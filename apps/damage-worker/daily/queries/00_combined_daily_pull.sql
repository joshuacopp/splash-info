-- =====================================================================
-- 00_combined_daily_pull.sql
-- =====================================================================
-- THE ONE QUERY TO RUN EACH MORNING.
--
-- Unions all four sources (splashdb sales, Spot AI cameras, ICS, DRB POS)
-- into a single result set shaped exactly like the CSV contract, so one
-- "Export resultset -> CSV" produces a file that drops straight into
-- build_car_counts.py with no hand-editing.
--
-- CONNECTION : DBeaver connection `splashdb`  (Amazon Redshift).
--              ALL FOUR sources live on this one connection. Do NOT run
--              any part of this against the `master` SQL Server
--              connection -- see TRAP 3.
-- OUTPUT     : source,location_name,day,total_cars   (exactly, in order)
-- PLACEHOLDER: '{DAY}'  -- a single-quoted YYYY-MM-DD literal.
--              Find-and-replace ALL occurrences (there are 7) with the
--              day you are pulling, e.g. '2026-09-05'.
-- READ-ONLY  : SELECT only. Standing rule from Josh: never write to any
--              DBeaver connection, ever.
--
-- The four single-source files (01..04) remain the authoritative
-- documentation for each branch -- they carry the full provenance,
-- appendices and recovered-verbatim originals. This file is the
-- operational convenience wrapper. If a branch here ever disagrees with
-- its numbered file, the numbered file wins and this one is the bug.
--
-- ---------------------------------------------------------------------
-- EXPECTED SHAPE OF A COMPLETE DAY: 89 ROWS
-- ---------------------------------------------------------------------
--   82  splashdb  (75 with a value, 7 legitimately blank)
--    2  spot_ai   (083 Plattsburgh, 092 Falmouth)
--    3  ICS       (Corporate, WashCo Middletown, WashCo White Plains)
--    2  DRB       (196 Rensselaer, 197 Guilderland)
--   --
--   89
--
-- If the row count is not 89, something upstream is missing. Investigate
-- BEFORE loading. A short day loads silently and looks like a real
-- decline in the cost-per-car metric.
--
-- The 7 blank splashdb rows are NORMAL and must NOT be dropped:
-- Online Portal, Splash Management-011, Bridgeport Lube-023,
-- Brighton-155, Nanuet-087, Port Jefferson-188, Splash24 Brockport-123.
-- They are non-stores or sites that do not report lube_cars.
-- build_car_counts.py skips them on its own.
--
-- ---------------------------------------------------------------------
-- HOW 083 / 092 RESOLVE  (why the splashdb branch is filtered)
-- ---------------------------------------------------------------------
-- 083 Plattsburgh and 092 Falmouth exist in `locations` but their
-- `sales.lube_cars` is NULL, so branch 1 on its own emits two blank rows
-- for them. The camera (branch 2) is the only usable count for those two
-- sites. A naive union would therefore emit each of them TWICE -- once
-- blank from splashdb, once valued from spot_ai.
--
-- Branch 1 below excludes them explicitly (`RIGHT(l.s_name,3) NOT IN
-- ('083','092')`) so spot_ai is the sole provider and each site appears
-- exactly once. That is why splashdb contributes 82 rows here and not
-- the 84 that 01_splashdb_lube_cars.sql produces standalone.
--
-- ---------------------------------------------------------------------
-- TRAP 1: MAX, NEVER SUM, ON sales.lube_cars
-- ---------------------------------------------------------------------
-- `sales` returns TWO rows per location-day. Most pairs are value+NULL
-- (harmless either way), but NINE sites carry genuinely different values
-- in the two rows -- e.g. Bedford Handwash & Lube-019 (max 257 / sum
-- 267), Bridgeport-022 (max 251 / sum 297). SUM overcounts those nine.
-- This is the bug that put roughly 31 extra cars into D1 for 2026-09-04.
-- Do not "fix" the MAX back to a SUM.
--
-- ---------------------------------------------------------------------
-- TRAP 2: MAX, NEVER SUM, ON spot_ai_car_counts EITHER
-- ---------------------------------------------------------------------
-- Different cause, same rule. `spot_ai_car_counts` holds one row per
-- Spot AI DASHBOARD per site-day, and at many sites several dashboards
-- watch the SAME lane. 22 of 77 sites are affected (14 with 2 rows,
-- 6 with 3, 2 with 4). Hamburg-149 on 09-04: three rows all reading 174,
-- SUM gives 522. White Plains Central-076: two rows, 425 and 447, SUM
-- gives 872. The old belief that "cameras run about 2x sales" was purely
-- an artifact of summing duplicate rows.
--
-- 083 and 092 happened to be single-dashboard on 09-04 and 09-05, so MAX
-- and SUM agreed there. Do not rely on that. MAX unconditionally.
--
-- ALSO: this branch is deliberately restricted to 083 and 092. Do NOT
-- widen it to 196/197 -- DRB POS outranks the camera for those two, and
-- Rensselaer's camera runs about 12% BELOW POS consistently (592 vs 673,
-- 527 vs 598). That is a systematic undercount, not noise.
--
-- ---------------------------------------------------------------------
-- TRAP 3: ICS RUNS HERE, ON splashdb -- NOT ON THE `master` CONNECTION
-- ---------------------------------------------------------------------
-- Josh calls ICS "the master database", and there IS a DBeaver connection
-- named `master` (SQL Server). The table is NOT there. Running against it
-- gives: SQL Error [208] [S0002]: Invalid object name
-- 'ics_financial_performance_by_location'. The ETL'd copy lives in
-- splashdb / Redshift / schema `public`.
--
-- TRAP 3b: the ICS table carries MULTIPLE LOADS per site-day. The inner
-- ROW_NUMBER() keeps only the latest load per (site_id, day). After
-- rn = 1 the outer SUM is a no-op collapsing site_ids that share a
-- site_name -- leave it in place.
--
-- TRAP 3c: 'WashCo White Plains' (077, location_code 'tarrytown') is a
-- REAL, DISTINCT site -- not a duplicate of 075 Kensico or 076 Central
-- Ave. Josh confirmed 2026-09-05. Export it. (The 2026 monthly seed
-- wrongly dropped it as a duplicate; its history is under-counted by
-- roughly 1,244 cars/day and a backfill is still pending.)
--
-- TRAP 3d: ICS rows are matched by build_car_counts.py on EXACT
-- site_name via its ICS_SITE dict, not by trailing site number. Do not
-- rename them. 'Corporate' comes back every day (usually 0) and is
-- skipped downstream as a non-store -- export it as-is.
--
-- ---------------------------------------------------------------------
-- TRAP 4: THE DRB CASE IS LOAD-BEARING
-- ---------------------------------------------------------------------
-- DRB sites are keyed by NAME in `site_id`; the site numbers 196/197
-- appear NOWHERE in that schema. build_car_counts.py matches on the
-- trailing 3-digit number in location_name, so a bare 'Guilderland'
-- would be skipped as "no site number in name". The CASE rewrites
-- site_id into the names the CSV expects. Do not drop it.
--
-- The DRB count rule: every row in v_sale is ONE CAR, minus three
-- exclusions -- the 5am settlement batch (actualsaleid IS NOT NULL,
-- ~26% of rows), refunds (null actualsaleid + status -32768), and a
-- trivial null group (null actualsaleid + status -32704). See
-- 04_drb_pos.sql for the full reasoning on each.
--
-- ---------------------------------------------------------------------
-- MANDATORY PRE-CHECK -- RUN THIS BEFORE TRUSTING THE DAY
-- ---------------------------------------------------------------------
-- The DRB completeness check CANNOT ride inside this union (different
-- grain). It is at the bottom of this file as a separate statement, and
-- also in 04_drb_pos.sql. Run it FIRST. If Guilderland's mx_logtime
-- lands well short of ~11,600, the DRB extract is PARTIAL, the count is
-- not comparable, and the day should not be loaded. Stop and say so.
--
-- ---------------------------------------------------------------------
-- OUTPUT TYPES
-- ---------------------------------------------------------------------
-- `day` is cast to ::date on every branch and `total_cars` to ::integer,
-- so the union is type-compatible and the CSV renders as clean whole
-- numbers (1219, not 1219.00) across all four sources. Cars are whole
-- units; lube_cars values are all .00 in practice. NULL survives the
-- cast and renders as an empty cell, which is what the 7 blank splashdb
-- rows need.
--
-- ---------------------------------------------------------------------
-- PROVENANCE / CONFIDENCE
-- ---------------------------------------------------------------------
-- Branches 1, 3, 4 are recovered verbatim from working pulls (only the
-- literal dates parameterized, the splashdb aggregate corrected from SUM
-- to MAX, and the source/location_name/day columns added to match the
-- CSV shape).
--
-- Branch 2 (spot_ai) is a RECONSTRUCTION, not recovered verbatim -- the
-- 2026-09-05 pull that used MAX ran in a child session whose transcript
-- is unreachable. Columns and filter style are recovered; the aggregate
-- is corrected. SPOT-CHECK 083 and 092 against the previous day before
-- trusting them. Reference: 2026-09-05 gave Falmouth-092 = 301 and
-- Plattsburgh-083 = 371.
--
-- Name note: Plattsburgh is 'ECO Plattsburgh-083' in spot_ai_car_counts
-- but 'Splash Plattsburgh-083' in `locations`. build_car_counts.py keys
-- on the trailing 3 digits so either loads, but branch 2 rewrites it to
-- the `locations` spelling for tidiness -- matching what the 09-05 CSV
-- used.
-- =====================================================================

