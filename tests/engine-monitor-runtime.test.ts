import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simhash, hamming, bands, hasFingerprint, sha256Hex, NEAR_DISTANCE } from '../knowledge/engine/monitor/fingerprint.ts';
import { compareChange, nextCheckAt, isDue } from '../knowledge/engine/monitor/change.ts';
import { RuntimeRegistry, type RuntimeModule } from '../knowledge/engine/runtime/registry.ts';
import { createRegistry } from '../knowledge/engine/runtime/builtin.ts';
import { wasmRuntimeModule } from '../knowledge/engine/runtime/wasm-adapter.ts';
import { validateManifest } from '../knowledge/engine/runtime/manifest.ts';

const words = (n: number, seed = 1) => { let x = seed; const w: string[] = []; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; w.push('w' + (x % 400)); } return w; };
test('simhash: identical text identical, light edit near, unrelated far; short text has no fingerprint', () => {
  const a = words(600).join(' '); const b = words(600).map((w, i) => (i === 300 ? 'edited' : w)).join(' '); const c = words(600, 99).join(' ');
  assert.equal(simhash(a), simhash(a)); assert.ok(hamming(simhash(a), simhash(b)) <= NEAR_DISTANCE); assert.ok(hamming(simhash(a), simhash(c)) > 12);
  assert.equal(hasFingerprint(simhash('too short')), false); assert.equal(simhash(a).length, 16);
});
test('banded lookup finds every pair within the near distance (pigeonhole guarantee)', () => {
  let x = 7; const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x; };
  for (let t = 0; t < 300; t++) {
    let h = BigInt('0x' + [...Array(4)].map(() => (rnd() & 0xffff).toString(16).padStart(4, '0')).join(''));
    let g = h; for (let k = 0; k < NEAR_DISTANCE; k++) g ^= 1n << BigInt(rnd() % 64);
    const A = h.toString(16).padStart(16, '0'); const B = g.toString(16).padStart(16, '0'); assert.ok(hamming(A, B) <= NEAR_DISTANCE);
    assert.ok(bands(A).some((v, i) => v === bands(B)[i]), `${A} ${B}`);
  }
});
test('change detection: unchanged / minor / major / moved / gone / unreachable and re-check backoff', () => {
  const t = words(2000).join(' '); const sim = simhash(t); const prev = { contentHash: 'h1', simhash: sim, canonicalUrl: 'https://a.example.com/x', checkFailures: 0 };
  const ok = (hash: string, s: string, canonical = 'https://a.example.com/x') => ({ kind: 'ok' as const, contentHash: hash, simhash: s, finalUrl: canonical, canonicalUrl: canonical });
  assert.equal(compareChange(null, ok('h', sim)).state, 'new'); assert.equal(compareChange(prev, ok('h1', sim)).state, 'unchanged'); assert.equal(compareChange(prev, { kind: 'not-modified' }).state, 'unchanged');
  assert.equal(compareChange(prev, ok('h2', simhash(words(2000).map((w, i) => (i === 10 ? 'q' : w)).join(' ')))).state, 'minor-change'); assert.equal(compareChange(prev, ok('h3', simhash(words(2000, 5).join(' ')))).state, 'major-change');
  assert.equal(compareChange(prev, ok('h4', sim, 'https://a.example.com/new')).state, 'moved'); assert.equal(compareChange(prev, { kind: 'gone', status: 410 }).state, 'gone'); assert.equal(compareChange(prev, { kind: 'error', note: 'x' }).state, 'unreachable');
  const now = 1_000; assert.equal(nextCheckAt(now, 0, 'unchanged'), now + 7 * 86_400_000); assert.equal(nextCheckAt(now, 3, 'unreachable'), now + 8 * 86_400_000); assert.equal(nextCheckAt(now, 9, 'unreachable'), now + 60 * 86_400_000); assert.equal(nextCheckAt(now, 3, 'gone'), null);
  assert.ok(isDue(now, now + 1)); assert.ok(!isDue(null, now));
});
test('sha256Hex is the standard digest', async () => { assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); });

