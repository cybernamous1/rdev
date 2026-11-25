// Layer 7 helper: concise, evidence-based explanations for the Owner Console. Pure text assembly from recorded data; no model involved.
import type { LicenseAssessment } from './contracts.ts';

export type ExplainInput = {
  title: string; url: string;
  meta: { resourceType: string; language: string; languageConfidence: number; method: string; signals: string[] } | null;
  assessment: LicenseAssessment; latestReview: { decision: string; note: string } | null;
};
export type Explanation = { headline: string; whySuggested: string[]; licensing: string[]; restrictions: string[]; nextSteps: string[]; discoveryConfidence: 'high' | 'medium' | 'low' | null; licensingConfidence: number };

const RESTRICTION_TEXT: Record<string, string> = {
  attribution: 'credit must be given', 'non-commercial': 'no commercial use', 'no-derivatives': 'no adaptations or derived works', 'share-alike': 'adaptations must use the same licence',
  copyleft: 'strong copyleft: derived work must be released under the same licence', 'weak-copyleft': 'file-level copyleft', 'no-redistribution': 'no redistribution', 'no-reproduction': 'no copying or republication',
  'permission-required': 'rights-holder permission needed', 'patent-clause': 'includes a patent clause', 'personal-use-only': 'personal use only', 'educational-use-only': 'educational use only',
  'notice-required': 'licence/copyright notice must be kept', 'unspecified-conditions': 'conditions not understood: read the original terms'
};

export function explainCandidate(x: ExplainInput): Explanation {
  const m = x.meta; const a = x.assessment;
  const why = m ? [`Looks like a ${m.resourceType === 'unknown' ? 'web page' : m.resourceType} (${m.language === 'en' ? 'English' : m.language === 'unknown' ? 'language not confirmed' : 'language: ' + m.language}) found by ${m.method.replace(/-/g, ' ')}.`, ...m.signals.slice(0, 4)] : ['Found by the v0.4.0 discovery flow; no v0.5.0 signals were recorded.'];
  const lic = [a.reuse.summary, a.access.note, ...a.conflicts, ...a.reasons.map((r) => r[0].toUpperCase() + r.slice(1) + '.')];
  if (x.latestReview) lic.push(`Latest owner decision: ${x.latestReview.decision}. ${x.latestReview.note}`);
  const next: string[] = ['Approving the source does not clear its licence, and clearing the licence does not approve the source or any proposal.'];
  if (a.reuse.status === 'no-evidence') next.unshift('Scan for licence evidence, or read the site terms yourself.');
  if (a.reuse.status === 'conflicting' || a.reuse.status === 'ambiguous') next.unshift('Read the cited evidence and decide what each licence covers before any clearance.');
  const conf = m ? (m.language === 'en' && m.signals.length >= 3 ? 'high' : m.signals.length >= 2 ? 'medium' : 'low') : null;
  return { headline: `${x.title} - licensing: ${a.reuse.status.replace(/-/g, ' ')}${x.latestReview ? `; owner decision: ${x.latestReview.decision}` : '; not cleared'}`, whySuggested: why, licensing: lic, restrictions: a.restrictions.map((r) => RESTRICTION_TEXT[r] ?? r), nextSteps: next, discoveryConfidence: conf, licensingConfidence: a.confidence };
}
