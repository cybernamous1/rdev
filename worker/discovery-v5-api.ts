// Owner-only v0.5.0 routes (/api/admin/discovery/v5/*), reached from discovery-api.ts AFTER the owner session is verified.
// Three approvals stay separate and none is automatic:
//   1. discovered SOURCES   -> existing POST /api/admin/discovery/candidates/:id/review (unchanged)
//   2. extracted PROPOSALS  -> existing Proposals tab / approve / verify / publish (unchanged)
//   3. LICENSING clearance  -> POST /v5/candidates/:id/license/review (append-only license_reviews; this file)
// Discovery, scanning, extraction and licence detection only ever add pending candidates, evidence and assessments.
import type { DiscoveryCtx } from './discovery-api.ts';
import type { PathClassifier } from '../knowledge/engine/contracts.ts';
import { PoliteFetcher } from '../knowledge/engine/net/fetcher.ts';
import { checkUrl } from '../knowledge/engine/net/url-policy.ts';
import { runDiscoveryStep, seedOpportunity } from '../knowledge/engine/orchestrator.ts';
import { createRegistry } from '../knowledge/engine/runtime/builtin.ts';
import { assessLicense, NEEDS_ACKNOWLEDGEMENT } from '../knowledge/engine/license/assess.ts';
import { detectLicenseEvidence } from '../knowledge/engine/license/detect.ts';
import { compareChange, nextCheckAt } from '../knowledge/engine/monitor/change.ts';
import { extractSignals } from '../knowledge/engine/parse/html-signals.ts';
import { bands, hasFingerprint, sha256Hex, simhash } from '../knowledge/engine/monitor/fingerprint.ts';
import { explainCandidate } from '../knowledge/engine/explain.ts';
import type { LicenseEvidence } from '../knowledge/engine/contracts.ts';
import { D1DiscoveryStore, D1HostPolicies, evidenceStatements } from './discovery-v5-store.ts';

export type V5Options = { fetchImpl?: typeof fetch; classify: PathClassifier; now?: () => number };
const safe = <T,>(v: unknown, d: T): T => { try { return JSON.parse(String(v ?? '')) as T; } catch { return d; } };
const changes = (r: any): number => Number(r?.meta?.changes ?? r?.changes ?? 0);
const MISSING = 'The v0.5.0 tables are missing. Apply database/upgrade-0.5.0.sql (after a backup, on your explicit decision) to use adaptive discovery and licensing. Nothing was changed.';

export function makeFetcher(c: DiscoveryCtx, o: V5Options) {
  return new PoliteFetcher({ fetchImpl: o.fetchImpl ?? ((i, init) => fetch(i, init)), store: new D1HostPolicies(c.db), now: o.now, apiHosts: ['api.github.com'] });
}

export async function discoveryV5Api(c: DiscoveryCtx, o: V5Options): Promise<Response | null> {
  if (!c.path.startsWith('/api/admin/discovery/v5')) return null;
  try { return await route(c, o); }
  catch (e) { if (/no such table/i.test((e as Error).message)) return c.json({ error: MISSING, code: 'v5-not-installed' }, 503); throw e; }
}

