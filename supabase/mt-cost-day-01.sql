-- mt-cost-day-01.sql
--
-- The cost model, rebuilt on PUNCHED hours and at DAY grain.
--
-- ===========================================================================
-- WHY THE BASIS CHANGED
-- ===========================================================================
-- Operator, 2026-09-18: "Cost basis should be punched hours. A comparison
-- between that and gps hours is also valuable but not the headline."
--
-- Until now the cost centres were allocated by GPS -- where the vehicle was --
-- while the business bills by the punch. On the Sites line alone that was a
-- 1,386 h difference (3,265 billed vs 1,879 GPS could place), and it produced
-- rows like Batavia Veterans showing zero for a site charged 73.7 h, because
-- the one mechanic working it has a dead transponder.
--
-- GPS is not discarded. It moves to where it belongs: corroboration, reported
-- beside the billed figure on the Location review tab. gps_onsite_h is carried
-- on every row here so the comparison stays a subtraction, not a second query.
--
-- ===========================================================================
-- THE PUNCH BASIS IS FULLY ADDITIVE, WHICH THE GPS BASIS NEVER WAS
-- ===========================================================================
-- Every punch carries exactly one job, and every job has a kind, so every paid
-- hour lands in exactly one cost centre with no remainder:
--
--   overhead PERSON  -> Management, whole person, whatever job they punched
--                       (the IT rule; cost and trackability are independent)
--   OVERHEAD job     -> Management
--   PTO job          -> Paid leave
--   CAPX job         -> Capital projects
--   SITE job         -> that site
--   SITE, no site    -> Unassigned (a job whose site could not be resolved)
--
-- There is NO Unattributed bucket here and that is the point: "we cannot place
-- this hour" is a statement about GPS coverage, not about who is paying. It
-- survives as a GPS measure on the review surface (mt_punch_allocation,
-- mt_offsite_time) and must not be re-added to a billed total.
--
-- Warehouse likewise: it was a carve-out of GPS Unattributed. Time at the
-- warehouse is punched to some job and bills there.
--
-- ===========================================================================
-- WHY DAY GRAIN
-- ===========================================================================
-- The operator asked for this week / last week / current month / past 30 days
-- / QTD / last quarter / YTD. A month-grained view cannot answer any of the
-- sub-month ones, and seven period-specific views would be seven things to
-- keep in step. One day-grained fact rolls up to all of them, and the caller
-- picks the range.
--
-- Bucketed on the mechanic's LOCAL day (America/New_York), not UTC: an evening
-- shift would otherwise split across two dates and "this week" would silently
-- include part of Sunday night twice over.
--
-- gps_onsite_h is time the vehicle sat inside the CLAIMED site's fence during
-- the punch. Deliberately not "inside any fence" -- the question the review
-- tab asks is whether the truck was where the punch said, so time at a
-- different site is not corroboration of this one.

create or replace view public.mt_cost_day as
with crew as (
  select d.device_id, d.connecteam_user_id, r.expense_to
  from mt_device_person d
  join mt_closer_role r on r.maintainx_user_id = d.maintainx_user_id
),
punch as (
  select (p.start_utc at time zone 'America/New_York')::date as work_date,
         p.shift_id, c.device_id, c.expense_to,
         p.start_utc, p.end_utc, p.duration_minutes,
         j.kind, js.site_number
  from mt_punch p
  join crew c on c.connecteam_user_id = p.connecteam_user_id
  left join mt_shift_job sj on sj.shift_id = p.shift_id
  left join mt_connecteam_job j on j.job_id = sj.job_id
  left join mt_job_site js on js.job_id = sj.job_id
),
classed as (
  select p.*,
         case
           when p.expense_to = 'MANAGEMENT'             then 'MANAGEMENT'
           when p.kind = 'OVERHEAD'                     then 'MANAGEMENT'
           when p.kind = 'PTO'                          then 'PTO'
           when p.kind = 'CAPX'                         then 'CAPX'
           when p.kind = 'SITE' and p.site_number is not null then 'SITE'
           else 'UNASSIGNED'
         end as centre_kind
  from punch p
),
gps as (
  select c.shift_id,
         sum(extract(epoch from (least(c.end_utc, g.departed_at)
                               - greatest(c.start_utc, g.arrived_at))) / 3600.0) as onsite_h
  from classed c
  join mt_gps_dwell g
    on g.device_id = c.device_id and g.within_geofence
   and g.matched_site_number = c.site_number
   and g.arrived_at < c.end_utc and g.departed_at > c.start_utc
  where c.site_number is not null
  group by c.shift_id
)
select c.work_date,
       c.centre_kind as kind,
       case when c.centre_kind in ('SITE','CAPX') then c.site_number end as site_number,
       round((sum(c.duration_minutes) / 60.0)::numeric, 2) as punched_h,
       round(coalesce(sum(g.onsite_h), 0)::numeric, 2)     as gps_onsite_h,
       count(*)                                            as punches
from classed c
left join gps g on g.shift_id = c.shift_id
group by 1, 2, 3;
