-- One-off fix: relabel Cicero determination 'DM Review' -> 'RM Review'.
--
-- cicero-backfill.sql has been updated so any fresh run already uses
-- 'RM Review'. This UPDATE is ONLY needed if the Cicero rows are already in
-- D1 (they were, per the reporting screenshot). It is idempotent and safe to
-- run once — it touches only Cicero rows still carrying the old label.
--
-- Run (from apps/damage-worker):
--   wrangler d1 execute splash-damage-claims --remote --file=cicero-determination-rm-fix.sql

UPDATE claims
   SET determination = 'RM Review'
 WHERE location_code = 'cicero'
   AND determination = 'DM Review';
