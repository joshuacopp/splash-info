-- Vehicle Guide: YouTube walkthroughs per entry.
--
-- Apply (D1 database splash-damage-claims) BEFORE deploying the worker that
-- reads it -- listIssues selects this column, so the page 500s without it:
--   pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage-claims --remote --command "ALTER TABLE vehicle_issues ADD COLUMN youtube_links TEXT"
--
-- Additive. NOT re-runnable: SQLite has no ADD COLUMN IF NOT EXISTS, so a
-- second run fails with "duplicate column name" (harmless, nothing changes).
--
-- NULL or '[]' = no links. Otherwise a JSON array of canonical watch URLs
-- (https://www.youtube.com/watch?v={id}[&t={n}s]), validated by the worker.

ALTER TABLE vehicle_issues ADD COLUMN youtube_links TEXT;
