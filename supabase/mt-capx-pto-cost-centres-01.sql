-- mt-capx-pto-cost-centres-01.sql
--
-- Splits CAPITAL work and PAID LEAVE out of the cost model, now that
-- mt_connecteam_job says which job is which.
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- Every site has a "<name> CapX" twin job. Until now the tracker charged both
-- to the site identically, so a site's maintenance cost silently included its
-- capital projects -- 427 h of on-site-and-inbound time, and Seneca Falls CAPX
-- alone is the largest single mechanic job in the data. Capital work is not
-- ordinarily a charge against a site's OPERATING budget, so the two need to be
-- separable. The operator asked for the split on 2026-09-17.
--
-- WHAT CHANGES MEANING: mt_site_month.onsite_h / inbound_travel_h / total_h
-- are now OPERATING ONLY. Capital hours moved to new sibling columns
-- (capx_onsite_h / capx_travel_h / capx_total_h) rather than a new row,
-- because the view's grain is (month, site) and every consumer sums it that
-- way -- adding rows per kind would double every site on the dashboard.
--
-- ===========================================================================
-- THE THREE-WAY RULE, AND WHY UNATTRIBUTED KEEPS ITS SHARE
-- ===========================================================================
-- Per punch of a field mechanic, by the job it claimed:
--
--   SITE      on-site + inbound travel -> that site
--             trailing travel          -> Management (the drive home)
--             unaccounted + no GPS     -> Unattributed
--   CAPX      identical, except on-site + inbound travel -> CapX
--   OVERHEAD  EVERYTHING -> Management
--
-- Unaccounted time on a CapX punch stays in Unattributed rather than moving to
-- CapX. The job a punch claims says what the work was FOR; it says nothing
-- about an hour the GPS cannot place. Moving it would let an unexplained hour
-- inherit an explanation from the punch, which is the exact inversion this
-- tracker exists to avoid.
--
-- OVERHEAD is whole-punch because it is the job-level twin of the whole-person
-- rule already applied to IT: if the work is overhead, all of its time is
-- overhead wherever GPS puts the truck.
--
-- ===========================================================================
-- PTO IS OUTSIDE THE GPS DENOMINATOR AND SAYS SO
-- ===========================================================================
-- All 205 h of mechanic PTO is source_type='admin', and queries/10_punches.sql
-- has excluded admin punches from the scored denominator since Layer A: they
-- are PTO and manual corrections, and they can NEVER carry GPS, so scoring
-- them would count a holiday as a mechanic who failed to show up.
--
-- So PTO has never been in mt_punch_allocation and is not being moved out of
-- another bucket -- it is ADDITIVE. The cost-centre total therefore rises from
-- the allocation's paid hours to paid hours PLUS leave. That is the intended
-- reading (a full account of what the crew was paid for) but it does mean the
-- old 'every centre sums to exactly the allocation' invariant is now
-- 'every centre except PTO sums to exactly the allocation'. Check both.

-- Per-punch job kind. coalesce to SITE so a punch whose job is not catalogued
-- keeps its current treatment rather than silently vanishing from the books.
create or replace view public.mt_punch_kind as
select a.shift_id, a.device_id, a.connecteam_user_id,
       a.start_utc, a.end_utc, a.punch_minutes,
       j.job_id, c.title as job_title, c.code as job_code,
       coalesce(c.kind, 'SITE') as work_kind
