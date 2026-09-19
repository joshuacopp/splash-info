-- mt-punch-detail-01.sql
--
-- Every mechanic punch, one row each, so any total can be taken apart.
--
-- site_number is NULL for overhead and leave punches. The site drill-down
-- filters those out; the flag panel must NOT, because a forgotten clock-out
-- on an overhead job inflates Management exactly as one on a site job
-- inflates that site. Scoped to site jobs only, this view missed a 16-hour
-- overhead punch in the current month -- which is why it is not called
-- mt_site_punch any more.
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- Operator, 2026-09-19, looking at Oswego #147 billing 52 h against 18 h and
-- 17 h at neighbouring sites: "that is hugely out of proportion in billed
-- hours - how can we drill down to see if that's legitimate or fucked up
-- punches orrr?"
--
-- It was one punch. Phillip Ritter, 13 Sep, in 11:12 and out 05:14 the next
-- morning: 18.0 hours, a third of the site's entire month. Take it out and
-- Oswego bills 33.8 h, in line with everything around it.
--
-- A site total could not answer that question and never will be able to. The
-- answer is always a punch, so this view is the punch list.
--
-- ===========================================================================
-- THE FLAGS ARE "LOOK AT THIS", NOT "THIS IS WRONG"
-- ===========================================================================
-- long_punch fires at 14 h. Company-wide that is 14 punches, 247 h, 6 people
-- -- 5% of all paid time. The band below it (12-14 h, 32 punches, 420 h) is
-- deliberately NOT flagged: a genuinely long day exists, and the Iowa drive
-- already documented in mt-punch-out-of-footprint ran 11-12 h and was real.
-- Pick a threshold that catches forgotten clock-outs, not hard days.
--
-- overnight_end fires when a punch ends between 01:00 and 05:59 local. That
-- is the shape of a forgotten clock-out rather than of night work: a real
-- overnight shift starts in the evening, and these mostly start late morning.
--
-- no_gps means the vehicle was never inside the claimed site's fence during
-- the punch. Read it WITH device_status -- Ritter's transponder has been
-- silent since 2026-09-07, so his punches cannot be corroborated whatever he
-- did, and the zero says nothing about him.
--
-- None of these is evidence of anything on its own. A forgotten clock-out is
-- an administrative error, and the fix is a corrected timesheet, not an
-- accusation.

create or replace view public.mt_punch_detail as
with base as (
  select k.shift_id,
         s.site_number,
         d.display_name,
         k.device_id,
         (k.start_utc at time zone 'America/New_York')::date as work_date,
         k.start_utc, k.end_utc,
         k.punch_minutes,
         c.title as job_title,
         k.work_kind,
         p.source_type
  from mt_punch_kind k
  left join mt_job_site s on s.job_id = k.job_id
  join mt_connecteam_job c on c.job_id = k.job_id
  join mt_device_person d on d.device_id = k.device_id
  join mt_punch p on p.shift_id = k.shift_id
),
gps as (
  select b.shift_id,
         sum(extract(epoch from (least(b.end_utc, g.departed_at)
                               - greatest(b.start_utc, g.arrived_at))) / 3600.0) as onsite_h
  from base b
  join mt_gps_dwell g
    on g.device_id = b.device_id and g.within_geofence
   and g.matched_site_number = b.site_number
   and g.arrived_at < b.end_utc and g.departed_at > b.start_utc
  group by b.shift_id
)
select b.shift_id,
       b.site_number,
       b.work_date,
       b.display_name,
       b.job_title,
       b.work_kind,
       b.source_type,
       to_char(b.start_utc at time zone 'America/New_York', 'HH24:MI') as start_et,
       to_char(b.end_utc   at time zone 'America/New_York', 'HH24:MI') as end_et,
       round((b.punch_minutes / 60.0)::numeric, 2) as punch_h,
       round(coalesce(g.onsite_h, 0)::numeric, 2)  as gps_onsite_h,
       (b.punch_minutes / 60.0) >= 14 as long_punch,
       extract(hour from (b.end_utc at time zone 'America/New_York')) between 1 and 5
         as overnight_end,
       coalesce(g.onsite_h, 0) = 0 as no_gps,
       h.device_status
from base b
left join gps g on g.shift_id = b.shift_id
left join mt_device_health h on h.device_id = b.device_id;
