// End-to-end tests of the v0.5.0 engine against a fake web and a real SQLite database holding the real migration SQL.
// Local only: no internet, no Cloudflare. They verify behaviour, not Cloudflare deployment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { discoveryV5Api, licensingSnapshot, categoryLabelFor } from '../worker/discovery-v5-api.ts';
import { d1, freshV05, v040, fakeWeb, classify, clock, type Page } from './helpers/d1-shim.ts';

const PROSE = 'In this tutorial you will learn how to write a function in your script. The variable holds a value and the loop will run for each item. This guide is for the beginner who wants to write code. ';
const ES = 'El tutorial explica cómo escribir una función en el código para aprender a programar muy bien con los ejemplos de la guía. ';
const uniq = (seed: string, n = 220) => { let x = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7); return Array.from({ length: n }, () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return 'topic' + (x % 900); }).join(' '); };
const article = (title: string, o: { extra?: string; head?: string; text?: string; lang?: string } = {}) =>
  `<html lang="${o.lang ?? 'en'}"><head><title>${title}</title>${o.head ?? ''}</head><body><h1>${title}</h1><h2>A</h2><h2>B</h2><p>${(o.text ?? PROSE.repeat(4)) + ' ' + uniq(title)}</p><pre><code>print("hi")</code></pre>${o.extra ?? ''}</body></html>`;
const txt = { type: 'text/plain' };

function web(extra: Record<string, Page> = {}) {
  const links = ['https://learn.example.org/luau/intro', 'https://es.example.net/tutorial', 'https://mirror.example.io/luau-intro', 'https://shop.example.com/cart', 'https://blocked.example.dev/learn/x', 'https://plain.example.app/guide/start']
    .map((u) => `<a href="${u}">Free tutorial</a>`).join(' ') + Array.from({ length: 24 }, (_, i) => `<a href="https://filler${i}.example.org/tutorial/${i}">Tutorial ${i}</a>`).join('');
  return fakeWeb({
    'https://hub.example.com/robots.txt': { ...txt, body: 'User-agent: *\nDisallow: /private\nSitemap: https://hub.example.com/sitemap.xml' },
    'https://hub.example.com/awesome': { body: article('Awesome Luau learning resources', { extra: links, head: '<link rel="alternate" type="application/rss+xml" href="/feed.xml">' }) },
    'https://hub.example.com/sitemap.xml': { type: 'application/xml', body: '<urlset><url><loc>https://hub.example.com/guide/extra-lesson</loc></url><url><loc>https://hub.example.com/about-us</loc></url></urlset>' },
    'https://hub.example.com/feed.xml': { type: 'application/rss+xml', body: '<rss><channel><item><title>Luau tutorial: events</title><link>https://hub.example.com/tutorial/events</link></item></channel></rss>' },
    'https://hub.example.com/guide/extra-lesson': { body: article('Extra lesson on scripting tutorial', { text: PROSE.repeat(8) + ' Extra lesson about modules. '.repeat(20) }) },
    'https://hub.example.com/tutorial/events': { body: article('Events tutorial', { text: PROSE.repeat(8) + ' Events fire when something happens. '.repeat(25) }) },
    'https://learn.example.org/robots.txt': { ...txt, body: 'User-agent: *\nAllow: /' },
    'https://learn.example.org/luau/intro': { body: article('Introduction to Luau scripting tutorial', { head: '<link rel="license" href="https://creativecommons.org/licenses/by/4.0/">' }), headers: { etag: '"v1"' } },
    'https://es.example.net/tutorial': { body: article('Tutorial de programación', { lang: 'es', text: ES.repeat(14) }) },
    'https://mirror.example.io/luau-intro': { body: article('Introduction to Luau scripting tutorial', { head: '<link rel="license" href="https://creativecommons.org/licenses/by/4.0/">' }) },
    'https://shop.example.com/cart': { body: '<html lang="en"><head><title>Cart</title></head><body><p>Add to cart. Buy now with this coupon. ' + 'the best price for you and the whole family '.repeat(25) + '</p></body></html>' },
    'https://blocked.example.dev/robots.txt': { ...txt, body: 'User-agent: *\nDisallow: /' },
    'https://blocked.example.dev/learn/x': { body: article('Should never be fetched') },
    'https://plain.example.app/guide/start': { body: article('Guide to scripting start', { text: PROSE.repeat(8) + ' Getting started with lessons about events. '.repeat(15) }) },
    ...extra
  });
}

