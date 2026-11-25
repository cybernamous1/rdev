// Project-level guarantees for v0.5.0: layering, no dynamic code execution, no paid/AI services, no deployment side effects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers/d1-shim.ts';

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []; });
const engine = files(join(ROOT, 'knowledge', 'engine')); const v5 = [...engine, join(ROOT, 'worker', 'discovery-v5-api.ts'), join(ROOT, 'worker', 'discovery-v5-store.ts')];
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

test('nothing discovered or downloaded can be executed: no eval, Function constructor, computed dynamic import or runtime wasm compilation', () => {
  for (const f of v5) { const s = strip(readFileSync(f, 'utf8')); assert.ok(!/\beval\s*\(|new\s+Function\s*\(|\bimport\s*\(\s*[^'"\s)]|WebAssembly\.(compile|instantiate)\s*\(|\bFunction\s*\(/.test(s), f); }
});
test('engine layers use only web-standard APIs and relative imports (Workers-compatible, no new dependencies)', () => {
  for (const f of engine) for (const m of readFileSync(f, 'utf8').matchAll(/from\s+'([^']+)'/g)) assert.ok(m[1].startsWith('.'), `${f}: ${m[1]}`);
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/verify-workers-compat.ts'], { cwd: ROOT, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr + r.stdout);
});
test('layer boundaries: lower layers never import the worker, the database layer or each other\'s internals', () => {
  const rule: Record<string, RegExp> = { net: /\.\.\/(discovery|license|monitor|runtime|parse|orchestrator)/, parse: /\.\.\/(net|discovery|license|monitor|runtime|orchestrator)/, license: /\.\.\/(net|discovery|monitor|runtime|orchestrator)/, monitor: /\.\.\/(net|discovery|license|runtime|parse|orchestrator)/ };
  for (const [layer, re] of Object.entries(rule)) for (const f of engine.filter((x) => x.includes(`/engine/${layer}/`))) { const imports = [...readFileSync(f, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).filter((i) => !i.endsWith('contracts.ts') && !i.endsWith('url-policy.ts')); for (const i of imports) { if (layer === 'license' && /\.\.\/parse\/|\.\.\/contracts/.test(i)) continue; assert.ok(!re.test(i), `${f} imports ${i}`); } }
  for (const f of engine) assert.ok(!/worker\/|admin-api|discovery-api/.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')), f);
});
test('no commercial search API, paid discovery service or mandatory third-party AI API anywhere in v0.5.0 code', () => {
  for (const f of v5) assert.ok(!/api\.(openai|anthropic)|generativelanguage|cohere|bing\.com\/v7|serpapi|googleapis\.com\/customsearch|brave\.com\/res|api\.search\./i.test(strip(readFileSync(f, 'utf8'))), f);
  const hosts = new Set(v5.flatMap((f) => [...strip(readFileSync(f, 'utf8')).matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()))); const allowed = ['api.github.com', 'github.com', 'creativecommons.org', 'opensource.org', 'spdx.org', 'apache.org', 'gnu.org', 'mozilla.org', 'unlicense.org', 'owner.test'];
  for (const h of hosts) assert.ok(allowed.some((a) => h === a || h.endsWith('.' + a)) || /example\./.test(h), `unexpected host in code: ${h}`);
});
test('no v0.5.0 module writes sources, proposals or packages: approval and publication stay in the existing owner flows', () => {
  for (const f of v5) { const s = strip(readFileSync(f, 'utf8')); assert.ok(!/(INSERT|UPDATE|DELETE)\s+(OR\s+\w+\s+)?(INTO\s+|FROM\s+)?(sources|proposals|packages|package_versions|proposal_provenance|source_snapshots)\b/i.test(s), f); assert.ok(!/UPDATE\s+discovered_sources\s+SET\s+status/i.test(s), f); }
});
test('the migration and the guard scripts never touch production: no wrangler/remote execution in any script or test of v0.5.0', () => {
  for (const f of [...v5, join(ROOT, 'scripts', 'verify-modules.ts')]) assert.ok(!/wrangler\s+(d1|deploy|publish)|child_process|git\s+(push|commit)/.test(strip(readFileSync(f, 'utf8'))), f);
});
test('modules: the verifier passes with no optional-language modules, and none ship in v0.5.0', () => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/verify-modules.ts'], { cwd: ROOT, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /TypeScript only/);
  assert.deepEqual(readdirSync(join(ROOT, 'modules')).filter((x) => statSync(join(ROOT, 'modules', x)).isDirectory()), []); assert.ok(existsSync(join(ROOT, 'modules', 'README.md')));
});
test('the public learner API and learner UI contain no reference to the discovery engine', () => {
  for (const f of ['worker/public-api.ts', 'src/App.tsx']) { const p = join(ROOT, f); if (existsSync(p)) assert.ok(!/discovery|license_evidence|engine\//i.test(readFileSync(p, 'utf8')), f); }
});
