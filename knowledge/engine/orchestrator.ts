// Orchestrator: advances ONE bounded step of a discovery job. Every step is short (a handful of fetches), leaves all state in the
// store, and can be repeated until the job reports `done`. A step that is interrupted (Worker timeout, crash) loses nothing: its lease
// simply expires and the next step resumes from the persisted frontier. Layers are reached only through contracts.ts types and the
// runtime registry; this file is the only place that wires them together. It never approves, registers, extracts or publishes anything.
import type { LicenseEvidence, Opportunity, PathClassifier, ResourceCandidate } from './contracts.ts';
import type { PoliteFetcher } from './net/fetcher.ts';
import type { RuntimeRegistry } from './runtime/registry.ts';
import type { PageSignals } from './contracts.ts';
import { canonicalize, sameSite } from './net/url-policy.ts';
import { assessRelevance, MIN_RELEVANCE } from './discovery/relevance.ts';
import { opportunitiesFromHost, opportunitiesFromIndex, opportunitiesFromPage, opportunityFor, dedupe } from './discovery/opportunities.ts';
import { bands, hamming, hasFingerprint, NEAR_DISTANCE, sha256Hex, simhash } from './monitor/fingerprint.ts';
import { extractSignals } from './parse/html-signals.ts';
import { detectLicenseEvidence, type GitHubRepoJson } from './license/detect.ts';
import type { SitemapResult, IndexEntry } from './discovery/indexes.ts';

export type FrontierItem = { id: number; jobId: number; url: string; kind: Opportunity['kind']; via: Opportunity['via']; origin: string; depth: number; score: number; attempts: number };
export type JobRow = { id: number; label: string; rootUrl: string; status: string; stats: Record<string, number> };
export type NewCandidate = ResourceCandidate & { category: 'official-docs' | 'language' | 'repository'; jobId: number; fetchedAt: string; etag: string | null; lastModified: string | null; evidence: LicenseEvidence[] };

export interface DiscoveryStore {
  claimJob(jobId: number, now: number, leaseMs: number): Promise<JobRow | null>;
  finishStep(jobId: number, o: { status: 'running' | 'completed' | 'failed'; stats: Record<string, number>; note: string }): Promise<void>;
  popFrontier(jobId: number, now: number, limit: number): Promise<FrontierItem[]>;
  resolveFrontier(id: number, status: 'queued' | 'done' | 'skipped' | 'blocked' | 'failed', note: string, notBefore?: number): Promise<void>;
  addFrontier(jobId: number, ops: Opportunity[], cap: number): Promise<number>;
  frontierSummary(jobId: number, now: number): Promise<{ open: number; ready: number; nextReadyAt: number | null }>;
  knownUrl(url: string): Promise<boolean>;
  hostKnown(host: string): Promise<boolean>;
  findDuplicates(hash: string, sim: string): Promise<{ exactOf: number | null; near: { id: number; distance: number }[] }>;
  insertCandidate(c: NewCandidate): Promise<number | null>;
}
export type StepLimits = { maxFetches: number; leaseMs: number; maxFrontier: number; maxCandidates: number };
export const DEFAULT_LIMITS: StepLimits = { maxFetches: 10, leaseMs: 60_000, maxFrontier: 400, maxCandidates: 40 };
export type Deps = { fetcher: PoliteFetcher; store: DiscoveryStore; runtime: RuntimeRegistry; classify: PathClassifier; now?: () => number; limits?: Partial<StepLimits> };
export type StepSummary = { jobId: number; done: boolean; busy?: boolean; fetched: number; newCandidates: number; open: number; waitMs: number | null; stats: Record<string, number>; log: string[] };

const bump = (s: Record<string, number>, k: string, n = 1) => { s[k] = (s[k] ?? 0) + n; };
const categoryOf = (t: ResourceCandidate['resourceType']) => (t === 'repository' ? 'repository' : 'official-docs') as 'repository' | 'official-docs';

