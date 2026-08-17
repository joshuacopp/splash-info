-- Greeter scorecard, migration 09: churn % (site only) and Google reviews (both).
--
-- Run the WHOLE file — select all (Ctrl+A) first. Running a highlighted fragment
-- fails with "syntax error at end of input", because most of this file is
-- comments and a comment-only selection parses to nothing.
--
-- Requires 07 (greeter-reactivations-07.sql). Safe to re-run.
--
-- SUPERSEDES 08 (greeter-low-sample-08.sql). This file recreates
-- greeter_period_report() with the `< 3` low_sample threshold already in it, so
-- if you have not run 08 yet you can skip it entirely. If you already ran 08,
-- running this changes nothing about that threshold.
--
--
-- THE TWO FIELDS
--
-- churn_pct — SITE ONLY, on location_daily. Self-reported by the site as a
-- percentage. Josh: informational. It gets no goal column, it does not enter the
-- over/under day buckets, and nothing sorts or grades on it.
--
-- google_reviews — BOTH tables. A COUNT of reviews collected that day, not a
-- star rating. Also informational: summed so a period total is visible, and
-- that is all.
--
--
-- WHY CHURN IS NOT AGGREGATED ANYWHERE
--
-- Every other rate in this schema is recomputed from a summed numerator over a
-- summed denominator, which is the only honest way to roll a percentage up. That
-- is impossible here: churn arrives ALREADY DIVIDED, with the site keeping both
-- inputs to itself. There is no members-lost count and no member base to divide
-- it by, so a period figure could only ever be a flat average of daily
-- percentages — exactly the thing the rest of this schema refuses to do, and the
-- thing that makes the greeter workbooks disagree with this report.
--
-- So churn_pct is returned per DAY and never aggregated. location_period_rows()
-- is a day-row function, which is why it is the only reader that gains it. If
-- churn ever needs a period number, the fix is to collect the numerator and
-- denominator, not to average this column.
--
-- google_reviews has no such problem: a count sums cleanly.
--
--
-- WHY THE FUNCTIONS ARE DROPPED FIRST
--
-- All three gain a RETURNS TABLE column, and CREATE OR REPLACE cannot alter a
-- function's return type. Dropped before the columns move, same order 07 used.
--
-- No generated column changes here, so unlike 07 this file does NOT rewrite
-- either table. churn_pct and google_reviews are ordinary nullable columns and
-- ADD COLUMN on a nullable column with no default is metadata-only.
--
-- greeter_scan_rates() and greeter_missing_days() are untouched: neither reads a
-- column this file adds, and neither should ever grade on one.

-- ===========================================================================
-- 1. Drop the three read functions that change shape.
-- ===========================================================================

DROP FUNCTION IF EXISTS greeter_rollup(date, date, integer, integer, text, text, text[]);
DROP FUNCTION IF EXISTS greeter_period_report(date, date, integer, integer, text, text, text[]);
DROP FUNCTION IF EXISTS location_period_rows(date, date, integer, integer, text[]);

-- ===========================================================================
-- 2. The columns.
-- ===========================================================================
-- Nullable on both, not defaulted to 0 — same rule the rest of this schema
-- follows. NULL means "not reported"; 0 means "reported, and there weren't any".
-- For google_reviews especially, a site that never fills the box would otherwise
-- read as a confirmed run of zero-review days.
--
-- churn_pct is numeric(5,2): two decimals, and the CHECK is what actually holds
-- it to a percentage. Without the CHECK the scale alone would happily accept
-- 999.99, and a site fat-fingering a member COUNT into a percent box is the
-- likeliest bad input this column will ever see.

ALTER TABLE location_daily ADD COLUMN IF NOT EXISTS churn_pct      numeric(5,2);
ALTER TABLE location_daily ADD COLUMN IF NOT EXISTS google_reviews integer;
ALTER TABLE greeter_daily  ADD COLUMN IF NOT EXISTS google_reviews integer;

ALTER TABLE location_daily DROP CONSTRAINT IF EXISTS location_daily_churn_pct_range;
ALTER TABLE location_daily ADD CONSTRAINT location_daily_churn_pct_range
  CHECK (churn_pct IS NULL OR (churn_pct >= 0 AND churn_pct <= 100));

ALTER TABLE location_daily DROP CONSTRAINT IF EXISTS location_daily_google_reviews_nonneg;
ALTER TABLE location_daily ADD CONSTRAINT location_daily_google_reviews_nonneg
  CHECK (google_reviews IS NULL OR google_reviews >= 0);

ALTER TABLE greeter_daily DROP CONSTRAINT IF EXISTS greeter_daily_google_reviews_nonneg;
ALTER TABLE greeter_daily ADD CONSTRAINT greeter_daily_google_reviews_nonneg
  CHECK (google_reviews IS NULL OR google_reviews >= 0);

