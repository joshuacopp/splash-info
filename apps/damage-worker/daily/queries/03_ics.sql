-- =====================================================================
-- 03_ics.sql
-- =====================================================================
-- FEEDS      : source = 'ICS'  in daily_car_counts_<DAY>.csv
-- CONNECTION : DBeaver connection `splashdb`  (Amazon Redshift),
--              table  public.ics_financial_performance_by_location
-- OUTPUT     : CSV header is  source,location_name,day,total_cars
--              This query emits exactly those four columns, in that order.
-- PLACEHOLDER: '{DAY}'  -- a single-quoted YYYY-MM-DD literal, e.g. '2026-09-05'.
-- READ-ONLY  : SELECT only. Standing rule from Josh: never write to any
--              DBeaver connection, ever.
--
-- PURPOSE    : The WashCo sites, which are absent from the Splash export
--              entirely:
--                057  WashCo Middletown     -> location_code 'middletown'
--                077  WashCo White Plains   -> location_code 'tarrytown'
--
-- ---------------------------------------------------------------------
-- TRAP 1: THIS RUNS ON splashdb, NOT ON THE `master` CONNECTION.
-- ---------------------------------------------------------------------
-- Josh calls ICS "the master database", and there IS a DBeaver connection
-- named `master` (SQL Server, ics-reporting...rds.amazonaws.com:1433). The
-- table is NOT there. Running this against `master` gives:
--     SQL Error [208] [S0002]: Invalid object name
--     'ics_financial_performance_by_location'
-- The ETL'd copy lives in splashdb / Redshift / schema `public`. Use the
-- native Redshift `::date` cast, not SQL Server's CAST(... AS date).
--
-- ---------------------------------------------------------------------
-- TRAP 2: DE-DUPLICATE BY load_timestamp FIRST.
-- ---------------------------------------------------------------------
-- The table carries multiple loads per site-day. The inner query keeps only
-- the LATEST load per (site_id, day) via
--     ROW_NUMBER() OVER (PARTITION BY site_id, start_date::date
--                        ORDER BY load_timestamp DESC) = 1
-- After rn = 1 there is exactly one row per site_id per day, so the outer
-- SUM is a no-op collapsing site_ids that share a site_name. Leave it.
--
-- ---------------------------------------------------------------------
-- TRAP 3: 077 IS A REAL, DISTINCT SITE.
-- ---------------------------------------------------------------------
-- 'WashCo White Plains' (site 077, location_code 'tarrytown') is NOT a
-- duplicate of 075 Kensico or 076 Central Ave. Josh confirmed this
-- 2026-09-05. The 2026 monthly seed wrongly dropped it as a duplicate, so
-- its history is under-counted by roughly 1,244 cars/day and a backfill is
-- still pending. build_car_counts.py has INCLUDE_TARRYTOWN = True. Export it.
--
-- ---------------------------------------------------------------------
-- OTHER NOTES
-- ---------------------------------------------------------------------
-- * A third row, 'Corporate', comes back every day (usually 0). Export it
--   as-is; build_car_counts.py skips it as an ICS non-store.
-- * Expected shape, from 2026-09-05:
--       ICS,Corporate,2026-09-05,0
--       ICS,WashCo Middletown,2026-09-05,1219
--       ICS,WashCo White Plains,2026-09-05,1170
-- * build_car_counts.py maps ICS rows by EXACT site_name via its ICS_SITE
--   dict ("WashCo Middletown" -> "057", "WashCo White Plains" -> "077"),
--   not by trailing site number. Do not rename these in the CSV.
--
-- PROVENANCE : Recovered verbatim from the transcript (2026-09-04 working
--              query). Only the hard-coded dates were replaced with the
--              '{DAY}' placeholder and the constant `source` column added.
-- =====================================================================

SELECT
    'ICS'                 AS source,
    i.site_name           AS location_name,
    i.start_date::date    AS day,
    SUM(i.num_cars)       AS total_cars
FROM (
    SELECT site_name,
           start_date,
           num_cars,
           ROW_NUMBER() OVER (PARTITION BY site_id, start_date::date
                              ORDER BY load_timestamp DESC) AS rn
    FROM ics_financial_performance_by_location
    WHERE start_date >= '{DAY}'
      AND start_date <  ('{DAY}'::date + 1)
) i
WHERE i.rn = 1
GROUP BY i.site_name, i.start_date::date
ORDER BY i.site_name;


-- ---------------------------------------------------------------------
-- APPENDIX -- the recovered form, verbatim, for 2026-09-04.
-- Identical apart from the literal dates and the added `source` column.
-- ---------------------------------------------------------------------
-- SELECT i.site_name AS location_name, i.start_date::date AS day, SUM(i.num_cars) AS total_cars
-- FROM (SELECT site_name, start_date, num_cars,
--              ROW_NUMBER() OVER (PARTITION BY site_id, start_date::date ORDER BY load_timestamp DESC) AS rn
--       FROM ics_financial_performance_by_location
--       WHERE start_date >= '2026-09-04' AND start_date < '2026-09-05') i
-- WHERE i.rn = 1
-- GROUP BY i.site_name, i.start_date::date ORDER BY i.site_name;
--
-- Sibling ICS tables in splashdb public schema, for reference:
--   ics_club_membership_events, ics_employee_time_records, ics_shift_detail,
--   ics_shift_detail_payments, ics_transaction_detail
