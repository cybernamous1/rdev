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

The database must already be initialized from `database/init.sql` (no schema change was made). Set the real D1 id in `wrangler.jsonc`, set `OWNER_ADMIN_TOKEN`, run the validation commands, and deploy only when separately authorized. Nothing in this integration executed SQL, touched D1 or deployed. Live-D1 behaviour (including `db.batch` atomicity) has been exercised only against SQLite adapters.

## Limitations

Source editing/deletion, scheduled retrieval, automated extraction/classification/proposal generation, multi-owner accounts, and per-user audit identity remain out of scope. Publication verification records the reviewer name the owner types; the owner is responsible for actually inspecting content and licensing.
