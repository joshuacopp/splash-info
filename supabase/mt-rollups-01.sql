-- mt-rollups-01.sql  --  Phase 3b rollups: the artifact PLAN.md 8 asks for
--
-- Two views over mt_punch_allocation. Nothing is written.
--
--   mt_mechanic_week   per mechanic per week
--   mt_site_month      per site per month
--
-- ===========================================================================
-- LESS THAN HALF OF PAID TIME BELONGS TO A SITE, AND THAT IS THE HEADLINE
-- ===========================================================================
-- 4,579 paid hours in the window. 2,225 of them (49%) attribute to a specific
-- site. The other 2,354 are overhead travel (962 h -- mostly the drive home),
-- stationary somewhere that is not a Splash site (849 h), and time the device
-- reported nothing for (544 h).
--
-- The two views reconcile exactly against the partition, which is the check
-- that they are not quietly double-counting:
--   on-site 1,455 + 181 = 1,636 h,  inbound travel 410 + 179 = 589 h,
--   total 2,225 h = mt_site_month total.
--
-- ===========================================================================
-- WHY SITE HOURS ARE ATTRIBUTED BY GPS AND NOT BY THE PUNCH
-- ===========================================================================
-- mt_site_month charges each hour to the site the vehicle ACTUALLY touched,
-- not the site the punch claimed. The marginal-leg rule says the destination
-- pays, so a leg ending at site Y during a punch billed to X is Y's cost.
-- Rolling up on the punch's own claim would have charged X, and the
-- other_site_* buckets exist in the partition precisely because that happens
-- (360 h of it). Deriving the rollup from the claim would have re-imported the
-- error the partition was built to separate out.
--
-- The drive home is in NEITHER view's site totals: a leg ending at no known
-- site is overhead and belongs to no site at all. That is the whole point of
-- the four-way split, and it is why these totals are lower than a naive
-- "hours punched to this site" report would show.
--
-- ===========================================================================
-- MEASURED 2026-09-17
-- ===========================================================================
--   mt_mechanic_week   108 rows, 12 mechanics, 4,579 h
--                      mean billable travel share 40.9%, mean no-GPS 11.9%
--   mt_site_month      172 rows, 65 sites, 2,225 h
--                      mean drive-time share 32.1%
--
-- ===========================================================================
-- READING RULES THAT TRAVEL WITH THESE NUMBERS
-- ===========================================================================
-- billable_travel_pct is NULL, not 0, for a week with no travel at all. A week
-- with no driving has no share; rendering it as 0% would read as a failure.
--
-- no_gps_pct sits next to every mechanic row on purpose. A low on-site figure
-- with a high no-GPS figure is SILENCE, not idleness, and the two are
-- indistinguishable without looking. Never show one without the other.
--
-- A persistently low billable travel share points at dispatch or territory,
-- not at a person -- somebody with a long commute posts a large overhead
-- number through no fault of their own. PLAN.md 8: the UI must not rank people
-- on it. These views deliberately expose no ordering that invites it.
--
-- On-site hours are a CEILING on productive time, never evidence of it.
-- Geotab tracks a vehicle, Connecteam records a button press. Neither observes
-- labour, and a mechanic can sit inside a fence for six hours doing nothing.
--
-- Per-site figures inherit the site crosswalk's confidence. mt_site_month is
-- attributed by GPS rather than by the crosswalk so it does not depend on it,
-- but any join back to a punch's billed_site should filter
-- billed_confidence in ('C','L') first.

create or replace view public.mt_mechanic_week as
select a.connecteam_user_id,
       date_trunc('week', a.start_utc)::date            as week_starting,
       count(*)                                          as punches,
       round(sum(a.punch_minutes)/60, 1)                 as paid_h,
       round(sum(a.onsite_billed_min + a.onsite_other_min)/60, 1) as onsite_h,
       round(sum(a.billable_travel_min + a.other_site_travel_min)/60, 1) as billable_travel_h,
       round(sum(a.overhead_travel_min)/60, 1)           as overhead_travel_h,
       round(sum(a.unaccounted_min)/60, 1)               as unaccounted_h,
       round(sum(a.no_gps_min)/60, 1)                    as no_gps_h,
       round(100.0 * sum(a.billable_travel_min + a.other_site_travel_min)
             / nullif(sum(a.billable_travel_min + a.other_site_travel_min + a.overhead_travel_min), 0), 1)
                                                         as billable_travel_pct,
       round(100.0 * sum(a.no_gps_min) / nullif(sum(a.punch_minutes),0), 1) as no_gps_pct
from mt_punch_allocation a
group by 1, 2;

create or replace view public.mt_site_month as
with paid as (
  select shift_id, device_id, start_utc, end_utc from mt_punch_allocation),
legs as (
  select g.device_id, g.departed_at leg_start,
         lead(g.arrived_at)          over (partition by g.device_id order by g.arrived_at) leg_end,
         lead(g.within_geofence)     over (partition by g.device_id order by g.arrived_at) ends_at_site,
         lead(g.matched_site_number) over (partition by g.device_id order by g.arrived_at) ends_site
  from mt_gps_dwell g),
onsite as (
  select date_trunc('month', greatest(p.start_utc, g.arrived_at))::date mth,
         g.matched_site_number site,
         sum(extract(epoch from (least(p.end_utc,g.departed_at) - greatest(p.start_utc,g.arrived_at)))/3600.0) h
  from paid p
  join mt_gps_dwell g on g.device_id = p.device_id and g.within_geofence
   and g.arrived_at < p.end_utc and g.departed_at > p.start_utc
  group by 1,2),
inbound as (
  select date_trunc('month', greatest(p.start_utc, l.leg_start))::date mth,
         l.ends_site site,
         sum(extract(epoch from (least(p.end_utc,l.leg_end) - greatest(p.start_utc,l.leg_start)))/3600.0) h
  from paid p
  join legs l on l.device_id = p.device_id and l.ends_at_site and l.leg_end is not null
   and l.leg_start < p.end_utc and l.leg_end > p.start_utc
  group by 1,2)
select coalesce(o.mth, i.mth)   as month,
       coalesce(o.site, i.site) as site_number,
       round(coalesce(o.h,0)::numeric, 1) as onsite_h,
       round(coalesce(i.h,0)::numeric, 1) as inbound_travel_h,
       round((coalesce(o.h,0) + coalesce(i.h,0))::numeric, 1) as total_h,
       round((100.0 * coalesce(i.h,0) / nullif(coalesce(o.h,0)+coalesce(i.h,0),0))::numeric, 1) as pct_drive_time
from onsite o
full outer join inbound i on i.mth = o.mth and i.site = o.site;
