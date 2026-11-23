// RDev knowledge engine CLI (v0.3.0).  node --experimental-strip-types --no-warnings scripts/kb.ts <command>
//   validate [--content <dir>]   run extract → classify → relate → duplicate/conflict analysis → validate (no output files)
//   bootstrap [...]              generate PENDING bootstrap proposal SQL (see scripts/gen-bootstrap.ts)
//   snapshot <dir> | --empty     write the bundled offline baseline from packages exported from the PUBLIC API (approved only)
//   check-bundle [dist]          fail if the built site or the snapshot could expose unapproved content
//   sources [--fetch]            list the source ledger; --fetch needs network (not used in tests)
//   ingest <url|file>            create a DRAFT from a URL or Markdown file (never enters a package automatically)
//   inspect <file>               validate any .rlf.json file
// Nothing here publishes content or touches a database.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './lib/pipeline.ts';
import { generateBootstrap } from './gen-bootstrap.ts';
import { writeSnapshot, checkBundle } from './lib/bundle.ts';
import { extractMarkdown, extractHtml } from '../knowledge/extract.ts';
import { acquireUrl, sha256Hex } from '../knowledge/acquire.ts';
import { summarize } from '../knowledge/duplicates.ts';
import { validatePackage, type Source } from '../shared/rlf.ts';

const ROOT = resolve(process.env.RDEV_PROJECT ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2); const [cmd, arg] = args;
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const content = resolve(opt('--content') ?? join(ROOT, 'content'));

if (cmd === 'validate') {
  if (!existsSync(content)) { console.log(`No content directory at ${content}. Nothing to validate.`); process.exit(0); }
  const r = await runPipeline(content);
  for (const w of r.warnings) console.warn('warning:', w);
  for (const f of r.findings) console.warn(`finding[${f.severity}] ${f.type}: ${f.entryId} ~ ${f.others.join(',')} — ${f.detail}`);
  for (const e of r.errors) console.error('ERROR:  ', e);
  const s = summarize(r.findings);
  console.log(`${r.entries.length} entries, ${r.packages.length} packages, ${r.relationships} relationships, ${r.indexTerms} index terms. Findings: ${s.block} blocking, ${s.warn} warnings, ${s.info} info.`);
  process.exit(r.errors.length ? 1 : 0);
} else if (cmd === 'bootstrap') {
  const out = resolve(opt('--out') ?? join(ROOT, 'database', 'bootstrap'));
  const res = await generateBootstrap({ content, out });
  if (!res.ok) { for (const e of res.errors) console.error('ERROR:', e); process.exit(1); }
  console.log(`Wrote ${res.count} pending proposals to ${out}.`);
} else if (cmd === 'snapshot') {
  const outFile = join(ROOT, 'src', 'generated', 'packages.json');
  const res = arg === '--empty' ? await writeSnapshot(null, outFile) : arg ? await writeSnapshot(resolve(arg), outFile) : { ok: false, errors: ['Usage: snapshot <dir-of-exported-packages> | --empty'], count: 0 };
  if (!res.ok) { for (const e of res.errors) console.error('ERROR:', e); process.exit(1); }
  console.log(`Snapshot written: ${res.count} approved package(s) → src/generated/packages.json`);
} else if (cmd === 'check-bundle') {
  const res = checkBundle({ distDir: resolve(arg ?? join(ROOT, 'dist')), snapshotFile: join(ROOT, 'src', 'generated', 'packages.json'), contentDir: content });
  for (const e of res.errors) console.error('ERROR:', e);
  console.log(res.ok ? `Bundle check passed (${res.scanned} files scanned, ${res.bannedChecked} unpublished identifiers checked).` : 'Bundle check FAILED: unapproved content could be public.');
  process.exit(res.ok ? 0 : 1);
} else if (cmd === 'sources') {
  const file = join(content, 'sources.json'); let sources: Source[] = JSON.parse(readFileSync(file, 'utf8'));
  if (arg === '--fetch') {
    const next: Source[] = [];
    for (const s of sources) { const r = await acquireUrl(s); console.log(`${r.source.status.padEnd(9)} ${s.id} — ${r.note}`); next.push(r.source); await new Promise((ok) => setTimeout(ok, 1200)); }
    sources = next; writeFileSync(file, JSON.stringify(sources, null, 2) + '\n'); console.log('Ledger updated.');
  } else for (const s of sources) console.log(`${s.status.padEnd(9)} ${s.id.padEnd(28)} ${s.url}`);
} else if (cmd === 'ingest' && arg) {
  mkdirSync(join(content, 'drafts'), { recursive: true });
  let title = '', blocks, sourceLine = '';
  if (/^https?:/.test(arg)) {
    const res = await acquireUrl({ id: 'adhoc', label: arg, url: arg, publisher: new URL(arg).hostname, license: null, status: 'unchecked', retrievedAt: null, contentHash: null });
    if (!res.html) { console.error(res.note); process.exit(1); }
    ({ title, blocks } = extractHtml(res.html)); sourceLine = `Source: ${arg} (retrieved ${res.source.retrievedAt}, sha256 ${res.source.contentHash})`;
  } else { const raw = readFileSync(arg, 'utf8'); const e = extractMarkdown(raw, arg); title = e.title; blocks = e.blocks; sourceLine = `Source file: ${arg} (sha256 ${await sha256Hex(raw)})`; }
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';
  writeFileSync(join(content, 'drafts', `${slug}.json`), JSON.stringify({ status: 'draft', origin: 'imported', note: 'Automated extraction. Needs a human rewrite, a license check and owner review before it can become a proposal.', sourceLine, title, blocks }, null, 2));
  console.log(`Draft written to content/drafts/${slug}.json (${blocks.length} blocks). It is not part of any package or proposal.`);
} else if (cmd === 'inspect' && arg) {
  const r = await validatePackage(JSON.parse(readFileSync(arg, 'utf8')));
  for (const w of r.warnings) console.warn('warning:', w); for (const e of r.errors) console.error('ERROR:', e);
  console.log(r.ok ? 'Package is valid.' : 'Package is INVALID.'); process.exit(r.ok ? 0 : 1);
} else { console.log('Usage: kb.ts validate | bootstrap | snapshot <dir>|--empty | check-bundle [dist] | sources [--fetch] | ingest <url|file> | inspect <file>'); process.exit(cmd ? 1 : 0); }
