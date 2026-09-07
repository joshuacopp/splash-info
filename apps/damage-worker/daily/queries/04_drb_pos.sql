-- =====================================================================
-- 04_drb_pos.sql
-- =====================================================================
-- FEEDS      : source = 'DRB'  in daily_car_counts_<DAY>.csv
-- CONNECTION : DBeaver connection `splashdb`  (Amazon Redshift),
--              schema  razayya_agent_collector  (DRB SiteWatch POS)
-- OUTPUT     : CSV header is  source,location_name,day,total_cars
--              This query emits exactly those four columns, in that order.
-- PLACEHOLDER: '{DAY}'  -- a single-quoted YYYY-MM-DD literal, e.g. '2026-09-05'.
-- READ-ONLY  : SELECT only. Standing rule from Josh: never write to any
--              DBeaver connection, ever.
--
-- PURPOSE    : The PREFERRED source for exactly two sites:
--                196  Rensselaer   -> location_code 'rensselear'  (typo is real)
--                197  Guilderland  -> location_code 'guilderland'
--              build_car_counts.py ranks DRB (POS) > splashdb (sales) >
--              spot_ai (camera), so these override any camera row.
--              Rensselaer's Spot AI camera runs ~12% BELOW POS consistently
--              (592 vs 673, 527 vs 598 on two days) -- a systematic
--              undercount, not noise. Guilderland's camera matches exactly.
--
-- ---------------------------------------------------------------------
-- THE COUNT RULE
-- ---------------------------------------------------------------------
-- Every row in v_sale is ONE CAR through the tunnel (Josh's domain
-- knowledge, and it overturned an earlier subagent verdict that the schema
-- was unusable). So:
--
--   car_count = ALL rows for the day
--             - rows with actualsaleid IS NOT NULL   (5am settlement batch)
--             - rows with actualsaleid IS NULL AND status = -32768 (refunds)
--             - rows with actualsaleid IS NULL AND status = -32704 (null group)
--
-- Why each exclusion:
--   * actualsaleid IS NOT NULL  -- ~26% of rows. A nightly settlement batch
--     landing in the 5am hour, two-plus hours before the site opens. Carries
--     retail dollar values ($33-40 avg) while the live car stream is mostly
--     $0 member redemptions, and its actualsaleid resolves to nothing in the
--     extract. These are not cars.
--   * status = -32768 with null actualsaleid -- refunds and adjustments,
--     average around -$114. A reversal of a car, not an extra car. Small
--     (about 12 and 10 rows/day) but it belongs out.
--   * status = -32704 with null actualsaleid -- small null group, trivial
--     and mostly $0.
--
-- Verified: 2026-09-04 Guilderland 907 / Rensselaer 673.
--           2026-09-05 Guilderland 986-308-1-3 = 674
--                      Rensselaer  836-224-3-11 = 598
-- Integrity is clean -- count(*) = count(distinct objid), no null/zero objid.
--
-- ---------------------------------------------------------------------
-- TRAP: SITE NAMING
-- ---------------------------------------------------------------------
-- Sites are keyed by NAME in `site_id` (varchar) plus a site-local `site`
-- int (Guilderland = 1, Rensselaer = 2). The DRB site numbers 196/197 appear
-- NOWHERE in this schema, and build_car_counts.py matches on the trailing
-- 3-digit number in location_name. The CASE below therefore rewrites
-- site_id into the names the CSV expects. Do not drop it -- a bare
-- 'Guilderland' has no site number and will be skipped as
-- "no site number in name".
--   Expected output, from 2026-09-05:
--       DRB,Splash Guilderland-197,2026-09-05,674
--       DRB,Splash Rensselaer-196,2026-09-05,598
--
-- ---------------------------------------------------------------------
-- LIMITS
-- ---------------------------------------------------------------------
-- * Covers ONLY Guilderland and Rensselaer. No Plattsburgh (083), no
--   Falmouth (092) -- confirmed across all eight populated tables. Those two
--   stay camera-derived (02_spot_ai.sql).
-- * Rolling ~15-day window. No history for backfill or trending.
-- * v_saleitems, v_itemtype, v_profitcenter, v_salepayments, v_tender and
--   v_plantypetype are all EMPTY. v_salestats is broken (captures only the
--   first ~60s of each day). Don't re-investigate from scratch -- just check
--   whether the collector has started populating them.
--
-- PROVENANCE : The main query below is RECOVERED VERBATIM from the
--              2026-09-05 pull (the arithmetic 986-308-1-3 = 674 is quoted
--              in the transcript against this exact SQL). Only the literal
--              dates were replaced with '{DAY}', and the source /
--              location_name / day columns were added to match the CSV
--              shape. The completeness check below is also verbatim.
-- =====================================================================

