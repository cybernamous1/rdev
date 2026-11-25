// Owner-only knowledge discovery and acquisition routes (/api/admin/discovery/*), called from admin-api.ts AFTER the
// owner session has been verified. Pipeline:
//   seed page -> CANDIDATE sources (pending) -> owner approves/rejects -> approved source is registered in the ledger
//   -> owner triggers retrieve+extract -> classified, duplicate-checked PENDING proposal -> existing approve/verify/publish flow.
// Nothing here approves, trusts or publishes anything by itself; the database triggers (init.sql) enforce the same rules.
import { validatePackage, type Entry, type RlfPackage, type Source } from '../shared/rlf.ts';
import { PATHS } from '../shared/paths.ts';
import { SEEDS, seedById, extractLinks, candidatesFrom, contentUrls, type Candidate } from '../knowledge/discover.ts';
import { retrieve, isAllowedUrl, type Retrieved } from '../knowledge/retrieve.ts';
import { extractContent, entryIdFor, buildEntry } from '../knowledge/ingest.ts';
import { analyzeEntries, detectOutdated, summarize, type Finding } from '../knowledge/duplicates.ts';
import { buildRelationships } from '../knowledge/relate.ts';
import { sha256Hex } from '../knowledge/acquire.ts';
import type { AdminDb, AdminStmt } from './admin-api.ts';
import { classifyText } from '../knowledge/classify.ts';
import { discoveryV5Api, licensingSnapshot, categoryLabelFor } from './discovery-v5-api.ts';
import { PoliteFetcher } from '../knowledge/engine/net/fetcher.ts';
import { D1HostPolicies } from './discovery-v5-store.ts';

export type DiscoveryCtx = {
  db: AdminDb; request: Request; url: URL; path: string; sessionId: string;
  json: (data: unknown, status?: number) => Response;
  readJson: (r: Request) => Promise<Record<string, any> | null>;
  audit: (name: string, detail: string) => Promise<void>;
  auditStmt: (name: string, detail: string) => AdminStmt;
  validSlug: (s: unknown) => s is string;
};

const STATUSES = ['pending', 'approved', 'rejected'];
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const safe = (v: unknown) => { try { return JSON.parse(String(v || 'null')); } catch { return null; } };

async function publishedEntries(db: AdminDb): Promise<Entry[]> {
  const rows = await db.prepare('SELECT v.body AS body FROM packages p JOIN package_versions v ON v.package_id=p.id AND v.version=p.current_version').all<{ body: string }>();
  return rows.results.flatMap((r) => { const p = safe(r.body) as RlfPackage | null; return Array.isArray(p?.entries) ? p!.entries : []; });
}

export async function discoveryApi(c: DiscoveryCtx): Promise<Response | null> {
  if (!c.path.startsWith('/api/admin/discovery')) return null;
  // v0.5.0 routes (adaptive discovery, licensing intelligence) live in their own module and have their own missing-table message.
  const v5 = await discoveryV5Api(c, { classify: (text, title) => { const r = classifyText(text, title); return { path: r.path, score: r.ranked[0].score }; } });
  if (v5) return v5;
  try { return await route(c); }
  catch (e) {
    if (/no such table/i.test((e as Error).message)) return c.json({ error: 'The discovery tables are missing. Apply database/upgrade-0.4.0.sql (after a backup) when you are ready; nothing was changed.' }, 503);
    throw e;
  }
}

