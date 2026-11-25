// L3 parsing: turn one HTML (or Markdown/plain) document into neutral PageSignals. Pure, bounded, regex-based
// (no DOM is needed and none exists in Workers). The page is DATA: scripts are never run, markup is never evaluated.
import type { PageSignals, PageLink } from '../contracts.ts';
import { canonicalize } from '../net/url-policy.ts';

const MAX_LINKS = 2000; const MAX_TEXT = 200_000; const MAX_CODE = 40_000;
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
export const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ' '));

export function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const k = m[1].toLowerCase(); if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

export function extractSignals(source: string, baseUrl: string, contentType = 'text/html'): PageSignals {
  const empty: PageSignals = { title: '', description: '', lang: null, canonical: null, robotsMeta: { noindex: false, nofollow: false }, links: [], feedLinks: [], licenseLinks: [], metaLicense: [], jsonLd: [], copyrightMeta: null, proseText: '', codeText: '', footerText: '', codeBlocks: 0, headings: 0, textLength: 0 };
  if (/markdown|text\/plain/.test(contentType) || (!/<\s*(html|body|head|div|p|a)\b/i.test(source.slice(0, 4000)) && !/xhtml|html/.test(contentType))) return fromText(source, baseUrl, empty);
  let html = source.slice(0, 1_600_000);
  // JSON-LD first (it lives in <script>), bounded.
  const jsonLd: unknown[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    if (jsonLd.length >= 5 || m[1].length > 100_000) continue; try { jsonLd.push(JSON.parse(m[1])); } catch { /* malformed JSON-LD is ignored */ }
  }
  html = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const head = /<head\b[\s\S]*?<\/head\s*>/i.exec(html)?.[0] ?? html.slice(0, 30_000);
  const lang = (/<html\b[^>]*>/i.exec(html)?.[0] ? parseAttrs(/<html\b[^>]*>/i.exec(html)![0]).lang : '')?.toLowerCase() || null;
  const metas: Record<string, string> = {}; const metaLicense: { name: string; content: string }[] = []; let copyrightMeta: string | null = null;
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]); const name = (a.name || a.property || a['http-equiv'] || a.itemprop || '').toLowerCase(); const content = (a.content || '').trim(); if (!name || !content) continue;
    metas[name] = content.slice(0, 600);
    if (/^(license|licence|dc\.rights|dcterms\.rights|dcterms\.license|dc\.license|og:license|cc:license|rights)$/.test(name)) metaLicense.push({ name, content: content.slice(0, 400) });
    if (/^(copyright|dc\.rights\.holder)$/.test(name)) copyrightMeta = content.slice(0, 300);
  }
  let canonical: string | null = null; const feedLinks: string[] = []; const licenseLinks: { url: string; text: string }[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]); const rel = (a.rel || '').toLowerCase().split(/\s+/); const href = a.href; if (!href) continue;
    const abs = canonicalize(href, baseUrl); if (!abs) continue;
    if (rel.includes('canonical')) canonical = abs;
    else if (rel.includes('license') || rel.includes('licence')) licenseLinks.push({ url: abs, text: 'link rel=license' });
    else if (rel.includes('alternate') && /(rss|atom|feed\+json|feed)/i.test(a.type || '') && feedLinks.length < 10) feedLinks.push(abs);
  }
  const robots = (metas.robots || '').toLowerCase() + ',' + (metas.rdevacademybot || '').toLowerCase();
  const robotsMeta = { noindex: /\b(noindex|none)\b/.test(robots), nofollow: /\b(nofollow|none)\b/.test(robots) };
  const body = /<body\b[\s\S]*<\/body\s*>/i.exec(html)?.[0] ?? html;
  const footerRaw = [...body.matchAll(/<footer\b[\s\S]*?<\/footer\s*>/gi)].map((m) => m[0]).join(' ');
  const pres: string[] = []; let codeBlocks = 0;
  const noPre = body.replace(/<pre\b[\s\S]*?<\/pre\s*>/gi, (m) => { codeBlocks++; if (pres.join('').length < MAX_CODE) pres.push(collapse(stripTags(m))); return ' '; });
  const links: PageLink[] = [];
  for (const m of noPre.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    if (links.length >= MAX_LINKS) break; const a = parseAttrs(m[1]); if (!a.href || /^(#|javascript:|mailto:|tel:|data:)/i.test(a.href.trim())) continue;
    const abs = canonicalize(a.href.trim(), baseUrl); if (!abs) continue;
    const rel = (a.rel || '').toLowerCase().split(/\s+/).filter(Boolean); const text = collapse(stripTags(m[2])).slice(0, 200);
    links.push({ url: abs, text, rel });
    if (rel.includes('license') || rel.includes('licence')) licenseLinks.push({ url: abs, text });
  }
  const prose = collapse(stripTags(noPre.replace(/<(nav|header|aside)\b[\s\S]*?<\/\1\s*>/gi, ' '))).slice(0, MAX_TEXT);
  const footerText = collapse(stripTags(footerRaw)).slice(0, 1500) || prose.slice(-1500);
  const title = collapse(stripTags(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1] ?? '')) || metas['og:title'] || collapse(stripTags(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(body)?.[1] ?? ''));
  const dedupLic = [...new Map(licenseLinks.map((l) => [l.url, l])).values()];
  return { ...empty, title: title.slice(0, 200), description: (metas.description || metas['og:description'] || '').slice(0, 400), lang, canonical, robotsMeta, links, feedLinks, licenseLinks: dedupLic, metaLicense, jsonLd, copyrightMeta,
    proseText: prose, codeText: pres.join('\n').slice(0, MAX_CODE), footerText, codeBlocks, headings: (body.match(/<h[1-6]\b/gi) || []).length, textLength: prose.length };
}

/** Markdown / plain text: no markup to separate, but fenced code is kept apart from prose and [text](url) links are read. */
function fromText(text: string, baseUrl: string, base: PageSignals): PageSignals {
  const src = text.slice(0, MAX_TEXT); const code: string[] = []; let blocks = 0;
  const prose = src.replace(/```[\s\S]*?```/g, (m) => { blocks++; code.push(m.slice(0, 4000)); return ' '; });
  const links: PageLink[] = [];
  for (const m of prose.matchAll(/\[([^\]\n]{1,200})\]\(([^)\s]+)\)/g)) { const abs = canonicalize(m[2], baseUrl); if (abs && links.length < MAX_LINKS) links.push({ url: abs, text: m[1], rel: [] }); }
  const title = /^\s*#\s+(.+)$/m.exec(prose)?.[1]?.trim() ?? '';
  const p = collapse(prose.replace(/[#*_`>]+/g, ' '));
  return { ...base, title: title.slice(0, 200), links, proseText: p, codeText: code.join('\n').slice(0, MAX_CODE), footerText: p.slice(-1500), codeBlocks: blocks, headings: (prose.match(/^\s*#{1,6}\s/gm) || []).length, textLength: p.length };
}
