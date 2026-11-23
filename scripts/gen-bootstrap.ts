// Bootstrap generator: existing Markdown content → PENDING, AI-assisted, unreviewed proposals (SQL files).
// It reads content and writes SQL files only. It never connects to a database and never publishes anything.
//   node --experimental-strip-types --no-warnings scripts/gen-bootstrap.ts [--project <dir>] [--content <dir>] [--out <dir>]
// Defaults: project = the repository root (parent of this script's folder, or $RDEV_PROJECT);
//           content = <project>/content;  out = <project>/database/bootstrap.
import { writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../shared/paths.ts';
import { runPipeline } from './lib/pipeline.ts';
import { bootstrapPayload, analysisFor, proposalInsertSql } from '../knowledge/proposals.ts';
import { summarize } from '../knowledge/duplicates.ts';

const q = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);

export async function generateBootstrap(opts: { content: string; out: string }) {
  const r = await runPipeline(opts.content);
  if (r.errors.length) return { ok: false as const, errors: r.errors, count: 0, summary: summarize(r.findings) };
  mkdirSync(opts.out, { recursive: true });
  for (const f of readdirSync(opts.out)) if (/^\d\d-.*\.sql$/.test(f)) rmSync(join(opts.out, f));
  const used = new Set(r.entries.flatMap((e) => e.sourceIds));
  let src = '-- Bootstrap part 1: source records (no snapshots: every source stays "not machine-checked"). Idempotent.\n';
  for (const s of r.sources.filter((s) => used.has(s.id))) src += `INSERT OR IGNORE INTO sources (id,label,url,publisher,license) VALUES (${q(s.id)},${q(s.label)},${q(s.url)},${q(s.publisher)},${q(s.license)});\n`;
  writeFileSync(join(opts.out, '00-sources.sql'), src);
  let count = 0;
  for (const [i, p] of PATHS.entries()) {
    const mine = r.entries.filter((e) => e.path === p.name); if (!mine.length) continue;
    let sql = `-- Bootstrap: ${p.name}. Creates PENDING proposals only (origin 'bootstrap'; AI-assisted, unreviewed).\n-- Creates no entries, versions or publications, so nothing here can become public. Idempotent: re-runs are ignored.\n`;
    for (const e of mine) {
      sql += await proposalInsertSql({
        kind: 'new', entryId: e.id, baseVersion: null, title: e.title, origin: 'bootstrap', payload: bootstrapPayload(e),
        rationale: 'Bootstrap import of existing content. AI-assisted and unreviewed; requires owner review before publication.',
        analysis: analysisFor(e.id, r.findings, { errors: [], warnings: r.warnings.filter((w) => w.includes(e.id)) }, r.entries.length)
      }) + '\n'; count++;
    }
    writeFileSync(join(opts.out, `${String(i + 1).padStart(2, '0')}-${p.slug}.sql`), sql);
  }
  return { ok: true as const, errors: [], count, summary: summarize(r.findings) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const project = resolve(opt('--project') ?? process.env.RDEV_PROJECT ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const content = resolve(opt('--content') ?? join(project, 'content')); const out = resolve(opt('--out') ?? join(project, 'database', 'bootstrap'));
  if (!existsSync(content)) { console.error(`Content directory not found: ${content}`); process.exit(2); }
  const res = await generateBootstrap({ content, out });
  if (!res.ok) { for (const e of res.errors) console.error('ERROR:', e); process.exit(1); }
  console.log(`Wrote ${res.count} pending proposals to ${out}. Findings: ${res.summary.block} blocking, ${res.summary.warn} warnings, ${res.summary.info} info.`);
}
