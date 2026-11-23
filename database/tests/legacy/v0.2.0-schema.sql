-- RDev Academy platform knowledge database (Cloudflare D1).
-- Public, centrally managed learning content only. No accounts, credentials or learner records.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS knowledge_items (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lesson','reference')),
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  category TEXT NOT NULL,
  level TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','ai-assisted','under-review','verified','published','outdated','archived')),
  origin TEXT NOT NULL CHECK (origin IN ('original','ai-assisted','imported')),
  search_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_status_updated ON knowledge_items(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_package ON knowledge_items(package_id);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  publisher TEXT NOT NULL,
  license TEXT,
  status TEXT NOT NULL CHECK (status IN ('unchecked','retrieved','failed')),
  retrieved_at TEXT,
  content_hash TEXT
);

CREATE TABLE IF NOT EXISTS entry_sources (
  entry_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY (entry_id, source_id)
);

CREATE TABLE IF NOT EXISTS relationships (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('prerequisite','related','next')),
  weight REAL NOT NULL DEFAULT 1,
  reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (from_id, to_id, type)
);

-- Complete RLF packages (JSON text). Clients validate the checksum themselves before using one.
CREATE TABLE IF NOT EXISTS rlf_packages (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
