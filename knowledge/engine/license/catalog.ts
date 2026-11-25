// L5 licensing intelligence: HINTS about well-known licences. This is NOT a closed list: an identifier or URL that is not
// recognised here is still recorded as evidence (kind "unknown" / "custom-permission") with its original text, and is never
// treated as permissive. The catalogue only tells the assessor what a recognised licence typically requires.
import type { LicenseKind, Restriction } from '../contracts.ts';

export type Indicates = 'permissive' | 'conditional' | 'restricted' | 'unknown';
export type Known = { id: string; name: string; kind: LicenseKind; restrictions: Restriction[]; indicates: Indicates };
const K = (id: string, name: string, kind: LicenseKind, restrictions: Restriction[], indicates: Indicates = 'permissive'): Known => ({ id, name, kind, restrictions, indicates });

const TABLE: { re: RegExp; known: Known }[] = [
  { re: /^(mit|expat)$/, known: K('MIT', 'MIT License', 'open-source', ['notice-required', 'attribution']) },
  { re: /^apache(-?2(\.0)?)?$/, known: K('Apache-2.0', 'Apache License 2.0', 'open-source', ['notice-required', 'attribution', 'patent-clause']) },
  { re: /^bsd-?2(-clause)?$|^simplifiedbsd$/, known: K('BSD-2-Clause', 'BSD 2-Clause License', 'open-source', ['notice-required', 'attribution']) },
  { re: /^bsd-?3(-clause)?$|^newbsd$|^bsd$/, known: K('BSD-3-Clause', 'BSD 3-Clause License', 'open-source', ['notice-required', 'attribution']) },
  { re: /^isc$/, known: K('ISC', 'ISC License', 'open-source', ['notice-required', 'attribution']) },
  { re: /^0bsd$/, known: K('0BSD', 'BSD Zero Clause License', 'open-source', []) },
  { re: /^zlib$/, known: K('Zlib', 'zlib License', 'open-source', ['notice-required']) },
  { re: /^(bsl-?1(\.0)?|boost)$/, known: K('BSL-1.0', 'Boost Software License 1.0', 'open-source', ['notice-required']) },
  { re: /^wtfpl$/, known: K('WTFPL', 'Do What The F*ck You Want To Public License', 'open-source', []) },
  { re: /^unlicense$/, known: K('Unlicense', 'The Unlicense', 'public-domain', []) },
  { re: /^cc0(-1\.0)?$/, known: K('CC0-1.0', 'CC0 1.0 Universal (public-domain dedication)', 'public-domain', []) },
  { re: /^(pdm|pdm-1\.0)$/, known: K('PDM-1.0', 'Public Domain Mark 1.0', 'public-domain', []) },
  { re: /^mpl-?2(\.0)?$/, known: K('MPL-2.0', 'Mozilla Public License 2.0', 'open-source', ['weak-copyleft', 'notice-required'], 'conditional') },
  { re: /^epl-?(1\.0|2\.0)$/, known: K('EPL-2.0', 'Eclipse Public License', 'open-source', ['weak-copyleft', 'notice-required'], 'conditional') },
  { re: /^lgpl-?(2\.1|3\.0|3)?(-only|-or-later|\+)?$/, known: K('LGPL', 'GNU Lesser General Public License', 'open-source', ['weak-copyleft', 'notice-required'], 'conditional') },
  { re: /^gpl-?(2\.0|3\.0|2|3)?(-only|-or-later|\+)?$/, known: K('GPL', 'GNU General Public License', 'open-source', ['copyleft', 'share-alike', 'notice-required'], 'conditional') },
  { re: /^agpl-?(3\.0|3)?(-only|-or-later|\+)?$/, known: K('AGPL-3.0', 'GNU Affero General Public License v3', 'open-source', ['copyleft', 'share-alike', 'notice-required'], 'conditional') },
  { re: /^gfdl-?(1\.[123])?(-only|-or-later)?$/, known: K('GFDL', 'GNU Free Documentation License', 'open-source', ['copyleft', 'share-alike', 'notice-required'], 'conditional') },
  { re: /^artistic-?2(\.0)?$/, known: K('Artistic-2.0', 'Artistic License 2.0', 'open-source', ['notice-required'], 'conditional') },
  { re: /^eupl-?1\.[12]$/, known: K('EUPL', 'European Union Public Licence', 'open-source', ['copyleft', 'notice-required'], 'conditional') }
];

export const normalizeId = (s: string) => s.toLowerCase().replace(/\blicen[sc]e\b/g, '').replace(/\b(version|v)\b/g, '').replace(/[\s_]+/g, '').replace(/^-+|-+$/g, '');
export const lookupLicense = (idOrName: string): Known | null => { const n = normalizeId(idOrName); if (!n) return null; for (const t of TABLE) if (t.re.test(n)) return t.known; return null; };

