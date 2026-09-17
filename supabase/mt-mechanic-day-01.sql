-- mt-mechanic-day-01.sql
--
-- The drill-down the tracker was built for: for one mechanic on one day, what
-- did the punch CLAIM, where was the truck, and what actually got closed.
--
-- Operator's framing, 2026-09-17: "I'm punched in to Vestal for 7 hours, 2 work
-- orders have been closed / no work orders have been closed / my truck's at
-- home."
--
-- ===========================================================================
-- THREE INDEPENDENT SOURCES, DELIBERATELY NOT COLLAPSED INTO A SCORE
-- ===========================================================================
--   CLAIM     Connecteam: which job, for how long
--   PRESENCE  Geotab: where the vehicle actually sat
--   OUTPUT    MaintainX: which work orders that person closed, and where
--
-- They are reported side by side and NOT reduced to a pass/fail. A mechanic
-- can be legitimately on site with nothing to close (diagnosis, waiting on
-- parts, covering a colleague), and can legitimately close a work order from
-- the road. Any single number would have to pick one of those to call a
-- failure. evidence_flag below names the SHAPE of the day, not a verdict --
-- read it as "this is worth a look", never as "this is wrong".
--
-- ===========================================================================
-- CIRCULARITY WARNING, INHERITED FROM THE CROSSWALK
-- ===========================================================================
-- When site_source = 'DERIVED' the claimed site came from mt_connecteam_job_site,
-- which is itself derived from GPS -- so "was the truck at the claimed site"
-- is partly asking GPS to confirm itself, and the answer is biased toward yes.
-- When site_source = 'CODE' the site came from the Connecteam job's own cost
-- code and the comparison is genuinely independent. PREFER CODE ROWS for
-- anything resembling a compliance question, and treat DERIVED rows as
-- descriptive. The column exists so this is visible per row rather than
-- buried in a header.
--
-- ===========================================================================
-- WHY THE DAY IS LOCAL, NOT UTC
-- ===========================================================================
-- "That day" means the mechanic's day. Bucketing on UTC would split an evening
-- shift across two dates and make a 7-hour day look like two short ones, so
-- both the punch and the work-order close are bucketed in America/New_York.
-- Every tracked mechanic is in the Eastern zone; revisit if that changes.

-- Job -> site, code first. `code` is a cost-centre code, so it is only a site
-- when a site of that number actually exists -- Management-011 must not
-- resolve to a site 11 that was never built.
create or replace view public.mt_job_site as
select c.job_id, c.title, c.kind, c.code,
       case when c.code ~ '^[0-9]+$'
             and exists (select 1 from mt_site_name n where n.site_number = c.code::int)
            then c.code::int
            else x.site_number end as site_number,
       case when c.code ~ '^[0-9]+$'
             and exists (select 1 from mt_site_name n where n.site_number = c.code::int)
            then 'CODE'
            when x.site_number is not null then 'DERIVED'
            else 'UNKNOWN' end as site_source,
       x.confidence as derived_confidence
from mt_connecteam_job c
left join mt_connecteam_job_site x on x.job_id = c.job_id
where c.kind in ('SITE','CAPX');

