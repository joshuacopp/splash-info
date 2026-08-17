-- Greeter scorecard, migration 04: the two functions behind /admin/greeters/report.
--
-- SUPERSEDED BY 07 (greeter-reactivations-07.sql). Both functions defined here
-- gained a `reactivations` column in their RETURNS TABLE. Do NOT re-run this
-- file on a database that has had 07 applied: the CREATE OR REPLACEs below will
-- fail with "cannot change return type of existing function", which is a loud
-- failure rather than a silent rollback, but it is a wasted run. Run 07 instead
-- — it drops and recreates both functions in full. This file is kept for the
-- history of why they are shaped the way they are.
--
-- Run in the Supabase SQL editor. Safe to re-run (CREATE OR REPLACE only).
-- Independent of 01, 02 and 03 — adds no columns and changes no existing object.
--
--
-- WHY THESE TWO AND NOT MORE
--
-- The report page has five views (previous 7 days, underperformers, top
-- performers, morning call, and the overview with its charts). They are all fed
-- by exactly two queries:
--
--   greeter_period_report()  one row per greeter per site, aggregated.
--   location_period_rows()   one row per site per DAY, raw.
--
-- The three greeter views differ only in window length and in a threshold on
-- columns this function already returns, so they are UI filters over one query
-- rather than three near-identical functions. Adding a sixth view later should
-- not need a migration.
--
-- location_period_rows() deliberately returns day rows and does NOT aggregate.
-- The morning-call table wants per-site totals and the trend chart wants
-- per-day totals — two different groupings of the same facts. Returning the
-- days once and grouping twice in the page guarantees the table and the chart
-- can never disagree, which two separate aggregate functions could not. The
-- grouping the page does is summing raw numerators and denominators, so the
-- weighting rule below is preserved.
--
--
-- WEIGHTING (same rule as greeter_rollup(), do not break it)
--
-- capture_pct and dob are recomputed from SUMmed numerator over SUMmed
-- denominator. Never AVG() the per-day percentage columns: that weights a
-- 3-car day the same as a 300-car day. The goal columns ARE averaged, because
-- they are already rates and summing them would grow with the window length.
--
--
-- WHAT "OVER GOAL" MEANS — read before changing the arithmetic
--
-- Counted at the DAY grain, before aggregation, because "18 of her 24 days beat
-- goal" is not derivable from a 24-day average. This is the whole reason a new
-- function exists instead of adding columns to greeter_rollup().
--
--   over    capture_pct >= capture_goal_pct   (hitting the number exactly is
--                                              hitting it, not missing it)
--   under   capture_pct <  capture_goal_pct
--   neither capture_pct IS NULL (no wash sales that day, so no opportunity and
--           no rate) OR capture_goal_pct IS NULL (no goal window covered the
--           day, so there is nothing to grade against)
--
-- The "neither" bucket is returned as ungraded_days rather than dropped, so the
-- page can say "5 of 12 days couldn't be graded" instead of quietly reporting
-- percentages off a denominator the reader can't see.
--
-- pct_days_over / pct_days_under are over GRADEABLE days, not days_logged.
-- Dividing by days_logged would let a greeter improve their standing by logging
-- days with no wash sales.
--
--
-- LOW SAMPLE
--
-- Two days, both under goal, is "100% under goal" and would otherwise open the
-- underperformer list. low_sample marks anyone with fewer than 5 gradeable days
-- so the page can sort them to the BOTTOM of both lists with a note, rather
-- than excluding them (Josh, 2026-08-15: he wants to see them, just not at the
-- top).
--
-- The flag is computed HERE and returned as a column rather than the page
-- comparing gradeable_days < 5 itself. One definition of "few reported
-- numbers", in the same place as the arithmetic it qualifies — if the threshold
-- moves, it moves once and every view follows.

