// Relationship stage: prerequisite edges (authored), "next" edges (path order) and "related" edges (shared tags).
import type { Entry, Relationship } from '../shared/rlf.ts';

export function buildRelationships(entries: Entry[]): Relationship[] {
  const out: Relationship[] = []; const seen = new Set<string>();
  const add = (r: Relationship) => { const k = `${r.from}>${r.to}:${r.type}`; if (!seen.has(k)) { seen.add(k); out.push(r); } };
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const e of entries) for (const p of e.prerequisites) if (byId.has(p)) add({ from: e.id, to: p, type: 'prerequisite', weight: 1, reason: 'Authored prerequisite' });
  const lessons = entries.filter((e) => e.kind === 'lesson');
  for (const path of new Set(lessons.map((e) => e.path))) {
    const seq = lessons.filter((e) => e.path === path).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    for (let i = 0; i < seq.length - 1; i++) add({ from: seq[i].id, to: seq[i + 1].id, type: 'next', weight: 1, reason: 'Next lesson in path' });
  }
  for (const a of entries) {
    const scored = entries.filter((b) => b.id !== a.id).map((b) => {
      const shared = a.tags.filter((t) => b.tags.includes(t));
      const union = new Set([...a.tags, ...b.tags]).size || 1;
      return { b, shared, j: shared.length / union };
    }).filter((x) => x.shared.length >= 2 || x.j >= 0.34).sort((x, y) => y.j - x.j || x.b.id.localeCompare(y.b.id)).slice(0, 4);
    for (const s of scored) add({ from: a.id, to: s.b.id, type: 'related', weight: Math.round(s.j * 100) / 100, reason: `Shared topics: ${s.shared.join(', ')}` });
  }
  return out;
}
