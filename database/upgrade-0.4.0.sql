-- RDev Academy v0.3.0 -> v0.4.0 upgrade: knowledge discovery and acquisition (ADDITIVE ONLY).
-- Run ONCE on a database that was initialized with the v0.3.0 init.sql. It only creates new tables, indexes and
-- triggers and updates schema_info; it changes no existing table, row, trigger or published content.
-- NOT executed by any script in this repository. Take a backup (wrangler d1 export / Time Travel) first, then e.g.:
--   wrangler d1 execute <db> --remote --file database/upgrade-0.4.0.sql
-- A fresh database should use init.sql instead (it already contains everything below).
-- Fails loudly if run twice (no IF NOT EXISTS).
-- ================= v0.4.0: KNOWLEDGE DISCOVERY AND ACQUISITION (additive) =================
-- Discovery never approves anything.  discovered_sources are CANDIDATES.  A candidate becomes a trusted ledger
-- source (a row in `sources`) only when the owner approves it, and content may be extracted only from such
-- sources.  Extracted content enters the existing `proposals` queue as PENDING (origin 'pipeline') and is
-- published only through the existing approve -> verify -> publish flow.
CREATE TABLE discovery_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seed_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('completed','failed')),
  pages_fetched INTEGER NOT NULL DEFAULT 0, links_found INTEGER NOT NULL DEFAULT 0, new_candidates INTEGER NOT NULL DEFAULT 0,
  note TEXT, started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE discovered_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE CHECK (url LIKE 'https://%'),
  host TEXT NOT NULL, title TEXT NOT NULL, publisher TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('official-docs','language','repository')),
  suggested_path TEXT, relevance INTEGER NOT NULL DEFAULT 0,
  discovered_via TEXT NOT NULL, run_id INTEGER REFERENCES discovery_runs(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_at TEXT, review_note TEXT,
  registered_source_id TEXT REFERENCES sources(id),
  CHECK (status = 'pending' OR reviewed_at IS NOT NULL),
  CHECK (status <> 'rejected' OR (review_note IS NOT NULL AND length(trim(review_note)) > 0)),
  CHECK (status <> 'approved' OR registered_source_id IS NOT NULL),
  CHECK (status = 'approved' OR registered_source_id IS NULL));
CREATE INDEX idx_discovered_status ON discovered_sources(status, relevance DESC);
CREATE TABLE extraction_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  status TEXT NOT NULL CHECK (status IN ('new','changed','unchanged','duplicate','unclassified','failed')),
  content_hash TEXT, http_status INTEGER, title TEXT, proposals_created INTEGER NOT NULL DEFAULT 0, note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (status = 'failed' OR content_hash IS NOT NULL));
CREATE INDEX idx_extraction_source ON extraction_runs(source_id, id DESC);
CREATE TABLE proposal_provenance (
  proposal_id INTEGER PRIMARY KEY REFERENCES proposals(id),
  source_id TEXT NOT NULL REFERENCES sources(id), source_url TEXT NOT NULL, content_hash TEXT NOT NULL,
  extraction_run_id INTEGER NOT NULL REFERENCES extraction_runs(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX idx_provenance_source ON proposal_provenance(source_id);

CREATE TRIGGER trg_discovered_starts_pending BEFORE INSERT ON discovered_sources
  WHEN NEW.status <> 'pending' OR NEW.reviewed_at IS NOT NULL OR NEW.registered_source_id IS NOT NULL
  BEGIN SELECT RAISE(ABORT,'discovered sources must start pending: discovery is not approval'); END;
CREATE TRIGGER trg_discovered_no_delete BEFORE DELETE ON discovered_sources BEGIN SELECT RAISE(ABORT,'discovered sources cannot be deleted'); END;
CREATE TRIGGER trg_discovered_identity_frozen BEFORE UPDATE OF url, host, publisher, category, discovered_via, first_seen_at ON discovered_sources
  BEGIN SELECT RAISE(ABORT,'discovered source identity is immutable'); END;
CREATE TRIGGER trg_discovered_transition BEFORE UPDATE OF status ON discovered_sources
  WHEN NEW.status <> OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('approved','rejected'))
  BEGIN SELECT RAISE(ABORT,'invalid discovered source status transition'); END;
CREATE TRIGGER trg_discovered_review_frozen BEFORE UPDATE OF reviewed_at, review_note, registered_source_id ON discovered_sources
  WHEN OLD.status <> 'pending'
  BEGIN SELECT RAISE(ABORT,'a reviewed discovered source cannot be changed'); END;
CREATE TRIGGER trg_discovered_approval_registered BEFORE UPDATE OF status ON discovered_sources
  WHEN NEW.status = 'approved' AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = NEW.registered_source_id AND s.url = NEW.url)
  BEGIN SELECT RAISE(ABORT,'approval must register the same URL in the source ledger'); END;
CREATE TRIGGER trg_extraction_requires_approved_source BEFORE INSERT ON extraction_runs
  WHEN NOT EXISTS (SELECT 1 FROM discovered_sources d WHERE d.registered_source_id = NEW.source_id AND d.status = 'approved')
  BEGIN SELECT RAISE(ABORT,'extraction requires an owner-approved source'); END;
CREATE TRIGGER trg_extraction_no_update BEFORE UPDATE ON extraction_runs BEGIN SELECT RAISE(ABORT,'extraction_runs are append-only'); END;
CREATE TRIGGER trg_extraction_no_delete BEFORE DELETE ON extraction_runs BEGIN SELECT RAISE(ABORT,'extraction_runs are append-only'); END;
CREATE TRIGGER trg_provenance_requires_approved_source BEFORE INSERT ON proposal_provenance
  WHEN NOT EXISTS (SELECT 1 FROM discovered_sources d WHERE d.registered_source_id = NEW.source_id AND d.status = 'approved')
    OR NOT EXISTS (SELECT 1 FROM proposals p WHERE p.id = NEW.proposal_id AND p.status = 'pending')
  BEGIN SELECT RAISE(ABORT,'provenance requires an owner-approved source and a pending proposal'); END;
CREATE TRIGGER trg_provenance_no_update BEFORE UPDATE ON proposal_provenance BEGIN SELECT RAISE(ABORT,'proposal_provenance is immutable'); END;
CREATE TRIGGER trg_provenance_no_delete BEFORE DELETE ON proposal_provenance BEGIN SELECT RAISE(ABORT,'proposal_provenance is immutable'); END;

UPDATE schema_info SET value = '0.4.0' WHERE key = 'schema_version';
INSERT INTO schema_info (key, value) VALUES ('upgraded_to_0_4_0_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO security_events (event, detail) VALUES ('db_upgraded','schema 0.4.0 discovery tables');
