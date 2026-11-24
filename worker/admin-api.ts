// Private owner management API (/api/admin/*). Everything here is authenticated and validated server-side.
// It never changes what the public API serves except through the same guarded D1 batch the SQL triggers verify:
// publication (approved proposal -> immutable package version -> pointer move) and rollback (pointer move to a
// previously published version). Public reads are served only from packages.current_version.
import { validatePackage, computeChecksum, type Entry, type RlfPackage } from '../shared/rlf.ts';
import { isValidVersion, nextVersion } from '../shared/semver.ts';
import { discoveryApi } from './discovery-api.ts';

export type AdminStmt = { bind(...v: unknown[]): AdminStmt; run(): Promise<any>; first<T = any>(): Promise<T | null>; all<T = any>(): Promise<{ results: T[] }> };
export type AdminDb = { prepare(sql: string): AdminStmt; batch(statements: AdminStmt[]): Promise<any[]> };
export type AdminEnv = { DB?: Partial<AdminDb> | null; OWNER_ADMIN_TOKEN?: string };

const COOKIE = 'rdev_owner_session';
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 32 * 1024;
const MAX_SOURCE_BYTES = 2_000_000;
const MAX_FAILED_LOGINS = 8;
const ALLOWED_SOURCE_HOSTS = ['create.roblox.com', 'luau.org', 'devforum.roblox.com', 'github.com', 'raw.githubusercontent.com'];
const enc = new TextEncoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
async function sha(value: string | BufferSource) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? enc.encode(value) : value))); }
// Domain-separated fingerprint: the stored value is not a bare hash of the secret.
const fingerprint = (token: string) => sha('rdev-owner-credential-v1:' + token);
function randomToken() { const b = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function cookieValue(request: Request) { const raw = request.headers.get('Cookie') || ''; return raw.split(';').map((x) => x.trim()).find((x) => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || ''; }
// `Secure` is omitted only for plain-http local development (wrangler dev); every deployed Worker is https.
const cookieAttrs = (request: Request) => `Path=/api/admin; HttpOnly; SameSite=Strict${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
const setCookie = (request: Request, token: string, maxAge: number) => `${COOKIE}=${token}; ${cookieAttrs(request)}; Max-Age=${maxAge}`;
const clearCookie = (request: Request) => `${COOKIE}=; ${cookieAttrs(request)}; Max-Age=0`;
function json(data: unknown, status = 200, headers: HeadersInit = {}) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } }); }
// State-changing requests must carry a matching Origin (or a same-origin Fetch Metadata header).
function sameOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}
function constantTimeEqual(a: string, b: string) { const aa = enc.encode(a), bb = enc.encode(b); let diff = aa.length ^ bb.length; const n = Math.max(aa.length, bb.length); for (let i = 0; i < n; i++) diff |= (aa[i] || 0) ^ (bb[i] || 0); return diff === 0; }
const validSlug = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 48;
const safeJson = (v: unknown) => { try { return JSON.parse(String(v || 'null')); } catch { return null; } };
const changesOf = (r: any): number => Number(r?.meta?.changes ?? r?.changes ?? 0);
async function readJson(request: Request): Promise<Record<string, any> | null> {
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return null;
  try { const text = await request.text(); if (text.length > MAX_BODY) return null; const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}
const BAD_BODY = () => json({ error: 'Invalid request body.' }, 400);
async function audit(db: AdminDb, name: string, severity: 'info' | 'warn' | 'critical' = 'info', detail = '', ipHash: string | null = null) {
  try { await db.prepare('INSERT INTO security_events(event,severity,ip_hash,detail) VALUES(?,?,?,?)').bind(name, severity, ipHash, detail.slice(0, 500)).run(); } catch { /* auditing must not mask the operation result */ }
}
const auditStmt = (db: AdminDb, name: string, detail: string, sessionId: string | null) => db.prepare("INSERT INTO security_events(event,severity,session_id,detail) VALUES(?,'info',?,?)").bind(name, sessionId, detail.slice(0, 500));

async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > max) { await reader.cancel(); return null; } chunks.push(value); }
  const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out;
}

export async function adminApi(request: Request, env: AdminEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/admin')) return null;
  const db = env.DB as AdminDb | null | undefined;
  if (!db || typeof db.prepare !== 'function') return json({ error: 'Owner database is not configured.' }, 503);
  try { return await route(request, env, db, path); }
  catch { return json({ error: 'The owner operation could not be completed. The database may be unavailable or not initialized; nothing was reported as committed.' }, 500); }
}

async function route(request: Request, env: AdminEnv, db: AdminDb, path: string): Promise<Response> {
  const url = new URL(request.url);
  const mutating = request.method !== 'GET' && request.method !== 'HEAD';
  if (mutating && !sameOrigin(request)) return json({ error: 'Cross-origin request rejected.' }, 403);

  if (path === '/api/admin/login' && request.method === 'POST') {
    if (!env.OWNER_ADMIN_TOKEN || env.OWNER_ADMIN_TOKEN.length < 32) return json({ error: 'Owner authentication is not configured. Set OWNER_ADMIN_TOKEN as a Worker secret (minimum 32 characters).' }, 503);
    const ipHash = await sha(request.headers.get('CF-Connecting-IP') || 'unknown');
    const attempts = await db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip_hash=? AND success=0 AND attempted_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')").bind(ipHash).first();
    if (Number(attempts?.n || 0) >= MAX_FAILED_LOGINS) return json({ error: 'Too many failed attempts. Try again later.' }, 429);
    const body = await readJson(request); if (!body) return BAD_BODY();
    const supplied = typeof body.token === 'string' ? body.token : '';
    const expectedFp = await fingerprint(env.OWNER_ADMIN_TOKEN);
    const ok = supplied.length > 0 && constantTimeEqual(expectedFp, await fingerprint(supplied));
    await db.prepare('INSERT INTO login_attempts(ip_hash,success) VALUES(?,?)').bind(ipHash, ok ? 1 : 0).run();
    if (!ok) { await audit(db, 'owner_login_failed', 'warn', '', ipHash); return json({ error: 'Invalid owner credential.' }, 401); }
    const session = randomToken(); const id = await sha(session);
    const now = Date.now(); const iso = (n: number) => new Date(n).toISOString();
    await db.prepare('INSERT INTO admin_sessions(id,token_fingerprint,last_seen_at,idle_expires_at,absolute_expires_at,ip_hash) VALUES(?,?,?,?,?,?)').bind(id, expectedFp, iso(now), iso(now + IDLE_MS), iso(now + ABSOLUTE_MS), ipHash).run();
    await audit(db, 'owner_login_succeeded', 'info', '', ipHash);
    // Opportunistic housekeeping so the auth tables stay small. Failure is harmless.
    try {
      await db.prepare("DELETE FROM login_attempts WHERE attempted_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')").run();
      await db.prepare("DELETE FROM admin_sessions WHERE absolute_expires_at < ? ").bind(iso(now - 24 * 3600 * 1000)).run();
    } catch { /* ignore */ }
    return json({ authenticated: true, expiresIn: IDLE_MS / 1000 }, 200, { 'Set-Cookie': setCookie(request, session, ABSOLUTE_MS / 1000) });
  }

  if (path === '/api/admin/logout' && request.method === 'POST') {
    const token = cookieValue(request);
    if (token) await db.prepare("UPDATE admin_sessions SET revoked_at=?,revoked_reason='logout' WHERE id=? AND revoked_at IS NULL").bind(new Date().toISOString(), await sha(token)).run();
    return json({ authenticated: false }, 200, { 'Set-Cookie': clearCookie(request) });
  }

  // ---- Everything below requires a valid owner session ----
  const sessionToken = cookieValue(request);
  if (!sessionToken) return json({ error: 'Owner authentication required.' }, 401);
  const sessionId = await sha(sessionToken);
  const session = await db.prepare('SELECT id,token_fingerprint,idle_expires_at,absolute_expires_at,revoked_at FROM admin_sessions WHERE id=?').bind(sessionId).first<any>();
  const expectedFp = env.OWNER_ADMIN_TOKEN && env.OWNER_ADMIN_TOKEN.length >= 32 ? await fingerprint(env.OWNER_ADMIN_TOKEN) : '';
  const now = Date.now();
  const idle = session ? Date.parse(session.idle_expires_at) : NaN; const absolute = session ? Date.parse(session.absolute_expires_at) : NaN;
  if (!session || !expectedFp || session.revoked_at || !constantTimeEqual(String(session.token_fingerprint), expectedFp) || !Number.isFinite(idle) || !Number.isFinite(absolute) || idle <= now || absolute <= now) {
    if (session && !session.revoked_at) await db.prepare("UPDATE admin_sessions SET revoked_at=?,revoked_reason='expired_or_invalid' WHERE id=? AND revoked_at IS NULL").bind(new Date().toISOString(), sessionId).run();
    return json({ error: 'Owner session expired. Please sign in again.' }, 401, { 'Set-Cookie': clearCookie(request) });
  }
  const newIdle = new Date(Math.min(now + IDLE_MS, absolute)).toISOString();
  await db.prepare('UPDATE admin_sessions SET last_seen_at=?,idle_expires_at=? WHERE id=?').bind(new Date(now).toISOString(), newIdle, sessionId).run();

  if (path === '/api/admin/session' && request.method === 'GET') return json({ authenticated: true, expiresAt: newIdle });

  if (path === '/api/admin/overview' && request.method === 'GET') {
    const [pending, approved, published, packages, sources, latest] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status='pending'").first(),
      db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status='approved'").first(),
      db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status='published'").first(),
      db.prepare('SELECT id,title,current_version FROM packages ORDER BY title').all(),
      db.prepare(`SELECT s.id,s.label,s.url,s.publisher,s.license,COALESCE(x.status,'unchecked') AS status,x.retrieved_at AS retrieved_at FROM sources s LEFT JOIN source_snapshots x ON x.id=(SELECT MAX(id) FROM source_snapshots WHERE source_id=s.id) ORDER BY s.label`).all(),
      db.prepare('SELECT id,package_id,version,action,published_at FROM publications ORDER BY id DESC LIMIT 10').all()
    ]);
    return json({ counts: { pending: pending?.n || 0, approved: approved?.n || 0, published: published?.n || 0 }, packages: packages.results, sources: sources.results, publications: latest.results });
  }

  if (path === '/api/admin/proposals' && request.method === 'GET') {
    const status = url.searchParams.get('status') || 'pending';
    if (!['pending', 'approved', 'rejected', 'published', 'superseded', 'all'].includes(status)) return json({ error: 'Invalid proposal status.' }, 400);
    const where = status === 'all' ? '' : 'WHERE p.status=?'; const binds = status === 'all' ? [] : [status];
    let rows: { results: any[] };
    try {
      // v0.4.0: pipeline proposals carry provenance (source, extraction hash) and a stale flag when the source changed since extraction.
      rows = await db.prepare(`SELECT p.id,p.kind,p.target_entry_id,p.base_version,p.title,p.rationale,p.payload_json,p.analysis_json,p.origin,p.status,p.created_at,p.reviewed_at,p.review_note,
        pp.source_id AS prov_source_id,pp.source_url AS prov_source_url,pp.content_hash AS prov_hash,
        CASE WHEN pp.proposal_id IS NULL THEN NULL WHEN (SELECT content_hash FROM extraction_runs WHERE source_id=pp.source_id AND status<>'failed' ORDER BY id DESC LIMIT 1) <> pp.content_hash THEN 1 ELSE 0 END AS source_changed
        FROM proposals p LEFT JOIN proposal_provenance pp ON pp.proposal_id=p.id ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT 200`).bind(...binds).all();
    } catch (e) {
      if (!/no such table/i.test((e as Error).message)) throw e; // database not yet upgraded to v0.4.0: behave exactly as v0.3.0
      rows = await db.prepare(`SELECT id,kind,target_entry_id,base_version,title,rationale,payload_json,analysis_json,origin,status,created_at,reviewed_at,review_note FROM proposals ${status === 'all' ? '' : 'WHERE status=?'} ORDER BY created_at DESC, id DESC LIMIT 200`).bind(...binds).all();
    }
    return json({ proposals: rows.results.map(({ payload_json, analysis_json, prov_source_id, prov_source_url, prov_hash, source_changed, ...r }: any) => ({ ...r, payload: safeJson(payload_json), analysis: safeJson(analysis_json), provenance: prov_source_id ? { sourceId: prov_source_id, sourceUrl: prov_source_url, contentHash: prov_hash, sourceChanged: source_changed === 1 } : null })) });
  }

  const reviewMatch = path.match(/^\/api\/admin\/proposals\/(\d{1,12})\/review$/);
  if (reviewMatch && request.method === 'POST') {
    const body = await readJson(request); if (!body) return BAD_BODY();
    const decision = body.decision; const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
    if (!['approve', 'reject'].includes(decision) || (decision === 'reject' && !note)) return json({ error: 'Choose approve or reject; rejection requires a reason.' }, 400);
    const id = Number(reviewMatch[1]); const row = await db.prepare('SELECT id,status FROM proposals WHERE id=?').bind(id).first<any>();
    if (!row) return json({ error: 'Proposal not found.' }, 404);
    if (row.status !== 'pending') return json({ error: 'Proposal is no longer pending.' }, 409);
    const status = decision === 'approve' ? 'approved' : 'rejected';
    try {
      const result = await db.prepare("UPDATE proposals SET status=?,reviewed_at=?,review_note=? WHERE id=? AND status='pending'").bind(status, new Date().toISOString(), note || null, id).run();
      if (changesOf(result) === 0) return json({ error: 'Proposal is no longer pending.' }, 409);
    } catch (e) { return json({ error: `Review was rejected by database safeguards: ${(e as Error).message}` }, 409); }
    await audit(db, `proposal_${status}`, 'info', `proposal ${id}`);
    return json({ success: true, id, status });
  }

  if (path === '/api/admin/sources' && request.method === 'POST') {
    const body = await readJson(request); if (!body) return BAD_BODY();
    const label = typeof body.label === 'string' ? body.label.trim() : ''; const publisher = typeof body.publisher === 'string' ? body.publisher.trim() : '';
    const license = typeof body.license === 'string' && body.license.trim() ? body.license.trim() : null;
    let parsed: URL; try { parsed = new URL(String(body.url || '')); } catch { return json({ error: 'A valid HTTPS source URL is required.' }, 400); }
    if (!validSlug(body.id) || !label || label.length > 160 || !publisher || publisher.length > 160 || (license && license.length > 300) || parsed.protocol !== 'https:' || !ALLOWED_SOURCE_HOSTS.includes(parsed.hostname) || parsed.port || parsed.username || parsed.password) return json({ error: 'Source fields are invalid. HTTPS sources must use an approved host.' }, 400);
    try { await db.prepare('INSERT INTO sources(id,label,url,publisher,license) VALUES(?,?,?,?,?)').bind(body.id, label, parsed.toString(), publisher, license).run(); }
    catch (e) { return json({ error: `Source could not be registered: ${(e as Error).message}` }, 409); }
    await audit(db, 'source_registered', 'info', String(body.id));
    return json({ success: true, id: body.id }, 201);
  }

  const fetchSourceMatch = path.match(/^\/api\/admin\/sources\/([a-z0-9-]{1,48})\/fetch$/);
  if (fetchSourceMatch && request.method === 'POST') {
    const source = await db.prepare('SELECT id,url FROM sources WHERE id=?').bind(fetchSourceMatch[1]).first<any>();
    if (!source) return json({ error: 'Source not found.' }, 404);
    const parsed = new URL(source.url);
    if (parsed.protocol !== 'https:' || !ALLOWED_SOURCE_HOSTS.includes(parsed.hostname) || parsed.port) return json({ error: 'Source host is not on the approved retrieval list.' }, 400);
    let status: 'retrieved' | 'failed' = 'failed', httpStatus: number | null = null, contentHash: string | null = null, note = '';
    try {
      const response = await fetch(source.url, { redirect: 'manual', headers: { 'user-agent': 'RDevAcademyKnowledgeBot/0.3 (+educational; respects source terms)', accept: 'text/html,text/plain,application/json' }, signal: AbortSignal.timeout(15000) });
      httpStatus = response.status;
      if (!response.ok) note = `HTTP ${response.status}; redirects and non-success responses are not followed.`;
      else {
        const bytes = await readCapped(response, MAX_SOURCE_BYTES);
        if (!bytes) note = 'Source response exceeded the 2 MB retrieval limit.';
        else { contentHash = await sha(bytes); status = 'retrieved'; note = `Retrieved ${bytes.length} bytes; content hash recorded. Source text was not copied into the public library.`; }
      }
    } catch (e) { note = `Retrieval failed: ${(e as Error).message}`; }
    await db.prepare('INSERT INTO source_snapshots(source_id,status,http_status,content_hash,retrieved_at,note) VALUES(?,?,?,?,?,?)').bind(source.id, status, httpStatus, contentHash, new Date().toISOString(), note.slice(0, 500)).run();
    return json({ success: status === 'retrieved', id: source.id, status, httpStatus, contentHash, note });
  }

  if (path === '/api/admin/publications' && request.method === 'GET') {
    const rows = await db.prepare('SELECT id,package_id,version,previous_version,action,note,published_at FROM publications ORDER BY id DESC LIMIT 100').all();
    return json({ publications: rows.results });
  }

  const publishMatch = path.match(/^\/api\/admin\/publish\/([a-z0-9-]{1,48})$/);
  if (publishMatch && request.method === 'POST') {
    const body = await readJson(request); if (!body) return BAD_BODY();
    const proposalId = Number(body.proposalId); if (!Number.isSafeInteger(proposalId) || proposalId < 1) return json({ error: 'A valid approved proposalId is required.' }, 400);
    const v = body.verification;
    if (!v || v.confirmed !== true || typeof v.reviewer !== 'string' || v.reviewer.trim().length < 2 || typeof v.notes !== 'string' || v.notes.trim().length < 10) return json({ error: 'Explicit content verification is required: provide a reviewer, at least 10 characters of review notes, and confirmation.' }, 400);
    if (typeof db.batch !== 'function') return json({ error: 'Owner database does not support atomic batches.' }, 503);
    const result = await publishApprovedProposal(db, publishMatch[1], proposalId, { reviewer: v.reviewer.trim().slice(0, 120), notes: v.notes.trim().slice(0, 2000) }, sessionId);
    return result.ok ? json(result) : json({ error: result.error }, result.status || 400);
  }

  const rollbackMatch = path.match(/^\/api\/admin\/rollback\/([a-z0-9-]{1,48})$/);
  if (rollbackMatch && request.method === 'POST') {
    const body = await readJson(request); if (!body) return BAD_BODY();
    if (!isValidVersion(body.version)) return json({ error: 'A valid target version is required.' }, 400);
    if (typeof db.batch !== 'function') return json({ error: 'Owner database does not support atomic batches.' }, 503);
    const packageId = rollbackMatch[1];
    const pkg = await db.prepare('SELECT current_version FROM packages WHERE id=?').bind(packageId).first<any>();
    if (!pkg) return json({ error: 'Package does not exist.' }, 404);
    if (!pkg.current_version || pkg.current_version === body.version) return json({ error: 'Package is not published or already points to that version.' }, 409);
    const wasPublished = await db.prepare("SELECT 1 AS ok FROM publications WHERE package_id=? AND version=? AND action='publish'").bind(packageId, body.version).first();
    if (!wasPublished) return json({ error: 'Rollback target must be a version that was previously published.' }, 409);
    // The target must still be an intact, valid package before learners are pointed at it.
    const target = await db.prepare('SELECT body FROM package_versions WHERE package_id=? AND version=?').bind(packageId, body.version).first<any>();
    const targetReport = target ? await validatePackage(safeJson(target.body)) : null;
    if (!targetReport?.ok) return json({ error: 'Rollback target failed package validation; the pointer was not changed.' }, 422);
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : 'Owner rollback';
    try {
      await db.batch([
        db.prepare("INSERT INTO publications(package_id,version,previous_version,action,note) VALUES(?,?,?,'rollback',?)").bind(packageId, body.version, pkg.current_version, note),
        db.prepare('UPDATE packages SET current_version=?,updated_at=? WHERE id=? AND current_version=?').bind(body.version, new Date().toISOString(), packageId, pkg.current_version),
        auditStmt(db, 'package_rolled_back', `${packageId} ${pkg.current_version} -> ${body.version}`, sessionId)
      ]);
    } catch (e) { return json({ error: `Rollback failed; no changes committed: ${(e as Error).message}` }, 409); }
    return json({ success: true, packageId, version: body.version, previousVersion: pkg.current_version });
  }

  const discovery = await discoveryApi({
    db, request, url, path, sessionId, validSlug,
    json: (data, status) => json(data, status),
    readJson,
    audit: (name, detail) => audit(db, name, 'info', detail),
    auditStmt: (name, detail) => auditStmt(db, name, detail, sessionId)
  });
  if (discovery) return discovery;

  return json({ error: 'Owner endpoint not found.' }, 404);
}

type PublishResult = { ok: true; version: string; packageId: string; entryId: string | null } | { ok: false; error: string; status?: number };

async function publishApprovedProposal(db: AdminDb, packageId: string, proposalId: number, verification: { reviewer: string; notes: string }, sessionId: string): Promise<PublishResult> {
  const fail = (status: number, error: string): PublishResult => ({ ok: false, status, error });
  const proposal = await db.prepare("SELECT id,kind,target_entry_id,base_version,payload_json FROM proposals WHERE id=? AND status='approved'").bind(proposalId).first<any>();
  if (!proposal) return fail(409, 'Only an approved proposal can be published.');
  // v0.4.0: content extracted from a source that has changed since extraction is stale and must be re-extracted and re-reviewed.
  try {
    const stale = await db.prepare("SELECT 1 AS stale FROM proposal_provenance pp WHERE pp.proposal_id=? AND (SELECT content_hash FROM extraction_runs WHERE source_id=pp.source_id AND status<>'failed' ORDER BY id DESC LIMIT 1) <> pp.content_hash").bind(proposalId).first();
    if (stale) return fail(409, 'The source has changed since this content was extracted. Re-extract it and review the new proposal; this stale proposal cannot be published.');
  } catch (e) { if (!/no such table/i.test((e as Error).message)) throw e; }
  const packageRow = await db.prepare('SELECT id,title,description,current_version FROM packages WHERE id=?').bind(packageId).first<any>();
  if (!packageRow) return fail(404, 'Package does not exist.');

  let oldPkg: RlfPackage | null = null;
  if (packageRow.current_version) {
    const previous = await db.prepare('SELECT body FROM package_versions WHERE package_id=? AND version=?').bind(packageId, packageRow.current_version).first<any>();
    oldPkg = previous ? safeJson(previous.body) as RlfPackage | null : null;
    if (!oldPkg || !Array.isArray(oldPkg.entries)) return fail(409, 'The current package version could not be read; publication refused.');
  }
  const kind: string = proposal.kind; const targetId: string = proposal.target_entry_id;
  const inCurrent = (oldPkg?.entries || []).some((e) => e.id === targetId);
  const raw = safeJson(proposal.payload_json) as Entry | null;
  if (kind !== 'retire') {
    if (!raw || typeof raw !== 'object' || !validSlug(raw.id) || raw.id !== targetId || !raw.title || !Array.isArray(raw.blocks)) return fail(400, 'Proposal payload is not a valid entry for its declared target.');
    if (raw.path !== packageRow.title) return fail(400, 'Proposal learning path does not match the selected package.');
    if (kind === 'new' && inCurrent) return fail(409, 'A new-entry proposal cannot publish an entry that is already in the package.');
    if (kind === 'update' && !inCurrent) return fail(409, 'An update proposal requires the entry to be in the currently published package.');
    const elsewhere = await db.prepare('SELECT 1 AS ok FROM package_version_entries m JOIN packages p ON p.id=m.package_id AND p.current_version=m.package_version WHERE m.entry_id=? AND m.package_id<>?').bind(targetId, packageId).first();
    if (elsewhere) return fail(409, 'This entry id is already published in a different package.');
  } else if (!inCurrent) return fail(409, 'Retirement target is not present in the current package.');

  const keptEntries = (oldPkg?.entries || []).filter((e) => e.id !== targetId);
  const sourceIds = kind === 'retire' ? [...new Set(keptEntries.flatMap((e) => e.sourceIds || []))] : (raw!.sourceIds || []);
  if (!Array.isArray(sourceIds) || sourceIds.some((s) => !validSlug(s))) return fail(400, 'Proposal references invalid source ids.');
  const sourceRows = await db.prepare(`SELECT s.id,s.label,s.url,s.publisher,s.license,x.status,x.retrieved_at,x.content_hash FROM sources s LEFT JOIN source_snapshots x ON x.id=(SELECT MAX(id) FROM source_snapshots WHERE source_id=s.id) WHERE s.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(sourceIds)).all();
  const ledger = (sourceRows.results || []).map((s: any) => ({ id: s.id, label: s.label, url: s.url, publisher: s.publisher, license: s.license, status: s.status || 'unchecked', retrievedAt: s.status === 'retrieved' ? s.retrieved_at : null, contentHash: s.status === 'retrieved' ? s.content_hash : null }));
  for (const sid of sourceIds) if (!ledger.some((s: any) => s.id === sid)) return fail(400, `Source ${sid} is not registered in the central source ledger.`);

  const reviewedAt = new Date().toISOString();
  let entry: Entry | null = null; let entryVersion = 0;
  if (kind !== 'retire') {
    const row = await db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM entry_versions WHERE entry_id=?').bind(targetId).first<any>();
    entryVersion = Number(row?.v || 0) + 1;
    if (kind === 'update' && Number(proposal.base_version) !== entryVersion - 1) return fail(409, 'Stale proposal: the entry changed since the proposal was based on it.');
    entry = { ...raw!, status: 'published', review: { reviewer: verification.reviewer, reviewedAt, notes: verification.notes }, version: `${entryVersion}.0.0`, updatedAt: reviewedAt } as Entry;
  }
  const entries: Entry[] = entry ? (inCurrent ? keptEntriesInPlace(oldPkg!.entries, entry) : [...keptEntries, entry]) : keptEntries;
  const remaining = new Set(entries.map((e) => e.id));
  const sources = [...(oldPkg?.sources || [])];
  for (const s of ledger) { const i = sources.findIndex((x: any) => x.id === s.id); if (i === -1) sources.push(s as any); }
  // Versions are allocated above every version ever created for this package, so a rollback can never cause a collision.
  const existing = await db.prepare('SELECT version FROM package_versions WHERE package_id=?').bind(packageId).all<{ version: string }>();
  let version: string; try { version = nextVersion((existing.results || []).map((r) => r.version)); } catch (e) { return fail(409, (e as Error).message); }
  const body: Omit<RlfPackage, 'checksum'> = { format: 'rlf', formatVersion: 1, id: packageId, title: packageRow.title, description: packageRow.description, version, license: oldPkg?.license || 'All rights reserved by the project owner until a license is selected and published. Linked third-party sources keep their own terms.', entries, sources, relationships: (oldPkg?.relationships || []).filter((r) => remaining.has(r.from) && remaining.has(r.to)) };
  const pkg: RlfPackage = { ...body, checksum: await computeChecksum(body) };
  const validation = await validatePackage(pkg);
  if (!validation.ok) return fail(422, `Publication validation failed: ${validation.errors.slice(0, 8).join(' ')}`);

  const stmts: AdminStmt[] = [];
  if (entry) {
    stmts.push(db.prepare('INSERT OR IGNORE INTO entries(id,kind) VALUES(?,?)').bind(entry.id, entry.kind));
    stmts.push(db.prepare(`INSERT INTO entry_versions(entry_id,version,path,category,title,summary,level,minutes,tags,content_json,search_text,status,origin,review_json,content_hash,proposal_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(entry.id, entryVersion, entry.path, entry.category, entry.title, entry.summary, entry.level, entry.minutes, (entry.tags || []).join(','), JSON.stringify(entry), [entry.title, entry.summary, ...(entry.tags || [])].join(' '), 'verified', entry.origin, JSON.stringify(entry.review), await sha(JSON.stringify(entry)), proposalId));
    for (const sid of entry.sourceIds || []) stmts.push(db.prepare('INSERT INTO entry_version_sources(entry_id,version,source_id) VALUES(?,?,?)').bind(entry.id, entryVersion, sid));
  }
  stmts.push(db.prepare('INSERT INTO package_versions(package_id,version,checksum,entry_count,body) VALUES(?,?,?,?,?)').bind(packageId, version, pkg.checksum, pkg.entries.length, JSON.stringify(pkg)));
  for (const e of pkg.entries) {
    // Membership uses the version each entry already carries inside the package body (contract: version N <-> 'N.0.0').
    const m = /^([1-9]\d*)\.0\.0$/.exec(e.version || ''); if (!m) return fail(409, `Entry ${e.id} has a version that does not follow the N.0.0 contract.`);
    stmts.push(db.prepare('INSERT INTO package_version_entries(package_id,package_version,entry_id,entry_version) VALUES(?,?,?,?)').bind(packageId, version, e.id, Number(m[1])));
  }
  stmts.push(db.prepare("INSERT INTO publications(package_id,version,previous_version,action,note) VALUES(?,?,?,'publish',?)").bind(packageId, version, packageRow.current_version, `Owner publication of proposal ${proposalId}`));
  stmts.push(db.prepare('INSERT INTO publication_proposals(publication_id,proposal_id) VALUES((SELECT MAX(id) FROM publications WHERE package_id=?),?)').bind(packageId, proposalId));
  stmts.push(db.prepare("UPDATE proposals SET status='published' WHERE id=? AND status='approved'").bind(proposalId));
  stmts.push(db.prepare('UPDATE packages SET current_version=?,updated_at=? WHERE id=? AND current_version IS ?').bind(version, reviewedAt, packageId, packageRow.current_version));
  stmts.push(auditStmt(db, 'package_published', `${packageId} ${packageRow.current_version ?? 'none'} -> ${version}; proposal ${proposalId}`, sessionId));
  try { await db.batch(stmts); }
  catch (e) { return fail(409, `Atomic publication rejected; no changes committed: ${(e as Error).message}`); }
  return { ok: true, version, packageId, entryId: entry?.id ?? null };
}

function keptEntriesInPlace(entries: Entry[], replacement: Entry): Entry[] { return entries.map((e) => (e.id === replacement.id ? replacement : e)); }
