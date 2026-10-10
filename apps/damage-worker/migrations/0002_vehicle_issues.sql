-- Vehicle Guide: known problem vehicles and how to handle them in the tunnel.
-- See packages/types/src/vehicle-guide.ts for the model and
-- apps/damage-worker/src/vehicle-guide.ts for the handlers.
--
-- Apply (D1 database splash-damage-claims):
--   pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage-claims --remote --file=migrations/0002_vehicle_issues.sql
--
-- Additive only: two new tables, nothing existing is touched. Safe to re-run.

CREATE TABLE IF NOT EXISTS vehicle_issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  make        TEXT NOT NULL,
  model       TEXT NOT NULL,
  year_from   INTEGER NOT NULL,
  -- NULL = "and newer": the issue is still current.
  year_to     INTEGER,
  issue_type  TEXT NOT NULL,              -- validated against VEHICLE_ISSUE_TYPES in code
  issue       TEXT NOT NULL,
  solution    TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (year_to IS NULL OR year_to >= year_from)
);
CREATE INDEX IF NOT EXISTS idx_vehicle_issues_make_model
  ON vehicle_issues (make COLLATE NOCASE, model COLLATE NOCASE);

-- Photos and videos. Bytes live in R2 (damagedocs bucket) under
-- vehicle-guide/{issue_id}/{random}.{ext}; the worker deletes the objects
-- itself when a row or its parent issue is deleted.
CREATE TABLE IF NOT EXISTS vehicle_issue_media (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id           INTEGER NOT NULL REFERENCES vehicle_issues(id) ON DELETE CASCADE,
  r2_key             TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('photo', 'video')),
  mime               TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  original_filename  TEXT,
  created_by         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vehicle_issue_media_issue
  ON vehicle_issue_media (issue_id);
