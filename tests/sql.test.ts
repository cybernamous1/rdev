import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { splitStatements } from '../scripts/sql-statements.ts';
import { ROOT, newDatabase, loadBootstrap, approveAndPublishPath } from './helpers/sqlite.ts';

const initSql = readFileSync(join(ROOT, 'database', 'init.sql'), 'utf8'); const deleteSql = readFileSync(join(ROOT, 'database', 'delete.sql'), 'utf8');
const names = (db: DatabaseSync) => (db.prepare("SELECT type||':'||name AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY 1").all() as { n: string }[]).map((r) => r.n);
const D1_STATEMENT_LIMIT = 100_000; // bytes; documented D1 limit as I recall it — verify against current Cloudflare docs

test('files: delete.sql exists, reset.sql does not, old v0.2.0 artifacts are gone', () => {
  assert.ok(existsSync(join(ROOT, 'database', 'delete.sql'))); assert.ok(existsSync(join(ROOT, 'database', 'init.sql')));
  for (const gone of ['database/reset.sql', 'database/schema.sql', 'database/seed', 'database/migrations', 'public/knowledge']) assert.ok(!existsSync(join(ROOT, gone)), gone);
});

test('init.sql splits into statements that D1 could take one by one', () => {
  const stmts = splitStatements(initSql); assert.ok(stmts.length > 60);
  for (const s of stmts) assert.ok(Buffer.byteLength(s) < D1_STATEMENT_LIMIT / 10, 'every statement is far below the size limit');
  for (const s of stmts) assert.ok(!/^\s*(PRAGMA|BEGIN\s+TRANSACTION|COMMIT|ROLLBACK|ATTACH|VACUUM)\b/i.test(s.replace(/--[^\n]*\n/g, '').trim()), 'no statement D1 rejects: ' + s.slice(0, 40));
  const whole = new DatabaseSync(':memory:'); whole.exec(initSql);
  const piece = new DatabaseSync(':memory:'); for (const s of stmts) piece.exec(s);
  assert.deepEqual(names(piece), names(whole), 'statement-by-statement equals whole-file');
  const body = (s: string) => s.replace(/^(\s*--[^\n]*\n)+/, '').trim();
  assert.equal(stmts.filter((s) => /^CREATE TRIGGER/i.test(body(s))).length, names(whole).filter((n) => n.startsWith('trigger:')).length, 'every trigger is kept as ONE statement');
});

test('delete.sql: complete, dependency-ordered, works with foreign keys enforced', async () => {
  const db = newDatabase(); const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  const drops = [...deleteSql.matchAll(/^DROP TABLE IF EXISTS (\w+);/gm)].map((m) => m[1]);
  for (const t of tables) assert.ok(drops.includes(t), `delete.sql drops ${t}`);
  const edges = tables.flatMap((t) => (db.prepare(`PRAGMA foreign_key_list(${t})`).all() as { table: string }[]).map((f) => [t, f.table]));
  assert.ok(edges.length >= 12);
  for (const [child, parent] of edges) assert.ok(drops.indexOf(child) < drops.indexOf(parent), `${child} must be dropped before ${parent}`);
  await loadBootstrap(db); db.exec(deleteSql); assert.deepEqual(names(db), [], 'populated database fully deleted');
  const wrong = newDatabase(); await loadBootstrap(wrong); await approveAndPublishPath(wrong, 'Luau Programming');
  assert.throws(() => wrong.exec('DROP TABLE packages'), /FOREIGN KEY|constraint/i, 'negative control: dropping a parent first fails when children have rows');
});

test('init.sql refuses to run over legacy tables (loud failure before anything is created)', () => {
  for (const legacy of ['knowledge_items', 'rlf_packages', 'relationships', 'entry_sources', 'sources']) {
    const db = new DatabaseSync(':memory:'); db.exec(`CREATE TABLE ${legacy} (x INTEGER)`);
    assert.throws(() => db.exec(initSql), /already|exists/i, legacy);
    if (legacy !== 'sources') assert.ok(!names(db).some((n) => n === 'table:schema_info'), 'nothing was created before the guard failed (' + legacy + ')');
  }
  const db = new DatabaseSync(':memory:'); db.exec(deleteSql); db.exec(initSql); db.exec(deleteSql); db.exec(initSql);
});

test('system records and strict version constraints', () => {
  const db = newDatabase();
  assert.equal((db.prepare('SELECT COUNT(*) c FROM packages WHERE current_version IS NULL').get() as { c: number }).c, 8);
  assert.equal((db.prepare("SELECT value FROM schema_info WHERE key='schema_version'").get() as { value: string }).value, '0.4.0');
  const ins = (v: string) => db.prepare("INSERT INTO package_versions(package_id,version,checksum,entry_count,body) VALUES ('rdev-art',?,'c',0,?)").run(v, JSON.stringify({ id: 'rdev-art', version: v, checksum: 'c', entries: [] }));
  for (const v of ['0.0.0', '1.10.2', '123456789.0.1']) ins(v);
  for (const v of ['1.0', '01.0.0', '1.0.0-rc', '1..0', '1.0.0\n', '١.٠.٠', 'v1.0.0']) assert.throws(() => ins(v), /CHECK|constraint/i, JSON.stringify(v));
});

