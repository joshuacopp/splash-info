-- greeter-scan-gaps-16.sql — which greeters a site's missed scans follow.
--
-- STATUS: APPLIED 2026-10-08 (Splash-info). Safe to re-run: CREATE OR REPLACE.
-- Additive only: one new read function, no table or view changes.
--
-- ===========================================================================
-- WHAT THIS CAN AND CANNOT SAY
-- ===========================================================================
--
-- Scanning is only ever measured per SITE-DAY: location_daily.wash_sales is the
-- cars the site sold, greeter_daily.wash_sales is the cars each greeter scanned
-- their card for, and nothing ties an individual car to an individual greeter.
-- So no query can prove who skipped a scan. What it CAN do is notice that a
-- site's missed scans keep landing on the days a particular person works, and
-- that is a lead for a manager to follow up, not a finding. The page labels it
-- that way and so should anything else that reads this.
--
-- Three signals per (site, greeter), each built from raw sums so a 300-car day
-- outweighs a 3-car one -- never by averaging per-day percentages:
--
--   1. WITH vs WITHOUT. The site's scan rate on days this greeter worked, next
--      to the same site's rate on the qualifying days they did not. Same site
--      on both sides, so a site that is simply busy or badly run does not make
--      everyone on it look guilty. The strongest signal and the one to sort by.
--
--   2. SHARE OF THE CREW'S SCANS against the share they would be expected to
--      carry. Expected share is their hours / the crew's hours when EVERY
--      greeter that day entered a shift window, otherwise 1 / crew size. Shift
--      times are optional and mostly blank, so most days fall back to the even
--      split; hours_days says how many did not. share_index = actual / expected,
--      so 1.0 is pulling their weight and 0.3 is scanning a third of it.
--
--   3. MISSED CARS on their days, split across that day's crew the same way
--      (hours where known, evenly otherwise). An estimate of the exposure, not
--      a count of anything this person did.
--
-- QUALIFYING DAYS are site-days with scannable cars AND at least one greeter
-- row. A day nobody logged is a reporting failure (greeter_missing_days owns
-- those) and folding it in as 0% would drag the "without" rate of everyone at
-- the site down for something none of them did.
--
-- Small samples come back like any other row. The page decides what is enough
-- to rank on (it shows the counts and refuses to rank under a floor); filtering
-- here would hide exactly the people nobody has enough data on yet.
--
-- Scannable = wash_sales - house_accounts - rewashes, floored at 0: the same
-- denominator greeter_scan_rates() uses, so the two can never disagree about
-- what a site's day was.

