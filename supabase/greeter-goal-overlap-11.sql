-- ===========================================================================
-- greeter-goal-overlap-11.sql
--
-- Makes overlapping goal windows LEGAL and decides between them by span:
-- the shortest window covering a day is the one that grades it.
--
-- WHY
-- ---
-- Josh, 2026-08-22: "specials come on by surprise and require different goals.
-- for example, normal baseline capture goal is 10% - so for the month of
-- september i would set a location capture goal to 10%. however, we may then be
-- told 'we're running a special the second week of september' - where the
-- capture goal would be 20%. currently trying to input a goal where there is
-- already another goal in place returns an error. desired behavior would be
-- that shorter term goals override longer term goals, for the term they are in
-- place."
--
-- The old `greeter_goals_no_overlap` EXCLUDE constraint made that shape
-- unrepresentable. It existed for a good reason — it was what guaranteed the
-- lookup could never be ambiguous, which is why getGoalSnapshot() in
-- packages/db-supabase could get away with a bare LIMIT 1 and no ORDER BY. So
-- the constraint cannot simply be dropped: something has to take over the job
-- of making the answer deterministic. That something is greeter_goal_for()
-- below, and pointing the application at it is NOT optional cleanup — an
-- unordered LIMIT 1 over two matching windows returns whichever row Postgres
-- happens to hand back first, which can differ between two runs of the same
-- query.
--
-- THE RULE, IN ONE LINE: smallest span wins; an open-ended window has infinite
-- span and therefore always loses to a bounded one.
--
-- That single rule covers every case Josh described and several he didn't,
-- without any of them being a special case in the code:
--
--   nested        Sept 8-14 inside Sept 1-30      -> the week, for those 7 days
--   partial       Sept 25-Oct 5 against Sept 1-30 -> the 11-day window Sept 25-30
--   standing      an open-ended baseline          -> loses to any dated window
--   stacked       a 3-day flash inside the week   -> the flash, for those 3 days
--
-- WHAT THIS DOES NOT CHANGE: goals are still SNAPSHOTTED onto greeter_daily and
-- location_daily at submit time. The resolver decides what gets stamped; it is
-- not consulted at read time. That is deliberate and predates this file — see
-- the greeter_goals header in greeter-scorecard-tables.sql. The consequence is
-- section 4: a goal added after the fact has to go back and re-stamp, or the
-- days already entered stay graded against the target they were entered under.
-- Josh confirmed those days SHOULD move ("1 - yes"), which is what makes the
-- re-stamp function part of this migration rather than a future nicety.
--
-- WHAT STAYS REJECTED: two goals for the same site with the SAME window. That
-- is not a promo layered on a baseline, it is the same row typed twice, and
-- there is no rule that could pick between them that wouldn't be a coin flip.
-- Section 2 rejects it with a unique index; the worker turns that into a
-- message pointing at the delete button rather than the old "close the existing
-- window first", which is no longer advice that applies to anything.
--
-- Idempotent. Safe to re-run.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Drop the overlap guard
-- ---------------------------------------------------------------------------
-- IF EXISTS rather than a bare DROP: on a database provisioned after this file
-- lands, greeter-scorecard-tables.sql will have been edited to stop creating
-- it, and re-running this migration must not fail on the absence.
--
-- btree_gist stays installed. Nothing else in this schema needs it today, but
-- dropping an extension to tidy up is how you find out something did.
ALTER TABLE greeter_goals DROP CONSTRAINT IF EXISTS greeter_goals_no_overlap;


-- ---------------------------------------------------------------------------
-- 2. Reject exact duplicates only
-- ---------------------------------------------------------------------------
-- COALESCE to 'infinity' for the same reason the old exclusion constraint used
-- it, and for the same reason expense_labor_rate indexes COALESCE(mechanic_key,
-- ''): NULLs compare distinct in a plain UNIQUE, so without the COALESCE two
-- identical open-ended baselines for one site would both be accepted and then
-- tie in the resolver forever.
--
-- Deliberately NOT a constraint. An expression index cannot be a table
-- constraint in Postgres, and the error a unique INDEX raises (23505) is the
-- same one the worker would catch either way.
CREATE UNIQUE INDEX IF NOT EXISTS idx_greeter_goals_unique_window
  ON greeter_goals (
    site_number,
    effective_from,
    COALESCE(effective_to, 'infinity'::date)
  );

