-- Greeter scorecard — ALTER 01.
--
-- Companion to greeter-scorecard-tables.sql, which has ALREADY been applied to
-- staging. Run this in the Supabase SQL editor to bring an existing database up
-- to the revised metric set. greeter-scorecard-tables.sql has been updated in
-- lockstep so a fresh apply of the CREATE file lands in the same place — you
-- need exactly one of the two, never both.
--
-- Every statement is guarded so the whole file is safe to re-run.
--
-- WHAT CHANGES AND WHY (confirmed with Josh 2026-08-15):
--
--   greeter_daily
--     - DROP total_cars. Tunnel volume is a site fact, not a greeter's fact;
--       every greeter on a shift would have typed the same number and the sum
--       across greeters would have triple-counted the site's day. It lives on
--       location_daily only now.
--     - ADD rewashes (optional). Present on the greeter form as a courtesy
--       field; the authoritative site figure is on location_daily.
--     - ADD shift_start / shift_end, and the two metrics they unlock:
--       hours_worked and wash_sales_per_hour.
--     - RENAME the goal snapshot columns (see greeter_goals below).
--
--   location_daily
--     - KEEP total_cars, ADD rewashes, cancellations, total_members.
--       total_members is a LEVEL (active members as of that day), not a delta —
--       so it is never summed across days, only read at the latest date in a
--       window. See the note on member_goal_month_end.
--     - RENAME the goal snapshot columns, ADD member_goal_month_end snapshot.
--
--   greeter_goals
--     - sign_up_goal (integer count) -> capture_goal_pct (numeric percent).
--       A raw sign-up count isn't comparable between a 40-car Tuesday and a
--       400-car Saturday; capture % already normalizes for opportunity, and it
--       is what capture_pct is measured in, so goal and actual now share units.
--     - extras_goal -> dob_goal. Same reasoning: extras dollars alone ignored
--       package dollars and volume; DOB is the metric the scorecard grades on.
--     - ADD member_goal_month_end — total ACTIVE members the site should reach
--       by month end. A level, not net adds and not gross sign-ups, so it is
--       graded against the most recent location_daily.total_members in the
--       window rather than against a sum.
--
-- SHIFT TIME / HOURS ARITHMETIC — read before touching:
--   shift_start and shift_end are `time` (no date, no zone). A shift that ends
--   before it starts is an overnight shift, so 86400s is added back. This caps
--   a single row at one day, which is correct for a per-day grain.
--
--   hours_worked and wash_sales_per_hour are both GENERATED ALWAYS ... STORED,
--   and wash_sales_per_hour INLINES the whole duration expression rather than
--   referencing hours_worked. That duplication is not an oversight: Postgres
--   forbids a generated column from referencing another generated column. If
--   you change the duration rule, change it in BOTH places.

-- ===========================================================================
-- 1. greeter_goals — capture % goal, DOB goal, monthly member level goal.
-- ===========================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'greeter_goals' AND column_name = 'sign_up_goal') THEN
    ALTER TABLE greeter_goals RENAME COLUMN sign_up_goal TO capture_goal_pct;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'greeter_goals' AND column_name = 'extras_goal') THEN
    ALTER TABLE greeter_goals RENAME COLUMN extras_goal TO dob_goal;
  END IF;
END $$;

-- The inline CHECKs from the CREATE file carry auto-generated names derived
-- from the OLD column names; a rename does not rename them. Drop both spellings
-- and re-add under explicit names so the constraint set is legible.
ALTER TABLE greeter_goals DROP CONSTRAINT IF EXISTS greeter_goals_sign_up_goal_check;
ALTER TABLE greeter_goals DROP CONSTRAINT IF EXISTS greeter_goals_extras_goal_check;
ALTER TABLE greeter_goals DROP CONSTRAINT IF EXISTS greeter_goals_capture_goal_pct_check;
ALTER TABLE greeter_goals DROP CONSTRAINT IF EXISTS greeter_goals_dob_goal_check;