async function route(c: DiscoveryCtx, o: V5Options): Promise<Response> {
  const { db, path, request, json } = c; const method = request.method; const store = new D1DiscoveryStore(db); const registry = createRegistry(o.now);
  const sub = path.slice('/api/admin/discovery/v5'.length) || '/';

  if (sub === '/overview' && method === 'GET') {
    const jobs = await store.listJobs();
    const cnt = await db.prepare(`SELECT (SELECT COUNT(*) FROM license_evidence) AS evidence,(SELECT COUNT(*) FROM license_reviews) AS reviews,(SELECT COUNT(*) FROM host_policies) AS hosts,
      (SELECT COUNT(*) FROM discovered_source_meta) AS enriched,(SELECT COUNT(*) FROM discovery_frontier WHERE status IN ('queued','fetching')) AS open_frontier`).first<any>();
    return json({ version: '0.5.0', jobs, counts: cnt, capabilities: registry.describe(),
      note: 'Discovery finds candidates and evidence only. Source approval, proposal approval and licensing clearance are three separate owner decisions.' });
  }
  if (sub === '/capabilities' && method === 'GET') return json({ modules: registry.describe() });

  if (sub === '/jobs' && method === 'GET') return json({ jobs: await store.listJobs() });
  if (sub === '/jobs' && method === 'POST') {
    const body = await c.readJson(request); if (!body) return json({ error: 'Invalid request body.' }, 400);
    const root = typeof body.rootUrl === 'string' ? body.rootUrl.trim() : ''; const chk = checkUrl(root);
    if (!chk.ok) return json({ error: `That starting point cannot be used: ${chk.reason}.` }, 400);
    const seed = seedOpportunity(root); if (!seed) return json({ error: 'That starting point cannot be used.' }, 400);
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : chk.url.hostname;
    const id = await store.createJob(label, seed.url, seed); await c.audit('discovery_job_created', `job ${id}: ${seed.url}`);
    return json({ success: true, jobId: id, note: 'Job created. Call step repeatedly; each step is short and resumable. The starting point is a hint, not a limit or an approval.' }, 201);
  }
  const jm = sub.match(/^\/jobs\/(\d{1,12})\/(step|cancel)$/);
  if (jm && method === 'POST') {
    const id = Number(jm[1]);
    if (jm[2] === 'cancel') { const ok = await store.cancelJob(id); if (ok) await c.audit('discovery_job_cancelled', `job ${id}`); return ok ? json({ success: true }) : json({ error: 'Job is not active.' }, 409); }
    const summary = await runDiscoveryStep(id, { fetcher: makeFetcher(c, o), store, runtime: registry, classify: o.classify, now: o.now });
    if (summary.busy) return json({ error: summary.log[0], ...summary }, 409);
    await c.audit('discovery_job_step', `job ${id}: ${summary.fetched} fetched, ${summary.newCandidates} new candidate(s)`);
    return json({ success: true, ...summary, note: 'New candidates are PENDING. Nothing is trusted, extracted or published.' });
  }

  if (sub === '/candidates' && method === 'GET') {
    const status = c.url.searchParams.get('status') || 'pending'; if (!['pending', 'approved', 'rejected', 'all'].includes(status)) return json({ error: 'Invalid status.' }, 400);
    const rows = await db.prepare(`SELECT d.id,m.resource_type,m.language,m.language_confidence,m.method,m.depth,m.change_state,m.signals_json,
      (SELECT COUNT(*) FROM license_evidence e WHERE e.candidate_id=d.id) AS evidence_count,
      (SELECT decision FROM license_reviews r WHERE r.candidate_id=d.id ORDER BY r.id DESC LIMIT 1) AS clearance
      FROM discovered_sources d JOIN discovered_source_meta m ON m.candidate_id=d.id ${status === 'all' ? '' : 'WHERE d.status=?'} ORDER BY d.id DESC LIMIT 300`).bind(...(status === 'all' ? [] : [status])).all<any>();
    return json({ candidates: rows.results.map((r) => ({ ...r, signals: safe(r.signals_json, []), signals_json: undefined })) });
  }
  const cm = sub.match(/^\/candidates\/(\d{1,12})\/(insight|license\/scan|license\/review|recheck)$/);
  if (cm) {
    const id = Number(cm[1]); const action = cm[2];
    const cand = await db.prepare('SELECT id,url,title,status,category FROM discovered_sources WHERE id=?').bind(id).first<any>(); if (!cand) return json({ error: 'Candidate source not found.' }, 404);
    if (action === 'insight' && method === 'GET') return json(await insight(c, cand));
    if (method !== 'POST') return json({ error: 'Owner endpoint not found.' }, 404);
    if (action === 'license/scan') return scan(c, o, cand);
    if (action === 'recheck') return recheck(c, o, cand);
    return reviewLicense(c, cand);
  }
  return json({ error: 'Owner endpoint not found.' }, 404);
}

export async function loadEvidence(c: DiscoveryCtx, candidateId: number) {
  const rows = (await c.db.prepare('SELECT * FROM license_evidence WHERE candidate_id=? ORDER BY confidence DESC, id ASC').bind(candidateId).all<any>()).results;
  return rows.map((r) => ({ id: r.id as number, kind: r.kind, identifier: r.identifier, label: r.label, evidenceUrl: r.evidence_url, licenseUrl: r.license_url, excerpt: r.excerpt, method: r.method, scope: r.scope, confidence: r.confidence,
    restrictions: safe(r.restrictions_json, []), indicates: r.indicates, detectedAt: r.detected_at, contentHash: r.content_hash, notes: safe<string[]>(r.notes_json, []) } as LicenseEvidence & { id: number }));
}

