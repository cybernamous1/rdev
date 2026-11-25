import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { checkUrl, canonicalize, sameSite } from '../knowledge/engine/net/url-policy.ts';
import { parseRobots, robotsFromResponse } from '../knowledge/engine/net/robots.ts';
import { PoliteFetcher } from '../knowledge/engine/net/fetcher.ts';
import { parseSitemap } from '../knowledge/engine/discovery/indexes.ts';
import { MemoryHostPolicies, fakeWeb, clock } from './helpers/d1-shim.ts';

test('url policy refuses private, credentialed, IP and non-https URLs but accepts any public https host', () => {
  for (const bad of ['http://example.com/', 'https://user:pw@example.com/', 'https://example.com:8443/', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://10.0.0.5/', 'https://intranet.corp/', 'https://printer.local/', 'https://2130706433/', 'https://nodots/', 'ftp://example.com/'])
    assert.equal(checkUrl(bad).ok, false, bad);
  for (const good of ['https://example.com/', 'https://learn.example.co.uk/a/b?x=1', 'https://xn--bcher-kva.com/', 'https://anything-new.dev/docs']) assert.equal(checkUrl(good).ok, true, good);
});
test('canonicalize strips tracking, fragments, index files and trailing slashes; sameSite ignores www', () => {
  assert.equal(canonicalize('https://Example.com/docs/index.html?utm_source=x&b=2&a=1#top'), 'https://example.com/docs?a=1&b=2');
  assert.equal(canonicalize('https://example.com/a//b/'), 'https://example.com/a/b'); assert.equal(canonicalize('http://example.com/'), null);
  assert.ok(sameSite('https://www.example.com/a', 'https://example.com/b')); assert.ok(!sameSite('https://a.example.com/', 'https://example.com/'));
});
test('robots.txt: longest match wins, Allow beats Disallow on ties, wildcards, crawl-delay, sitemaps, specific agent group', () => {
  const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*.pdf$\nCrawl-delay: 4\nSitemap: https://example.com/sm.xml\n\nUser-agent: otherbot\nDisallow: /');
  assert.equal(r.allows('/docs'), true); assert.equal(r.allows('/private/x'), false); assert.equal(r.allows('/private/open/x'), true); assert.equal(r.allows('/a/b.pdf'), false); assert.equal(r.allows('/a/b.pdf?x'), true);
  assert.equal(r.crawlDelaySec, 4); assert.deepEqual(r.sitemaps, ['https://example.com/sm.xml']);
  const mine = parseRobots('User-agent: rdevacademybot\nDisallow: /\n\nUser-agent: *\nAllow: /'); assert.equal(mine.allows('/x'), false);
  assert.equal(parseRobots('User-agent: *\nDisallow:\n').allows('/anything'), true);
});
test('robots availability: 404 = allow all; 5xx/401/403/network failure = do not crawl', () => {
  assert.equal(robotsFromResponse(404, '').allows('/x'), true); assert.equal(robotsFromResponse(503, '').allows('/x'), false);
  assert.equal(robotsFromResponse(403, '').allows('/x'), false); assert.equal(robotsFromResponse(null, '').allows('/x'), false);
});

const mk = (pages: Parameters<typeof fakeWeb>[0], extra: object = {}) => { const web = fakeWeb(pages); const c = clock(); const store = new MemoryHostPolicies(); return { web, store, f: new PoliteFetcher({ fetchImpl: web.fetchImpl, store, now: c.now, minDelayMs: 0, ...extra }), c }; };
test('fetcher: fetches an arbitrary public host, honours robots, never requests a disallowed path', async () => {
  const { web, f } = mk({ 'https://new-site.dev/robots.txt': { body: 'User-agent: *\nDisallow: /secret', type: 'text/plain' }, 'https://new-site.dev/learn': { body: '<html>ok</html>' }, 'https://new-site.dev/secret/a': { body: 'x' } });
  const ok = await f.fetch('https://new-site.dev/learn'); assert.equal(ok.kind, 'ok');
  const no = await f.fetch('https://new-site.dev/secret/a'); assert.equal(no.kind, 'blocked'); assert.equal((no as any).reason, 'robots');
  assert.ok(!web.requested.includes('https://new-site.dev/secret/a'));
});
test('fetcher: unreachable robots.txt means no crawling; robots is cached per host', async () => {
  const a = mk({ 'https://down.example.org/robots.txt': { status: 503, body: '' }, 'https://down.example.org/x': { body: 'x' } });
  assert.equal((await a.f.fetch('https://down.example.org/x')).kind, 'blocked'); assert.ok(!a.web.requested.includes('https://down.example.org/x'));
  const b = mk({ 'https://ok.example.org/a': { body: 'a' }, 'https://ok.example.org/b': { body: 'b', type: 'text/plain' } });
  await b.f.fetch('https://ok.example.org/a'); await b.f.fetch('https://ok.example.org/b'); assert.equal(b.web.requested.filter((u) => u.endsWith('/robots.txt')).length, 1);
});
test('fetcher: SSRF guards on the start URL and on every redirect hop', async () => {
  const { web, f } = mk({ 'https://start.example.com/r': { status: 302, location: 'https://127.0.0.1/admin' }, 'https://start.example.com/r2': { status: 302, location: 'http://example.org/' } });
  for (const u of ['https://127.0.0.1/', 'http://example.com/', 'https://internal.corp/']) assert.equal((await f.fetch(u)).kind, 'blocked');
  assert.equal((await f.fetch('https://start.example.com/r')).kind, 'blocked'); assert.equal((await f.fetch('https://start.example.com/r2')).kind, 'blocked');
  assert.ok(!web.requested.some((u) => u.includes('127.0.0.1')));
});
test('fetcher: redirects to another host are followed only through that host\'s robots.txt', async () => {
  const { web, f } = mk({ 'https://a.example.com/old': { status: 301, location: 'https://b.example.net/new' }, 'https://b.example.net/robots.txt': { body: 'User-agent: *\nDisallow: /new', type: 'text/plain' }, 'https://b.example.net/new': { body: 'x' } });
  const r = await f.fetch('https://a.example.com/old'); assert.equal(r.kind, 'blocked'); assert.ok(!web.requested.includes('https://b.example.net/new'));
});
test('fetcher: size cap, content-type allow-list, conditional request, gzip sitemap', async () => {
  const big = 'x'.repeat(5000);
  const { f } = mk({ 'https://s.example.com/big': { body: big }, 'https://s.example.com/img': { body: 'PNG', type: 'image/png' }, 'https://s.example.com/e': { body: 'e', headers: { etag: '"v1"' } },
    'https://s.example.com/sitemap.xml.gz': { body: gzipSync('<urlset><url><loc>https://s.example.com/a</loc></url></urlset>'), type: 'application/gzip' } });
  assert.equal(((await f.fetch('https://s.example.com/big', { maxBytes: 1000 })) as any).reason, 'too-large');
  assert.equal(((await f.fetch('https://s.example.com/img')) as any).reason, 'content-type');
  assert.equal((await f.fetch('https://s.example.com/e', { conditional: { etag: '"v1"' } })).kind, 'not-modified');
  const gz = await f.fetch('https://s.example.com/sitemap.xml.gz'); assert.equal(gz.kind, 'ok');
  assert.equal(parseSitemap((gz as any).text, 'https://s.example.com/')!.entries[0].url, 'https://s.example.com/a');
});
test('fetcher: per-host spacing and Crawl-delay are honoured by deferring (never by sleeping); 429 defers with Retry-After', async () => {
  const web = fakeWeb({ 'https://p.example.com/robots.txt': { body: 'User-agent: *\nCrawl-delay: 10', type: 'text/plain' }, 'https://p.example.com/a': { body: 'a' }, 'https://p.example.com/b': { body: 'b' }, 'https://q.example.com/x': { status: 429, headers: { 'retry-after': '30' } } });
  const c = clock(1_800_000_000_000, 1000); const f = new PoliteFetcher({ fetchImpl: web.fetchImpl, store: new MemoryHostPolicies(), now: c.now });
  assert.equal((await f.fetch('https://p.example.com/a')).kind, 'ok'); const d = await f.fetch('https://p.example.com/b'); assert.equal(d.kind, 'deferred'); assert.ok((d as any).retryAfterMs > 0 && (d as any).retryAfterMs <= 10_000);
  c.set(c.get() + 20_000); assert.equal((await f.fetch('https://p.example.com/b')).kind, 'ok');
  const t = await f.fetch('https://q.example.com/x'); assert.equal(t.kind, 'deferred'); assert.equal((t as any).retryAfterMs, 30_000);
});
test('fetcher: apiHosts skip robots but not SSRF rules', async () => {
  const web = fakeWeb({ 'https://api.github.com/repos/o/r': { body: '{}', type: 'application/json' } }); const f = new PoliteFetcher({ fetchImpl: web.fetchImpl, store: new MemoryHostPolicies(), apiHosts: ['api.github.com'], minDelayMs: 0 });
  assert.equal((await f.fetch('https://api.github.com/repos/o/r', { allowTypes: /json/ })).kind, 'ok');
});