-- integer -> numeric(6,2): a capture goal of 30 becomes 30.00 %, which is the
-- same intent the old integer carried at the sites that were already thinking
-- in percent. Sites that entered a raw sign-up COUNT will need their goal row
-- re-entered; there is no arithmetic that could convert one into the other
-- without knowing the expected wash_sales.
ALTER TABLE greeter_goals ALTER COLUMN capture_goal_pct TYPE numeric(6,2);

ALTER TABLE greeter_goals ADD CONSTRAINT greeter_goals_capture_goal_pct_range
  CHECK (capture_goal_pct >= 0 AND capture_goal_pct <= 100);
ALTER TABLE greeter_goals ADD CONSTRAINT greeter_goals_dob_goal_nonneg
  CHECK (dob_goal >= 0);

-- Nullable: not every location sets a membership target, and a goal window is
-- still valid without one.
ALTER TABLE greeter_goals ADD COLUMN IF NOT EXISTS member_goal_month_end integer;
ALTER TABLE greeter_goals DROP CONSTRAINT IF EXISTS greeter_goals_member_goal_nonneg;
ALTER TABLE greeter_goals ADD CONSTRAINT greeter_goals_member_goal_nonneg
  CHECK (member_goal_month_end IS NULL OR member_goal_month_end >= 0);

-- ===========================================================================
-- 2. greeter_daily — drop total_cars, add rewashes + shift window + derived.
-- ===========================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'greeter_daily' AND column_name = 'sign_up_goal') THEN
    ALTER TABLE greeter_daily RENAME COLUMN sign_up_goal TO capture_goal_pct;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'greeter_daily' AND column_name = 'extras_goal') THEN
    ALTER TABLE greeter_daily RENAME COLUMN extras_goal TO dob_goal;
  END IF;
END $$;

ALTER TABLE greeter_daily ALTER COLUMN capture_goal_pct TYPE numeric(6,2);

-- greeter_rollup() reads total_cars, so it must be dropped before the column
-- can be. It is recreated at the bottom of this file against the new shape.
DROP FUNCTION IF EXISTS greeter_rollup(date, date, integer, integer, text, text, text[]);

ALTER TABLE greeter_daily DROP COLUMN IF EXISTS total_cars;

ALTER TABLE greeter_daily ADD COLUMN IF NOT EXISTS rewashes    integer;
ALTER TABLE greeter_daily ADD COLUMN IF NOT EXISTS shift_start time;
ALTER TABLE greeter_daily ADD COLUMN IF NOT EXISTS shift_end   time;

ALTER TABLE greeter_daily DROP CONSTRAINT IF EXISTS greeter_daily_rewashes_nonneg;
ALTER TABLE greeter_daily ADD CONSTRAINT greeter_daily_rewashes_nonneg
  CHECK (rewashes IS NULL OR rewashes >= 0);

-- Both-or-neither. A half-filled shift window would silently produce a NULL
-- hours_worked that looks identical to "didn't record a shift", and the form
-- can't distinguish the two after the fact.
ALTER TABLE greeter_daily DROP CONSTRAINT IF EXISTS greeter_daily_shift_pair;
ALTER TABLE greeter_daily ADD CONSTRAINT greeter_daily_shift_pair
  CHECK ((shift_start IS NULL) = (shift_end IS NULL));

-- Dropped first so re-running this file picks up an edited expression; a
-- generated column's expression cannot be ALTERed in place.
ALTER TABLE greeter_daily DROP COLUMN IF EXISTS hours_worked;
ALTER TABLE greeter_daily DROP COLUMN IF EXISTS wash_sales_per_hour;

