-- Empty every greeter scorecard table. Run this BEFORE greeter-seed-binghamton-06.sql.
--
-- This deletes ALL rows from greeter_daily, location_daily and greeter_goals —
-- not just rows matching some "looks like test data" heuristic. That was the
-- explicit instruction, and it is the only honest way to do it: hand-entered
-- test rows are indistinguishable from real ones once they're in the table, so
-- any filter would either miss some or take real numbers with it.
--
-- STOP AND READ IF ANY SITE HAS STARTED USING THE SCORECARD FOR REAL. There is
-- no undo once this commits. If you only want Binghamton gone, replace each
-- DELETE with `DELETE FROM <table> WHERE site_number = 122;` and drop the
-- greeter_goals delete down to the same filter.
--
-- Order matters only for readability — there are no foreign keys between these
-- three tables (see the LOCATION KEYING note in greeter-scorecard-tables.sql),
-- so nothing cascades and nothing blocks.
--
-- DELETE rather than TRUNCATE, deliberately: TRUNCATE can't report how many
-- rows it removed, and the row counts below are the only confirmation you get
-- that this hit what you expected. These tables are small enough that the
-- performance difference is irrelevant.

BEGIN;

DO $$
DECLARE
  n_greeter  bigint;
  n_location bigint;
  n_goals    bigint;
BEGIN
  DELETE FROM greeter_daily;
  GET DIAGNOSTICS n_greeter = ROW_COUNT;

  DELETE FROM location_daily;
  GET DIAGNOSTICS n_location = ROW_COUNT;

  DELETE FROM greeter_goals;
  GET DIAGNOSTICS n_goals = ROW_COUNT;

  RAISE NOTICE 'cleared: greeter_daily=% location_daily=% greeter_goals=%',
    n_greeter, n_location, n_goals;
END $$;

-- Proof, in the results pane rather than only in the NOTICE log — the Supabase
-- SQL editor doesn't always surface RAISE NOTICE.
SELECT 'greeter_daily'  AS table_name, count(*) AS rows_remaining FROM greeter_daily
UNION ALL
SELECT 'location_daily', count(*) FROM location_daily
UNION ALL
SELECT 'greeter_goals',  count(*) FROM greeter_goals
ORDER BY table_name;

COMMIT;
