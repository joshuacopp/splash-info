-- ===========================================================================
-- greeter-void-12.sql — edit and withdraw submitted days
-- ===========================================================================
-- Run once, against an existing database. Everything here is also folded into
-- greeter-scorecard-tables.sql so a database built fresh from that file lands
-- in the same shape; the two are kept in sync by convention.
--
-- WHAT CHANGED, AND WHY
--
-- Days could be corrected (re-submitting the same location + greeter + date
-- overwrites) but never withdrawn. A day entered against the wrong site, or for
-- a greeter who wasn't there, had no exit: it stayed in every total forever.
--
-- The answer is a VOID, not a DELETE. The scorecard is the record of what a
-- site reported, and "submitted, then withdrawn" is a different fact from
-- "never submitted" — the first is worth being able to look at later, the
-- second is what the missing-days panel is for. So a struck-out row keeps its
-- values, its author, and its timestamps, and simply stops counting.
--
-- Three moving parts:
--
--   1. voided_at / voided_by / voided_by_email on both daily tables. NULL means
--      live. A restore is voided_at = NULL, which is why this is a nullable
--      timestamp and not a boolean.
--
--   2. The (location, greeter, date) and (location, date) unique constraints
--      become PARTIAL unique indexes, live rows only. Without this, voiding a
--      day would be a trap: the slot stays occupied by the struck-out row, so
--      re-entering the day fails on a duplicate key naming a row that no longer
--      appears in any total. Partial means a void genuinely frees the day.
--
--   3. greeter_daily_live / location_daily_live views, and every reporting
--      function repointed at them. This is the enforcement mechanism for
--      "voided rows are not reported", and it is a view rather than a predicate
--      copied into each function because six functions read these tables — some
--      of them twice — and a rule written twelve times is a rule that will
--      eventually be written eleven.
--
--      It also removes a specific footgun. greeter_missing_days() LEFT JOINs
--      location_daily; spelled as a predicate the exclusion would have to sit
--      in the JOIN's ON clause, because `l.voided_at IS NULL` in the WHERE
--      quietly converts that LEFT JOIN to an inner one and drops every missing
--      day the function exists to find. Reading a view makes that unavailable.
--
-- CONSEQUENCE WORTH SAYING OUT LOUD: voiding a day makes it MISSING again. The
-- site has no standing answer for that date, and the missing-days panel should
-- say so. That is intended, not a side effect.
--
-- The functions below are recreated in full because Postgres has no way to
-- patch a function body. Their only change is the table name in each FROM —
-- they are otherwise character-for-character what greeter-scorecard-tables.sql
-- holds. If you are reviewing this file, that is the diff to look for.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The void columns
-- ---------------------------------------------------------------------------
ALTER TABLE greeter_daily
  ADD COLUMN IF NOT EXISTS voided_at       timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by       uuid,
  ADD COLUMN IF NOT EXISTS voided_by_email text;

ALTER TABLE location_daily
  ADD COLUMN IF NOT EXISTS voided_at       timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by       uuid,
  ADD COLUMN IF NOT EXISTS voided_by_email text;

COMMENT ON COLUMN greeter_daily.voided_at IS
  'Non-NULL means this submission was withdrawn. Nothing computed reads it — '
  'see greeter_daily_live. Restoring is voided_at = NULL.';
COMMENT ON COLUMN location_daily.voided_at IS
  'Non-NULL means this submission was withdrawn. See location_daily_live.';

-- ---------------------------------------------------------------------------
-- 2. Uniqueness, live rows only
-- ---------------------------------------------------------------------------
-- Safe to drop then create in this order because every existing row has
-- voided_at NULL, so the partial index covers exactly the same set the
-- constraint did and cannot fail to build on data that satisfied the old rule.
ALTER TABLE greeter_daily  DROP CONSTRAINT IF EXISTS greeter_daily_unique_day;
ALTER TABLE location_daily DROP CONSTRAINT IF EXISTS location_daily_unique_day;

CREATE UNIQUE INDEX IF NOT EXISTS idx_greeter_daily_unique_live_day
  ON greeter_daily (location_id, beekeeper_user_id, business_date)
  WHERE voided_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_location_daily_unique_live_day
  ON location_daily (location_id, business_date)
  WHERE voided_at IS NULL;

-- Voided rows are read only by the correction screen, keyed by location and
-- date like every other read on these tables. Partial so it stays small — the
-- expected count is a handful of rows against tens of thousands.
CREATE INDEX IF NOT EXISTS idx_greeter_daily_voided
  ON greeter_daily (location_code, business_date DESC)
  WHERE voided_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_location_daily_voided
  ON location_daily (location_code, business_date DESC)
  WHERE voided_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. The reading surface