from mt_punch_allocation a
left join mt_shift_job j on j.shift_id = a.shift_id
left join mt_connecteam_job c on c.job_id = j.job_id;

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
agg as (
  select coalesce(o.mth, i.mth) as mth,
         coalesce(o.site, i.site) as site,
         coalesce(o.work_kind, i.work_kind) as work_kind,
         coalesce(o.h, 0) as oh,
         coalesce(i.h, 0) as ih
  from onsite o
  full join inbound i on i.mth = o.mth and i.site = o.site and i.work_kind = o.work_kind
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
       round(coalesce(sum(oh + ih) filter (where work_kind = 'OVERHEAD'), 0)::numeric, 1) as overhead_h
from agg
group by 1, 2;

create or replace view public.mt_cost_centre_month as
with overhead_people as (
  select d.connecteam_user_id, d.device_id
  from mt_device_person d
  join mt_closer_role r on r.maintainx_user_id = d.maintainx_user_id
  where r.expense_to = 'MANAGEMENT'
),
a as (
  select k.*, al.overhead_travel_min, al.unaccounted_min, al.no_gps_min,
         date_trunc('month', k.start_utc)::date as mth
  from mt_punch_kind k
  join mt_punch_allocation al on al.shift_id = k.shift_id
),
-- Field crew only: everyone whose time is capable of being a site charge.
crew as (
  select * from a
  where connecteam_user_id not in (select connecteam_user_id from overhead_people)
),
paid as (select device_id, start_utc, end_utc from crew),
offsite as (
  select date_trunc('month', greatest(p.start_utc, g.arrived_at))::date as mth,
         o.cost_centre,
         sum(extract(epoch from (least(p.end_utc, g.departed_at) - greatest(p.start_utc, g.arrived_at))) / 3600.0) as h
  from mt_offsite_location o
  join mt_gps_dwell g on not g.within_geofence
   and sqrt(power((g.centroid_lat - o.latitude) * 111320.0, 2)
          + power((g.centroid_lon - o.longitude) * 111320.0 * cos(radians(g.centroid_lat)), 2)) <= o.radius_m
  join paid p on p.device_id = g.device_id and g.arrived_at < p.end_utc and g.departed_at > p.start_utc
  group by 1, 2
),
mgmt as (
  select z.mth, sum(z.h) as h from (
    -- the drive home, on site and capital punches alike
    select mth, sum(overhead_travel_min) / 60.0 as h
      from crew where work_kind in ('SITE','CAPX') group by mth
    union all
    -- an overhead JOB is overhead whole, wherever the truck was
    select mth, sum(punch_minutes) / 60.0
      from crew where work_kind = 'OVERHEAD' group by mth
    union all
    -- an overhead PERSON is overhead whole (the IT rule)
    select mth, sum(punch_minutes) / 60.0
      from a where connecteam_user_id in (select connecteam_user_id from overhead_people)
      group by mth
  ) z group by z.mth
),
-- Leave never entered mt_punch_allocation (admin punches carry no GPS), so
-- this reads mt_punch directly. It is additive to the total, not a carve-out.
pto as (
  select date_trunc('month', p.start_utc)::date as mth,
         sum(p.duration_minutes) / 60.0 as h
  from mt_punch p
  join mt_shift_job j on j.shift_id = p.shift_id
  join mt_connecteam_job c on c.job_id = j.job_id and c.kind = 'PTO'
  join mt_device_person d on d.connecteam_user_id = p.connecteam_user_id
  join mt_closer_role r on r.maintainx_user_id = d.maintainx_user_id and r.expense_to = 'SITE'
  group by 1
)
select s.month, 'SITE'::text as kind, s.site_number,
       ('Site ' || s.site_number)::text as cost_centre,
       s.onsite_h, s.inbound_travel_h as travel_h, s.total_h as hours
from mt_site_month s
where s.total_h > 0
union all
select s.month, 'CAPX', null, 'Capital projects',
       round(sum(s.capx_onsite_h), 1), round(sum(s.capx_travel_h), 1), round(sum(s.capx_total_h), 1)
from mt_site_month s group by s.month having sum(s.capx_total_h) > 0
union all
select m.mth, 'MANAGEMENT', null, 'Management', 0::numeric, round(m.h, 1), round(m.h, 1)
from mgmt m
union all
select o.mth, 'WAREHOUSE', null, 'Warehouse', round(o.h, 1), 0::numeric, round(o.h, 1)
from offsite o where o.cost_centre = 'WAREHOUSE'
union all
select t.mth, 'PTO', null, 'Paid leave', 0::numeric, 0::numeric, round(t.h::numeric, 1)
from pto t
union all
select c.mth, 'UNATTRIBUTED', null, 'Unattributed',
       round(greatest(sum(c.unaccounted_min) / 60.0
             - coalesce((select sum(o.h) from offsite o where o.mth = c.mth), 0), 0)::numeric, 1),
       0::numeric,
       round(greatest(sum(c.unaccounted_min + c.no_gps_min) / 60.0
             - coalesce((select sum(o.h) from offsite o where o.mth = c.mth), 0), 0)::numeric, 1)
from crew c where c.work_kind in ('SITE','CAPX') group by c.mth;
