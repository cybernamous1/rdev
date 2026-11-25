// Migration safety: upgrade a COPY of a v0.4.0 database (built from the legacy 0.3.0 schema + upgrade-0.4.0.sql, with data) to 0.5.0.
// Local SQLite only - this does NOT prove behaviour on Cloudflare D1 (see docs/v0.5.0-implementation-report.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sql, v040, freshV05 } from './helpers/d1-shim.ts';

const V4_TABLES = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[]).map((r) => r.name as string);
const dump = (db: DatabaseSync, tables: string[]) => Object.fromEntries(tables.map((t) => [t, createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).digest('hex')]));
const schemaNames = (db: DatabaseSync) => (db.prepare("SELECT type||':'||name AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY 1").all() as any[]).map((r) => r.n);
const NEW_TABLES = ['discovery_jobs', 'discovery_frontier', 'host_policies', 'discovered_source_meta', 'license_evidence', 'license_reviews'];

function seed(db: DatabaseSync) {
  db.exec(`INSERT INTO discovery_runs(seed_id,status,pages_fetched,links_found,new_candidates,note) VALUES('legacy-seed','completed',3,9,2,'v0.4.0 run');
    INSERT INTO discovered_sources(url,host,title,publisher,category,suggested_path,relevance,discovered_via,run_id) VALUES
      ('https://create.roblox.com/docs/luau','create.roblox.com','Luau docs','Roblox','official-docs','Luau Programming',9,'link',1),
      ('https://github.com/Roblox/luau','github.com','luau repo','Roblox','repository',NULL,5,'link',1);`);
}