-- ---------------------------------------------------------------------------
-- SELECT * is deliberate: it saves listing forty-odd columns twice, generated
-- ones included, and reads as "the table, minus the struck-out rows" — which is
-- exactly what these are for.
--
-- BUT IT DOES NOT TRACK THE TABLE. Postgres expands the star ONCE, at CREATE
-- time, and freezes the result in the view definition; a later ALTER TABLE ...
-- ADD COLUMN does NOT appear here. So any future migration that adds a metric to
-- greeter_daily or location_daily must re-run the two CREATE OR REPLACE VIEW
-- statements below, or every reporting function will keep reading the old shape
-- and the new column will be invisible everywhere except the correction screen
-- (which reads the base tables directly).
--
-- Note also that CREATE OR REPLACE VIEW can only ADD columns to the end. If a
-- column is ever dropped or reordered, these need DROP VIEW first — and both
-- views have six functions depending on them, so that is a CASCADE and a
-- re-create of all six in the same transaction.
CREATE OR REPLACE VIEW greeter_daily_live AS
  SELECT * FROM greeter_daily WHERE voided_at IS NULL;

CREATE OR REPLACE VIEW location_daily_live AS
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
-- 4. The six functions, repointed
-- ---------------------------------------------------------------------------
-- Verbatim from greeter-scorecard-tables.sql apart from the FROM clauses. The
-- two UPDATE statements inside greeter_restamp_goals still name the base
-- tables, and need no voided_at predicate of their own: each joins its
-- `resolved` CTE on id, and an id that the CTE's SELECT did not return cannot
-- be written by the UPDATE that follows it.

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
    -- The _live view, so a voided day is never re-graded. The UPDATE below
    -- needs no voided_at predicate of its own: it joins `resolved` on id, and
    -- an id that isn't in this SELECT cannot be written by it.
    --
    -- KNOWN GAP, accepted rather than missed. Skipping voided rows means a day
    -- that was struck out before a goal window moved keeps the goal it was
    -- stamped with, so restoring it brings back a snapshot that no longer
    -- matches the window covering its date. The correct fix is for the restore
    -- path to re-stamp the row it revives, the same way the submit path does;
    -- until then the workaround is to save the goal window again after a
    -- restore, which re-runs this function over the whole range. Re-grading
    -- voided rows here instead would be worse: it would silently rewrite the
    -- record of what a withdrawn day was graded against, which is most of the
    -- reason a void keeps the row at all.
    FROM greeter_daily_live d
    -- LEFT JOIN LATERAL, not a plain one: when no window covers the day the
    -- resolver returns no rows, and an inner join would skip that day rather
    -- than clearing the stale goal off it. Clearing it is the point on delete.
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
    FROM location_daily_live l
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
    CASE WHEN SUM(g.wash_sales) > 0
      THEN ROUND(SUM(COALESCE(g.sign_ups, 0))::numeric * 100 / SUM(g.wash_sales), 2)
    END                          AS capture_pct,
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

