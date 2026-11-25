-- RDev Academy v0.5.0 — database initialization.
-- Run once on an EMPTY database (run delete.sql first only for an exceptional full overhaul).
-- Deliberately NO "IF NOT EXISTS": on a database that still has legacy tables this script
-- fails loudly instead of silently mixing schemas.
-- D1 is the single authoritative store for published knowledge.
--
-- LIFECYCLE
--   proposal(pending) -> approved -> published.  Entry versions can only be created from an
--   APPROVED proposal.  A publication adds an immutable package version, its membership rows and
--   a publication record, then moves packages.current_version.  The pointer move is the final
--   gate: triggers re-verify the whole publication, so an invalid publication aborts the
--   entire D1 batch (D1 batches are atomic) and nothing changes.
--   Rollback = a 'rollback' publication record + pointer move to an earlier published version.
--   Public reads serve ONLY packages.current_version.
--
-- WHAT SQL CANNOT CHECK (done by the Worker, inside the same batch, before it is sent):
--   * SHA-256 of the package body (SQLite has no SHA-256). SQL only guarantees that the checksum
--     column equals the checksum field inside the body JSON.
--   * Semantic ordering of versions (SQL guarantees well-formed x.y.z only) and numeric ranges.
--   * RLF schema validation of the body.
-- CONTRACT: entry version N of an entry appears in an RLF body as entry.version = 'N.0.0'.
-- Timestamps: ISO-8601 UTC text ('YYYY-MM-DDTHH:MM:SS.sssZ').
--
-- CLOUDFLARE D1 NOTES (not verified against a live D1 in this repository):
--   * Uses only SQLite features D1 documents: JSON functions, triggers with RAISE(ABORT), partial/unique
--     indexes, CHECK constraints and foreign keys (D1 always enforces foreign keys).
--   * No BEGIN/COMMIT/PRAGMA statements; the Worker must send publish steps as one db.batch([...]),
--     which D1 runs atomically.
--   * Trigger bodies contain semicolons. Prefer `wrangler d1 execute <db> --remote --file database/init.sql`.
--     If you must paste into a dashboard console and it rejects the file, run `npm run db:statements --
--     database/init.sql` to list the statements (trigger-aware) and run them one at a time.
--   * Every statement stays far below D1's per-statement size limit (checked by `npm test`).

-- GUARD: fail loudly, before anything is created, if legacy v0.1.0/v0.2.0 tables are still present.
-- (A view cannot be created over an existing table of the same name; the view is dropped straight away.)
CREATE VIEW knowledge_items AS SELECT 1;  DROP VIEW knowledge_items;
CREATE VIEW rlf_packages AS SELECT 1;     DROP VIEW rlf_packages;
CREATE VIEW relationships AS SELECT 1;    DROP VIEW relationships;
CREATE VIEW entry_sources AS SELECT 1;    DROP VIEW entry_sources;

CREATE TABLE schema_info (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- ---------- Sources ----------
CREATE TABLE sources (
  id TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9]*' AND id NOT GLOB '*[^a-z0-9-]*'),
  label TEXT NOT NULL, url TEXT NOT NULL UNIQUE CHECK (url LIKE 'https://%'),
  publisher TEXT NOT NULL, license TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE source_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('retrieved','failed')),
  http_status INTEGER, content_hash TEXT, retrieved_at TEXT NOT NULL, note TEXT,
  CHECK (status = 'failed' OR content_hash IS NOT NULL));
CREATE INDEX idx_snapshots_source ON source_snapshots(source_id, retrieved_at DESC);

