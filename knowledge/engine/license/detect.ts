// L5 licensing intelligence: find licensing EVIDENCE on a page. Evidence is recorded with its exact URL, a verbatim excerpt,
// the scope it appears to cover, a confidence and the restrictions it names. Detection never concludes "cleared".
import type { DetectionMethod, LicenseEvidence, LicenseKind, LicenseScope, PageSignals, Restriction } from '../contracts.ts';
import { lookupLicense, lookupLicenseUrl, parseCcName, parseCcUrl, type Indicates } from './catalog.ts';

export const DETECTOR_VERSION = 'rdev-license-detect/1';
export type GitHubRepoJson = { html_url?: string; license?: { spdx_id?: string | null; name?: string | null; url?: string | null } | null; archived?: boolean };
export type DetectInput = { pageUrl: string; signals: PageSignals; fetchedAt: string; contentHash: string | null; github?: GitHubRepoJson | null };

const clip = (s: string, n = 400) => s.replace(/\s+/g, ' ').trim().slice(0, n);
const window = (text: string, i: number, len: number) => clip(text.slice(Math.max(0, i - 120), Math.min(text.length, i + len + 160)));

type Partial = Omit<LicenseEvidence, 'evidenceUrl' | 'detectedAt' | 'contentHash' | 'notes'> & { notes?: string[] };
const finish = (p: Partial, i: DetectInput): LicenseEvidence => ({ ...p, evidenceUrl: i.pageUrl, detectedAt: i.fetchedAt, contentHash: i.contentHash, notes: p.notes ?? [] });
const R = (...r: Restriction[]) => r;

/** Evidence from a licence URL (rel=license, meta, JSON-LD). Unknown URLs are kept as low-confidence "unknown" evidence. */
function fromLicenseUrl(url: string, method: DetectionMethod, excerpt: string, scope: LicenseScope): Partial {
  const cc = parseCcUrl(url);
  if (cc) return { kind: cc.kind, identifier: cc.id, label: cc.name, licenseUrl: url, excerpt, method: method === 'meta-tag' ? method : 'cc-url', scope, confidence: 0.9, restrictions: cc.restrictions, indicates: cc.indicates };
  const k = lookupLicenseUrl(url);
  if (k) return { kind: k.kind, identifier: k.id, label: k.name, licenseUrl: url, excerpt, method, scope, confidence: 0.85, restrictions: k.restrictions, indicates: k.indicates };
  return { kind: 'unknown', identifier: null, label: 'Licence document not recognised', licenseUrl: url, excerpt, method, scope, confidence: 0.4, restrictions: R('unspecified-conditions'), indicates: 'unknown', notes: ['The link points to a licence or terms document the engine cannot interpret. The owner must read it.'] };
}

/** SPDX-style expression: "MIT OR Apache-2.0", "GPL-2.0-only AND MIT", "Apache-2.0 WITH LLVM-exception", "MIT/Apache-2.0". */
export function parseSpdxExpression(expr: string): { ids: string[]; op: 'single' | 'OR' | 'AND' | 'mixed' } {
  const cleaned = expr.replace(/[()]/g, ' ').replace(/\s+WITH\s+\S+/gi, '').trim();
  const hasOr = /\s+OR\s+|\//i.test(cleaned); const hasAnd = /\s+AND\s+/i.test(cleaned);
  const ids = cleaned.split(/\s+(?:OR|AND)\s+|\//i).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9.+-]{2,40}$/.test(s)).slice(0, 6);
  return { ids, op: ids.length <= 1 ? 'single' : hasOr && hasAnd ? 'mixed' : hasOr ? 'OR' : 'AND' };
}

function fromSpdx(expr: string, method: DetectionMethod, excerpt: string, scope: LicenseScope, confidence: number): Partial[] {
  const { ids, op } = parseSpdxExpression(expr); if (!ids.length) return [];
  return ids.map((id) => {
    const k = lookupLicense(id); const notes: string[] = [];
    if (op === 'OR') notes.push(`Dual/multi-licensed: "${expr.trim()}" - the recipient may choose one of the listed licences.`);
    if (op === 'AND') notes.push(`All listed licences apply: "${expr.trim()}".`);
    if (op === 'mixed') notes.push(`Compound expression "${expr.trim()}" needs a human reading.`);
    if (!k) return { kind: 'unknown' as LicenseKind, identifier: id, label: `Unrecognised licence identifier "${id}"`, licenseUrl: null, excerpt, method, scope, confidence: Math.min(confidence, 0.5), restrictions: R('unspecified-conditions'), indicates: 'unknown' as Indicates, notes: [...notes, 'Identifier is not in the built-in hints; treated as unknown, never as permissive.'] };
    return { kind: k.kind, identifier: k.id === 'GPL' || k.id === 'LGPL' || k.id === 'GFDL' ? id : k.id, label: k.name, licenseUrl: null, excerpt, method, scope, confidence, restrictions: k.restrictions, indicates: k.indicates, notes: op === 'single' ? notes : [...notes, `expression:${op}`] };
  });
}

const sentenceAt = (text: string, i: number) => { const a = Math.max(text.lastIndexOf('. ', i), text.lastIndexOf('\n', i)); const b = text.indexOf('. ', i); return text.slice(a < 0 ? 0 : a + 1, b < 0 ? text.length : b + 1); };
function scopeNear(text: string): LicenseScope {
  if (/\b(code|source code|samples?|examples?|snippets?|software)\b/i.test(text)) return /\b(documentation|content|text|articles?|tutorials?)\b/i.test(text) ? 'unspecified' : 'code';
  if (/\b(documentation|content|text|articles?|tutorials?|images?|this (page|work|site|website))\b/i.test(text)) return /this (page|work)\b/i.test(text) ? 'page' : 'content';
  return 'page';
}

function* walk(node: unknown, depth = 0, budget = { n: 200 }): Generator<Record<string, unknown>> {
  if (depth > 4 || budget.n-- <= 0 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) yield* walk(x, depth + 1, budget); return; }
  const o = node as Record<string, unknown>; yield o;
  for (const v of Object.values(o)) yield* walk(v, depth + 1, budget);
}

