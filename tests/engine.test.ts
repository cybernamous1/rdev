import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePackage, computeChecksum, type RlfPackage, type Entry } from '../shared/rlf.ts';
import { isValidVersion, compareVersions, nextVersion } from '../shared/semver.ts';
import { checkBlocks, lintLuau } from '../shared/luau.ts';
import { buildIndex, search } from '../shared/search.ts';
import { extractMarkdown, parseBlocks } from '../knowledge/extract.ts';
import { classify } from '../knowledge/classify.ts';
import { buildRelationships } from '../knowledge/relate.ts';
import { analyzeEntries, detectOutdated } from '../knowledge/duplicates.ts';
import { runPipeline } from '../scripts/lib/pipeline.ts';
import { generateBootstrap } from '../scripts/gen-bootstrap.ts';
import { writeSnapshot, checkBundle } from '../scripts/lib/bundle.ts';
import { ROOT, FIXTURES } from './helpers/sqlite.ts';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const tmp = () => mkdtempSync(join(tmpdir(), 'rdev-t-'));
const fx = await runPipeline(FIXTURES);
const pkgs = fx.packages; const all = fx.entries;

test('semantic versions: strict format, numeric ordering, next version', () => {
  for (const v of ['0.0.0', '1.0.0', '10.20.30', '123456789.0.1']) assert.ok(isValidVersion(v), v);
  for (const v of ['', '1', '1.0', '1.0.0.0', '1..0', '01.0.0', '1.00.0', '1.0.0-beta', '1.0.0+b', 'v1.0.0', '1.0.x', '1.0.0 ', '١.٠.٠', '1234567890.0.0', 12, null]) assert.ok(!isValidVersion(v), String(v));
  assert.ok(compareVersions('1.0.10', '1.0.9') > 0 && compareVersions('2.0.0', '1.99.99') > 0 && compareVersions('1.2.3', '1.2.3') === 0);
  assert.equal(nextVersion([]), '1.0.0'); assert.equal(nextVersion(['1.0.2', '1.0.9']), '1.0.10'); assert.equal(nextVersion(['1.0.0', '1.0.1'], 'minor'), '1.1.0'); assert.equal(nextVersion(['1.4.2'], 'major'), '2.0.0');
  assert.throws(() => nextVersion(['999999999.0.0'], 'major'));
  assert.throws(() => compareVersions('1.0', '1.0.0'));
});

test('fixture pipeline: 7 entries, 2 packages, no errors', () => {
  assert.equal(all.length, 7); assert.equal(pkgs.length, 2); assert.deepEqual(fx.errors, []);
});

test('packages validate; tampering, bad status rules and bad versions are caught', async () => {
  for (const p of pkgs) assert.deepEqual((await validatePackage(p)).errors, [], p.id);
  const t = clone(pkgs[0]); t.entries[0].title = 'Changed'; assert.ok((await validatePackage(t)).errors.some((e) => /Checksum mismatch/.test(e)));
  const v = clone(pkgs[0]); v.entries[0].status = 'verified'; v.checksum = await computeChecksum(v); assert.ok((await validatePackage(v)).errors.some((e) => /requires a recorded review/.test(e)));
  const bad = clone(pkgs[0]); bad.version = '01.0.0'; bad.checksum = await computeChecksum(bad); assert.ok((await validatePackage(bad)).errors.some((e) => /strict MAJOR\.MINOR\.PATCH/.test(e)));
  const cyc = clone(pkgs[0]); cyc.entries[0].prerequisites = [cyc.entries[1].id]; cyc.entries[1].prerequisites = [cyc.entries[0].id]; cyc.checksum = await computeChecksum(cyc); assert.ok((await validatePackage(cyc)).errors.some((e) => /cycle/.test(e)));
  const src = clone(pkgs[0]); src.sources[0].status = 'retrieved'; src.checksum = await computeChecksum(src); assert.ok((await validatePackage(src)).errors.some((e) => /without a date and content hash/.test(e)));
});

test('luau heuristics', () => {
  assert.equal(checkBlocks('local function f()\n  if x then\n    print("end")\n  end\nend').length, 0);
  assert.equal(checkBlocks('for i = 1, 3 do\n  print(i)\n').length, 1);
  assert.equal(checkBlocks('local s = if a then 1 else 2').length, 0);
  assert.equal(checkBlocks('repeat\n x += 1\nuntil x > 3').length, 0);
  assert.match(lintLuau('wait(1)\nInstance.new("Part", workspace)').map((f) => f.message).join('|'), /wait\(\) is deprecated.*parent to Instance\.new/);
  for (const e of all) for (const b of e.blocks) if (b.type === 'code' && b.lang === 'luau') assert.deepEqual(checkBlocks(b.code), [], e.id);
});

