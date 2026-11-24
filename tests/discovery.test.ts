import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminApi } from '../worker/admin-api.ts';
import { SEEDS, extractLinks, candidatesFrom, contentUrls } from '../knowledge/discover.ts';
import { newDatabase, asDb, ROOT } from './helpers/sqlite.ts';
import { listPublishedPackages, listPublishedSources, getPublishedPackageBody } from '../worker/public-api.ts';

const TOKEN = 'test-owner-token-' + 'x'.repeat(40);
function adapter(raw: DatabaseSync) {
  const prepare = (sql: string, args: unknown[] = []) => ({
    bind: (...v: unknown[]) => prepare(sql, v),
    first: async <T,>() => (raw.prepare(sql).get(...args as never[]) as T | undefined) ?? null,
    all: async <T,>() => ({ results: raw.prepare(sql).all(...args as never[]) as T[] }),
    run: async () => raw.prepare(sql).run(...args as never[]), sql, args
  });
  return { prepare: (sql: string) => prepare(sql), batch: async (items: ReturnType<typeof prepare>[]) => {
    raw.exec('BEGIN'); try { const out = items.map((x) => raw.prepare(x.sql).run(...x.args as never[])); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
  } };
}
// ---- fake network: the tests never touch the internet ----
type Page = { body: string; type?: string; status?: number; location?: string };
let pages: Record<string, Page> = {}; let requested: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  const u = String(input); requested.push(u); const p = pages[u];
  if (!p) return new Response('nope', { status: 404 });
  return new Response(p.body, { status: p.status ?? 200, headers: { 'content-type': p.type ?? 'text/html', ...(p.location ? { location: p.location } : {}) } });
}) as typeof fetch;
afterEach(() => { pages = {}; requested = []; });
process.on('exit', () => { globalThis.fetch = realFetch; });

const SEED = SEEDS.find((s) => s.id === 'roblox-docs-scripting')!;
const seedHtml = `<html><body><nav>
  <a href="/docs/scripting/luau-variables">Luau variables and functions</a>
  <a href="/docs/scripting/luau-variables?utm=1#top">Luau variables and functions</a>
  <a href="/docs/scripting/events/remote">RemoteEvent server and client</a>
  <a href="/docs/cooking-recipes">Cooking recipes</a>
  <a href="https://evil.example/docs/luau">Luau on an evil site</a>
  <a href="/docs/assets/pic.png">Picture</a>
  <a href="https://github.com/Roblox/creator-docs">creator docs repo</a>
  <a href="https://github.com/randomuser/luau-stuff">random repo</a>
  </nav></body></html>`;
const page = (title: string, text: string[]) => `<html><head><title>${title} - Documentation - Roblox Creator Hub</title></head><body><nav><a href="/x">nav</a></nav><h1>${title}</h1>${text.map((t) => `<p>${t}</p>`).join('')}<pre>local score = 0\nprint(score)</pre><ul><li>Use a variable to name a value in Luau.</li></ul></body></html>`;
const VARS = ['A variable in Luau stores a value so a script can use it later in a function or a loop.', 'Declare a variable with the local keyword, then assign a string or a number to it.', 'A table groups many values and a function can return a table to its caller.'];
const VARS_URL = 'https://create.roblox.com/docs/scripting/luau-variables';