SELECT
    'DRB' AS source,
    CASE s.site_id
        WHEN 'Guilderland' THEN 'Splash Guilderland-197'
        WHEN 'Rensselaer'  THEN 'Splash Rensselaer-196'
        ELSE s.site_id
    END                                                   AS location_name,
    '{DAY}'::date                                         AS day,
      count(*)
    - sum(case when s.actualsaleid is not null then 1 else 0 end)
    - sum(case when s.actualsaleid is null and s.status = -32768 then 1 else 0 end)
    - sum(case when s.actualsaleid is null and s.status = -32704 then 1 else 0 end)
                                                          AS total_cars
FROM razayya_agent_collector.v_sale s
WHERE s.logdate >= '{DAY}'
  AND s.logdate <  ('{DAY}'::date + 1)
GROUP BY s.site_id
ORDER BY s.site_id;


-- ---------------------------------------------------------------------
-- MANDATORY PRE-CHECK: is the day complete, or a truncated extract?
-- Run this BEFORE trusting the counts above.
--
-- `logtime` is in 6-SECOND UNITS -- multiply by 6 for seconds past midnight.
--   11,676 = 19:27, which is normal closing time.
-- Reference maxima: 09-03 11,697/11,670 · 09-04 11,676/12,124 · 09-05
-- 11,674/11,683. If mx_logtime lands well short of ~11,600 at Guilderland,
-- the day is PARTIAL and the count is not comparable -- it will look like a
-- sharp decline that isn't real. Stop and say so.
-- ---------------------------------------------------------------------
SELECT trunc(logdate) AS d, site_id,
       count(*) AS n,
       count(distinct objid) AS n_obj,
       sum(case when objid is null or objid = 0 then 1 else 0 end) AS bad_objid,
       min(created) AS mn_created, max(created) AS mx_created,
       min(logtime) AS mn_logtime, max(logtime) AS mx_logtime,
       count(distinct terminal) AS n_terminals
FROM razayya_agent_collector.v_sale
WHERE logdate >= '{DAY}'
  AND logdate <  ('{DAY}'::date + 1)
GROUP BY 1, 2
ORDER BY 1, 2;


-- ---------------------------------------------------------------------
-- APPENDIX 1 -- the count query exactly as recovered, for 2026-09-05.
-- ---------------------------------------------------------------------
-- select site_id, count(*)
--   - sum(case when actualsaleid is not null then 1 else 0 end)
--   - sum(case when actualsaleid is null and status = -32768 then 1 else 0 end)
--   - sum(case when actualsaleid is null and status = -32704 then 1 else 0 end) as car_count
-- from razayya_agent_collector.v_sale
-- where logdate >= '2026-09-05' and logdate < '2026-09-06' group by 1
--
-- ---------------------------------------------------------------------
-- APPENDIX 2 -- status breakdown, recovered verbatim. Run this when a count
-- looks wrong; it shows which group moved.
-- 2026-09-04 groups (Guilderland / Rensselaer):
--   -16384 null   907 / 673   mostly $0  -- unlimited-plan member redemptions
--   -32768 linked 198 / 142   avg $39.86 / $37.75  -- paid retail (EXCLUDED)
--   -9     linked 127 /  85   avg $33.19 / $33.43  -- paid retail (EXCLUDED)
--   -32768 null    12 /  10   avg -$114.31 / -$0.28 -- refunds  (EXCLUDED)
--   -32704 + strays 4 /  15   trivial, mostly $0    -- (EXCLUDED)
-- ---------------------------------------------------------------------
-- select trunc(logdate) as d, site_id, status,
--        case when actualsaleid is null then 'null' else 'linked' end as act,
--        count(*) as n, count(distinct objid) as n_obj,
--        sum(case when total=0 then 1 else 0 end) as n_zero,
--        avg(total) as avg_total
-- from razayya_agent_collector.v_sale
-- where logdate >= '2026-09-04' and logdate < '2026-09-06'
-- group by 1,2,3,4
-- order by 1,2,3,4;
