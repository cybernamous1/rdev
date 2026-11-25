# RDev Academy Owner Console

The private console is part of the same React app and Cloudflare Worker (`worker/admin-api.ts`, `src/pages/Owner.tsx`). It is not a second app. The learner routes, learner startup and local learner data are unaffected: the console is a lazily loaded chunk that learners never download, and `App.tsx` only renders it for `#/owner`.

## Access

Open `https://<your-worker-domain>/#/owner`. The route is not linked from learner navigation, but a hidden route is not treated as security: every `/api/admin/*` request is authenticated by the Worker.

## Configure the owner credential

Generate a long random token (at least 32 characters) and set it as a Worker secret:

```bash
npx wrangler secret put OWNER_ADMIN_TOKEN
```

Do not put it in `.env`, `wrangler.jsonc`, frontend code, browser storage, query strings or source control. Until it is set, login answers 503 and nothing else is reachable.

- Sessions: random 256-bit cookie, `HttpOnly`, `SameSite=Strict`, `Secure` on https, path `/api/admin`. Only a SHA-256 of the session id and a domain-separated fingerprint of the credential are stored in D1.
- Expiry: 30-minute idle, 12-hour absolute. Rotating `OWNER_ADMIN_TOKEN` invalidates all existing sessions.
- Brute force: 8 failed logins per hashed client IP in 15 minutes triggers HTTP 429. Old attempt/session rows are purged on login.
- CSRF: every state-changing request must carry a matching `Origin` (or `Sec-Fetch-Site: same-origin`).
- Request bodies are capped at 32 KB; unexpected failures return a generic 500 without internals.
- Audit: logins, review decisions, source registration, publication and rollback are written to the append-only `security_events` table (publication and rollback inside the same atomic batch).

## Operations

- Overview, proposal queue (filter by status), proposal inspection with analysis findings.
- Approve / reject (rejection needs a reason; approval never publishes).
- Separate verification step (reviewer, notes, explicit confirmation) before publication.
- Atomic publication in one D1 `batch`: new immutable entry version, package version, membership, publication record, proposal marked published, pointer move. The existing SQL triggers re-verify the whole publication; any failure commits nothing.
- Package version numbers are allocated above every version ever created for that package, so publishing after a rollback cannot collide. Unchanged entries keep the version already in the package body.
- Rollback to a previously published version: the target body is re-validated (RLF + checksum) first, then a `rollback` publication record and pointer move are committed atomically. History is append-only.
- Register sources (HTTPS, approved hosts, no ports/credentials) and manually check them (no redirects, 2 MB streamed cap, hash only; source text is never stored or published).

## Learner safety and cache behaviour

- The public API serves only `packages.current_version`; pending, approved and rejected proposals are never queried by public routes (enforced by a test).
- `/api/admin/*` responses are `Cache-Control: no-store`; the service worker never caches `/api/*`.
- After publish or rollback, learners converge after the manifest cache expires (`max-age=60`, `stale-while-revalidate=300`; package bodies `max-age=300`). Learner sync follows the server's current version even when it is lower.

## Deployment requirements

A database initialized with the v0.3.0 `init.sql` must first be upgraded with `database/upgrade-0.4.0.sql` (additive; see below). A new database uses the v0.4.0 `init.sql`. Until the upgrade is applied the console keeps working as in v0.3.0 and the Discovery tab reports that the upgrade is missing. Set the real D1 id in `wrangler.jsonc`, set `OWNER_ADMIN_TOKEN`, run the validation commands, and deploy only when separately authorized. Nothing in this integration executed SQL, touched D1 or deployed. Live-D1 behaviour (including `db.batch` atomicity) has been exercised only against SQLite adapters.

## Limitations

Source editing/deletion, scheduled retrieval, multi-owner accounts, and per-user audit identity remain out of scope. See the discovery limitations below. Publication verification records the reviewer name the owner types; the owner is responsible for actually inspecting content and licensing.

## Knowledge discovery and acquisition (v0.4.0)

Everything is owner-triggered from the **Discovery** tab; there is no scheduler, no public endpoint and no AI/agent service. Routes live under `/api/admin/discovery/*` (same session, CSRF and no-store rules as the rest of the console).

```
discovery roots ─► CANDIDATE sources (pending) ─► owner approves/rejects ─► approved source registered in the ledger
   ─► owner: Retrieve & extract ─► classified, duplicate-checked PENDING proposal ─► owner approve ─► verify ─► publish
```

**Two separate review queues.** (1) *Discovery tab*: candidate sources. Approving a source only registers its URL in the source ledger (`sources`) and records your license text; it extracts nothing. (2) *Proposals tab*: extracted knowledge proposals (filter “Extracted from sources”). Approving a source never approves its content, and approving a proposal never publishes it; publication is still the separate verification step.

