// Validation of optional-language module manifests (modules/<name>/module.json). A module is accepted only when everything the
// project requires of an extra language is present: its own dependency manifest + lockfile, build configuration and reproducible
// build instructions, a single entry point, the shared processing interface, a recorded measurable advantage over TypeScript,
// and Workers-compatibility EVIDENCE (a report file). Pure: file existence is supplied by the caller.
export type ModuleManifest = {
  id?: string; language?: string; version?: string; interface?: string; entry?: string; operations?: string[];
  artifact?: { path?: string; sha256?: string }; dependencies?: { manifest?: string; lockfile?: string };
  build?: { config?: string; instructions?: string }; workers?: { status?: string; report?: string; runtime?: string };
  advantage?: { summary?: string; benchmark?: string }; limits?: { maxInputBytes?: number };
};
const OPS = ['html.signals', 'sitemap.parse', 'feed.parse', 'license.detect', 'text.simhash', 'text.language'];
export const ALLOWED_LANGUAGES = ['rust', 'go', 'tinygo', 'c', 'cpp', 'kotlin', 'python', 'assemblyscript', 'zig'];

export function validateManifest(m: ModuleManifest, exists: (rel: string) => boolean): string[] {
  const e: string[] = []; const need = (ok: unknown, msg: string) => { if (!ok) e.push(msg); };
  need(m.id && /^[a-z0-9][a-z0-9-]{1,40}$/.test(m.id), 'id: lowercase slug required');
  need(m.language && ALLOWED_LANGUAGES.includes(m.language), `language: one of ${ALLOWED_LANGUAGES.join(', ')} (TypeScript modules live in knowledge/engine, not modules/)`);
  need(m.version && /^\d+\.\d+\.\d+$/.test(m.version), 'version: semver required');
  need(m.interface === 'rdev-module/1', 'interface: must be "rdev-module/1"');
  need(m.entry && exists(m.entry), 'entry: a single entry-point file that exists');
  need(Array.isArray(m.operations) && m.operations.length > 0 && m.operations.every((o) => OPS.includes(o)), `operations: non-empty subset of ${OPS.join(', ')}`);
  need(m.artifact?.path && exists(m.artifact.path) && /^[0-9a-f]{64}$/.test(m.artifact.sha256 || ''), 'artifact: compiled .wasm that exists + its sha256');
  need(m.dependencies?.manifest && exists(m.dependencies.manifest), 'dependencies.manifest: own dependency manifest that exists');
  need(m.dependencies?.lockfile && exists(m.dependencies.lockfile), 'dependencies.lockfile: own lockfile that exists');
  need(m.build?.config && exists(m.build.config), 'build.config: own build configuration that exists');
  need(m.build?.instructions && exists(m.build.instructions), 'build.instructions: reproducible build instructions that exist');
  need(m.workers?.status === 'verified-workers' && m.workers.report && exists(m.workers.report), 'workers: status "verified-workers" with a report file produced by running the module under workerd/wrangler');
  need(m.advantage?.summary && m.advantage.benchmark && exists(m.advantage.benchmark), 'advantage: a measurable advantage over the TypeScript implementation with a benchmark file');
  need(Number.isInteger(m.limits?.maxInputBytes) && (m.limits!.maxInputBytes as number) > 0 && (m.limits!.maxInputBytes as number) <= 8_000_000, 'limits.maxInputBytes: positive integer <= 8 MB');
  return e;
}