-- ---------- Packages ----------
CREATE TABLE packages (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
  current_version TEXT CHECK (current_version IS NULL OR (current_version NOT GLOB '*[^0-9.]*' AND current_version GLOB '[0-9]*.[0-9]*.[0-9]*' AND current_version NOT GLOB '*..*' AND current_version NOT GLOB '.*' AND current_version NOT GLOB '*.' AND (length(current_version) - length(replace(current_version,'.',''))) = 2 AND current_version NOT GLOB '0[0-9]*' AND current_version NOT GLOB '*.0[0-9]*' AND length(current_version) <= 29)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE package_versions (
  package_id TEXT NOT NULL REFERENCES packages(id),
  version TEXT NOT NULL CHECK (version NOT GLOB '*[^0-9.]*' AND version GLOB '[0-9]*.[0-9]*.[0-9]*' AND version NOT GLOB '*..*' AND version NOT GLOB '.*' AND version NOT GLOB '*.' AND (length(version) - length(replace(version,'.',''))) = 2 AND version NOT GLOB '0[0-9]*' AND version NOT GLOB '*.0[0-9]*' AND length(version) <= 29),
  checksum TEXT NOT NULL, entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (package_id, version),
  CHECK (json_valid(body) AND json_type(body,'$.entries') = 'array'
         AND json_array_length(body,'$.entries') = entry_count
         AND json_extract(body,'$.id') = package_id
         AND json_extract(body,'$.version') = version
         AND json_extract(body,'$.checksum') = checksum));

-- ---------- Entries and immutable versions ----------
CREATE TABLE entries (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('lesson','reference')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('new','update','retire')),
  target_entry_id TEXT NOT NULL,
  base_version INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','published','superseded')),
  title TEXT NOT NULL, rationale TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)), payload_hash TEXT NOT NULL,
  diff_json TEXT CHECK (diff_json IS NULL OR json_valid(diff_json)),
  analysis_json TEXT CHECK (analysis_json IS NULL OR json_valid(analysis_json)),  -- validation, duplicate and conflict findings for owner review
  origin TEXT NOT NULL CHECK (origin IN ('bootstrap','pipeline','owner')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_at TEXT, review_note TEXT,
  CHECK ((kind = 'new' AND base_version IS NULL) OR (kind <> 'new' AND base_version IS NOT NULL)),
  CHECK (status IN ('pending','superseded') OR reviewed_at IS NOT NULL),
  CHECK (status <> 'rejected' OR (review_note IS NOT NULL AND length(trim(review_note)) > 0)),
  UNIQUE (kind, target_entry_id, payload_hash));
CREATE INDEX idx_proposals_status ON proposals(status, created_at DESC);
CREATE INDEX idx_proposals_target ON proposals(target_entry_id);
-- Every status change is recorded by a trigger, so the audit trail cannot be bypassed.
CREATE TABLE proposal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  from_status TEXT, to_status TEXT NOT NULL, decided_at TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX idx_prop_events ON proposal_events(proposal_id, id);

CREATE TABLE entry_versions (
  entry_id TEXT NOT NULL REFERENCES entries(id), version INTEGER NOT NULL CHECK (version >= 1),
  path TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('Beginner','Intermediate','Advanced')),
  minutes INTEGER NOT NULL CHECK (minutes > 0), tags TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  search_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft','ai-assisted','under-review','verified','published','outdated','archived')),
  origin TEXT NOT NULL CHECK (origin IN ('original','ai-assisted','imported')),
  review_json TEXT CHECK (review_json IS NULL OR json_valid(review_json)),
  content_hash TEXT NOT NULL,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (entry_id, version),
  CHECK (status <> 'verified' OR review_json IS NOT NULL));
CREATE INDEX idx_entver_proposal ON entry_versions(proposal_id);
CREATE TABLE entry_version_sources (
  entry_id TEXT NOT NULL, version INTEGER NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id),
  PRIMARY KEY (entry_id, version, source_id),
  FOREIGN KEY (entry_id, version) REFERENCES entry_versions(entry_id, version));
CREATE TABLE package_version_entries (
  package_id TEXT NOT NULL, package_version TEXT NOT NULL,
  entry_id TEXT NOT NULL, entry_version INTEGER NOT NULL,
  PRIMARY KEY (package_id, package_version, entry_id),
  FOREIGN KEY (package_id, package_version) REFERENCES package_versions(package_id, version),
  FOREIGN KEY (entry_id, entry_version) REFERENCES entry_versions(entry_id, version));
CREATE INDEX idx_pve_entry ON package_version_entries(entry_id, entry_version);

-- ---------- Publication history ----------
CREATE TABLE publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id TEXT NOT NULL,
  version TEXT NOT NULL CHECK (version NOT GLOB '*[^0-9.]*' AND version GLOB '[0-9]*.[0-9]*.[0-9]*' AND version NOT GLOB '*..*' AND version NOT GLOB '.*' AND version NOT GLOB '*.' AND (length(version) - length(replace(version,'.',''))) = 2 AND version NOT GLOB '0[0-9]*' AND version NOT GLOB '*.0[0-9]*' AND length(version) <= 29),
  previous_version TEXT CHECK (previous_version IS NULL OR (previous_version NOT GLOB '*[^0-9.]*' AND previous_version GLOB '[0-9]*.[0-9]*.[0-9]*' AND previous_version NOT GLOB '*..*' AND previous_version NOT GLOB '.*' AND previous_version NOT GLOB '*.' AND (length(previous_version) - length(replace(previous_version,'.',''))) = 2 AND previous_version NOT GLOB '0[0-9]*' AND previous_version NOT GLOB '*.0[0-9]*' AND length(previous_version) <= 29)),
  action TEXT NOT NULL CHECK (action IN ('publish','rollback')), note TEXT,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (package_id, version) REFERENCES package_versions(package_id, version),
  CHECK (previous_version IS NOT version));
