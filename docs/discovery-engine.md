# Discovery engine (v0.5.0)

Source-agnostic discovery of publicly accessible English-language educational and programming resources. TypeScript, web-standard APIs only, runs inside the existing Worker. **It finds and describes; it never approves, clears, extracts or publishes.**

## Layers and contracts

All layers talk through the types in `knowledge/engine/contracts.ts`. Lower layers never import the worker, the database layer or each other's internals (enforced by `tests/engine-hygiene.test.ts`).

| Layer | Folder | Job |
| --- | --- | --- |
| 1 Global discovery | `engine/discovery/` | Where to look next: sitemap/feed parsers (`indexes.ts`), link analysis, directory detection, host probing, quotas (`opportunities.ts`), relevance/language/type heuristics (`relevance.ts`). No site list anywhere. |
| 2 Scanning | `engine/net/` | `url-policy.ts` (public https only; no IP/credentials/ports/internal names; canonicalisation), `robots.ts` (RFC 9309), `fetcher.ts` (robots-enforced, per-host spacing by *deferral*, size/time caps, redirect re-validation, conditional requests, gzip). |
| 3 Parsing | `engine/parse/` | HTML/Markdown to neutral `PageSignals` (prose separated from code, footer, rel=license, meta, JSON-LD, feeds). Pages are data; nothing is executed. |
| 4 Knowledge | `engine/discovery/relevance.ts` + existing `knowledge/classify.ts` | English/relevance/type with explainable signals; learning-path matching is injected. Extraction into proposals is the unchanged v0.4.0 flow. |
| 5 Licensing | `engine/license/` | Evidence detection and assessment; see `licensing-intelligence.md`. |
| 6 Monitoring | `engine/monitor/` | SHA-256 + SimHash fingerprints, banded near-duplicate lookup, change states, re-check back-off. |
| 7 Management | `worker/discovery-v5-*.ts`, Owner Console | The only layer that touches D1; owner routes and review. |

`engine/orchestrator.ts` wires the layers for one bounded **step**; `engine/runtime/` is the capability registry; `engine/explain.ts` builds owner-facing explanations.

## How a job runs

1. Owner starts a job from any public https URL (a hint, not a limit). 2. Each *step* (about ten fetches) pops the best frontier items, fetches politely, parses, scores, expands (feeds, sitemaps, robots `Sitemap:` lines, new hosts, links from relevant/directory-like pages within depth 3 and per-page/per-host quotas), de-duplicates (known URL, exact hash, SimHash within 3 bits) and inserts **pending** candidates with licence evidence. 3. State lives in `discovery_jobs`/`discovery_frontier`; a lease prevents overlapping steps and an expired lease makes an interrupted step resumable. 4. When nothing is left the job completes and a normal `discovery_runs` row is written.

Candidates reuse `discovered_sources` (the existing queue). Because its `category` CHECK allows only `official-docs`/`language`/`repository`, third-party pages are stored as `official-docs` and the true type (tutorial, course, reference…) is in `discovered_source_meta.resource_type`; the console and extraction labels use it.

## Politeness and safety

robots.txt is fetched, cached per host and enforced on every request and redirect hop; an unreachable robots.txt (5xx, 401/403, network) means *do not crawl*; `Crawl-delay` and 429/503 `Retry-After` are honoured by deferring; `noindex`/`X-Robots-Tag` pages are not proposed; `rel=nofollow/ugc/sponsored` links are not followed. `api.github.com` is used as a documented public API (unauthenticated, rate-limited) and is the one host exempt from robots.txt (SSRF rules still apply). No commercial search API, paid service or AI API is used. Discovery needs no credentials.

## Limits (be aware)

* "Global" means *any publicly reachable site the engine can discover from the owner's starting points*, not the whole internet. Coverage depends on the starting points and on what sites publish (links, feeds, sitemaps).
* Heuristics (English, relevance, type, licence wording) are keyword/structure rules: expect false positives and misses. The owner reviews everything.
* No JavaScript rendering: pages that need it yield little text. Non-HTML formats (PDF, video) are not read.
* A Worker step is limited by Workers CPU/subrequest limits; the default budget (about ten pages plus robots.txt requests) is conservative for the free plan and is untested on Cloudflare.
* There is no scheduler by design: steps are owner-triggered.
