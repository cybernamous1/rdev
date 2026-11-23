# Deployment and validation (v0.3.0)

**Nothing has been deployed, pushed, published or executed against Cloudflare.**

## Validation matrix

| Check | Status |
| --- | --- |
| TypeScript type-check | Passed in the author's sandbox **with stand-in typings** for React and Hono (real `@types/react`, Hono and `@cloudflare/workers-types` were not installable). Re-run `npm run typecheck`. |
| `npm test` (27 tests) | Passed. Hono routes ran against a **local stand-in**, not real Hono. Worker queries ran against SQLite 3.54 (`node:sqlite`) loaded with the real `init.sql`. |
| `npm run test:db` (113 checks) | Passed in SQLite 3.45 (Python). Not D1. |
| Browser tests (69 checks, Chromium) | Passed against an esbuild bundle with real Tailwind v4 compiler output and the real Worker code + stand-in Hono over SQLite. The harness is not part of the repository. |
| `npm ci` / `vite build` / `npm run build` | **NOT RUN.** Must be run in your environment. |
| Real Hono, `@cloudflare/vite-plugin`, `wrangler dev` / `wrangler deploy` | **NOT RUN.** Check especially whether `wrangler.jsonc` needs `assets.directory` with the Vite plugin. |
| Cloudflare D1 execution of `init.sql` / bootstrap | **NOT RUN.** See `database/README.md`. |

## When you are ready (each step needs your decision)

1. `npm ci && npm run typecheck && npm test && npm run test:db && npm run build`, and `npm run dev` for local D1 emulation.
2. Create the D1 database; put its id into `wrangler.jsonc` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`) or remove the `d1_databases` block to run without a database.
3. Initialize and bootstrap it (see `database/README.md`). Pending proposals remain private.
4. Connect the repository to a Worker (Workers Builds): build `npm run build`, deploy `npx wrangler deploy`. The site works with an empty database.
5. Later phases: owner authentication, review/publish UI, pipeline.
