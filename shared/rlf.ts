// RLF — RDev Learning Format. A versioned JSON package of learning entries, sources and relationships.
import { PATHS } from './paths.ts';
import { checkBlocks } from './luau.ts';
import { isValidVersion } from './semver.ts';

export const RLF_FORMAT = 'rlf';
export const RLF_FORMAT_VERSION = 1;
export const STATUSES = ['draft', 'ai-assisted', 'under-review', 'verified', 'published', 'outdated', 'archived'] as const;
export type Status = (typeof STATUSES)[number];
export type Origin = 'original' | 'ai-assisted' | 'imported';
export type Level = 'Beginner' | 'Intermediate' | 'Advanced';
export type Kind = 'lesson' | 'reference';

export type Block =
  | { type: 'h'; text: string; level: 2 | 3 }
  | { type: 'p'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'callout'; tone: 'tip' | 'warning' | 'note'; text: string }
  | { type: 'exercise'; text: string };

export type Source = {
  id: string; label: string; url: string; publisher: string;
  license: string | null; // null = not determined
  status: 'unchecked' | 'retrieved' | 'failed';
  retrievedAt: string | null; contentHash: string | null;
};
export type Review = { reviewer: string; reviewedAt: string; notes?: string };
export type Entry = {
  id: string; kind: Kind; title: string; path: string; category: string; level: Level; minutes: number;
  summary: string; tags: string[]; objectives: string[]; prerequisites: string[]; order: number;
  blocks: Block[]; sourceIds: string[]; status: Status; origin: Origin; review: Review | null;
  version: string; updatedAt: string;
};
export type Relationship = { from: string; to: string; type: 'prerequisite' | 'related' | 'next'; weight: number; reason: string };
export type RlfPackage = {
  format: typeof RLF_FORMAT; formatVersion: number; id: string; title: string; description: string;
  version: string; license: string; entries: Entry[]; sources: Source[]; relationships: Relationship[]; checksum: string;
};
export type ValidationReport = { ok: boolean; errors: string[]; warnings: string[] };

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

export { compareVersions } from './semver.ts';