WITH splashdb_sales AS (
    SELECT
        'splashdb'                AS source,
        l.s_name                  AS location_name,
        s.date::date              AS day,
        MAX(s.lube_cars)::integer AS total_cars   -- MAX, never SUM. TRAP 1.
    FROM sales s
    JOIN locations l ON l.id = s.location_id
    WHERE s.date = '{DAY}'
      -- 083 / 092 are NULL here and come from the camera instead.
      AND RIGHT(l.s_name, 3) NOT IN ('083', '092')
    GROUP BY l.s_name, s.date
),

spot_ai_fill AS (
    SELECT
        'spot_ai'                AS source,
        CASE
            WHEN location ILIKE '%plattsburgh%' THEN 'Splash Plattsburgh-083'
            WHEN location ILIKE '%falmouth%'    THEN 'Splash Falmouth-092'
            ELSE location
        END                      AS location_name,
        date::date               AS day,
        MAX(num_cars)::integer   AS total_cars   -- MAX, never SUM. TRAP 2.
    FROM spot_ai_car_counts
    WHERE date = '{DAY}'
      -- Gap-fill ONLY. Never widen to 196/197 -- DRB outranks the camera.
      AND (   location ILIKE '%plattsburgh%'
           OR location ILIKE '%falmouth%' )
    GROUP BY 2, date
),

