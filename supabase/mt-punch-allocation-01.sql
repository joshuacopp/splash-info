-- mt-punch-allocation-01.sql  --  Phase 3b, the per-punch cost decomposition
--
-- PLAN.md 8's four-way partition, one row per punch. A VIEW: nothing is
-- written, and it recomputes as dwell and the site crosswalk improve.
--
-- Every bucket is decided by GPS, never by what the punch claims. A leg is the
-- movement between one stay and the next, classified by where it TERMINATES --
-- "the destination pays" (PLAN.md 8). That rule is what makes the partition
-- computable at all, because nothing in Connecteam records which site a punch
-- is billed to (see mt-connecteam-job-site-01.sql).
--
--   onsite_billed_min      stay inside the billed site's fence
--   onsite_other_min       stay inside SOME OTHER site's fence
--   billable_travel_min    leg ending inside the billed site's fence
--   other_site_travel_min  leg ending inside another site's fence
--   overhead_travel_min    leg ending at NO known site -- home, parts counter,
--                          anywhere without a geofence. Nobody's cost.
--   unaccounted_min        stationary somewhere that is not a Splash site
--   no_gps_min             punch time the device reported nothing for
--
-- SEVEN BUCKETS, NOT FOUR, AND THE EXTRA THREE ARE NOT PADDING. The
-- other_site_* pair exists because the marginal-leg rule means a leg ending at
-- site Y during a punch billed to X is Y's cost, not X's; collapsing them into
-- the billed site would silently mis-bill. no_gps_min exists because "we have
-- no measurement" must never be absorbed into a bucket that reads as a
-- measurement -- it is 12% of paid time and would visibly inflate whichever
-- bucket swallowed it.
--
-- MEASURED 2026-09-17. Crew punches from 2026-07-16 (GPS start), admin punches
-- excluded. 1,178 punches / 4,579 paid hours:
--
--   on-site (billed)        1,455 h   31.8%
--   overhead travel           962 h   21.0%
--   unaccounted               849 h   18.5%
--   no GPS                    544 h   11.9%
--   billable travel           410 h    9.0%
--   on-site (other site)      181 h    4.0%
--   travel to another site    179 h    3.9%
--
--   BILLABLE SHARE OF PAID TRAVEL: 38.0%. Nearly two thirds of windshield time
--   terminates somewhere that is not a Splash site.
--
-- COHERENCE CHECK THE MODEL HAD TO PASS. Overhead should concentrate in the
-- last punch of the day, because that is when the drive home happens:
--
--   last punch of day   476 punches   24.3% of paid time overhead   (658 h)
--   earlier punches     702 punches   16.2%                         (304 h)
--
-- 68% of all overhead hours sit in last-of-day punches. The partition was
-- never told about is_last_of_day; this falls out of the leg-termination rule
-- alone, independently reproducing the punching-convention finding recorded in
-- mt-connecteam-job-site-01.sql from the opposite direction.
--
-- WHAT THIS IS NOT
--   On-site dwell is a CEILING on productive time, never evidence of it
--   (PLAN.md 8). Geotab tracks a vehicle, Connecteam records a button press,
--   MaintainX records a clock. None of them observes labour. A mechanic can
--   sit inside a fence for six hours doing nothing and no signal here can tell.
--
--   A large overhead number is a fact about where somebody lives and where
--   they are dispatched from -- territory design, not conduct. PLAN.md 8 is
--   explicit that the UI must not rank people on it, and the 962 hours above
--   are mostly thirteen people driving home thirteen times a week.
--
--   The drive home is currently billed to the last site worked, because the
--   overhead job is not being punched. This view therefore shows what SHOULD
--   be overhead under PLAN.md 8's rule, which is NOT what sites are charged
--   today. Moving it is an operator decision; the view reports, it does not
--   re-bill.
--
--   billed_confidence is C/L for a usable site attribution and W/F/I
--   otherwise. A NULL billed_site sends all site time to the "other" buckets
--   by construction, because without a billed site nothing can be "the" site.
--   Filter on billed_confidence in ('C','L') before quoting a per-site number.

