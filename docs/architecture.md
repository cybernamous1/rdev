# Architecture (v0.3.0)

```
                    ┌────────────── owner-only (/#/owner) ───────────────┐
 sources ─► acquire ─► extract ─► classify ─► relate ─► validate ─► duplicates/conflicts ─► PROPOSALS (pending, D1)
                                                                                    │ review ► approve ► publish
 learner browser                                                                    ▼ (owner console)
 ┌──────────────────────────┐   background    ┌──────────────────────────────────────────────┐
 │ React app (Vite, Tailwind)│ ───────────────►│ Cloudflare Worker (Hono)  /api/v1/*  read-only │
 │ IndexedDB: learner data   │◄─────────────── │ health · packages · packages/:id/:version ·    │
 │ + stored approved packages│  ETag / 304      │ sources   (serve ONLY packages.current_version)│
 └──────────────────────────┘                 └───────────────┬──────────────────────────────┘
   bundled snapshot (approved only; empty today)               │ D1 (single authoritative database)
```

* **Startup** loads only local things. **Sync** runs afterwards, revalidates the manifest every time (ETag), validates each package (schema + checksum + manifest agreement) and follows the server's *current* version even when it is lower (rollback).
* **Precedence per package id:** platform > local import > bundled snapshot. Version numbers are not compared because rollbacks lower them.
* **Public safety:** proposals, entry history, admin and security tables are never queried by public routes; `/api/admin/*` requires the owner session (401 otherwise) and is never cached; public writes are 405; `npm run build` ends with a bundle guard.
* **Dependencies:** react, react-dom, hono; build tooling: Vite, Tailwind v4, Cloudflare Vite plugin, TypeScript, Wrangler. No KV, Durable Objects, R2, queues or extra databases.
* **Future:** owner authentication (Worker secret, HttpOnly session cookies), proposal review UI, publish/rollback endpoints, scheduled pipeline, dedicated Lexus Interactive infrastructure for the pipeline (Cloudflare stays in front).