async function insight(c: DiscoveryCtx, cand: any) {
  const { db } = c;
  const meta = await db.prepare('SELECT resource_type,language,language_confidence,method,depth,canonical_url,change_state,fetched_at,last_checked_at,next_check_at,check_failures,signals_json FROM discovered_source_meta WHERE candidate_id=?').bind(cand.id).first<any>();
  const evidence = await loadEvidence(c, cand.id); const assessment = assessLicense(evidence, { resourceType: meta?.resource_type });
  const reviews = (await db.prepare('SELECT id,decision,basis,scope,permits_display,permits_modification,permits_redistribution,permits_commercial,attribution_text,conditions,evidence_ids_json,assessment_status,acknowledged_ambiguity,note,reviewed_at FROM license_reviews WHERE candidate_id=? ORDER BY id DESC LIMIT 10').bind(cand.id).all<any>()).results
    .map((r) => ({ ...r, evidence_ids: safe(r.evidence_ids_json, []), evidence_ids_json: undefined }));
  return { candidate: cand, meta: meta ? { ...meta, signals: safe(meta.signals_json, []), signals_json: undefined } : null, evidence, assessment, reviews, explanation: explainCandidate({ title: cand.title, url: cand.url, meta: meta ? { resourceType: meta.resource_type, language: meta.language, languageConfidence: meta.language_confidence, method: meta.method, signals: safe(meta.signals_json, []) } : null, assessment, latestReview: reviews[0] ? { decision: reviews[0].decision, note: reviews[0].note } : null }) };
}

/** Licensing snapshot attached to extraction analysis (used by discovery-api.ts). Never throws: a missing v0.5.0 schema returns null. */
export async function licensingSnapshot(c: Pick<DiscoveryCtx, 'db'>, candidateId: number) {
  try {
    const ctx = { db: c.db } as DiscoveryCtx; const evidence = await loadEvidence(ctx, candidateId); const a = assessLicense(evidence);
    const last = await c.db.prepare('SELECT decision,basis,note,reviewed_at FROM license_reviews WHERE candidate_id=? ORDER BY id DESC LIMIT 1').bind(candidateId).first<any>();
    return { assessment: { reuse: a.reuse, restrictions: a.restrictions, confidence: a.confidence, conflicts: a.conflicts }, evidenceCount: evidence.length, clearance: last ? { decision: last.decision, basis: last.basis, reviewedAt: last.reviewed_at } : null };
  } catch { return null; }
}
export async function categoryLabelFor(c: Pick<DiscoveryCtx, 'db'>, candidateId: number): Promise<string | null> {
  try { const m = await c.db.prepare('SELECT resource_type FROM discovered_source_meta WHERE candidate_id=?').bind(candidateId).first<{ resource_type: string }>();
    return m ? ({ tutorial: 'Tutorial', course: 'Course', reference: 'Reference', documentation: 'Documentation', article: 'Article', repository: 'Repository', directory: 'Directory page' } as Record<string, string>)[m.resource_type] ?? 'Web resource' : null; } catch { return null; }
}

