// Public read-only queries. Everything here reads ONLY what is published: packages.current_version and the
// entry versions that belong to it. Proposals, entry history, admin tables and security logs are never queried.
// `Db` is structural so Cloudflare's D1Database satisfies it and tests can supply a SQLite-backed adapter.
export type Stmt = { bind(...v: unknown[]): Stmt; all<T = Record<string, unknown>>(): Promise<{ results: T[] }>; first<T = Record<string, unknown>>(): Promise<T | null> };
export type Db = { prepare(sql: string): Stmt };

export const API_VERSION = '0.3.0';
export const SERVICE = 'RDev Academy API';

export type PublishedPackage = { id: string; title: string; version: string; checksum: string; entries: number; publishedAt: string };
export type PublishedSource = { id: string; label: string; url: string; publisher: string; license: string | null; status: string; retrievedAt: string | null };

export async function databaseReady(db: Db): Promise<boolean> {
  try { const r = await db.prepare("SELECT value FROM schema_info WHERE key = 'schema_version'").first<{ value: string }>(); return Boolean(r); } catch { return false; }
}

export async function listPublishedPackages(db: Db): Promise<PublishedPackage[]> {
  const { results } = await db.prepare(
    `SELECT p.id AS id, p.title AS title, p.current_version AS version, pv.checksum AS checksum,
            pv.entry_count AS entries, pv.created_at AS publishedAt
       FROM packages p JOIN package_versions pv ON pv.package_id = p.id AND pv.version = p.current_version
      WHERE p.current_version IS NOT NULL ORDER BY p.id`).all<PublishedPackage>();
  return results;
}

/** Only the CURRENT version of a package is served. Older (rolled-back) versions return null. */
export async function getPublishedPackageBody(db: Db, id: string, version: string): Promise<{ body: string; checksum: string } | null> {
  return db.prepare(
    `SELECT pv.body AS body, pv.checksum AS checksum
       FROM packages p JOIN package_versions pv ON pv.package_id = p.id AND pv.version = p.current_version
      WHERE p.id = ? AND p.current_version = ?`).bind(id, version).first<{ body: string; checksum: string }>();
}

/** Sources cited by currently published entries only. Status comes from the latest snapshot ('unchecked' when none). */
export async function listPublishedSources(db: Db): Promise<PublishedSource[]> {
  const { results } = await db.prepare(
    `SELECT DISTINCT s.id AS id, s.label AS label, s.url AS url, s.publisher AS publisher, s.license AS license,
            COALESCE(ls.status, 'unchecked') AS status, ls.retrieved_at AS retrievedAt
       FROM sources s
       JOIN entry_version_sources evs ON evs.source_id = s.id
       JOIN package_version_entries m ON m.entry_id = evs.entry_id AND m.entry_version = evs.version
       JOIN packages p ON p.id = m.package_id AND p.current_version = m.package_version
       LEFT JOIN source_snapshots ls ON ls.id = (SELECT MAX(id) FROM source_snapshots WHERE source_id = s.id)
      ORDER BY s.label`).all<PublishedSource>();
  return results;
}