COMMENT ON COLUMN location_daily.churn_pct IS
  'Self-reported daily churn, percent. Informational: no goal, never graded, and never aggregated across days — it arrives already divided with no denominator to re-sum. See greeter-churn-reviews-09.sql.';
COMMENT ON COLUMN location_daily.google_reviews IS
  'Count of Google reviews collected that day. Informational; summed only.';
COMMENT ON COLUMN greeter_daily.google_reviews IS
  'Count of Google reviews collected that day by this greeter. Informational; summed only, never in capture_pct or dob.';

-- ===========================================================================
-- 3. greeter_rollup() — one added SUM.
-- ===========================================================================
-- Identical to 07's definition apart from google_reviews. capture_pct and dob
-- are byte-for-byte unchanged and must stay that way.
CREATE FUNCTION greeter_rollup(
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

-- ===========================================================================
-- 4. greeter_period_report() — one added SUM.
-- ===========================================================================
-- The three day buckets are untouched. They grade capture_pct against
-- capture_goal_pct; google_reviews enters neither side, so over + under +
-- ungraded still equals days_logged and no historical row changes bucket.
CREATE FUNCTION greeter_period_report(
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
    -- Two or fewer graded days is a thin sample. Three is enough to rate someone.
    -- AUTHORITATIVE. presets.ts's LOW_SAMPLE_DAYS is copy only and follows this.
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
-- 5. location_period_rows() — passes both new columns through, unaggregated.
-- ===========================================================================
-- This is a DAY-ROW function: one row per site per date, nothing summed. That is
-- exactly why it is the only reader that gets churn_pct — at day level the
-- percentage is the number the site reported, with no roll-up to get wrong.
--
-- churn_pct sits after dob_goal rather than beside capture_pct, deliberately:
-- the columns before it are goal-graded and it is not, and putting it in the
-- middle of that block invites someone to give it a goal to match its
-- neighbours.
CREATE FUNCTION location_period_rows(
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
  reactivations      integer,
  cancellations      integer,
  total_members      integer,
  net_members        integer,
  capture_pct        numeric,
  dob                numeric,
  capture_goal_pct   numeric,
  dob_goal           numeric,
  churn_pct          numeric,
  google_reviews     integer,
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
      l.reactivations,
      l.cancellations,
      l.total_members,
      l.net_members,
      l.capture_pct,
      l.dob,
      l.capture_goal_pct,
      l.dob_goal,
      l.churn_pct,
      l.google_reviews
    FROM location_daily l
    WHERE l.business_date >= p_date_from
      AND l.business_date <= p_date_to
      AND (p_location_id    IS NULL OR l.location_id   =  p_location_id)
      AND (p_site_number    IS NULL OR l.site_number   =  p_site_number)
      AND (p_location_codes IS NULL OR l.location_code = ANY (p_location_codes))
  ),
  scanned AS (
    -- Every greeter at the site, with no name filter — same reasoning as
    -- greeter_scan_rates(); keep the two consistent.
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
    s.reactivations,
    s.cancellations,
    s.total_members,
    s.net_members,
    s.capture_pct,
    s.dob,
    s.capture_goal_pct,
    s.dob_goal,
    s.churn_pct,
    s.google_reviews,
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

-- ===========================================================================
-- 6. Verification — must be the LAST statement.
-- ===========================================================================
-- The editor renders only the final result grid, so this sits alone at the end.
-- Expect six rows, all ok = true.
--
-- The last two read the function bodies back rather than assuming the CREATEs
-- above are what actually ran: a partial selection that skipped section 5 would
-- leave the old location_period_rows() in place and every column check here
-- would still pass.
SELECT 'location_daily.churn_pct' AS check_name,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'location_daily' AND column_name = 'churn_pct') AS ok
UNION ALL
SELECT 'location_daily.google_reviews',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'location_daily' AND column_name = 'google_reviews')
UNION ALL
SELECT 'greeter_daily.google_reviews',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'greeter_daily' AND column_name = 'google_reviews')
UNION ALL
SELECT 'churn_pct is range-checked 0-100',
       EXISTS (SELECT 1 FROM pg_constraint
               WHERE conname = 'location_daily_churn_pct_range')
UNION ALL
SELECT 'location_period_rows returns churn_pct',
       COALESCE((SELECT pg_get_functiondef(p.oid) LIKE '%churn_pct%'
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE p.proname = 'location_period_rows' AND n.nspname = 'public'), false)
UNION ALL
SELECT 'greeter_period_report returns google_reviews and low_sample < 3',
       COALESCE((SELECT pg_get_functiondef(p.oid) LIKE '%google_reviews%'
                  AND pg_get_functiondef(p.oid) LIKE '%r.gradeable) < 3%'
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE p.proname = 'greeter_period_report' AND n.nspname = 'public'), false)
ORDER BY 1;