test('upgrade 0.4.0 -> 0.5.0 on a copy keeps every existing table and row byte-identical and only adds new structures', () => {
  const db = v040(); seed(db); const before = V4_TABLES(db); const hashes = dump(db, before); const schemaBefore = schemaNames(db);
  assert.equal((db.prepare("SELECT value FROM schema_info WHERE key='schema_version'").get() as any).value, '0.4.0');
  db.exec(sql('database/upgrade-0.5.0.sql'));
  const after = V4_TABLES(db); for (const t of before) assert.ok(after.includes(t), `table ${t} survived`);
  assert.deepEqual(after.filter((t) => !before.includes(t)).sort(), [...NEW_TABLES].sort());
  const h2 = dump(db, before.filter((t) => t !== 'schema_info' && t !== 'security_events')); for (const [t, h] of Object.entries(h2)) assert.equal(h, hashes[t], `rows of ${t} unchanged`);
  for (const n of schemaBefore) assert.ok(schemaNames(db).includes(n), `${n} still present`);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM discovered_sources').get() as any).n, 2);
  assert.equal((db.prepare("SELECT value FROM schema_info WHERE key='schema_version'").get() as any).value, '0.5.0'); assert.ok(db.prepare("SELECT 1 FROM schema_info WHERE key='upgraded_to_0_5_0_at'").get());
  assert.equal(db.prepare("SELECT 1 FROM schema_info WHERE key='upgrade_0_5_0_precheck'").get(), undefined, 'precheck marker removed');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
test('upgrade is repeatable: running it again changes nothing', () => {
  const db = v040(); seed(db); db.exec(sql('database/upgrade-0.5.0.sql')); const t = V4_TABLES(db); const h = dump(db, t.filter((x) => x !== 'security_events')); const s = schemaNames(db);
  db.exec(sql('database/upgrade-0.5.0.sql')); assert.deepEqual(V4_TABLES(db), t); assert.deepEqual(dump(db, t.filter((x) => x !== 'security_events')), h); assert.deepEqual(schemaNames(db), s);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM security_events WHERE detail LIKE 'schema 0.5.0%'").get() as any).n, 1);
});
test('upgrade refuses a database that is not at schema 0.4.0 and creates nothing', () => {
  const old = new DatabaseSync(':memory:'); old.exec(sql('database/tests/legacy/v0.3.0-schema.sql'));
  assert.throws(() => old.exec(sql('database/upgrade-0.5.0.sql')), /NOT NULL/); assert.deepEqual(V4_TABLES(old).filter((t) => NEW_TABLES.includes(t)), []);
  const empty = new DatabaseSync(':memory:'); empty.exec('CREATE TABLE schema_info(key TEXT PRIMARY KEY, value TEXT NOT NULL)'); assert.throws(() => empty.exec(sql('database/upgrade-0.5.0.sql')));
});
test('fresh init.sql and the upgrade path produce the same schema objects; delete.sql removes every v0.5.0 table', () => {
  const up = v040(); up.exec(sql('database/upgrade-0.5.0.sql')); const fresh = freshV05(); assert.deepEqual(schemaNames(fresh), schemaNames(up));
  const block = (f: string) => /-- ===== v0\.5\.0 BEGIN[\s\S]*?-- ===== v0\.5\.0 END =====/.exec(sql(f))![0]; assert.equal(block('database/init.sql'), block('database/upgrade-0.5.0.sql'));
  fresh.exec('PRAGMA foreign_keys=OFF'); fresh.exec(sql('database/delete.sql')); assert.deepEqual(V4_TABLES(fresh), []);
});
test('v0.4.0 append-only and approval triggers still hold after the upgrade', () => {
  const db = v040(); seed(db); db.exec(sql('database/upgrade-0.5.0.sql'));
  assert.throws(() => db.exec("DELETE FROM discovered_sources WHERE id=1")); assert.throws(() => db.exec("UPDATE discovered_sources SET status='approved' WHERE id=1"), /./, 'approval still requires the existing owner review path or its guards');
});

let n = 0; const cand = (db: DatabaseSync) => { db.exec(`INSERT INTO discovered_sources(url,host,title,publisher,category,relevance,discovered_via) VALUES('https://x.example.com/a${++n}','x.example.com','A','x','official-docs',5,'v5:test')`); return Number((db.prepare('SELECT MAX(id) AS id FROM discovered_sources').get() as any).id); };
const ev = (db: DatabaseSync, id: number, fp = 'f1') => db.prepare("INSERT INTO license_evidence(candidate_id,fingerprint,kind,identifier,label,evidence_url,excerpt,method,scope,confidence,indicates,detector_version,detected_at) VALUES(?,?,'creative-commons','CC-BY-4.0','CC BY','https://x.example.com/a','Licensed under CC BY','text-pattern','page',0.8,'permissive','t','2026-01-01T00:00:00Z')").run(id, fp);
const review = (db: DatabaseSync, o: Record<string, unknown>) => { const r = { candidate_id: 1, decision: 'cleared', basis: 'detected-evidence', scope: 'page text', permits_display: 1, evidence_ids_json: '[]', assessment_status: 'indicated-permissive', acknowledged_ambiguity: 0, note: 'Read the licence page myself.', conditions: null, ...o };
  return db.prepare('INSERT INTO license_reviews(candidate_id,decision,basis,scope,permits_display,conditions,evidence_ids_json,assessment_status,acknowledged_ambiguity,note) VALUES(?,?,?,?,?,?,?,?,?,?)').run(r.candidate_id as any, r.decision as any, r.basis as any, r.scope as any, r.permits_display as any, r.conditions as any, r.evidence_ids_json as any, r.assessment_status as any, r.acknowledged_ambiguity as any, r.note as any); };
test('licensing safeguards in the database: append-only, evidence must exist for the candidate, ambiguity needs acknowledgement, conditions must be written', () => {
  const db = freshV05(); const id = cand(db); ev(db, id); const other = cand(db);
  assert.throws(() => ev(db, id), /UNIQUE/, 'rescans are idempotent via fingerprint');
  assert.throws(() => db.exec('UPDATE license_evidence SET confidence=1'), /append-only/); assert.throws(() => db.exec('DELETE FROM license_evidence'), /append-only/);
  assert.throws(() => review(db, { candidate_id: id, evidence_ids_json: '[]' }), /must cite evidence/); assert.throws(() => review(db, { candidate_id: id, evidence_ids_json: '[999]' }), /must cite evidence/);
  assert.throws(() => review(db, { candidate_id: other, evidence_ids_json: '[1]' }), /must cite evidence/, 'evidence of another candidate is refused');
  assert.throws(() => review(db, { candidate_id: id, evidence_ids_json: '[1]', note: 'short' }), /CHECK/);
  review(db, { candidate_id: id, evidence_ids_json: '[1]' });
  for (const status of ['ambiguous', 'conflicting', 'no-evidence', 'restricted']) assert.throws(() => review(db, { candidate_id: id, evidence_ids_json: '[1]', assessment_status: status }), /acknowledg/, status);
  review(db, { candidate_id: id, basis: 'owner-written-permission', assessment_status: 'ambiguous', acknowledged_ambiguity: 1, note: 'Publisher emailed written permission on 2026-11-01.' });
  assert.throws(() => review(db, { candidate_id: id, decision: 'cleared-with-conditions', evidence_ids_json: '[1]', conditions: '  ' }), /conditions/); review(db, { candidate_id: id, decision: 'cleared-with-conditions', evidence_ids_json: '[1]', conditions: 'Give credit to the author.' });
  review(db, { candidate_id: id, decision: 'denied', basis: 'owner-judgement', permits_display: 0, assessment_status: 'conflicting', note: 'Terms forbid republication.' });
  assert.throws(() => db.exec("UPDATE license_reviews SET decision='cleared'"), /append-only/); assert.throws(() => db.exec('DELETE FROM license_reviews'), /append-only/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM license_reviews').get() as any).n, 4, 'history is preserved; the latest row is the current decision');
});
test('no table of the discovery/licensing layers can mark anything approved, published or cleared on its own', () => {
  const db = freshV05(); const cols = NEW_TABLES.flatMap((t) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => `${t}.${c.name}`));
  assert.ok(!cols.some((c) => /approved|published|cleared_at|auto/i.test(c)), cols.join(','));
});