-- Only the service role calls this (the worker). Locking it down keeps the
-- function off the anon/authenticated PostgREST surface, where it would run as
-- a SECURITY INVOKER read that RLS on greeter_daily would have to catch.
REVOKE ALL ON FUNCTION greeter_rollup(date, date, integer, integer, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_rollup(date, date, integer, integer, text, text, text[]) TO service_role;

CREATE OR REPLACE FUNCTION greeter_scan_rates(
  p_date_from      date    DEFAULT NULL,
  p_date_to        date    DEFAULT NULL,
  p_location_id    integer DEFAULT NULL,
  p_site_number    integer DEFAULT NULL,
  p_location_codes text[]  DEFAULT NULL
)
RETURNS TABLE (
  business_date        date,
  location_id          integer,
  site_number          integer,
  location_code        text,
  site_wash_sales      integer,
  -- The two deductions are returned individually as well as netted, because
  -- "why is my denominator 380 and not 400" is the first question this column
  -- will be asked.
  house_accounts       integer,
  rewashes             integer,
  scannable_wash_sales integer,
  scanned_wash_sales   bigint,
  greeters_logged      bigint,
  scanned_pct          numeric,
  ever_submitted       boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH site AS (
    -- Driving from location_daily (not a join of both tables) is what makes a
    -- site day with ZERO greeter rows still appear — that row is the point.
    SELECT
      l.business_date,
      l.location_id,
      l.site_number,
      l.location_code,
      l.wash_sales,
      l.house_accounts,
      l.rewashes,
      -- GREATEST(..., 0) because nothing stops a site from typing more
      -- rewashes than wash sales at 11pm, and a negative denominator would
      -- produce a negative percentage that looks like a code bug rather than
      -- like the typo it is.
      GREATEST(
        COALESCE(l.wash_sales, 0)
        - COALESCE(l.house_accounts, 0)
        - COALESCE(l.rewashes, 0),
        0
      ) AS scannable
    FROM location_daily_live l
    WHERE (p_date_from      IS NULL OR l.business_date >= p_date_from)
      AND (p_date_to        IS NULL OR l.business_date <= p_date_to)
      AND (p_location_id    IS NULL OR l.location_id   =  p_location_id)
      AND (p_site_number    IS NULL OR l.site_number   =  p_site_number)
      AND (p_location_codes IS NULL OR l.location_code = ANY(p_location_codes))
  ),
  scanned AS (
    -- No greeter-name filter here, unlike greeter_rollup(). The denominator is
    -- the whole site's day, so the numerator must be every greeter at that
    -- site; filtering it by name would make sites look underreported whenever
    -- someone typed in the filter bar.
    SELECT
      g.business_date,
      g.location_id,
      SUM(COALESCE(g.wash_sales, 0))::bigint AS scanned,
      COUNT(*)::bigint                       AS greeters
    FROM greeter_daily_live g
    JOIN site s
      ON s.business_date = g.business_date
     AND s.location_id   = g.location_id
    GROUP BY g.business_date, g.location_id
  ),
  ever AS (
    -- Lets the UI tell "onboarded and slipping" (0%, flag it) apart from
    -- "never started" (blank, don't nag).
    SELECT DISTINCT g.location_id FROM greeter_daily_live g
  )
  SELECT
    s.business_date,
    s.location_id,
    s.site_number,
    s.location_code,
    s.wash_sales,
    s.house_accounts,
    s.rewashes,
    s.scannable::integer,
    COALESCE(sc.scanned, 0)::bigint,
    COALESCE(sc.greeters, 0)::bigint,
    -- NULL, not 0, when there were no SCANNABLE cars. That now covers two
    -- cases: the site sold nothing, and the site sold nothing a customer could
    -- have scanned for. Neither has a meaningful scan rate.
    CASE
      WHEN s.scannable > 0
      THEN ROUND(COALESCE(sc.scanned, 0)::numeric * 100 / s.scannable, 1)
    END,
    (e.location_id IS NOT NULL)
  FROM site s
  LEFT JOIN scanned sc
    ON sc.business_date = s.business_date
   AND sc.location_id   = s.location_id
  LEFT JOIN ever e
    ON e.location_id = s.location_id
  ORDER BY s.business_date DESC, s.location_code;
$$;

REVOKE ALL ON FUNCTION greeter_scan_rates(date, date, integer, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_scan_rates(date, date, integer, integer, text[]) TO service_role;

CREATE OR REPLACE FUNCTION greeter_missing_days(
  p_date_from      date,
  p_date_to        date,
  p_location_id    integer DEFAULT NULL,
  p_site_number    integer DEFAULT NULL,
  p_location_codes text[]  DEFAULT NULL
)
RETURNS TABLE (
  business_date   date,
  location_id     integer,
  site_number     integer,
  location_code   text,
  has_site_row    boolean,
  greeters_logged bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH submitted AS (
    -- Both tables, so a location that only ever logged one kind of row still
    -- counts as onboarded.
    --
    -- SCOPED HERE, BEFORE THE COLLAPSE. location_code has been observed to
    -- diverge between tables for the same site; collapsing first and filtering
    -- on whichever spelling won would intermittently drop a location admin's
    -- own site out of their panel.
    SELECT l.location_id, l.site_number, l.location_code, l.business_date
      FROM location_daily_live l
     WHERE (p_location_id    IS NULL OR l.location_id   =  p_location_id)
       AND (p_site_number    IS NULL OR l.site_number   =  p_site_number)
       AND (p_location_codes IS NULL OR l.location_code = ANY(p_location_codes))
    UNION ALL
    SELECT g.location_id, g.site_number, g.location_code, g.business_date
      FROM greeter_daily_live g
     WHERE (p_location_id    IS NULL OR g.location_id   =  p_location_id)
       AND (p_site_number    IS NULL OR g.site_number   =  p_site_number)
       AND (p_location_codes IS NULL OR g.location_code = ANY(p_location_codes))
  ),
  scoped AS (
    -- One identity row per location, plus the day it first appeared. Identity
    -- is the most recent submission's spelling; location_code breaks the tie so
    -- the pick is deterministic rather than planner-dependent.
    SELECT DISTINCT ON (s.location_id)
           s.location_id,
           s.site_number,
           s.location_code,
           MIN(s.business_date) OVER (PARTITION BY s.location_id) AS first_seen
      FROM submitted s
     ORDER BY s.location_id, s.business_date DESC, s.location_code
  ),
  days AS (
    SELECT d::date AS business_date
      FROM generate_series(p_date_from, p_date_to, interval '1 day') AS d
  ),
  greeter_counts AS (
    SELECT g.location_id, g.business_date, COUNT(*)::bigint AS greeters
      FROM greeter_daily_live g
     WHERE g.business_date BETWEEN p_date_from AND p_date_to
     GROUP BY g.location_id, g.business_date
  )
  SELECT
    d.business_date,
    s.location_id,
    s.site_number,
    s.location_code,
    (l.id IS NOT NULL),
    COALESCE(gc.greeters, 0)::bigint
  FROM scoped s
  CROSS JOIN days d
  -- The _live view, which is the ONLY correct spelling here: `l.voided_at IS
  -- NULL` in this query's WHERE would turn the LEFT JOIN into an inner one and
  -- drop every missing day. A voided site day therefore counts as missing
  -- again, which is the answer this function should give.
  LEFT JOIN location_daily_live l
    ON l.location_id   = s.location_id
   AND l.business_date = d.business_date
  LEFT JOIN greeter_counts gc
    ON gc.location_id   = s.location_id
   AND gc.business_date = d.business_date
  -- Only the gaps. A complete day is section 6's business, not this one's.
  WHERE (l.id IS NULL OR COALESCE(gc.greeters, 0) = 0)
    -- Never report a day before the location's first submission: a site
    -- onboarded on Wednesday didn't miss Monday.
    AND d.business_date >= s.first_seen
  ORDER BY d.business_date DESC, s.location_code;
$$;

REVOKE ALL ON FUNCTION greeter_missing_days(date, date, integer, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_missing_days(date, date, integer, integer, text[]) TO service_role;

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
    CASE WHEN SUM(r.wash_sales) > 0
      THEN ROUND(SUM(COALESCE(r.sign_ups, 0))::numeric * 100 / SUM(r.wash_sales), 2)
    END                                                   AS capture_pct,
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

-- DROPPED RATHER THAN REPLACED, unlike every other function in this file.
-- CREATE OR REPLACE cannot change a RETURNS TABLE shape, and this one gains an
-- `id` column below; without the drop the whole migration fails on "cannot
-- change return type of existing function". The signature is unchanged, so the
-- REVOKE/GRANT pair after the body still names the same five argument types.
DROP FUNCTION IF EXISTS location_period_rows(date, date, integer, integer, text[]);

CREATE OR REPLACE FUNCTION location_period_rows(
  p_date_from      date,
  p_date_to        date,
  p_location_id    integer DEFAULT NULL,
  p_site_number    integer DEFAULT NULL,
  p_location_codes text[]  DEFAULT NULL
)
RETURNS TABLE (
  -- The site day's own row id, carried purely so the report's drill-through can
  -- offer a Void button. Every other column here is a number to read; this one
  -- is a handle to act on, which is why it leads rather than hiding among them.
  -- location_daily_live has one row per (location, date) and this function does
  -- not aggregate the site side, so the id stays one-to-one with the row.
  id                 uuid,
  business_date      date,
  location_id        integer,
  site_number        integer,
  location_code      text,
  total_cars         integer,
  wash_sales         integer,
  -- Adjacent to rewashes because they are the same kind of fact and are
  -- subtracted together; a reader who finds one should trip over the other.
  house_accounts     integer,
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
  -- After the goal-graded block on purpose: churn has no goal, and slotting it
  -- in among columns that do invites someone to give it one to match.
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
      l.id,
      l.business_date,
      l.location_id,
      l.site_number,
      l.location_code,
      l.total_cars,
      l.wash_sales,
      l.house_accounts,
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
    FROM location_daily_live l
    WHERE l.business_date >= p_date_from
      AND l.business_date <= p_date_to
      AND (p_location_id    IS NULL OR l.location_id   =  p_location_id)
      AND (p_site_number    IS NULL OR l.site_number   =  p_site_number)
      AND (p_location_codes IS NULL OR l.location_code = ANY (p_location_codes))
  ),
  scanned AS (
    -- Every greeter at the site, no name filter — same reasoning as section 6.
    SELECT
      g.business_date,
      g.location_id,
      SUM(COALESCE(g.wash_sales, 0))::bigint AS scanned,
      COUNT(*)::bigint                       AS greeters
    FROM greeter_daily_live g
    JOIN site s
      ON s.business_date = g.business_date
     AND s.location_id   = g.location_id
    GROUP BY g.business_date, g.location_id
  )
  SELECT
    s.id,
    s.business_date,
    s.location_id,
    s.site_number,
    s.location_code,
    s.total_cars,
    s.wash_sales,
    s.house_accounts,
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

COMMIT;

