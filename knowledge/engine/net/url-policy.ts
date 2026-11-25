// URL safety and canonicalization. Pure functions; Workers-safe (web-standard URL only).
// Discovery may reach any PUBLIC https host, so the policy is about WHAT a URL is, not WHICH site it is:
// no credentials, no custom ports, no IP literals, no loopback/private/internal-looking names (SSRF defence).
export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.corp', '.localdomain', '.home.arpa', '.onion', '.test', '.invalid', '.example'];
const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|ref|ref_src|spm|share|sessionid|sid|phpsessid)$/i;

export function checkUrl(raw: string): UrlCheck {
  let u: URL; try { u = new URL(raw); } catch { return { ok: false, reason: 'not a valid URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'only https URLs are fetched' };
  if (u.username || u.password) return { ok: false, reason: 'URLs with credentials are refused' };
  if (u.port && u.port !== '443') return { ok: false, reason: 'custom ports are refused' };
  const h = u.hostname.toLowerCase();
  if (h.length > 253 || !h.includes('.')) return { ok: false, reason: 'host must be a public domain name' };
  if (h.startsWith('[') || /^[0-9.]+$/.test(h) || h.includes(':')) return { ok: false, reason: 'IP-address hosts are refused' };
  if (/^(0x[0-9a-f]+|[0-9]+)$/i.test(h.split('.').pop() || '')) return { ok: false, reason: 'numeric hosts are refused' };
  if (h === 'localhost' || BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return { ok: false, reason: 'internal-looking host names are refused' };
  if (!/^[a-z0-9.-]+$/.test(h) || h.split('.').some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return { ok: false, reason: 'host name is not a plain public domain name' };
  return { ok: true, url: u };
}

/** Stable identity of a page: lower-case host, no fragment, no tracking parameters, sorted remaining query (max 5), no trailing slash / index file. */
export function canonicalize(raw: string, base?: string): string | null {
  let u: URL; try { u = new URL(raw, base); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  u.hash = ''; u.port = ''; u.hostname = u.hostname.toLowerCase();
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = ''; for (const [k, v] of keep.slice(0, 5)) u.searchParams.append(k, v);
  u.pathname = u.pathname.replace(/\/index\.(html?|php)$/i, '/').replace(/\/{2,}/g, '/');
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  const out = u.toString();
  return out.length <= 500 ? out : null;
}

/** Cheap same-site test without a public-suffix list: equal host after removing a leading "www.". Deliberately conservative. */
export const siteKey = (host: string) => host.toLowerCase().replace(/^www\./, '');
export const sameSite = (a: string, b: string) => siteKey(new URL(a).hostname) === siteKey(new URL(b).hostname);
