-- mt-site-month-punched-01.sql
--
-- Adds PUNCHED hours to mt_site_month, alongside the GPS hours it already had.
--
-- ===========================================================================
-- WHY: THE PAGE WAS SHOWING A ZERO FOR A SITE THAT WAS BILLED 73.7 HOURS
-- ===========================================================================
-- Operator, 2026-09-18: "Having 0 hours on site but hours recorded on the work
-- order is misleading. We also don't seem to be reflecting the hours punched
-- in on Connecteam for the site, which are the actual billed hours."
--
-- Batavia Veterans (#121), September 2026, as the view stood:
--
--   punched in Connecteam   73.7 h   (32.4 site + 41.3 CapX)
--   GPS on site              0.0 h
--   work orders closed        11, 12.3 h of logged labour
--   why the zero            Charles Zimmer's transponder, silent 18 days
--
-- The site row read "ON-SITE 0 / TOTAL 0" next to fourteen work orders with
-- labour hours on them. Every figure was correct and the row was still wrong,
-- because the one number a reader wants -- what is this site being charged --
-- was the one number not on it.
--
-- THE TWO ARE DIFFERENT QUESTIONS AND BOTH BELONG ON THE ROW:
--   punched_h   what the site is BILLED. Connecteam, the mechanic's claim.
--   onsite_h    what GPS can CORROBORATE. Evidence, and silent when a
--               transponder dies.
-- Reporting only the second made a broken device look like an absent mechanic.
-- Reporting only the first would be the old spreadsheet. The tracker exists to
-- hold them side by side.
--
-- NOTE THE ASYMMETRY when reading a row: onsite_h can never exceed punched_h
-- by much, but punched_h routinely exceeds onsite_h for honest reasons --
-- travel, a dead transponder, an unfenced stop. A gap is a question, never a
-- finding. See mt_mechanic_day for the per-day version of the same comparison.
--
-- GRAIN IS UNCHANGED, (month, site). punched_h is added as a column rather
-- than a row so every existing consumer keeps summing the view the way it
-- already does.
--
-- A punch maps to exactly one site through its job, so punched_h cannot double
-- count across sites. It CAN exceed the site's real share when a mechanic
-- works two sites on one punch -- which is a punching-convention problem
-- (see the Hudson Valley note in locations-coordinates-04) and not something
-- this view can or should correct.

create or replace view public.mt_site_month as
with site_billable as (
  select d.device_id
  from mt_device_person d
  join mt_closer_role r on r.maintainx_user_id = d.maintainx_user_id
  where r.expense_to = 'SITE'
),
paid as (
  select k.shift_id, k.device_id, k.start_utc, k.end_utc, k.work_kind
  from mt_punch_kind k
  join site_billable b on b.device_id = k.device_id
),
legs as (
  select g.device_id,
         g.departed_at as leg_start,
         lead(g.arrived_at)          over (partition by g.device_id order by g.arrived_at) as leg_end,
         lead(g.within_geofence)     over (partition by g.device_id order by g.arrived_at) as ends_at_site,
         lead(g.matched_site_number) over (partition by g.device_id order by g.arrived_at) as ends_site
  from mt_gps_dwell g
),
onsite as (
  select date_trunc('month', greatest(p.start_utc, g.arrived_at))::date as mth,
         g.matched_site_number as site, p.work_kind,
         sum(extract(epoch from (least(p.end_utc, g.departed_at) - greatest(p.start_utc, g.arrived_at))) / 3600.0) as h
  from paid p
  join mt_gps_dwell g on g.device_id = p.device_id and g.within_geofence
   and g.arrived_at < p.end_utc and g.departed_at > p.start_utc
  group by 1, 2, 3
),
inbound as (
  select date_trunc('month', greatest(p.start_utc, l.leg_start))::date as mth,
         l.ends_site as site, p.work_kind,
         sum(extract(epoch from (least(p.end_utc, l.leg_end) - greatest(p.start_utc, l.leg_start))) / 3600.0) as h
  from paid p
  join legs l on l.device_id = p.device_id and l.ends_at_site and l.leg_end is not null
   and l.leg_start < p.end_utc and l.leg_end > p.start_utc
  group by 1, 2, 3
),
-- The billed side. Keyed on the job the punch claimed, not on GPS, so a site
-- whose only mechanic has a dead transponder still shows its hours.
punched as (
  select date_trunc('month', k.start_utc)::date as mth,
         s.site_number as site, k.work_kind,
         sum(k.punch_minutes) / 60.0 as h
  from mt_punch_kind k
  join mt_job_site s on s.job_id = k.job_id
  join site_billable b on b.device_id = k.device_id
  where s.site_number is not null
  group by 1, 2, 3
),
agg as (
  select coalesce(o.mth, i.mth) as mth, coalesce(o.site, i.site) as site,
         coalesce(o.work_kind, i.work_kind) as work_kind,
         coalesce(o.h, 0) as oh, coalesce(i.h, 0) as ih, 0::float8 as ph
  from onsite o
  full join inbound i on i.mth = o.mth and i.site = o.site and i.work_kind = o.work_kind
  union all
  select p.mth, p.site, p.work_kind, 0, 0, p.h from punched p
)
select mth as month,
       site as site_number,
       round(coalesce(sum(oh) filter (where work_kind = 'SITE'), 0)::numeric, 1) as onsite_h,
       round(coalesce(sum(ih) filter (where work_kind = 'SITE'), 0)::numeric, 1) as inbound_travel_h,
       round(coalesce(sum(oh + ih) filter (where work_kind = 'SITE'), 0)::numeric, 1) as total_h,
       round((100.0 * coalesce(sum(ih) filter (where work_kind = 'SITE'), 0)
              / nullif(coalesce(sum(oh + ih) filter (where work_kind = 'SITE'), 0), 0))::numeric, 1) as pct_drive_time,
       round(coalesce(sum(oh) filter (where work_kind = 'CAPX'), 0)::numeric, 1) as capx_onsite_h,
       round(coalesce(sum(ih) filter (where work_kind = 'CAPX'), 0)::numeric, 1) as capx_travel_h,
       round(coalesce(sum(oh + ih) filter (where work_kind = 'CAPX'), 0)::numeric, 1) as capx_total_h,
       round(coalesce(sum(oh + ih) filter (where work_kind = 'OVERHEAD'), 0)::numeric, 1) as overhead_h,
       round(coalesce(sum(ph) filter (where work_kind = 'SITE'), 0)::numeric, 1) as punched_h,
       round(coalesce(sum(ph) filter (where work_kind = 'CAPX'), 0)::numeric, 1) as punched_capx_h
from agg
group by 1, 2;