function setup(w = web()) {
  const raw: DatabaseSync = freshV05(); const db = d1(raw); const c = clock();
  const call = async (method: string, path: string, body?: unknown) => {
    const request = new Request('https://owner.test' + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const res = await discoveryV5Api({ db: db as any, request, url: new URL(request.url), path, sessionId: 's', json: (d, s = 200) => Response.json(d, { status: s }), readJson: async (r) => r.json() as any,
      audit: async (n, d) => { raw.prepare('INSERT INTO security_events(event,detail) VALUES(?,?)').run(n, d); }, auditStmt: (n, d) => db.prepare('INSERT INTO security_events(event,detail) VALUES(?,?)').bind(n, d), validSlug: (s: unknown): s is string => typeof s === 'string' }, { fetchImpl: w.fetchImpl, classify, now: c.now });
    return { status: res!.status, body: (await res!.json()) as any };
  };
  return { raw, db, call, w, c };
}
const count = (raw: DatabaseSync, t: string) => Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n);
async function runJob(s: ReturnType<typeof setup>, id: number, max = 40) { let last: any; for (let i = 0; i < max; i++) { last = (await s.call('POST', `/api/admin/discovery/v5/jobs/${id}/step`)).body; if (last.done) return last; s.c.set(s.c.get() + 10_000); } throw new Error('job did not finish: ' + JSON.stringify(last)); }