async function route(c: DiscoveryCtx): Promise<Response> {
  const { db, path, request, json } = c; const method = request.method;
  const num = (s: string) => Number(s);

  if (path === '/api/admin/discovery/overview' && method === 'GET') {
    const runs = await db.prepare('SELECT r.seed_id,r.status,r.links_found,r.new_candidates,r.note,r.started_at FROM discovery_runs r WHERE r.id IN (SELECT MAX(id) FROM discovery_runs GROUP BY seed_id)').all<any>();
    const counts = await db.prepare('SELECT status, COUNT(*) AS n FROM discovered_sources GROUP BY status').all<{ status: string; n: number }>();
    return json({
      seeds: SEEDS.map((s) => ({ ...s, lastRun: runs.results.find((r) => r.seed_id === s.id) || null })),
      counts: Object.fromEntries(STATUSES.map((s) => [s, counts.results.find((r) => r.status === s)?.n || 0])),
      note: 'Discovery only suggests candidate sources. Nothing is trusted, extracted or published until you approve it.'
    });
  }

  if (path === '/api/admin/discovery/run' && method === 'POST') {
    const body = await c.readJson(request); if (!body) return json({ error: 'Invalid request body.' }, 400);
    const seed = seedById(body.seedId); if (!seed) return json({ error: 'Unknown discovery seed.' }, 400);
    let page: Retrieved | null = null; let pages = 0; let note = '';
    for (const u of contentUrls(seed.url)) { const r = await retrieve(u); pages++; if (r.ok) { page = r; break; } note = r.note; }
    if (!page) {
      await db.prepare("INSERT INTO discovery_runs(seed_id,status,pages_fetched,note) VALUES(?,'failed',?,?)").bind(seed.id, pages, note.slice(0, 500)).run();
      return json({ error: `Discovery failed: ${note}` }, 502);
    }
    const links = [{ url: new URL(seed.url), text: seed.label }, ...extractLinks(page.text, page.finalUrl)];
    const candidates = candidatesFrom(links, seed);
    const urls = JSON.stringify(candidates.map((x) => x.url));
    const registered = new Set((await db.prepare('SELECT url FROM sources WHERE url IN (SELECT value FROM json_each(?))').bind(urls).all<{ url: string }>()).results.map((r) => r.url));
    const known = new Set((await db.prepare('SELECT url FROM discovered_sources WHERE url IN (SELECT value FROM json_each(?))').bind(urls).all<{ url: string }>()).results.map((r) => r.url));
    const fresh = candidates.filter((x) => !registered.has(x.url) && !known.has(x.url));
    const now = new Date().toISOString();
    const stmts: AdminStmt[] = [db.prepare("INSERT INTO discovery_runs(seed_id,status,pages_fetched,links_found,new_candidates,note) VALUES(?,'completed',?,?,?,?)").bind(seed.id, pages, links.length, fresh.length, `${candidates.length} relevant candidate(s); ${registered.size} already registered; ${known.size} already queued.`)];
    for (const x of fresh as Candidate[]) stmts.push(db.prepare("INSERT OR IGNORE INTO discovered_sources(url,host,title,publisher,category,suggested_path,relevance,discovered_via,run_id) VALUES(?,?,?,?,?,?,?,?,(SELECT MAX(id) FROM discovery_runs))").bind(x.url, x.host, x.title, x.publisher, x.category, x.suggestedPath, x.relevance, seed.id));
    for (const u of known) stmts.push(db.prepare('UPDATE discovered_sources SET last_seen_at=? WHERE url=?').bind(now, u));
    stmts.push(c.auditStmt('discovery_run', `${seed.id}: ${fresh.length} new candidate(s)`));
    await db.batch(stmts);
    return json({ success: true, seedId: seed.id, linksFound: links.length, relevant: candidates.length, newCandidates: fresh.length, alreadyRegistered: registered.size, alreadyQueued: known.size });
  }

  if (path === '/api/admin/discovery/candidates' && method === 'GET') {
    const status = c.url.searchParams.get('status') || 'pending';
    if (![...STATUSES, 'all'].includes(status)) return json({ error: 'Invalid status.' }, 400);
    const rows = await db.prepare(`SELECT d.id,d.url,d.host,d.title,d.publisher,d.category,d.suggested_path,d.relevance,d.discovered_via,d.status,d.first_seen_at,d.last_seen_at,d.reviewed_at,d.review_note,d.registered_source_id,s.license AS license,
      (SELECT status FROM extraction_runs WHERE source_id=d.registered_source_id ORDER BY id DESC LIMIT 1) AS last_extraction,
      (SELECT created_at FROM extraction_runs WHERE source_id=d.registered_source_id ORDER BY id DESC LIMIT 1) AS last_extraction_at
      FROM discovered_sources d LEFT JOIN sources s ON s.id=d.registered_source_id ${status === 'all' ? '' : 'WHERE d.status=?'} ORDER BY d.relevance DESC, d.id DESC LIMIT 300`).bind(...(status === 'all' ? [] : [status])).all();
    return json({ candidates: rows.results });
  }

  const m = path.match(/^\/api\/admin\/discovery\/candidates\/(\d{1,12})\/(review|extract|license)$/);
  if (m && method === 'POST') {
    const id = num(m[1]); const body = await c.readJson(request); if (!body) return json({ error: 'Invalid request body.' }, 400);
    const cand = await db.prepare('SELECT id,url,title,publisher,category,suggested_path,status,registered_source_id FROM discovered_sources WHERE id=?').bind(id).first<any>();
    if (!cand) return json({ error: 'Candidate source not found.' }, 404);
    if (m[2] === 'review') return review(c, cand, body);
    if (cand.status !== 'approved' || !cand.registered_source_id) return json({ error: 'Only an owner-approved source can be used. Approve the candidate first.' }, 409);
    if (m[2] === 'license') {
      const license = typeof body.license === 'string' ? body.license.trim() : '';
      if (!license || license.length > 300) return json({ error: 'Provide the license text (up to 300 characters).' }, 400);
      const res: any = await db.prepare('UPDATE sources SET license=? WHERE id=? AND license IS NULL').bind(license, cand.registered_source_id).run();
      if (Number(res?.meta?.changes ?? res?.changes ?? 0) === 0) return json({ error: 'This source already has a license recorded.' }, 409);
      await c.audit('source_license_recorded', cand.registered_source_id);
      return json({ success: true });
    }
    return extract(c, cand, body);
  }

  if (path === '/api/admin/discovery/changes' && method === 'GET') return changes(c);
  return json({ error: 'Owner endpoint not found.' }, 404);
}

