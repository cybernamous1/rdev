-- RDev Academy v0.4.0 -> v0.5.0 upgrade: adaptive global knowledge discovery and licensing intelligence (ADDITIVE ONLY).
-- Run on a database at schema 0.4.0, after a backup, only on explicit owner decision. NOT executed by any script in this repository:
--   wrangler d1 execute <db> --remote --file database/upgrade-0.5.0.sql
-- It only creates new tables, indexes and triggers (IF NOT EXISTS) and moves schema_info to 0.5.0. No existing table, row, trigger,
-- proposal, source or published package is changed, dropped, truncated or rewritten.
-- Repeatable: running it again on a 0.5.0 database changes nothing. The first statement is a pre-check: on any database that is not at
-- schema 0.4.0 / 0.5.0 it fails (NOT NULL violation) BEFORE anything is created. If any statement fails, stop and investigate; do not continue.
-- A fresh database should use init.sql (it contains the identical block between the BEGIN/END markers below).
INSERT OR REPLACE INTO schema_info (key, value)
  SELECT 'upgrade_0_5_0_precheck', CASE WHEN (SELECT value FROM schema_info WHERE key = 'schema_version') IN ('0.4.0','0.5.0')
    AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'discovered_sources') THEN 'ok' END;
-- ===== v0.5.0 BEGIN: adaptive discovery and licensing intelligence (additive) =====
-- Nothing here approves, trusts, extracts or publishes anything. discovered_sources (v0.4.0) stays THE candidate queue and sources the ledger;
-- these tables only add what v0.4.0 could not record: resumable crawl state, per-host politeness, per-candidate discovery metadata,
-- licensing EVIDENCE (detected, append-only) and licensing REVIEWS (owner decisions, append-only).
CREATE TABLE IF NOT EXISTS discovery_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL, root_url TEXT NOT NULL CHECK (root_url LIKE 'https://%'),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  lease_until INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(stats_json)),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON discovery_jobs(status, id DESC);
CREATE TABLE IF NOT EXISTS discovery_frontier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES discovery_jobs(id),
  url TEXT NOT NULL CHECK (url LIKE 'https://%'),
  kind TEXT NOT NULL CHECK (kind IN ('sitemap','feed','directory','page','repository')),
  via TEXT NOT NULL, origin TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0, reason TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','fetching','done','skipped','blocked','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0, note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (job_id, url));
CREATE INDEX IF NOT EXISTS idx_frontier_next ON discovery_frontier(job_id, status, not_before, score DESC);
CREATE TABLE IF NOT EXISTS host_policies (
  host TEXT PRIMARY KEY,
  robots_status TEXT NOT NULL CHECK (robots_status IN ('allow-all','rules','disallow-all')),
  robots_text TEXT, robots_fetched_at INTEGER NOT NULL, crawl_delay_sec REAL,
  sitemaps_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sitemaps_json)),
  last_fetch_at INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS discovered_source_meta (
  candidate_id INTEGER PRIMARY KEY REFERENCES discovered_sources(id),
  resource_type TEXT NOT NULL, language TEXT NOT NULL, language_confidence REAL NOT NULL DEFAULT 0,
  method TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0, canonical_url TEXT NOT NULL,
  content_hash TEXT NOT NULL, simhash TEXT NOT NULL, sh0 TEXT NOT NULL, sh1 TEXT NOT NULL, sh2 TEXT NOT NULL, sh3 TEXT NOT NULL,
  etag TEXT, last_modified TEXT,
  signals_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(signals_json)),
  job_id INTEGER REFERENCES discovery_jobs(id),
  fetched_at TEXT NOT NULL, last_checked_at TEXT, next_check_at INTEGER, check_failures INTEGER NOT NULL DEFAULT 0,
  change_state TEXT NOT NULL DEFAULT 'new' CHECK (change_state IN ('new','unchanged','minor-change','major-change','moved','gone','unreachable')));
CREATE INDEX IF NOT EXISTS idx_meta_sh0 ON discovered_source_meta(sh0);
CREATE INDEX IF NOT EXISTS idx_meta_sh1 ON discovered_source_meta(sh1);
CREATE INDEX IF NOT EXISTS idx_meta_sh2 ON discovered_source_meta(sh2);
CREATE INDEX IF NOT EXISTS idx_meta_sh3 ON discovered_source_meta(sh3);
CREATE INDEX IF NOT EXISTS idx_meta_hash ON discovered_source_meta(content_hash);
CREATE TABLE IF NOT EXISTS license_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES discovered_sources(id),
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('open-source','creative-commons','public-domain','custom-permission','proprietary','copyright-notice','terms-reference','unknown')),
  identifier TEXT, label TEXT NOT NULL,
  evidence_url TEXT NOT NULL CHECK (evidence_url LIKE 'https://%'), license_url TEXT,
  excerpt TEXT NOT NULL, method TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('page','site','code','content','repository','unspecified')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  restrictions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(restrictions_json)),
  indicates TEXT NOT NULL CHECK (indicates IN ('permissive','conditional','restricted','unknown')),
  notes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(notes_json)),
  detector_version TEXT NOT NULL, content_hash TEXT, detected_at TEXT NOT NULL,
  UNIQUE (candidate_id, fingerprint));
