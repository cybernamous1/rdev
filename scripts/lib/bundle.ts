// Snapshot (approved packages → bundled offline baseline) and the "no unapproved content" bundle guard.
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { validatePackage, type RlfPackage } from '../../shared/rlf.ts';
import { loadContent } from './pipeline.ts';

const APPROVED = new Set(['published', 'verified']);

/** Validate packages exported from the PUBLIC API and write them as the bundled snapshot. Refuses anything not approved. */
export async function writeSnapshot(fromDir: string | null, outFile: string): Promise<{ ok: boolean; errors: string[]; count: number }> {
  const errors: string[] = []; const pkgs: RlfPackage[] = [];
  if (fromDir) {
    for (const f of readdirSync(fromDir).filter((x) => x.endsWith('.json')).sort()) {
      let pkg: RlfPackage; try { pkg = JSON.parse(readFileSync(join(fromDir, f), 'utf8')); } catch { errors.push(`${f}: not valid JSON`); continue; }
      const r = await validatePackage(pkg);
      if (!r.ok) { errors.push(...r.errors.map((m) => `${f}: ${m}`)); continue; }
      for (const e of pkg.entries) if (!APPROVED.has(e.status)) errors.push(`${f}: entry "${e.id}" has status "${e.status}"; only published or verified entries may be bundled.`);
      if (pkgs.some((p) => p.id === pkg.id)) errors.push(`${f}: duplicate package id "${pkg.id}".`);
      pkgs.push(pkg);
    }
  }
  if (errors.length) return { ok: false, errors, count: 0 };
  pkgs.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(outFile, JSON.stringify(pkgs));
  return { ok: true, errors, count: pkgs.length };
}

function walk(dir: string): string[] { return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; }); }

/** Fails if a built site or the bundled snapshot could expose unapproved content. */
export function checkBundle(opts: { distDir: string; snapshotFile: string; contentDir: string; bootstrapDir?: string }): { ok: boolean; errors: string[]; scanned: number; bannedChecked: number } {
  const errors: string[] = [];
  let snapshot: RlfPackage[] = [];
  try { snapshot = JSON.parse(readFileSync(opts.snapshotFile, 'utf8')); } catch { errors.push(`Cannot read snapshot ${opts.snapshotFile}`); }
  if (!Array.isArray(snapshot)) { errors.push('Snapshot must be an array of packages.'); snapshot = []; }
  const approvedIds = new Set<string>(); const approvedTitles = new Set<string>();
  for (const p of snapshot) for (const e of p.entries || []) { if (!APPROVED.has(e.status)) errors.push(`Snapshot entry "${e.id}" has status "${e.status}" (not approved).`); approvedIds.add(e.id); approvedTitles.add(e.title); }
  // Everything known to exist as unpublished content, minus what is legitimately in the approved snapshot.
  const banned = new Map<string, string>();
  if (existsSync(opts.contentDir)) for (const e of loadContent(opts.contentDir).entries) { if (!approvedIds.has(e.id)) banned.set(e.id, 'unpublished id'); if (!approvedTitles.has(e.title)) banned.set(e.title, 'unpublished title'); }
  let scanned = 0;
  if (!existsSync(opts.distDir)) errors.push(`Build output not found: ${opts.distDir}`);
  else for (const f of walk(opts.distDir)) {
    const rel = f.slice(opts.distDir.length + 1);
    if (/\.rlf\.json$/.test(rel) || /(^|\/)(seed|bootstrap)[^/]*\.sql$/.test(rel) || /(^|\/)knowledge\//.test(rel)) errors.push(`Forbidden file in build output: ${rel}`);
    if (!/\.(js|mjs|css|html|json|txt|webmanifest|svg|map)$/.test(extname(f) ? f : f + '.txt')) continue;
    const text = readFileSync(f, 'utf8'); scanned++;
    if (text.includes('"origin":"bootstrap"') || text.includes('"status":"ai-assisted"')) errors.push(`${rel}: contains proposal/bootstrap markers.`);
    for (const [needle, why] of banned) if (text.includes(needle)) errors.push(`${rel}: contains ${why} "${needle}".`);
  }
  return { ok: errors.length === 0, errors, scanned, bannedChecked: banned.size };
}
