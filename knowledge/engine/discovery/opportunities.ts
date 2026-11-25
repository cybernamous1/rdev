// L1 discovery: turn what a page, a robots.txt or a host reveals into NEW places to look (Opportunities).
// No fixed site list: every rule here is about the shape of the web (feeds, sitemaps, link-rich directories, repositories),
// so a new publisher is found the same way as a known one. Expansion is bounded by depth, per-page and per-host quotas.
import type { DiscoveryMethod, Opportunity, OpportunityKind, PageSignals } from '../contracts.ts';
import { canonicalize, checkUrl, sameSite } from '../net/url-policy.ts';
import { scoreUrl } from './relevance.ts';

export const LIMITS = { maxDepth: 3, perPage: 25, perHostPerPage: 8, directoryMinLinks: 25 };
const DIRECTORY_HINT = /\b(awesome|resources?|curated|directory|list of|links|courses|tutorials|learn|learning paths?|roadmap|reading list|bookmarks|collection)\b/i;
const SKIP_HOST = /(^|\.)(facebook|twitter|x|instagram|linkedin|pinterest|tiktok|youtube|reddit|amazon|ebay|google|bing|doubleclick)\.com$/i;

export function kindOf(url: URL): OpportunityKind {
  const p = url.pathname.toLowerCase();
  if (url.hostname === 'github.com' && p.split('/').filter(Boolean).length === 2) return 'repository';
  if (/\.xml(\.gz)?$/.test(p) && /sitemap/.test(p)) return 'sitemap';
  if (/sitemap/.test(p) && /\.(txt|xml|gz)$/.test(p)) return 'sitemap';
  if (/\.(rss|atom)$|\/(feed|rss|atom)(\.xml)?$|feed\.json$/.test(p)) return 'feed';
  return 'page';
}

export function opportunityFor(rawUrl: string, via: DiscoveryMethod, origin: string, depth: number, text = '', forceKind?: OpportunityKind): Opportunity | null {
  const url = canonicalize(rawUrl, origin); if (!url) return null; const chk = checkUrl(url); if (!chk.ok) return null; if (SKIP_HOST.test(chk.url.hostname)) return null;
  const kind = forceKind ?? kindOf(chk.url); const s = scoreUrl(chk.url, text);
  const base = kind === 'sitemap' || kind === 'feed' ? 6 : kind === 'repository' ? 3 : 0;
  if (s.score < 0 && kind === 'page') return null;
  return { url, kind, via, origin, depth, score: base + s.score, reason: s.reason };
}

/** What a fetched HTML page tells us about where to look next. */
export function opportunitiesFromPage(pageUrl: string, depth: number, s: PageSignals, isRelevant: boolean): Opportunity[] {
  const out: Opportunity[] = []; const add = (o: Opportunity | null) => { if (o) out.push(o); };
  for (const f of s.feedLinks) add(opportunityFor(f, 'feed', pageUrl, depth, '', 'feed'));
  if (depth >= LIMITS.maxDepth || s.robotsMeta.nofollow) return dedupe(out);
  const looksLikeDirectory = s.links.length >= LIMITS.directoryMinLinks && (DIRECTORY_HINT.test(s.title + ' ' + s.description + ' ' + pageUrl) || isRelevant);
  const perHost = new Map<string, number>();
  for (const l of s.links) {
    if (out.length >= LIMITS.perPage) break;
    if (l.rel.some((r) => r === 'nofollow' || r === 'ugc' || r === 'sponsored')) continue;
    const o = opportunityFor(l.url, looksLikeDirectory ? 'directory' : 'link-analysis', pageUrl, depth + 1, l.text); if (!o) continue;
    const host = new URL(o.url).hostname; const same = sameSite(o.url, pageUrl);
    // Off-site links are followed only from directory-like pages or relevant pages, and only if the link itself looks educational.
    if (!same && !looksLikeDirectory && !isRelevant) continue;
    if (!same && o.score < 2) continue;
    if (same && o.score < 1) continue;
    const n = perHost.get(host) ?? 0; if (n >= LIMITS.perHostPerPage) continue; perHost.set(host, n + 1);
    out.push({ ...o, score: o.score + (looksLikeDirectory && !same ? 1 : 0) });
  }
  return dedupe(out);
}

/** Probe the conventional index locations of a host once (robots.txt Sitemap lines are authoritative when present). */
export function opportunitiesFromHost(host: string, robotsSitemaps: string[], depth: number): Opportunity[] {
  const out: Opportunity[] = [];
  for (const s of robotsSitemaps) { const o = opportunityFor(s, 'robots-sitemap', `https://${host}/robots.txt`, depth, '', 'sitemap'); if (o && new URL(o.url).hostname.endsWith(host.replace(/^www\./, ''))) out.push(o); }
  if (!out.length) { const o = opportunityFor(`https://${host}/sitemap.xml`, 'host-probe', `https://${host}/`, depth, '', 'sitemap'); if (o) out.push(o); }
  return out;
}

/** Entries of a sitemap or feed become page opportunities (to be verified by actually fetching them). */
export function opportunitiesFromIndex(entries: { url: string; title: string; summary: string }[], via: DiscoveryMethod, origin: string, depth: number, keep = 60): Opportunity[] {
  const out: Opportunity[] = [];
  for (const e of entries) { const o = opportunityFor(e.url, via, origin, depth, e.title + ' ' + e.summary); if (o && (o.kind !== 'page' || o.score >= 1)) out.push(o); }
  return dedupe(out).sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)).slice(0, keep);
}

export function dedupe(list: Opportunity[]): Opportunity[] {
  const seen = new Map<string, Opportunity>();
  for (const o of list) { const prev = seen.get(o.url); if (!prev || o.score > prev.score) seen.set(o.url, o); }
  return [...seen.values()];
}
