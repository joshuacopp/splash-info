-- ===========================================================================
-- 13. capture_pct gets its real denominator
-- ===========================================================================
-- WHAT CHANGES
--   capture_pct         was  sign_ups / wash_sales
--                       now  sign_ups / (wash_sales + sign_ups)
--
--   dob                 UNCHANGED. Still (package $ + extras $) / wash_sales.
--                       Dollars over base is a per-wash average and its
--                       denominator was never in question. Do not "make them
--                       consistent" — they measure different things.
--
-- WHY. A sign-up and a wash sale are mutually exclusive outcomes for the same
-- car: the customer either bought a single wash or joined the plan. The old
-- formula put signups over wash sales alone, so a greeter who converted more
-- customers than they sold single washes scored above 100% — which is not a
-- rate at all. Four rows from one afternoon at Leray under the old math:
--
--     4 signups /  1 wash  = 400.0%      ->   4 / 5  =  80.0%
--     4 signups /  3 washes= 133.3%      ->   4 / 7  =  57.1%
--    18 signups / 14 washes= 128.6%      ->  18 / 32 =  56.3%
--     2 signups /  3 washes=  66.7%      ->   2 / 5  =  40.0%
--
-- The new denominator is every car that could have gone either way, so the
-- result is bounded 0-100 and reads as "share of opportunities converted".
--
-- THIS REVERSES A WRITTEN-DOWN DECISION. greeter-house-accounts-10.sql:29-35
-- and greeter-reactivations-07.sql:15 both record the gross-wash-sales
-- denominator as deliberate company policy. It was wrong, confirmed by Josh
-- 2026-08-22. Those two notes are left in place as history; this file is the
-- current definition.
--
-- WHAT DOES *NOT* CHANGE, so nobody re-litigates it later:
--   * house_accounts, rewashes, reactivations and google_reviews still stay
--     out of both the numerator and the denominator. A reactivation is not a
--     new capture and a review is not a sale.
--   * capture_pct stays a raw percentage (57.14 = 57.14%), not a 0-1 fraction.
--     The scale is what greeter-scorecard-tables.sql:73-75 was talking about;
--     the denominator was never in scope for that note.
--   * performance_tracking.capture_rate is untouched. It is a separate legacy
--     table, hand-entered on /admin/performance, not derived from greeter logs.
--   * Goal windows are untouched. Managers set their own numbers and will
--     re-aim them; a 25% goal is simply a harder target on the new scale.
--
-- ALL HISTORY RE-DERIVES. capture_pct is GENERATED ALWAYS ... STORED, so
-- dropping and re-adding it recomputes every existing row from wash_sales and
-- sign_ups, which are the raw columns and are not touched. Every past day is
-- restated on the new scale. That is intended — one metric, one meaning.
--
-- THE NULL RULE CHANGES WITH IT.
--   Before: NULL whenever wash_sales was 0 or NULL. "No wash sales" was read
--           as "no opportunities today", which was genuinely unknown.
--   Now:    NULL only when wash_sales + sign_ups is 0. A day with 0 wash sales
--           and 3 sign-ups is 3 opportunities, all three converted — a real
--           100%, not an unknown. A greeter who goes 3-for-3 gets credit for
--           it instead of disappearing from the grade.
--   Consequence: fewer ungraded days. Rows that used to fall in the
--   `ungraded_days` bucket on the report because they had sign-ups but no
--   wash sales now count as gradeable and, in practice, as days over goal.
--
-- ORDERING. RUN greeter-void-12.sql FIRST. This file drops and re-creates
-- greeter_daily_live / location_daily_live and replaces two functions that 12
-- defines. Applying it to a database that has not seen 12 will fail on the
-- missing voided_at column.
--
-- WHY THE VIEWS HAVE TO GO. Both are `SELECT *`, which Postgres expands once
-- at CREATE time and freezes. That freeze is a real dependency on capture_pct,
-- so ALTER TABLE ... DROP COLUMN would be refused. CREATE OR REPLACE VIEW
-- cannot help either — it may only append columns, and the column is moving to
-- the end of the table. DROP then CREATE is the only route. No CASCADE is
-- needed: the six reporting functions have string bodies (LANGUAGE sql AS $$),
-- which Postgres does not dependency-track, so they survive the drop and
-- re-resolve the views on their next call.
--
-- COLUMN ORDER MOVES. capture_pct lands at the end of both tables. Nothing
-- reads these by position — every INSERT in the worker names its columns and
-- every SELECT is explicit — but a hand-written `SELECT *` in psql will show
-- it in a new place.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Take down the reading surface
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS greeter_daily_live;
DROP VIEW IF EXISTS location_daily_live;