test('proposal lifecycle is enforced and audited (bootstrap → approve → audit trail)', async () => {
  const db = newDatabase(); await loadBootstrap(db);
  const id = (db.prepare("SELECT MIN(id) i FROM proposals").get() as { i: number }).i;
  assert.throws(() => db.exec(`UPDATE proposals SET status='published' WHERE id=${id}`), /invalid proposal status transition/);
  db.prepare("UPDATE proposals SET status='approved', reviewed_at='2026-11-22T00:00:00Z', review_note='ok' WHERE id=?").run(id);
  assert.throws(() => db.exec(`UPDATE proposals SET review_note='sneaky' WHERE id=${id}`), /review metadata/);
  assert.throws(() => db.exec(`UPDATE proposals SET title='x' WHERE id=${id}`), /immutable/);
  assert.throws(() => db.exec(`DELETE FROM proposals WHERE id=${id}`), /cannot be deleted/);
  const ev = db.prepare('SELECT from_status f, to_status t FROM proposal_events WHERE proposal_id=? ORDER BY id').all(id) as { f: string | null; t: string }[];
  assert.deepEqual(ev.map((e) => [e.f, e.t]), [[null, 'pending'], ['pending', 'approved']]);
  assert.throws(() => db.exec('UPDATE proposal_events SET note=1'), /append-only/);
  await loadBootstrap(db); assert.equal((db.prepare('SELECT COUNT(*) c FROM proposals').get() as { c: number }).c, 7, 're-running bootstrap is idempotent');
  assert.equal((db.prepare("SELECT COUNT(*) c FROM entries").get() as { c: number }).c, 0);
});

test('private bootstrap files (only when present) respect the statement limit and create only proposals', { skip: !existsSync(join(ROOT, 'database', 'bootstrap', '00-sources.sql')) }, () => {
  const dir = join(ROOT, 'database', 'bootstrap'); const db = newDatabase();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) { const sql = readFileSync(join(dir, f), 'utf8'); for (const s of splitStatements(sql)) assert.ok(Buffer.byteLength(s) < D1_STATEMENT_LIMIT, f); db.exec(sql); }
  assert.equal((db.prepare("SELECT COUNT(*) c FROM proposals WHERE status='pending' AND origin='bootstrap'").get() as { c: number }).c, 36);
  for (const t of ['entries', 'entry_versions', 'package_versions', 'publications']) assert.equal((db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c, 0);
});

test('upgrade-0.4.0.sql turns a v0.3.0 database into exactly the v0.4.0 schema, keeping existing data', async () => {
  const legacy = join(ROOT, 'database', 'tests', 'legacy', 'v0.3.0-schema.sql'); const upgrade = readFileSync(join(ROOT, 'database', 'upgrade-0.4.0.sql'), 'utf8');
  const old = new DatabaseSync(':memory:'); old.exec(readFileSync(legacy, 'utf8')); await loadBootstrap(old); await approveAndPublishPath(old, 'Luau Programming');
  const pointer = () => (old.prepare("SELECT current_version v FROM packages WHERE id='rdev-luau'").get() as { v: string }).v;
  const before = [pointer(), (old.prepare('SELECT COUNT(*) c FROM proposals').get() as { c: number }).c];
  old.exec(upgrade);
  assert.deepEqual(names(old), names(newDatabase()), 'upgraded schema equals a fresh v0.4.0 init');
  assert.deepEqual([pointer(), (old.prepare('SELECT COUNT(*) c FROM proposals').get() as { c: number }).c], before, 'published content and proposals untouched');
  assert.equal((old.prepare("SELECT value FROM schema_info WHERE key='schema_version'").get() as { value: string }).value, '0.4.0');
  assert.throws(() => old.exec(upgrade), /already exists/i, 'running the upgrade twice fails loudly');
  const stmts = splitStatements(upgrade); for (const s of stmts) assert.ok(Buffer.byteLength(s) < D1_STATEMENT_LIMIT / 10 && !/^\s*(PRAGMA|BEGIN|COMMIT|ROLLBACK)\b/i.test(s.replace(/--[^\n]*\n/g, '').trim()));
  const piece = new DatabaseSync(':memory:'); piece.exec(readFileSync(legacy, 'utf8')); for (const s of stmts) piece.exec(s); assert.deepEqual(names(piece), names(old), 'statement-by-statement upgrade works');
});