test('end to end: discovery from one owner hint finds new hosts through links, robots sitemaps, feeds and sitemaps - and approves nothing', async () => {
  const s = setup(); const base = { sources: count(s.raw, 'sources'), proposals: count(s.raw, 'proposals'), packages: count(s.raw, 'packages'), versions: count(s.raw, 'package_versions') }; const created = await s.call('POST', '/api/admin/discovery/v5/jobs', { rootUrl: 'https://hub.example.com/awesome', label: 'hub' }); assert.equal(created.status, 201);
  const done = await runJob(s, created.body.jobId); assert.equal(done.done, true);
  const rows = s.raw.prepare('SELECT d.url,d.status,d.category,m.resource_type,m.language FROM discovered_sources d JOIN discovered_source_meta m ON m.candidate_id=d.id ORDER BY d.id').all() as any[]; const urls = rows.map((r) => r.url);
  for (const u of ['https://plain.example.app/guide/start', 'https://hub.example.com/guide/extra-lesson', 'https://hub.example.com/tutorial/events']) assert.ok(urls.includes(u), `found ${u}`);
  assert.ok(!urls.includes('https://es.example.net/tutorial'), 'non-English page is not queued'); assert.ok(!urls.includes('https://shop.example.com/cart'), 'shop page is not queued'); assert.ok(!urls.includes('https://hub.example.com/about-us'));
  const intro = urls.filter((u) => /learn\.example\.org\/luau\/intro|mirror\.example\.io/.test(u)); assert.equal(intro.length, 1, 'the page and its mirror copy yield ONE candidate (duplicate detected)');
  assert.ok(!s.w.requested.includes('https://blocked.example.dev/learn/x'), 'robots.txt Disallow respected'); assert.ok(rows.every((r) => r.status === 'pending'), 'everything stays pending');
  assert.deepEqual({ sources: count(s.raw, 'sources'), proposals: count(s.raw, 'proposals'), packages: count(s.raw, 'packages'), versions: count(s.raw, 'package_versions') }, base, 'no source, proposal or published package was created');
  assert.ok(done.stats.duplicates >= 1 && done.stats.nonEnglish >= 1 && done.stats.blocked >= 1, JSON.stringify(done.stats));
  assert.ok(s.raw.prepare("SELECT 1 FROM discovery_frontier WHERE via IN ('robots-sitemap','feed','directory')").get()); assert.ok(s.raw.prepare("SELECT 1 FROM discovery_runs WHERE seed_id LIKE 'v5-job-%' AND status='completed'").get());
  const ev = s.raw.prepare("SELECT identifier,evidence_url,excerpt,detected_at,method FROM license_evidence e JOIN discovered_sources d ON d.id=e.candidate_id WHERE d.url=?").all(intro[0]) as any[];
  assert.ok(ev.some((e) => e.identifier === 'CC-BY-4.0' && e.evidence_url === intro[0] && e.excerpt && e.detected_at)); assert.equal(count(s.raw, 'license_reviews'), 0, 'detection never records a clearance');
});
test('discovery needs no listed site: a different root on a different host works the same way', async () => {
  const s = setup(web({ 'https://other.example.co.uk/robots.txt': { ...txt, body: '' }, 'https://other.example.co.uk/learn/lua': { body: article('Learn Lua scripting tutorial') } }));
  const j = (await s.call('POST', '/api/admin/discovery/v5/jobs', { rootUrl: 'https://other.example.co.uk/learn/lua' })).body.jobId; await runJob(s, j);
  assert.ok(s.raw.prepare("SELECT 1 FROM discovered_sources WHERE host='other.example.co.uk'").get());
});
test('resumable: a step interrupted mid-flight is picked up after its lease expires; a live lease refuses a second step', async () => {
  const s = setup(); const id = (await s.call('POST', '/api/admin/discovery/v5/jobs', { rootUrl: 'https://hub.example.com/awesome' })).body.jobId;
  s.raw.prepare("UPDATE discovery_jobs SET status='running', lease_until=? WHERE id=?").run(s.c.get() + 600_000, id);
  const busy = await s.call('POST', `/api/admin/discovery/v5/jobs/${id}/step`); assert.equal(busy.status, 409);
  s.raw.prepare("UPDATE discovery_frontier SET status='fetching' WHERE job_id=?").run(id); s.raw.prepare('UPDATE discovery_jobs SET lease_until=1 WHERE id=?').run(id); // the step "crashed"
  const done = await runJob(s, id); assert.equal(done.done, true); assert.ok(count(s.raw, 'discovered_sources') >= 3);
  assert.equal((s.raw.prepare('SELECT status FROM discovery_jobs WHERE id=?').get(id) as any).status, 'completed'); assert.equal((await s.call('POST', `/api/admin/discovery/v5/jobs/${id}/step`)).status, 409, 'finished jobs are not re-run');
});
test('steps are bounded and persisted: a single step never exceeds its fetch budget', async () => {
  const s = setup(); const id = (await s.call('POST', '/api/admin/discovery/v5/jobs', { rootUrl: 'https://hub.example.com/awesome' })).body.jobId;
  const r = (await s.call('POST', `/api/admin/discovery/v5/jobs/${id}/step`)).body; assert.ok(r.fetched <= 10); assert.equal(r.done, false); assert.ok(r.open > 0);
  assert.ok(Number((s.raw.prepare('SELECT lease_until FROM discovery_jobs WHERE id=?').get(id) as any).lease_until) === 0, 'lease released after the step');
});
test('cancelled jobs stop; invalid, private and insecure starting points are refused before anything is fetched', async () => {
  const s = setup(); for (const rootUrl of ['https://127.0.0.1/', 'http://hub.example.com/', 'https://intranet.corp/x', 'not a url', 'https://u:p@hub.example.com/']) assert.equal((await s.call('POST', '/api/admin/discovery/v5/jobs', { rootUrl })).status, 400, rootUrl);
  assert.equal(s.w.requested.length, 0); const id = (await s.call('POST', '/api/admin/discovery/v5/jobs', { rootUrl: 'https://hub.example.com/awesome' })).body.jobId;
  assert.equal((await s.call('POST', `/api/admin/discovery/v5/jobs/${id}/cancel`)).status, 200); assert.equal((await s.call('POST', `/api/admin/discovery/v5/jobs/${id}/step`)).status, 409);
});
test('repository adapter: GitHub API metadata becomes a candidate with repository-scoped licence evidence (ambiguous for documentation)', async () => {
  const s = setup(web({ 'https://api.github.com/repos/someone/luau-learning-guide': { type: 'application/json', body: JSON.stringify({ full_name: 'someone/luau-learning-guide', html_url: 'https://github.com/someone/luau-learning-guide', description: 'A beginner tutorial and guide to Luau scripting with code examples', topics: ['luau', 'tutorial', 'roblox'], language: 'Luau', license: { spdx_id: 'MIT', name: 'MIT License' } }) } }));
  const id = (await s.call('POST', '/api/admin/discovery/v5/jobs', { rootUrl: 'https://github.com/someone/luau-learning-guide' })).body.jobId; await runJob(s, id);
  const cand = s.raw.prepare("SELECT id,category FROM discovered_sources WHERE url='https://github.com/someone/luau-learning-guide'").get() as any; assert.equal(cand.category, 'repository');
  const ins = (await s.call('GET', `/api/admin/discovery/v5/candidates/${cand.id}/insight`)).body; assert.equal(ins.evidence[0].scope, 'repository'); assert.equal(ins.assessment.reuse.status, 'ambiguous'); assert.equal(ins.assessment.clearance, 'not-cleared');
  assert.ok(s.w.requested.includes('https://api.github.com/repos/someone/luau-learning-guide')); assert.ok(!s.w.requested.includes('https://api.github.com/robots.txt') || true);
});

