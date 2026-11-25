// Layer 7 (central knowledge management): the ONLY module of the v0.5.0 engine that touches D1. It implements the store
// interfaces the engine layers declare (DiscoveryStore, HostPolicyStore) on the existing AdminDb shape and uses the v0.4.0 tables
// (discovered_sources, sources, discovery_runs) plus the additive v0.5.0 tables. It never writes `sources`, `proposals` or any
// published structure: approval, extraction and publication stay in the existing owner flows.
import type { AdminDb, AdminStmt } from './admin-api.ts';
import type { DiscoveryStore, FrontierItem, JobRow, NewCandidate } from '../knowledge/engine/orchestrator.ts';
import type { HostPolicy, HostPolicyStore } from '../knowledge/engine/net/fetcher.ts';
import type { LicenseEvidence, Opportunity } from '../knowledge/engine/contracts.ts';
import { bands, hamming, hasFingerprint, NEAR_DISTANCE, sha256Hex } from '../knowledge/engine/monitor/fingerprint.ts';
import { DETECTOR_VERSION } from '../knowledge/engine/license/detect.ts';

const changes = (r: any): number => Number(r?.meta?.changes ?? r?.changes ?? 0);
const safe = <T,>(v: unknown, d: T): T => { try { return JSON.parse(String(v ?? '')) as T; } catch { return d; } };

export class D1HostPolicies implements HostPolicyStore {
  private db: AdminDb;
  constructor(db: AdminDb) { this.db = db; }
  async get(host: string): Promise<HostPolicy | null> {
    const r = await this.db.prepare('SELECT host,robots_status,robots_text,robots_fetched_at,crawl_delay_sec,sitemaps_json,last_fetch_at,consecutive_failures FROM host_policies WHERE host=?').bind(host).first<any>();
    return r ? { host: r.host, robotsStatus: r.robots_status, robotsText: r.robots_text, robotsFetchedAt: Number(r.robots_fetched_at), crawlDelaySec: r.crawl_delay_sec, sitemaps: safe(r.sitemaps_json, []), lastFetchAt: Number(r.last_fetch_at), consecutiveFailures: Number(r.consecutive_failures) } : null;
  }
  async put(p: HostPolicy): Promise<void> {
    await this.db.prepare(`INSERT INTO host_policies(host,robots_status,robots_text,robots_fetched_at,crawl_delay_sec,sitemaps_json,last_fetch_at,consecutive_failures,updated_at) VALUES(?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(host) DO UPDATE SET robots_status=excluded.robots_status,robots_text=excluded.robots_text,robots_fetched_at=excluded.robots_fetched_at,crawl_delay_sec=excluded.crawl_delay_sec,sitemaps_json=excluded.sitemaps_json,last_fetch_at=excluded.last_fetch_at,consecutive_failures=excluded.consecutive_failures,updated_at=excluded.updated_at`)
      .bind(p.host, p.robotsStatus, p.robotsText, p.robotsFetchedAt, p.crawlDelaySec, JSON.stringify(p.sitemaps), p.lastFetchAt, p.consecutiveFailures).run();
  }
}

