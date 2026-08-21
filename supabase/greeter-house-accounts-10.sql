-- ===========================================================================
-- greeter-house-accounts-10.sql
--
-- Adds location_daily.house_accounts and changes ONE metric: the scanned
-- percentage.
--
-- WHY
-- ---
-- A house-account car and a rewash are both real cars that both count as wash
-- sales, and a customer cannot scan a loyalty card for either one. They are
-- therefore in the denominator of the scan rate but can never be in the
-- numerator, which drags a site's scanned % down by exactly the amount of
-- business it did correctly. A site running twenty house accounts on a
-- four-hundred-car day is penalised five points for doing nothing wrong.
--
-- The fix is to stop counting unscannable cars as scannable:
--
--   scannable = wash_sales - house_accounts - rewashes
--
-- REWASHES WERE PREVIOUSLY DEDUCTED FROM NOTHING. The column has been
-- collected on both forms and displayed in three tables since the scorecard
-- shipped, but no denominator anywhere used it. So this migration introduces
-- the rewash deduction as much as it introduces house accounts; a site's
-- scanned % will move on this migration even before anyone types a house
-- account number in.
--
-- WHAT DELIBERATELY DOES NOT CHANGE
-- ---------------------------------
-- capture_pct and dob keep the GROSS wash_sales denominator. That is a company
-- policy call, not an oversight: house accounts and rewashes are included in
-- the capture rate even though they aren't salable cars. Do not "fix" this to
-- match the scan rate — the two metrics answer to different rules on purpose.
-- capture_pct and dob are also GENERATED ALWAYS columns on both daily tables,
-- so changing them would mean rewriting stored data, not just a function.
--
-- WHERE house_accounts LIVES
-- --------------------------
-- location_daily ONLY. It is a site fact — nobody hands a greeter a house
-- account to log against their own name — and it sits alongside total_cars,
-- cancellations and total_members, the other three site-only metrics.
-- greeter_daily deliberately does not get this column.
--
-- WHAT ABOUT THE NUMERATOR
-- ------------------------
-- Left gross, on purpose. The numerator is the sum of greeter-reported
-- wash_sales, i.e. how many cars the greeters actually logged. Netting the
-- denominator without netting the numerator means the ratio can now exceed
-- 100% more easily than before (it already could — a site under-reporting its
-- own wash_sales relative to its greeters has always been able to). Read a
-- figure over 100% as "the site's totals are wrong", which is the same thing
-- it meant before this migration.
--
-- Idempotent. Safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
-- Nullable, matching every other metric on this table: NULL means "nobody told
-- us", 0 means "we ran none". The scan rate treats both as zero deduction, but
-- the distinction is what lets the UI show a blank instead of a confident 0.
--
-- The CHECK is NAMED because the verification block at the bottom of this file
-- looks it up by name, and an inline unnamed CHECK would auto-name to
-- location_daily_house_accounts_check and fail that lookup.
ALTER TABLE location_daily
  ADD COLUMN IF NOT EXISTS house_accounts integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'location_daily_house_accounts_nonneg'
       AND conrelid = 'location_daily'::regclass
  ) THEN
    ALTER TABLE location_daily
      ADD CONSTRAINT location_daily_house_accounts_nonneg
      CHECK (house_accounts IS NULL OR house_accounts >= 0);
  END IF;
END
$$;

COMMENT ON COLUMN location_daily.house_accounts IS
  'Cars washed on a house account. Counts as a wash sale, cannot be scanned; '
  'deducted from the scan-rate denominator only. Capture % and DOB keep the '
  'gross wash_sales denominator by company policy.';

-- ---------------------------------------------------------------------------
-- 2. greeter_scan_rates() — the one function whose arithmetic changes
-- ---------------------------------------------------------------------------
-- DROPPED rather than CREATE OR REPLACEd: the RETURNS TABLE gains
-- scannable_wash_sales, and Postgres will not let a replacement change the
-- output signature. Dropping is safe — nothing holds a dependency on it; the
-- worker calls it through PostgREST by name.
--
-- scannable_wash_sales is returned rather than left implicit so that a site
-- looking at a rate it doesn't believe can see the denominator that produced
-- it without opening the database.
DROP FUNCTION IF EXISTS greeter_scan_rates(date, date, integer, integer, text[]);

CREATE FUNCTION greeter_scan_rates(
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
    FROM location_daily l
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
    FROM greeter_daily g
    JOIN site s
      ON s.business_date = g.business_date
     AND s.location_id   = g.location_id
    GROUP BY g.business_date, g.location_id
  ),
  ever AS (
    -- Lets the UI tell "onboarded and slipping" (0%, flag it) apart from
    -- "never started" (blank, don't nag).
    SELECT DISTINCT g.location_id FROM greeter_daily g
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

-- ---------------------------------------------------------------------------
-- 3. location_period_rows() — passes the column through; does NOT divide
-- ---------------------------------------------------------------------------
-- This function returns day rows and lets the report page sum them, so the
-- period scan rate is computed in TypeScript from summed numerators and summed
-- denominators (never by averaging daily percentages — see section 5 of
-- greeter-scorecard-tables.sql). That means the only thing needed here is to
-- hand house_accounts out alongside rewashes so the aggregator can subtract
-- both. The division stays in aggregate.ts.
--
-- Dropped for the same signature reason as above.
DROP FUNCTION IF EXISTS location_period_rows(date, date, integer, integer, text[]);

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
    FROM location_daily l
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

-- ---------------------------------------------------------------------------
-- 4. Verification — fails loudly rather than leaving a half-applied migration
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text := '';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'location_daily' AND column_name = 'house_accounts'
  ) THEN
    v_missing := v_missing || ' location_daily.house_accounts';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'location_daily_house_accounts_nonneg'
  ) THEN
    v_missing := v_missing || ' location_daily_house_accounts_nonneg';
  END IF;

  -- Proves the FUNCTIONS were replaced, not just that they exist: both new
  -- signatures return a column the old ones did not.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN unnest(p.proargnames) AS n(name) ON true
     WHERE p.proname = 'greeter_scan_rates'
       AND n.name = 'scannable_wash_sales'
  ) THEN
    v_missing := v_missing || ' greeter_scan_rates.scannable_wash_sales';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN unnest(p.proargnames) AS n(name) ON true
     WHERE p.proname = 'location_period_rows'
       AND n.name = 'house_accounts'
  ) THEN
    v_missing := v_missing || ' location_period_rows.house_accounts';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'greeter-house-accounts-10 incomplete, missing:%', v_missing;
  END IF;

  RAISE NOTICE 'greeter-house-accounts-10 applied.';
END
$$;
