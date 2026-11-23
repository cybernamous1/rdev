// Test helpers: SQLite (node:sqlite) loaded with the REAL database/init.sql, plus a driver that performs the same
// publish / update / rollback transactions the future Worker will perform. SQLite is not D1; see README "Validation".
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeChecksum, type Entry, type RlfPackage } from '../../shared/rlf.ts';
import { generateBootstrap } from '../../scripts/gen-bootstrap.ts';
import type { Db, Stmt } from '../../worker/public-api.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = join(ROOT, 'tests', 'fixtures', 'content');
const NOW = '2026-11-22T10:00:00.000Z';

export function newDatabase(): DatabaseSync { const db = new DatabaseSync(':memory:'); db.exec(readFileSync(join(ROOT, 'database', 'init.sql'), 'utf8')); return db; }

/** Adapter exposing the D1-like surface used by worker/public-api.ts. */
export function asDb(raw: DatabaseSync, opts: { failWith?: Error } = {}): Db {
  const mk = (sql: string, args: unknown[] = []): Stmt => ({
    bind: (...v: unknown[]) => mk(sql, v),
    all: async <T,>() => { if (opts.failWith) throw opts.failWith; return { results: raw.prepare(sql).all(...(args as never[])) as T[] }; },
    first: async <T,>() => { if (opts.failWith) throw opts.failWith; return (raw.prepare(sql).get(...(args as never[])) as T | undefined) ?? null; }
  });
  return { prepare: (sql: string) => mk(sql) };
}

export async function loadBootstrap(raw: DatabaseSync, content = FIXTURES): Promise<number> {
  const out = mkdtempSync(join(tmpdir(), 'rdev-boot-'));
  const res = await generateBootstrap({ content, out });
  if (!res.ok) throw new Error(res.errors.join('; '));
  for (const f of readdirSync(out).sort()) raw.exec(readFileSync(join(out, f), 'utf8'));
  return res.count;
}

const rows = <T,>(raw: DatabaseSync, sql: string, ...a: unknown[]) => raw.prepare(sql).all(...(a as never[])) as T[];
const one = <T,>(raw: DatabaseSync, sql: string, ...a: unknown[]) => raw.prepare(sql).get(...(a as never[])) as T | undefined;

function entryContent(payload: Entry, n: number): string { return JSON.stringify({ ...payload, status: 'published', version: `${n}.0.0` }); }

async function writePackage(raw: DatabaseSync, pkg: string, version: string, members: { id: string; ver: number }[]) {
  const meta = one<{ title: string; description: string }>(raw, 'SELECT title, description FROM packages WHERE id = ?', pkg)!;
  const entries = members.map((m) => JSON.parse(one<{ content_json: string }>(raw, 'SELECT content_json FROM entry_versions WHERE entry_id = ? AND version = ?', m.id, m.ver)!.content_json));
  const srcIds = new Set<string>(entries.flatMap((e: Entry) => e.sourceIds));
  const sources = rows<{ id: string; label: string; url: string; publisher: string; license: string | null }>(raw, 'SELECT id,label,url,publisher,license FROM sources').filter((s) => srcIds.has(s.id)).map((s) => ({ ...s, status: 'unchecked', retrievedAt: null, contentHash: null }));
  const body: Omit<RlfPackage, 'checksum'> = { format: 'rlf', formatVersion: 1, id: pkg, title: meta.title, description: meta.description, version, license: 'test-fixture', entries, sources, relationships: [] } as never;
  return { body: { ...body, checksum: await computeChecksum(body as RlfPackage) } as RlfPackage };
}