export async function runDiscoveryStep(jobId: number, deps: Deps): Promise<StepSummary> {
  const now = deps.now ?? (() => Date.now()); const L = { ...DEFAULT_LIMITS, ...deps.limits };
  const job = await deps.store.claimJob(jobId, now(), L.leaseMs);
  if (!job) return { jobId, done: false, busy: true, fetched: 0, newCandidates: 0, open: 0, waitMs: null, stats: {}, log: ['Job is not runnable (finished, cancelled, or another step is still running).'] };
  const stats = { ...job.stats }; const log: string[] = []; let fetched = 0; let created = 0;
  try {
    while (fetched < L.maxFetches && created < L.maxCandidates) {
      const [item] = await deps.store.popFrontier(job.id, now(), 1); if (!item) break;
      const r = await processItem(item, job, deps, stats, log, L);
      if (r.fetched) fetched++; created += r.candidates;
    }
    const sum = await deps.store.frontierSummary(job.id, now());
    const done = sum.open === 0;
    await deps.store.finishStep(job.id, { status: done ? 'completed' : 'running', stats, note: log.slice(-5).join(' | ').slice(0, 500) });
    return { jobId: job.id, done, fetched, newCandidates: created, open: sum.open, waitMs: sum.ready > 0 ? 0 : sum.nextReadyAt ? Math.max(0, sum.nextReadyAt - now()) : null, stats, log };
  } catch (e) {
    await deps.store.finishStep(job.id, { status: 'failed', stats, note: `Step failed: ${(e as Error).message}`.slice(0, 500) }).catch(() => {});
    throw e;
  }
}