CREATE UNIQUE INDEX idx_publish_once ON publications(package_id, version) WHERE action = 'publish';
CREATE INDEX idx_publications_pkg ON publications(package_id, id DESC);
CREATE TABLE publication_proposals (
  publication_id INTEGER NOT NULL REFERENCES publications(id),
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  PRIMARY KEY (publication_id, proposal_id));

-- ---------- Owner administration ----------
CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY, token_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL, idle_expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT, revoked_reason TEXT, ip_hash TEXT, ua_hash TEXT);
CREATE INDEX idx_sessions_expiry ON admin_sessions(absolute_expires_at);
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ip_hash TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0,1)),
  attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX idx_attempts_ip ON login_attempts(ip_hash, attempted_at DESC);
CREATE INDEX idx_attempts_time ON login_attempts(attempted_at);
CREATE TABLE security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 64),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','critical')),
  session_id TEXT, ip_hash TEXT, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX idx_security_time ON security_events(created_at DESC);

-- ================= TRIGGERS =================
-- Immutability / append-only
CREATE TRIGGER trg_package_versions_no_update BEFORE UPDATE ON package_versions BEGIN SELECT RAISE(ABORT,'package_versions are immutable'); END;
CREATE TRIGGER trg_package_versions_no_delete BEFORE DELETE ON package_versions BEGIN SELECT RAISE(ABORT,'package_versions are immutable'); END;
CREATE TRIGGER trg_entry_versions_no_update BEFORE UPDATE ON entry_versions BEGIN SELECT RAISE(ABORT,'entry_versions are immutable'); END;
CREATE TRIGGER trg_entry_versions_no_delete BEFORE DELETE ON entry_versions BEGIN SELECT RAISE(ABORT,'entry_versions are immutable'); END;
CREATE TRIGGER trg_package_version_entries_no_update BEFORE UPDATE ON package_version_entries BEGIN SELECT RAISE(ABORT,'package membership is immutable'); END;
CREATE TRIGGER trg_package_version_entries_no_delete BEFORE DELETE ON package_version_entries BEGIN SELECT RAISE(ABORT,'package membership is immutable'); END;
CREATE TRIGGER trg_publications_no_update BEFORE UPDATE ON publications BEGIN SELECT RAISE(ABORT,'publications are append-only'); END;
CREATE TRIGGER trg_publications_no_delete BEFORE DELETE ON publications BEGIN SELECT RAISE(ABORT,'publications are append-only'); END;
CREATE TRIGGER trg_security_events_no_update BEFORE UPDATE ON security_events BEGIN SELECT RAISE(ABORT,'security_events are append-only'); END;
CREATE TRIGGER trg_security_events_no_delete BEFORE DELETE ON security_events BEGIN SELECT RAISE(ABORT,'security_events are append-only'); END;
CREATE TRIGGER trg_proposal_events_no_update BEFORE UPDATE ON proposal_events BEGIN SELECT RAISE(ABORT,'proposal_events are append-only'); END;
CREATE TRIGGER trg_proposal_events_no_delete BEFORE DELETE ON proposal_events BEGIN SELECT RAISE(ABORT,'proposal_events are append-only'); END;

-- ---------- Proposal lifecycle (pending -> approved|rejected|superseded; approved -> published|rejected|superseded) ----------
CREATE TRIGGER trg_prop_no_delete BEFORE DELETE ON proposals BEGIN SELECT RAISE(ABORT,'proposals cannot be deleted'); END;
CREATE TRIGGER trg_prop_starts_pending BEFORE INSERT ON proposals
  WHEN NEW.status <> 'pending' OR NEW.reviewed_at IS NOT NULL OR NEW.review_note IS NOT NULL
  BEGIN SELECT RAISE(ABORT,'new proposals must start pending and unreviewed'); END;