create or replace view public.mt_mechanic_day as
with punch as (
  -- Field crew only. IT keep their rows in mt_punch/mt_punch_kind (the data is
  -- retained for a future IT view) but they are not mechanics and must not
  -- appear in a mechanic drill-down -- the same rule mt_mechanic_week and
  -- mt_device_health already follow via mt_field_crew.
  select (k.start_utc at time zone 'America/New_York')::date as work_date,
         k.connecteam_user_id, k.device_id, k.shift_id,
         k.start_utc, k.end_utc, k.punch_minutes,
         k.job_id, k.job_title, k.work_kind,
         s.site_number as claimed_site, s.site_source, s.derived_confidence
  from mt_punch_kind k
  join mt_field_crew fc on fc.device_id = k.device_id
  left join mt_job_site s on s.job_id = k.job_id
),
-- Dwell overlap per punch, split by whether the stop is at the claimed site,
-- at some other site, or nowhere with a fence.
dwell as (
  select p.shift_id,
         sum(case when g.within_geofence and g.matched_site_number = p.claimed_site
                  then extract(epoch from (least(p.end_utc,g.departed_at) - greatest(p.start_utc,g.arrived_at)))/60.0 end) as at_claimed_min,
         sum(case when g.within_geofence and g.matched_site_number is distinct from p.claimed_site
                  then extract(epoch from (least(p.end_utc,g.departed_at) - greatest(p.start_utc,g.arrived_at)))/60.0 end) as at_other_min,
         sum(case when not g.within_geofence
                  then extract(epoch from (least(p.end_utc,g.departed_at) - greatest(p.start_utc,g.arrived_at)))/60.0 end) as offsite_min,
         string_agg(distinct case when g.within_geofence
                    and g.matched_site_number is distinct from p.claimed_site
                    then coalesce(n.site_name, 'Site ' || g.matched_site_number) end, ', ') as other_sites
  from punch p
  join mt_gps_dwell g on g.device_id = p.device_id
   and g.arrived_at < p.end_utc and g.departed_at > p.start_utc
  left join mt_site_name n on n.site_number = g.matched_site_number
  group by p.shift_id
),
day as (
  select p.work_date, p.connecteam_user_id, p.device_id,
         p.job_id, p.job_title, p.work_kind,
         p.claimed_site, p.site_source, p.derived_confidence,
         sum(p.punch_minutes)                     as punch_min,
         sum(coalesce(d.at_claimed_min, 0))       as at_claimed_min,
         sum(coalesce(d.at_other_min, 0))         as at_other_min,
         sum(coalesce(d.offsite_min, 0))          as offsite_min,
         string_agg(distinct d.other_sites, ', ') as other_sites
  from punch p
  left join dwell d on d.shift_id = p.shift_id
  group by 1,2,3,4,5,6,7,8,9
)
select d.work_date,
       d.connecteam_user_id,
       per.display_name,
       d.job_title,
       d.work_kind,
       d.claimed_site,
       n.site_name as claimed_site_name,
       d.site_source,
       d.derived_confidence,
       round((d.punch_min/60.0)::numeric, 2)       as punch_h,
       round((d.at_claimed_min/60.0)::numeric, 2)  as at_claimed_site_h,
       round((d.at_other_min/60.0)::numeric, 2)    as at_other_site_h,
       round((d.offsite_min/60.0)::numeric, 2)     as stopped_offsite_h,
       round((greatest(d.punch_min - d.at_claimed_min - d.at_other_min - d.offsite_min, 0)/60.0)::numeric, 2)
                                                   as moving_or_no_gps_h,
       d.other_sites,
       coalesce(w.closed_here, 0)                  as wo_closed_at_claimed_site,
       coalesce(e.closed_elsewhere, 0)             as wo_closed_elsewhere,
       w.titles                                    as wo_titles,
       case
         when d.work_kind in ('OVERHEAD','PTO')                    then 'NOT_SITE_WORK'
         when d.claimed_site is null                               then 'NO_CLAIMED_SITE'
         when d.at_claimed_min >= 0.5 * d.punch_min                then 'AT_CLAIMED_SITE'
         when d.at_claimed_min > 0                                 then 'PARTLY_AT_CLAIMED_SITE'
         when d.at_other_min > 0                                   then 'AT_A_DIFFERENT_SITE'
         when d.offsite_min > 0                                    then 'STOPPED_OFF_SITE'
         else 'NO_GPS'
       end as evidence_flag
from day d
join mt_device_person per on per.connecteam_user_id = d.connecteam_user_id
left join mt_site_name n on n.site_number = d.claimed_site
left join lateral (
  select count(*) as closed_here, string_agg(o.title, ' | ' order by o.completed_at) as titles
  from mt_site_work_orders o
  where o.completer_id = per.maintainx_user_id
    and o.site_number = d.claimed_site
    and (o.completed_at at time zone 'America/New_York')::date = d.work_date
) w on true
left join lateral (
  select count(*) as closed_elsewhere
  from mt_site_work_orders o
  where o.completer_id = per.maintainx_user_id
    and o.site_number is distinct from d.claimed_site
    and (o.completed_at at time zone 'America/New_York')::date = d.work_date
) e on true;