test('search: ranking, CamelCase parts, prefixes, no match', () => {
  const idx = buildIndex(all);
  assert.equal(search(idx, 'sorting gadgets')[0].entry.id, 'fx-beta');
  assert.equal(search(idx, 'bakery')[0].entry.id, 'fx-pro-one');
  assert.ok(search(idx, 'widg').length > 0); assert.equal(search(idx, 'zzzzqq').length, 0);
  const cc = buildIndex([{ ...all[0], id: 'camel', title: 'Using RemoteEvents safely', tags: ['remoteevent'] } as Entry]);
  assert.equal(search(cc, 'remote event')[0].entry.id, 'camel'); assert.equal(search(cc, 'remoteevent')[0].entry.id, 'camel');
});

test('extraction, classification and relationships', () => {
  const blocks = parseBlocks('Intro **bold**.\n\n## Example\n```luau\nprint(1)\n```\n\n> tip: be kind\n\n- a\n- b\n\n## Exercise\nDo it.');
  assert.deepEqual(blocks.map((b) => b.type), ['p', 'h', 'code', 'callout', 'list', 'exercise']);
  assert.throws(() => extractMarkdown('---\nid: x\n---\nbody'), /missing/);
  assert.equal(classify(all.find((e) => e.id === 'fx-alpha')!).ranked.length, 8);
  const rels = buildRelationships(all);
  assert.ok(rels.some((r) => r.type === 'prerequisite' && r.from === 'fx-beta' && r.to === 'fx-alpha'));
  assert.ok(rels.some((r) => r.type === 'next' && r.from === 'fx-alpha' && r.to === 'fx-beta'));
});

test('duplicate, conflict, prerequisite and outdated detection', () => {
  const base = all.find((e) => e.id === 'fx-alpha')!;
  const mk = (over: Partial<Entry>): Entry => ({ ...clone(base), ...over });
  const types = (f: ReturnType<typeof analyzeEntries>) => f.map((x) => x.type);
  assert.deepEqual(analyzeEntries(all), [], 'distinct fixtures raise no findings');
  assert.ok(types(analyzeEntries([base, mk({})])).includes('duplicate-id'));
  assert.ok(types(analyzeEntries([base, mk({ id: 'other' })])).includes('duplicate-title'));
  assert.ok(types(analyzeEntries([base, mk({ id: 'other', title: 'Totally different words here' })])).includes('near-duplicate-content'));
  assert.ok(types(analyzeEntries([mk({ id: 'p', prerequisites: ['ghost'] })])).includes('missing-prerequisite'));
  const a = mk({ id: 'ca', title: 'Cycle one', prerequisites: ['cb'], blocks: [{ type: 'p', text: 'unique alpha text about one thing entirely' }] });
  const b = mk({ id: 'cb', title: 'Cycle two', prerequisites: ['ca'], blocks: [{ type: 'p', text: 'something else altogether regarding another matter' }] });
  assert.ok(types(analyzeEntries([a, b])).includes('prerequisite-cycle'));
  const pub = mk({ id: 'same', title: 'Old title', path: 'Luau Programming' }); const inc = mk({ id: 'same', title: 'New thing', path: 'UI/UX Development' });
  assert.ok(types(analyzeEntries([inc], [pub])).includes('conflict-existing'));
  const out = detectOutdated(all, [{ id: 'fx-source-a', contentHash: 'aaa' }], [{ id: 'fx-source-a', contentHash: 'bbb' }]);
  assert.equal(out.length, all.length); assert.equal(out[0].type, 'outdated-source');
  assert.equal(detectOutdated(all, [{ id: 'fx-source-a', contentHash: 'aaa' }], [{ id: 'fx-source-a', contentHash: 'aaa' }]).length, 0);
});

test('bootstrap generator: pending/AI-assisted/unreviewed only, deterministic, path-independent, no absolute paths', async () => {
  const a = tmp(), b = tmp(), copy = join(tmp(), 'elsewhere-content'); cpSync(FIXTURES, copy, { recursive: true });
  const r1 = await generateBootstrap({ content: FIXTURES, out: a }); const r2 = await generateBootstrap({ content: copy, out: b });
  assert.ok(r1.ok && r2.ok && r1.count === 7);
  assert.deepEqual(readdirSync(a), readdirSync(b));
  for (const f of readdirSync(a)) { const sql = readFileSync(join(a, f), 'utf8'); assert.equal(sql, readFileSync(join(b, f), 'utf8')); assert.ok(!/(\/home\/|\/tmp\/|\/mnt\/|[A-Z]:\\)/.test(sql), f + ' has no absolute path'); if (f !== '00-sources.sql') { assert.ok(!/INSERT (OR \w+ )?INTO (entries|entry_versions|package_versions|publications)/.test(sql)); assert.ok(sql.includes("'bootstrap'")); } }
  const sql = readFileSync(join(a, '02-luau.sql'), 'utf8');
  assert.ok(sql.includes('\\"status\\":\\"ai-assisted\\"') || sql.includes('"status":"ai-assisted"')); assert.ok(sql.includes('"review":null'));
  assert.ok(!sql.includes('"status":"published"'));
});