export function detectLicenseEvidence(i: DetectInput): LicenseEvidence[] {
  const s = i.signals; const found: Partial[] = [];

  // A. rel="license" links
  for (const l of s.licenseLinks.slice(0, 6)) found.push(fromLicenseUrl(l.url, 'rel-license', clip(`${l.text || 'rel=license'} -> ${l.url}`), 'unspecified'));
  // B. meta tags
  for (const m of s.metaLicense) {
    if (/^https:\/\//i.test(m.content)) found.push(fromLicenseUrl(m.content, 'meta-tag', clip(`${m.name}: ${m.content}`), 'page'));
    else { const cc = parseCcName(m.content); const sp = lookupLicense(m.content.replace(/[,.;]+$/, ''));
      if (cc) found.push({ kind: cc.kind, identifier: cc.id, label: cc.name, licenseUrl: null, excerpt: clip(`${m.name}: ${m.content}`), method: 'meta-tag', scope: 'page', confidence: 0.75, restrictions: cc.restrictions, indicates: cc.indicates });
      else if (sp) found.push({ kind: sp.kind, identifier: sp.id, label: sp.name, licenseUrl: null, excerpt: clip(`${m.name}: ${m.content}`), method: 'meta-tag', scope: 'page', confidence: 0.7, restrictions: sp.restrictions, indicates: sp.indicates });
      else found.push({ kind: 'copyright-notice', identifier: null, label: 'Rights statement in page metadata', licenseUrl: null, excerpt: clip(`${m.name}: ${m.content}`), method: 'meta-tag', scope: 'page', confidence: 0.4, restrictions: R('unspecified-conditions'), indicates: 'unknown', notes: ['A rights statement without a recognisable licence grants nothing by itself.'] }); }
  }
  // C. JSON-LD
  for (const doc of s.jsonLd) for (const node of walk(doc)) {
    const lic = node.license ?? node.licence; const vals = Array.isArray(lic) ? lic : lic ? [lic] : [];
    for (const v of vals.slice(0, 3)) {
      const url = typeof v === 'string' ? v : typeof (v as any)?.url === 'string' ? (v as any).url : typeof (v as any)?.['@id'] === 'string' ? (v as any)['@id'] : null;
      const name = typeof (v as any)?.name === 'string' ? (v as any).name : null;
      if (url && /^https:\/\//i.test(url)) found.push(fromLicenseUrl(url, 'json-ld', clip(`JSON-LD license: ${url}`), 'page'));
      else if (typeof v === 'string' || name) { const t = String(name || v); const sp = fromSpdx(t, 'json-ld', clip(`JSON-LD license: ${t}`), 'page', 0.7); found.push(...(sp.length ? sp : [])); }
    }
  }
  // D. text statements (prose only; code blocks are excluded so a tutorial that QUOTES a licence is not mistaken for one)
  const text = (s.footerText + ' \n ' + s.proseText.slice(0, 60_000));
  for (const m of text.matchAll(/SPDX-License-Identifier:\s*([A-Za-z0-9.+\-() /]+?)(?=\s{2,}|$|\n|\*\/|-->)/gi)) found.push(...fromSpdx(m[1], 'spdx-tag', window(text, m.index!, m[0].length), 'unspecified', 0.85));
  let seenCc = false;
  for (const m of text.matchAll(/(?:licensed|released|available|distributed|provided)\s+(?:under|with)\s+(?:the\s+|a\s+)?([^.;\n]{3,100})/gi)) {
    const near = window(text, m.index!, m[0].length); const phrase = m[1];
    const cc = parseCcName(phrase); const scope = scopeNear(sentenceAt(text, m.index!));
    if (cc) { seenCc = true; found.push({ kind: cc.kind, identifier: cc.id, label: cc.name, licenseUrl: null, excerpt: near, method: 'text-pattern', scope, confidence: 0.75, restrictions: cc.restrictions, indicates: cc.indicates }); continue; }
    const dual = /\b(\S+)\s+(?:or|and|\/)\s+(\S+)\b/i.exec(phrase.replace(/licen[sc]e/gi, ''));
    const direct = lookupLicense(phrase.replace(/\s+(license|licence|terms).*$/i, '').trim());
    if (direct) { found.push({ kind: direct.kind, identifier: direct.id, label: direct.name, licenseUrl: null, excerpt: near, method: 'text-pattern', scope, confidence: 0.7, restrictions: direct.restrictions, indicates: direct.indicates }); continue; }
    if (dual && lookupLicense(dual[1]) && lookupLicense(dual[2])) { const choice = /\b(?:dual|multi)[- ]licen[sc]ed\b|\beither\b|\bor\b|\//i.test(sentenceAt(text, m.index!)); found.push(...fromSpdx(`${dual[1]} ${choice ? 'OR' : 'AND'} ${dual[2]}`, 'text-pattern', near, scope, 0.65)); continue; }
    if (/licen[sc]e|terms/i.test(phrase)) found.push({ kind: 'custom-permission', identifier: null, label: clip(`Custom or unrecognised licence: ${phrase}`, 120), licenseUrl: null, excerpt: near, method: 'text-pattern', scope, confidence: 0.45, restrictions: R('unspecified-conditions'), indicates: 'unknown', notes: ['A licence is named but not recognised; read its terms.'] });
  }
  if (!seenCc) for (const m of text.matchAll(/\bCC[- ]BY(?:[- ](?:NC|ND|SA))*(?:[- ]\d\.\d)?\b/g)) { const cc = parseCcName(m[0]); if (cc) found.push({ kind: cc.kind, identifier: cc.id, label: cc.name, licenseUrl: null, excerpt: window(text, m.index!, m[0].length), method: 'text-pattern', scope: 'page', confidence: 0.6, restrictions: cc.restrictions, indicates: cc.indicates }); }
  for (const m of text.matchAll(/\b(?:released|dedicated|placed)\s+(?:in|into|to)\s+the\s+public\s+domain\b|\bpublic[- ]domain\s+(?:dedication|declaration)\b|\bCC0\b/gi))
    found.push({ kind: 'public-domain', identifier: /CC0/i.test(m[0]) ? 'CC0-1.0' : null, label: 'Public-domain declaration', licenseUrl: null, excerpt: window(text, m.index!, m[0].length), method: 'text-pattern', scope: scopeNear(window(text, m.index!, m[0].length)), confidence: 0.65, restrictions: [], indicates: 'permissive', notes: ['Public-domain status can differ by jurisdiction and by work; a declaration is evidence, not proof.'] });
  for (const m of text.matchAll(/\bpermission is (?:hereby )?granted\b[^.]{0,200}|\byou (?:may|are free to|can) (?:freely )?(?:copy|share|redistribute|reuse|republish)\b[^.]{0,160}/gi))
    found.push({ kind: 'custom-permission', identifier: null, label: 'Publisher-specific permission statement', licenseUrl: null, excerpt: window(text, m.index!, m[0].length), method: 'text-pattern', scope: scopeNear(m[0]), confidence: 0.5, restrictions: R('unspecified-conditions'), indicates: 'conditional', notes: ['Custom wording: conditions (attribution, non-commercial, etc.) must be read in full.'] });
  for (const m of text.matchAll(/\b(?:may not|must not|cannot|can not|no part of this[^.]{0,40} may)\s+be\s+(?:reproduced|copied|redistributed|republished|reprinted|transmitted|mirrored)\b[^.]{0,160}|\bno\s+(?:redistribution|reproduction|republication)\b[^.]{0,100}|\bwithout (?:prior )?(?:written )?(?:permission|consent)\b[^.]{0,80}/gi)) {
    const e = window(text, m.index!, m[0].length);
    found.push({ kind: 'proprietary', identifier: null, label: 'Reproduction / redistribution restriction', licenseUrl: null, excerpt: e, method: 'text-pattern', scope: scopeNear(e), confidence: 0.7, restrictions: R('no-reproduction', 'no-redistribution', 'permission-required'), indicates: 'restricted' });
  }
  for (const m of text.matchAll(/\ball rights reserved\b/gi)) found.push({ kind: 'proprietary', identifier: null, label: '"All rights reserved" notice', licenseUrl: null, excerpt: window(text, m.index!, m[0].length), method: 'copyright-notice', scope: 'site', confidence: 0.6, restrictions: R('permission-required'), indicates: 'restricted', notes: ['No licence is granted by this notice; reuse needs the rights holder\'s permission.'] });
  if (/\b(?:for|is limited to)\s+(?:your\s+)?personal(?:,?\s+non-?commercial)?\s+use\s+only\b|\bpersonal use only\b/i.test(text)) { const m = /personal use only|personal(?:,?\s+non-?commercial)?\s+use\s+only/i.exec(text)!; found.push({ kind: 'proprietary', identifier: null, label: 'Personal-use-only restriction', licenseUrl: null, excerpt: window(text, m.index, m[0].length), method: 'text-pattern', scope: 'page', confidence: 0.65, restrictions: R('personal-use-only', 'no-redistribution'), indicates: 'restricted' }); }
  if (/\b(?:non-?commercial(?:\s+use)?\s+only|educational\s+use\s+only)\b/i.test(text) && !found.some((f) => f.restrictions.includes('non-commercial'))) { const m = /non-?commercial(?:\s+use)?\s+only|educational\s+use\s+only/i.exec(text)!; found.push({ kind: 'custom-permission', identifier: null, label: 'Use-limited permission', licenseUrl: null, excerpt: window(text, m.index, m[0].length), method: 'text-pattern', scope: 'page', confidence: 0.5, restrictions: R(/educational/i.test(m[0]) ? 'educational-use-only' : 'non-commercial'), indicates: 'conditional' }); }
  // E. plain copyright notice (grants nothing)
  const cn = /(?:©|\(c\)|copyright)\s*(?:\d{4}(?:\s*[-–]\s*\d{4})?)?\s*[,:]?\s*([A-Z][^.\n|]{1,80})/i.exec(s.footerText || text.slice(-1500));
  if (cn) found.push({ kind: 'copyright-notice', identifier: null, label: 'Copyright notice', licenseUrl: null, excerpt: clip(cn[0], 160), method: 'copyright-notice', scope: 'site', confidence: 0.6, restrictions: R('unspecified-conditions'), indicates: 'unknown', notes: ['A copyright notice identifies a rights holder; it does not grant any reuse permission.'] });
  // F. links to terms pages (not read by the engine)
  let terms = 0;
  for (const l of s.links) { if (terms >= 3) break; if (/\b(terms(?: of (?:use|service))?|copyright|licen[sc]ing|legal|permissions|reuse policy)\b/i.test(l.text) && l.text.length < 60) { terms++; found.push({ kind: 'terms-reference', identifier: null, label: `Terms/legal page: ${l.text}`, licenseUrl: l.url, excerpt: clip(`${l.text} -> ${l.url}`), method: 'terms-link', scope: 'site', confidence: 0.3, restrictions: R('unspecified-conditions'), indicates: 'unknown', notes: ['The page was not read; terms can restrict reuse even when other evidence looks permissive.'] }); } }
  // G. repository API
  if (i.github) {
    const l = i.github.license; const id = l?.spdx_id;
    if (id && id !== 'NOASSERTION') found.push(...fromSpdx(id, 'github-api', clip(`GitHub licence: ${id}${l?.name ? ' (' + l.name + ')' : ''}`), 'repository', 0.85).map((p) => ({ ...p, licenseUrl: l?.url ?? null, notes: [...(p.notes ?? []), 'Repository licences often cover the code only; prose documentation may be licensed differently.'] })));
    else found.push({ kind: 'unknown', identifier: null, label: id === 'NOASSERTION' ? 'Repository has a licence file GitHub could not identify' : 'Repository has no detected licence', licenseUrl: null, excerpt: 'GitHub API: ' + (id ?? 'license: null'), method: 'github-api', scope: 'repository', confidence: 0.7, restrictions: R('permission-required', 'unspecified-conditions'), indicates: id === 'NOASSERTION' ? 'unknown' : 'restricted', notes: ['Without a licence, default copyright applies and reuse is not permitted unless the owner grants it.'] });
  }
  // de-duplicate, strongest first
  const seen = new Map<string, Partial>();
  for (const f of found) { const key = [f.method, f.identifier ?? '', f.licenseUrl ?? '', f.kind, f.excerpt.slice(0, 80)].join('|'); const p = seen.get(key); if (!p || f.confidence > p.confidence) seen.set(key, f); }
  return [...seen.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 20).map((p) => finish(p, i));
}
