// L5 licensing intelligence: combine evidence into an ASSESSMENT for the owner. The assessment can say "indicated permissive",
// but it can never say "cleared": clearance is a separate owner decision (license_reviews). Free access to read a page is
// reported separately and is never treated as permission to reuse or redistribute.
import type { LicenseAssessment, LicenseEvidence, Restriction, ReuseStatus } from '../contracts.ts';

const ACCESS_NOTE = 'The page was readable without payment or login. That is access only: it is not permission to copy, adapt, republish or redistribute it.';
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

export function assessLicense(evidence: LicenseEvidence[], opts: { resourceType?: string } = {}): LicenseAssessment {
  const base = { access: { publiclyReadable: true, note: ACCESS_NOTE }, clearance: 'not-cleared' as const, requiresOwnerDecision: true as const };
  const grants = evidence.filter((e) => e.indicates !== 'unknown' || e.kind === 'unknown');
  const real = evidence.filter((e) => ['open-source', 'creative-commons', 'public-domain', 'custom-permission', 'proprietary'].includes(e.kind) || e.indicates === 'restricted');
  if (real.length === 0) {
    const notice = evidence.some((e) => e.kind === 'copyright-notice' || e.kind === 'terms-reference');
    return { ...base, reuse: { status: 'no-evidence', summary: notice ? 'Only a copyright notice or a link to terms was found. Nothing grants reuse; default copyright is assumed to apply.' : 'No licensing evidence was found. Default copyright is assumed to apply.' },
      restrictions: ['permission-required'], confidence: notice ? 0.5 : 0.4, conflicts: [], reasons: ['no licence, public-domain declaration or permission statement was detected'] };
  }
  const permissive = real.filter((e) => e.indicates === 'permissive'); const conditional = real.filter((e) => e.indicates === 'conditional'); const restricted = real.filter((e) => e.indicates === 'restricted');
  const unknown = real.filter((e) => e.indicates === 'unknown');
  const reasons: string[] = []; const conflicts: string[] = [];

  // Alternatives (OR expressions) are choices: one option may be selected, so they do not conflict with each other.
  const alt = (e: LicenseEvidence) => e.notes.some((n) => n === 'expression:OR' || /Dual\/multi-licensed/.test(n));
  const orGroup = real.filter(alt);
  const best = [...real].sort((a, b) => b.confidence - a.confidence)[0];
  let status: ReuseStatus;

  if (restricted.length && (permissive.length || conditional.length)) {
    const nonAlt = [...permissive, ...conditional].filter((e) => !alt(e));
    if (nonAlt.length || !orGroup.length) {
      status = 'conflicting';
      conflicts.push(`Restrictive wording ("${restricted[0].label}") appears alongside permissive evidence ("${[...permissive, ...conditional][0].label}"). They may cover different scopes (e.g. code vs. text) or contradict each other.`);
    } else status = 'ambiguous';
  } else if (restricted.length) { status = 'restricted'; reasons.push(`restrictive terms found: ${restricted[0].label}`); }
  else if (permissive.length + conditional.length === 0) { status = 'ambiguous'; reasons.push('licence evidence is present but not recognised; its terms must be read'); }
  else {
    const grantors = [...permissive, ...conditional];
    // Two different licences for the same scope that are NOT presented as alternatives are a conflict.
    // Two different licences whose scopes overlap (unspecified/page/site overlap everything except code-only vs. text; a repository licence is about the code) are a conflict.
    const overlap = (a: string, b: string) => a === b || a === 'unspecified' || b === 'unspecified' || (a !== 'code' && b !== 'code' && a !== 'repository' && b !== 'repository') || (a === 'repository' && b === 'code') || (a === 'code' && b === 'repository');
    const pool = grantors.filter((e) => e.identifier && !alt(e)); let clash: [LicenseEvidence, LicenseEvidence] | null = null;
    for (const x of pool) for (const y of pool) if (!clash && x.identifier !== y.identifier && x.identifier! < y.identifier! && overlap(x.scope, y.scope)) clash = [x, y];
    if (clash) { status = 'conflicting'; conflicts.push(`Different licences are declared for overlapping content: ${clash[0].identifier} (${clash[0].scope}) and ${clash[1].identifier} (${clash[1].scope}).`); }
    else if (permissive.length && !conditional.length) status = 'indicated-permissive'; else status = 'indicated-conditional';
    if (orGroup.length > 1) {
      const anyPermissive = orGroup.some((e) => e.indicates === 'permissive');
      reasons.push(`dual/multi-licensed (${orGroup.map((e) => e.identifier).join(' OR ')}); the owner must record which licence is relied on`);
      if (!anyPermissive && status === 'indicated-permissive') status = 'indicated-conditional';
    }
  }

  // Scope: a licence that covers only code or the repository does not necessarily cover prose documentation.
  const onlyNarrow = real.filter((e) => e.indicates !== 'restricted').every((e) => e.scope === 'code' || e.scope === 'repository');
  if ((status === 'indicated-permissive' || status === 'indicated-conditional') && onlyNarrow) {
    status = 'ambiguous'; reasons.push('the licence appears to cover code or the repository, not necessarily the documentation text that would be extracted');
  }
  // Low confidence is ambiguity, never permission.
  const topGrant = [...permissive, ...conditional].sort((a, b) => b.confidence - a.confidence)[0];
  if ((status === 'indicated-permissive' || status === 'indicated-conditional') && (!topGrant || topGrant.confidence < 0.6)) { status = 'ambiguous'; reasons.push('licence evidence is weak (low confidence)'); }
  // A terms page that was not read can still restrict reuse.
  if ((status === 'indicated-permissive' || status === 'indicated-conditional') && evidence.some((e) => e.kind === 'terms-reference')) reasons.push('a terms/legal page is linked and was not read; it may add restrictions');
  if (unknown.length && (status === 'indicated-permissive' || status === 'indicated-conditional')) reasons.push('some licensing evidence on the page was not recognised');
  void grants; void opts;

  const restrictions: Restriction[] = uniq(real.flatMap((e) => e.restrictions)).filter((r) => r !== 'unspecified-conditions' || status === 'ambiguous' || status === 'conflicting');
  if (status === 'ambiguous' || status === 'conflicting' || status === 'restricted') { if (!restrictions.includes('permission-required') && status !== 'ambiguous') restrictions.push('permission-required'); }
  let confidence = best ? best.confidence : 0.4; confidence = Math.max(0, confidence - 0.2 * conflicts.length - (status === 'ambiguous' ? 0.15 : 0));
  const label = best?.identifier ?? best?.label ?? 'unrecognised terms';
  const summary: Record<ReuseStatus, string> = {
    'no-evidence': 'No licensing evidence found.',
    'indicated-permissive': `Evidence indicates a permissive licence (${label}). This is a detection, not clearance: confirm scope and obligations before reuse.`,
    'indicated-conditional': `Evidence indicates reuse under conditions (${label}${restrictions.length ? '; ' + restrictions.join(', ') : ''}). Check that the conditions are acceptable before reuse.`,
    restricted: `Evidence indicates reuse is restricted (${label}). Permission from the rights holder would be needed.`,
    conflicting: 'Evidence conflicts. Do not reuse until the owner resolves which terms apply to which content.',
    ambiguous: 'Evidence is ambiguous or incomplete. It must not be treated as clearance.'
  };
  return { ...base, reuse: { status, summary: summary[status] }, restrictions, confidence: Math.round(confidence * 100) / 100, conflicts, reasons };
}

/** Status values for which the owner must explicitly acknowledge the ambiguity before recording any clearance. */
export const NEEDS_ACKNOWLEDGEMENT: ReuseStatus[] = ['no-evidence', 'ambiguous', 'conflicting', 'restricted'];
