// Small in-memory full-text index (weighted term frequency with IDF). No external dependencies.
import type { Entry } from './rlf.ts';

export type Hit = { entry: Entry; score: number; snippet: string };
type Doc = { entry: Entry; tf: Map<string, number>; text: string };
export type SearchIndex = { docs: Doc[]; df: Map<string, number>; terms: number };

const stem = (t: string) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);
/** Lowercased words; CamelCase names also yield their parts (RemoteEvents → remoteevent, remote, event). */
export const tokenize = (s: string): string[] => {
  const out: string[] = [];
  for (const w of s.match(/[A-Za-z0-9_]+/g) || []) {
    out.push(stem(w.toLowerCase()));
    const parts = w.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g);
    if (parts && parts.length > 1) for (const p of parts) out.push(stem(p.toLowerCase()));
  }
  return out;
};

const blockText = (e: Entry) => e.blocks.map((b) => (b.type === 'list' ? b.items.join(' ') : b.type === 'code' ? b.code : b.text)).join('\n');

export function buildIndex(entries: Entry[]): SearchIndex {
  const df = new Map<string, number>();
  const docs: Doc[] = entries.map((entry) => {
    const tf = new Map<string, number>();
    const add = (text: string, w: number) => { for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + w); };
    add(entry.title, 6); add(entry.tags.join(' '), 4); add(entry.category + ' ' + entry.path, 2); add(entry.summary, 3);
    add(entry.objectives.join(' '), 2);
    for (const b of entry.blocks) if (b.type === 'h') add(b.text, 3);
    add(blockText(entry), 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { entry, tf, text: blockText(entry) };
  });
  return { docs, df, terms: df.size };
}

export function search(index: SearchIndex, query: string, limit = 50): Hit[] {
  const qt = tokenize(query);
  if (!qt.length) return [];
  const N = index.docs.length || 1;
  const hits: Hit[] = [];
  for (const doc of index.docs) {
    let score = 0, matched = 0;
    qt.forEach((q, i) => {
      const last = i === qt.length - 1;
      let best = 0;
      for (const [term, tf] of doc.tf) {
        const exact = term === q; const prefix = last && q.length >= 2 && term.startsWith(q);
        if (!exact && !prefix) continue;
        const idf = Math.log(1 + N / (index.df.get(term) || 1));
        best = Math.max(best, (tf / (tf + 1.5)) * idf * (exact ? 1 : 0.6));
      }
      if (best > 0) { matched++; score += best; }
    });
    if (matched === 0) continue;
    if (matched === qt.length) score *= 1.5; // all words present
    if (doc.entry.title.toLowerCase().includes(query.toLowerCase().trim())) score *= 1.4;
    hits.push({ entry: doc.entry, score, snippet: snippet(doc, qt) });
  }
  return hits.sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title)).slice(0, limit);
}

function snippet(doc: Doc, qt: string[]): string {
  const sentences = (doc.entry.summary + ' ' + doc.text.replace(/\s+/g, ' ')).split(/(?<=[.!?])\s+/);
  let best = doc.entry.summary, bestN = -1;
  for (const s of sentences) {
    const toks = new Set(tokenize(s)); let n = 0;
    for (const q of qt) if (toks.has(q) || [...toks].some((t) => t.startsWith(q))) n++;
    if (n > bestN) { bestN = n; best = s; }
  }
  return best.length > 170 ? best.slice(0, 167).trimEnd() + '…' : best;
}
