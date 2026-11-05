-- Vehicle Guide: loading issues vs vehicle issues, several models per entry,
-- and a service-bulletin reference.
--
-- Apply (D1 database splash-damage-claims) BEFORE deploying the worker that
-- reads it -- listIssues selects these columns, so the guide 500s without
-- them. One statement per --command (multi-statement commands have timed out
-- from this machine before):
--   pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage-claims --remote --command "ALTER TABLE vehicle_issues ADD COLUMN category TEXT NOT NULL DEFAULT 'loading'"
--   pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage-claims --remote --command "ALTER TABLE vehicle_issues ADD COLUMN models TEXT"
--   pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage-claims --remote --command "ALTER TABLE vehicle_issues ADD COLUMN bulletin TEXT"
--   pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage-claims --remote --command "ALTER TABLE vehicle_issues ADD COLUMN bulletin_url TEXT"
--
-- Additive. Every existing row becomes a loading issue, which is what all of
-- them are. NOT re-runnable: SQLite has no ADD COLUMN IF NOT EXISTS, so a
-- second run fails with "duplicate column name" (harmless, nothing changes).
--
-- category      'loading' | 'vehicle'; validated in code against
--               VEHICLE_ISSUE_CATEGORIES, and the issue type must belong to it.
-- models        JSON array of model names. NULL (every row written before
--               this migration) reads as [model]. '[]' = every model of the
--               make. `model` keeps the display label ("Telluride, Sorento" or
--               "All models") so ordering and older readers still work.
-- bulletin      Free-text bulletin / recall number, or NULL.
-- bulletin_url  https link to the bulletin, or NULL.

ALTER TABLE vehicle_issues ADD COLUMN category TEXT NOT NULL DEFAULT 'loading';
ALTER TABLE vehicle_issues ADD COLUMN models TEXT;
ALTER TABLE vehicle_issues ADD COLUMN bulletin TEXT;
ALTER TABLE vehicle_issues ADD COLUMN bulletin_url TEXT;