ALTER TABLE greeter_daily ADD COLUMN hours_worked numeric(6,2)
  GENERATED ALWAYS AS (
    CASE WHEN shift_start IS NOT NULL AND shift_end IS NOT NULL THEN
      ROUND(
        (
          EXTRACT(EPOCH FROM shift_end) - EXTRACT(EPOCH FROM shift_start)
          + CASE WHEN shift_end < shift_start THEN 86400 ELSE 0 END
        )::numeric / 3600, 2)
    END
  ) STORED;

-- Duration expression repeated on purpose — see the header note. NULL rather
-- than 0 when the shift is absent or zero-length: an unrecorded shift is
-- unknown throughput, not zero throughput.
ALTER TABLE greeter_daily ADD COLUMN wash_sales_per_hour numeric(10,2)
  GENERATED ALWAYS AS (
    CASE WHEN shift_start IS NOT NULL AND shift_end IS NOT NULL
          AND (
            EXTRACT(EPOCH FROM shift_end) - EXTRACT(EPOCH FROM shift_start)
            + CASE WHEN shift_end < shift_start THEN 86400 ELSE 0 END
          ) > 0
    THEN ROUND(
           COALESCE(wash_sales, 0)::numeric * 3600
           / (
               EXTRACT(EPOCH FROM shift_end) - EXTRACT(EPOCH FROM shift_start)
               + CASE WHEN shift_end < shift_start THEN 86400 ELSE 0 END
             )::numeric, 2)
    END
  ) STORED;

-- ===========================================================================
-- 3. location_daily — rewashes, cancellations, total_members.
-- ===========================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'location_daily' AND column_name = 'sign_up_goal') THEN
    ALTER TABLE location_daily RENAME COLUMN sign_up_goal TO capture_goal_pct;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'location_daily' AND column_name = 'extras_goal') THEN
    ALTER TABLE location_daily RENAME COLUMN extras_goal TO dob_goal;
  END IF;
END $$;

ALTER TABLE location_daily ALTER COLUMN capture_goal_pct TYPE numeric(6,2);

ALTER TABLE location_daily ADD COLUMN IF NOT EXISTS rewashes      integer;
ALTER TABLE location_daily ADD COLUMN IF NOT EXISTS cancellations integer;
ALTER TABLE location_daily ADD COLUMN IF NOT EXISTS total_members integer;
ALTER TABLE location_daily ADD COLUMN IF NOT EXISTS member_goal_month_end integer;

ALTER TABLE location_daily DROP CONSTRAINT IF EXISTS location_daily_rewashes_nonneg;
ALTER TABLE location_daily ADD CONSTRAINT location_daily_rewashes_nonneg
  CHECK (rewashes IS NULL OR rewashes >= 0);
ALTER TABLE location_daily DROP CONSTRAINT IF EXISTS location_daily_cancellations_nonneg;
ALTER TABLE location_daily ADD CONSTRAINT location_daily_cancellations_nonneg
  CHECK (cancellations IS NULL OR cancellations >= 0);
ALTER TABLE location_daily DROP CONSTRAINT IF EXISTS location_daily_total_members_nonneg;
ALTER TABLE location_daily ADD CONSTRAINT location_daily_total_members_nonneg
  CHECK (total_members IS NULL OR total_members >= 0);

-- net_members is a convenience delta for the day, NOT the member level. Kept
-- generated so it can't drift from its two inputs.
ALTER TABLE location_daily DROP COLUMN IF EXISTS net_members;
ALTER TABLE location_daily ADD COLUMN net_members integer
  GENERATED ALWAYS AS (COALESCE(sign_ups, 0) - COALESCE(cancellations, 0)) STORED;

