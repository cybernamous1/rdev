// L1 discovery: parsers for publicly published INDEXES — sitemaps (XML / text), RSS, Atom and JSON Feed.
// Pure, tolerant, bounded. These never fetch; the orchestrator hands them text it retrieved through the polite fetcher.
import { decodeEntities } from '../parse/html-signals.ts';
import { canonicalize } from '../net/url-policy.ts';

export type IndexEntry = { url: string; title: string; summary: string; lastmod: string | null };
export type SitemapResult = { kind: 'index' | 'urlset'; entries: IndexEntry[]; truncated: boolean };
const MAX_ENTRIES = 2000;
const tag = (block: string, name: string) => { const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(block); return m ? decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : ''; };

export function parseSitemap(text: string, base: string): SitemapResult | null {
  const src = text.slice(0, 6_000_000);
  if (/<sitemapindex\b/i.test(src) || /<urlset\b/i.test(src)) {
    const index = /<sitemapindex\b/i.test(src); const entries: IndexEntry[] = []; let truncated = false;
    for (const m of src.matchAll(index ? /<sitemap\b[\s\S]*?<\/sitemap\s*>/gi : /<url\b[\s\S]*?<\/url\s*>/gi)) {
      if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
      const loc = canonicalize(tag(m[0], 'loc'), base); if (!loc) continue;
      entries.push({ url: loc, title: '', summary: '', lastmod: tag(m[0], 'lastmod') || null });
    }
    return { kind: index ? 'index' : 'urlset', entries, truncated };
  }
  // Plain-text sitemap: one URL per line.
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && lines.slice(0, 20).every((l) => /^https:\/\/\S+$/.test(l))) {
    const entries = lines.slice(0, MAX_ENTRIES).map((l) => canonicalize(l, base)).filter((u): u is string => !!u).map((url) => ({ url, title: '', summary: '', lastmod: null }));
    return { kind: 'urlset', entries, truncated: lines.length > MAX_ENTRIES };
  }
  return null;
}

export function parseFeed(text: string, base: string): IndexEntry[] | null {
  const src = text.slice(0, 3_000_000).trim(); const out: IndexEntry[] = [];
  if (src.startsWith('{')) { // JSON Feed
    try { const j = JSON.parse(src); if (!Array.isArray(j.items)) return null;
      for (const it of j.items.slice(0, MAX_ENTRIES)) { const u = canonicalize(String(it.url || it.external_url || ''), base); if (u) out.push({ url: u, title: String(it.title || '').slice(0, 200), summary: String(it.summary || '').slice(0, 400), lastmod: it.date_modified || it.date_published || null }); }
      return out; } catch { return null; }
  }
  const isAtom = /<feed\b/i.test(src);
  if (!isAtom && !/<rss\b|<rdf:RDF\b|<channel\b/i.test(src)) return null;
  for (const m of src.matchAll(isAtom ? /<entry\b[\s\S]*?<\/entry\s*>/gi : /<item\b[\s\S]*?<\/item\s*>/gi)) {
    if (out.length >= MAX_ENTRIES) break; let link = '';
    if (isAtom) { const links = [...m[0].matchAll(/<link\b[^>]*>/gi)].map((l) => l[0]); const alt = links.find((l) => !/rel\s*=/.test(l) || /rel\s*=\s*["']alternate["']/i.test(l)) ?? links[0]; link = alt ? (/href\s*=\s*["']([^"']+)["']/i.exec(alt)?.[1] ?? '') : ''; }
    else link = tag(m[0], 'link') || tag(m[0], 'guid');
    const url = canonicalize(decodeEntities(link), base); if (!url) continue;
    out.push({ url, title: tag(m[0], 'title').slice(0, 200), summary: tag(m[0], isAtom ? 'summary' : 'description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400), lastmod: tag(m[0], isAtom ? 'updated' : 'pubDate') || null });
  }
  return out;
}
