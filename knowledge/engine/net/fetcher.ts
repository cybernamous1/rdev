// L2 scanning: polite, bounded retrieval of public https resources.
//  * every URL (and every redirect hop) must pass url-policy (no private/IP/credential/port URLs)
//  * robots.txt is fetched, cached per host (store) and enforced for every request; an unavailable robots.txt means "do not crawl"
//  * per-host spacing (and Crawl-delay) is honoured by DEFERRING, never by sleeping, so a Worker request stays short and resumable
//  * size cap (streamed), timeout, content-type allow-list, conditional requests (ETag / Last-Modified)
//  * downloaded bytes are only ever decoded as text and parsed; nothing fetched is executed (no eval, no dynamic import)
import type { FetchLike } from '../contracts.ts';
import { checkUrl } from './url-policy.ts';
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, robotsFromResponse, type RobotsPolicy } from './robots.ts';

export type HostPolicy = {
  host: string; robotsStatus: 'allow-all' | 'rules' | 'disallow-all'; robotsText: string | null; robotsFetchedAt: number;
  crawlDelaySec: number | null; sitemaps: string[]; lastFetchAt: number; consecutiveFailures: number;
};
export interface HostPolicyStore { get(host: string): Promise<HostPolicy | null>; put(p: HostPolicy): Promise<void> }

export type FetchOk = { kind: 'ok'; status: number; finalUrl: string; contentType: string; bytes: Uint8Array; text: string; etag: string | null; lastModified: string | null; redirects: string[]; xRobotsTag: string | null };
export type FetchResult =
  | FetchOk
  | { kind: 'not-modified'; finalUrl: string }
  | { kind: 'blocked'; reason: 'url-policy' | 'robots' | 'content-type' | 'too-large' | 'redirect'; detail: string }
  | { kind: 'deferred'; retryAfterMs: number; reason: string }
  | { kind: 'error'; status: number | null; note: string };

export type FetchRequest = { accept?: string; conditional?: { etag?: string | null; lastModified?: string | null }; maxBytes?: number; allowTypes?: RegExp };
export type FetcherOptions = {
  fetchImpl: FetchLike; store: HostPolicyStore; now?: () => number; userAgent?: string;
  maxBytes?: number; timeoutMs?: number; maxRedirects?: number; minDelayMs?: number; maxDelayMs?: number; robotsTtlMs?: number;
  /** Public documented API hosts that are not crawled (e.g. api.github.com); robots.txt is not consulted, SSRF rules still apply. */
  apiHosts?: string[];
};

export const DEFAULT_TYPES = /^(text\/(html|plain|markdown|xml)|application\/(xhtml\+xml|xml|rss\+xml|atom\+xml|feed\+json|json|ld\+json|gzip|x-gzip))\b/;
export const MAX_BYTES = 1_500_000;

async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > max) { await reader.cancel(); return null; } chunks.push(value); }
  const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out;
}

/** Decompress gzip bytes (e.g. sitemap.xml.gz) with a hard output cap. Uses the web-standard DecompressionStream. */
export async function gunzip(bytes: Uint8Array, max = 5_000_000): Promise<Uint8Array | null> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > max) { await reader.cancel(); return null; } chunks.push(value); }
  const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out;
}

export class PoliteFetcher {
  private o: Required<Omit<FetcherOptions, 'fetchImpl' | 'store'>> & Pick<FetcherOptions, 'fetchImpl' | 'store'>;
  private memo = new Map<string, RobotsPolicy>();
  constructor(opts: FetcherOptions) {
    this.o = {
      now: () => Date.now(), userAgent: 'RDevAcademyKnowledgeBot/0.5 (+educational; owner-triggered; honors robots.txt)',
      maxBytes: MAX_BYTES, timeoutMs: 12_000, maxRedirects: 3, minDelayMs: 1_000, maxDelayMs: 20_000, robotsTtlMs: 24 * 3600_000, apiHosts: [], ...opts
    };
  }

  /** robots policy for a host, from the store when fresh, otherwise fetched. Never throws. */
  async policyFor(host: string): Promise<{ robots: RobotsPolicy; policy: HostPolicy }> {
    const now = this.o.now(); let policy = await this.o.store.get(host);
    if (policy && now - policy.robotsFetchedAt < this.o.robotsTtlMs) {
      const memo = this.memo.get(host);
      const robots = memo ?? (policy.robotsStatus === 'allow-all' ? ALLOW_ALL : policy.robotsStatus === 'disallow-all' ? DISALLOW_ALL : parseRobots(policy.robotsText || ''));
      this.memo.set(host, robots); return { robots, policy };
    }
    let status: number | null = null; let body = '';
    try {
      let target = `https://${host}/robots.txt`;
      for (let hop = 0; hop <= this.o.maxRedirects; hop++) {
        const chk = checkUrl(target); if (!chk.ok) { status = null; break; }
        const res = await this.o.fetchImpl(target, { redirect: 'manual', headers: { 'user-agent': this.o.userAgent, accept: 'text/plain' }, signal: AbortSignal.timeout(this.o.timeoutMs) });
        if (res.status >= 300 && res.status < 400) { const loc = res.headers.get('location'); if (!loc) { status = res.status; break; } target = new URL(loc, target).toString(); continue; }
        status = res.status;
        if (res.ok) { const bytes = await readCapped(res, 512 * 1024); body = bytes ? new TextDecoder().decode(bytes) : ''; if (!bytes) status = 413; }
        break;
      }
    } catch { status = null; }
    const robots = robotsFromResponse(status, body);
    policy = {
      host, robotsStatus: robots.mode, robotsText: robots.mode === 'rules' ? body.slice(0, 64 * 1024) : null, robotsFetchedAt: now,
      crawlDelaySec: robots.crawlDelaySec, sitemaps: robots.sitemaps, lastFetchAt: policy?.lastFetchAt ?? 0, consecutiveFailures: policy?.consecutiveFailures ?? 0
    };
    await this.o.store.put(policy); this.memo.set(host, robots);
    return { robots, policy };
  }

