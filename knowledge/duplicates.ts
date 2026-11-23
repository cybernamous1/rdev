// Duplicate, conflict and outdated-content detection. Pure functions: no network, no database, no AI.
// Findings are advisory input for the owner's review; they never publish or reject anything by themselves.
import type { Entry, Source } from '../shared/rlf.ts';
import { tokenize } from '../shared/search.ts';

export type Finding = {
  type: 'duplicate-id' | 'duplicate-title' | 'similar-title' | 'near-duplicate-content' | 'duplicate-code' | 'conflict-existing' | 'missing-prerequisite' | 'prerequisite-cycle' | 'outdated-source';
  severity: 'info' | 'warn' | 'block';
  entryId: string; others: string[]; detail: string;
};

const text = (e: Entry) => e.blocks.map((b) => (b.type === 'list' ? b.items.join(' ') : b.type === 'code' ? '' : b.text)).join(' ');
const jaccard = <T,>(a: Set<T>, b: Set<T>) => { let i = 0; for (const x of a) if (b.has(x)) i++; const u = a.size + b.size - i; return u ? i / u : 0; };
const shingles = (s: string, n = 4) => { const t = tokenize(s); const out = new Set<string>(); for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(' ')); return out; };
const normCode = (c: string) => c.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

/** `incoming` are candidate entries; `existing` are already-published entries they will be compared against. */
export function analyzeEntries(incoming: Entry[], existing: Entry[] = []): Finding[] {
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);
  const seen = new Map<string, Entry>();
  for (const e of incoming) {
    const prior = seen.get(e.id);
    if (prior) add({ type: 'duplicate-id', severity: 'block', entryId: e.id, others: [prior.id], detail: `Two incoming entries share the id "${e.id}".` });
    seen.set(e.id, e);
  }
  const pool = [...incoming, ...existing.filter((x) => !incoming.some((i) => i.id === x.id))];
  const tshingle = new Map(pool.map((e) => [e.id + (existing.includes(e) ? '@pub' : ''), shingles(text(e))]));
  const codes = new Map<string, string[]>();
  for (const e of incoming) {
    for (const b of e.blocks) if (b.type === 'code' && normCode(b.code).length > 40) { const k = normCode(b.code); codes.set(k, [...(codes.get(k) || []), e.id]); }
    const mine = tshingle.get(e.id)!;
    const title = e.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); const titleTokens = new Set(tokenize(e.title));
    for (const o of pool) {
      if (o.id === e.id) continue;
      const otherKey = o.id + (existing.includes(o) ? '@pub' : '');
      const otitle = o.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (title === otitle) add({ type: 'duplicate-title', severity: 'block', entryId: e.id, others: [o.id], detail: `Same title as "${o.id}" (different id): possible conflicting duplicate.` });
      else if (jaccard(titleTokens, new Set(tokenize(o.title))) >= 0.8) add({ type: 'similar-title', severity: 'warn', entryId: e.id, others: [o.id], detail: `Title is very similar to "${o.title}".` });
      if (incoming.indexOf(e) < incoming.indexOf(o) || existing.includes(o)) {
        const sim = jaccard(mine, tshingle.get(otherKey)!);
        if (mine.size >= 8 && sim >= 0.6) add({ type: 'near-duplicate-content', severity: sim >= 0.9 ? 'block' : 'warn', entryId: e.id, others: [o.id], detail: `Text overlaps ${Math.round(sim * 100)}% with "${o.id}".` });
      }
    }
    const pub = existing.find((x) => x.id === e.id);
    if (pub && pub.title !== e.title && pub.path !== e.path) add({ type: 'conflict-existing', severity: 'warn', entryId: e.id, others: [pub.id], detail: 'Reuses the id of a published entry but changes both title and path: confirm this is the same topic.' });
    for (const q of e.prerequisites) if (!pool.some((x) => x.id === q)) add({ type: 'missing-prerequisite', severity: 'warn', entryId: e.id, others: [q], detail: `Prerequisite "${q}" does not exist in the incoming or published set.` });
  }
  for (const [, ids] of codes) { const u = [...new Set(ids)]; if (u.length > 1) for (const id of u) add({ type: 'duplicate-code', severity: 'info', entryId: id, others: u.filter((x) => x !== id), detail: 'Identical code example also appears in another entry.' }); }
  // prerequisite cycles within the pool
  const pre = new Map(pool.map((e) => [e.id, e.prerequisites])); const state = new Map<string, number>(); const reported = new Set<string>();
  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === 2 || !pre.has(id)) return;
    if (state.get(id) === 1) { const cyc = [...trail.slice(trail.indexOf(id)), id]; const key = [...cyc].sort().join(); if (!reported.has(key)) { reported.add(key); for (const c of new Set(cyc)) if (incoming.some((e) => e.id === c)) add({ type: 'prerequisite-cycle', severity: 'block', entryId: c, others: cyc.filter((x) => x !== c), detail: `Prerequisite cycle: ${cyc.join(' → ')}.` }); } return; }
    state.set(id, 1); for (const q of pre.get(id)!) visit(q, [...trail, id]); state.set(id, 2);
  };
  for (const id of pre.keys()) visit(id, []);
  return out;
}

/** Entries that cite a source whose retrieved content hash changed since the previous recorded hash. */
export function detectOutdated(entries: Entry[], previous: Pick<Source, 'id' | 'contentHash'>[], current: Pick<Source, 'id' | 'contentHash'>[]): Finding[] {
  const before = new Map(previous.map((s) => [s.id, s.contentHash])); const changed = new Set<string>();
  for (const s of current) { const b = before.get(s.id); if (s.contentHash && b && b !== s.contentHash) changed.add(s.id); }
  const out: Finding[] = [];
  for (const e of entries) { const hit = e.sourceIds.filter((id) => changed.has(id)); if (hit.length) out.push({ type: 'outdated-source', severity: 'warn', entryId: e.id, others: hit, detail: `Source content changed since it was last recorded (${hit.join(', ')}); review whether this entry is outdated.` }); }
  return out;
}

export const summarize = (findings: Finding[]) => ({ block: findings.filter((f) => f.severity === 'block').length, warn: findings.filter((f) => f.severity === 'warn').length, info: findings.filter((f) => f.severity === 'info').length });
