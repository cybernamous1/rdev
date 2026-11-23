import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBootstrap } from '../scripts/gen-bootstrap.ts';
import { adminApi } from '../worker/admin-api.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function adapter(raw: DatabaseSync) {
  const prepare = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async <T,>() => (raw.prepare(sql).get(...args as never[]) as T | undefined) ?? null,
    all: async <T,>() => ({ results: raw.prepare(sql).all(...args as never[]) as T[] }),
    run: async () => raw.prepare(sql).run(...args as never[]),
    sql, args
  });
  return {
    prepare: (sql: string) => prepare(sql),
    batch: async (items: ReturnType<typeof prepare>[]) => {
      raw.exec('BEGIN');
      try { const out = items.map(x => raw.prepare(x.sql).run(...x.args as never[])); raw.exec('COMMIT'); return out; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    }
  };
}
async function fixture() {
  const raw = new DatabaseSync(':memory:'); raw.exec(readFileSync(join(ROOT, 'database/init.sql'), 'utf8'));
  const out = mkdtempSync(join(tmpdir(), 'rdev-admin-'));
  const generated = await generateBootstrap({ content: join(ROOT, 'tests/fixtures/content'), out });
  assert.equal(generated.ok, true);
  for (const file of readdirSync(out).sort()) raw.exec(readFileSync(join(out, file), 'utf8'));
  return { raw, db: adapter(raw) };
}
const TOKEN = 'test-owner-token-' + 'x'.repeat(40);