/** Fetch the candidate page (and up to two licence/terms pages it links to on the same site), record EVIDENCE, return the assessment. Clears nothing. */
async function scan(c: DiscoveryCtx, o: V5Options, cand: any): Promise<Response> {
  const { db, json } = c; const fetcher = makeFetcher(c, o); const runtime = createRegistry(o.now); const now = (o.now ?? Date.now)();
  const isRepo = cand.category === 'repository' && new URL(cand.url).hostname === 'github.com';
  const all: LicenseEvidence[] = []; const notes: string[] = [];
  if (isRepo) {
    const seg = new URL(cand.url).pathname.split('/').filter(Boolean);
    const r = await fetcher.fetch(`https://api.github.com/repos/${seg[0]}/${seg[1]}`, { accept: 'application/vnd.github+json', allowTypes: /^application\/json/ });
    if (r.kind === 'ok') { const gh = safe<any>(r.text, null); all.push(...detectLicenseEvidence({ pageUrl: cand.url, signals: extractSignals('', cand.url, 'text/plain'), fetchedAt: new Date(now).toISOString(), contentHash: null, github: gh })); }
    else notes.push(`Repository API: ${r.kind === 'blocked' ? r.detail : r.kind === 'deferred' ? r.reason : (r as any).note}`);
  }
  const page = await fetcher.fetch(cand.url);
  const followed: string[] = [];
  if (page.kind === 'ok') {
    const s = await runtime.run<any>('html.signals', { text: page.text, url: page.finalUrl, contentType: page.contentType });
    if (s.ok) {
      const hash = await sha256Hex(JSON.stringify({ t: s.value.title, p: s.value.proseText }));
      const ev = await runtime.run<LicenseEvidence[]>('license.detect', { pageUrl: page.finalUrl, signals: s.value, fetchedAt: new Date(now).toISOString(), contentHash: hash }); if (ev.ok) all.push(...ev.value);
      const host = new URL(page.finalUrl).hostname;
      for (const l of s.value.links) { if (followed.length >= 2) break; if (new URL(l.url).hostname === host && /\b(licen[sc]e|licensing|copyright|terms(?: of use)?|permissions|reuse)\b/i.test(l.text) && l.text.length < 50 && l.url !== page.finalUrl) followed.push(l.url); }
    } else notes.push(`Page parsing failed: ${s.errors[0].error}`);
  } else notes.push(`Page not scanned: ${page.kind === 'blocked' ? page.detail : page.kind === 'deferred' ? page.reason : page.kind === 'error' ? page.note : page.kind}`);
  for (const u of followed) {
    const r = await fetcher.fetch(u); if (r.kind !== 'ok') { notes.push(`Linked page ${u} not read: ${r.kind === 'blocked' ? r.detail : r.kind === 'deferred' ? 'deferred (try again shortly)' : r.kind}`); continue; }
    const s = await runtime.run<any>('html.signals', { text: r.text, url: r.finalUrl, contentType: r.contentType }); if (!s.ok) continue;
    const hash = await sha256Hex(r.text.slice(0, 200_000)); const ev = await runtime.run<LicenseEvidence[]>('license.detect', { pageUrl: r.finalUrl, signals: s.value, fetchedAt: new Date(now).toISOString(), contentHash: hash });
    if (ev.ok) all.push(...ev.value.filter((e) => e.kind !== 'terms-reference' && e.kind !== 'copyright-notice').map((e) => ({ ...e, scope: e.scope === 'page' ? 'site' as const : e.scope })));
  }
  const stmts = await evidenceStatements(db, { sql: 'SELECT id FROM discovered_sources WHERE id=?', args: [cand.id] }, all);
  if (stmts.length) await db.batch([...stmts, c.auditStmt('license_scan', `candidate ${cand.id}: ${all.length} evidence item(s)`)]); else await c.audit('license_scan', `candidate ${cand.id}: no evidence`);
  const evidence = await loadEvidence(c, cand.id); const assessment = assessLicense(evidence);
  return json({ success: true, scannedPages: 1 + followed.length, newEvidence: all.length, assessment, notes, note: 'Evidence was recorded. This is a detection, not a clearance.' });
}

/** Owner-triggered re-check of a known candidate: conditional request, hash/simhash comparison, change state + next check time. */
async function recheck(c: DiscoveryCtx, o: V5Options, cand: any): Promise<Response> {
  const { db, json } = c; const meta = await db.prepare('SELECT content_hash,simhash,canonical_url,etag,last_modified,check_failures FROM discovered_source_meta WHERE candidate_id=?').bind(cand.id).first<any>();
  if (!meta) return json({ error: 'This candidate was not found by the v0.5.0 engine, so there is nothing to compare.' }, 409);
  const now = (o.now ?? Date.now)(); const res = await makeFetcher(c, o).fetch(cand.url, { conditional: { etag: meta.etag, lastModified: meta.last_modified } });
  if (res.kind === 'deferred') return json({ success: false, deferred: true, retryAfterMs: res.retryAfterMs, note: res.reason }, 202);
  if (res.kind === 'blocked') return json({ error: `Not re-checked: ${res.detail}` }, 409);
  const prev = { contentHash: meta.content_hash, simhash: meta.simhash, canonicalUrl: meta.canonical_url, checkFailures: meta.check_failures };
  let verdict; let hash = meta.content_hash; let sim = meta.simhash; let etag = meta.etag; let lm = meta.last_modified;
  if (res.kind === 'ok') {
    const s = extractSignals(res.text, res.finalUrl, res.contentType); hash = await sha256Hex(JSON.stringify({ t: s.title, p: s.proseText })); sim = simhash(s.proseText); etag = res.etag; lm = res.lastModified;
    verdict = compareChange(prev, { kind: 'ok', contentHash: hash, simhash: hasFingerprint(sim) ? sim : '0'.repeat(16), finalUrl: res.finalUrl, canonicalUrl: s.canonical || meta.canonical_url });
  } else if (res.kind === 'not-modified') verdict = compareChange(prev, { kind: 'not-modified' });
  else if (res.kind === 'error' && (res.status === 404 || res.status === 410)) verdict = compareChange(prev, { kind: 'gone', status: res.status });
  else verdict = compareChange(prev, { kind: 'error', note: res.kind === 'error' ? res.note : 'unknown' });
  const failures = verdict.state === 'gone' || verdict.state === 'unreachable' ? meta.check_failures + 1 : 0;
  const [a, b, cc, d] = bands(hasFingerprint(sim) ? sim : '0'.repeat(16));
  await db.batch([db.prepare("UPDATE discovered_source_meta SET content_hash=?,simhash=?,sh0=?,sh1=?,sh2=?,sh3=?,etag=?,last_modified=?,change_state=?,check_failures=?,last_checked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_check_at=? WHERE candidate_id=?")
    .bind(hash, sim, a, b, cc, d, etag, lm, verdict.state === 'new' ? 'unchanged' : verdict.state, failures, nextCheckAt(now, failures, verdict.state), cand.id), c.auditStmt('candidate_rechecked', `candidate ${cand.id}: ${verdict.state}`)]);
  return json({ success: true, state: verdict.state, reason: verdict.reason, note: 'Nothing was re-extracted or changed in any proposal. Use "Re-check & extract" to propose an update.' });
}