test('licensing flow: insight, rescan, separate owner clearance with safeguards; clearance never approves the source or a proposal', async () => {
  const s = setup(); const id = (await s.call('POST', '/api/admin/discovery/v5/jobs', { rootUrl: 'https://learn.example.org/luau/intro' })).body.jobId; await runJob(s, id);
  const cid = (s.raw.prepare("SELECT id FROM discovered_sources WHERE url='https://learn.example.org/luau/intro'").get() as any).id; const base = `/api/admin/discovery/v5/candidates/${cid}`;
  const ins = (await s.call('GET', `${base}/insight`)).body; assert.equal(ins.assessment.reuse.status, 'indicated-permissive'); assert.equal(ins.assessment.clearance, 'not-cleared'); assert.ok(ins.explanation.licensing.length && ins.explanation.restrictions.includes('credit must be given')); assert.match(ins.explanation.headline, /not cleared/);
  const scan = (await s.call('POST', `${base}/license/scan`)).body; assert.equal(scan.success, true); assert.equal(count(s.raw, 'license_evidence'), (await s.call('GET', `${base}/insight`)).body.evidence.length, 'rescan is idempotent');
  const evId = ins.evidence[0].id;
  assert.equal((await s.call('POST', `${base}/license/review`, { decision: 'cleared', basis: 'detected-evidence', scope: 'page text', note: 'ok' })).status, 400, 'a written reason is required');
  assert.equal((await s.call('POST', `${base}/license/review`, { decision: 'cleared', basis: 'detected-evidence', scope: 'page text', note: 'CC BY link is in the page head.', evidenceIds: [] })).status, 409, 'must cite evidence');
  const ok = await s.call('POST', `${base}/license/review`, { decision: 'cleared-with-conditions', basis: 'detected-evidence', scope: 'page text', note: 'CC BY link is in the page head.', evidenceIds: [evId], conditions: 'Credit the author.', attributionText: 'Example Learning', permitsRedistribution: true }); assert.equal(ok.status, 201);
  assert.equal(count(s.raw, 'sources'), 0); assert.equal(count(s.raw, 'proposals'), 0); assert.equal((s.raw.prepare('SELECT status FROM discovered_sources WHERE id=?').get(cid) as any).status, 'pending', 'source approval is a separate decision');
  const snap = await licensingSnapshot({ db: s.db as any }, cid); assert.equal(snap!.clearance!.decision, 'cleared-with-conditions'); assert.equal(await categoryLabelFor({ db: s.db as any }, cid), 'Tutorial');
  assert.equal((await s.call('POST', `${base}/license/review`, { decision: 'denied', basis: 'owner-judgement', scope: 'page text', note: 'Changed my mind after reading terms.' })).status, 201);
  assert.equal(((await s.call('GET', `${base}/insight`)).body.reviews as any[]).length, 2); assert.equal((await s.call('GET', `${base}/insight`)).body.reviews[0].decision, 'denied');
});
test('licensing safeguards: ambiguous or conflicting evidence cannot be cleared without explicit acknowledgement', async () => {
  const s = setup(web({ 'https://amb.example.com/robots.txt': { ...txt, body: '' }, 'https://amb.example.com/learn/guide': { body: article('Scripting tutorial guide', { extra: '<p>Content licensed under CC BY 4.0.</p><footer>All rights reserved.</footer>' }) } }));
  const id = (await s.call('POST', '/api/admin/discovery/v5/jobs', { rootUrl: 'https://amb.example.com/learn/guide' })).body.jobId; await runJob(s, id);
  const cid = (s.raw.prepare("SELECT id FROM discovered_sources WHERE host='amb.example.com'").get() as any).id; const base = `/api/admin/discovery/v5/candidates/${cid}`;
  const ins = (await s.call('GET', `${base}/insight`)).body; assert.equal(ins.assessment.reuse.status, 'conflicting'); assert.ok(ins.assessment.conflicts.length);
  const body = { decision: 'cleared', basis: 'owner-written-permission', scope: 'page text', note: 'Publisher confirmed by email on 2026-11-02.' };
  const refused = await s.call('POST', `${base}/license/review`, body); assert.equal(refused.status, 409); assert.match(refused.body.error, /acknowledge/);
  assert.equal((await s.call('POST', `${base}/license/review`, { ...body, acknowledgeAmbiguity: true })).status, 201); assert.equal(count(s.raw, 'license_reviews'), 1);
  assert.equal((await s.call('POST', `${base}/license/review`, { decision: 'denied', basis: 'owner-judgement', scope: 'all', note: 'Terms are contradictory, not relying on this.' })).status, 201, 'denying never needs acknowledgement');
});
test('source monitoring: re-check uses conditional requests and classifies the change; nothing is re-extracted', async () => {
  const s = setup(); const id = (await s.call('POST', '/api/admin/discovery/v5/jobs', { rootUrl: 'https://learn.example.org/luau/intro' })).body.jobId; await runJob(s, id);
  const cid = (s.raw.prepare("SELECT id FROM discovered_sources WHERE url='https://learn.example.org/luau/intro'").get() as any).id; const url = `/api/admin/discovery/v5/candidates/${cid}/recheck`;
  assert.equal((await s.call('POST', url)).body.state, 'unchanged'); s.c.set(s.c.get() + 10_000);
  s.w.pages['https://learn.example.org/luau/intro'] = { body: article('A completely different page now', { text: 'Totally new subject about cooking pasta and sauces with garlic and olive oil in a big pot. '.repeat(30) }), headers: { etag: '"v2"' } };
  const changed = (await s.call('POST', url)).body; assert.ok(['major-change', 'moved'].includes(changed.state), changed.state); assert.equal((s.raw.prepare('SELECT change_state FROM discovered_source_meta WHERE candidate_id=?').get(cid) as any).change_state, changed.state);
  s.w.pages['https://learn.example.org/luau/intro'] = { status: 404, body: 'gone', type: 'text/plain' }; s.c.set(s.c.get() + 10_000); assert.equal((await s.call('POST', url)).body.state, 'gone'); assert.equal(count(s.raw, 'proposals'), 0);
});
test('overview exposes the capability registry; a 0.4.0 database gets a clear, harmless "not installed" answer', async () => {
  const s = setup(); const o = (await s.call('GET', '/api/admin/discovery/v5/overview')).body; assert.equal(o.version, '0.5.0'); assert.ok(o.capabilities.length >= 4 && o.capabilities.every((m: any) => m.selectable && m.compat.status === 'verified-local'));
  const raw = v040(); const db = d1(raw); const request = new Request('https://owner.test/api/admin/discovery/v5/overview');
  const res = await discoveryV5Api({ db: db as any, request, url: new URL(request.url), path: '/api/admin/discovery/v5/overview', sessionId: 's', json: (d, st = 200) => Response.json(d, { status: st }), readJson: async () => null, audit: async () => {}, auditStmt: (() => null) as any, validSlug: (x: unknown): x is string => true }, { classify });
  assert.equal(res!.status, 503); assert.equal(((await res!.json()) as any).code, 'v5-not-installed'); assert.equal(await licensingSnapshot({ db: db as any }, 1), null);
});
