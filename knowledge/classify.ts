// Classification stage: transparent keyword scoring. This is a rule-based classifier, not an AI model.
import { PATHS } from '../shared/paths.ts';
import type { Entry, Level } from '../shared/rlf.ts';

export type Classification = { path: string; confidence: number; ranked: { path: string; score: number }[]; suggestedLevel: Level };

const fullText = (e: Entry) =>
  [e.title, e.summary, e.tags.join(' '), ...e.blocks.map((b) => (b.type === 'list' ? b.items.join(' ') : b.type === 'code' ? b.code : b.text))].join(' ').toLowerCase();

export function classify(e: Entry): Classification {
  const text = fullText(e); const title = (e.title + ' ' + e.tags.join(' ')).toLowerCase();
  const ranked = PATHS.map((p) => {
    let score = 0;
    for (const k of p.keywords) {
      const hits = text.split(k).length - 1;
      score += Math.min(hits, 5) + (title.includes(k) ? 4 : 0);
    }
    return { path: p.name, score };
  }).sort((a, b) => b.score - a.score);
  const total = ranked.reduce((n, r) => n + r.score, 0) || 1;
  const code = e.blocks.filter((b) => b.type === 'code').map((b) => (b.type === 'code' ? b.code : '')).join('\n');
  const advanced = /DataStore|UpdateAsync|OnServerEvent|RemoteFunction|--!strict|type\s+\w+\s*=/.test(code);
  const suggestedLevel: Level = advanced ? 'Intermediate' : 'Beginner';
  return { path: ranked[0].path, confidence: ranked[0].score / total, ranked, suggestedLevel };
}

/** Editorial warning when an entry's declared path looks inconsistent with its content. */
export function classificationWarnings(e: Entry): string[] {
  const c = classify(e);
  const own = c.ranked.find((r) => r.path === e.path)?.score || 0;
  const top = c.ranked[0];
  const out: string[] = [];
  if (top.path !== e.path && own < top.score * 0.5) out.push(`Entry "${e.id}": content looks closer to "${top.path}" than its declared path "${e.path}".`);
  if (e.level === 'Beginner' && c.suggestedLevel === 'Intermediate') out.push(`Entry "${e.id}": code uses server/data APIs usually taught at Intermediate level.`);
  return out;
}

/** Keyword classification of free text (used for discovery candidates and extracted pages). Transparent rules, no AI. */
export function classifyText(text: string, title = ''): { path: string | null; confidence: number; ranked: { path: string; score: number }[]; matched: string[] } {
  const body = text.toLowerCase(); const head = title.toLowerCase(); const matched = new Set<string>();
  const ranked = PATHS.map((p) => {
    let score = 0;
    for (const k of p.keywords) {
      const hits = body.split(k).length - 1; const inTitle = head.includes(k);
      if (hits || inTitle) matched.add(k);
      score += Math.min(hits, 5) + (inTitle ? 4 : 0);
    }
    return { path: p.name, score };
  }).sort((a, b) => b.score - a.score);
  const total = ranked.reduce((n, r) => n + r.score, 0);
  return { path: ranked[0].score > 0 ? ranked[0].path : null, confidence: total ? ranked[0].score / total : 0, ranked, matched: [...matched] };
}
