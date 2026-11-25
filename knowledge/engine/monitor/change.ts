// L6 monitoring: change detection and re-check scheduling for known resources. Pure decisions; persistence is layer 7.
import type { ChangeVerdict } from '../contracts.ts';
import { hamming, hasFingerprint, NEAR_DISTANCE } from './fingerprint.ts';

export type Observation = { kind: 'ok'; contentHash: string; simhash: string; finalUrl: string; canonicalUrl: string } | { kind: 'not-modified' } | { kind: 'gone'; status: number } | { kind: 'error'; note: string };
export type Previous = { contentHash: string | null; simhash: string | null; canonicalUrl: string | null; checkFailures: number };

export function compareChange(prev: Previous | null, obs: Observation): ChangeVerdict {
  if (obs.kind === 'not-modified') return { state: 'unchanged', reason: 'server reported not modified (ETag / Last-Modified)' };
  if (obs.kind === 'gone') return { state: 'gone', reason: `HTTP ${obs.status}` };
  if (obs.kind === 'error') return { state: 'unreachable', reason: obs.note };
  if (!prev || !prev.contentHash) return { state: 'new', reason: 'no previous observation' };
  if (prev.contentHash === obs.contentHash) return { state: 'unchanged', reason: 'identical content hash' };
  if (prev.canonicalUrl && prev.canonicalUrl !== obs.canonicalUrl) return { state: 'moved', reason: `canonical URL changed to ${obs.canonicalUrl}` };
  if (prev.simhash && hasFingerprint(prev.simhash) && hasFingerprint(obs.simhash) && hamming(prev.simhash, obs.simhash) <= NEAR_DISTANCE) return { state: 'minor-change', reason: 'text differs slightly (near-identical fingerprint)' };
  return { state: 'major-change', reason: 'content differs substantially' };
}

const DAY = 86_400_000;
/** Next check: weekly when healthy, backing off exponentially (max 60 days) after failures. A source gone 3 times in a row stops being re-checked. */
export function nextCheckAt(now: number, failures: number, state: ChangeVerdict['state']): number | null {
  if (state === 'gone' && failures >= 3) return null;
  if (failures > 0) return now + Math.min(60, 2 ** failures) * DAY;
  return now + (state === 'major-change' || state === 'minor-change' ? 3 : 7) * DAY;
}
export const isDue = (nextAt: number | null, now: number) => nextAt !== null && nextAt <= now;
