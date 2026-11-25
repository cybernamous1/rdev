// Safe retrieval for the discovery and extraction stages. Used only by owner-triggered Worker requests.
// HTTPS only, approved hosts only, no ports or credentials, redirects followed manually (at most 3) and only to approved
// hosts, streamed size cap, timeout. Source text is returned to the caller; it is never stored by this module.
import { ALLOWED_HOSTS } from './acquire.ts';

export const MAX_RETRIEVE_BYTES = 2_000_000;
export type Retrieved = { ok: boolean; status: number | null; finalUrl: string; contentType: string; text: string; note: string };

export function isAllowedUrl(raw: string): URL | null {
  let u: URL; try { u = new URL(raw); } catch { return null; }
  return u.protocol === 'https:' && ALLOWED_HOSTS.includes(u.hostname) && !u.port && !u.username && !u.password ? u : null;
}

async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > max) { await reader.cancel(); return null; } chunks.push(value); }
  const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out;
}

export async function retrieve(rawUrl: string, accept = 'text/html,text/plain,text/markdown'): Promise<Retrieved> {
  let url = isAllowedUrl(rawUrl); const fail = (note: string, status: number | null = null): Retrieved => ({ ok: false, status, finalUrl: rawUrl, contentType: '', text: '', note });
  if (!url) return fail('URL is not HTTPS on the approved host list.');
  try {
    for (let hop = 0; hop <= 3; hop++) {
      const res: Response = await fetch(url.toString(), { redirect: 'manual', headers: { 'user-agent': 'RDevAcademyKnowledgeBot/0.4 (+educational; owner-triggered; respects source terms)', accept }, signal: AbortSignal.timeout(15000) });
      if (res.status >= 300 && res.status < 400) {
        const loc: string | null = res.headers.get('location'); let next: URL | null = null;
        try { next = loc ? isAllowedUrl(new URL(loc, url).toString()) : null; } catch { next = null; }
        if (!next) return fail(`Redirect (HTTP ${res.status}) to a location outside the approved host list was not followed.`, res.status);
        url = next; continue;
      }
      if (!res.ok) return fail(`HTTP ${res.status}`, res.status);
      const bytes = await readCapped(res, MAX_RETRIEVE_BYTES);
      if (!bytes) return fail('Response exceeded the 2 MB retrieval limit.', res.status);
      return { ok: true, status: res.status, finalUrl: url.toString(), contentType: (res.headers.get('content-type') || '').toLowerCase(), text: new TextDecoder().decode(bytes), note: `Retrieved ${bytes.length} bytes.` };
    }
    return fail('Too many redirects.');
  } catch (e) { return fail(`Retrieval failed: ${(e as Error).message}`); }
}