-- ---------------------------------------------------------------------------
-- 2. Re-define the column on both daily tables
-- ---------------------------------------------------------------------------
-- Identical expressions. They must stay identical: a greeter row and the site
-- row for the same day are compared side by side on the report, and a
-- denominator that differed between them would make the site look like it was
-- capturing at a different rate than the sum of its greeters.

ALTER TABLE greeter_daily DROP COLUMN capture_pct;
ALTER TABLE greeter_daily
  ADD COLUMN capture_pct numeric(6,2) GENERATED ALWAYS AS (
    CASE WHEN COALESCE(wash_sales, 0) + COALESCE(sign_ups, 0) > 0
      THEN ROUND(
             COALESCE(sign_ups, 0)::numeric * 100
             / (COALESCE(wash_sales, 0) + COALESCE(sign_ups, 0)), 2)
    END
  ) STORED;

ALTER TABLE location_daily DROP COLUMN capture_pct;
ALTER TABLE location_daily
  ADD COLUMN capture_pct numeric(6,2) GENERATED ALWAYS AS (
    CASE WHEN COALESCE(wash_sales, 0) + COALESCE(sign_ups, 0) > 0
      THEN ROUND(
             COALESCE(sign_ups, 0)::numeric * 100
             / (COALESCE(wash_sales, 0) + COALESCE(sign_ups, 0)), 2)
    END
  ) STORED;

COMMENT ON COLUMN greeter_daily.capture_pct IS
  'sign_ups / (wash_sales + sign_ups), as a percentage 0-100. The denominator '
  'is every car that could have gone either way, so this cannot exceed 100. '
  'NULL only when both are zero — nothing happened, so there is no rate. '
  'Reactivations, rewashes, house accounts and reviews are excluded from both '
  'sides. Changed 2026-08-22; it used to divide by wash_sales alone.';
COMMENT ON COLUMN location_daily.capture_pct IS
  'Same definition as greeter_daily.capture_pct, and it must stay the same.';

-- ---------------------------------------------------------------------------
-- 3. Put the reading surface back
-- ---------------------------------------------------------------------------
-- Verbatim from greeter-void-12.sql sections 3. Re-stating the grants and
-- comments because DROP VIEW took them with it.
CREATE VIEW greeter_daily_live AS
  SELECT * FROM greeter_daily WHERE voided_at IS NULL;

CREATE VIEW location_daily_live AS
  SELECT * FROM location_daily WHERE voided_at IS NULL;

REVOKE ALL ON greeter_daily_live  FROM PUBLIC;
REVOKE ALL ON location_daily_live FROM PUBLIC;
GRANT SELECT ON greeter_daily_live  TO service_role;
GRANT SELECT ON location_daily_live TO service_role;

COMMENT ON VIEW greeter_daily_live IS
  'greeter_daily minus voided rows. Every reporting function reads this, not '
  'the table. Read the table directly only to show a user their own struck-out '
  'rows so they can restore one.';
COMMENT ON VIEW location_daily_live IS
  'location_daily minus voided rows. See greeter_daily_live.';

-- ---------------------------------------------------------------------------
-- 4. The two functions that recompute capture from sums
-- ---------------------------------------------------------------------------
-- Only two of the six need touching.
--
--   greeter_rollup         recomputes capture_pct from summed columns.
--   greeter_period_report  recomputes capture_pct from summed columns, and
--                          grades each DAY on the stored column (which the
--                          ALTER above already fixed).
--   location_period_rows   passes l.capture_pct straight through from the
--                          view. Fixed by section 2, no re-definition needed.
--   greeter_restamp_goals  goals only.
--   greeter_scan_rates     wash sales only.
--   greeter_missing_days   row presence only.
--
-- WEIGHTING IS THE POINT AND SURVIVES THE CHANGE. These sum the numerator and
-- sum the denominator, then divide once. AVG(capture_pct) would weight a
-- 3-car day the same as a 300-car day. The spreadsheets flat-average theirs,
-- which is why these numbers read lower than the sheet footers.

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
  reactivations       bigint,
  google_reviews      bigint,
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
    -- A plain total and nothing else. Not added to sign_ups, not divided by
    -- wash_sales, not compared to a goal.
    SUM(g.reactivations)         AS reactivations,
    -- Same deal. A review is not a capture and must never reach capture_pct.
    SUM(g.google_reviews)        AS google_reviews,
    SUM(g.hours_worked)          AS hours_worked,
    CASE WHEN SUM(g.hours_worked) > 0
      THEN ROUND(SUM(COALESCE(g.wash_sales, 0))::numeric / SUM(g.hours_worked), 2)
    END                          AS wash_sales_per_hour,
    ROUND(AVG(g.capture_goal_pct), 2) AS capture_goal_pct,
    ROUND(AVG(g.dob_goal), 2)         AS dob_goal,
    -- Opportunities = wash sales + sign-ups. See the header. The guard is on
    -- the sum, not on wash_sales alone: a stretch with no wash sales but some
    -- sign-ups is 100%, not unknown.
    CASE WHEN SUM(COALESCE(g.wash_sales, 0)) + SUM(COALESCE(g.sign_ups, 0)) > 0
      THEN ROUND(
             SUM(COALESCE(g.sign_ups, 0))::numeric * 100
             / (SUM(COALESCE(g.wash_sales, 0)) + SUM(COALESCE(g.sign_ups, 0))), 2)
    END                          AS capture_pct,
    -- dob keeps the wash_sales denominator. Deliberate, not an oversight.
    CASE WHEN SUM(g.wash_sales) > 0
      THEN ROUND((SUM(COALESCE(g.package_dollars, 0)) + SUM(COALESCE(g.extras_dollars, 0)))
                 / SUM(g.wash_sales), 2)
    END                          AS dob
  FROM greeter_daily_live g
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

