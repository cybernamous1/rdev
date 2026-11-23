// Optional platform knowledge service (Cloudflare Worker + D1). Core learning never depends on it:
// it runs in the BACKGROUND after the app has started, and every failure is non-fatal.
import { validatePackage, type RlfPackage } from '../../shared/rlf.ts';
import { isValidVersion } from '../../shared/semver.ts';
import { deleteStoredPackage, putStoredPackage } from './localData.ts';
import type { PackageOrigin } from './library.ts';

export type PlatformStatus = {
  state: 'unchecked' | 'checking' | 'online' | 'unavailable';
  databaseConfigured: boolean; databaseReady: boolean; apiVersion: string | null;
  checkedAt: string | null; detail: string; updated: string[]; published: number | null;
};
export const initialPlatform = (): PlatformStatus => ({ state: 'unchecked', databaseConfigured: false, databaseReady: false, apiVersion: null, checkedAt: null, detail: 'Not checked yet.', updated: [], published: null });

// `revalidate` forces a conditional request (ETag → cheap 304) so a cached manifest can never hide a new publication or a rollback.
async function getJson<T>(url: string, ms = 6000, revalidate = false): Promise<T> {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' }, cache: revalidate ? 'no-cache' : 'default' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally { clearTimeout(timer); }
}

export async function checkPlatform(): Promise<PlatformStatus> {
  const now = new Date().toISOString();
  try {
    const h = await getJson<{ status: string; version: string; databaseConfigured: boolean; databaseReady: boolean }>('/api/v1/health', 5000, true);
    if (h.status !== 'ok') throw new Error('Unexpected health response');
    return { state: 'online', databaseConfigured: h.databaseConfigured, databaseReady: h.databaseReady, apiVersion: h.version, checkedAt: now, updated: [], published: null,
      detail: !h.databaseConfigured ? 'Service reachable. The knowledge database is not configured yet.' : !h.databaseReady ? 'Service reachable. The knowledge database has not been initialized.' : 'Service and knowledge database are available.' };
  } catch (err) {
    return { state: 'unavailable', databaseConfigured: false, databaseReady: false, apiVersion: null, checkedAt: now, updated: [], published: null, detail: `Service not reachable (${(err as Error).message}). Learning continues with the content already on this device.` };
  }
}

export type HaveMap = Map<string, { version: string; checksum: string; origin: PackageOrigin }>;
export type SyncResult = { updated: string[]; removed: string[]; problems: string[]; serverPackages: number };

/**
 * Make this device follow the server's CURRENT published packages.
 * The server is authoritative, so a package is replaced even when the server's version is LOWER (a rollback).
 * Every package is validated (schema + checksum) and compared with the manifest before it is stored.
 */
export async function syncPackages(have: HaveMap, report?: (i: number, n: number, id: string) => void): Promise<SyncResult> {
  const updated: string[] = [], removed: string[] = [], problems: string[] = [];
  const manifest = await getJson<{ packages: { id: string; version: string; checksum: string }[] }>('/api/v1/packages', 6000, true);
  const list = manifest.packages;
  const todo: typeof list = [];
  for (const m of list) {
    const cur = have.get(m.id);
    if (!isValidVersion(m.version)) { problems.push(`${m.id}: server reported an invalid version "${m.version}"`); continue; }
    if (cur && cur.checksum === m.checksum) {
      if (cur.origin === 'bundled' || cur.origin === 'platform') continue;
    }
    todo.push(m);
  }
  for (let i = 0; i < todo.length; i++) {
    const m = todo[i]; report?.(i, todo.length, m.id);
    try {
      const pkg = await getJson<RlfPackage>(`/api/v1/packages/${encodeURIComponent(m.id)}/${m.version}`, 12000);
      if (pkg.id !== m.id || pkg.version !== m.version) { problems.push(`${m.id}: package identity does not match the manifest; rejected.`); continue; }
      const v = await validatePackage(pkg);
      if (!v.ok) { problems.push(`${m.id}: rejected (${v.errors[0]})`); continue; }
      if (pkg.checksum !== m.checksum) { problems.push(`${m.id}: checksum differs from the manifest; rejected.`); continue; }
      const cur = have.get(m.id);
      if (cur?.origin === 'bundled' && cur.checksum === pkg.checksum) { await deleteStoredPackage(m.id); removed.push(m.id); continue; }
      await putStoredPackage({ id: pkg.id, origin: 'platform', savedAt: new Date().toISOString(), pkg });
      updated.push(`${pkg.id} ${pkg.version}`);
    } catch (err) { problems.push(`${m.id}: ${(err as Error).message}`); }
  }
  return { updated, removed, problems, serverPackages: list.length };
}
