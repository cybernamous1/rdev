import { test } from 'node:test';
import assert from 'node:assert/strict';
import app, { type Env } from '../worker/index.ts';
import { validatePackage, type RlfPackage } from '../shared/rlf.ts';
import { newDatabase, asDb, loadBootstrap, approveAndPublishPath, publishUpdate, rollbackTo } from './helpers/sqlite.ts';

const assets = { fetch: async () => new Response('static-asset', { status: 200 }) };
const get = (env: Env, path: string, init?: RequestInit) => Promise.resolve(app.request(path, init, env));
const json = async (r: Response) => JSON.parse(await r.text());

test('API: nothing is public after bootstrap (pending proposals stay private)', async () => {
  const raw = newDatabase(); const n = await loadBootstrap(raw); assert.equal(n, 7);
  const env: Env = { DB: asDb(raw), ASSETS: assets };
  const h = await json(await get(env, '/api/v1/health')); assert.deepEqual([h.status, h.databaseConfigured, h.databaseReady, h.version], ['ok', true, true, '0.3.0']);
  const bodies = [await (await get(env, '/api/v1/packages')).text(), await (await get(env, '/api/v1/sources')).text()];
  assert.deepEqual(JSON.parse(bodies[0]), { packages: [] }); assert.deepEqual(JSON.parse(bodies[1]), { sources: [] });
  for (const b of bodies) assert.ok(!b.includes('fx-'), 'no fixture content may appear in any public response');
  assert.equal((await get(env, '/api/v1/packages/rdev-luau/1.0.0')).status, 404);
});

test('API: only approved + published content is served; other pending proposals stay private', async () => {
  const raw = newDatabase(); await loadBootstrap(raw); await approveAndPublishPath(raw, 'Luau Programming');
  const env: Env = { DB: asDb(raw), ASSETS: assets };
  const m = await json(await get(env, '/api/v1/packages'));
  assert.equal(m.packages.length, 1); assert.equal(m.packages[0].id, 'rdev-luau'); assert.equal(m.packages[0].entries, 6);
  const res = await get(env, '/api/v1/packages/rdev-luau/1.0.0'); assert.equal(res.status, 200);
  const pkg = JSON.parse(await res.text()) as RlfPackage;
  const v = await validatePackage(pkg); assert.deepEqual(v.errors, [], 'served package passes full RLF validation incl. checksum');
  assert.equal(pkg.checksum, m.packages[0].checksum);
  assert.ok(pkg.entries.every((e) => e.status === 'published' && e.id.startsWith('fx-') && e.path === 'Luau Programming'));
  const all = JSON.stringify(m) + JSON.stringify(pkg) + (await (await get(env, '/api/v1/sources')).text());
  assert.ok(!all.includes('fx-pro-one') && !all.includes('planning bakeries'), 'the unpublished Professional Development proposal is not exposed');
  const src = await json(await get(env, '/api/v1/sources')); assert.deepEqual(src.sources.map((s: { id: string }) => s.id), ['fx-source-a']);
  assert.equal(src.sources[0].status, 'unchecked');
});

test('API: ETag revalidation, HEAD, validation of parameters, cache headers', async () => {
  const raw = newDatabase(); await loadBootstrap(raw); await approveAndPublishPath(raw, 'Luau Programming');
  const env: Env = { DB: asDb(raw), ASSETS: assets };
  const r1 = await get(env, '/api/v1/packages'); const etag = r1.headers.get('etag')!; assert.ok(etag);
  assert.match(r1.headers.get('cache-control')!, /max-age=60/);
  assert.equal((await get(env, '/api/v1/packages', { headers: { 'If-None-Match': etag } })).status, 304);
  const p1 = await get(env, '/api/v1/packages/rdev-luau/1.0.0'); const pe = p1.headers.get('etag')!;
  assert.equal((await get(env, '/api/v1/packages/rdev-luau/1.0.0', { headers: { 'If-None-Match': pe } })).status, 304);
  const head = await get(env, '/api/v1/packages', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  for (const bad of ['/api/v1/packages/RDEV/1.0.0', '/api/v1/packages/rdev-luau/1.0', '/api/v1/packages/rdev-luau/01.0.0', '/api/v1/packages/rdev-luau/1.0.0-beta', '/api/v1/packages/a_b/1.0.0']) assert.equal((await get(env, bad)).status, 400, bad);
  assert.equal((await get(env, '/api/v1/packages/rdev-ui/1.0.0')).status, 404);
  assert.equal(r1.headers.get('x-content-type-options'), 'nosniff');
});

test('API: updates and rollback — only the CURRENT version is served', async () => {
  const raw = newDatabase(); await loadBootstrap(raw); const { pkg } = await approveAndPublishPath(raw, 'Luau Programming');
  await publishUpdate(raw, pkg, 'fx-alpha', 'Fixture alpha: counting widgets (revised)', '1.0.1');
  const env: Env = { DB: asDb(raw), ASSETS: assets };
  assert.equal((await json(await get(env, '/api/v1/packages'))).packages[0].version, '1.0.1');
  assert.equal((await get(env, '/api/v1/packages/rdev-luau/1.0.0')).status, 404, 'superseded version is not served');
  const v2 = JSON.parse(await (await get(env, '/api/v1/packages/rdev-luau/1.0.1')).text()) as RlfPackage;
  assert.ok(v2.entries.some((e) => e.title.endsWith('(revised)')) && (await validatePackage(v2)).ok);
  rollbackTo(raw, pkg, '1.0.0');
  assert.equal((await json(await get(env, '/api/v1/packages'))).packages[0].version, '1.0.0');
  assert.equal((await get(env, '/api/v1/packages/rdev-luau/1.0.1')).status, 404, 'rolled-back version disappears from the API');
  const v1 = JSON.parse(await (await get(env, '/api/v1/packages/rdev-luau/1.0.0')).text()) as RlfPackage;
  assert.ok(!v1.entries.some((e) => e.title.endsWith('(revised)')));
});

test('API: admin and unknown routes are 404, writes are 405, no database is handled', async () => {
  const raw = newDatabase(); const env: Env = { DB: asDb(raw), ASSETS: assets };
  for (const p of ['/api/admin', '/api/admin/proposals', '/api/admin/login', '/api/v1/proposals', '/api/knowledge', '/api/health']) assert.equal((await get(env, p)).status, 404, p);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await get(env, '/api/v1/packages', { method })).status, 405, method);
  assert.equal((await get(env, '/api/admin/login', { method: 'POST' })).status, 405);
  const none: Env = { ASSETS: assets };
  const h = await json(await get(none, '/api/v1/health')); assert.deepEqual([h.databaseConfigured, h.databaseReady], [false, false]);
  for (const p of ['/api/v1/packages', '/api/v1/sources', '/api/v1/packages/rdev-luau/1.0.0']) assert.equal((await get(none, p)).status, 503, p);
  const broken: Env = { DB: asDb(raw, { failWith: new Error('D1 unavailable') }), ASSETS: assets };
  assert.equal((await get(broken, '/api/v1/packages')).status, 503); assert.equal((await json(await get(broken, '/api/v1/health'))).databaseReady, false);
  assert.equal(await (await get(env, '/index.html')).text(), 'static-asset', 'non-API paths fall through to static assets');
});
