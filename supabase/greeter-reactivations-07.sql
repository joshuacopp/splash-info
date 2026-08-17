-- Greeter scorecard, migration 07: reactivations.
--
-- Run in the Supabase SQL editor. Safe to re-run: every ALTER is guarded and
-- every function is dropped before it is recreated.
--
--
-- WHAT A REACTIVATION IS AND WHERE IT COUNTS (confirmed with Josh 2026-08-16)
--
-- A lapsed member coming back. It is NOT a sign-up: a sign-up is a new member,
-- and the two are counted separately in the point-of-sale, so folding them
-- together here would make capture % disagree with the register.
--
-- Three decisions, all deliberate, all asked and answered rather than inferred:
--
--   1. capture_pct DOES NOT CHANGE. It stays sign_ups / wash_sales on both
--      tables. A reactivation is not a car captured off the lot — the customer
--      already knew the product — so counting it in the numerator would inflate
--      the rate the scorecard grades greeters on, and would silently restate
--      every historical capture % the day this migration ran.
--
--   2. net_members DOES change, to sign_ups + reactivations - cancellations.
--      That column is the day's change in the member roll, and a reactivation
--      genuinely moves the roll. Leaving it out would make net_members
--      disagree with total_members' own day-over-day delta, which is the one
--      thing net_members exists to approximate.
--
--   3. THE COLUMN GOES ON BOTH TABLES, but the two are not symmetric:
--
--        location_daily   a real input. Feeds net_members (see 2).
--        greeter_daily    OPTIONAL AND INFORMATIONAL ONLY. Nothing is computed
--                         from it — no rate, no goal, no generated column, and
--                         it appears in no grading arithmetic anywhere. It is
--                         carried so a greeter who reactivated somebody gets
--                         credit for it on the page, and totalled in the two
--                         report functions so the credit survives aggregation.
--                         DO NOT give it a denominator later without asking.
--
-- The greeter side has no net_members equivalent on purpose: cancellations are
-- site-only (nobody cancels at a specific greeter's window), so the delta can't
-- be assembled from a greeter's row.
--
--
-- ONE SIDE EFFECT TO EXPECT. Section 3 DROPs and re-ADDs location_daily's
-- net_members, because a generated column's expression cannot be ALTERed in
-- place. Two consequences:
--
--   * net_members moves to the END of the table's physical column order on any
--     database that already had it. greeter-scorecard-tables.sql still declares
--     it in its original position, so a live table diffed against that file
--     will show the columns in a different ORDER while every definition
--     matches. Nothing depends on ordinal position — every reader in this repo
--     uses an explicit column list — but don't go hunting for a phantom
--     schema drift.
--
--   * ADD COLUMN on a STORED generated column rewrites the table under an
--     ACCESS EXCLUSIVE lock. This is not a metadata-only change. At the size
--     these tables are it is instant; on a table with real volume, schedule it.

-- ===========================================================================
-- 1. Drop the three read functions that will change shape.
-- ===========================================================================
-- Dropped rather than CREATE OR REPLACEd, because each gains a RETURNS TABLE
-- column and REPLACE cannot alter a function's return type. Dropped BEFORE the
-- columns move, mirroring what migration 01 had to do around total_cars.
--
-- greeter_scan_rates() and greeter_missing_days() are untouched: neither reads
-- a column this file changes, and neither should ever grade on reactivations.

DROP FUNCTION IF EXISTS greeter_rollup(date, date, integer, integer, text, text, text[]);
DROP FUNCTION IF EXISTS greeter_period_report(date, date, integer, integer, text, text, text[]);
DROP FUNCTION IF EXISTS location_period_rows(date, date, integer, integer, text[]);

-- ===========================================================================
-- 2. The columns.
-- ===========================================================================
-- Nullable on both, and NOT defaulted to 0. NULL means "not reported"; 0 means
-- "reported, and there weren't any". The greeter form leaves the box blank far
-- more often than a site does, and collapsing the two would make a blank field
-- look like a confirmed zero in every total.

ALTER TABLE location_daily ADD COLUMN IF NOT EXISTS reactivations integer;
ALTER TABLE greeter_daily  ADD COLUMN IF NOT EXISTS reactivations integer;

ALTER TABLE location_daily DROP CONSTRAINT IF EXISTS location_daily_reactivations_nonneg;
ALTER TABLE location_daily ADD CONSTRAINT location_daily_reactivations_nonneg
  CHECK (reactivations IS NULL OR reactivations >= 0);

ALTER TABLE greeter_daily DROP CONSTRAINT IF EXISTS greeter_daily_reactivations_nonneg;
ALTER TABLE greeter_daily ADD CONSTRAINT greeter_daily_reactivations_nonneg
  CHECK (reactivations IS NULL OR reactivations >= 0);

-- ===========================================================================
-- 3. net_members — now sign_ups + reactivations - cancellations.
-- ===========================================================================
-- Dropped and re-added rather than altered: a generated column's expression
-- cannot be changed in place, and dropping first is also what makes this file
-- re-runnable after an edit to the arithmetic.
--
-- Still a DELTA, not a level. total_members is the level; do not confuse them.
-- Postgres recomputes the stored value for every existing row on ADD, so days
-- already loaded pick up their reactivations (currently NULL, hence +0) without
-- a backfill.

ALTER TABLE location_daily DROP COLUMN IF EXISTS net_members;
ALTER TABLE location_daily ADD COLUMN net_members integer
  GENERATED ALWAYS AS (
    COALESCE(sign_ups, 0)
    + COALESCE(reactivations, 0)
    - COALESCE(cancellations, 0)
  ) STORED;

-- ===========================================================================
-- 4. greeter_rollup() — rebuilt with a reactivations total.
-- ===========================================================================
-- Identical to migration 01's definition apart from one SUM. capture_pct and
-- dob are byte-for-byte unchanged and must stay that way — see decision 1.
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
-- 5. greeter_period_report() — same one-SUM addition.
-- ===========================================================================
-- The three day buckets are untouched. They are graded on capture_pct against
-- capture_goal_pct, and reactivations enter neither side of that comparison, so
-- over + under + ungraded still equals days_logged and no historical row
-- changes bucket because of this migration.
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
    (COUNT(*) FILTER (WHERE r.gradeable) < 5)             AS low_sample,
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
-- 6. location_period_rows() — passes reactivations through, unaggregated.
-- ===========================================================================
-- Sits next to sign_ups and cancellations, the two columns it belongs with:
-- net_members is now the sum of all three, and a reader who can see the delta
-- but only two of its three inputs cannot check it.
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
      l.dob_goal
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
-- 7. Verification — must be the LAST statement.
-- ===========================================================================
-- The Supabase editor renders only the final result grid, so this sits alone at
-- the end. Expect four rows, all with ok = true.
SELECT 'greeter_daily.reactivations' AS check_name,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'greeter_daily' AND column_name = 'reactivations') AS ok
UNION ALL
SELECT 'location_daily.reactivations',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'location_daily' AND column_name = 'reactivations')
UNION ALL
-- The generation expression is read back rather than assumed: a re-run that
-- silently skipped the DROP would leave the old two-input formula in place and
-- nothing else here would notice.
SELECT 'net_members includes reactivations',
       COALESCE(
         (SELECT generation_expression FROM information_schema.columns
          WHERE table_name = 'location_daily' AND column_name = 'net_members')
         LIKE '%reactivations%', false)
UNION ALL
SELECT 'three functions rebuilt',
       (SELECT COUNT(*) FROM pg_proc
        WHERE proname IN ('greeter_rollup', 'greeter_period_report', 'location_period_rows')) = 3;
