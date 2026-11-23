// Proposal stage: turn extracted entries into PENDING proposals (SQL). Nothing here publishes anything.
import type { Entry } from '../shared/rlf.ts';
import { sha256Hex } from './acquire.ts';
import type { Finding } from './duplicates.ts';

export type ProposalInput = {
  kind: 'new' | 'update' | 'retire'; entryId: string; baseVersion: number | null; title: string; rationale: string;
  payload: unknown; origin: 'bootstrap' | 'pipeline' | 'owner'; analysis: unknown;
};

const q = (v: string | number | null) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);

/** Bootstrapped content keeps its AI-assisted label, carries no review, and is not marked published. */
export const bootstrapPayload = (e: Entry): Entry => ({ ...e, status: 'ai-assisted', review: null });

export function analysisFor(entryId: string, findings: Finding[], validation: { errors: string[]; warnings: string[] }, comparedAgainst: number) {
  return { generator: 'rdev-kb 0.3.0', comparedAgainst, findings: findings.filter((f) => f.entryId === entryId), validation };
}

/** INSERT OR IGNORE keeps re-runs idempotent (UNIQUE(kind, target_entry_id, payload_hash)). Status/review fields are left to defaults. */
export async function proposalInsertSql(p: ProposalInput): Promise<string> {
  const payload = JSON.stringify(p.payload);
  const hash = await sha256Hex(payload);
  return `INSERT OR IGNORE INTO proposals (kind,target_entry_id,base_version,title,rationale,payload_json,payload_hash,analysis_json,origin) VALUES (${q(p.kind)},${q(p.entryId)},${q(p.baseVersion)},${q(p.title)},${q(p.rationale)},${q(payload)},${q(hash)},${q(JSON.stringify(p.analysis))},${q(p.origin)});`;
}
