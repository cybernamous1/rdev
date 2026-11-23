# Database (Cloudflare D1)

**None of these files is executed by any script in this repository. Running them against a real D1 database requires the owner's explicit decision.**

| File | Purpose |
| --- | --- |
| `init.sql` | Creates the complete v0.3.0 schema and initial system records on an **empty** database. Fails loudly (before creating anything) if legacy v0.1.0/v0.2.0 tables exist. |
| `delete.sql` | **Destructive.** Deletes every table and all contents, in foreign-key-safe order. For exceptional major revamps only. Back up first. |
| `bootstrap/` | Generated (git-ignored): `00-sources.sql` + one file per learning path. Creates **pending** proposals only. Re-runnable. |
| `tests/` | `test_db.py` (113 checks), `checksum.mjs`, legacy fixtures. |

Order for a fresh database (after authorization): `init.sql` → `bootstrap/00-sources.sql` → the other bootstrap files. There is no migration system and no `reset.sql`.

## Model

* `proposals` (pending → approved → published; rejected/superseded terminal) with an automatic `proposal_events` audit trail; review decisions cannot be edited silently.
* `entry_versions` and `package_versions` are immutable; `package_version_entries` defines which entry versions form each package version.
* `packages.current_version` is the single publication pointer. Moving it re-verifies body↔membership↔counts and proposal coverage in triggers, inside one atomic batch. Rollback = a `publications` row + pointer move to an older published version.
* `sources` / `source_snapshots` (hashes only). `admin_sessions`, `login_attempts`, `security_events` exist for the future owner area.
* Contract: entry version *N* appears in an RLF body as `entry.version = "N.0.0"`.

## What SQL cannot enforce (the Worker must)

SHA-256 of package bodies, numeric version ordering and part limits (`shared/semver.ts`), RLF schema validation, and sending the whole publication as one `db.batch([...])`.

## D1 compatibility (not verified on a live D1)

Only documented SQLite features are used. Prefer `wrangler d1 execute <db> --remote --file database/init.sql`. If a dashboard console rejects the multi-statement file (trigger bodies contain semicolons), use `npm run db:statements -- database/init.sql` to list the statements and run them one at a time. `npm test` checks that every statement is far below the statement-size limit, contains no PRAGMA/BEGIN/COMMIT, and that running statement-by-statement equals running the whole file (in SQLite).