**Discovery.** Built-in discovery roots (`knowledge/discover.ts`: Creator Hub docs sections, luau.org, and the `Roblox/creator-docs` and `luau-lang/luau` repositories). One root per request, 15 s timeout, 2 MB cap, HTTPS and approved hosts only, redirects followed only within approved hosts. Links are normalized (query/fragment dropped), filtered (docs paths, Luau pages, GitHub repos/Markdown of the `Roblox` and `luau-lang` owners only), scored by the existing learning-path keywords and capped at 40 per run. URLs already registered or queued are skipped; a rejected candidate is never re-queued or reopened.

**Extraction.** Only for an approved source. HTML pages (headings, paragraphs, lists, code) and GitHub Markdown (read from `raw.githubusercontent.com`, README or the linked `.md`) become an RLF `reference` entry: `status: ai-assisted`, `origin: imported`, no review, id derived from the URL so re-extraction targets the same entry. It is classified into one of the eight existing learning paths by the keyword rules (`classifyText`); if no path matches, extraction stops with *needs a path* and you choose one. Related entries (shared tags) are listed in the analysis. Payloads are capped at 150 blocks / 60,000 characters (marked as truncated).

**Duplicate, outdated and change detection.** The proposal analysis lists findings from `analyzeEntries` against published entries *and* the pending/approved queue (duplicate title, near-duplicate text, duplicate code, conflicts, prerequisites), RLF validation results, and a missing-license warning. Each extraction records a hash of the normalized extracted text (not raw HTML, so page chrome does not trigger changes). An unchanged hash creates nothing; a changed hash creates an `update` proposal (when the entry is published) or replaces your still-pending proposal for that entry (older one is marked superseded). The *Changed sources* panel lists published entries citing a source that changed (`outdated-source`) and pending/approved proposals gone stale. **A stale proposal cannot be published** (HTTP 409) and must be re-extracted and re-reviewed.

**Publication gates (unchanged and extra).** Only an owner-approved proposal with explicit verification can be published, atomically, through the existing D1 batch and triggers. Imported content additionally needs a license on its source: record it at approval time or later via *Save license* (it is written once and never overwritten). Source text is never stored in the source ledger; reviewed extracted text lives only in the proposal and, once published, in the package.

**Database enforcement.** `discovered_sources` must start `pending`; only `pending → approved|rejected` is allowed, decisions are frozen, rows cannot be deleted, approval must register the identical URL in `sources`; `extraction_runs` and `proposal_provenance` can only be written for an approved source (and provenance only for a pending proposal) and are append-only/immutable.

**Limitations.**
* Verified only against local SQLite and a fake network; not run against live Roblox/Luau/GitHub or Cloudflare D1/Workers. Script-rendered pages yield no text (reported as a failed extraction); real page structure may need extractor tuning.
* The extractor is deliberately simple (headings, paragraphs, lists, code, tables are dropped); extracted wording is the source's wording, so licensing and rewriting are your responsibility. Extracted entries are `reference` entries; lessons are never generated.
* One page per source, no crawling beyond the discovery roots, no scheduled re-checks (use *Re-check & extract*), no DevForum discovery (host stays allowed for manual registration).
* Change detection compares extraction hashes only; sources registered manually or checked with *Check source* are not covered. The classifier is keyword-based and can be wrong, so check the suggested path.
* Candidates and decisions cannot be edited, deleted or reopened from the console.
* Payload size is capped for D1's per-statement limit, so very long pages are truncated.

## Adaptive discovery and licensing (v0.5.0)

Inside **Discovery** (only when `upgrade-0.5.0.sql` has been applied; otherwise a harmless notice is shown):

* **Adaptive discovery:** paste any public https starting point and press *Start discovery job*, then *Run next step* repeatedly. Each step reads at most about ten pages, so it is short and can be repeated after an interruption. New candidates appear in *Candidate sources* as **pending**.
* **Why suggested · licensing evidence** (on every candidate): a concise explanation, the licensing assessment (`indicated-permissive`, `indicated-conditional`, `restricted`, `conflicting`, `ambiguous` or `no-evidence`), restrictions in plain words, confidence, and every evidence item with its exact URL, original excerpt, scope and detection time. *Scan for licence evidence* reads the page and up to two linked licence/terms pages; *Re-check source* reports whether it changed.
* **Record a licensing decision:** a separate, append-only decision (cleared / cleared with conditions / denied) with basis, scope, and reason. Ambiguous, conflicting, restricted or evidence-free material can only be cleared after you tick an explicit acknowledgement. This never approves the source and never approves a proposal.
* Proposals extracted from a source show its licensing status and whether you have recorded a clearance.
