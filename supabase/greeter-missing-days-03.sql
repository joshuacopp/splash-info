-- Greeter scorecard, migration 03: missing-submission insight.
--
-- Run in the Supabase SQL editor. Safe to re-run (CREATE OR REPLACE only).
-- Independent of 01 and 02 — reads only keying columns none of them change.
--
--
-- WHY THIS IS SEPARATE FROM greeter_scan_rates()
--
-- A day where nobody submitted anything is NOT a low scan rate. Scan rate asks
-- "of the cars this site sold, how many did a greeter claim?" — a question that
-- needs a submission to answer at all. Folding no-shows into that number would
-- both understate the sites that are genuinely scanning badly and bury the
-- simpler, more actionable fact that a site just didn't report.
--
-- Concretely: greeter_scan_rates() is driven from location_daily, so a day the
-- site skipped entirely produces NO ROW there — it is invisible, not 0%. This
-- function is what makes those days visible.
--
--
-- WHAT COUNTS AS "MISSING"
--
-- A full day for a location is TWO submissions: the site's own numbers
-- (location_daily) and at least one greeter's day (greeter_daily). Either one
-- absent is a gap, and they're reported separately because they have different
-- owners — the site row is usually the manager, the greeter rows the crew.
--
--
-- WHICH LOCATIONS ARE EXPECTED TO REPORT
--
-- Deliberately NOT "every row in `locations`". That table includes sites that
-- were never onboarded to the scorecard, and listing them would make the panel
-- permanently full of noise nobody can act on.
--
-- Instead the universe is "locations that have EVER submitted either kind of
-- row" — i.e. sites that demonstrably know how to use this. A site that has
-- never submitted anything is silent here on purpose; onboarding it is a
-- different conversation from nagging it about last Tuesday.
--
-- And a location is only reported from its FIRST submission onward, so a site
-- onboarded midweek isn't accused of missing the days before it existed here.
--
-- KNOWN LIMIT: a location that is closed, seasonal, or has stopped using the
-- scorecard on purpose will still show every day as missing. There is no
-- "expected to report" flag in the schema to filter on yet. If that becomes
-- noisy, the fix is a column on `locations`, not a heuristic here.
--
--
-- WINDOW IS REQUIRED
--
-- p_date_from and p_date_to have no defaults. The grid is
-- (onboarded locations x every date in the window), so an unbounded call would
-- try to materialise every day since the epoch. A caller must say when.

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
    -- Both tables, so a location that only ever logged greeter days (or only
    -- ever logged site days) still counts as onboarded.
    --
    -- SCOPED HERE, BEFORE THE COLLAPSE, NOT AFTER. location_code has been
    -- observed to diverge between tables for the same site (196 is
    -- "rensselear" in one and "rensselaer" in another). Collapsing first and
    -- then filtering on whichever spelling won would intermittently drop a
    -- location admin's own site out of their panel. Filtering first means any
    -- row carrying a code they hold brings the location in.
    SELECT l.location_id, l.site_number, l.location_code, l.business_date
      FROM location_daily l
     WHERE (p_location_id    IS NULL OR l.location_id   =  p_location_id)
       AND (p_site_number    IS NULL OR l.site_number   =  p_site_number)
       AND (p_location_codes IS NULL OR l.location_code = ANY(p_location_codes))
    UNION ALL
    SELECT g.location_id, g.site_number, g.location_code, g.business_date
      FROM greeter_daily g
     WHERE (p_location_id    IS NULL OR g.location_id   =  p_location_id)
       AND (p_site_number    IS NULL OR g.site_number   =  p_site_number)
       AND (p_location_codes IS NULL OR g.location_code = ANY(p_location_codes))
  ),
  scoped AS (
    -- One identity row per location, plus the day it first appeared.
    --
    -- Identity is the MOST RECENT submission's site_number/location_code —
    -- that's the spelling the rest of the UI will be showing. location_code
    -- breaks the ORDER BY tie so the pick is deterministic rather than
    -- whichever row the planner happened to emit first; without it the panel
    -- could show a different spelling on every page load.
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
      FROM greeter_daily g
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
  LEFT JOIN location_daily l
    ON l.location_id   = s.location_id
   AND l.business_date = d.business_date
  LEFT JOIN greeter_counts gc
    ON gc.location_id   = s.location_id
   AND gc.business_date = d.business_date
  -- Only the gaps. A day with both halves present is not this function's
  -- business — greeter_scan_rates() grades those.
  WHERE (l.id IS NULL OR COALESCE(gc.greeters, 0) = 0)
    -- Never report a day BEFORE the location's first submission. A site
    -- onboarded on Wednesday didn't "miss" Monday and Tuesday, and saying it
    -- did would put every newly-onboarded site at the top of the list on the
    -- day it starts — the worst possible first impression of the panel.
    AND d.business_date >= s.first_seen
  ORDER BY d.business_date DESC, s.location_code;
$$;

-- Same posture as the other two: service-role only, caller scoping in app code.
REVOKE ALL ON FUNCTION greeter_missing_days(date, date, integer, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_missing_days(date, date, integer, integer, text[]) TO service_role;

-- greeter_counts groups greeter_daily by (business_date, location_id); the
-- index migration 02 adds covers it. Repeated here with IF NOT EXISTS so this
-- file stands alone if 02 hasn't been applied.
CREATE INDEX IF NOT EXISTS greeter_daily_date_location_idx
  ON greeter_daily (business_date, location_id);

-- The LEFT JOIN probes location_daily by (location_id, business_date), which is
-- the leading pair of location_daily_unique_day, so no extra index is needed.