function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export async function computeChecksum(pkg: Omit<RlfPackage, 'checksum'> | RlfPackage): Promise<string> {
  const { checksum: _ignored, ...rest } = pkg as RlfPackage;
  const data = new TextEncoder().encode(canonical(rest));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function validateBlock(b: any, where: string, errors: string[], warnings: string[]) {
  if (!b || typeof b !== 'object') return errors.push(`${where}: block is not an object.`);
  switch (b.type) {
    case 'h': if (!isStr(b.text) || ![2, 3].includes(b.level)) errors.push(`${where}: heading needs text and level 2 or 3.`); break;
    case 'p': case 'exercise': if (!isStr(b.text)) errors.push(`${where}: ${b.type} block needs text.`); break;
    case 'callout': if (!isStr(b.text) || !['tip', 'warning', 'note'].includes(b.tone)) errors.push(`${where}: callout needs text and a valid tone.`); break;
    case 'list': if (!Array.isArray(b.items) || b.items.length === 0 || !b.items.every(isStr) || typeof b.ordered !== 'boolean') errors.push(`${where}: list needs ordered flag and non-empty string items.`); break;
    case 'code':
      if (!isStr(b.code) || !isStr(b.lang)) { errors.push(`${where}: code block needs lang and code.`); break; }
      if (b.lang === 'luau') for (const f of checkBlocks(b.code)) warnings.push(`${where}: code block line ${f.line}: ${f.message}`);
      break;
    default: errors.push(`${where}: unknown block type "${b.type}".`);
  }
}

/** Structural and editorial validation. `verified` can never be claimed without a recorded review. */
export async function validatePackage(input: unknown, opts: { checkChecksum?: boolean } = {}): Promise<ValidationReport> {
  const errors: string[] = [], warnings: string[] = [];
  const p = input as RlfPackage;
  if (!p || typeof p !== 'object') return { ok: false, errors: ['Package is not an object.'], warnings };
  if (p.format !== RLF_FORMAT) errors.push(`format must be "${RLF_FORMAT}".`);
  if (p.formatVersion !== RLF_FORMAT_VERSION) errors.push(`Unsupported formatVersion ${String(p.formatVersion)} (this app reads ${RLF_FORMAT_VERSION}).`);
  if (!isStr(p.id) || !SLUG.test(p.id)) errors.push('Package id must be a lowercase slug.');
  if (!isStr(p.title)) errors.push('Package title is required.');
  if (!isValidVersion(p.version)) errors.push('Package version must be strict MAJOR.MINOR.PATCH (for example 1.0.0, no leading zeros).');
  if (!isStr(p.license)) errors.push('Package license is required.');
  if (!Array.isArray(p.entries) || !Array.isArray(p.sources) || !Array.isArray(p.relationships)) {
    errors.push('entries, sources and relationships must be arrays.');
    return { ok: false, errors, warnings };
  }
  const sourceIds = new Set<string>();
  for (const s of p.sources) {
    if (!isStr(s?.id) || !SLUG.test(s.id)) { errors.push('Source id must be a lowercase slug.'); continue; }
    if (sourceIds.has(s.id)) errors.push(`Duplicate source id "${s.id}".`);
    sourceIds.add(s.id);
    if (!isStr(s.label) || !isStr(s.url) || !/^https:\/\//.test(s.url)) errors.push(`Source "${s.id}" needs a label and an https URL.`);
    if (!['unchecked', 'retrieved', 'failed'].includes(s.status)) errors.push(`Source "${s.id}" has invalid status.`);
    if (s.status === 'retrieved' && (!s.retrievedAt || !s.contentHash)) errors.push(`Source "${s.id}" is marked retrieved without a date and content hash.`);
    if (s.status !== 'retrieved' && (s.retrievedAt || s.contentHash)) errors.push(`Source "${s.id}" has retrieval data but is not marked retrieved.`);
  }
  const ids = new Set<string>(); const paths = new Set(PATHS.map((x) => x.name));
  for (const e of p.entries) {
    const w = `Entry "${e?.id}"`;
    if (!isStr(e?.id) || !SLUG.test(e.id)) { errors.push('Entry id must be a lowercase slug.'); continue; }
    if (ids.has(e.id)) errors.push(`Duplicate entry id "${e.id}".`);
    ids.add(e.id);
    if (!['lesson', 'reference'].includes(e.kind)) errors.push(`${w}: invalid kind.`);
    if (!isStr(e.title) || !isStr(e.summary) || !isStr(e.category)) errors.push(`${w}: title, summary and category are required.`);
    if (!paths.has(e.path)) errors.push(`${w}: unknown learning path "${e.path}".`);
    if (!['Beginner', 'Intermediate', 'Advanced'].includes(e.level)) errors.push(`${w}: invalid level.`);
    if (!(e.minutes > 0)) errors.push(`${w}: minutes must be positive.`);
    if (!STATUSES.includes(e.status)) errors.push(`${w}: invalid status.`);
    if (!['original', 'ai-assisted', 'imported'].includes(e.origin)) errors.push(`${w}: invalid origin.`);
    if (!isValidVersion(e.version)) errors.push(`${w}: entry version must be strict MAJOR.MINOR.PATCH.`);
    if (!ISO_DATE.test(e.updatedAt || '')) errors.push(`${w}: updatedAt must be an ISO date.`);
    if (!Array.isArray(e.blocks) || e.blocks.length === 0) errors.push(`${w}: needs content blocks.`);
    else e.blocks.forEach((b, i) => validateBlock(b, `${w} block ${i + 1}`, errors, warnings));
    for (const sid of e.sourceIds || []) if (!sourceIds.has(sid)) errors.push(`${w}: references unknown source "${sid}".`);
    if (e.status === 'verified' && (!e.review || !isStr(e.review.reviewer) || !ISO_DATE.test(e.review.reviewedAt || ''))) errors.push(`${w}: "verified" requires a recorded review (reviewer and date).`);
    if (e.status !== 'verified' && e.review) warnings.push(`${w}: has a review record but is not marked verified.`);
    if (e.origin === 'imported') for (const sid of e.sourceIds) { const s = p.sources.find((x) => x.id === sid); if (s && !s.license) errors.push(`${w}: imported content requires a license on source "${sid}".`); }
    if (e.kind === 'lesson') {
      if (!e.objectives?.length) errors.push(`${w}: lessons need learning objectives.`);
      if (!e.blocks?.some((b) => b.type === 'exercise')) warnings.push(`${w}: lesson has no exercise.`);
      if (!e.sourceIds?.length) errors.push(`${w}: lessons must cite at least one source.`);
      if (e.blocks?.filter((b) => b.type === 'code').length === 0) warnings.push(`${w}: lesson has no code example.`);
    }
  }
  // Prerequisite references and cycles (prerequisites may point to entries in other packages, so unknown ids are warnings).
  const prereq = new Map<string, string[]>();
  for (const e of p.entries) { prereq.set(e.id, e.prerequisites || []); for (const q of e.prerequisites || []) if (!ids.has(q)) warnings.push(`Entry "${e.id}": prerequisite "${q}" is not in this package.`); }
  const state = new Map<string, number>();
  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === 2 || !prereq.has(id)) return;
    if (state.get(id) === 1) { errors.push(`Prerequisite cycle: ${[...trail, id].join(' → ')}.`); return; }
    state.set(id, 1); for (const q of prereq.get(id)!) visit(q, [...trail, id]); state.set(id, 2);
  };
  for (const id of prereq.keys()) visit(id, []);
  for (const r of p.relationships) if (!isStr(r?.from) || !isStr(r?.to) || !['prerequisite', 'related', 'next'].includes(r.type)) errors.push('Relationship has invalid fields.');
  if (opts.checkChecksum !== false) {
    if (!isStr(p.checksum)) errors.push('Package checksum is missing.');
    else if ((await computeChecksum(p)) !== p.checksum) errors.push('Checksum mismatch: package content was altered or corrupted.');
  }
  return { ok: errors.length === 0, errors, warnings };
}

export const STATUS_LABEL: Record<Status, string> = {
  draft: 'Draft', 'ai-assisted': 'AI-assisted', 'under-review': 'Under review', verified: 'Verified', published: 'Published', outdated: 'Outdated', archived: 'Archived'
};
