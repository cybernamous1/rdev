-- RDev Academy v0.4.0 — DELETE ALL DATABASE OBJECTS (DESTRUCTIVE)
-- ============================================================================
-- WARNING: Permanently deletes ALL RDev Academy tables and every row in them:
--   published knowledge, entry/package version history, proposals and their audit
--   trail, publication history, admin sessions and security logs. Indexes and
--   triggers on these tables are removed with them. It also removes the legacy
--   v0.1.0 / v0.2.0 tables. It does not touch Cloudflare's internal tables (_cf_*).
--   It cannot be undone except by restoring a backup: run `wrangler d1 export`
--   (or confirm D1 Time Travel) BEFORE executing it.
-- Intended ONLY for exceptional major revamps or complete overhauls. NOT executed automatically
-- by any script in this repository. Run only after explicit owner authorization, then run
-- init.sql immediately afterwards if the database is to be reused.
--
-- ORDER: D1 enforces foreign keys, so referencing (child) tables are dropped before the
-- tables they reference. database/tests/test_db.py derives the foreign-key graph from the live
-- schema and fails if this order is ever wrong. The legacy v0.1.0/v0.2.0 schemas declared no
-- foreign keys, so their position here is not order-sensitive; it is verified anyway.
-- ============================================================================
DROP TABLE IF EXISTS license_reviews;
DROP TABLE IF EXISTS license_evidence;
DROP TABLE IF EXISTS discovered_source_meta;
DROP TABLE IF EXISTS discovery_frontier;
DROP TABLE IF EXISTS discovery_jobs;
DROP TABLE IF EXISTS host_policies;
DROP TABLE IF EXISTS proposal_provenance;
DROP TABLE IF EXISTS extraction_runs;
DROP TABLE IF EXISTS discovered_sources;
DROP TABLE IF EXISTS discovery_runs;
DROP TABLE IF EXISTS security_events;
DROP TABLE IF EXISTS login_attempts;
DROP TABLE IF EXISTS admin_sessions;
DROP TABLE IF EXISTS publication_proposals;
DROP TABLE IF EXISTS publications;
DROP TABLE IF EXISTS package_version_entries;
DROP TABLE IF EXISTS entry_version_sources;
DROP TABLE IF EXISTS entry_versions;
DROP TABLE IF EXISTS proposal_events;
DROP TABLE IF EXISTS entries;
DROP TABLE IF EXISTS proposals;
DROP TABLE IF EXISTS package_versions;
DROP TABLE IF EXISTS packages;
DROP TABLE IF EXISTS source_snapshots;
DROP TABLE IF EXISTS sources;
DROP TABLE IF EXISTS schema_info;
-- Legacy v0.1.0 / v0.2.0 objects (no foreign keys)
DROP TABLE IF EXISTS entry_sources;
DROP TABLE IF EXISTS relationships;
DROP TABLE IF EXISTS rlf_packages;
DROP TABLE IF EXISTS knowledge_items;