create or replace view public.mt_punch_allocation as
with legs as (
  select g.device_id,
         g.departed_at as leg_start,
         lead(g.arrived_at)          over (partition by g.device_id order by g.arrived_at) as leg_end,
         lead(g.within_geofence)     over (partition by g.device_id order by g.arrived_at) as ends_at_site,
         lead(g.matched_site_number) over (partition by g.device_id order by g.arrived_at) as ends_site
  from mt_gps_dwell g),
punch as (
  select p.shift_id, p.connecteam_user_id, d.device_id, p.start_utc, p.end_utc,
         p.source_type, p.is_last_of_day,
         extract(epoch from (p.end_utc - p.start_utc))/60.0 as punch_minutes,
         s.site_number as billed_site, s.confidence as billed_confidence
  from mt_punch p
  join mt_device_person d on d.connecteam_user_id = p.connecteam_user_id
  left join mt_shift_site s on s.shift_id = p.shift_id
  where p.end_utc is not null and p.source_type <> 'admin'
    and p.start_utc >= '2026-07-16'),
dwell_part as (
  select pu.shift_id,
    coalesce(sum(case when g.within_geofence and g.matched_site_number = pu.billed_site then o.ov end),0) onsite_billed_min,
    coalesce(sum(case when g.within_geofence and g.matched_site_number is distinct from pu.billed_site then o.ov end),0) onsite_other_min,
    coalesce(sum(case when not g.within_geofence then o.ov end),0) unaccounted_min
  from punch pu
  join mt_gps_dwell g on g.device_id = pu.device_id
   and g.arrived_at < pu.end_utc and g.departed_at > pu.start_utc
  cross join lateral (select extract(epoch from (least(pu.end_utc,g.departed_at) - greatest(pu.start_utc,g.arrived_at)))/60.0 ov) o
  group by pu.shift_id),
leg_part as (
  select pu.shift_id,
    coalesce(sum(case when l.ends_at_site and l.ends_site = pu.billed_site then o.ov end),0) billable_travel_min,
    coalesce(sum(case when l.ends_at_site and l.ends_site is distinct from pu.billed_site then o.ov end),0) other_site_travel_min,
    coalesce(sum(case when not l.ends_at_site then o.ov end),0) overhead_travel_min
  from punch pu
  join legs l on l.device_id = pu.device_id and l.leg_end is not null
   and l.leg_start < pu.end_utc and l.leg_end > pu.start_utc
  cross join lateral (select extract(epoch from (least(pu.end_utc,l.leg_end) - greatest(pu.start_utc,l.leg_start)))/60.0 ov) o
  group by pu.shift_id)
select pu.shift_id, pu.connecteam_user_id, pu.device_id, pu.start_utc, pu.end_utc,
       pu.is_last_of_day, pu.billed_site, pu.billed_confidence,
       round(pu.punch_minutes::numeric,1)                    as punch_minutes,
       round(coalesce(d.onsite_billed_min,0)::numeric,1)     as onsite_billed_min,
       round(coalesce(d.onsite_other_min,0)::numeric,1)      as onsite_other_min,
       round(coalesce(d.unaccounted_min,0)::numeric,1)       as unaccounted_min,
       round(coalesce(l.billable_travel_min,0)::numeric,1)   as billable_travel_min,
       round(coalesce(l.other_site_travel_min,0)::numeric,1) as other_site_travel_min,
       round(coalesce(l.overhead_travel_min,0)::numeric,1)   as overhead_travel_min,
       round(greatest(pu.punch_minutes
             - coalesce(d.onsite_billed_min,0) - coalesce(d.onsite_other_min,0)
             - coalesce(d.unaccounted_min,0)   - coalesce(l.billable_travel_min,0)
             - coalesce(l.other_site_travel_min,0) - coalesce(l.overhead_travel_min,0), 0)::numeric,1) as no_gps_min
from punch pu
left join dwell_part d on d.shift_id = pu.shift_id
left join leg_part  l on l.shift_id = pu.shift_id;

-- mt_shift_site: which site each shift is billed to, via the derived job
-- crosswalk. 1,723 of 2,699 shifts resolve; 864 at C/L confidence.
create table if not exists public.mt_shift_site (
  shift_id    text primary key,
  site_number integer not null,
  confidence  char(1) not null check (confidence in ('C','L','W','F','I')),
  derived_at  timestamptz not null default now()
);
alter table public.mt_shift_site enable row level security;
