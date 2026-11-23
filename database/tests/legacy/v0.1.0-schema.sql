-- Public knowledge metadata only. No accounts, credentials, or learner records.
CREATE TABLE IF NOT EXISTS knowledge_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','ai-assisted','under-review','verified','published','outdated','archived')),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_status_updated ON knowledge_items(status, updated_at DESC);