/** Owner licensing clearance. Append-only; the database triggers enforce evidence citation, acknowledgement of ambiguity and written conditions. */
async function reviewLicense(c: DiscoveryCtx, cand: any): Promise<Response> {
  const { db, json } = c; const body = await c.readJson(c.request); if (!body) return json({ error: 'Invalid request body.' }, 400);
  const decision = body.decision; if (!['cleared', 'cleared-with-conditions', 'denied'].includes(decision)) return json({ error: 'Choose cleared, cleared-with-conditions or denied.' }, 400);
  const basis = body.basis; if (!['detected-evidence', 'owner-written-permission', 'owner-judgement'].includes(basis)) return json({ error: 'State the basis of the decision.' }, 400);
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : ''; if (note.length < 10) return json({ error: 'A written reason of at least 10 characters is required.' }, 400);
  const scope = typeof body.scope === 'string' ? body.scope.trim().slice(0, 300) : ''; if (!scope) return json({ error: 'Describe what the decision covers (for example "text of this page and its code samples").' }, 400);
  const flag = (v: unknown) => (v === true ? 1 : 0);
  const ids = Array.isArray(body.evidenceIds) ? body.evidenceIds.filter((x: unknown) => Number.isInteger(x)).slice(0, 20) : [];
  const evidence = await loadEvidence(c, cand.id); const assessment = assessLicense(evidence);
  const needsAck = NEEDS_ACKNOWLEDGEMENT.includes(assessment.reuse.status);
  if (decision !== 'denied' && needsAck && body.acknowledgeAmbiguity !== true) return json({ error: `The current assessment is "${assessment.reuse.status}". It can only be cleared if you explicitly acknowledge that, and say why in the note.`, assessment }, 409);
  try {
    await db.batch([db.prepare('INSERT INTO license_reviews(candidate_id,decision,basis,scope,permits_display,permits_modification,permits_redistribution,permits_commercial,attribution_text,conditions,evidence_ids_json,assessment_status,acknowledged_ambiguity,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(cand.id, decision, basis, scope, decision === 'denied' ? flag(body.permitsDisplay) : 1, flag(body.permitsModification), flag(body.permitsRedistribution), flag(body.permitsCommercial),
        typeof body.attributionText === 'string' ? body.attributionText.slice(0, 500) : null, typeof body.conditions === 'string' ? body.conditions.slice(0, 1000) : null, JSON.stringify(ids), assessment.reuse.status, body.acknowledgeAmbiguity === true ? 1 : 0, note),
      c.auditStmt('license_review', `candidate ${cand.id}: ${decision} (${assessment.reuse.status})`)]);
  } catch (e) { return json({ error: `Licensing decision refused by database safeguards: ${(e as Error).message}` }, 409); }
  return json({ success: true, candidateId: cand.id, decision, assessmentStatus: assessment.reuse.status, note: 'Recorded as a separate licensing decision. It does not approve the source or any proposal.' }, 201);
}
export { changes };
