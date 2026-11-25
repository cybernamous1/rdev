import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSignals } from '../knowledge/engine/parse/html-signals.ts';
import { parseSitemap, parseFeed } from '../knowledge/engine/discovery/indexes.ts';
import { assessRelevance, guessLanguage, MIN_RELEVANCE, scoreUrl } from '../knowledge/engine/discovery/relevance.ts';
import { opportunitiesFromPage, opportunitiesFromHost, opportunitiesFromIndex, opportunityFor, LIMITS } from '../knowledge/engine/discovery/opportunities.ts';
import { classify } from './helpers/d1-shim.ts';

const EN = 'The tutorial explains how to use a function in your script. You can learn what the variable is, and the loop will run for each item in the list. This is a guide for the beginner who wants to write code that is clear. '.repeat(12);
const page = (extra = '', head = '') => `<!doctype html><html lang="en"><head><title>Luau scripting tutorial</title><meta name="description" content="Learn scripting"><link rel="canonical" href="https://learn.example.com/luau/intro?utm_source=a">${head}<script>alert(1)</script></head><body><nav><a href="/menu">Menu</a></nav><h1>Intro</h1><h2>A</h2><h2>B</h2><p>${EN}</p><pre><code>local x = 1\nprint(x)</code></pre><footer>&copy; 2025 Example Learning. <a href="/terms">Terms of use</a></footer>${extra}</body></html>`;