async function setup() {
  const raw = newDatabase(); const db = adapter(raw); const env = { DB: db, OWNER_ADMIN_TOKEN: TOKEN };
  const login = await adminApi(new Request('https://rdev.test/api/admin/login', { method: 'POST', headers: { Origin: 'https://rdev.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) }), env);
  const h = { Cookie: login!.headers.get('set-cookie')!.split(';')[0], Origin: 'https://rdev.test', 'Content-Type': 'application/json' };
  const call = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => { const r = await adminApi(new Request('https://rdev.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env); return { status: r!.status, data: await r!.json() as any }; };
  return { raw, db, env, call };
}
type S = Awaited<ReturnType<typeof setup>>;
const count = (raw: DatabaseSync, sql: string) => (raw.prepare(sql).get() as { n: number }).n;
async function discover(s: S) { pages[SEED.url] = { body: seedHtml }; const r = await s.call('/api/admin/discovery/run', { seedId: SEED.id }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
const candidateId = (raw: DatabaseSync, url: string) => (raw.prepare('SELECT id FROM discovered_sources WHERE url=?').get(url) as { id: number }).id;
const verification = { confirmed: true, reviewer: 'Test Reviewer', notes: 'Inspected content, code examples, source and licensing.' };

test('discovery filters links and queues only PENDING candidates; nothing is trusted, extracted or published', async () => {
  const s = await setup(); const r = await discover(s);
  const urls = (s.raw.prepare('SELECT url FROM discovered_sources ORDER BY url').all() as { url: string }[]).map((x) => x.url);
  assert.ok(urls.includes(VARS_URL) && urls.includes('https://create.roblox.com/docs/scripting/events/remote') && urls.includes('https://github.com/Roblox/creator-docs'));
  assert.ok(!urls.some((u) => /evil|randomuser|cooking|png/.test(u)), 'untrusted hosts, unknown owners, irrelevant pages and images are not suggested: ' + urls.join());
  assert.equal(urls.filter((u) => u.includes('luau-variables')).length, 1, 'query/fragment duplicates collapse');
  assert.equal(r.alreadyRegistered, 0);
  assert.equal(count(s.raw, "SELECT COUNT(*) n FROM discovered_sources WHERE status<>'pending'"), 0);
  for (const t of ['sources', 'extraction_runs', 'proposals', 'proposal_provenance', 'package_versions', 'publications']) assert.equal(count(s.raw, `SELECT COUNT(*) n FROM ${t}`), 0, t);
  assert.equal(count(s.raw, 'SELECT COUNT(*) n FROM packages WHERE current_version IS NOT NULL'), 0);
  assert.ok(requested.every((u) => u === SEED.url), 'only the seed page was fetched');
});

test('re-running discovery is idempotent and never changes a reviewed decision', async () => {
  const s = await setup(); await discover(s);
  const before = count(s.raw, 'SELECT COUNT(*) n FROM discovered_sources');
  const id = candidateId(s.raw, 'https://create.roblox.com/docs/scripting/events/remote');
  assert.equal((await s.call(`/api/admin/discovery/candidates/${id}/review`, { decision: 'reject' })).status, 400, 'rejection needs a reason');
  assert.equal((await s.call(`/api/admin/discovery/candidates/${id}/review`, { decision: 'reject', note: 'Too advanced for now.' })).status, 200);
  const again = await discover(s);
  assert.equal(again.newCandidates, 0); assert.equal(count(s.raw, 'SELECT COUNT(*) n FROM discovered_sources'), before);
  assert.equal((s.raw.prepare('SELECT status FROM discovered_sources WHERE id=?').get(id) as any).status, 'rejected');
  assert.equal((await s.call(`/api/admin/discovery/candidates/${id}/review`, { decision: 'approve' })).status, 409, 'a decided candidate cannot be flipped');
  assert.equal(count(s.raw, 'SELECT COUNT(*) n FROM sources'), 0);
});

test('extraction is refused for pending and rejected sources (API and database both enforce it)', async () => {
  const s = await setup(); await discover(s);
  const id = candidateId(s.raw, VARS_URL); pages[VARS_URL] = { body: page('Luau variables', VARS) };
  assert.equal((await s.call(`/api/admin/discovery/candidates/${id}/extract`, {})).status, 409);
  assert.ok(!requested.includes(VARS_URL), 'the source was not even fetched');
  await s.call(`/api/admin/discovery/candidates/${id}/review`, { decision: 'reject', note: 'No.' });
  assert.equal((await s.call(`/api/admin/discovery/candidates/${id}/extract`, {})).status, 409);
  // Database level: even a direct write cannot bypass the owner's approval.
  s.raw.exec("INSERT INTO sources(id,label,url,publisher) VALUES('manual-src','m','https://luau.org/x','p')");
  assert.throws(() => s.raw.exec("INSERT INTO extraction_runs(source_id,status,content_hash) VALUES('manual-src','new','h')"), /owner-approved source/);
  assert.throws(() => s.raw.exec("INSERT INTO discovered_sources(url,host,title,publisher,category,discovered_via,status,reviewed_at,registered_source_id) VALUES('https://luau.org/y','luau.org','t','p','language','x','approved','2026-01-01','manual-src')"), /must start pending/);
  assert.throws(() => s.raw.exec('DELETE FROM discovered_sources'), /cannot be deleted/);
  assert.throws(() => s.raw.exec(`UPDATE discovered_sources SET url='https://luau.org/z' WHERE id=${id}`), /immutable/);
  assert.throws(() => s.raw.exec(`UPDATE discovered_sources SET status='approved',reviewed_at='2026-01-01',registered_source_id='manual-src' WHERE id=${id}`), /status transition|must register the same URL/);
});

test('full workflow: discover → approve source → extract → review proposal → verify → publish → learner API', async () => {
  const s = await setup(); await discover(s);
  const id = candidateId(s.raw, VARS_URL); pages[VARS_URL] = { body: page('Luau variables', VARS) };
  const approve = await s.call(`/api/admin/discovery/candidates/${id}/review`, { decision: 'approve', sourceId: 'docs-luau-variables', license: 'CC BY 4.0 (owner verified)', note: 'Official page' });
  assert.equal(approve.status, 200, JSON.stringify(approve.data));
  assert.equal((s.raw.prepare("SELECT license FROM sources WHERE id='docs-luau-variables'").get() as any).license, 'CC BY 4.0 (owner verified)');
  assert.equal(count(s.raw, 'SELECT COUNT(*) n FROM proposals'), 0, 'approving a source extracts nothing');

  const ex = await s.call(`/api/admin/discovery/candidates/${id}/extract`, {});
  assert.equal(ex.status, 201, JSON.stringify(ex.data)); assert.equal(ex.data.kind, 'new'); assert.equal(ex.data.path, 'Luau Programming');
  const prop = s.raw.prepare('SELECT * FROM proposals WHERE id=?').get(ex.data.proposalId) as any;
  assert.deepEqual([prop.status, prop.origin, prop.kind], ['pending', 'pipeline', 'new']);
  const entry = JSON.parse(prop.payload_json);
  assert.deepEqual([entry.status, entry.origin, entry.review, entry.kind, entry.sourceIds], ['ai-assisted', 'imported', null, 'reference', ['docs-luau-variables']]);
  assert.equal(JSON.parse(prop.analysis_json).classification.method, 'keyword-rules');
  assert.equal(count(s.raw, 'SELECT COUNT(*) n FROM entries'), 0); assert.equal(count(s.raw, 'SELECT COUNT(*) n FROM package_versions'), 0);

  // The learner-facing reads see nothing at this point: candidate, approved source and pending proposal are all private.
  assert.deepEqual(await listPublishedPackages(asDb(s.raw)), []);
  assert.deepEqual(await listPublishedSources(asDb(s.raw)), []);
  // Publishing an unapproved extracted proposal is impossible.
  assert.equal((await s.call('/api/admin/publish/rdev-luau', { proposalId: prop.id, verification })).status, 409);
  // The review queue shows provenance.
  const queue = await s.call('/api/admin/proposals?status=pending');
  assert.equal(queue.data.proposals[0].provenance.sourceId, 'docs-luau-variables'); assert.equal(queue.data.proposals[0].provenance.sourceChanged, false);

  assert.equal((await s.call(`/api/admin/proposals/${prop.id}/review`, { decision: 'approve' })).status, 200);
  assert.equal((await s.call('/api/admin/publish/rdev-luau', { proposalId: prop.id, verification })).status, 200);
  const pub = JSON.parse((s.raw.prepare("SELECT body FROM package_versions WHERE package_id='rdev-luau' AND version='1.0.0'").get() as any).body);
  assert.equal(pub.entries.length, 1); assert.equal(pub.entries[0].status, 'published'); assert.equal(pub.entries[0].review.reviewer, 'Test Reviewer');
  assert.equal(pub.sources[0].license, 'CC BY 4.0 (owner verified)');
  assert.equal(count(s.raw, "SELECT COUNT(*) n FROM packages WHERE current_version IS NOT NULL"), 1);
  const listed = await listPublishedPackages(asDb(s.raw)); assert.equal(listed.length, 1); assert.equal(listed[0].id, 'rdev-luau');
  const served = await getPublishedPackageBody(asDb(s.raw), 'rdev-luau', '1.0.0'); assert.ok(served && JSON.parse(served.body).entries[0].id === entry.id);
  assert.deepEqual((await listPublishedSources(asDb(s.raw))).map((x: any) => x.id), ['docs-luau-variables']);
});

test('unchanged sources create nothing; changed sources create an update proposal, flag outdated content and block stale publication', async () => {
  const s = await setup(); await discover(s);
  const id = candidateId(s.raw, VARS_URL); pages[VARS_URL] = { body: page('Luau variables', VARS) };
  await s.call(`/api/admin/discovery/candidates/${id}/review`, { decision: 'approve', sourceId: 'docs-luau-variables', license: 'CC BY 4.0' });
  const first = await s.call(`/api/admin/discovery/candidates/${id}/extract`, {});
  const again = await s.call(`/api/admin/discovery/candidates/${id}/extract`, {});
  assert.equal(again.data.status, 'unchanged'); assert.equal(count(s.raw, 'SELECT COUNT(*) n FROM proposals'), 1);
  // Page chrome changes (a different nav link) do not count as a content change.
  pages[VARS_URL] = { body: page('Luau variables', VARS).replace('<a href="/x">nav</a>', '<a href="/y">other nav</a>') };
  assert.equal((await s.call(`/api/admin/discovery/candidates/${id}/extract`, {})).data.status, 'unchanged');

  // Pending proposal goes stale and is superseded by a re-extraction.
  pages[VARS_URL] = { body: page('Luau variables', [...VARS, 'The newest Luau release adds a new variable attribute for scripts.']) };
  assert.equal((await s.call('/api/admin/discovery/changes')).data.staleProposals.length, 0, 'nothing is stale before the source is re-checked');
  const second = await s.call(`/api/admin/discovery/candidates/${id}/extract`, {});
  assert.equal(second.status, 201); assert.equal(second.data.kind, 'new'); assert.deepEqual(second.data.supersededProposals, [first.data.proposalId]);
  assert.equal((s.raw.prepare('SELECT status FROM proposals WHERE id=?').get(first.data.proposalId) as any).status, 'superseded');

  // Publish the new one, then change the source again: an UPDATE proposal with an outdated-source finding.
  const pid = second.data.proposalId;
  await s.call(`/api/admin/proposals/${pid}/review`, { decision: 'approve' });
  assert.equal((await s.call('/api/admin/publish/rdev-luau', { proposalId: pid, verification })).status, 200);
  pages[VARS_URL] = { body: page('Luau variables', [...VARS, 'A different edit: variables can now carry type annotations in Luau.']) };
  const third = await s.call(`/api/admin/discovery/candidates/${id}/extract`, {});
  assert.equal(third.status, 201, JSON.stringify(third.data)); assert.equal(third.data.kind, 'update');
  const upd = s.raw.prepare('SELECT base_version,analysis_json,status FROM proposals WHERE id=?').get(third.data.proposalId) as any;
  assert.equal(upd.base_version, 1); assert.equal(upd.status, 'pending');
  assert.ok(JSON.parse(upd.analysis_json).findings.some((f: any) => f.type === 'outdated-source'));
  const ch = (await s.call('/api/admin/discovery/changes')).data;
  assert.equal(ch.outdatedPublished.length, 1, 'the published entry is reported as possibly outdated'); assert.equal(ch.outdatedPublished[0].type, 'outdated-source');
  // Approve the update, then the source changes once more before publication: publication is refused as stale.
  await s.call(`/api/admin/proposals/${third.data.proposalId}/review`, { decision: 'approve' });
  pages[VARS_URL] = { body: page('Luau variables', [...VARS, 'Yet another edit made after the owner approved the earlier extraction.']) };
  await s.call(`/api/admin/discovery/candidates/${id}/extract`, {});
  const stale = await s.call('/api/admin/publish/rdev-luau', { proposalId: third.data.proposalId, verification });
  assert.equal(stale.status, 409); assert.match(stale.data.error, /source has changed/i);
  assert.equal((await s.call('/api/admin/proposals?status=approved')).data.proposals[0].provenance.sourceChanged, true);
  assert.equal((s.raw.prepare("SELECT current_version FROM packages WHERE id='rdev-luau'").get() as any).current_version, '1.0.0');
});

test('duplicate content from a second source is flagged for review (not silently dropped or published)', async () => {
  const s = await setup(); await discover(s);
  const a = candidateId(s.raw, VARS_URL); const bUrl = 'https://create.roblox.com/docs/scripting/events/remote';
  pages[VARS_URL] = { body: page('Luau variables', VARS) }; pages[bUrl] = { body: page('Luau variables guide', VARS) };
  for (const [cid, sid] of [[a, 'src-a'], [candidateId(s.raw, bUrl), 'src-b']] as const) await s.call(`/api/admin/discovery/candidates/${cid}/review`, { decision: 'approve', sourceId: sid, license: 'CC BY 4.0' });
  const one = await s.call(`/api/admin/discovery/candidates/${a}/extract`, {});
  const two = await s.call(`/api/admin/discovery/candidates/${candidateId(s.raw, bUrl)}/extract`, {});
  assert.equal(two.status, 201); assert.ok(two.data.findings.block + two.data.findings.warn > 0, JSON.stringify(two.data.findings));
  const analysis = JSON.parse((s.raw.prepare('SELECT analysis_json FROM proposals WHERE id=?').get(two.data.proposalId) as any).analysis_json);
  assert.ok(analysis.findings.some((f: any) => f.type === 'near-duplicate-content' && f.others.length), 'overlap with the queued proposal is reported');
  assert.equal((s.raw.prepare('SELECT status FROM proposals WHERE id=?').get(one.data.proposalId) as any).status, 'pending');
});

test('a source without a license can be proposed but never published until the owner records one', async () => {
  const s = await setup(); await discover(s);
  const id = candidateId(s.raw, VARS_URL); pages[VARS_URL] = { body: page('Luau variables', VARS) };
  await s.call(`/api/admin/discovery/candidates/${id}/review`, { decision: 'approve', sourceId: 'nolicense' });
  const ex = await s.call(`/api/admin/discovery/candidates/${id}/extract`, {});
  assert.ok(JSON.parse((s.raw.prepare('SELECT analysis_json FROM proposals WHERE id=?').get(ex.data.proposalId) as any).analysis_json).validation.warnings.some((w: string) => /no recorded license/.test(w)));
  await s.call(`/api/admin/proposals/${ex.data.proposalId}/review`, { decision: 'approve' });
  const blocked = await s.call('/api/admin/publish/rdev-luau', { proposalId: ex.data.proposalId, verification });
  assert.equal(blocked.status, 422); assert.match(blocked.data.error, /license/);
  assert.equal((await s.call(`/api/admin/discovery/candidates/${id}/license`, { license: 'CC BY 4.0' })).status, 200);
  assert.equal((await s.call(`/api/admin/discovery/candidates/${id}/license`, { license: 'Other' })).status, 409, 'a recorded license is not silently overwritten');
  assert.equal((await s.call('/api/admin/publish/rdev-luau', { proposalId: ex.data.proposalId, verification })).status, 200);
});

test('unclassifiable content needs an owner-chosen path; failures and redirects are recorded safely', async () => {
  const s = await setup(); await discover(s);
  const id = candidateId(s.raw, VARS_URL);
  await s.call(`/api/admin/discovery/candidates/${id}/review`, { decision: 'approve', sourceId: 'misc', license: 'CC BY 4.0' });
  pages[VARS_URL] = { body: '<html><head><title>Gardening tips</title></head><body><h1>Gardening tips</h1><p>Water the tulips each morning.</p><p>Compost improves soil.</p></body></html>' };
  const un = await s.call(`/api/admin/discovery/candidates/${id}/extract`, {});
  assert.equal(un.data.status, 'unclassified'); assert.equal(count(s.raw, 'SELECT COUNT(*) n FROM proposals'), 0);
  assert.equal((await s.call(`/api/admin/discovery/candidates/${id}/extract`, { path: 'Nonsense' })).status, 400);
  assert.equal((await s.call(`/api/admin/discovery/candidates/${id}/extract`, { path: 'Professional Development' })).status, 201);
  // Redirect off the approved host list is not followed.
  pages[VARS_URL] = { body: '', status: 302, location: 'https://evil.example/steal' };
  const bad = await s.call(`/api/admin/discovery/candidates/${id}/extract`, {});
  assert.equal(bad.status, 502); assert.ok(!requested.some((u) => u.includes('evil.example')));
  assert.equal((s.raw.prepare('SELECT status FROM extraction_runs ORDER BY id DESC LIMIT 1').get() as any).status, 'failed');
  // A script-rendered page with no text is a failed (not silently empty) extraction.
  pages[VARS_URL] = { body: '<html><head><title>App</title></head><body><div id="root"></div></body></html>' };
  assert.equal((await s.call(`/api/admin/discovery/candidates/${id}/extract`, {})).status, 422);
});

test('GitHub repository candidates are read as raw Markdown', async () => {
  const s = await setup(); await discover(s);
  const url = 'https://github.com/Roblox/creator-docs'; const id = candidateId(s.raw, url);
  assert.deepEqual(contentUrls(url), ['https://raw.githubusercontent.com/Roblox/creator-docs/main/README.md', 'https://raw.githubusercontent.com/Roblox/creator-docs/master/README.md']);
  pages['https://raw.githubusercontent.com/Roblox/creator-docs/main/README.md'] = { type: 'text/plain', body: '---\ntitle: Creator documentation\ndescription: Source files for Studio and Luau documentation.\n---\n## Studio\nThe Studio explorer and properties windows are described here.\n```luau\nlocal part = workspace.Part\n```\n' };
  await s.call(`/api/admin/discovery/candidates/${id}/review`, { decision: 'approve', sourceId: 'creator-docs-repo', license: 'CC BY 4.0' });
  const ex = await s.call(`/api/admin/discovery/candidates/${id}/extract`, {});
  assert.equal(ex.status, 201, JSON.stringify(ex.data)); assert.equal(ex.data.path, 'Roblox Studio Fundamentals');
  assert.equal((s.raw.prepare('SELECT title FROM proposals WHERE id=?').get(ex.data.proposalId) as any).title, 'Creator documentation');
});

test('discovery routes are owner-only, CSRF-protected and degrade cleanly on a database that was not upgraded', async () => {
  const s = await setup();
  const anon = await adminApi(new Request('https://rdev.test/api/admin/discovery/overview'), s.env); assert.equal(anon!.status, 401);
  const csrf = await adminApi(new Request('https://rdev.test/api/admin/discovery/run', { method: 'POST', headers: { Cookie: '', Origin: 'https://evil.example' }, body: '{}' }), s.env); assert.equal(csrf!.status, 403);
  assert.equal((await s.call('/api/admin/discovery/run', { seedId: 'https://evil.example/' })).status, 400, 'only built-in discovery roots can be crawled');
  assert.equal((await s.call('/api/admin/discovery/overview')).data.seeds.length, SEEDS.length);
  // v0.3.0 database (no discovery tables): console proposals still work, discovery explains what to do.
  const old = new DatabaseSync(':memory:'); old.exec(readFileSync(join(ROOT, 'database/tests/legacy/v0.3.0-schema.sql'), 'utf8'));
  const env = { DB: adapter(old), OWNER_ADMIN_TOKEN: TOKEN };
  const login = await adminApi(new Request('https://rdev.test/api/admin/login', { method: 'POST', headers: { Origin: 'https://rdev.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) }), env);
  const h = { Cookie: login!.headers.get('set-cookie')!.split(';')[0], Origin: 'https://rdev.test' };
  assert.equal((await adminApi(new Request('https://rdev.test/api/admin/proposals', { headers: h }), env))!.status, 200);
  const d = await adminApi(new Request('https://rdev.test/api/admin/discovery/overview', { headers: h }), env); assert.equal(d!.status, 503);
  assert.match((await d!.json() as any).error, /upgrade-0\.4\.0/);
});

test('link extraction and candidate rules (unit)', () => {
  const links = extractLinks('<a href="/docs/ui/frames">Frames and layout</a> [Luau](https://luau.org/typecheck) <a href="mailto:x@y.z">m</a>', 'https://create.roblox.com/docs/ui');
  const c = candidatesFrom(links, SEEDS.find((x) => x.id === 'roblox-docs-ui')!);
  assert.deepEqual(c.map((x) => x.url).sort(), ['https://create.roblox.com/docs/ui/frames', 'https://luau.org/typecheck']);
  assert.equal(c.find((x) => x.url.endsWith('/frames'))!.suggestedPath, 'UI/UX Development');
});