COMMENT ON INDEX idx_greeter_goals_unique_window IS
  'Overlapping goal windows are allowed (shortest span wins — see '
  'greeter_goal_for). Identical windows are not: there is no rule that could '
  'choose between them. Delete the existing goal instead.';


-- ---------------------------------------------------------------------------
-- 3. greeter_goal_for() — the one place the rule lives
-- ---------------------------------------------------------------------------
-- Mirrors expense_labor_rate_for() on purpose: resolution logic belongs in the
-- database once, not in every caller that needs a goal. The application is not
-- permitted a second copy of this ORDER BY.
--
-- Returns a ROW rather than three scalars because all three goals must come
-- from the SAME window. Three separate scalar lookups could each pick a
-- different row on a tie and hand back a capture target from the promo and a
-- member target from the baseline — a combination nobody ever set.
--
-- No row at all when nothing covers the date. Callers stamp NULLs, which is
-- what the goal columns on both daily tables already mean: "no goal window
-- covered this day", not "the goal was zero". A zero capture goal would grade
-- every day as a win.
--
-- THE ORDER BY, term by term:
--
--   1. (effective_to IS NULL) ASC — bounded windows before open-ended ones.
--      This is how "an open-ended window has infinite span" is expressed
--      without doing arithmetic on 'infinity'::date, which Postgres refuses to
--      subtract.
--   2. (effective_to - effective_from) ASC — among bounded windows, the
--      shortest. This is the rule Josh asked for.
--   3. effective_from DESC — the tiebreaker, and it does real work in two
--      places. Two bounded windows of EQUAL length can both cover a day (Sept
--      1-7 and Sept 5-11 both cover Sept 6), and two open-ended windows tie at
--      step 1 and produce a NULL at step 2, so every standing baseline for a
--      site lands here. Later start wins: the more recently begun window is the
--      more recent instruction, which is the same semantic as
--      expense_labor_rate_for's "newest effective_from wins".
--   4. created_at DESC, id — pure determinism. Reachable only when two windows
--      are identical in span AND start, which section 2 now forbids for one
--      site. Present anyway so this function cannot become non-deterministic if
--      that index is ever dropped.
CREATE OR REPLACE FUNCTION greeter_goal_for(
  p_site_number   integer,
  p_business_date date
)
RETURNS TABLE (
  capture_goal_pct      numeric,
  dob_goal              numeric,
  member_goal_month_end integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    g.capture_goal_pct,
    g.dob_goal,
    g.member_goal_month_end
  FROM greeter_goals g
  WHERE g.site_number = p_site_number
    AND g.effective_from <= p_business_date
    AND (g.effective_to IS NULL OR g.effective_to >= p_business_date)
  ORDER BY
    (g.effective_to IS NULL)              ASC,
    (g.effective_to - g.effective_from)   ASC,
    g.effective_from                      DESC,
    g.created_at                          DESC,
    g.id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION greeter_goal_for(integer, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_goal_for(integer, date) TO service_role;


-- ---------------------------------------------------------------------------
-- 4. greeter_restamp_goals() — make already-entered days obey a new goal
-- ---------------------------------------------------------------------------
-- Goals are frozen onto each submission at submit time, so a goal set today for
-- a window that is partly in the past leaves those days graded against whatever
-- was in force when they were typed. Without this function, adding the
-- special-week goal after the special week would change nothing anyone can see
-- and would look exactly like a save that silently failed.
--
-- IT RE-RESOLVES; IT DOES NOT APPLY THE GOAL IT WAS CALLED ABOUT. Every day in
-- the window is put back through greeter_goal_for(), so re-stamping a month-long
-- baseline does NOT flatten the promo week sitting inside it — those days
-- resolve to the promo again and are left alone. That property is also what
-- lets the DELETE path call this same function: with the goal gone, the days
-- resolve to whatever is left (possibly nothing), and the NULL-out falls out for
-- free instead of needing its own code.
--
-- p_to NULL means open-ended, which in practice means "to the last day anybody
-- has submitted" — there is nothing to re-stamp in the future.
--
-- Returns both counts separately because they are different grains. Four
-- greeter rows and one site row is one DAY at a four-greeter site, and a banner
-- that added them into "5 rows re-graded" would be arithmetic on two different
-- units.
--
-- IS DISTINCT FROM on every column, so a day already carrying the right target
-- is not written. That keeps the count honest (it is "days that changed", not
-- "days considered") and stops the updated_at trigger on both tables from
-- moving on rows nothing happened to.
--
-- updated_by / updated_by_email ARE DELIBERATELY LEFT ALONE, which means a
-- re-stamped row shows a fresh updated_at beside the email of whoever last
-- typed its numbers. That is the lesser of two wrongs: overwriting those
-- columns would destroy the only record of who entered the day, to replace it
-- with a name that isn't a person. The updated_at movement is true — the row
-- did change — and /admin/greeters says how many rows moved in the banner, so
-- the change is not silent.
CREATE OR REPLACE FUNCTION greeter_restamp_goals(
  p_site_number integer,
  p_from        date,
  p_to          date DEFAULT NULL
)
RETURNS TABLE (
  greeter_rows  integer,
  location_rows integer
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_greeter  integer := 0;
  v_location integer := 0;
BEGIN
  WITH resolved AS (
    SELECT
      d.id,
      f.capture_goal_pct,
      f.dob_goal
    FROM greeter_daily d
    -- LEFT JOIN LATERAL, not a plain one: when no window covers the day the
    -- resolver returns no rows, and an inner join would skip that day rather
    -- than clearing the stale goal off it. Clearing it is the point on the
    -- delete path.
    LEFT JOIN LATERAL greeter_goal_for(d.site_number, d.business_date) f ON true
    WHERE d.site_number = p_site_number
      AND d.business_date >= p_from
      AND (p_to IS NULL OR d.business_date <= p_to)
  ),
  changed AS (
    UPDATE greeter_daily d
       SET capture_goal_pct = r.capture_goal_pct,
           dob_goal         = r.dob_goal
      FROM resolved r
     WHERE d.id = r.id
       AND (d.capture_goal_pct IS DISTINCT FROM r.capture_goal_pct
         OR d.dob_goal         IS DISTINCT FROM r.dob_goal)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_greeter FROM changed;

  WITH resolved AS (
    SELECT
      l.id,
      f.capture_goal_pct,
      f.dob_goal,
      f.member_goal_month_end
    FROM location_daily l
    LEFT JOIN LATERAL greeter_goal_for(l.site_number, l.business_date) f ON true
    WHERE l.site_number = p_site_number
      AND l.business_date >= p_from
      AND (p_to IS NULL OR l.business_date <= p_to)
  ),
  changed AS (
    UPDATE location_daily l
       SET capture_goal_pct      = r.capture_goal_pct,
           dob_goal              = r.dob_goal,
           member_goal_month_end = r.member_goal_month_end
      FROM resolved r
     WHERE l.id = r.id
       AND (l.capture_goal_pct      IS DISTINCT FROM r.capture_goal_pct
         OR l.dob_goal              IS DISTINCT FROM r.dob_goal
         OR l.member_goal_month_end IS DISTINCT FROM r.member_goal_month_end)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_location FROM changed;

  greeter_rows  := v_greeter;
  location_rows := v_location;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION greeter_restamp_goals(integer, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_restamp_goals(integer, date, date) TO service_role;


-- ---------------------------------------------------------------------------
-- 5. Verification — fails loudly rather than leaving a half-applied migration
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text := '';
  v_rows    integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'greeter_goals_no_overlap'
       AND conrelid = 'greeter_goals'::regclass
  ) THEN
    v_missing := v_missing || ' greeter_goals_no_overlap(still present)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'greeter_goals'
       AND indexname = 'idx_greeter_goals_unique_window'
  ) THEN
    v_missing := v_missing || ' idx_greeter_goals_unique_window';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'greeter_goal_for'
  ) THEN
    v_missing := v_missing || ' greeter_goal_for';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'greeter_restamp_goals'
  ) THEN
    v_missing := v_missing || ' greeter_restamp_goals';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'greeter-goal-overlap-11 incomplete, missing:%', v_missing;
  END IF;

  -- Both functions must RUN, not merely exist. Site -1 exists nowhere, so the
  -- resolver returns no row and the re-stamp touches nothing — the point is
  -- that the LATERAL join and the plpgsql body compile and execute against the
  -- real column names, which a pg_proc lookup cannot tell you.
  PERFORM * FROM greeter_goal_for(-1, CURRENT_DATE);

  SELECT greeter_rows + location_rows INTO v_rows
    FROM greeter_restamp_goals(-1, CURRENT_DATE, CURRENT_DATE);

  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'greeter_restamp_goals touched % rows for a site that does not exist', v_rows;
  END IF;

  RAISE NOTICE 'greeter-goal-overlap-11 applied. Overlapping goal windows are now legal; shortest span wins.';
END
$$;