const mod = (o: Partial<RuntimeModule> & { id: string }): RuntimeModule => ({ language: 'typescript', version: '1', operations: ['text.simhash'], formats: [], cost: 'light', maxInputBytes: 1000, priority: 100, compat: { status: 'verified-local', method: 't', evidence: null }, invoke: () => 'ok', ...o });
test('registry: only verified modules are selectable; unverified are listed but never run; input limits respected', async () => {
  const r = new RuntimeRegistry(); r.register(mod({ id: 'ts-a' })); r.register(mod({ id: 'ts-unverified', compat: { status: 'unverified', method: '-', evidence: null } })); r.register(mod({ id: 'ts-small', maxInputBytes: 10 }));
  assert.deepEqual(r.select('text.simhash', { inputBytes: 500 }).map((m) => m.id), ['ts-a']); assert.deepEqual(r.select('text.simhash', { inputBytes: 5 }).map((m) => m.id).sort(), ['ts-a', 'ts-small']);
  assert.equal(r.describe().find((d) => d.id === 'ts-unverified')!.selectable, false); assert.equal((await r.run('html.signals', {})).ok, false);
});
test('registry: a non-TypeScript module needs a documented advantage and Workers verification (a local check is not enough)', () => {
  const r = new RuntimeRegistry();
  assert.throws(() => r.register(mod({ id: 'rs-1', language: 'rust', compat: { status: 'verified-workers', method: 'wrangler', evidence: 'r.md' } })), /advantage/);
  assert.throws(() => r.register(mod({ id: 'rs-2', language: 'rust', advantage: '5x', compat: { status: 'verified-local', method: 'node', evidence: null } })), /verified-workers/);
  r.register(mod({ id: 'rs-3', language: 'rust', advantage: '5x faster, see benchmark.md', priority: 100, compat: { status: 'verified-workers', method: 'wrangler', evidence: 'r.md' } })); r.register(mod({ id: 'ts-x' }));
  assert.equal(r.select('text.simhash')[0].id, 'ts-x', 'TypeScript wins ties'); assert.throws(() => r.register(mod({ id: 'ts-x' })), /already registered/);
});
test('registry: a failing or hanging module is isolated, the next candidate answers, and a circuit breaker stops retrying it', async () => {
  let t = 0; const r = new RuntimeRegistry(() => t, { failureThreshold: 2, cooldownMs: 1000, timeoutMs: 30 }); let calls = 0;
  r.register(mod({ id: 'bad', priority: 200, language: 'rust', advantage: 'x', compat: { status: 'verified-workers', method: 'w', evidence: 'e' }, invoke: () => { calls++; throw new Error('boom'); } })); r.register(mod({ id: 'good' }));
  const a = await r.run<string>('text.simhash', 1); assert.ok(a.ok && a.moduleId === 'good'); await r.run('text.simhash', 1); assert.equal(calls, 2);
  await r.run('text.simhash', 1); assert.equal(calls, 2, 'circuit open: bad module no longer called'); assert.equal(r.describe().find((d) => d.id === 'bad')!.circuitOpen, true);
  t = 5000; await r.run('text.simhash', 1); assert.equal(calls, 3, 'half-open after cooldown');
  const h = new RuntimeRegistry(() => 0, { failureThreshold: 3, cooldownMs: 1, timeoutMs: 20 }); h.register(mod({ id: 'slow', invoke: () => new Promise(() => {}) })); const res = await h.run('text.simhash', 1); assert.ok(!res.ok); assert.match((res as any).errors[0].error, /timed out/);
});
test('built-in TypeScript modules cover every operation and answer through the registry', async () => {
  const r = createRegistry(); const ops = ['html.signals', 'sitemap.parse', 'feed.parse', 'license.detect', 'text.simhash', 'text.language'] as const;
  for (const op of ops) assert.ok(r.select(op).length > 0, op); assert.ok(r.describe().every((m) => m.language === 'typescript' && m.compat.status === 'verified-local'));
  const s = await r.run<any>('html.signals', { text: '<html><title>T</title></html>', url: 'https://x.example.com/' }); assert.ok(s.ok && s.value.title === 'T');
});

