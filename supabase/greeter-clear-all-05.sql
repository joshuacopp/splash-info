-- Empty every greeter scorecard table. Run this BEFORE greeter-seed-binghamton-06.sql.
--
-- This deletes ALL rows from greeter_daily, location_daily and greeter_goals —
-- not just rows matching some "looks like test data" heuristic. That was the
-- explicit instruction, and it is the only honest way to do it: hand-entered
-- test rows are indistinguishable from real ones once they're in the table, so
-- any filter would either miss some or take real numbers with it.
--
-- STOP AND READ IF ANY SITE HAS STARTED USING THE SCORECARD FOR REAL. There is
-- no undo once this commits. If you only want Binghamton gone, add
-- `WHERE site_number = 122` to each of the three DELETEs below.
--
-- ONE STATEMENT, deliberately. The earlier version of this file captured the
-- before-counts into a TEMP TABLE and read them back from a later statement,
-- which fails in the Supabase SQL editor with
--     ERROR: 42P01: relation "_cleared" does not exist
-- because the editor does not hold one session across statement boundaries the
-- way psql does. Data-modifying CTEs remove the need entirely: the three
-- DELETEs and the report of what they removed are a single statement, so there
-- is no state to carry and no BEGIN/COMMIT to get wrong. All three either
-- happen or none do.
--
-- Postgres guarantees a data-modifying WITH clause runs exactly once and to
-- completion whether or not the outer query reads its output, so nothing here
-- depends on the SELECT below touching all three. Order between them is not
-- defined and does not matter — there are no foreign keys between these tables
-- (see the LOCATION KEYING note in greeter-scorecard-tables.sql), so nothing
-- cascades and nothing blocks.
--
-- DELETE rather than TRUNCATE, deliberately: TRUNCATE can't report how many
-- rows it removed, and these counts are the only confirmation you get that this
-- ran against the database you meant rather than an empty one. The tables are
-- small enough that the performance difference is irrelevant.

WITH
  d_greeter_daily  AS (DELETE FROM greeter_daily  RETURNING 1),
  d_location_daily AS (DELETE FROM location_daily RETURNING 1),
  d_greeter_goals  AS (DELETE FROM greeter_goals  RETURNING 1)
SELECT 'greeter_daily'  AS table_name, (SELECT count(*) FROM d_greeter_daily)  AS rows_deleted
UNION ALL
SELECT 'location_daily', (SELECT count(*) FROM d_location_daily)
UNION ALL
SELECT 'greeter_goals',  (SELECT count(*) FROM d_greeter_goals)
ORDER BY table_name;

-- ---------------------------------------------------------------------------
-- Proof the tables are actually empty. Has to be run SEPARATELY (select these
-- three lines and hit run) — the same statement that deletes sees the rows as
-- they were before it started, so folding this into the query above would
-- report the pre-delete counts and look like the delete did nothing.
-- ---------------------------------------------------------------------------
-- SELECT 'greeter_daily' AS table_name, count(*) AS rows_remaining FROM greeter_daily
-- UNION ALL SELECT 'location_daily', count(*) FROM location_daily
-- UNION ALL SELECT 'greeter_goals',  count(*) FROM greeter_goals;
