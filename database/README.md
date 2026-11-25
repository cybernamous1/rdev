# Database (Cloudflare D1)

**None of these files is executed by any script in this repository. Running them against a real D1 database requires the owner's explicit decision.**

| File | Purpose |
| --- | --- |
| `init.sql` | Creates the complete v0.5.0 schema and initial system records on an **empty** database. Fails loudly (before creating anything) if legacy v0.1.0/v0.2.0 tables exist. |
| `upgrade-0.4.0.sql` | **Additive upgrade** of an existing v0.3.0 database (discovery tables/triggers). Run once, after a backup, only on explicit owner decision. Not needed for a fresh `init.sql`. |
| `upgrade-0.5.0.sql` | **Additive, repeatable upgrade** of a v0.4.0 database: six new tables (discovery jobs/frontier, host policies, per-candidate discovery metadata, licensing evidence, licensing reviews), their indexes and append-only/safeguard triggers. Refuses (before creating anything) to run on a database that is not at 0.4.0/0.5.0. Run once, after a backup, only on explicit owner decision. |
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

## v0.4.0 discovery tables

`discovery_runs`, `discovered_sources` (candidate queue; triggers keep it pending until the owner approves and registers the URL in `sources`), `extraction_runs` (append-only; requires an approved source) and `proposal_provenance` (immutable link from a pipeline proposal to its source and extraction hash). No existing table or trigger changed.

## Upgrading v0.4.0 -> v0.5.0 (owner decision required; nothing runs this automatically)

1. Back up: `wrangler d1 export <db> --remote --output backup-0.4.0.sql`.
2. Rehearse on a **copy** first (local: `wrangler d1 execute <copy> --local --file database/upgrade-0.4.0.sql` is NOT needed if the copy is already 0.4.0; then `--file database/upgrade-0.5.0.sql`). The repository tests do this against SQLite; they do not prove D1 behaviour.
3. Apply: `wrangler d1 execute <db> --remote --file database/upgrade-0.5.0.sql`. Stop at the first error; the first statement is a pre-check that fails before anything is created on a wrong baseline.
4. Verify: `SELECT value FROM schema_info WHERE key='schema_version'` returns `0.5.0`; row counts of `sources`, `proposals`, `packages`, `discovered_sources` are unchanged.
5. Running the file again is harmless (all statements are `IF NOT EXISTS` / `INSERT OR IGNORE`). There is no automatic rollback: the new tables are independent, so the v0.4.0 Worker keeps working if you restore the backup or simply ignore them.

New tables and why each was necessary (everything else is reused): `discovery_jobs` / `discovery_frontier` (v0.4.0 `discovery_runs` can only record finished runs, so interrupted/resumable crawling had nowhere to live); `host_policies` (robots.txt cache and per-host politeness); `discovered_source_meta` (type, language, fingerprints, ETag, change state for each existing `discovered_sources` row; that table's `category` CHECK cannot be widened without recreating it, which is forbidden); `license_evidence` (append-only detections); `license_reviews` (append-only owner clearance decisions).