ics_washco AS (
    SELECT
        'ICS'                     AS source,
        i.site_name               AS location_name,
        i.start_date::date        AS day,
        SUM(i.num_cars)::integer  AS total_cars   -- no-op after rn = 1. TRAP 3b.
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
),

drb_pos AS (
    SELECT
        'DRB' AS source,
        CASE s.site_id                                  -- load-bearing. TRAP 4.
            WHEN 'Guilderland' THEN 'Splash Guilderland-197'
            WHEN 'Rensselaer'  THEN 'Splash Rensselaer-196'
            ELSE s.site_id
        END                                    AS location_name,
        '{DAY}'::date                          AS day,
        (   count(*)
          - sum(case when s.actualsaleid is not null then 1 else 0 end)
          - sum(case when s.actualsaleid is null and s.status = -32768 then 1 else 0 end)
          - sum(case when s.actualsaleid is null and s.status = -32704 then 1 else 0 end)
        )::integer                             AS total_cars
    FROM razayya_agent_collector.v_sale s
    WHERE s.logdate >= '{DAY}'
      AND s.logdate <  ('{DAY}'::date + 1)
    GROUP BY s.site_id
)

SELECT source, location_name, day, total_cars FROM splashdb_sales
UNION ALL
SELECT source, location_name, day, total_cars FROM spot_ai_fill
UNION ALL
SELECT source, location_name, day, total_cars FROM ics_washco
UNION ALL
SELECT source, location_name, day, total_cars FROM drb_pos
ORDER BY 1, 2;


-- =====================================================================
-- MANDATORY PRE-CHECK -- run this BEFORE trusting the counts above.
-- Is the DRB day complete, or a truncated extract?
--
-- `logtime` is in 6-SECOND UNITS -- multiply by 6 for seconds past
-- midnight. 11,676 = 19:27, which is normal closing time.
-- Reference maxima: 09-03 11,697/11,670 - 09-04 11,676/12,124 -
-- 09-05 11,674/11,683.
--
-- If mx_logtime lands well short of ~11,600 at Guilderland, the day is
-- PARTIAL and the count is not comparable -- it will look like a sharp
-- decline that isn't real. Stop and say so; do not load the day.
--
-- Integrity should also hold: n = n_obj, and bad_objid = 0.
-- =====================================================================
-- SELECT trunc(logdate) AS d, site_id,
--        count(*) AS n,
--        count(distinct objid) AS n_obj,
--        sum(case when objid is null or objid = 0 then 1 else 0 end) AS bad_objid,
--        min(created) AS mn_created, max(created) AS mx_created,
--        min(logtime) AS mn_logtime, max(logtime) AS mx_logtime,
--        count(distinct terminal) AS n_terminals
-- FROM razayya_agent_collector.v_sale
-- WHERE logdate >= '{DAY}'
--   AND logdate <  ('{DAY}'::date + 1)
-- GROUP BY 1, 2
-- ORDER BY 1, 2;


-- =====================================================================
-- OPTIONAL SANITY CHECK -- Spot AI duplicate-dashboard inventory.
-- Run when a camera number looks wrong, or before adding a new
-- gap-fill site. dashboard_rows > 1 means duplicate dashboards at that
-- site, i.e. a SUM there would inflate it 2-4x.
-- Do NOT export this into the CSV -- it collides with the ~75 splashdb
-- rows that already report through `sales`.
-- =====================================================================
-- SELECT location, date, MAX(num_cars) AS total_cars, COUNT(*) AS dashboard_rows
-- FROM spot_ai_car_counts
-- WHERE date = '{DAY}'
-- GROUP BY location, date
-- ORDER BY dashboard_rows DESC, location;