CREATE OR REPLACE FUNCTION greeter_scan_gaps(
  p_date_from      date,
  p_date_to        date,
  p_location_id    integer DEFAULT NULL,
  p_location_codes text[]  DEFAULT NULL
)
RETURNS TABLE (
  location_id          integer,
  site_number          integer,
  location_code        text,
  beekeeper_user_id    text,
  greeter_name         text,
  site_days            integer,
  days_with            integer,
  scannable_with       bigint,
  scanned_with         bigint,
  pct_with             numeric,
  days_without         integer,
  scannable_without    bigint,
  scanned_without      bigint,
  pct_without          numeric,
  gap_points           numeric,
  own_scans            bigint,
  share_pct            numeric,
  expected_share_pct   numeric,
  share_index          numeric,
  missed_share         numeric,
  avg_crew_size        numeric,
  hours_days           integer
)
LANGUAGE sql
STABLE
AS $$
  WITH crew_row AS (
    SELECT
      g.business_date,
      g.location_id,
      g.beekeeper_user_id,
      g.greeter_name,
      COALESCE(g.wash_sales, 0) AS own,
      g.hours_worked
    FROM greeter_daily_live g
    WHERE g.business_date BETWEEN p_date_from AND p_date_to
      AND (p_location_id    IS NULL OR g.location_id   =  p_location_id)
      AND (p_location_codes IS NULL OR g.location_code = ANY(p_location_codes))
  ),
  crew_day AS (
    SELECT
      business_date,
      location_id,
      SUM(own)::bigint AS scanned,
      COUNT(*)         AS crew_size,
      -- Hours only count when the WHOLE crew has them. One person with a shift
      -- window and two without would otherwise hand that one person the entire
      -- expected share.
      CASE WHEN COUNT(*) = COUNT(hours_worked) AND SUM(hours_worked) > 0
           THEN SUM(hours_worked) END AS crew_hours
    FROM crew_row
    GROUP BY business_date, location_id
  ),
  site_day AS (
    SELECT
      l.business_date,
      l.location_id,
      l.site_number,
      l.location_code,
      GREATEST(
        COALESCE(l.wash_sales, 0)
        - COALESCE(l.house_accounts, 0)
        - COALESCE(l.rewashes, 0),
        0
      ) AS scannable,
      c.scanned,
      c.crew_size,
      c.crew_hours
    FROM location_daily_live l
    JOIN crew_day c
      ON c.business_date = l.business_date
     AND c.location_id   = l.location_id
    WHERE l.business_date BETWEEN p_date_from AND p_date_to
      AND (p_location_id    IS NULL OR l.location_id   =  p_location_id)
      AND (p_location_codes IS NULL OR l.location_code = ANY(p_location_codes))
  ),
  qualifying AS (
    SELECT * FROM site_day WHERE scannable > 0
  ),
  site_tot AS (
    SELECT
      location_id,
      COUNT(*)::integer        AS site_days,
      SUM(scannable)::bigint   AS scannable,
      SUM(scanned)::bigint     AS scanned
    FROM qualifying
    GROUP BY location_id
  ),
  worked AS (
    SELECT
      q.location_id,
      q.site_number,
      q.location_code,
      r.beekeeper_user_id,
      r.greeter_name,
      r.business_date,
      q.scannable,
      q.scanned,
      q.crew_size,
      r.own,
      -- The share of the day this greeter was expected to carry.
      CASE WHEN q.crew_hours IS NOT NULL
           THEN r.hours_worked / q.crew_hours
           ELSE 1.0 / q.crew_size END AS weight,
      (q.crew_hours IS NOT NULL) AS by_hours
    FROM qualifying q
    JOIN crew_row r
      ON r.business_date = q.business_date
     AND r.location_id   = q.location_id
  ),
  per_greeter AS (
    SELECT
      w.location_id,
      MAX(w.site_number)                       AS site_number,
      MAX(w.location_code)                     AS location_code,
      w.beekeeper_user_id,
      -- Most recent spelling, for display; the id is the key.
      (ARRAY_AGG(w.greeter_name ORDER BY w.business_date DESC))[1] AS greeter_name,
      COUNT(*)::integer                        AS days_with,
      SUM(w.scannable)::bigint                 AS scannable_with,
      SUM(w.scanned)::bigint                   AS scanned_with,
      SUM(w.own)::bigint                       AS own_scans,
      -- Expected scans in CARS (weight x the crew's scans that day), so the
      -- index is weighted by volume like everything else here.
      SUM(w.weight * w.scanned)                AS expected_scans,
      SUM(w.weight * GREATEST(w.scannable - w.scanned, 0)) AS missed_share,
      AVG(w.crew_size)                         AS avg_crew_size,
      COUNT(*) FILTER (WHERE w.by_hours)::integer AS hours_days
    FROM worked w
    GROUP BY w.location_id, w.beekeeper_user_id
  )
  SELECT
    p.location_id,
    p.site_number,
    p.location_code,
    p.beekeeper_user_id,
    p.greeter_name,
    s.site_days,
    p.days_with,
    p.scannable_with,
    p.scanned_with,
    ROUND(p.scanned_with::numeric * 100 / NULLIF(p.scannable_with, 0), 1),
    (s.site_days - p.days_with)::integer,
    (s.scannable - p.scannable_with)::bigint,
    (s.scanned   - p.scanned_with)::bigint,
    ROUND((s.scanned - p.scanned_with)::numeric * 100
          / NULLIF(s.scannable - p.scannable_with, 0), 1),
    -- Negative = the site scans worse when this person is on. NULL when there
    -- is no "without" side to compare against (they worked every day).
    ROUND(p.scanned_with::numeric * 100 / NULLIF(p.scannable_with, 0), 1)
      - ROUND((s.scanned - p.scanned_with)::numeric * 100
              / NULLIF(s.scannable - p.scannable_with, 0), 1),
    p.own_scans,
    ROUND(p.own_scans::numeric * 100 / NULLIF(p.scanned_with, 0), 1),
    ROUND(p.expected_scans * 100 / NULLIF(p.scanned_with, 0), 1),
    ROUND(p.own_scans::numeric / NULLIF(p.expected_scans, 0), 2),
    ROUND(p.missed_share, 1),
    ROUND(p.avg_crew_size, 1),
    p.hours_days
  FROM per_greeter p
  JOIN site_tot s ON s.location_id = p.location_id
  ORDER BY p.location_code, p.greeter_name;
$$;

-- Service role only, like every other greeter_* reader: the worker scopes the
-- locations, and this must not be reachable as an RLS-dependent PostgREST read.
REVOKE ALL ON FUNCTION greeter_scan_gaps(date, date, integer, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION greeter_scan_gaps(date, date, integer, text[]) TO service_role;
