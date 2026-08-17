-- Greeter scorecard, migration 08: low_sample threshold 5 -> 3.
--
-- Run the WHOLE file. Select all (Ctrl+A) before Run — running a highlighted
-- fragment of it will fail with "syntax error at end of input", because most of
-- the file is comment lines and a comment-only selection parses to nothing.
--
-- Requires 07 (greeter-reactivations-07.sql) to have been applied already. If it
-- hasn't, run 07 instead — it contains this same function with the new threshold
-- baked in, and this file will fail on the missing `reactivations` column.
--
--
-- WHAT CHANGES
--
-- One boolean expression inside greeter_period_report(). low_sample flipped from
-- "fewer than 5 gradeable days" to "fewer than 3" — so only two days or fewer is
-- now a thin sample. Josh's call: a greeter working four days in a seven-day
-- window is an ordinary part-time schedule, and flagging that made the "Few days"
-- tag noise rather than signal.
--
-- Nothing else in the function moves. Same signature, same RETURNS TABLE, same
-- arithmetic everywhere else — which is why this is a CREATE OR REPLACE and not
-- a DROP. No column changes, no table rewrite, no lock worth planning around.
--
-- No stored data changes either. low_sample is computed at read time, so every
-- existing row simply grades differently the next time the report is opened.
--
--
-- KEEP IN LOCKSTEP
--
-- greeter-scorecard-tables.sql carries an inlined copy of this function for
-- from-scratch builds and already has `< 3`. The page's LOW_SAMPLE_DAYS constant
-- in report/_lib/presets.ts is COPY ONLY — it exists so the explanatory text
-- can't drift from this expression, and is already 3. If the threshold moves
-- again it moves HERE first, then in those two.

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
    CASE WHEN COUNT(*) FILTER (WHERE r.gradeable) > 0
      THEN ROUND(SUM(r.is_over)::numeric  * 100 / COUNT(*) FILTER (WHERE r.gradeable), 1)
    END                                                   AS pct_days_over,
    CASE WHEN COUNT(*) FILTER (WHERE r.gradeable) > 0
      THEN ROUND(SUM(r.is_under)::numeric * 100 / COUNT(*) FILTER (WHERE r.gradeable), 1)
    END                                                   AS pct_days_under,
    -- THE ONE LINE THIS MIGRATION EXISTS FOR. Was `< 5`.
    -- AUTHORITATIVE. presets.ts's LOW_SAMPLE_DAYS is copy only and follows this.
    (COUNT(*) FILTER (WHERE r.gradeable) < 3)             AS low_sample,
    SUM(r.wash_sales)::bigint                             AS wash_sales,
    SUM(r.sign_ups)::bigint                               AS sign_ups,
    SUM(r.reactivations)::bigint                          AS reactivations,
    SUM(r.package_dollars)                                AS package_dollars,
    SUM(r.extras_dollars)                                 AS extras_dollars,
    SUM(r.hours_worked)                                   AS hours_worked,
    CASE WHEN SUM(r.hours_worked) > 0
      THEN ROUND(SUM(COALESCE(r.wash_sales, 0))::numeric / SUM(r.hours_worked), 2)
    END                                                   AS wash_sales_per_hour,
    ROUND(AVG(r.capture_goal_pct), 2)                     AS capture_goal_pct,
    ROUND(AVG(r.dob_goal), 2)                             AS dob_goal,
    CASE WHEN SUM(r.wash_sales) > 0
      THEN ROUND(SUM(COALESCE(r.sign_ups, 0))::numeric * 100 / SUM(r.wash_sales), 2)
    END                                                   AS capture_pct,
    CASE WHEN SUM(r.wash_sales) > 0
      THEN ROUND((SUM(COALESCE(r.package_dollars, 0)) + SUM(COALESCE(r.extras_dollars, 0)))
                 / SUM(r.wash_sales), 2)
    END                                                   AS dob
  FROM graded r
  GROUP BY r.beekeeper_user_id, r.location_id, r.site_number, r.location_code
  ORDER BY SUM(r.is_over)::numeric
             / NULLIF(COUNT(*) FILTER (WHERE r.gradeable), 0) DESC NULLS LAST,
           MAX(r.greeter_name);
$$;

REVOKE ALL ON FUNCTION greeter_period_report(date, date, integer, integer, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_period_report(date, date, integer, integer, text, text, text[]) TO service_role;

-- ===========================================================================
-- Verification. Must be the LAST statement — the editor only renders the
-- final result grid.
-- ===========================================================================
-- Reads the threshold back out of the stored function source rather than
-- trusting that the CREATE above is the version that ran. Then shows every
-- greeter in the seeded window with the flag as it now stands, so you can see
-- which rows changed sides.
--
-- EXPECTED: threshold_ok = true, and any greeter with 3+ graded days reading
-- low_sample = false.

SELECT
  'threshold' AS check,
  NULL::text  AS greeter,
  NULL::bigint AS gradeable_days,
  (pg_get_functiondef(p.oid) LIKE '%r.gradeable) < 3%') AS low_sample
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'greeter_period_report'
  AND n.nspname = 'public'

UNION ALL

SELECT
  'greeter',
  greeter_name,
  gradeable_days,
  low_sample
FROM greeter_period_report(DATE '2026-08-01', DATE '2026-08-31')

ORDER BY 1, 3;