async function review(c: DiscoveryCtx, cand: any, body: Record<string, any>): Promise<Response> {
  const { db, json } = c;
  const decision = body.decision; const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
  if (!['approve', 'reject'].includes(decision) || (decision === 'reject' && !note)) return json({ error: 'Choose approve or reject; rejection requires a reason.' }, 400);
  if (cand.status !== 'pending') return json({ error: 'This candidate was already reviewed.' }, 409);
  const reviewedAt = new Date().toISOString();
  if (decision === 'reject') {
    try { await db.batch([db.prepare("UPDATE discovered_sources SET status='rejected',reviewed_at=?,review_note=? WHERE id=? AND status='pending'").bind(reviewedAt, note, cand.id), c.auditStmt('discovered_source_rejected', `candidate ${cand.id}`)]); }
    catch (e) { return json({ error: `Rejection refused by database safeguards: ${(e as Error).message}` }, 409); }
    return json({ success: true, id: cand.id, status: 'rejected' });
  }
  const u = new URL(cand.url);
  const sourceId = c.validSlug(body.sourceId) ? body.sourceId : `${slugify(u.hostname.replace(/^www\./, '') + '-' + u.pathname.split('/').filter(Boolean).slice(-2).join('-')).slice(0, 40).replace(/-+$/, '')}-${(await sha256Hex(cand.url)).slice(0, 4)}`;
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 160) : String(cand.title).slice(0, 160);
  const publisher = typeof body.publisher === 'string' && body.publisher.trim() ? body.publisher.trim().slice(0, 160) : cand.publisher;
  const license = typeof body.license === 'string' && body.license.trim() ? body.license.trim().slice(0, 300) : null;
  if (await db.prepare('SELECT 1 AS ok FROM sources WHERE id=? OR url=?').bind(sourceId, cand.url).first()) return json({ error: 'A source with this id or URL is already registered.' }, 409);
  try {
    // One atomic batch: the ledger row is created only while the candidate is still pending, and the approval is recorded with it.
    await db.batch([
      db.prepare("INSERT INTO sources(id,label,url,publisher,license) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM discovered_sources WHERE id=? AND status='pending')").bind(sourceId, label, cand.url, publisher, license, cand.id),
      db.prepare("UPDATE discovered_sources SET status='approved',reviewed_at=?,review_note=?,registered_source_id=? WHERE id=? AND status='pending'").bind(reviewedAt, note || null, sourceId, cand.id),
      c.auditStmt('discovered_source_approved', `candidate ${cand.id} registered as ${sourceId}`)
    ]);
  } catch (e) { return json({ error: `Approval failed; nothing was registered: ${(e as Error).message}` }, 409); }
  return json({ success: true, id: cand.id, status: 'approved', sourceId });
}