CREATE TRIGGER trg_prop_created AFTER INSERT ON proposals
  BEGIN INSERT INTO proposal_events (proposal_id, from_status, to_status) VALUES (NEW.id, NULL, 'pending'); END;
CREATE TRIGGER trg_prop_content_frozen BEFORE UPDATE OF kind, target_entry_id, base_version, title, rationale, payload_json, payload_hash, diff_json, analysis_json, origin, created_at ON proposals
  BEGIN SELECT RAISE(ABORT,'proposal content is immutable'); END;
CREATE TRIGGER trg_prop_transition BEFORE UPDATE OF status ON proposals
  WHEN NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending'  AND NEW.status IN ('approved','rejected','superseded'))
    OR (OLD.status = 'approved' AND NEW.status IN ('published','rejected','superseded')))
  BEGIN SELECT RAISE(ABORT,'invalid proposal status transition'); END;
-- reviewed_at / review_note may only be written together with an approve or reject decision.
CREATE TRIGGER trg_prop_review_frozen BEFORE UPDATE OF reviewed_at, review_note ON proposals
  WHEN NOT (NEW.status <> OLD.status AND NEW.status IN ('approved','rejected'))
  BEGIN SELECT RAISE(ABORT,'review metadata can only change with an approve/reject decision'); END;
CREATE TRIGGER trg_prop_audit AFTER UPDATE OF status ON proposals
  WHEN NEW.status <> OLD.status
  BEGIN INSERT INTO proposal_events (proposal_id, from_status, to_status, decided_at, note)
        VALUES (NEW.id, OLD.status, NEW.status, NEW.reviewed_at, NEW.review_note); END;

-- ---------- Entry versions only from approved, non-stale proposals ----------
CREATE TRIGGER trg_entver_requires_approval BEFORE INSERT ON entry_versions
  WHEN NOT EXISTS (SELECT 1 FROM proposals p WHERE p.id = NEW.proposal_id AND p.status = 'approved'
                   AND p.target_entry_id = NEW.entry_id AND p.kind IN ('new','update'))
  BEGIN SELECT RAISE(ABORT,'entry version requires an approved new/update proposal for this entry'); END;
CREATE TRIGGER trg_entver_contiguous BEFORE INSERT ON entry_versions
  WHEN NEW.version <> (SELECT COALESCE(MAX(version),0) + 1 FROM entry_versions WHERE entry_id = NEW.entry_id)
  BEGIN SELECT RAISE(ABORT,'entry versions must be contiguous'); END;
CREATE TRIGGER trg_entver_not_stale BEFORE INSERT ON entry_versions
  WHEN EXISTS (SELECT 1 FROM proposals p WHERE p.id = NEW.proposal_id AND
        ((p.kind = 'new' AND EXISTS (SELECT 1 FROM entry_versions e WHERE e.entry_id = NEW.entry_id))
      OR (p.kind = 'update' AND p.base_version <> (SELECT COALESCE(MAX(version),0) FROM entry_versions WHERE entry_id = NEW.entry_id))))
  BEGIN SELECT RAISE(ABORT,'stale proposal: the entry changed since the proposal was based on it'); END;

-- ---------- Publication guards ----------
CREATE TRIGGER trg_pub_compare_and_set BEFORE INSERT ON publications
  WHEN NEW.previous_version IS NOT (SELECT current_version FROM packages WHERE id = NEW.package_id)
  BEGIN SELECT RAISE(ABORT,'stale publication: the package pointer changed since it was read'); END;
CREATE TRIGGER trg_pub_rollback_valid BEFORE INSERT ON publications
  WHEN NEW.action = 'rollback' AND (NEW.previous_version IS NULL OR NOT EXISTS
       (SELECT 1 FROM publications p WHERE p.package_id = NEW.package_id AND p.version = NEW.version AND p.action = 'publish'))
  BEGIN SELECT RAISE(ABORT,'rollback target must be a previously published version'); END;
CREATE TRIGGER trg_pubprop_valid BEFORE INSERT ON publication_proposals
  WHEN NOT EXISTS (SELECT 1 FROM publications b JOIN proposals p ON p.id = NEW.proposal_id
        WHERE b.id = NEW.publication_id AND b.action = 'publish' AND p.status = 'approved' AND (
          (p.kind IN ('new','update') AND EXISTS (SELECT 1 FROM package_version_entries m JOIN entry_versions ev
              ON ev.entry_id = m.entry_id AND ev.version = m.entry_version
              WHERE m.package_id = b.package_id AND m.package_version = b.version AND ev.proposal_id = p.id))
       OR (p.kind = 'retire' AND NOT EXISTS (SELECT 1 FROM package_version_entries m
              WHERE m.package_id = b.package_id AND m.package_version = b.version AND m.entry_id = p.target_entry_id)
              AND EXISTS (SELECT 1 FROM package_version_entries m WHERE m.package_id = b.package_id
              AND m.package_version = b.previous_version AND m.entry_id = p.target_entry_id))))
  BEGIN SELECT RAISE(ABORT,'only approved proposals that match the package contents can be attached to a publication'); END;