CREATE OR REPLACE FUNCTION greeter_period_report(
  p_date_from         date,
  p_date_to           date,
  p_location_id       integer DEFAULT NULL,
  p_site_number       integer DEFAULT NULL,
  p_beekeeper_user_id text    DEFAULT NULL,
  p_greeter           text    DEFAULT NULL,
  p_location_codes    text[]  DEFAULT NULL
)
RETURNS TABLE (
  beekeeper_user_id   text,
  greeter_name        text,
  location_id         integer,
  site_number         integer,
  location_code       text,
  first_date          date,
  last_date           date,
  days_logged         bigint,
  gradeable_days      bigint,
  ungraded_days       bigint,
  days_over_goal      bigint,
  days_under_goal     bigint,
  pct_days_over       numeric,
  pct_days_under      numeric,
  low_sample          boolean,
  wash_sales          bigint,
  sign_ups            bigint,
  reactivations       bigint,
  google_reviews      bigint,
  package_dollars     numeric,
  extras_dollars      numeric,
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
  WITH graded AS (
    -- Day grain. over + under + ungraded always equals days_logged — a property
    -- worth preserving if you add a fourth bucket.
    --
    -- The day grade reads the STORED capture_pct, so it moved to the new
    -- denominator with the ALTER TABLE and needs no change here. What does
    -- change in practice: a day with sign-ups but no wash sales used to be
    -- NULL and land in `ungraded`, and is now a genuine 100% and gradeable.
    SELECT
      g.beekeeper_user_id,
      g.greeter_name,
      g.location_id,
      g.site_number,
      g.location_code,
      g.business_date,
      g.wash_sales,
      g.sign_ups,
      g.reactivations,
      g.google_reviews,
      g.package_dollars,
      g.extras_dollars,
      g.hours_worked,
      g.capture_goal_pct,
      g.dob_goal,
      (g.capture_pct IS NOT NULL AND g.capture_goal_pct IS NOT NULL) AS gradeable,
      CASE WHEN g.capture_pct IS NOT NULL AND g.capture_goal_pct IS NOT NULL
                AND g.capture_pct >= g.capture_goal_pct
           THEN 1 ELSE 0 END AS is_over,
      CASE WHEN g.capture_pct IS NOT NULL AND g.capture_goal_pct IS NOT NULL
                AND g.capture_pct <  g.capture_goal_pct
           THEN 1 ELSE 0 END AS is_under
    FROM greeter_daily_live g
    WHERE g.business_date >= p_date_from
      AND g.business_date <= p_date_to
      AND (p_location_id       IS NULL OR g.location_id       = p_location_id)
      AND (p_site_number       IS NULL OR g.site_number       = p_site_number)
      AND (p_beekeeper_user_id IS NULL OR g.beekeeper_user_id = p_beekeeper_user_id)
      AND (p_greeter           IS NULL OR g.greeter_name ILIKE '%' || p_greeter || '%')
      AND (p_location_codes    IS NULL OR g.location_code = ANY (p_location_codes))
  )
  SELECT
    r.beekeeper_user_id,
    MAX(r.greeter_name)                                   AS greeter_name,
    r.location_id,
    r.site_number,
    r.location_code,
    MIN(r.business_date)                                  AS first_date,
    MAX(r.business_date)                                  AS last_date,
    COUNT(*)::bigint                                      AS days_logged,
    COUNT(*) FILTER (WHERE r.gradeable)::bigint           AS gradeable_days,
    COUNT(*) FILTER (WHERE NOT r.gradeable)::bigint       AS ungraded_days,
    SUM(r.is_over)::bigint                                AS days_over_goal,
    SUM(r.is_under)::bigint                               AS days_under_goal,
    -- NULL, not 0, when nothing was gradeable: "0% of days beat goal" and "we
    -- couldn't grade any of these days" are different statements.
    CASE WHEN COUNT(*) FILTER (WHERE r.gradeable) > 0
      THEN ROUND(SUM(r.is_over)::numeric  * 100 / COUNT(*) FILTER (WHERE r.gradeable), 1)
    END                                                   AS pct_days_over,
    CASE WHEN COUNT(*) FILTER (WHERE r.gradeable) > 0
      THEN ROUND(SUM(r.is_under)::numeric * 100 / COUNT(*) FILTER (WHERE r.gradeable), 1)
    END                                                   AS pct_days_under,
    -- Keep in lockstep with greeter-churn-reviews-09.sql. See the note above.
    (COUNT(*) FILTER (WHERE r.gradeable) < 3)             AS low_sample,
    SUM(r.wash_sales)::bigint                             AS wash_sales,
    SUM(r.sign_ups)::bigint                               AS sign_ups,
    SUM(r.reactivations)::bigint                          AS reactivations,
    SUM(r.google_reviews)::bigint                         AS google_reviews,
    SUM(r.package_dollars)                                AS package_dollars,
    SUM(r.extras_dollars)                                 AS extras_dollars,
    SUM(r.hours_worked)                                   AS hours_worked,
    CASE WHEN SUM(r.hours_worked) > 0
      THEN ROUND(SUM(COALESCE(r.wash_sales, 0))::numeric / SUM(r.hours_worked), 2)
    END                                                   AS wash_sales_per_hour,
    ROUND(AVG(r.capture_goal_pct), 2)                     AS capture_goal_pct,
    ROUND(AVG(r.dob_goal), 2)                             AS dob_goal,
    -- Opportunities = wash sales + sign-ups. Must match greeter_rollup exactly;
    -- the two are shown on screens a click apart and any drift reads as a bug.
    CASE WHEN SUM(COALESCE(r.wash_sales, 0)) + SUM(COALESCE(r.sign_ups, 0)) > 0
      THEN ROUND(
             SUM(COALESCE(r.sign_ups, 0))::numeric * 100
             / (SUM(COALESCE(r.wash_sales, 0)) + SUM(COALESCE(r.sign_ups, 0))), 2)
    END                                                   AS capture_pct,
    -- dob keeps the wash_sales denominator. Deliberate, not an oversight.
    CASE WHEN SUM(r.wash_sales) > 0
      THEN ROUND((SUM(COALESCE(r.package_dollars, 0)) + SUM(COALESCE(r.extras_dollars, 0)))
                 / SUM(r.wash_sales), 2)
    END                                                   AS dob
  FROM graded r
  GROUP BY r.beekeeper_user_id, r.location_id, r.site_number, r.location_code
  -- Aggregate expressions, not the output aliases: RETURNS TABLE column names
  -- are in scope inside a SQL-language function body, so a bare alias here is
  -- at best ambiguous.
  ORDER BY SUM(r.is_over)::numeric
             / NULLIF(COUNT(*) FILTER (WHERE r.gradeable), 0) DESC NULLS LAST,
           MAX(r.greeter_name);
$$;

REVOKE ALL ON FUNCTION greeter_period_report(date, date, integer, integer, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_period_report(date, date, integer, integer, text, text, text[]) TO service_role;

COMMIT;

-- ===========================================================================
-- AFTER RUNNING — sanity checks, not part of the migration
-- ===========================================================================
-- 1. Nothing may exceed 100 any more. Expect zero rows from both.
--
--   SELECT id, business_date, greeter_name, wash_sales, sign_ups, capture_pct
--     FROM greeter_daily WHERE capture_pct > 100;
--
--   SELECT id, business_date, location_code, wash_sales, sign_ups, capture_pct
--     FROM location_daily WHERE capture_pct > 100;
--
-- 2. Spot-check the Leray afternoon from the header. Expect 80.00, 57.14,
--    56.25 and 40.00 where the screenshot showed 400.0, 133.3, 128.6 and 66.7.
--
--   SELECT greeter_name, wash_sales, sign_ups, capture_pct
--     FROM greeter_daily
--    WHERE site_number = 148
--    ORDER BY business_date DESC, greeter_name;
--
-- 3. Days that were ungraded only because they had no wash sales are now
--    graded. Expect these to have a non-NULL capture_pct of 100.00.
--
--   SELECT business_date, greeter_name, wash_sales, sign_ups, capture_pct
--     FROM greeter_daily
--    WHERE COALESCE(wash_sales, 0) = 0 AND COALESCE(sign_ups, 0) > 0;
--
-- 4. Confirm dob did NOT move. Compare against a number you wrote down before
--    running this; it should be identical.
--
--   SELECT greeter_name, package_dollars, extras_dollars, wash_sales, dob
--     FROM greeter_daily WHERE site_number = 148 ORDER BY business_date DESC;
-- ===========================================================================
