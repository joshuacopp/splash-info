-- Greeter scorecard, migration 02: scan-rate insight.
--
-- SUPERSEDED — HISTORICAL. DO NOT RUN, DO NOT EDIT.
--
-- greeter-house-accounts-10.sql replaced greeter_scan_rates() with a version
-- whose denominator is wash_sales minus house_accounts minus rewashes, and
-- whose RETURNS TABLE has four more columns. Running this file would silently
-- roll the scan rate back to the gross denominator. The live definition lives
-- in greeter-scorecard-tables.sql and 10; this file is kept only so the
-- migration history reads in order.
--
-- INDEPENDENT OF greeter-scorecard-alter-01.sql. This function reads only
-- business_date, location_id, site_number, location_code and wash_sales, none
-- of which 01 touches, so the two can be applied in either order.
--
--
-- WHAT THIS MEASURES
--
-- The two wash_sales columns count the same cars from two directions:
--
--   location_daily.wash_sales  Every a-la-carte (non-unlimited) car the site
--                              sold that day. The tunnel's own count. This is
--                              the truth.
--   greeter_daily.wash_sales   The subset a greeter scanned their card for.
--                              Attribution, not volume.
--
-- So SUM(greeter) / site is the share of the day's ALC business that actually
-- got attributed to somebody. It is a DATA-QUALITY metric, not a sales metric:
-- a site at 60% didn't sell less, it failed to scan 40% of what it sold, and
-- every per-greeter number derived from that day is understated by the gap.
--
-- Deliberately NOT a generated column on location_daily: the numerator lives in
-- a different table and changes every time a greeter submits or corrects a day.
-- A stored value would be stale the moment a late greeter row landed.
--
--
-- WHY A FUNCTION AND NOT A VIEW
--
-- Same reason as greeter_rollup(): a view would have to aggregate before the
-- caller's date filter could bind, so every caller would silently get an
-- all-time answer. The filters are arguments here and apply to the base rows.
--
--
-- SCOPING
--
-- p_location_codes filters the SITE rows. Greeter rows are only ever reached by
-- joining an already-filtered site day, so a location admin cannot see another
-- site's numerator. The `ever` CTE scans greeter_daily unscoped but yields only
-- location_ids, which are then joined back to scoped sites — no leak.
--
-- NOTE the greeter-name filter that greeter_rollup() accepts is absent here on
-- purpose. The denominator is the whole site's day, so the numerator must be
-- every greeter at that site. Filtering the numerator by name would make a site
-- look underreported whenever someone typed a name in the filter bar.

CREATE OR REPLACE FUNCTION greeter_scan_rates(
  p_date_from      date    DEFAULT NULL,
  p_date_to        date    DEFAULT NULL,
  p_location_id    integer DEFAULT NULL,
  p_site_number    integer DEFAULT NULL,
  p_location_codes text[]  DEFAULT NULL
)
RETURNS TABLE (
  business_date      date,
  location_id        integer,
  site_number        integer,
  location_code      text,
  site_wash_sales    integer,
  scanned_wash_sales bigint,
  greeters_logged    bigint,
  scanned_pct        numeric,
  ever_submitted     boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH site AS (
    -- The denominator side. Driving from location_daily (not from a join of
    -- both tables) is what makes a site day with ZERO greeter rows still appear
    -- — that row is the whole point of the metric.
    SELECT
      l.business_date,
      l.location_id,
      l.site_number,
      l.location_code,
      l.wash_sales
    FROM location_daily l
    WHERE (p_date_from      IS NULL OR l.business_date >= p_date_from)
      AND (p_date_to        IS NULL OR l.business_date <= p_date_to)
      AND (p_location_id    IS NULL OR l.location_id   =  p_location_id)
      AND (p_site_number    IS NULL OR l.site_number   =  p_site_number)
      AND (p_location_codes IS NULL OR l.location_code = ANY(p_location_codes))
  ),
  scanned AS (
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
    -- Has this site EVER logged a greeter day? Lets the UI tell "onboarded and
    -- slipping" (0%, flag it) apart from "never started" (blank, don't nag).
    SELECT DISTINCT g.location_id FROM greeter_daily g
  )
  SELECT
    s.business_date,
    s.location_id,
    s.site_number,
    s.location_code,
    s.wash_sales,
    COALESCE(sc.scanned, 0)::bigint,
    COALESCE(sc.greeters, 0)::bigint,
    -- NULL, not 0, when the site sold no ALC cars: no denominator means no
    -- rate. A zero here would read as "scanned nothing" on a day where there
    -- was nothing to scan.
    CASE
      WHEN COALESCE(s.wash_sales, 0) > 0
      THEN ROUND(COALESCE(sc.scanned, 0)::numeric * 100 / s.wash_sales, 1)
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

-- Same posture as greeter_rollup(): reachable only by the service-role client
-- the workers use. All caller-facing scoping happens in application code.
REVOKE ALL ON FUNCTION greeter_scan_rates(date, date, integer, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_scan_rates(date, date, integer, integer, text[]) TO service_role;

-- Supporting index: `scanned` groups greeter_daily by (business_date,
-- location_id), which is the leading pair of greeter_daily_unique_day only if
-- that constraint is ordered that way. It isn't (it leads with location_id), so
-- add the composite explicitly.
CREATE INDEX IF NOT EXISTS greeter_daily_date_location_idx
  ON greeter_daily (business_date, location_id);
