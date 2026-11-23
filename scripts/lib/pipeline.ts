// Node-side pipeline: Markdown → entries → classification → relationships → duplicate/conflict analysis → validation.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractMarkdown } from '../../knowledge/extract.ts';
import { classificationWarnings } from '../../knowledge/classify.ts';
import { buildRelationships } from '../../knowledge/relate.ts';
import { buildPackages } from '../../knowledge/pack.ts';
import { analyzeEntries, type Finding } from '../../knowledge/duplicates.ts';
import { buildIndex, search } from '../../shared/search.ts';
import { validatePackage, type Entry, type RlfPackage, type Source } from '../../shared/rlf.ts';

export type PipelineResult = {
  entries: Entry[]; sources: Source[]; packages: RlfPackage[]; findings: Finding[];
  errors: string[]; warnings: string[]; relationships: number; indexTerms: number;
};

export function loadContent(contentDir: string): { entries: Entry[]; sources: Source[]; errors: string[] } {
  const errors: string[] = []; const entries: Entry[] = [];
  const srcFile = join(contentDir, 'sources.json');
  const sources: Source[] = existsSync(srcFile) ? JSON.parse(readFileSync(srcFile, 'utf8')) : [];
  for (const dir of ['lessons', 'reference']) {
    const d = join(contentDir, dir); if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.md')).sort()) {
      try { entries.push(extractMarkdown(readFileSync(join(d, f), 'utf8'), `${dir}/${f}`)); } catch (e) { errors.push((e as Error).message); }
    }
  }
  return { entries, sources, errors };
}

export async function runPipeline(contentDir: string, versions: Record<string, string> = {}): Promise<PipelineResult> {
  const { entries, sources, errors } = loadContent(contentDir); const warnings: string[] = [];
  for (const e of entries) if (e.kind === 'lesson') warnings.push(...classificationWarnings(e));
  const all = new Set(entries.map((e) => e.id));
  for (const e of entries) for (const q of e.prerequisites) if (!all.has(q)) errors.push(`Entry "${e.id}": prerequisite "${q}" does not exist.`);
  const rels = buildRelationships(entries);
  const packages = await buildPackages(entries, sources, rels, versions);
  for (const pkg of packages) {
    const r = await validatePackage(pkg);
    errors.push(...r.errors.map((m) => `[${pkg.id}] ${m}`));
    warnings.push(...r.warnings.filter((m) => !/prerequisite ".*" is not in this package/.test(m)).map((m) => `[${pkg.id}] ${m}`));
  }
  const index = buildIndex(entries);
  for (const e of entries) if (!search(index, e.title, 5).some((h) => h.entry.id === e.id)) errors.push(`Search index cannot find "${e.id}" by its title.`);
  return { entries, sources, packages, findings: analyzeEntries(entries), errors, warnings, relationships: rels.length, indexTerms: index.terms };
}