// ---- WebAssembly adapter: a hand-assembled test module (echo) proves the rdev-module/1 contract without any toolchain ----
const leb = (n: number) => { const o: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sec = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
const str = (s: string) => [...leb(s.length), ...[...s].map((c) => c.charCodeAt(0))];
function wasm(opts: { trap?: boolean; noMemory?: boolean } = {}) {
  const types = sec(1, [3, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 1, 0x7f]);
  const funcs = sec(3, [3, 0, 1, 2]); const mem = sec(5, [1, 0, 1]);
  const globals = sec(6, [2, 0x7f, 1, 0x41, 0x80, 0x08, 0x0b, 0x7f, 1, 0x41, 0x00, 0x0b]);
  const exp = sec(7, [opts.noMemory ? 3 : 4, ...(opts.noMemory ? [] : [...str('memory'), 2, 0]), ...str('alloc'), 0, 0, ...str('process'), 0, 1, ...str('output_ptr'), 0, 2]);
  const alloc = [0, 0x23, 0, 0x23, 0, 0x20, 0, 0x6a, 0x24, 0, 0x0b]; const proc = opts.trap ? [0, 0x00, 0x0b] : [0, 0x20, 0, 0x24, 1, 0x20, 1, 0x0b]; const outp = [0, 0x23, 1, 0x0b];
  const code = sec(10, [3, ...leb(alloc.length), ...alloc, ...leb(proc.length), ...proc, ...leb(outp.length), ...outp]);
  return new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...types, ...funcs, ...mem, ...globals, ...exp, ...code]));
}
const desc = { id: 'echo-wasm', language: 'rust', version: '0.0.1', operations: ['text.simhash' as const], maxInputBytes: 4096, advantage: 'test fixture only', compat: { status: 'verified-workers' as const, method: 'test fixture', evidence: null } };
test('wasm adapter: a compiled module is driven through the rdev-module/1 contract (fresh instance per call, no imports)', async () => {
  const m = wasmRuntimeModule(desc, wasm()); assert.deepEqual(await m.invoke('text.simhash', 'abc'), { op: 'text.simhash', input: 'abc' }); assert.deepEqual(await m.invoke('text.simhash', { a: [1, 2] }), { op: 'text.simhash', input: { a: [1, 2] } });
  assert.throws(() => m.invoke('text.simhash', 'x'.repeat(5000)), /exceeds the module limit/);
});
test('wasm adapter: traps and contract violations become ordinary errors the registry isolates, with TypeScript answering instead', async () => {
  assert.throws(() => wasmRuntimeModule(desc, wasm({ trap: true })).invoke('text.simhash', 1)); assert.throws(() => wasmRuntimeModule(desc, wasm({ noMemory: true })).invoke('text.simhash', 1), /rdev-module\/1/);
  const r = new RuntimeRegistry(); r.register({ ...wasmRuntimeModule(desc, wasm({ trap: true })), priority: 500 }); r.register(mod({ id: 'ts-fallback', invoke: () => 'from-ts' }));
  const res = await r.run<string>('text.simhash', 'abc'); assert.ok(res.ok && res.value === 'from-ts');
});
test('manifest validator requires own lockfile, build config + instructions, entry, interface, Workers evidence and a benchmark', () => {
  const files = new Set(['src/lib.rs', 'Cargo.toml', 'Cargo.lock', '.cargo/config.toml', 'BUILD.md', 'dist/m.wasm', 'workers-report.md', 'benchmark.md']); const ex = (p: string) => files.has(p);
  const good = { id: 'html-fast', language: 'rust', version: '0.1.0', interface: 'rdev-module/1', entry: 'src/lib.rs', operations: ['html.signals'], artifact: { path: 'dist/m.wasm', sha256: 'a'.repeat(64) }, dependencies: { manifest: 'Cargo.toml', lockfile: 'Cargo.lock' }, build: { config: '.cargo/config.toml', instructions: 'BUILD.md' }, workers: { status: 'verified-workers', report: 'workers-report.md' }, advantage: { summary: '6x faster on 1 MB pages', benchmark: 'benchmark.md' }, limits: { maxInputBytes: 2_000_000 } };
  assert.deepEqual(validateManifest(good, ex), []);
  for (const [k, v] of [['dependencies', { manifest: 'Cargo.toml' }], ['workers', { status: 'unverified' }], ['advantage', { summary: 'x' }], ['build', { config: 'nope' }], ['interface', 'other'], ['language', 'typescript']] as const) assert.ok(validateManifest({ ...good, [k]: v } as any, ex).length > 0, k);
  assert.ok(validateManifest({}, ex).length >= 10);
});