-- ===========================================================================
-- 4. greeter_rollup() — rebuilt against the new column set.
-- ===========================================================================
-- Dropped above (before total_cars went away) rather than CREATE OR REPLACEd,
-- because the RETURNS TABLE column list changed and REPLACE cannot alter a
-- function's return type.
--
-- WEIGHTING, unchanged in spirit: every rate is recomputed from SUMmed
-- numerator and denominator, never averaged across days. wash_sales_per_hour
-- here is total wash sales over total hours for the whole filtered range —
-- Josh's "averaged, not an attempted breakdown". AVG(g.wash_sales_per_hour)
-- would weight a 2-hour shift the same as a 10-hour one.
--
-- The two goal columns are the exception and are AVGed, not SUMmed: they are
-- now a percentage and a dollars-per-car rate, and summing either across days
-- produces a meaningless number that grows with the length of the range.
CREATE OR REPLACE FUNCTION greeter_rollup(
  p_date_from         date    DEFAULT NULL,
  p_date_to           date    DEFAULT NULL,
  p_location_id       integer DEFAULT NULL,
  p_site_number       integer DEFAULT NULL,
  p_beekeeper_user_id text    DEFAULT NULL,
  p_greeter           text    DEFAULT NULL,
  p_location_codes    text[]  DEFAULT NULL
)
RETURNS TABLE (
  beekeeper_user_id   text,
  greeter_name        text,
  site_number         integer,
  location_code       text,
  first_date          date,
  last_date           date,
  days_logged         bigint,
  wash_sales          bigint,
  rewashes            bigint,
  package_dollars     numeric,
  extras_dollars      numeric,
  sign_ups            bigint,
  hours_worked        numeric,
  wash_sales_per_hour numeric,
  capture_goal_pct    numeric,
  dob_goal            numeric,
  capture_pct         numeric,
  dob                 numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    g.beekeeper_user_id,
    MAX(g.greeter_name)          AS greeter_name,
    g.site_number,
    g.location_code,
    MIN(g.business_date)         AS first_date,
    MAX(g.business_date)         AS last_date,
    COUNT(*)                     AS days_logged,
    SUM(g.wash_sales)            AS wash_sales,
    SUM(g.rewashes)              AS rewashes,
    SUM(g.package_dollars)       AS package_dollars,
    SUM(g.extras_dollars)        AS extras_dollars,
    SUM(g.sign_ups)              AS sign_ups,
    SUM(g.hours_worked)          AS hours_worked,
    CASE WHEN SUM(g.hours_worked) > 0
      THEN ROUND(SUM(COALESCE(g.wash_sales, 0))::numeric / SUM(g.hours_worked), 2)
    END                          AS wash_sales_per_hour,
    ROUND(AVG(g.capture_goal_pct), 2) AS capture_goal_pct,
    ROUND(AVG(g.dob_goal), 2)         AS dob_goal,
    CASE WHEN SUM(g.wash_sales) > 0
      THEN ROUND(SUM(COALESCE(g.sign_ups, 0))::numeric * 100 / SUM(g.wash_sales), 2)
    END                          AS capture_pct,
    CASE WHEN SUM(g.wash_sales) > 0
      THEN ROUND((SUM(COALESCE(g.package_dollars, 0)) + SUM(COALESCE(g.extras_dollars, 0)))
                 / SUM(g.wash_sales), 2)
    END                          AS dob
  FROM greeter_daily g
  WHERE (p_date_from         IS NULL OR g.business_date     >= p_date_from)
    AND (p_date_to           IS NULL OR g.business_date     <= p_date_to)
    AND (p_location_id       IS NULL OR g.location_id        = p_location_id)
    AND (p_site_number       IS NULL OR g.site_number        = p_site_number)
    AND (p_beekeeper_user_id IS NULL OR g.beekeeper_user_id  = p_beekeeper_user_id)
    AND (p_greeter           IS NULL OR g.greeter_name ILIKE '%' || p_greeter || '%')
    AND (p_location_codes    IS NULL OR g.location_code = ANY (p_location_codes))
  GROUP BY g.beekeeper_user_id, g.site_number, g.location_code
  ORDER BY capture_pct DESC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION greeter_rollup(date, date, integer, integer, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_rollup(date, date, integer, integer, text, text, text[]) TO service_role;