  async fetch(rawUrl: string, req: FetchRequest = {}): Promise<FetchResult> {
    let url = rawUrl; const redirects: string[] = []; const types = req.allowTypes ?? DEFAULT_TYPES; const max = req.maxBytes ?? this.o.maxBytes;
    for (let hop = 0; hop <= this.o.maxRedirects; hop++) {
      const chk = checkUrl(url); if (!chk.ok) return { kind: 'blocked', reason: hop ? 'redirect' : 'url-policy', detail: chk.reason };
      const host = chk.url.hostname.toLowerCase(); const isApi = this.o.apiHosts.includes(host);
      const { robots, policy } = await this.policyFor(host);
      if (!isApi && !robots.allows(chk.url.pathname + chk.url.search)) return { kind: 'blocked', reason: 'robots', detail: `robots.txt of ${host} does not allow this path` };
      const now = this.o.now();
      const delay = Math.min(Math.max(this.o.minDelayMs, (robots.crawlDelaySec ?? 0) * 1000), this.o.maxDelayMs * 3);
      if (!isApi && policy.lastFetchAt && now - policy.lastFetchAt < delay) return { kind: 'deferred', retryAfterMs: delay - (now - policy.lastFetchAt), reason: `waiting ${Math.ceil(delay / 1000)}s between requests to ${host}` };
      const headers: Record<string, string> = { 'user-agent': this.o.userAgent, accept: req.accept ?? 'text/html,application/xhtml+xml,text/plain,text/markdown,application/xml;q=0.9' };
      if (req.conditional?.etag) headers['if-none-match'] = req.conditional.etag; if (req.conditional?.lastModified) headers['if-modified-since'] = req.conditional.lastModified;
      let res: Response;
      try { res = await this.o.fetchImpl(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(this.o.timeoutMs) }); }
      catch (e) { await this.o.store.put({ ...policy, lastFetchAt: this.o.now(), consecutiveFailures: policy.consecutiveFailures + 1 }); return { kind: 'error', status: null, note: `Request failed: ${(e as Error).message}` }; }
      await this.o.store.put({ ...policy, lastFetchAt: this.o.now(), consecutiveFailures: res.status >= 500 || res.status === 429 ? policy.consecutiveFailures + 1 : 0 });
      if (res.status === 304) return { kind: 'not-modified', finalUrl: url };
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location'); if (!loc) return { kind: 'error', status: res.status, note: 'Redirect without a location.' };
        try { url = new URL(loc, url).toString(); } catch { return { kind: 'blocked', reason: 'redirect', detail: 'invalid redirect target' }; }
        redirects.push(url); continue;
      }
      if (res.status === 429 || res.status === 503) { const ra = Number(res.headers.get('retry-after')); return { kind: 'deferred', retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 3600_000) : 60_000, reason: `HTTP ${res.status} from ${host}` }; }
      if (!res.ok) return { kind: 'error', status: res.status, note: `HTTP ${res.status}` };
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const gz = /\.gz($|\?)/i.test(new URL(url).pathname);
      if (!types.test(contentType) && !(gz && /octet-stream/.test(contentType))) { try { await res.body?.cancel(); } catch { /* ignore */ } return { kind: 'blocked', reason: 'content-type', detail: `content type "${contentType || 'unknown'}" is not processed` }; }
      let bytes = await readCapped(res, max); if (!bytes) return { kind: 'blocked', reason: 'too-large', detail: `response exceeded ${max} bytes` };
      if (gz || /gzip/.test(contentType)) { const out = await gunzip(bytes); if (!out) return { kind: 'blocked', reason: 'too-large', detail: 'decompressed response exceeded the limit' }; bytes = out; }
      return { kind: 'ok', status: res.status, finalUrl: url, contentType, bytes, text: new TextDecoder().decode(bytes), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), redirects, xRobotsTag: res.headers.get('x-robots-tag') };
    }
    return { kind: 'blocked', reason: 'redirect', detail: 'too many redirects' };
  }
}