-- ===========================================================================
-- 1. greeter_period_report() — per greeter per site, over a window.
-- ===========================================================================
-- Grain is (greeter, site), matching greeter_rollup(): one person's numbers at
-- two different sites are two different jobs and averaging them together would
-- hide a site-specific problem.
--
-- No threshold parameters. The caller asks for the window and does its own
-- filtering — see the header note.
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
    -- Day grain. The three CASEs are mutually exclusive and cover every row,
    -- so over + under + ungraded always equals days_logged — a property worth
    -- preserving if you add a fourth bucket.
    SELECT
      g.beekeeper_user_id,
      g.greeter_name,
      g.location_id,
      g.site_number,
      g.location_code,
      g.business_date,
      g.wash_sales,
      g.sign_ups,
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
    FROM greeter_daily g
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
    -- Display snapshot; MAX() picks one deterministically if the name was
    -- corrected mid-window.
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
    -- NULL, not 0, when nothing was gradeable: "0% of days beat goal" and
    -- "we couldn't grade any of these days" are different statements and the
    -- page renders them differently.
    CASE WHEN COUNT(*) FILTER (WHERE r.gradeable) > 0
      THEN ROUND(SUM(r.is_over)::numeric  * 100 / COUNT(*) FILTER (WHERE r.gradeable), 1)
    END                                                   AS pct_days_over,
    CASE WHEN COUNT(*) FILTER (WHERE r.gradeable) > 0
      THEN ROUND(SUM(r.is_under)::numeric * 100 / COUNT(*) FILTER (WHERE r.gradeable), 1)
    END                                                   AS pct_days_under,
    (COUNT(*) FILTER (WHERE r.gradeable) < 5)             AS low_sample,
    SUM(r.wash_sales)::bigint                             AS wash_sales,
    SUM(r.sign_ups)::bigint                               AS sign_ups,
    SUM(r.package_dollars)                                AS package_dollars,
    SUM(r.extras_dollars)                                 AS extras_dollars,
    SUM(r.hours_worked)                                   AS hours_worked,
    CASE WHEN SUM(r.hours_worked) > 0
      THEN ROUND(SUM(COALESCE(r.wash_sales, 0))::numeric / SUM(r.hours_worked), 2)
    END                                                   AS wash_sales_per_hour,
    ROUND(AVG(r.capture_goal_pct), 2)                     AS capture_goal_pct,
    ROUND(AVG(r.dob_goal), 2)                             AS dob_goal,
    -- Weighted, not averaged. See the header.
    CASE WHEN SUM(r.wash_sales) > 0
      THEN ROUND(SUM(COALESCE(r.sign_ups, 0))::numeric * 100 / SUM(r.wash_sales), 2)
    END                                                   AS capture_pct,
    CASE WHEN SUM(r.wash_sales) > 0
      THEN ROUND((SUM(COALESCE(r.package_dollars, 0)) + SUM(COALESCE(r.extras_dollars, 0)))
                 / SUM(r.wash_sales), 2)
    END                                                   AS dob
  FROM graded r
  GROUP BY r.beekeeper_user_id, r.location_id, r.site_number, r.location_code
  -- Default order is "most days beaten first". Every caller re-sorts for its
  -- own view; this just makes an unsorted read look sane.
  --
  -- Written as the aggregate expressions rather than the output aliases
  -- (pct_days_over, greeter_name) on purpose: RETURNS TABLE column names are in
  -- scope inside a SQL-language function body, so a bare alias here is at best
  -- ambiguous and at worst resolves to the wrong thing.
  ORDER BY SUM(r.is_over)::numeric
             / NULLIF(COUNT(*) FILTER (WHERE r.gradeable), 0) DESC NULLS LAST,
           MAX(r.greeter_name);
$$;

