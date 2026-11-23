// Extraction stage: turn raw material (Markdown with front matter, or HTML) into RLF blocks.
import type { Block, Entry, Level, Status, Origin } from '../shared/rlf.ts';

export type FrontMatter = Record<string, string | string[]>;

export function parseFrontMatter(raw: string): { meta: FrontMatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: FrontMatter = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) { (meta[listKey] as string[]).push(item[1].trim()); continue; }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val === '') { meta[key] = []; listKey = key; continue; }
    listKey = null;
    const arr = /^\[(.*)\]$/.exec(val.trim());
    meta[key] = arr ? arr[1].split(',').map((s) => s.trim()).filter(Boolean) : val.trim();
  }
  return { meta, body: m[2] };
}

export function parseBlocks(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0; let inExercise = false; let exercise: string[] = [];
  const flushExercise = () => { if (exercise.length) blocks.push({ type: 'exercise', text: exercise.join(' ') }); exercise = []; inExercise = false; };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flushExercise();
      const code: string[] = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++; blocks.push({ type: 'code', lang: fence[1] || 'text', code: code.join('\n') }); continue;
    }
    const h = /^(#{2,3})\s+(.*)$/.exec(line);
    if (h) {
      flushExercise();
      const text = h[2].trim();
      if (/^(exercise|try it yourself|practice exercise)$/i.test(text)) { inExercise = true; i++; continue; }
      blocks.push({ type: 'h', text, level: h[1].length === 2 ? 2 : 3 }); i++; continue;
    }
    if (/^>\s*/.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) parts.push(lines[i++].replace(/^>\s?/, ''));
      const text = parts.join(' ').trim();
      const t = /^(tip|warning|note):\s*(.*)$/i.exec(text);
      flushExercise();
      blocks.push({ type: 'callout', tone: (t ? t[1].toLowerCase() : 'note') as 'tip' | 'warning' | 'note', text: t ? t[2] : text }); continue;
    }
    const ul = /^\s*[-*]\s+/.test(line), ol = /^\s*\d+\.\s+/.test(line);
    if (ul || ol) {
      const items: string[] = [];
      const re = ul ? /^\s*[-*]\s+(.*)$/ : /^\s*\d+\.\s+(.*)$/;
      while (i < lines.length && re.test(lines[i])) items.push(re.exec(lines[i++])![1].trim());
      if (inExercise) { exercise.push(items.join(' ')); continue; }
      blocks.push({ type: 'list', ordered: ol, items }); continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{2,3}\s|>|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) para.push(lines[i++].trim());
    if (inExercise) exercise.push(para.join(' ')); else blocks.push({ type: 'p', text: para.join(' ') });
  }
  flushExercise();
  return blocks;
}

const arr = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);

/** Markdown lesson/reference file → RLF entry. Throws on missing required front matter. */
export function extractMarkdown(raw: string, file = 'input'): Entry {
  const { meta, body } = parseFrontMatter(raw);
  const need = (k: string) => { const v = meta[k]; if (!v || (Array.isArray(v) && !v.length)) throw new Error(`${file}: front matter is missing "${k}".`); return v; };
  const str = (k: string) => String(need(k));
  return {
    id: str('id'), kind: (meta.kind as 'lesson' | 'reference') || 'lesson', title: str('title'), path: str('path'),
    category: String(meta.category || meta.path), level: str('level') as Level, minutes: Number(str('minutes')),
    summary: str('summary'), tags: arr(meta.tags), objectives: arr(meta.objectives), prerequisites: arr(meta.prerequisites),
    order: Number(meta.order || 0), blocks: parseBlocks(body), sourceIds: arr(meta.sources),
    status: (meta.status as Status) || 'published', origin: (meta.origin as Origin) || 'ai-assisted', review: null,
    version: String(meta.version || '1.0.0'), updatedAt: str('updated')
  };
}

const decode = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const text = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Very small HTML extractor used for source acquisition. Produces draft blocks only; a human must review them. */
export function extractHtml(html: string): { title: string; blocks: Block[] } {
  const clean = html.replace(/<(script|style|nav|footer|header|svg)[\s\S]*?<\/\1>/gi, '');
  const title = text((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(clean) || [, ''])[1]);
  const blocks: Block[] = [];
  const re = /<(h[1-3]|p|pre|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  let pendingList: string[] = [];
  const flush = () => { if (pendingList.length) blocks.push({ type: 'list', ordered: false, items: pendingList }); pendingList = []; };
  while ((m = re.exec(clean))) {
    const tag = m[1].toLowerCase(); const t = text(m[2]);
    if (!t) continue;
    if (tag === 'li') { pendingList.push(t); continue; }
    flush();
    if (tag === 'pre') blocks.push({ type: 'code', lang: 'text', code: decode(m[2].replace(/<[^>]+>/g, '')).trim() });
    else if (tag === 'p') blocks.push({ type: 'p', text: t });
    else blocks.push({ type: 'h', text: t, level: tag === 'h3' ? 3 : 2 });
  }
  flush();
  return { title, blocks };
}
