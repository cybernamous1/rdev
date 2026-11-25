// Test helpers for the v0.5.0 suites: a D1-shaped adapter over node:sqlite (real SQL, real triggers, real foreign keys),
// an in-memory HostPolicyStore and a fake web. No test touches the internet or a real D1.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostPolicy, HostPolicyStore } from '../../knowledge/engine/net/fetcher.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sql = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

export function d1(raw: DatabaseSync) {
  const make = (q: string, args: unknown[] = []): any => ({
    sql: q, args, bind: (...v: unknown[]) => make(q, v),
    run: async () => { const r = raw.prepare(q).run(...(args as never[])); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    first: async () => (raw.prepare(q).get(...(args as never[])) as any) ?? null,
    all: async () => ({ results: raw.prepare(q).all(...(args as never[])) as any[] })
  });
  return { prepare: (q: string) => make(q), batch: async (items: any[]) => {
    raw.exec('BEGIN'); try { const out = items.map((x) => { const r = raw.prepare(x.sql).run(...(x.args as never[])); return { meta: { changes: Number(r.changes) } }; }); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
  } };
}
export function freshV05(): DatabaseSync { const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); db.exec(sql('database/init.sql')); return db; }
export function v040(): DatabaseSync { const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); db.exec(sql('database/tests/legacy/v0.3.0-schema.sql')); db.exec(sql('database/upgrade-0.4.0.sql')); return db; }

export class MemoryHostPolicies implements HostPolicyStore {
  map = new Map<string, HostPolicy>();
  async get(h: string) { return this.map.get(h) ?? null; }
  async put(p: HostPolicy) { this.map.set(p.host, { ...p }); }
}

export type Page = { body?: string | Uint8Array; type?: string; status?: number; headers?: Record<string, string>; location?: string };
export function fakeWeb(pages: Record<string, Page>) {
  const requested: string[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const u = String(input); requested.push(u); const p = pages[u];
    if (!p) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const headers: Record<string, string> = { 'content-type': p.type ?? 'text/html; charset=utf-8', ...(p.headers ?? {}), ...(p.location ? { location: p.location } : {}) };
    const inm = init?.headers?.['if-none-match']; if (inm && p.headers?.etag === inm) return new Response(null, { status: 304 });
    return new Response((p.body ?? '') as BodyInit, { status: p.status ?? 200, headers });
  }) as typeof fetch;
  return { fetchImpl, requested, pages };
}
export const classify = (text: string, title: string) => { const hit = /luau|roblox|lua\b|scripting/i.test(text + ' ' + title); return { path: hit ? 'Luau Programming' : null, score: hit ? 8 : 0 }; };
export const clock = (start = 1_800_000_000_000, step = 5_000) => { let t = start; return { now: () => (t += step), set: (v: number) => { t = v; }, get: () => t }; };
