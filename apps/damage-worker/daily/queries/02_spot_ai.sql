-- =====================================================================
-- 02_spot_ai.sql
-- =====================================================================
-- FEEDS      : source = 'spot_ai'  in daily_car_counts_<DAY>.csv
-- CONNECTION : DBeaver connection `splashdb`  (Amazon Redshift),
--              table  public.spot_ai_car_counts
-- OUTPUT     : CSV header is  source,location_name,day,total_cars
--              This query emits exactly those four columns, in that order.
-- PLACEHOLDER: '{DAY}'  -- a single-quoted YYYY-MM-DD literal, e.g. '2026-09-05'.
-- READ-ONLY  : SELECT only. Standing rule from Josh: never write to any
--              DBeaver connection, ever.
--
-- PURPOSE    : Camera gap-fill for the two sites that have no usable count
--              anywhere else: 083 Plattsburgh and 092 Falmouth. Both appear
--              in `locations` with a NULL `sales.lube_cars`, so 01 produces
--              a blank row for them.
--              Guilderland-197 and Rensselaer-196 ALSO have camera rows, but
--              DRB POS (04_drb_pos.sql) outranks the camera for those two and
--              build_car_counts.py enforces that precedence. Do NOT export
--              spot_ai rows for 196/197 -- Rensselaer's camera runs ~12%
--              below POS consistently (592 vs 673, 527 vs 598).
--
-- ---------------------------------------------------------------------
-- TRAP: ONE DASHBOARD ROW PER SITE-DAY. NEVER SUM.
-- ---------------------------------------------------------------------
-- `spot_ai_car_counts` holds MULTIPLE rows per site per day -- one per Spot AI
-- dashboard -- and at many sites those dashboards watch the SAME lane rather
-- than separate lanes. 22 of 77 sites are affected (14 with 2 rows, 6 with 3,
-- 2 with 4). Summing inflates them 2-4x.
--
--   Hamburg-149 on 2026-09-04 : three rows all reading 174. SUM gives 522.
--   White Plains Central-076  : two rows, 425 and 447.      SUM gives 872.
--
-- Take ONE row (MAX / DISTINCT), never SUM. De-duplicated, the camera tracks
-- paid washes within a few percent -- the old belief that "cameras run ~2x
-- sales" was purely an artifact of summing duplicate rows.
--
-- 083 and 092 happened to be single-dashboard on 09-04 and 09-05, so MAX and
-- SUM agreed. Do not rely on that; use MAX unconditionally.
--
-- ---------------------------------------------------------------------
-- NAME MAPPING
-- ---------------------------------------------------------------------
-- Plattsburgh is 'ECO Plattsburgh-083' in this table but 'Splash
-- Plattsburgh-083' in `locations`. build_car_counts.py keys on the TRAILING
-- 3-DIGIT SITE NUMBER, so either spelling loads correctly. The 2026-09-05
-- CSV used the `locations` spelling for tidiness:
--     spot_ai,Splash Falmouth-092,2026-09-05,301
--     spot_ai,Splash Plattsburgh-083,2026-09-05,371
--
-- ---------------------------------------------------------------------
-- PROVENANCE
-- ---------------------------------------------------------------------
-- The exploratory queries against this table were recovered verbatim from
-- the transcript (see the appendix at the bottom), but they PRE-DATE the
-- duplicate-dashboard discovery and all used SUM. The de-duplicated
-- gap-fill query below is a RECONSTRUCTION built from those recovered
-- fragments plus the documented MAX-not-SUM rule. It was not found verbatim
-- in the transcript -- the 2026-09-05 pull that used MAX ran in a separate
-- child session whose transcript is not reachable from here. Columns and
-- filter style are recovered; the aggregate is corrected. Spot-check the
-- output against the previous day before trusting it.
-- =====================================================================

SELECT
    'spot_ai'      AS source,
    location       AS location_name,
    date           AS day,
    MAX(num_cars)  AS total_cars   -- MAX, never SUM. See header.
FROM spot_ai_car_counts
WHERE date = '{DAY}'
  AND (   location ILIKE '%plattsburgh%'
       OR location ILIKE '%falmouth%' )
GROUP BY location, date
ORDER BY location;


-- ---------------------------------------------------------------------
-- Optional: full de-duplicated inventory for every site on the day.
-- Useful for cross-checking splashdb, or if a new site needs gap-filling.
-- Do NOT export this wholesale into the CSV -- it would collide with the
-- splashdb rows for the ~75 sites that already report through `sales`.
-- ---------------------------------------------------------------------
-- SELECT
--     'spot_ai'      AS source,
--     location       AS location_name,
--     date           AS day,
--     MAX(num_cars)  AS total_cars,
--     COUNT(*)       AS dashboard_rows   -- >1 means duplicate dashboards
-- FROM spot_ai_car_counts
-- WHERE date = '{DAY}'
-- GROUP BY location, date
-- ORDER BY dashboard_rows DESC, location;


-- ---------------------------------------------------------------------
-- APPENDIX -- recovered verbatim from the transcript, 2026-09-06.
-- Kept for provenance ONLY. Both use SUM and are therefore WRONG for any
-- site with more than one dashboard row. Do not run them to produce counts.
-- ---------------------------------------------------------------------
-- -- raw per-dashboard rows for the gap-fill candidates
-- SELECT location, location_id, date, num_cars
-- FROM spot_ai_car_counts
-- WHERE (location ILIKE '%plattsburgh%' OR location ILIKE '%rensselaer%'
--     OR location ILIKE '%guilderland%' OR location ILIKE '%wash boss%'
--     OR location ILIKE '%eco%' OR location ILIKE '%montgomery%'
--     OR location ILIKE '%williston%')
--   AND date >= '2026-08-30'
-- ORDER BY location, date;
--
-- -- camera vs sales comparison (the query whose SUM produced the false
-- -- "cameras run 2x sales" conclusion)
-- SELECT sa.location, SUM(sa.num_cars) AS spot_ai_cars, MAX(s.sales_cars) AS sales_cars
-- FROM (SELECT location, RIGHT(location,3) AS site, num_cars
--       FROM spot_ai_car_counts WHERE date = '2026-09-04') sa
-- LEFT JOIN (SELECT RIGHT(l.s_name,3) AS site, SUM(s.lube_cars) AS sales_cars
--            FROM sales s JOIN locations l ON l.id = s.location_id
--            WHERE s.date = '2026-09-04' GROUP BY RIGHT(l.s_name,3)) s
--   ON s.site = sa.site
-- GROUP BY sa.location ORDER BY sales_cars NULLS FIRST, sa.location;
--
-- Table columns: location_id, location, date, num_cars, api_source,
--                load_timestamp, dashboards