test('owner can approve, separately verify, and atomically publish one proposal to the public package API tables', async () => {
  const { raw, db } = await fixture();
  const env = { DB: db, OWNER_ADMIN_TOKEN: TOKEN };
  const login = await adminApi(new Request('https://rdev.test/api/admin/login', { method: 'POST', headers: { Origin: 'https://rdev.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) }), env);
  assert.equal(login?.status, 200);
  const cookie = login!.headers.get('set-cookie')!.split(';')[0];
  const proposal = raw.prepare("SELECT id,title FROM proposals WHERE status='pending' AND json_extract(payload_json,'$.path')='Luau Programming' ORDER BY id LIMIT 1").get() as { id: number; title: string };
  const headers = { Cookie: cookie, Origin: 'https://rdev.test', 'Content-Type': 'application/json' };
  const approved = await adminApi(new Request(`https://rdev.test/api/admin/proposals/${proposal.id}/review`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve' }) }), env);
  assert.equal(approved?.status, 200);
  const publish = await adminApi(new Request('https://rdev.test/api/admin/publish/rdev-luau', { method: 'POST', headers, body: JSON.stringify({ proposalId: proposal.id, verification: { confirmed: true, reviewer: 'Test Reviewer', notes: 'Inspected lesson structure, code examples, references and licensing.' } }) }), env);
  assert.equal(publish?.status, 200, await publish!.text());
  const pointer = raw.prepare("SELECT current_version FROM packages WHERE id='rdev-luau'").get() as { current_version: string };
  assert.equal(pointer.current_version, '1.0.0');
  assert.equal((raw.prepare("SELECT status FROM proposals WHERE id=?").get(proposal.id) as { status: string }).status, 'published');
  const body = JSON.parse((raw.prepare("SELECT body FROM package_versions WHERE package_id='rdev-luau' AND version='1.0.0'").get() as { body: string }).body);
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].status, 'published');
  assert.equal(body.entries[0].review.reviewer, 'Test Reviewer');
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM publications WHERE package_id='rdev-luau'").get() as { n: number }).n, 1);
});

// ---------- additional safety coverage ----------
async function session(env: any) {
  const login = await adminApi(new Request('https://rdev.test/api/admin/login', { method: 'POST', headers: { Origin: 'https://rdev.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) }), env);
  assert.equal(login?.status, 200);
  return { Cookie: login!.headers.get('set-cookie')!.split(';')[0], Origin: 'https://rdev.test', 'Content-Type': 'application/json' };
}
const call = (env: any, headers: Record<string, string>, path: string, body?: unknown, method = 'POST') => adminApi(new Request('https://rdev.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
const verification = { confirmed: true, reviewer: 'Test Reviewer', notes: 'Inspected lesson structure, code examples, references and licensing.' };
const pendingFor = (raw: DatabaseSync, path: string) => raw.prepare("SELECT id FROM proposals WHERE status='pending' AND kind='new' AND json_extract(payload_json,'$.path')=? ORDER BY id").all(path) as { id: number }[];
async function approve(env: any, h: Record<string, string>, id: number) { assert.equal((await call(env, h, `/api/admin/proposals/${id}/review`, { decision: 'approve' }))?.status, 200); }
async function publishOne(env: any, h: Record<string, string>, pkg: string, id: number) { await approve(env, h, id); return call(env, h, `/api/admin/publish/${pkg}`, { proposalId: id, verification }); }

test('unapproved or pending proposals can never be published, and nothing becomes public', async () => {
  const { raw, db } = await fixture(); const env = { DB: db, OWNER_ADMIN_TOKEN: TOKEN }; const h = await session(env);
  const [first] = pendingFor(raw, 'Luau Programming');
  const res = await call(env, h, '/api/admin/publish/rdev-luau', { proposalId: first.id, verification });
  assert.equal(res?.status, 409);
  assert.equal((raw.prepare("SELECT current_version FROM packages WHERE id='rdev-luau'").get() as any).current_version, null);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM package_versions').get() as any).n, 0);
  const noVerify = await call(env, h, '/api/admin/publish/rdev-luau', { proposalId: first.id, verification: { confirmed: false, reviewer: 'x', notes: 'short' } });
  assert.equal(noVerify?.status, 400);
});

test('rejection requires a reason and a rejected proposal cannot be published', async () => {
  const { raw, db } = await fixture(); const env = { DB: db, OWNER_ADMIN_TOKEN: TOKEN }; const h = await session(env);
  const [first] = pendingFor(raw, 'Luau Programming');
  assert.equal((await call(env, h, `/api/admin/proposals/${first.id}/review`, { decision: 'reject' }))?.status, 400);
  assert.equal((await call(env, h, `/api/admin/proposals/${first.id}/review`, { decision: 'reject', note: 'Inaccurate example.' }))?.status, 200);
  assert.equal((await call(env, h, `/api/admin/proposals/${first.id}/review`, { decision: 'approve' }))?.status, 409);
  assert.equal((await call(env, h, '/api/admin/publish/rdev-luau', { proposalId: first.id, verification }))?.status, 409);
  assert.equal((await call(env, h, '/api/admin/proposals/999999/review', { decision: 'approve' }))?.status, 404);
});

test('a second publication appends to the package; rollback then publishing again never reuses a version', async () => {
  const { raw, db } = await fixture(); const env = { DB: db, OWNER_ADMIN_TOKEN: TOKEN }; const h = await session(env);
  const ids = pendingFor(raw, 'Luau Programming').map((p) => p.id); assert.ok(ids.length >= 3);
  assert.equal((await publishOne(env, h, 'rdev-luau', ids[0]))?.status, 200);
  assert.equal((await publishOne(env, h, 'rdev-luau', ids[1]))?.status, 200);
  const current = () => (raw.prepare("SELECT current_version FROM packages WHERE id='rdev-luau'").get() as any).current_version;
  assert.equal(current(), '1.0.1');
  assert.equal(JSON.parse((raw.prepare("SELECT body FROM package_versions WHERE package_id='rdev-luau' AND version='1.0.1'").get() as any).body).entries.length, 2);
  // Roll back to 1.0.0: public API now serves exactly the first package.
  assert.equal((await call(env, h, '/api/admin/rollback/rdev-luau', { version: '1.0.0' }))?.status, 200);
  assert.equal(current(), '1.0.0');
  // Invalid rollback targets are refused without touching the pointer.
  assert.equal((await call(env, h, '/api/admin/rollback/rdev-luau', { version: '9.9.9' }))?.status, 409);
  assert.equal((await call(env, h, '/api/admin/rollback/rdev-luau', { version: 'latest' }))?.status, 400);
  assert.equal(current(), '1.0.0');
  // Publishing after a rollback must allocate 1.0.2 (above every existing version), not collide with 1.0.1.
  const res = await publishOne(env, h, 'rdev-luau', ids[2]);
  assert.equal(res?.status, 200, await res!.clone().text());
  assert.equal(current(), '1.0.2');
  const body = JSON.parse((raw.prepare("SELECT body FROM package_versions WHERE package_id='rdev-luau' AND version='1.0.2'").get() as any).body);
  assert.equal(body.entries.length, 2, 'rolled-back-away entry is not silently reintroduced');
  assert.deepEqual(await (async () => { const { validatePackage } = await import('../shared/rlf.ts'); return (await validatePackage(body)).errors; })(), []);
  const history = raw.prepare("SELECT action FROM publications WHERE package_id='rdev-luau' ORDER BY id").all().map((r: any) => r.action);
  assert.deepEqual(history, ['publish', 'publish', 'rollback', 'publish']);
});

test('owner API rejects missing Origin on mutations, bad bodies, oversized bodies and expired sessions', async () => {
  const { raw, db } = await fixture(); const env = { DB: db, OWNER_ADMIN_TOKEN: TOKEN }; const h = await session(env);
  const noOrigin = await adminApi(new Request('https://rdev.test/api/admin/logout', { method: 'POST', headers: { Cookie: h.Cookie } }), env);
  assert.equal(noOrigin?.status, 403);
  assert.equal((await adminApi(new Request('https://rdev.test/api/admin/sources', { method: 'POST', headers: h, body: 'not json' }), env))?.status, 400);
  assert.equal((await adminApi(new Request('https://rdev.test/api/admin/sources', { method: 'POST', headers: h, body: JSON.stringify({ pad: 'x'.repeat(40_000) }) }), env))?.status, 400);
  assert.equal((await call(env, h, '/api/admin/sources', { id: 'bad', label: 'L', publisher: 'P', url: 'http://create.roblox.com/x' }))?.status, 400);
  assert.equal((await call(env, h, '/api/admin/sources', { id: 'bad', label: 'L', publisher: 'P', url: 'https://evil.example/x' }))?.status, 400);
  assert.equal((await call(env, h, '/api/admin/sources', { id: 'ok-src', label: 'Docs', publisher: 'Roblox', url: 'https://create.roblox.com/docs/new' }))?.status, 201);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM security_events WHERE event='source_registered'").get() as any).n, 1);
  // Expire the session server-side: the next request must be refused and the session revoked.
  raw.exec("UPDATE admin_sessions SET idle_expires_at='2000-01-01T00:00:00.000Z'");
  const expired = await call(env, h, '/api/admin/overview', undefined, 'GET');
  assert.equal(expired?.status, 401);
  assert.ok((raw.prepare('SELECT revoked_at FROM admin_sessions').get() as any).revoked_at);
  // A rotated owner secret invalidates sessions that were issued under the old one.
  const h2 = await session(env);
  assert.equal((await call({ DB: db, OWNER_ADMIN_TOKEN: 'rotated-' + 'y'.repeat(40) }, h2, '/api/admin/overview', undefined, 'GET'))?.status, 401);
});

test('failed logins are rate limited and never create a session', async () => {
  const { raw, db } = await fixture(); const env = { DB: db, OWNER_ADMIN_TOKEN: TOKEN };
  const attempt = (token: string) => adminApi(new Request('https://rdev.test/api/admin/login', { method: 'POST', headers: { Origin: 'https://rdev.test', 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify({ token }) }), env);
  for (let i = 0; i < 8; i++) assert.equal((await attempt('wrong-' + 'z'.repeat(40)))?.status, 401);
  assert.equal((await attempt(TOKEN))?.status, 429, 'even the right credential is refused while rate limited');
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get() as any).n, 0);
  assert.ok((raw.prepare("SELECT COUNT(*) AS n FROM security_events WHERE event='owner_login_failed'").get() as any).n >= 8);
});
