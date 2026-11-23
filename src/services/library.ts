// Combines RLF packages (bundled, platform-synced, locally imported) into one searchable library.
import type { Entry, Relationship, RlfPackage, Source } from '../../shared/rlf.ts';
import { buildIndex, type SearchIndex } from '../../shared/search.ts';

export type PackageOrigin = 'bundled' | 'platform' | 'local';
export type PackageInfo = { id: string; title: string; version: string; entries: number; origin: PackageOrigin; checksum: string; description: string; superseded: string[]; pkg: RlfPackage };
export type Library = {
  entries: Entry[]; byId: Map<string, Entry>; sources: Map<string, Source>; relationships: Relationship[];
  packages: PackageInfo[]; index: SearchIndex; notices: string[]; tags: Map<string, number>;
};

export function buildLibrary(inputs: { pkg: RlfPackage; origin: PackageOrigin }[]): Library {
  const notices: string[] = [];
  const chosen = new Map<string, { pkg: RlfPackage; origin: PackageOrigin; superseded: string[] }>();
  // Precedence per package id: platform (the server's current published version, even after a rollback) >
  // local import > bundled snapshot. Version numbers are NOT compared, because a rollback legitimately lowers them.
  const rank: Record<PackageOrigin, number> = { platform: 0, local: 1, bundled: 2 };
  for (const inp of inputs) {
    const cur = chosen.get(inp.pkg.id);
    if (!cur) { chosen.set(inp.pkg.id, { ...inp, superseded: [] }); continue; }
    if (rank[inp.origin] < rank[cur.origin]) chosen.set(inp.pkg.id, { ...inp, superseded: [...cur.superseded, `${cur.origin} ${cur.pkg.version}`] });
    else cur.superseded.push(`${inp.origin} ${inp.pkg.version}`);
  }
  const entries: Entry[] = []; const byId = new Map<string, Entry>(); const sources = new Map<string, Source>();
  const relationships: Relationship[] = []; const relSeen = new Set<string>();
  for (const { pkg } of chosen.values()) {
    for (const e of pkg.entries) {
      if (byId.has(e.id)) { notices.push(`Duplicate entry "${e.id}" in package ${pkg.id} was ignored.`); continue; }
      byId.set(e.id, e); entries.push(e);
    }
    for (const s of pkg.sources) if (!sources.has(s.id) || (s.status === 'retrieved' && sources.get(s.id)!.status !== 'retrieved')) sources.set(s.id, s);
    for (const r of pkg.relationships) { const k = `${r.from}>${r.to}:${r.type}`; if (!relSeen.has(k) && byId.has(r.from)) { relSeen.add(k); relationships.push(r); } }
  }
  const valid = relationships.filter((r) => byId.has(r.from) && byId.has(r.to));
  const tags = new Map<string, number>();
  for (const e of entries) for (const t of e.tags) tags.set(t, (tags.get(t) || 0) + 1);
  const packages: PackageInfo[] = [...chosen.values()].map(({ pkg, origin, superseded }) => ({ id: pkg.id, title: pkg.title, version: pkg.version, entries: pkg.entries.length, origin, checksum: pkg.checksum, description: pkg.description, superseded, pkg })).sort((a, b) => a.id.localeCompare(b.id));
  return { entries, byId, sources, relationships: valid, packages, index: buildIndex(entries), notices, tags };
}

export const relatedTo = (lib: Library, id: string, type: Relationship['type'], dir: 'out' | 'in' = 'out'): Entry[] =>
  lib.relationships.filter((r) => r.type === type && (dir === 'out' ? r.from === id : r.to === id)).map((r) => lib.byId.get(dir === 'out' ? r.to : r.from)!).filter(Boolean);
