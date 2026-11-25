// Built-in TypeScript modules. TypeScript is the primary language: these wrap the engine's own pure functions behind the
// registry so the orchestrator never calls them directly and an alternative implementation can be slotted in per operation.
// Their compatibility status is "verified-local": scripts/verify-workers-compat.ts proves the sources use only web-standard APIs,
// and the Node tests pass. It is NOT "verified-workers" until the project is run under wrangler/workerd (see docs).
import { RuntimeRegistry, type RuntimeModule } from './registry.ts';
import { extractSignals } from '../parse/html-signals.ts';
import { parseSitemap, parseFeed } from '../discovery/indexes.ts';
import { detectLicenseEvidence, type DetectInput } from '../license/detect.ts';
import { simhash } from '../monitor/fingerprint.ts';
import { guessLanguage } from '../discovery/relevance.ts';

const compat = { status: 'verified-local' as const, method: 'static Workers-API scan (scripts/verify-workers-compat.ts) + node:test', evidence: 'tests/engine-runtime.test.ts' };
const ts = (id: string, operations: RuntimeModule['operations'], invoke: RuntimeModule['invoke'], maxInputBytes = 2_000_000): RuntimeModule =>
  ({ id, language: 'typescript', version: '0.5.0', operations, formats: [], cost: 'light', maxInputBytes, priority: 100, compat, invoke });

export function builtinModules(): RuntimeModule[] {
  return [
    ts('ts-html-signals', ['html.signals'], (_op, i) => { const x = i as { text: string; url: string; contentType?: string }; return extractSignals(x.text, x.url, x.contentType); }),
    ts('ts-index-parse', ['sitemap.parse', 'feed.parse'], (op, i) => { const x = i as { text: string; url: string }; return op === 'sitemap.parse' ? parseSitemap(x.text, x.url) : parseFeed(x.text, x.url); }, 6_000_000),
    ts('ts-license-detect', ['license.detect'], (_op, i) => detectLicenseEvidence(i as DetectInput)),
    ts('ts-text-fingerprint', ['text.simhash', 'text.language'], (op, i) => { const x = i as { text: string; declared?: string | null }; return op === 'text.simhash' ? simhash(x.text) : guessLanguage(x.text, x.declared ?? null); })
  ];
}
export function createRegistry(now?: () => number): RuntimeRegistry { const r = new RuntimeRegistry(now); for (const m of builtinModules()) r.register(m); return r; }