/** Recognise well-known licence URLs (SPDX, OSI, GNU, Apache, Mozilla ...). Returns null for anything else. */
export function lookupLicenseUrl(raw: string): Known | null {
  let u: URL; try { u = new URL(raw); } catch { return null; }
  const h = u.hostname.replace(/^www\./, ''); const p = u.pathname.toLowerCase();
  if (h === 'spdx.org' && p.startsWith('/licenses/')) return lookupLicense(p.split('/')[2].replace(/\.html?$/, ''));
  if (h === 'opensource.org') { const m = /\/licens(?:es|e)\/([^/]+)/.exec(p); return m ? lookupLicense(m[1].replace(/\.(html?|php)$/, '')) : null; }
  if (h === 'apache.org' && /license-2\.0/.test(p)) return lookupLicense('apache-2.0');
  if (h === 'gnu.org' && p.startsWith('/licenses/')) { const m = /\/licenses\/(l?a?gpl|fdl)(?:-([\d.]+))?/.exec(p); return m ? lookupLicense(m[1] === 'fdl' ? 'gfdl' : m[1]) : null; }
  if (h === 'mozilla.org' && /mpl\/2\.0/.test(p)) return lookupLicense('mpl-2.0');
  if (h === 'unlicense.org') return lookupLicense('unlicense');
  return null;
}

// ---------- Creative Commons ----------
export type CcInfo = { id: string; kind: LicenseKind; restrictions: Restriction[]; indicates: Indicates; elements: string[]; version: string | null; jurisdiction: string | null; name: string };

function ccFrom(elements: string[], version: string | null, jurisdiction: string | null): CcInfo {
  const els = ['by', 'nc', 'nd', 'sa'].filter((e) => elements.includes(e)); const r: Restriction[] = [];
  if (els.includes('by')) r.push('attribution'); if (els.includes('nc')) r.push('non-commercial'); if (els.includes('nd')) r.push('no-derivatives'); if (els.includes('sa')) r.push('share-alike');
  const id = 'CC-' + els.map((e) => e.toUpperCase()).join('-') + (version ? '-' + version : '') + (jurisdiction ? '-' + jurisdiction.toUpperCase() : '');
  const conditional = els.some((e) => e === 'nc' || e === 'nd' || e === 'sa');
  return { id, kind: 'creative-commons', restrictions: r, indicates: conditional ? 'conditional' : 'permissive', elements: els, version, jurisdiction, name: `Creative Commons ${els.map((e) => ({ by: 'Attribution', nc: 'NonCommercial', nd: 'NoDerivatives', sa: 'ShareAlike' } as Record<string, string>)[e]).join('-')}${version ? ' ' + version : ''}` };
}

export function parseCcUrl(raw: string): CcInfo | { id: string; kind: 'public-domain'; restrictions: Restriction[]; indicates: Indicates; name: string } | null {
  let u: URL; try { u = new URL(raw); } catch { return null; }
  if (u.hostname.replace(/^www\./, '') !== 'creativecommons.org') return null;
  const seg = u.pathname.toLowerCase().split('/').filter(Boolean);
  if (seg[0] === 'publicdomain') {
    if (seg[1] === 'zero') return { id: 'CC0-1.0', kind: 'public-domain', restrictions: [], indicates: 'permissive', name: 'CC0 1.0 Universal (public-domain dedication)' };
    if (seg[1] === 'mark') return { id: 'PDM-1.0', kind: 'public-domain', restrictions: [], indicates: 'permissive', name: 'Public Domain Mark 1.0' };
    return null;
  }
  if (seg[0] !== 'licenses' || !seg[1]) return null;
  const els = seg[1].split('-'); if (!els.every((e) => ['by', 'nc', 'nd', 'sa'].includes(e)) || !els.includes('by')) return null;
  return ccFrom(els, /^\d\.\d$/.test(seg[2] || '') ? seg[2] : null, /^[a-z]{2,3}$/.test(seg[3] || '') ? seg[3] : null);
}

/** "Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International" -> CcInfo. Also "CC BY-NC-SA 4.0". */
export function parseCcName(text: string): CcInfo | null {
  const long = /creative\s+commons\s+(attribution(?:[- ]non-?commercial)?(?:[- ](?:no-?deriv(?:ative)?s?|share-?alike))?)\s*(?:license\s*)?(\d\.\d)?/i.exec(text);
  if (long) { const w = long[1].toLowerCase(); const els = ['by']; if (/non-?commercial/.test(w)) els.push('nc'); if (/no-?deriv/.test(w)) els.push('nd'); if (/share-?alike/.test(w)) els.push('sa'); return ccFrom(els, long[2] || null, null); }
  const short = /\bCC[- ]BY(?:[- ](NC))?(?:[- ](ND|SA))?(?:[- ](\d\.\d))?\b/i.exec(text);
  if (short) { const els = ['by']; if (short[1]) els.push('nc'); if (short[2]) els.push(short[2].toLowerCase()); return ccFrom(els, short[3] || null, null); }
  return null;
}
