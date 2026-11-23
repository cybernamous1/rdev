// Packaging stage: group entries into RLF packages and compute checksums.
// (v0.3.0: no seed SQL. Public content reaches D1 only through approved publication.)
import { PATHS } from '../shared/paths.ts';
import { RLF_FORMAT, RLF_FORMAT_VERSION, computeChecksum, type Entry, type Relationship, type RlfPackage, type Source } from '../shared/rlf.ts';

export const PACKAGE_LICENSE = 'All rights reserved by the project owner until a license is selected and published. Linked third-party sources keep their own terms.';

export async function buildPackages(entries: Entry[], sources: Source[], rels: Relationship[], versions: Record<string, string>): Promise<RlfPackage[]> {
  const out: RlfPackage[] = [];
  for (const p of PATHS) {
    const mine = entries.filter((e) => e.path === p.name).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    if (!mine.length) continue;
    const ids = new Set(mine.map((e) => e.id));
    const used = new Set(mine.flatMap((e) => e.sourceIds));
    const pkg: Omit<RlfPackage, 'checksum'> = {
      format: RLF_FORMAT, formatVersion: RLF_FORMAT_VERSION, id: `rdev-${p.slug}`, title: p.name, description: p.blurb,
      version: versions[`rdev-${p.slug}`] || '1.0.0', license: PACKAGE_LICENSE, entries: mine,
      sources: sources.filter((s) => used.has(s.id)), relationships: rels.filter((r) => ids.has(r.from))
    };
    out.push({ ...pkg, checksum: await computeChecksum(pkg) });
  }
  return out;
}
