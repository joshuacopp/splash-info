-- =====================================================================
-- 01_splashdb_lube_cars.sql
-- =====================================================================
-- FEEDS      : source = 'splashdb'  in daily_car_counts_<DAY>.csv
-- CONNECTION : DBeaver connection `splashdb`  (Amazon Redshift)
-- OUTPUT     : CSV header is  source,location_name,day,total_cars
--              This query emits exactly those four columns, in that order.
-- PLACEHOLDER: '{DAY}'  -- a single-quoted YYYY-MM-DD literal, e.g. '2026-09-05'.
--              Replace every occurrence before running. Same placeholder
--              convention in all four files in this folder.
-- READ-ONLY  : SELECT only. Standing rule from Josh: never write to any
--              DBeaver connection, ever.
--
-- ---------------------------------------------------------------------
-- TRAP: MAX, NEVER SUM.
-- ---------------------------------------------------------------------
-- `sales` returns TWO rows per location-day. For ~66 locations the pair is
-- a value plus a NULL (harmless either way), but for NINE locations the two
-- rows carry genuinely different values, and SUM double-counts them.
--
-- Verified 2026-09-06 against the known-good 2026-09-04 loaded values:
--     Bedford Handwash & Lube-019 : max=257  sum=267   (loaded 257)
--     Bridgeport-022              : max=251  sum=297   (loaded 251)
-- MAX is correct. The 2026-09-04 pull was NOT consistently MAX, which is
-- why 09-04 sits ~31 cars high (0.09%) in D1 -- deliberately left alone.
--
-- The originally-recovered form of this query used SUM(s.lube_cars):
--
--     SELECT l.s_name AS location_name, s.date AS day, SUM(s.lube_cars) AS total_cars
--     FROM sales s JOIN locations l ON l.id = s.location_id
--     WHERE s.date = '2026-09-04'
--     GROUP BY l.s_name, s.date ORDER BY l.s_name;
--
-- That is the bug. It has been corrected to MAX below. Do not revert it.
--
-- ---------------------------------------------------------------------
-- OTHER NOTES
-- ---------------------------------------------------------------------
-- * Expect 84 location rows, of which ~75 are non-null. Blank total_cars is
--   NORMAL -- a location present in `locations` with no sales that day.
--   build_car_counts.py handles blanks; do not drop those rows.
-- * The join key is `locations.s_name`, and build_car_counts.py maps a row
--   to a site by the TRAILING 3-DIGIT NUMBER in location_name. Name
--   spellings differing between tables therefore do not matter.
-- * Sites 196 (Rensselaer) and 197 (Guilderland) exist in `locations`
--   (as 'Guilderland' and 'Wash Boss - Rensselaer') but have NO `sales`
--   rows, so they never appear here. They come from 04_drb_pos.sql.
--   Sites 083 Plattsburgh and 092 Falmouth appear here with a NULL count
--   and are gap-filled by 02_spot_ai.sql.
--   Missing that distinction once cost a silent 1,499-car shortfall.
-- * The WashCo sites (057 Middletown, 077 White Plains/Tarrytown) are
--   absent from this export entirely -- see 03_ics.sql.
-- =====================================================================

SELECT
    'splashdb'        AS source,
    l.s_name          AS location_name,
    s.date            AS day,
    MAX(s.lube_cars)  AS total_cars   -- MAX, never SUM. See header.
FROM sales s
JOIN locations l ON l.id = s.location_id
WHERE s.date = '{DAY}'
GROUP BY l.s_name, s.date
ORDER BY l.s_name;


-- ---------------------------------------------------------------------
-- Optional sanity check -- run separately, do not export.
-- Recovered verbatim from the 2026-09-04 session (SUM form); corrected to
-- MAX for consistency with the query above.
-- Expect roughly: locations_total 84, locations_reporting 75.
-- ---------------------------------------------------------------------
-- SELECT COUNT(*)          AS locations_total,
--        COUNT(s.lube_cars) AS locations_reporting,
--        SUM(s.lube_cars)   AS total_cars
-- FROM (SELECT l.s_name, MAX(s.lube_cars) AS lube_cars
--       FROM sales s JOIN locations l ON l.id = s.location_id
--       WHERE s.date = '{DAY}'
--       GROUP BY l.s_name) s;