async function processItem(item: FrontierItem, job: JobRow, d: Deps, stats: Record<string, number>, log: string[], L: StepLimits): Promise<{ fetched: boolean; candidates: number }> {
  const now = d.now ?? (() => Date.now());
  const addOps = async (ops: Opportunity[]) => { const n = await d.store.addFrontier(job.id, ops, L.maxFrontier); bump(stats, 'frontierAdded', n); };
  if (item.kind === 'repository') return repository(item, job, d, stats, log);

  const accept = item.kind === 'sitemap' || item.kind === 'feed' ? 'application/xml,text/xml,application/rss+xml,application/atom+xml,application/feed+json,text/plain,application/gzip' : undefined;
  const res = await d.fetcher.fetch(item.url, { accept });
  if (res.kind === 'deferred') { bump(stats, 'deferred'); await d.store.resolveFrontier(item.id, 'queued', res.reason, now() + res.retryAfterMs); return { fetched: false, candidates: 0 }; }
  if (res.kind === 'blocked') { bump(stats, 'blocked'); log.push(`${item.url}: blocked (${res.reason})`); await d.store.resolveFrontier(item.id, 'blocked', `${res.reason}: ${res.detail}`); return { fetched: false, candidates: 0 }; }
  if (res.kind === 'error' || res.kind === 'not-modified') {
    bump(stats, 'errors'); const retry = res.kind === 'error' && (res.status === null || res.status >= 500) && item.attempts < 2;
    await d.store.resolveFrontier(item.id, retry ? 'queued' : 'failed', res.kind === 'error' ? res.note : 'not modified', retry ? now() + 120_000 : undefined); return { fetched: true, candidates: 0 };
  }
  bump(stats, 'fetched');

  if (item.kind === 'sitemap') {
    const parsed = await d.runtime.run<SitemapResult | null>('sitemap.parse', { text: res.text, url: item.url }, { inputBytes: res.bytes.length });
    if (!parsed.ok || !parsed.value) { await d.store.resolveFrontier(item.id, 'failed', parsed.ok ? 'not a sitemap' : parsed.errors[0].error); return { fetched: true, candidates: 0 }; }
    const sm = parsed.value;
    if (sm.kind === 'index') await addOps(opportunitiesFromIndex(sm.entries, 'sitemap', item.url, item.depth + 1, 12).map((o) => ({ ...o, kind: 'sitemap' as const, score: o.score + 2 })));
    else await addOps(opportunitiesFromIndex(sm.entries, 'sitemap', item.url, item.depth + 1, 40));
    await d.store.resolveFrontier(item.id, 'done', `${sm.kind}: ${sm.entries.length} entries${sm.truncated ? ' (truncated)' : ''}`); return { fetched: true, candidates: 0 };
  }
  if (item.kind === 'feed') {
    const parsed = await d.runtime.run<IndexEntry[] | null>('feed.parse', { text: res.text, url: item.url }, { inputBytes: res.bytes.length });
    if (!parsed.ok || !parsed.value) { await d.store.resolveFrontier(item.id, 'failed', parsed.ok ? 'not a feed' : parsed.errors[0].error); return { fetched: true, candidates: 0 }; }
    await addOps(opportunitiesFromIndex(parsed.value, 'feed', item.url, item.depth + 1, 40));
    await d.store.resolveFrontier(item.id, 'done', `feed: ${parsed.value.length} items`); return { fetched: true, candidates: 0 };
  }

  // page / directory
  if (/(^|[,\s])(noindex|none)\b/i.test(res.xRobotsTag || '')) { bump(stats, 'noindex'); await d.store.resolveFrontier(item.id, 'skipped', 'X-Robots-Tag asks not to index this page'); return { fetched: true, candidates: 0 }; }
  const sg = await d.runtime.run<PageSignals>('html.signals', { text: res.text, url: res.finalUrl, contentType: res.contentType }, { inputBytes: res.bytes.length });
  if (!sg.ok) { await d.store.resolveFrontier(item.id, 'failed', sg.errors[0].error); bump(stats, 'errors'); return { fetched: true, candidates: 0 }; }
  const s = sg.value; const finalUrl = canonicalize(res.finalUrl) ?? res.finalUrl;
  const canonical = s.canonical && sameSite(s.canonical, finalUrl) ? s.canonical : finalUrl;
  const rel = assessRelevance(new URL(canonical), s, d.classify);
  const english = rel.language.code === 'en' || (rel.language.code === 'unknown') || (rel.language.code === 'other' && rel.language.confidence < 0.6);
  const relevant = rel.score >= MIN_RELEVANCE && english && !s.robotsMeta.noindex;
  if (!english) bump(stats, 'nonEnglish'); else if (rel.score < MIN_RELEVANCE) bump(stats, 'irrelevant');
  if (s.robotsMeta.noindex) bump(stats, 'noindex');

  // Expand through the page (feeds always; links only within depth/quotas), including hosts seen for the first time.
  const ops = opportunitiesFromPage(finalUrl, item.depth, s, relevant);
  const host = new URL(canonical).hostname;
  if (relevant && !(await d.store.hostKnown(host))) { const { policy } = await d.fetcher.policyFor(host); ops.push(...opportunitiesFromHost(host, policy.sitemaps, item.depth + 1)); }
  if (item.depth === 0 && item.via === 'owner-hint') { const { policy } = await d.fetcher.policyFor(host); ops.push(...opportunitiesFromHost(host, policy.sitemaps, 1)); }
  await addOps(dedupe(ops));

  if (!relevant) { await d.store.resolveFrontier(item.id, 'done', `not queued as a candidate (relevance ${rel.score}${english ? '' : ', not English'})`); return { fetched: true, candidates: 0 }; }
  if (await d.store.knownUrl(canonical) || await d.store.knownUrl(finalUrl)) { await d.store.resolveFrontier(item.id, 'done', 'already known'); bump(stats, 'alreadyKnown'); return { fetched: true, candidates: 0 }; }

  const contentHash = await sha256Hex(JSON.stringify({ t: s.title, p: s.proseText }));
  const sh = await d.runtime.run<string>('text.simhash', { text: s.proseText });
  const sim = sh.ok ? sh.value : simhash(s.proseText);
  const dup = await d.store.findDuplicates(contentHash, sim);
  if (dup.exactOf !== null || dup.near.length) { bump(stats, 'duplicates'); await d.store.resolveFrontier(item.id, 'done', dup.exactOf !== null ? `exact duplicate of candidate #${dup.exactOf}` : `near-duplicate of candidate #${dup.near[0].id} (distance ${dup.near[0].distance})`); return { fetched: true, candidates: 0 }; }

  const fetchedAt = new Date(now()).toISOString();
  const ev = await d.runtime.run<LicenseEvidence[]>('license.detect', { pageUrl: finalUrl, signals: s, fetchedAt, contentHash });
  const candidate: NewCandidate = {
    url: canonical, canonicalUrl: canonical, title: (s.title || canonical).slice(0, 160), host, publisher: host.replace(/^www\./, ''), resourceType: rel.resourceType, language: rel.language,
    relevance: rel.score, suggestedPath: rel.suggestedPath, signals: rel.signals, via: item.via, depth: item.depth, contentHash, simhash: hasFingerprint(sim) ? sim : '0'.repeat(16),
    category: categoryOf(rel.resourceType), jobId: job.id, fetchedAt, etag: res.etag, lastModified: res.lastModified, evidence: ev.ok ? ev.value : []
  };
  const id = await d.store.insertCandidate(candidate);
  await d.store.resolveFrontier(item.id, 'done', id ? `candidate #${id} queued for owner review (relevance ${rel.score})` : 'candidate already queued');
  if (id) { bump(stats, 'candidates'); log.push(`candidate #${id}: ${candidate.title.slice(0, 60)}`); }
  return { fetched: true, candidates: id ? 1 : 0 };
}

