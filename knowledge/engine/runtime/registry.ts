// Runtime capability registry. Describes which processing modules exist, what they can do, and whether their compatibility with
// Cloudflare Workers has been VERIFIED. The orchestrator asks for an OPERATION; the registry picks a verified module whose limits fit.
// A module that throws, times out or misbehaves is skipped (circuit breaker) and the next candidate - normally the TypeScript
// implementation - is used, so an optional module can never take the primary Worker down.
import type { Operation } from '../contracts.ts';

/** verified-workers: ran under workerd/wrangler (evidence required). verified-local: static Workers-API check + Node tests only. */
export type CompatStatus = 'verified-workers' | 'verified-local' | 'unverified' | 'failed';
export type RuntimeModule = {
  id: string; language: string; version: string; operations: Operation[]; formats: string[];
  cost: 'light' | 'medium' | 'heavy'; maxInputBytes: number; priority: number;
  compat: { status: CompatStatus; method: string; evidence: string | null };
  /** Why a non-TypeScript module is worth having (benchmark reference). Required for non-TypeScript modules. */
  advantage?: string;
  invoke(op: Operation, input: unknown): unknown | Promise<unknown>;
};
export type RunResult<T> = { ok: true; value: T; moduleId: string } | { ok: false; errors: { moduleId: string; error: string }[] };
const SELECTABLE: CompatStatus[] = ['verified-workers', 'verified-local'];

export class RuntimeRegistry {
  private modules = new Map<string, RuntimeModule>();
  private health = new Map<string, { failures: number; openUntil: number }>();
  private now: () => number; private opts: { failureThreshold: number; cooldownMs: number; timeoutMs: number };
  constructor(now: () => number = () => Date.now(), opts = { failureThreshold: 3, cooldownMs: 5 * 60_000, timeoutMs: 5_000 }) { this.now = now; this.opts = opts; }

  register(m: RuntimeModule): void {
    if (this.modules.has(m.id)) throw new Error(`runtime module "${m.id}" is already registered`);
    if (m.language !== 'typescript' && !m.advantage) throw new Error(`non-TypeScript module "${m.id}" must document a measurable advantage`);
    if (m.language !== 'typescript' && m.compat.status === 'verified-local') throw new Error(`non-TypeScript module "${m.id}" needs verified-workers compatibility evidence, not a local check`);
    this.modules.set(m.id, m);
  }
  private open(id: string) { const h = this.health.get(id); return !!h && h.openUntil > this.now(); }
  /** Candidates for an operation, best first: verified, healthy, input within limits; TypeScript wins ties. */
  select(op: Operation, ctx: { format?: string; inputBytes?: number } = {}): RuntimeModule[] {
    return [...this.modules.values()].filter((m) => m.operations.includes(op) && SELECTABLE.includes(m.compat.status) && !this.open(m.id)
      && (ctx.inputBytes === undefined || ctx.inputBytes <= m.maxInputBytes) && (!ctx.format || !m.formats.length || m.formats.some((f) => ctx.format!.includes(f))))
      .sort((a, b) => b.priority - a.priority || (a.language === 'typescript' ? -1 : 1) - (b.language === 'typescript' ? -1 : 1) || a.id.localeCompare(b.id));
  }
  async run<T>(op: Operation, input: unknown, ctx: { format?: string; inputBytes?: number } = {}): Promise<RunResult<T>> {
    const errors: { moduleId: string; error: string }[] = [];
    for (const m of this.select(op, ctx)) {
      try {
        const value = await Promise.race([Promise.resolve().then(() => m.invoke(op, input)), new Promise((_, rej) => setTimeout(() => rej(new Error('module timed out')), this.opts.timeoutMs))]);
        this.health.set(m.id, { failures: 0, openUntil: 0 }); return { ok: true, value: value as T, moduleId: m.id };
      } catch (e) {
        const h = this.health.get(m.id) ?? { failures: 0, openUntil: 0 }; h.failures++; if (h.failures >= this.opts.failureThreshold) h.openUntil = this.now() + this.opts.cooldownMs; this.health.set(m.id, h);
        errors.push({ moduleId: m.id, error: (e as Error).message });
      }
    }
    return { ok: false, errors: errors.length ? errors : [{ moduleId: '-', error: `no verified module available for ${op}` }] };
  }
  /** Owner-visible listing, including modules that are registered but NOT selectable. */
  describe() { return [...this.modules.values()].map((m) => ({ id: m.id, language: m.language, version: m.version, operations: m.operations, cost: m.cost, compat: m.compat, selectable: SELECTABLE.includes(m.compat.status), circuitOpen: this.open(m.id), advantage: m.advantage ?? null })); }
}