test('snapshot: only approved packages may be bundled', async () => {
  const dir = tmp(); const out = join(tmp(), 'packages.json');
  const published = clone(pkgs[0]); for (const e of published.entries) e.status = 'published'; published.checksum = await computeChecksum(published);
  writeFileSync(join(dir, 'rdev-luau.json'), JSON.stringify(published));
  let r = await writeSnapshot(dir, out); assert.ok(r.ok && r.count === 1); assert.equal(JSON.parse(readFileSync(out, 'utf8')).length, 1);
  const bad = clone(published); bad.entries[0].status = 'ai-assisted'; bad.checksum = await computeChecksum(bad); writeFileSync(join(dir, 'rdev-luau.json'), JSON.stringify(bad));
  r = await writeSnapshot(dir, out); assert.ok(!r.ok && r.errors.some((e) => /only published or verified/.test(e)));
  writeFileSync(join(dir, 'rdev-luau.json'), JSON.stringify({ ...published, entries: [] })); r = await writeSnapshot(dir, out); assert.ok(!r.ok, 'checksum no longer matches');
  r = await writeSnapshot(null, out); assert.ok(r.ok && r.count === 0); assert.equal(readFileSync(out, 'utf8'), '[]');
});

test('bundle guard: detects unapproved content, markers and forbidden files', async () => {
  const snap = join(tmp(), 'snap.json'); writeFileSync(snap, '[]');
  const dist = tmp(); mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<html>RDev Academy</html>'); writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("hello")');
  let r = checkBundle({ distDir: dist, snapshotFile: snap, contentDir: FIXTURES }); assert.ok(r.ok, r.errors.join(';')); assert.ok(r.bannedChecked >= 14);
  writeFileSync(join(dist, 'assets', 'leak.js'), 'var t="Fixture beta: sorting gadgets"'); r = checkBundle({ distDir: dist, snapshotFile: snap, contentDir: FIXTURES }); assert.ok(!r.ok && r.errors.some((e) => /unpublished title/.test(e)));
  writeFileSync(join(dist, 'assets', 'leak.js'), 'var i="fx-gamma"'); r = checkBundle({ distDir: dist, snapshotFile: snap, contentDir: FIXTURES }); assert.ok(!r.ok && r.errors.some((e) => /unpublished id/.test(e)));
  writeFileSync(join(dist, 'assets', 'leak.js'), '{"origin":"bootstrap"}'); assert.ok(!checkBundle({ distDir: dist, snapshotFile: snap, contentDir: FIXTURES }).ok);
  writeFileSync(join(dist, 'assets', 'leak.js'), 'ok'); writeFileSync(join(dist, 'x.rlf.json'), '{}'); assert.ok(checkBundle({ distDir: dist, snapshotFile: snap, contentDir: FIXTURES }).errors.some((e) => /Forbidden file/.test(e)));
  // an APPROVED entry in the snapshot is allowed to appear
  const dist2 = tmp(); const approved = clone(pkgs[0]); for (const e of approved.entries) e.status = 'published'; const snap2 = join(tmp(), 's.json'); writeFileSync(snap2, JSON.stringify([approved]));
  writeFileSync(join(dist2, 'a.js'), 'var t="Fixture alpha: counting widgets"'); assert.ok(checkBundle({ distDir: dist2, snapshotFile: snap2, contentDir: FIXTURES }).ok);
  const unapproved = clone(pkgs[0]); for (const e of unapproved.entries) e.status = 'ai-assisted'; const snap3 = join(tmp(), 's3.json'); writeFileSync(snap3, JSON.stringify([unapproved])); assert.ok(!checkBundle({ distDir: dist2, snapshotFile: snap3, contentDir: FIXTURES }).ok, 'ai-assisted snapshot entries are refused');
});

test('SHIPPED public snapshot contains only approved content (Option A)', () => {
  const snap = JSON.parse(readFileSync(join(ROOT, 'src', 'generated', 'packages.json'), 'utf8')) as RlfPackage[];
  assert.ok(Array.isArray(snap)); for (const p of snap) for (const e of p.entries) assert.ok(['published', 'verified'].includes(e.status), e.id);
  assert.deepEqual(snap, [], 'until the owner publishes, the bundled snapshot is empty');
});

test('private content (only when present): 26 lessons + 10 references pass the pipeline', { skip: !existsSync(join(ROOT, 'content', 'lessons')) }, async () => {
  const r = await runPipeline(join(ROOT, 'content'));
  assert.deepEqual(r.errors, []); assert.equal(r.entries.filter((e) => e.kind === 'lesson').length, 26); assert.equal(r.entries.filter((e) => e.kind === 'reference').length, 10);
  assert.equal(r.findings.filter((f) => f.severity === 'block').length, 0);
});