-- ---------- The pointer move is the final gate ----------
CREATE TRIGGER trg_pointer_no_unpublish BEFORE UPDATE OF current_version ON packages
  WHEN NEW.current_version IS NOT OLD.current_version AND (NEW.current_version IS NULL)
  BEGIN SELECT RAISE(ABORT,'the publication pointer cannot be unset'); END;
CREATE TRIGGER trg_pointer_needs_record BEFORE UPDATE OF current_version ON packages
  WHEN NEW.current_version IS NOT NULL AND NEW.current_version IS NOT OLD.current_version AND (NOT EXISTS (SELECT 1 FROM publications WHERE id = (SELECT MAX(id) FROM publications WHERE package_id = NEW.id) AND version = NEW.current_version AND previous_version IS OLD.current_version))
  BEGIN SELECT RAISE(ABORT,'the pointer must follow the latest publication record'); END;
CREATE TRIGGER trg_pointer_count BEFORE UPDATE OF current_version ON packages
  WHEN NEW.current_version IS NOT NULL AND NEW.current_version IS NOT OLD.current_version AND ((SELECT action FROM publications WHERE id = (SELECT MAX(id) FROM publications WHERE package_id = NEW.id)) = 'publish' AND (SELECT COUNT(*) FROM package_version_entries WHERE package_id = NEW.id AND package_version = NEW.current_version) <> (SELECT entry_count FROM package_versions WHERE package_id = NEW.id AND version = NEW.current_version))
  BEGIN SELECT RAISE(ABORT,'package membership count does not match the declared entry count'); END;
CREATE TRIGGER trg_pointer_distinct BEFORE UPDATE OF current_version ON packages
  WHEN NEW.current_version IS NOT NULL AND NEW.current_version IS NOT OLD.current_version AND ((SELECT action FROM publications WHERE id = (SELECT MAX(id) FROM publications WHERE package_id = NEW.id)) = 'publish' AND (SELECT COUNT(DISTINCT json_extract(je.value,'$.id')) FROM json_each((SELECT body FROM package_versions WHERE package_id = NEW.id AND version = NEW.current_version),'$.entries') je) <> (SELECT entry_count FROM package_versions WHERE package_id = NEW.id AND version = NEW.current_version))
  BEGIN SELECT RAISE(ABORT,'package body has duplicate or missing entry ids'); END;
CREATE TRIGGER trg_pointer_body_matches BEFORE UPDATE OF current_version ON packages
  WHEN NEW.current_version IS NOT NULL AND NEW.current_version IS NOT OLD.current_version AND ((SELECT action FROM publications WHERE id = (SELECT MAX(id) FROM publications WHERE package_id = NEW.id)) = 'publish' AND EXISTS (SELECT 1 FROM json_each((SELECT body FROM package_versions WHERE package_id = NEW.id AND version = NEW.current_version),'$.entries') je WHERE NOT EXISTS (SELECT 1 FROM package_version_entries m JOIN entry_versions ev ON ev.entry_id = m.entry_id AND ev.version = m.entry_version WHERE m.package_id = NEW.id AND m.package_version = NEW.current_version AND m.entry_id = json_extract(je.value,'$.id') AND json(ev.content_json) = json(je.value) AND json_extract(je.value,'$.version') = (m.entry_version || '.0.0'))))
  BEGIN SELECT RAISE(ABORT,'package body does not match its membership records'); END;
CREATE TRIGGER trg_pointer_eligible BEFORE UPDATE OF current_version ON packages
  WHEN NEW.current_version IS NOT NULL AND NEW.current_version IS NOT OLD.current_version AND ((SELECT action FROM publications WHERE id = (SELECT MAX(id) FROM publications WHERE package_id = NEW.id)) = 'publish' AND EXISTS (SELECT 1 FROM package_version_entries m JOIN entry_versions ev ON ev.entry_id = m.entry_id AND ev.version = m.entry_version WHERE m.package_id = NEW.id AND m.package_version = NEW.current_version AND ev.status NOT IN ('published','verified')))
  BEGIN SELECT RAISE(ABORT,'only entry versions with status published or verified can be public'); END;
