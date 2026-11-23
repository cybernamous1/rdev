// Acquisition stage: fetch an approved public source politely and record what happened.
// The ledger stores the URL, status, date and a content hash — never a copy of third-party text.
import type { Source } from '../shared/rlf.ts';

export const ALLOWED_HOSTS = ['create.roblox.com', 'luau.org', 'devforum.roblox.com', 'github.com', 'raw.githubusercontent.com'];

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function acquireUrl(source: Source, fetcher: typeof fetch = fetch): Promise<{ source: Source; html: string | null; note: string }> {
  const url = new URL(source.url);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.includes(url.hostname)) {
    return { source: { ...source, status: 'failed' }, html: null, note: `Host ${url.hostname} is not on the approved source list.` };
  }
  try {
    const res = await fetcher(source.url, { headers: { 'user-agent': 'RDevAcademyKnowledgeBot/0.3 (+educational; respects robots and rate limits)', accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { source: { ...source, status: 'failed' }, html: null, note: `HTTP ${res.status}` };
    const html = await res.text();
    return { source: { ...source, status: 'retrieved', retrievedAt: new Date().toISOString(), contentHash: await sha256Hex(html) }, html, note: `Retrieved ${html.length} characters.` };
  } catch (err) {
    return { source: { ...source, status: 'failed', retrievedAt: null, contentHash: null }, html: null, note: `Fetch failed: ${(err as Error).message}` };
  }
}