REVOKE ALL ON FUNCTION greeter_period_report(date, date, integer, integer, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_period_report(date, date, integer, integer, text, text, text[]) TO service_role;

-- ===========================================================================
-- 2. location_period_rows() — per site per day, raw, plus attribution.
-- ===========================================================================
-- Returns days, not totals, on purpose — see the header note.
--
-- Driven from location_daily, so a day the site didn't report produces no row.
-- That is correct here: this function reports what WAS submitted, and the
-- reader is told "5 of 7 days reported" by counting rows against the window.
-- The separate question of which specific days are missing is
-- greeter_missing_days()'s job (migration 03) and is not duplicated here.
--
-- total_members is passed through UNSUMMED and unaggregated. It is a LEVEL —
-- active members as of that day — and summing it across a week produces a
-- number roughly seven times the truth. Any caller wanting "members now" must
-- read it at the latest business_date in the window. This function cannot
-- enforce that; it is called out here and again in the TS wrapper.
CREATE OR REPLACE FUNCTION location_period_rows(
  p_date_from      date,
  p_date_to        date,
  p_location_id    integer DEFAULT NULL,
  p_site_number    integer DEFAULT NULL,
  p_location_codes text[]  DEFAULT NULL
)
RETURNS TABLE (
  business_date      date,
  location_id        integer,
  site_number        integer,
  location_code      text,
  total_cars         integer,
  wash_sales         integer,
  rewashes           integer,
  package_dollars    numeric,
  extras_dollars     numeric,
  sign_ups           integer,
  cancellations      integer,
  total_members      integer,
  net_members        integer,
  capture_pct        numeric,
  dob                numeric,
  capture_goal_pct   numeric,
  dob_goal           numeric,
  scanned_wash_sales bigint,
  greeters_logged    bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH site AS (
    SELECT
      l.business_date,
      l.location_id,
      l.site_number,
      l.location_code,
      l.total_cars,
      l.wash_sales,
      l.rewashes,
      l.package_dollars,
      l.extras_dollars,
      l.sign_ups,
      l.cancellations,
      l.total_members,
      l.net_members,
      l.capture_pct,
      l.dob,
      l.capture_goal_pct,
      l.dob_goal
    FROM location_daily l
    WHERE l.business_date >= p_date_from
      AND l.business_date <= p_date_to
      AND (p_location_id    IS NULL OR l.location_id   =  p_location_id)
      AND (p_site_number    IS NULL OR l.site_number   =  p_site_number)
      AND (p_location_codes IS NULL OR l.location_code = ANY (p_location_codes))
  ),
  scanned AS (
    -- Every greeter at the site, with no name filter — the denominator is the
    -- whole site's day, so filtering the numerator by person would make sites
    -- look underreported whenever someone typed in the filter bar. Same
    -- reasoning as greeter_scan_rates(); keep the two consistent.
    SELECT
      g.business_date,
      g.location_id,
      SUM(COALESCE(g.wash_sales, 0))::bigint AS scanned,
      COUNT(*)::bigint                       AS greeters
    FROM greeter_daily g
    JOIN site s
      ON s.business_date = g.business_date
     AND s.location_id   = g.location_id
    GROUP BY g.business_date, g.location_id
  )
  SELECT
    s.business_date,
    s.location_id,
    s.site_number,
    s.location_code,
    s.total_cars,
    s.wash_sales,
    s.rewashes,
    s.package_dollars,
    s.extras_dollars,
    s.sign_ups,
    s.cancellations,
    s.total_members,
    s.net_members,
    s.capture_pct,
    s.dob,
    s.capture_goal_pct,
    s.dob_goal,
    COALESCE(sc.scanned, 0)::bigint,
    COALESCE(sc.greeters, 0)::bigint
  FROM site s
  LEFT JOIN scanned sc
    ON sc.business_date = s.business_date
   AND sc.location_id   = s.location_id
  ORDER BY s.business_date DESC, s.location_code;
$$;

REVOKE ALL ON FUNCTION location_period_rows(date, date, integer, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION location_period_rows(date, date, integer, integer, text[]) TO service_role;

-- Both functions filter greeter_daily by business_date and group/join by
-- (business_date, location_id). Migration 02 adds this index; repeated with
-- IF NOT EXISTS so this file stands alone.
CREATE INDEX IF NOT EXISTS greeter_daily_date_location_idx
  ON greeter_daily (business_date, location_id);

-- greeter_period_report() groups by (beekeeper_user_id, location_id, ...) after
-- a business_date range scan. idx_greeter_daily_date (business_date DESC) from
-- the base schema drives the scan; the grouping is a sort over the result and
-- does not want its own index at this row count.