CREATE TRIGGER trg_pointer_changes_have_proposals BEFORE UPDATE OF current_version ON packages
  WHEN NEW.current_version IS NOT NULL AND NEW.current_version IS NOT OLD.current_version AND ((SELECT action FROM publications WHERE id = (SELECT MAX(id) FROM publications WHERE package_id = NEW.id)) = 'publish' AND EXISTS (SELECT 1 FROM package_version_entries m JOIN entry_versions ev ON ev.entry_id = m.entry_id AND ev.version = m.entry_version WHERE m.package_id = NEW.id AND m.package_version = NEW.current_version AND NOT EXISTS (SELECT 1 FROM package_version_entries o WHERE o.package_id = NEW.id AND o.package_version = OLD.current_version AND o.entry_id = m.entry_id AND o.entry_version = m.entry_version) AND NOT EXISTS (SELECT 1 FROM publication_proposals pp WHERE pp.publication_id = (SELECT MAX(id) FROM publications WHERE package_id = NEW.id) AND pp.proposal_id = ev.proposal_id)))
  BEGIN SELECT RAISE(ABORT,'every new or changed entry version must be attached to the publication through its approved proposal'); END;
CREATE TRIGGER trg_pointer_retirements_have_proposals BEFORE UPDATE OF current_version ON packages
  WHEN NEW.current_version IS NOT NULL AND NEW.current_version IS NOT OLD.current_version AND ((SELECT action FROM publications WHERE id = (SELECT MAX(id) FROM publications WHERE package_id = NEW.id)) = 'publish' AND OLD.current_version IS NOT NULL AND EXISTS (SELECT 1 FROM package_version_entries o WHERE o.package_id = NEW.id AND o.package_version = OLD.current_version AND NOT EXISTS (SELECT 1 FROM package_version_entries m WHERE m.package_id = NEW.id AND m.package_version = NEW.current_version AND m.entry_id = o.entry_id) AND NOT EXISTS (SELECT 1 FROM publication_proposals pp JOIN proposals p ON p.id = pp.proposal_id WHERE pp.publication_id = (SELECT MAX(id) FROM publications WHERE package_id = NEW.id) AND p.kind = 'retire' AND p.target_entry_id = o.entry_id)))
  BEGIN SELECT RAISE(ABORT,'every removed entry must be attached to the publication through an approved retire proposal'); END;
CREATE TRIGGER trg_pointer_proposals_marked BEFORE UPDATE OF current_version ON packages
  WHEN NEW.current_version IS NOT NULL AND NEW.current_version IS NOT OLD.current_version AND ((SELECT action FROM publications WHERE id = (SELECT MAX(id) FROM publications WHERE package_id = NEW.id)) = 'publish' AND EXISTS (SELECT 1 FROM publication_proposals pp JOIN proposals p ON p.id = pp.proposal_id WHERE pp.publication_id = (SELECT MAX(id) FROM publications WHERE package_id = NEW.id) AND p.status <> 'published'))
  BEGIN SELECT RAISE(ABORT,'proposals attached to a publication must be marked published before the pointer moves'); END;

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

-- ---------- Initial system records ----------
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

INSERT INTO schema_info (key, value) VALUES ('schema_version','0.5.0'),
  ('initialized_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO packages (id, title, description) VALUES
  ('rdev-studio','Roblox Studio Fundamentals','Find your way around Studio, build with parts and models, and test your work.'),
  ('rdev-luau','Luau Programming','The language of Roblox: variables, functions, tables, control flow and modules.'),
  ('rdev-ui','UI/UX Development','Build responsive interfaces that work on phones, tablets and desktops.'),
  ('rdev-level','Game Building and Level Design','Plan readable spaces, guide players and improve levels through playtesting.'),
  ('rdev-gameplay','Gameplay Systems','Events, leaderboards, round loops and animation of game objects.'),
  ('rdev-backend','Backend and Networking','Client-server thinking, RemoteEvents, saving data and defensive design.'),
  ('rdev-art','3D Art and Animation','Prepare assets for Roblox and play animations from scripts.'),
  ('rdev-pro','Professional Development','Organize projects, debug methodically and present your work honestly.');
INSERT INTO security_events (event, detail) VALUES ('db_initialized','schema 0.5.0');
