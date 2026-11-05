-- Vehicle Guide: links to reported failures (owner complaints, forum threads,
-- news) for issues with no service bulletin, or alongside one.
--
-- Apply (D1 database splash-damage-claims) BEFORE deploying the worker that
-- reads it -- listIssues selects this column, so the guide 500s without it:
--   pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage-claims --remote --command "ALTER TABLE vehicle_issues ADD COLUMN report_links TEXT"
--
-- Additive. NOT re-runnable: SQLite has no ADD COLUMN IF NOT EXISTS, so a
-- second run fails with "duplicate column name" (harmless, nothing changes).
--
-- NULL or '[]' = none. Otherwise a JSON array of {"label": "...", "url":
-- "https://..."}, validated by parseReportLinks in
-- packages/types/src/vehicle-guide.ts (http(s) only, at most 10).

ALTER TABLE vehicle_issues ADD COLUMN report_links TEXT;
