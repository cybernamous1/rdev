// Extraction + classification + organization of one retrieved page into a DRAFT entry (pure; no network, no database).
// The result only ever becomes a PENDING proposal. It is imported, unreviewed material until the owner approves and verifies it.
import { PATHS } from '../shared/paths.ts';
import type { Block, Entry, Level } from '../shared/rlf.ts';
import { classifyText } from './classify.ts';
import { extractHtml, parseBlocks, parseFrontMatter } from './extract.ts';
import { sha256Hex } from './acquire.ts';
import type { Retrieved } from './retrieve.ts';

export const MAX_BLOCKS = 150; export const MAX_PAYLOAD_CHARS = 60_000;
export type Extracted = { title: string; description: string; blocks: Block[]; truncated: boolean; contentHash: string };

const blockWords = (b: Block) => (b.type === 'list' ? b.items.join(' ') : b.type === 'code' ? b.code : b.text);

export async function extractContent(r: Pick<Retrieved, 'finalUrl' | 'contentType' | 'text'>): Promise<Extracted | null> {
  const isMd = /\.md$/i.test(new URL(r.finalUrl).pathname) || /markdown|text\/plain/.test(r.contentType);
  let title = ''; let description = ''; let blocks: Block[];
  if (isMd) {
    const { meta, body } = parseFrontMatter(r.text);
    title = String(meta.title || /^#\s+(.+)$/m.exec(body)?.[1] || '').trim(); description = String(meta.description || '').trim();
    blocks = parseBlocks(body);
  } else { const h = extractHtml(r.text); title = h.title.replace(/\s+[|–—-]\s+[^|–—-]*$/, '').trim(); blocks = h.blocks; }
  blocks = blocks.filter((b) => blockWords(b).trim().length > 0);
  if (!title || blocks.length === 0) return null;
  let truncated = false; let size = 0; const kept: Block[] = [];
  for (const b of blocks) {
    const n = JSON.stringify(b).length;
    if (kept.length >= MAX_BLOCKS || size + n > MAX_PAYLOAD_CHARS) { truncated = true; break; }
    kept.push(b); size += n;
  }
  return { title: title.slice(0, 160), description, blocks: kept, truncated, contentHash: await sha256Hex(JSON.stringify({ title, blocks: kept })) };
}

/** Stable id from the source URL (not the title), so re-extraction of the same page targets the same entry. */
export async function entryIdFor(url: string): Promise<string> {
  const u = new URL(url); const tail = u.pathname.split('/').filter(Boolean).slice(-2).join('-');
  const base = (tail || u.hostname).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 38).replace(/-+$/g, '') || 'page';
  return `${base}-${(await sha256Hex(url)).slice(0, 6)}`;
}

export type Built = { entry: Entry; classification: ReturnType<typeof classifyText>; pathSource: 'rules' | 'owner' | 'none' };

export function buildEntry(x: Extracted, o: { id: string; sourceId: string; categoryLabel: string; now: string; pathOverride?: string | null; candidatePath?: string | null; kind?: 'reference' }): Built {
  const text = x.blocks.map(blockWords).join(' ');
  const classification = classifyText(text, x.title);
  let path = classification.path; let pathSource: Built['pathSource'] = path ? 'rules' : 'none';
  if (o.pathOverride && PATHS.some((p) => p.name === o.pathOverride)) { path = o.pathOverride; pathSource = 'owner'; }
  const code = x.blocks.filter((b) => b.type === 'code').map(blockWords).join('\n');
  const level: Level = /DataStore|UpdateAsync|OnServerEvent|RemoteFunction|--!strict|type\s+\w+\s*=/.test(code) ? 'Intermediate' : 'Beginner';
  const firstPara = x.blocks.find((b) => b.type === 'p') as { text: string } | undefined;
  const summary = (x.description || firstPara?.text || x.title).replace(/\s+/g, ' ').trim().slice(0, 240);
  const words = text.split(/\s+/).filter(Boolean).length;
  const entry: Entry = {
    id: o.id, kind: 'reference', title: x.title, path: path || '', category: o.categoryLabel, level,
    minutes: Math.min(60, Math.max(1, Math.ceil(words / 200))), summary,
    tags: classification.matched.slice(0, 6), objectives: [], prerequisites: [], order: 0, blocks: x.blocks, sourceIds: [o.sourceId],
    status: 'ai-assisted', origin: 'imported', review: null, version: '1.0.0', updatedAt: o.now
  };
  return { entry, classification, pathSource };
}