/** Approve every pending proposal of one path and publish them as a new package version, in one atomic transaction. */
export async function approveAndPublishPath(raw: DatabaseSync, pathName: string, version = '1.0.0') {
  const pkg = one<{ id: string }>(raw, 'SELECT id FROM packages WHERE title = ?', pathName)!.id;
  const props = rows<{ id: number; target_entry_id: string; payload_json: string }>(raw, "SELECT id,target_entry_id,payload_json FROM proposals WHERE status='pending' AND json_extract(payload_json,'$.path') = ? ORDER BY id", pathName);
  raw.exec('BEGIN');
  try {
    for (const p of props) raw.prepare("UPDATE proposals SET status='approved', reviewed_at=?, review_note='fixture approval' WHERE id=?").run(NOW, p.id);
    for (const p of props) {
      const e = JSON.parse(p.payload_json) as Entry;
      raw.prepare('INSERT INTO entries(id,kind) VALUES (?,?)').run(e.id, e.kind);
      raw.prepare('INSERT INTO entry_versions(entry_id,version,path,category,title,summary,level,minutes,tags,content_json,search_text,status,origin,review_json,content_hash,proposal_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(e.id, 1, e.path, e.category, e.title, e.summary, e.level, e.minutes, e.tags.join(','), entryContent(e, 1), e.title.toLowerCase(), 'published', e.origin, null, 'h', p.id);
      for (const s of e.sourceIds) raw.prepare('INSERT INTO entry_version_sources VALUES (?,?,?)').run(e.id, 1, s);
    }
    const { body } = await writePackage(raw, pkg, version, props.map((p) => ({ id: p.target_entry_id, ver: 1 })));
    const prev = one<{ current_version: string | null }>(raw, 'SELECT current_version FROM packages WHERE id = ?', pkg)!.current_version;
    raw.prepare('INSERT INTO package_versions(package_id,version,checksum,entry_count,body) VALUES (?,?,?,?,?)').run(pkg, version, body.checksum, props.length, JSON.stringify(body));
    for (const p of props) raw.prepare('INSERT INTO package_version_entries VALUES (?,?,?,?)').run(pkg, version, p.target_entry_id, 1);
    const pub = raw.prepare("INSERT INTO publications(package_id,version,previous_version,action,note) VALUES (?,?,?,'publish','fixture')").run(pkg, version, prev).lastInsertRowid;
    for (const p of props) raw.prepare('INSERT INTO publication_proposals VALUES (?,?)').run(pub, p.id);
    for (const p of props) raw.prepare("UPDATE proposals SET status='published' WHERE id=?").run(p.id);
    raw.prepare('UPDATE packages SET current_version = ? WHERE id = ?').run(version, pkg);
    raw.exec('COMMIT');
  } catch (e) { raw.exec('ROLLBACK'); throw e; }
  return { pkg, ids: props.map((p) => p.target_entry_id), version };
}

/** Publish an owner 'update' proposal for one entry as the next package version. */
export async function publishUpdate(raw: DatabaseSync, pkg: string, entryId: string, newTitle: string, version: string) {
  const cur = one<{ version: number; content_json: string }>(raw, 'SELECT version, content_json FROM entry_versions WHERE entry_id=? ORDER BY version DESC LIMIT 1', entryId)!;
  const payload = { ...(JSON.parse(cur.content_json) as Entry), title: newTitle };
  raw.exec('BEGIN');
  try {
    const pid = raw.prepare("INSERT INTO proposals(kind,target_entry_id,base_version,title,payload_json,payload_hash,origin) VALUES ('update',?,?,?,?,?,'owner')").run(entryId, cur.version, 'Update ' + entryId, JSON.stringify(payload), 'h-' + version + entryId).lastInsertRowid;
    raw.prepare("UPDATE proposals SET status='approved', reviewed_at=?, review_note='ok' WHERE id=?").run(NOW, pid);
    const n = cur.version + 1;
    raw.prepare('INSERT INTO entry_versions(entry_id,version,path,category,title,summary,level,minutes,tags,content_json,search_text,status,origin,review_json,content_hash,proposal_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(entryId, n, payload.path, payload.category, newTitle, payload.summary, payload.level, payload.minutes, payload.tags.join(','), entryContent(payload, n), newTitle.toLowerCase(), 'published', payload.origin, null, 'h', pid);
    const prev = one<{ current_version: string }>(raw, 'SELECT current_version FROM packages WHERE id=?', pkg)!.current_version;
    const members = rows<{ entry_id: string; entry_version: number }>(raw, 'SELECT entry_id, entry_version FROM package_version_entries WHERE package_id=? AND package_version=?', pkg, prev).map((m) => ({ id: m.entry_id, ver: m.entry_id === entryId ? n : m.entry_version }));
    const { body } = await writePackage(raw, pkg, version, members);
    raw.prepare('INSERT INTO package_versions(package_id,version,checksum,entry_count,body) VALUES (?,?,?,?,?)').run(pkg, version, body.checksum, members.length, JSON.stringify(body));
    for (const m of members) raw.prepare('INSERT INTO package_version_entries VALUES (?,?,?,?)').run(pkg, version, m.id, m.ver);
    const pub = raw.prepare("INSERT INTO publications(package_id,version,previous_version,action) VALUES (?,?,?,'publish')").run(pkg, version, prev).lastInsertRowid;
    raw.prepare('INSERT INTO publication_proposals VALUES (?,?)').run(pub, pid);
    raw.prepare("UPDATE proposals SET status='published' WHERE id=?").run(pid);
    raw.prepare('UPDATE packages SET current_version=? WHERE id=?').run(version, pkg);
    raw.exec('COMMIT');
  } catch (e) { raw.exec('ROLLBACK'); throw e; }
}

export function rollbackTo(raw: DatabaseSync, pkg: string, version: string) {
  const prev = one<{ current_version: string }>(raw, 'SELECT current_version FROM packages WHERE id=?', pkg)!.current_version;
  raw.exec('BEGIN');
  try {
    raw.prepare("INSERT INTO publications(package_id,version,previous_version,action,note) VALUES (?,?,?,'rollback','test rollback')").run(pkg, version, prev);
    raw.prepare('UPDATE packages SET current_version=? WHERE id=?').run(version, pkg);
    raw.exec('COMMIT');
  } catch (e) { raw.exec('ROLLBACK'); throw e; }
}