async function extract(c: DiscoveryCtx, cand: any, body: Record<string, any>): Promise<Response> {
  const { db, json } = c; const sourceId: string = cand.registered_source_id;
  const src = await db.prepare('SELECT id,label,url,publisher,license FROM sources WHERE id=?').bind(sourceId).first<any>();
  if (!src) return json({ error: 'Registered source is missing.' }, 409);
  const pathOverride = typeof body.path === 'string' && body.path ? body.path : null;
  if (pathOverride && !PATHS.some((p) => p.name === pathOverride)) return json({ error: 'Unknown learning path.' }, 400);
  const now = new Date().toISOString();
  const snapshot = (status: 'retrieved' | 'failed', http: number | null, hash: string | null, note: string) => db.prepare('INSERT INTO source_snapshots(source_id,status,http_status,content_hash,retrieved_at,note) VALUES(?,?,?,?,?,?)').bind(sourceId, status, http, hash, now, note.slice(0, 500));
  const run = (status: string, hash: string | null, http: number | null, title: string | null, created: number, note: string) => db.prepare('INSERT INTO extraction_runs(source_id,status,content_hash,http_status,title,proposals_created,note) VALUES(?,?,?,?,?,?,?)').bind(sourceId, status, hash, http, title, created, note.slice(0, 500));
  const finish = async (status: string, hash: string | null, http: number | null, title: string | null, note: string, httpCode = 200) => {
    await db.batch([snapshot(hash ? 'retrieved' : 'failed', http, hash, note), run(status, hash, http, title, 0, note), c.auditStmt('knowledge_extraction', `${sourceId}: ${status}`)]);
    return json({ success: status !== 'failed', status, note, ...(status === 'failed' ? { error: note } : {}) }, httpCode);
  };

  let page: Retrieved | null = null; let last = '';
  for (const u of contentUrls(src.url)) { const r = await retrieveApproved(c, u); if (r.ok) { page = r; break; } last = r.note; }
  if (!page) return finish('failed', null, null, null, `Retrieval failed: ${last}`, 502);
  const x = await extractContent(page);
  if (!x) return finish('failed', null, page.status, null, 'No extractable text was found (the page may be rendered by scripts, or is not a documentation page).', 422);

  const prev = await db.prepare("SELECT content_hash AS h FROM extraction_runs WHERE source_id=? AND status IN ('new','changed','unchanged','duplicate') ORDER BY id DESC LIMIT 1").bind(sourceId).first<{ h: string }>();
  if (prev && prev.h === x.contentHash) return finish('unchanged', x.contentHash, page.status, x.title, 'Source content is unchanged since the previous extraction; no new proposal was created.');

  const entryId = await entryIdFor(cand.url);
  const published = await publishedEntries(db);
  const current = published.find((e) => e.id === entryId) || null;
  const v5Label = await categoryLabelFor(c, cand.id); // v0.5.0: a third-party tutorial is not labelled "Official documentation"
  const built = buildEntry(x, { id: entryId, sourceId, categoryLabel: v5Label ?? (cand.category === 'official-docs' ? 'Official documentation' : cand.category === 'language' ? 'Luau language' : 'Repository'), now, pathOverride });
  const entry = built.entry;
  if (!entry.path) return finish('unclassified', x.contentHash, page.status, x.title, 'The content could not be matched to a learning path by the keyword rules. Re-run extraction and choose a learning path yourself.');
  if (current) entry.path = current.path; // an update stays in its published package
  const maxVer = Number((await db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM entry_versions WHERE entry_id=?').bind(entryId).first<any>())?.v || 0);
  if (maxVer > 0 && !current) return finish('duplicate', x.contentHash, page.status, x.title, 'This entry was published before and later retired; it is not proposed again automatically.');
  const kind = current ? 'update' : 'new';

  // Duplicate / conflict / outdated detection against published content and the review queue.
  const queued = (await db.prepare("SELECT payload_json FROM proposals WHERE status IN ('pending','approved') AND target_entry_id<>?").bind(entryId).all<{ payload_json: string }>()).results.map((r) => safe(r.payload_json) as Entry).filter((e) => e && Array.isArray(e.blocks) && Array.isArray(e.prerequisites));
  const pool = [...published.filter((e) => e.id !== entryId), ...queued];
  const findings: Finding[] = analyzeEntries([entry], pool);
  if (kind === 'update' && prev) findings.push(...detectOutdated([current!], [{ id: sourceId, contentHash: prev.h }], [{ id: sourceId, contentHash: x.contentHash }]));
  const ledger: Source = { id: sourceId, label: src.label, url: src.url, publisher: src.publisher, license: src.license, status: 'retrieved', retrievedAt: now, contentHash: x.contentHash };
  const probe = { format: 'rlf', formatVersion: 1, id: 'probe', title: entry.path, description: 'probe', version: '1.0.0', license: 'probe', entries: [entry], sources: [ledger], relationships: [], checksum: '' } as RlfPackage;
  const v = await validatePackage(probe, { checkChecksum: false });
  const related = buildRelationships([entry, ...pool]).filter((r) => r.from === entry.id && r.type === 'related').map((r) => ({ id: r.to, reason: r.reason }));
  const warnings = [...v.warnings]; if (x.truncated) warnings.push('Extracted content was truncated to fit the proposal size limit.');
  if (!src.license) warnings.push('The source has no recorded license. Imported content cannot be published until a license is recorded for the source.');
  const licensing = await licensingSnapshot(c, cand.id); // null when the v0.5.0 tables are not installed
  if (licensing && licensing.assessment.reuse.status !== 'indicated-permissive' && licensing.assessment.reuse.status !== 'indicated-conditional') warnings.push(`Licensing evidence status: ${licensing.assessment.reuse.status}. Not cleared for reuse.`);
  if (licensing && !licensing.clearance) warnings.push('No licensing clearance has been recorded by the owner for this source.');
  const analysis = {
    generator: 'rdev-kb 0.5.0 discovery', comparedAgainst: pool.length, findings, summary: summarize(findings), validation: { errors: v.errors, warnings },
    classification: { method: 'keyword-rules', path: entry.path, pathSource: built.pathSource, confidence: Math.round(built.classification.confidence * 100) / 100, ranked: built.classification.ranked.slice(0, 3), level: entry.level },
    related, source: { id: sourceId, url: src.url, contentHash: x.contentHash, retrievedAt: now, license: src.license }, change: kind === 'update' ? 'changed-source' : 'new-content',
    ...(licensing ? { licensing } : {})
  };
  const payloadHash = await sha256Hex(JSON.stringify({ ...entry, updatedAt: '' }));
  const dup = await db.prepare('SELECT id,status FROM proposals WHERE kind=? AND target_entry_id=? AND payload_hash=?').bind(kind, entryId, payloadHash).first<any>();
  if (dup) return finish('duplicate', x.contentHash, page.status, x.title, `An identical proposal already exists (#${dup.id}, ${dup.status}); nothing new was queued.`);
  const supersede = (await db.prepare("SELECT id FROM proposals WHERE target_entry_id=? AND status='pending' AND origin='pipeline' AND id IN (SELECT proposal_id FROM proposal_provenance WHERE source_id=?)").bind(entryId, sourceId).all<{ id: number }>()).results.map((r) => r.id);
  (analysis as any).supersedes = supersede;
  const rationale = kind === 'update'
    ? `The approved source changed since it was last extracted. Re-extracted from ${src.url}. Imported, unreviewed; compare with the published entry before approving.`
    : `Extracted from the owner-approved source ${src.url}. Imported, unreviewed; check accuracy, licensing and wording before approving.`;
  const status = prev ? 'changed' : 'new';
  try {
    await db.batch([
      snapshot('retrieved', page.status, x.contentHash, 'Extraction hash of normalized text; source text is not stored in the ledger.'),
      run(status, x.contentHash, page.status, x.title, 1, `Proposed ${kind} entry ${entryId}.`),
      db.prepare("UPDATE proposals SET status='superseded' WHERE target_entry_id=? AND status='pending' AND origin='pipeline' AND id IN (SELECT proposal_id FROM proposal_provenance WHERE source_id=?)").bind(entryId, sourceId),
      db.prepare("INSERT INTO proposals(kind,target_entry_id,base_version,title,rationale,payload_json,payload_hash,analysis_json,origin) VALUES(?,?,?,?,?,?,?,?,'pipeline')").bind(kind, entryId, kind === 'update' ? maxVer : null, entry.title, rationale, JSON.stringify(entry), payloadHash, JSON.stringify(analysis)),
      db.prepare('INSERT INTO proposal_provenance(proposal_id,source_id,source_url,content_hash,extraction_run_id) VALUES((SELECT id FROM proposals WHERE kind=? AND target_entry_id=? AND payload_hash=?),?,?,?,(SELECT MAX(id) FROM extraction_runs WHERE source_id=?))').bind(kind, entryId, payloadHash, sourceId, src.url, x.contentHash, sourceId),
      c.auditStmt('knowledge_extraction', `${sourceId}: ${kind} proposal for ${entryId}`)
    ]);
  } catch (e) { return json({ error: `Extraction was refused by database safeguards; nothing was queued: ${(e as Error).message}` }, 409); }
  const row = await db.prepare('SELECT id FROM proposals WHERE kind=? AND target_entry_id=? AND payload_hash=?').bind(kind, entryId, payloadHash).first<any>();
  return json({ success: true, status, proposalId: row?.id ?? null, kind, entryId, path: entry.path, findings: summarize(findings), supersededProposals: supersede, note: 'A PENDING proposal was queued. It is not public and not approved.' }, 201);
}

async function changes(c: DiscoveryCtx): Promise<Response> {
  const { db, json } = c;
  const sources = await db.prepare(`SELECT d.id AS candidate_id,d.registered_source_id AS source_id,d.url,d.title,
      (SELECT status FROM extraction_runs WHERE source_id=d.registered_source_id ORDER BY id DESC LIMIT 1) AS last_status,
      (SELECT created_at FROM extraction_runs WHERE source_id=d.registered_source_id ORDER BY id DESC LIMIT 1) AS last_run_at
      FROM discovered_sources d WHERE d.status='approved' ORDER BY d.id DESC`).all<any>();
  const stale = await db.prepare(`SELECT p.id,p.title,p.status,pp.source_id FROM proposals p JOIN proposal_provenance pp ON pp.proposal_id=p.id
      WHERE p.status IN ('pending','approved') AND (SELECT content_hash FROM extraction_runs WHERE source_id=pp.source_id AND status<>'failed' ORDER BY id DESC LIMIT 1) <> pp.content_hash`).all<any>();
  const published = await db.prepare(`SELECT m.entry_id AS id, pp.source_id AS source_id, pp.content_hash AS hash FROM package_version_entries m
      JOIN packages p ON p.id=m.package_id AND p.current_version=m.package_version
      JOIN entry_versions ev ON ev.entry_id=m.entry_id AND ev.version=m.entry_version
      JOIN proposal_provenance pp ON pp.proposal_id=ev.proposal_id`).all<any>();
  const latest = await db.prepare("SELECT source_id AS id, content_hash AS hash FROM extraction_runs WHERE id IN (SELECT MAX(id) FROM extraction_runs WHERE status<>'failed' GROUP BY source_id)").all<any>();
  const outdated: Finding[] = [];
  for (const row of published.results) {
    outdated.push(...detectOutdated([{ id: row.id, sourceIds: [row.source_id] } as Entry], [{ id: row.source_id, contentHash: row.hash }], latest.results.filter((l) => l.id === row.source_id).map((l) => ({ id: l.id, contentHash: l.hash }))));
  }
  return json({ sources: sources.results, staleProposals: stale.results, outdatedPublished: outdated });
}

/** Retrieval for an owner-APPROVED source. The v0.4.0 host allow-list path is unchanged; any other approved public host is read through the
 *  robots-respecting v0.5.0 fetcher (SSRF-safe, size-capped, never executed). Approval of the source by the owner is still required before this runs. */
async function retrieveApproved(c: DiscoveryCtx, url: string): Promise<Retrieved> {
  const first = await retrieve(url); if (first.ok || isAllowedUrl(url)) return first;
  const f = new PoliteFetcher({ fetchImpl: (i, init) => fetch(i, init), store: new D1HostPolicies(c.db), minDelayMs: 0 });
  const r = await f.fetch(url, { accept: 'text/html,text/plain,text/markdown' });
  if (r.kind === 'ok') return { ok: true, status: r.status, finalUrl: r.finalUrl, contentType: r.contentType, text: r.text, note: `Retrieved ${r.bytes.length} bytes.` };
  return { ok: false, status: r.kind === 'error' ? r.status : null, finalUrl: url, contentType: '', text: '', note: r.kind === 'blocked' ? r.detail : r.kind === 'deferred' ? `${r.reason} (try again shortly)` : r.kind === 'error' ? r.note : 'not modified' };
}