CREATE INDEX IF NOT EXISTS idx_evidence_candidate ON license_evidence(candidate_id, confidence DESC);
CREATE TABLE IF NOT EXISTS license_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES discovered_sources(id),
  decision TEXT NOT NULL CHECK (decision IN ('cleared','cleared-with-conditions','denied')),
  basis TEXT NOT NULL CHECK (basis IN ('detected-evidence','owner-written-permission','owner-judgement')),
  scope TEXT NOT NULL CHECK (length(trim(scope)) > 0),
  permits_display INTEGER NOT NULL DEFAULT 0 CHECK (permits_display IN (0,1)),
  permits_modification INTEGER NOT NULL DEFAULT 0 CHECK (permits_modification IN (0,1)),
  permits_redistribution INTEGER NOT NULL DEFAULT 0 CHECK (permits_redistribution IN (0,1)),
  permits_commercial INTEGER NOT NULL DEFAULT 0 CHECK (permits_commercial IN (0,1)),
  attribution_text TEXT, conditions TEXT,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
  assessment_status TEXT NOT NULL, acknowledged_ambiguity INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_ambiguity IN (0,1)),
  note TEXT NOT NULL CHECK (length(trim(note)) >= 10),
  reviewed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (decision = 'denied' OR permits_display = 1));
CREATE INDEX IF NOT EXISTS idx_reviews_candidate ON license_reviews(candidate_id, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_evidence_no_update BEFORE UPDATE ON license_evidence BEGIN SELECT RAISE(ABORT,'license_evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_evidence_no_delete BEFORE DELETE ON license_evidence BEGIN SELECT RAISE(ABORT,'license_evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_reviews_no_update BEFORE UPDATE ON license_reviews BEGIN SELECT RAISE(ABORT,'license_reviews are append-only: record a new decision instead'); END;
CREATE TRIGGER IF NOT EXISTS trg_reviews_no_delete BEFORE DELETE ON license_reviews BEGIN SELECT RAISE(ABORT,'license_reviews are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_reviews_basis_evidence BEFORE INSERT ON license_reviews
  WHEN NEW.decision <> 'denied' AND NEW.basis = 'detected-evidence'
    AND ((SELECT COUNT(*) FROM json_each(NEW.evidence_ids_json)) = 0
      OR EXISTS (SELECT 1 FROM json_each(NEW.evidence_ids_json) j WHERE NOT EXISTS (SELECT 1 FROM license_evidence e WHERE e.id = j.value AND e.candidate_id = NEW.candidate_id)))
  BEGIN SELECT RAISE(ABORT,'clearance on detected evidence must cite evidence recorded for this candidate'); END;
CREATE TRIGGER IF NOT EXISTS trg_reviews_ambiguity BEFORE INSERT ON license_reviews
  WHEN NEW.decision <> 'denied' AND NEW.assessment_status IN ('no-evidence','ambiguous','conflicting','restricted') AND NEW.acknowledged_ambiguity = 0
  BEGIN SELECT RAISE(ABORT,'ambiguous, conflicting or restrictive licensing cannot be cleared without an explicit owner acknowledgement'); END;
CREATE TRIGGER IF NOT EXISTS trg_reviews_conditions BEFORE INSERT ON license_reviews
  WHEN NEW.decision = 'cleared-with-conditions' AND (NEW.conditions IS NULL OR length(trim(NEW.conditions)) = 0)
  BEGIN SELECT RAISE(ABORT,'cleared-with-conditions requires the conditions to be written down'); END;
-- ===== v0.5.0 END =====

UPDATE schema_info SET value = '0.5.0' WHERE key = 'schema_version' AND value = '0.4.0';
INSERT OR IGNORE INTO schema_info (key, value) VALUES ('upgraded_to_0_5_0_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
DELETE FROM schema_info WHERE key = 'upgrade_0_5_0_precheck';
INSERT INTO security_events (event, detail) SELECT 'db_upgraded', 'schema 0.5.0 discovery engine and licensing tables' WHERE NOT EXISTS (SELECT 1 FROM security_events WHERE event = 'db_upgraded' AND detail LIKE 'schema 0.5.0%');
