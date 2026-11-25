# RDev Academy

**Create. Learn. Develop.** A free, independent learning hub for Roblox development. Version **0.5.0** (adaptive global knowledge discovery and licensing intelligence on top of the v0.4.0 owner console).

No learner accounts, registration, login, OAuth, subscriptions or paywalls. Bookmarks, notes, preferences and progress stay in the browser (IndexedDB). No external hosted AI service is used.

## What v0.3.0 is

A corrected architecture on the intended stack: **React · TypeScript · Vite · Tailwind CSS v4 (plus handwritten CSS) · Cloudflare Workers · Hono · Cloudflare Vite plugin · Cloudflare D1 · IndexedDB**.

* **Public content is approval-gated.** The deployed site, its bundles, static assets and public API contain only content the owner has approved and published. Until then the app shows a "library is being prepared" state. The 26 lessons and 10 references exist only as **pending, AI-assisted, unreviewed proposals** (see `database/bootstrap`).
* **D1 is the single authoritative knowledge database** (schema prepared, never executed by any script here). Published knowledge is versioned, immutable and rollback-able; the public API serves only each package's *current* version.
* **Startup never waits on the network.** Local storage, preferences, bundled snapshot, stored packages and the search index load first. The service check and updates run in the background after first render.
* **Owner console:** a private, token-authenticated interface (`/#/owner`, `/api/admin/*`) to review proposals, register/check sources, publish approved content and roll back. **Knowledge discovery (v0.4.0):** owner-triggered discovery of candidate sources, owner approval of sources, retrieval/extraction/classification into pending proposals, duplicate/outdated/source-change detection, and two separate review queues. **Not implemented (by design):** scheduled/unattended retrieval and any automatic approval or publication.

## Learner experience

Animated branded initialization with real progress and error handling · dashboard · learning paths · lessons and references · full-text search (CamelCase-aware) · Code Playground (editor, structural Luau checks, snippets; it does **not** run Luau) · Knowledge Explorer (concepts, learning map, packages, sources, service) · bookmarks · local progress and notes · six themes · Android-first responsive layout · installable PWA with offline-capable service worker · neutral policy panels · honest empty states.

## Commands (Node ≥ 22.6)

```bash
npm ci
npm run dev            # Vite + Cloudflare plugin: Worker + local D1 emulation (empty until you initialize it)
npm run typecheck
npm test               # Node tests (engine, SQL, Worker API over a real-schema SQLite, project hygiene)
npm run test:db        # 113 SQLite lifecycle/constraint checks (Python 3 + Node)
npm run build          # tsc -b && vite build && bundle guard (fails if unapproved content could be public)
```

Knowledge engine (never publishes, never touches a database):

```bash
npm run kb:validate                 # extract → classify → relate → duplicate/conflict analysis → validate
npm run kb:bootstrap                # regenerate PENDING proposal SQL in database/bootstrap
npm run kb:snapshot -- <dir>        # write the offline baseline from packages exported from the PUBLIC API (approved only)
npm run kb:snapshot -- --empty      # reset the baseline to empty
npm run kb:check-bundle [dist]      # unapproved-content guard
npm run db:statements -- database/init.sql   # trigger-aware statement list (for consoles that cannot take whole files)
```

## Knowledge flow

source collection (`knowledge/acquire.ts`) → extraction (`extract.ts`) → classification (`classify.ts`, rule-based, not AI) → relationships (`relate.ts`) → validation (`shared/rlf.ts`) → **duplicate, conflict and outdated detection** (`duplicates.ts`) → **proposals** (`proposals.ts`, pending) → *(future)* owner review → approval → publication → public API → clients.

## Database

See [`database/README.md`](database/README.md). `init.sql` creates the schema, `delete.sql` removes everything (exceptional overhauls only), `bootstrap/` loads pending proposals. **Nothing is executed automatically; D1 operations require the owner's explicit decision.**

## Private content and the repository

`content/lessons/`, `content/reference/` and `database/bootstrap/` are listed in `.gitignore` so unapproved content is not pushed to a public repository by accident. If your repository is private and you want them versioned, remove those three lines. If anything was pushed earlier, it remains in git history until the history is rewritten.

## Validation status

See the *Validation* section of `docs/deployment.md`. In short: tests listed above passed in the author's offline sandbox using stand-ins for packages that could not be installed; **`npm ci`, `vite build`, real Hono, the Cloudflare Vite plugin, Wrangler and D1 have not been run.**

## Limitations

* The Code Playground cannot execute Luau.
* Content is AI-assisted and unreviewed until a human review is recorded; "published" means approved for display, not verified.
* Source links are "not machine-checked" until `kb sources --fetch` runs with network access.
* Learner data does not sync across devices (manual JSON export/restore only).


## Owner console

The private owner console is available at `/#/owner` after configuring the `OWNER_ADMIN_TOKEN` Worker secret. See [docs/owner-console.md](docs/owner-console.md) for setup, security behavior, supported operations, and current limitations. The learner website remains accountless.

## v0.5.0 in one paragraph

Discovery is no longer limited to a handful of official pages: the owner gives a starting point (any public https page, sitemap, feed or GitHub repository) and a layered, resumable engine follows links, feeds, sitemaps and `robots.txt` hints to find English-language educational and programming resources on any host, while respecting `robots.txt`, rate limits and access restrictions. Every candidate arrives **pending**, with an explanation and **licensing evidence** (exact URL, excerpt, scope, confidence, restrictions). Source approval, proposal approval and licensing clearance remain three separate owner decisions; nothing is ever approved, cleared or published automatically. See `docs/discovery-engine.md`, `docs/licensing-intelligence.md` and `docs/v0.5.0-implementation-report.md`.