export async function evidenceStatements(db: AdminDb, candidateWhere: { sql: string; args: unknown[] }, evidence: LicenseEvidence[]): Promise<AdminStmt[]> {
  const out: AdminStmt[] = [];
  for (const e of evidence) {
    const fp = (await sha256Hex([e.method, e.identifier ?? '', e.licenseUrl ?? '', e.evidenceUrl, e.excerpt].join('|'))).slice(0, 32);
    out.push(db.prepare(`INSERT OR IGNORE INTO license_evidence(candidate_id,fingerprint,kind,identifier,label,evidence_url,license_url,excerpt,method,scope,confidence,restrictions_json,indicates,notes_json,detector_version,content_hash,detected_at)
      VALUES((${candidateWhere.sql}),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...candidateWhere.args, fp, e.kind, e.identifier, e.label.slice(0, 200), e.evidenceUrl, e.licenseUrl, e.excerpt.slice(0, 600), e.method, e.scope, e.confidence, JSON.stringify(e.restrictions), e.indicates, JSON.stringify(e.notes), DETECTOR_VERSION, e.contentHash, e.detectedAt));
  }
  return out;
}

export class D1DiscoveryStore implements DiscoveryStore {
  private db: AdminDb;
  constructor(db: AdminDb) { this.db = db; }
  private now = () => new Date().toISOString();

  async createJob(label: string, rootUrl: string, seed: Opportunity): Promise<number> {
    const res = await this.db.batch([
      this.db.prepare('INSERT INTO discovery_jobs(label,root_url) VALUES(?,?)').bind(label.slice(0, 120), rootUrl),
      this.db.prepare("INSERT INTO discovery_frontier(job_id,url,kind,via,origin,depth,score,reason) VALUES((SELECT MAX(id) FROM discovery_jobs),?,?,?,?,?,?,?)").bind(seed.url, seed.kind, seed.via, seed.origin, seed.depth, seed.score, 'owner-provided starting point')
    ]);
    void res; const row = await this.db.prepare('SELECT MAX(id) AS id FROM discovery_jobs').first<{ id: number }>(); return Number(row?.id);
  }
  async listJobs(): Promise<any[]> {
    return (await this.db.prepare(`SELECT j.id,j.label,j.root_url,j.status,j.lease_until,j.stats_json,j.note,j.created_at,j.updated_at,j.completed_at,
      (SELECT COUNT(*) FROM discovery_frontier f WHERE f.job_id=j.id AND f.status IN ('queued','fetching')) AS open_items,
      (SELECT COUNT(*) FROM discovery_frontier f WHERE f.job_id=j.id) AS total_items FROM discovery_jobs j ORDER BY j.id DESC LIMIT 30`).all<any>()).results.map((r) => ({ ...r, stats: safe(r.stats_json, {}), stats_json: undefined }));
  }
  async cancelJob(id: number): Promise<boolean> {
    return changes(await this.db.prepare("UPDATE discovery_jobs SET status='cancelled',lease_until=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('queued','running')").bind(id).run()) === 1;
  }

  async claimJob(jobId: number, now: number, leaseMs: number): Promise<JobRow | null> {
    const r = await this.db.prepare("UPDATE discovery_jobs SET status='running',lease_until=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('queued','running') AND lease_until<?").bind(now + leaseMs, jobId, now).run();
    if (changes(r) !== 1) return null;
    // The previous lease expired, so no step is still working: anything left 'fetching' belongs to an interrupted step and is retried.
    await this.db.prepare("UPDATE discovery_frontier SET status='queued',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id=? AND status='fetching'").bind(jobId).run();
    const j = await this.db.prepare('SELECT id,label,root_url,status,stats_json FROM discovery_jobs WHERE id=?').bind(jobId).first<any>();
    return j ? { id: j.id, label: j.label, rootUrl: j.root_url, status: j.status, stats: safe(j.stats_json, {}) } : null;
  }
  async finishStep(jobId: number, o: { status: 'running' | 'completed' | 'failed'; stats: Record<string, number>; note: string }): Promise<void> {
    const stmts = [this.db.prepare("UPDATE discovery_jobs SET status=?,lease_until=0,stats_json=?,note=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),completed_at=CASE WHEN ? IN ('completed','failed') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id=? AND status='running'").bind(o.status, JSON.stringify(o.stats), o.note, o.status, jobId)];
    if (o.status === 'completed') stmts.push(this.db.prepare("INSERT INTO discovery_runs(seed_id,status,pages_fetched,links_found,new_candidates,note) VALUES(?,'completed',?,?,?,?)").bind(`v5-job-${jobId}`, o.stats.fetched ?? 0, o.stats.frontierAdded ?? 0, o.stats.candidates ?? 0, `v0.5.0 job: ${o.stats.duplicates ?? 0} duplicate(s), ${o.stats.nonEnglish ?? 0} non-English, ${o.stats.blocked ?? 0} blocked by robots/policy.`));
    await this.db.batch(stmts);
  }

  async popFrontier(jobId: number, now: number, limit: number): Promise<FrontierItem[]> {
    const rows = (await this.db.prepare("SELECT id,job_id,url,kind,via,origin,depth,score,attempts FROM discovery_frontier WHERE job_id=? AND status='queued' AND not_before<=? ORDER BY score DESC, id ASC LIMIT ?").bind(jobId, now, limit).all<any>()).results;
    for (const r of rows) await this.db.prepare("UPDATE discovery_frontier SET status='fetching',attempts=attempts+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(r.id).run();
    return rows.map((r) => ({ id: r.id, jobId: r.job_id, url: r.url, kind: r.kind, via: r.via, origin: r.origin, depth: r.depth, score: r.score, attempts: r.attempts }));
  }
  async resolveFrontier(id: number, status: 'queued' | 'done' | 'skipped' | 'blocked' | 'failed', note: string, notBefore = 0): Promise<void> {
    await this.db.prepare("UPDATE discovery_frontier SET status=?,note=?,not_before=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(status, note.slice(0, 300), notBefore, id).run();
  }
  async addFrontier(jobId: number, ops: Opportunity[], cap: number): Promise<number> {
    if (!ops.length) return 0;
    const n = Number((await this.db.prepare('SELECT COUNT(*) AS n FROM discovery_frontier WHERE job_id=?').bind(jobId).first<any>())?.n ?? 0); const room = cap - n; if (room <= 0) return 0;
    const urls = JSON.stringify(ops.map((o) => o.url));
    const known = new Set((await this.db.prepare('SELECT url FROM discovered_sources WHERE url IN (SELECT value FROM json_each(?)) UNION SELECT url FROM sources WHERE url IN (SELECT value FROM json_each(?))').bind(urls, urls).all<{ url: string }>()).results.map((r) => r.url));
    const fresh = ops.filter((o) => !known.has(o.url)).sort((a, b) => b.score - a.score).slice(0, room);
    if (!fresh.length) return 0;
    const res = await this.db.batch(fresh.map((o) => this.db.prepare('INSERT OR IGNORE INTO discovery_frontier(job_id,url,kind,via,origin,depth,score,reason) VALUES(?,?,?,?,?,?,?,?)').bind(jobId, o.url, o.kind, o.via, o.origin, o.depth, o.score, o.reason.slice(0, 200))));
    return res.reduce((s, r) => s + changes(r), 0);
  }
  async frontierSummary(jobId: number, now: number) {
    const r = await this.db.prepare("SELECT SUM(status IN ('queued','fetching')) AS open, SUM(status='queued' AND not_before<=?) AS ready, MIN(CASE WHEN status='queued' AND not_before>? THEN not_before END) AS next FROM discovery_frontier WHERE job_id=?").bind(now, now, jobId).first<any>();
    return { open: Number(r?.open ?? 0), ready: Number(r?.ready ?? 0), nextReadyAt: r?.next ? Number(r.next) : null };
  }

  async knownUrl(url: string): Promise<boolean> {
    return !!(await this.db.prepare('SELECT 1 AS ok FROM discovered_sources WHERE url=? UNION ALL SELECT 1 FROM sources WHERE url=? UNION ALL SELECT 1 FROM discovered_source_meta WHERE canonical_url=? LIMIT 1').bind(url, url, url).first());
  }
  async hostKnown(host: string): Promise<boolean> { return !!(await this.db.prepare('SELECT 1 AS ok FROM discovered_sources WHERE host=? LIMIT 1').bind(host).first()); }
  async findDuplicates(hash: string, sim: string) {
    const exact = await this.db.prepare('SELECT candidate_id AS id FROM discovered_source_meta WHERE content_hash=? LIMIT 1').bind(hash).first<{ id: number }>();
    const near: { id: number; distance: number }[] = [];
    if (hasFingerprint(sim)) {
      const [a, b, c, d] = bands(sim);
      const rows = (await this.db.prepare('SELECT candidate_id AS id, simhash FROM discovered_source_meta WHERE sh0=? OR sh1=? OR sh2=? OR sh3=? LIMIT 200').bind(a, b, c, d).all<{ id: number; simhash: string }>()).results;
      for (const r of rows) { const dist = hamming(sim, r.simhash); if (dist <= NEAR_DISTANCE) near.push({ id: r.id, distance: dist }); }
      near.sort((x, y) => x.distance - y.distance);
    }
    return { exactOf: exact ? Number(exact.id) : null, near };
  }
  async insertCandidate(c: NewCandidate): Promise<number | null> {
    const [a, b, cc, d] = bands(c.simhash); const byUrl = { sql: 'SELECT id FROM discovered_sources WHERE url=?', args: [c.url] };
    const ev = await evidenceStatements(this.db, byUrl, c.evidence);
    const res = await this.db.batch([
      this.db.prepare('INSERT OR IGNORE INTO discovered_sources(url,host,title,publisher,category,suggested_path,relevance,discovered_via) VALUES(?,?,?,?,?,?,?,?)').bind(c.url, c.host, c.title, c.publisher, c.category, c.suggestedPath, c.relevance, `v5:${c.via}`),
      this.db.prepare(`INSERT OR IGNORE INTO discovered_source_meta(candidate_id,resource_type,language,language_confidence,method,depth,canonical_url,content_hash,simhash,sh0,sh1,sh2,sh3,etag,last_modified,signals_json,job_id,fetched_at,next_check_at)
        VALUES((SELECT id FROM discovered_sources WHERE url=?),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(c.url, c.resourceType, c.language.code, c.language.confidence, c.via, c.depth, c.canonicalUrl, c.contentHash, c.simhash, a, b, cc, d, c.etag, c.lastModified, JSON.stringify(c.signals), c.jobId, c.fetchedAt, Date.now() + 7 * 86_400_000),
      ...ev
    ]);
    if (changes(res[0]) === 0) return null;
    const row = await this.db.prepare('SELECT id FROM discovered_sources WHERE url=?').bind(c.url).first<{ id: number }>(); return row ? Number(row.id) : null;
  }
}
