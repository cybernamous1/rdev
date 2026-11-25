import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSignals } from '../knowledge/engine/parse/html-signals.ts';
import { detectLicenseEvidence, parseSpdxExpression } from '../knowledge/engine/license/detect.ts';
import { assessLicense } from '../knowledge/engine/license/assess.ts';
import { parseCcUrl, parseCcName, lookupLicense, lookupLicenseUrl } from '../knowledge/engine/license/catalog.ts';

const URL_ = 'https://docs.example.com/page'; const AT = '2026-11-24T00:00:00.000Z';
const run = (html: string, github?: any) => detectLicenseEvidence({ pageUrl: URL_, signals: extractSignals(html, URL_), fetchedAt: AT, contentHash: 'h', github });
const doc = (body: string, head = '') => `<html lang="en"><head><title>T</title>${head}</head><body><p>${'The guide explains how to use the code. '.repeat(30)}</p>${body}</body></html>`;
const assess = (html: string, gh?: any) => assessLicense(run(html, gh));

test('Creative Commons: URL, name and short forms give elements, version and restrictions', () => {
  const c = parseCcUrl('https://creativecommons.org/licenses/by-nc-sa/4.0/')!; assert.equal((c as any).id, 'CC-BY-NC-SA-4.0'); assert.deepEqual([...c.restrictions].sort(), ['attribution', 'non-commercial', 'share-alike']); assert.equal(c.indicates, 'conditional');
  assert.equal((parseCcUrl('https://creativecommons.org/publicdomain/zero/1.0/') as any).kind, 'public-domain'); assert.equal((parseCcUrl('https://creativecommons.org/licenses/by/3.0/de/') as any).jurisdiction, 'de');
  assert.equal(parseCcName('Creative Commons Attribution-NoDerivatives 4.0 International')!.id, 'CC-BY-ND-4.0'); assert.equal(parseCcName('CC BY-SA 3.0')!.id, 'CC-BY-SA-3.0'); assert.equal(parseCcUrl('https://example.com/licenses/by/4.0/'), null);
});
test('catalogue is a hint, not a closed list: unknown ids and URLs are kept as unknown evidence, never permissive', () => {
  assert.equal(lookupLicense('Apache License 2.0')!.id, 'Apache-2.0'); assert.equal(lookupLicenseUrl('https://opensource.org/licenses/MIT')!.id, 'MIT'); assert.equal(lookupLicense('Acme-Shared-Source-1.2'), null);
  const ev = run(doc('<p>SPDX-License-Identifier: Acme-Shared-Source-1.2</p>')); const e = ev.find((x) => x.identifier === 'Acme-Shared-Source-1.2')!;
  assert.equal(e.kind, 'unknown'); assert.equal(e.indicates, 'unknown'); assert.notEqual(assessLicense(ev).reuse.status, 'indicated-permissive');
  const u = run(doc('', '<link rel="license" href="https://publisher.example.org/our-own-licence">'))[0]; assert.equal(u.kind, 'unknown'); assert.equal(u.licenseUrl, 'https://publisher.example.org/our-own-licence');
});
test('permissive evidence: rel=license CC BY is indicated-permissive, not cleared, with exact URL, excerpt, timestamp, scope and hash preserved', () => {
  const ev = run(doc('', '<link rel="license" href="https://creativecommons.org/licenses/by/4.0/">')); const e = ev[0];
  assert.equal(e.identifier, 'CC-BY-4.0'); assert.equal(e.evidenceUrl, URL_); assert.equal(e.licenseUrl, 'https://creativecommons.org/licenses/by/4.0'); assert.equal(e.detectedAt, AT); assert.equal(e.contentHash, 'h'); assert.ok(e.excerpt.length > 0); assert.ok(e.scope);
  const a = assessLicense(ev); assert.equal(a.reuse.status, 'indicated-permissive'); assert.equal(a.clearance, 'not-cleared'); assert.equal(a.requiresOwnerDecision, true); assert.ok(a.restrictions.includes('attribution'));
});
test('free access is reported separately from permission to reuse', () => {
  const a = assess(doc('<p>Welcome, everything here is free to read.</p>')); assert.equal(a.access.publiclyReadable, true); assert.match(a.access.note, /not permission/); assert.equal(a.reuse.status, 'no-evidence'); assert.ok(a.restrictions.includes('permission-required'));
});
test('public domain, custom permission, proprietary, all-rights-reserved and personal-use wording', () => {
  assert.equal(assess(doc('<p>This tutorial is released into the public domain.</p>')).reuse.status, 'indicated-permissive');
  const custom = assess(doc('<p>Permission is granted to copy these lessons for classroom use, provided credit is given.</p>')); assert.equal(custom.reuse.status, 'ambiguous');
  const prop = assess(doc('<p>No part of this site may be reproduced or redistributed without written permission.</p>')); assert.equal(prop.reuse.status, 'restricted'); assert.ok(prop.restrictions.includes('no-reproduction'));
  assert.equal(assess(doc('<footer>Copyright 2025 Acme. All rights reserved.</footer>')).reuse.status, 'restricted');
  assert.ok(assess(doc('<p>Content is for personal use only.</p>')).restrictions.includes('personal-use-only'));
});
test('copyright notice and terms links alone grant nothing', () => {
  const a = assess(doc('<footer>&copy; 2025 Example Learning <a href="/terms">Terms of use</a></footer>')); assert.equal(a.reuse.status, 'no-evidence'); assert.notEqual(a.reuse.status, 'indicated-permissive');
});
test('conflicts: open licence + "all rights reserved" / no-reproduction is conflicting and lowers confidence; never permissive', () => {
  const a = assess(doc('<p>Content licensed under CC BY 4.0.</p><footer>All rights reserved.</footer>')); assert.equal(a.reuse.status, 'conflicting'); assert.ok(a.conflicts.length > 0);
  const b = assess(doc('<p>Licensed under the MIT license.</p><p>No part may be reproduced without permission.</p>')); assert.equal(b.reuse.status, 'conflicting');
  const two = assess(doc('<p>The text is licensed under CC BY 4.0.</p>', '<link rel="license" href="https://creativecommons.org/licenses/by-nc/4.0/">')); assert.equal(two.reuse.status, 'conflicting');
});
test('dual licensing: OR is a choice (recorded, flagged), AND applies all; expression parsing', () => {
  assert.deepEqual(parseSpdxExpression('MIT OR Apache-2.0'), { ids: ['MIT', 'Apache-2.0'], op: 'OR' }); assert.deepEqual(parseSpdxExpression('(GPL-2.0-only AND MIT)').op, 'AND'); assert.equal(parseSpdxExpression('MIT/Apache-2.0').op, 'OR');
  const a = assess(doc('<p>SPDX-License-Identifier: MIT OR Apache-2.0</p>')); assert.equal(a.reuse.status, 'indicated-permissive'); assert.ok(a.reasons.some((r) => /dual/.test(r)));
  const t = assess(doc('<p>This project is dual licensed under MIT and Apache-2.0.</p>')); assert.ok(['indicated-permissive', 'ambiguous'].includes(t.reuse.status));
  const gpl = assess(doc('<p>SPDX-License-Identifier: GPL-3.0-only</p>')); assert.equal(gpl.reuse.status, 'indicated-conditional'); assert.ok(gpl.restrictions.includes('copyleft'));
});
test('scope: a code-only or repository-only licence is ambiguous for documentation text; code-vs-content split is visible', () => {
  assert.equal(assess(doc('<p>The code samples are licensed under the MIT license.</p>')).reuse.status, 'ambiguous');
  const gh = assess(doc(''), { license: { spdx_id: 'MIT', name: 'MIT License' } }); assert.equal(gh.reuse.status, 'ambiguous'); assert.ok(gh.reasons.some((r) => /code or the repository/.test(r)));
  const split = run(doc('<p>The code samples are licensed under the MIT license. The documentation text is licensed under CC BY 4.0.</p>')); assert.ok(split.some((e) => e.scope === 'code') && split.some((e) => e.scope === 'content'));
  assert.equal(assessLicense(split).reuse.status, 'indicated-permissive');
});
test('GitHub repository without a detectable licence is restricted/unknown, never permissive', () => {
  assert.equal(assess(doc(''), { license: null }).reuse.status, 'restricted'); assert.notEqual(assess(doc(''), { license: { spdx_id: 'NOASSERTION' } }).reuse.status, 'indicated-permissive');
});
test('a tutorial that QUOTES a licence inside a code block is not mistaken for the page licence', () => {
  const a = assess(doc('<pre><code>Licensed under the MIT license. SPDX-License-Identifier: MIT</code></pre>')); assert.equal(a.reuse.status, 'no-evidence');
});
test('low-confidence and unrecognised statements are ambiguous, never permissive', () => {
  assert.equal(assess(doc('<p>This text is licensed under the Friendly Sharing Terms v2.</p>')).reuse.status, 'ambiguous');
  assert.equal(assess(doc('', '<meta name="dc.rights" content="Some rights reserved by the author">')).reuse.status, 'no-evidence');
});
test('every assessment, whatever the evidence, is not-cleared and requires an owner decision', () => {
  for (const body of ['', '<p>Released into the public domain.</p>', '<p>Licensed under the MIT license.</p>', '<footer>All rights reserved</footer>']) { const a = assess(doc(body)); assert.equal(a.clearance, 'not-cleared'); assert.equal(a.requiresOwnerDecision, true); }
});