test('html signals: title, lang, canonical, code separated from prose, footer, scripts ignored', () => {
  const s = extractSignals(page(), 'https://learn.example.com/luau/intro');
  assert.equal(s.title, 'Luau scripting tutorial'); assert.equal(s.lang, 'en'); assert.equal(s.canonical, 'https://learn.example.com/luau/intro');
  assert.equal(s.codeBlocks, 1); assert.ok(s.codeText.includes('print(x)')); assert.ok(!s.proseText.includes('print(x)')); assert.ok(!s.proseText.includes('alert'));
  assert.ok(s.footerText.includes('Example Learning')); assert.ok(s.headings >= 3); assert.ok(s.links.some((l) => l.url === 'https://learn.example.com/terms'));
});
test('html signals: rel=license, meta licence, JSON-LD, feeds, noindex/nofollow, nofollow links', () => {
  const s = extractSignals(page('<a rel="nofollow" href="https://spam.example.net/x">x</a>', '<link rel="license" href="https://creativecommons.org/licenses/by/4.0/"><meta name="robots" content="noindex, nofollow"><meta name="dc.rights" content="CC BY 4.0"><link rel="alternate" type="application/rss+xml" href="/feed.xml"><script type="application/ld+json">{"@type":"Article","license":"https://opensource.org/licenses/MIT"}</script>'), 'https://learn.example.com/a');
  assert.deepEqual(s.licenseLinks.map((l) => l.url), ['https://creativecommons.org/licenses/by/4.0']); assert.equal(s.metaLicense.length, 1); assert.equal(s.jsonLd.length, 1);
  assert.deepEqual(s.feedLinks, ['https://learn.example.com/feed.xml']); assert.deepEqual(s.robotsMeta, { noindex: true, nofollow: true });
  assert.ok(s.links.find((l) => l.url.includes('spam'))!.rel.includes('nofollow'));
});
test('html signals: markdown and malformed input do not throw', () => {
  const md = extractSignals('# Title\n\nSee [docs](https://x.example.com/docs).\n\n```lua\nprint(1)\n```\n', 'https://x.example.com/README.md', 'text/markdown');
  assert.equal(md.title, 'Title'); assert.equal(md.codeBlocks, 1); assert.equal(md.links.length, 1);
  assert.doesNotThrow(() => extractSignals('<div><a href=', 'https://x.example.com/')); assert.doesNotThrow(() => extractSignals('', 'https://x.example.com/'));
});
test('sitemaps: urlset, index, text format, tolerant of entities and CDATA', () => {
  const u = parseSitemap('<?xml version="1.0"?><urlset><url><loc>https://a.example.com/docs/a?x=1&amp;utm_source=z</loc><lastmod>2025-01-02</lastmod></url><url><loc><![CDATA[https://a.example.com/b]]></loc></url></urlset>', 'https://a.example.com/sitemap.xml')!;
  assert.equal(u.kind, 'urlset'); assert.deepEqual(u.entries.map((e) => e.url), ['https://a.example.com/docs/a?x=1', 'https://a.example.com/b']);
  assert.equal(parseSitemap('<sitemapindex><sitemap><loc>https://a.example.com/s1.xml</loc></sitemap></sitemapindex>', 'https://a.example.com/')!.kind, 'index');
  assert.equal(parseSitemap('https://a.example.com/one\nhttps://a.example.com/two\n', 'https://a.example.com/s.txt')!.entries.length, 2); assert.equal(parseSitemap('<html>not a sitemap</html>', 'https://a.example.com/'), null);
});
test('feeds: RSS, Atom and JSON Feed', () => {
  const rss = parseFeed('<rss><channel><item><title>T1</title><link>https://b.example.com/p1</link><description>&lt;b&gt;Learn&lt;/b&gt; things</description></item></channel></rss>', 'https://b.example.com/')!;
  assert.equal(rss[0].url, 'https://b.example.com/p1'); assert.equal(rss[0].summary, 'Learn things');
  const atom = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><link rel="alternate" href="https://b.example.com/a1"/><updated>2025-01-01</updated></entry></feed>', 'https://b.example.com/')!; assert.equal(atom[0].url, 'https://b.example.com/a1');
  assert.equal(parseFeed(JSON.stringify({ items: [{ url: 'https://b.example.com/j1', title: 'J' }] }), 'https://b.example.com/')![0].url, 'https://b.example.com/j1'); assert.equal(parseFeed('hello', 'https://b.example.com/'), null);
});
test('language: English detected from content, non-English and non-Latin rejected, short text uses lang attribute', () => {
  assert.equal(guessLanguage(EN, null).code, 'en'); assert.equal(guessLanguage('これは日本語のページです。'.repeat(20), 'ja').code, 'other');
  assert.equal(guessLanguage('El tutorial explica cómo usar una función en tu código para aprender a programar muy bien. '.repeat(10), 'es').code, 'other'); assert.equal(guessLanguage('hi', 'en-GB').code, 'en');
});
test('relevance: an educational English programming page scores above the threshold with explainable signals; a shop page does not', () => {
  const s = extractSignals(page(), 'https://learn.example.com/luau/intro'); const r = assessRelevance(new URL('https://learn.example.com/luau/intro'), s, classify);
  assert.ok(r.score >= MIN_RELEVANCE, String(r.score)); assert.equal(r.language.code, 'en'); assert.equal(r.suggestedPath, 'Luau Programming'); assert.ok(r.signals.length >= 3);
  const shop = extractSignals('<html lang="en"><head><title>Buy now</title></head><body><p>Add to cart. Buy now with coupon. ' + 'the best price for you and the family '.repeat(30) + '</p></body></html>', 'https://shop.example.com/cart');
  assert.ok(assessRelevance(new URL('https://shop.example.com/cart'), shop, classify).score < MIN_RELEVANCE);
});
test('opportunities: no fixed site list - links, feeds, sitemaps and new hosts are all derived from page shape, within quotas', () => {
  const links = Array.from({ length: 40 }, (_, i) => `<a href="https://other-${i % 5}.example.org/tutorial/lesson-${i}">Free tutorial ${i}</a>`).join('') + '<a href="https://www.facebook.com/x">fb</a><a href="/login">login</a><a href="/learn/guide-1">Guide one</a>';
  const s = extractSignals(`<html lang="en"><head><title>Awesome learning resources</title><link rel="alternate" type="application/atom+xml" href="/atom.xml"></head><body>${links}<p>${EN}</p></body></html>`, 'https://hub.example.com/awesome');
  const ops = opportunitiesFromPage('https://hub.example.com/awesome', 0, s, true);
  assert.ok(ops.some((o) => o.kind === 'feed')); assert.ok(ops.length <= LIMITS.perPage + 1); assert.ok(ops.every((o) => !o.url.includes('facebook') && !o.url.includes('/login')));
  assert.ok(ops.some((o) => o.via === 'directory' && !o.url.includes('hub.example.com'))); assert.ok(ops.filter((o) => o.url.includes('other-0')).length <= LIMITS.perHostPerPage);
  assert.deepEqual(opportunitiesFromPage('https://hub.example.com/awesome', LIMITS.maxDepth, s, true).filter((o) => o.kind !== 'feed'), []);
  assert.equal(opportunitiesFromHost('new.example.dev', ['https://new.example.dev/sm.xml'], 1)[0].via, 'robots-sitemap'); assert.equal(opportunitiesFromHost('new.example.dev', [], 1)[0].url, 'https://new.example.dev/sitemap.xml');
  assert.ok(opportunitiesFromIndex([{ url: 'https://z.example.com/docs/api-reference', title: 'API reference', summary: '' }, { url: 'https://z.example.com/about-us', title: 'About', summary: '' }], 'sitemap', 'https://z.example.com/sitemap.xml', 1).length === 1);
  assert.equal(opportunityFor('https://z.example.com/logo.png', 'link-analysis', 'https://z.example.com/', 1), null); assert.ok(scoreUrl(new URL('https://x.example.com/tutorial/api')).score > 0);
});
