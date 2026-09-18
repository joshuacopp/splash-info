-- mt-device-health-mxid-01.sql
--
-- Adds maintainx_user_id to mt_device_health so callers can join device health
-- to who closed a work order WITHOUT matching on names.
--
-- WHY THIS IS NOT A COSMETIC ADDITION: the two systems disagree on names.
-- mt_device_person carries "Charles Zimmer"; MaintainX carries "Chuck Zimmer"
-- for the same person (maintainx_user_id 452445). A name join looks like it
-- works -- most people match -- and silently drops exactly the person whose
-- transponder is dead, which is the case the join exists to find.
--
-- mt_field_crew already carries maintainx_user_id; this just stops it being
-- dropped on the way through.

create or replace view public.mt_device_health as
with punch as (
  select connecteam_user_id,
         max(start_utc) as last_punch,
         count(distinct (start_utc at time zone 'America/New_York')::date)
           filter (where start_utc >= now() - interval '21 days') as punch_days_21d,
         count(distinct (start_utc at time zone 'America/New_York')::date)
           filter (where start_utc >= now() - interval '7 days') as punch_days_7d
  from mt_punch group by connecteam_user_id
), gps as (
  select device_id,
         max(arrived_at) as last_gps,
         count(distinct (arrived_at at time zone 'America/New_York')::date)
           filter (where arrived_at >= now() - interval '21 days') as gps_days_21d,
         count(distinct (arrived_at at time zone 'America/New_York')::date)
           filter (where arrived_at >= now() - interval '7 days') as gps_days_7d
  from mt_gps_dwell group by device_id
)
select d.device_id,
       d.display_name,
       d.connecteam_user_id,
       g.last_gps,
       p.last_punch,
       floor(extract(epoch from now() - g.last_gps) / 86400)::integer as days_since_gps,
       coalesce(g.gps_days_21d, 0) as gps_days_21d,
       coalesce(p.punch_days_21d, 0) as punch_days_21d,
       case
         when coalesce(p.punch_days_21d, 0) = 0 then 'NOT_WORKING'
         when coalesce(p.punch_days_7d, 0) > 0 and coalesce(g.gps_days_7d, 0) = 0 then 'TRANSPONDER_SILENT'
         when coalesce(g.gps_days_21d, 0)::numeric < (coalesce(p.punch_days_21d, 0)::numeric / 2.0) then 'TRANSPONDER_PATCHY'
         else 'OK'
       end as device_status,
       -- Appended, not inserted: `create or replace view` can only add
       -- columns at the END. Position is irrelevant to PostgREST callers.
       d.maintainx_user_id
from mt_field_crew d
left join punch p on p.connecteam_user_id = d.connecteam_user_id
left join gps g on g.device_id = d.device_id;
