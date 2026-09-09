-- 90_dow_volume_check.sql
--
-- Day-of-week sanity check for the splashdb source.
--
-- WHY: on 2026-09-06 (Sunday) splashdb came in 31% under the previous Saturday,
-- while DRB / ICS / spot_ai fell only 16-20%. That looked like unsettled sales.
-- But those three sources cover six sites between them and splashdb covers ~82,
-- so their taper is not a fair yardstick for the fleet. The real question is
-- what a normal Saturday -> Sunday drop looks like for splashdb itself.
--
-- Read-only. SELECT only. Safe to run any time.
--
-- USAGE
--   psql "service=splashdb" -P pager=off --no-psqlrc -f queries\90_dow_volume_check.sql

-- MAX, never SUM: duplicate rows per site-day would roughly double the total.
with daily as (
  select s.date::date as day,
         l.s_name     as nm,
         max(s.lube_cars) as cars
  from public.sales s
  join public.locations l on s.location_id = l.id
  where s.date >= dateadd(week, -9, current_date)
    and s.date <  current_date
  group by 1, 2
),
totals as (
  select day,
         to_char(day, 'Dy') as dow,
         count(*)           as sites,
         sum(cars)          as cars
  from daily
  group by 1, 2
)
select day,
       dow,
       sites,
       cars,
       -- same weekday last week, for a like-for-like comparison
       lag(cars, 7) over (order by day) as cars_prev_week,
       -- previous calendar day, so Sunday rows show the Sat -> Sun drop
       round(
         100.0 * cars / nullif(lag(cars, 1) over (order by day), 0) - 100.0
       , 1) as pct_vs_prev_day
from totals
order by day;