async function repository(item: FrontierItem, job: JobRow, d: Deps, stats: Record<string, number>, log: string[]): Promise<{ fetched: boolean; candidates: number }> {
  const now = d.now ?? (() => Date.now());
  const seg = new URL(item.url).pathname.split('/').filter(Boolean); const api = `https://api.github.com/repos/${seg[0]}/${seg[1]}`;
  const res = await d.fetcher.fetch(api, { accept: 'application/vnd.github+json', allowTypes: /^application\/json/ });
  if (res.kind === 'deferred') { bump(stats, 'deferred'); await d.store.resolveFrontier(item.id, 'queued', res.reason, now() + res.retryAfterMs); return { fetched: false, candidates: 0 }; }
  if (res.kind !== 'ok') {
    const rate = res.kind === 'error' && (res.status === 403 || res.status === 429);
    bump(stats, rate ? 'deferred' : 'errors'); await d.store.resolveFrontier(item.id, rate ? 'queued' : 'failed', res.kind === 'error' ? res.note : res.kind, rate ? now() + 15 * 60_000 : undefined); return { fetched: true, candidates: 0 };
  }
  bump(stats, 'fetched');
  let repo: GitHubRepoJson & { full_name?: string; description?: string | null; topics?: string[]; fork?: boolean; disabled?: boolean; language?: string | null };
  try { repo = JSON.parse(res.text); } catch { await d.store.resolveFrontier(item.id, 'failed', 'invalid JSON from the API'); return { fetched: true, candidates: 0 }; }
  if (repo.disabled || repo.fork) { await d.store.resolveFrontier(item.id, 'skipped', 'fork or disabled repository'); return { fetched: true, candidates: 0 }; }
  const canonical = canonicalize(repo.html_url || item.url) ?? item.url;
  const text = `# ${repo.full_name}\n${repo.description ?? ''}\nTopics: ${(repo.topics ?? []).join(' ')}\nLanguage: ${repo.language ?? ''}`;
  const s = extractSignals(text, canonical, 'text/plain');
  const rel = assessRelevance(new URL(canonical), { ...s, textLength: Math.max(s.textLength, 400) }, d.classify);
  if (rel.score < MIN_RELEVANCE - 1 || rel.language.code === 'other') { bump(stats, 'irrelevant'); await d.store.resolveFrontier(item.id, 'done', `repository not queued (relevance ${rel.score})`); return { fetched: true, candidates: 0 }; }
  if (await d.store.knownUrl(canonical)) { await d.store.resolveFrontier(item.id, 'done', 'already known'); bump(stats, 'alreadyKnown'); return { fetched: true, candidates: 0 }; }
  const contentHash = await sha256Hex(JSON.stringify({ n: repo.full_name, d: repo.description, t: repo.topics, l: repo.license?.spdx_id ?? null }));
  const sim = simhash(text + ' ' + text);
  const dup = await d.store.findDuplicates(contentHash, sim); if (dup.exactOf !== null) { bump(stats, 'duplicates'); await d.store.resolveFrontier(item.id, 'done', `exact duplicate of candidate #${dup.exactOf}`); return { fetched: true, candidates: 0 }; }
  const fetchedAt = new Date(now()).toISOString();
  const evidence = detectLicenseEvidence({ pageUrl: canonical, signals: s, fetchedAt, contentHash, github: repo });
  const host = new URL(canonical).hostname;
  const id = await d.store.insertCandidate({ url: canonical, canonicalUrl: canonical, title: (repo.full_name ? `${repo.full_name}${repo.description ? ' - ' + repo.description : ''}` : canonical).slice(0, 160), host, publisher: `${seg[0]} (GitHub)`, resourceType: 'repository', language: rel.language, relevance: rel.score, suggestedPath: rel.suggestedPath,
    signals: [...rel.signals, 'metadata from the public GitHub repository API'], via: 'repository-api', depth: item.depth, contentHash, simhash: sim, category: 'repository', jobId: job.id, fetchedAt, etag: res.etag, lastModified: res.lastModified, evidence });
  await d.store.resolveFrontier(item.id, 'done', id ? `repository candidate #${id}` : 'candidate already queued'); if (id) { bump(stats, 'candidates'); log.push(`repository candidate #${id}`); }
  return { fetched: true, candidates: id ? 1 : 0 };
}

export const seedOpportunity = (rootUrl: string): Opportunity | null => { const o = opportunityFor(rootUrl, 'owner-hint', rootUrl, 0); return o ? { ...o, score: 100 } : null; };
export { bands, hamming, NEAR_DISTANCE };
