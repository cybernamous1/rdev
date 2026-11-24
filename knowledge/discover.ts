// Discovery stage: find CANDIDATE sources by reading links from a few fixed, official discovery roots.
// Pure functions (no network, no database). A candidate is only a suggestion: nothing here registers, trusts,
// extracts or publishes anything. Relevance and path suggestions use the same transparent keyword rules as classify.ts.
import { PATHS } from '../shared/paths.ts';
import { classifyText } from './classify.ts';

export type Category = 'official-docs' | 'language' | 'repository';
export type Seed = { id: string; label: string; url: string; publisher: string; category: Category };
export type Candidate = { url: string; title: string; host: string; publisher: string; category: Category; relevance: number; suggestedPath: string | null };

/** Discovery roots (where to LOOK). They are not trusted sources and are not registered by being listed here. */
export const SEEDS: Seed[] = [
  { id: 'roblox-docs-studio', label: 'Creator Hub docs: Studio', url: 'https://create.roblox.com/docs/studio', publisher: 'Roblox Corporation', category: 'official-docs' },
  { id: 'roblox-docs-scripting', label: 'Creator Hub docs: Scripting', url: 'https://create.roblox.com/docs/scripting', publisher: 'Roblox Corporation', category: 'official-docs' },
  { id: 'roblox-docs-ui', label: 'Creator Hub docs: UI', url: 'https://create.roblox.com/docs/ui', publisher: 'Roblox Corporation', category: 'official-docs' },
  { id: 'roblox-docs-animation', label: 'Creator Hub docs: Animation', url: 'https://create.roblox.com/docs/animation', publisher: 'Roblox Corporation', category: 'official-docs' },
  { id: 'roblox-docs-cloud', label: 'Creator Hub docs: Cloud services', url: 'https://create.roblox.com/docs/cloud-services', publisher: 'Roblox Corporation', category: 'official-docs' },
  { id: 'luau-site', label: 'Luau language site', url: 'https://luau.org/', publisher: 'Luau project', category: 'language' },
  { id: 'repo-roblox-creator-docs', label: 'GitHub: Roblox/creator-docs', url: 'https://github.com/Roblox/creator-docs', publisher: 'Roblox (GitHub)', category: 'repository' },
  { id: 'repo-luau-lang', label: 'GitHub: luau-lang/luau', url: 'https://github.com/luau-lang/luau', publisher: 'Luau project (GitHub)', category: 'repository' }
];
export const TRUSTED_GITHUB_OWNERS = ['roblox', 'luau-lang'];
export const MAX_CANDIDATES_PER_RUN = 40;
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|zip|gz|pdf|mp4|webm|woff2?|ttf|map|txt)$/i;

export const seedById = (id: unknown) => SEEDS.find((s) => s.id === id);

export function normalizeUrl(raw: string, base: string): URL | null {
  let u: URL; try { u = new URL(raw, base); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
  u.hash = ''; u.search = '';
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u;
}

/** Links from HTML (href) or Markdown ([text](url)). */
export function extractLinks(body: string, base: string): { url: URL; text: string }[] {
  const out: { url: URL; text: string }[] = [];
  const add = (href: string, text: string) => { const u = normalizeUrl(href.trim(), base); if (u) out.push({ url: u, text: text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }); };
  for (const m of body.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) add(m[1], m[2]);
  for (const m of body.matchAll(/\[([^\]\n]{1,200})\]\(([^)\s]+)\)/g)) add(m[2], m[1]);
  return out;
}

function accept(u: URL): Category | null {
  const p = u.pathname;
  if (SKIP_EXT.test(p) && !(u.hostname === 'raw.githubusercontent.com' || /\.md$/i.test(p))) return null;
  if (u.hostname === 'create.roblox.com') return p.startsWith('/docs/') && !/^\/docs\/(assets|_next)\b/.test(p) ? 'official-docs' : null;
  if (u.hostname === 'luau.org') return p === '/' || /^\/[a-z0-9-]+$/i.test(p) ? 'language' : null;
  if (u.hostname === 'github.com') {
    const seg = p.split('/').filter(Boolean);
    if (!TRUSTED_GITHUB_OWNERS.includes((seg[0] || '').toLowerCase())) return null;
    if (seg.length === 2 && /^[\w.-]+$/.test(seg[1])) return 'repository';
    if (seg.length >= 5 && seg[2] === 'blob' && /\.md$/i.test(p)) return 'repository';
  }
  if (u.hostname === 'raw.githubusercontent.com') { const seg = p.split('/').filter(Boolean); return TRUSTED_GITHUB_OWNERS.includes((seg[0] || '').toLowerCase()) && /\.md$/i.test(p) ? 'repository' : null; }
  return null;
}

const titleFromPath = (u: URL) => decodeURIComponent(u.pathname.split('/').filter(Boolean).slice(-2).join(' / ')).replace(/[-_]+/g, ' ') || u.hostname;

export function candidatesFrom(links: { url: URL; text: string }[], seed: Seed): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const { url, text } of links) {
    const category = accept(url); if (!category || seen.has(url.toString())) continue;
    const title = (text && text.length >= 3 ? text : titleFromPath(url)).slice(0, 160);
    const c = classifyText(decodeURIComponent(url.pathname).replace(/[-_/]+/g, ' ') + ' ' + title, title);
    const bonus = category === 'language' || category === 'repository' ? 1 : 0;
    const relevance = c.ranked[0].score + bonus;
    if (c.path === null && category === 'official-docs') continue; // nothing relates it to a learning path
    seen.set(url.toString(), { url: url.toString(), title, host: url.hostname, publisher: seed.publisher, category, relevance, suggestedPath: c.path });
  }
  return [...seen.values()].sort((a, b) => b.relevance - a.relevance || a.url.localeCompare(b.url)).slice(0, MAX_CANDIDATES_PER_RUN);
}

/** Where the readable content of an approved source lives (GitHub pages are read as raw Markdown, never as HTML). */
export function contentUrls(sourceUrl: string): string[] {
  const u = normalizeUrl(sourceUrl, sourceUrl); if (!u) return [];
  if (u.hostname === 'github.com') {
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length === 2) return ['main', 'master'].map((b) => `https://raw.githubusercontent.com/${seg[0]}/${seg[1]}/${b}/README.md`);
    if (seg[2] === 'blob') return [`https://raw.githubusercontent.com/${seg[0]}/${seg[1]}/${seg.slice(3).join('/')}`];
  }
  return [u.toString()];
}

export const pathNames = PATHS.map((p) => p.name);
