-- mt-offsite-locations-01.sql
--
-- Named places that are NOT car wash sites but where crew legitimately stop --
-- the warehouse, parts suppliers, a shop. Lets paid time move out of the
-- Unattributed bucket into something with a name.
--
-- ===========================================================================
-- WHY: THE GEOFENCE WAS NOT THE PROBLEM
-- ===========================================================================
-- The operator asked whether site geofences were too tight, since 859 paid
-- hours were landing in "stopped somewhere with no geofence". Measured
-- 2026-09-17, distance from the nearest site fence, paid time only:
--
--   within 150 m past the fence      28 h    3.3%
--   within 1 km past the fence       88 h   10.1%
--   1-5 km away                     375 h   43.7%
--   5-50 km away                    394 h   45.9%
--
-- Widening every radius to 150 m recovers 3%. Even an absurd 1 km radius --
-- which would swallow neighbouring businesses and overlap adjacent sites --
-- recovers 10%. Roughly NINE TENTHS of that time is spent more than a
-- kilometre from any Splash site, so it is genuinely elsewhere and not a
-- boundary artefact. Widening fences would not have fixed it and would have
-- started attributing other people's car parks to Splash sites.
--
-- Naming the shared stops is the only thing that reduces the bucket honestly.
--
-- ===========================================================================
-- RESIDENTIAL ADDRESSES ARE DELIBERATELY EXCLUDED AND MUST STAY EXCLUDED
-- ===========================================================================
-- The largest recurring off-site clusters are mechanics' homes. The biggest is
-- 179 paid hours on a SINGLE vehicle 19 km from any site; the operator
-- confirmed it as a home address, and confirmed two others.
--
-- They are not in this table and must not be added:
--   - home time is already overhead under the operator's own rule, so
--     geofencing it changes no cost figure;
--   - an employee's home coordinates in a queryable table is a privacy
--     exposure with no analytical upside;
--   - "not a known location" is the correct representation, and is what the
--     tracker already produces.
--
-- The shape that distinguishes them is reliable and worth remembering: a home
-- is ONE vehicle, long stays, far out. A shared facility is MANY vehicles,
-- short stays. The NY Warehouse is 7 vehicles averaging 8-20 minutes, which is
-- a parts-pickup pattern; a home is one vehicle averaging hours.
--
-- ONE CLUSTER IS UNRESOLVED and is intentionally not seeded here: a
-- residential address ~1.4 km from a site with 109 paid hours across FOUR
-- mechanics (one of them 131 visits averaging 28 minutes). Multi-vehicle says
-- facility, residential says home, and the two readings imply opposite
-- treatments. It stays in Unattributed until somebody who knows says which.
-- Guessing would either hide legitimate work or name somebody's house.

create table if not exists public.mt_offsite_location (
  id           bigserial primary key,
  name         text not null,
  latitude     double precision not null,
  longitude    double precision not null,
  radius_m     integer not null default 150,
  cost_centre  text not null check (cost_centre in ('MANAGEMENT','SITE_SUPPORT','OTHER')),
  note         text,
  created_at   timestamptz not null default now()
);
alter table public.mt_offsite_location enable row level security;

insert into mt_offsite_location (name, latitude, longitude, radius_m, cost_centre, note)
select 'NY Warehouse', 42.974, -77.231, 200, 'SITE_SUPPORT',
       'Operator-identified 2026-09-17. Shared: 7 mechanics, 40 visits, 8-20 min each -- a parts-pickup pattern, not a work location.'
where not exists (select 1 from mt_offsite_location where name = 'NY Warehouse');

-- Paid time spent at each named off-site location.
create or replace view public.mt_offsite_time as
with paid as (select device_id, start_utc, end_utc from mt_punch_allocation)
select o.id, o.name, o.cost_centre,
       count(*) visits,
       count(distinct g.device_id) vehicles,
       round((sum(extract(epoch from (least(p.end_utc,g.departed_at)
                                    - greatest(p.start_utc,g.arrived_at)))/3600.0))::numeric,1) paid_hours
from mt_offsite_location o
join mt_gps_dwell g
  on not g.within_geofence
 and sqrt( power((g.centroid_lat - o.latitude)  * 111320.0, 2)
         + power((g.centroid_lon - o.longitude) * 111320.0
                 * cos(radians(g.centroid_lat)), 2) ) <= o.radius_m
join paid p on p.device_id = g.device_id
 and g.arrived_at < p.end_utc and g.departed_at > p.start_utc
group by o.id, o.name, o.cost_centre;

-- Measured on seeding: NY Warehouse, 47 visits, 7 vehicles, 14.2 paid hours.
-- Small against 859 h of Unattributed, and that is the honest picture: most of
-- the bucket is one-off stops -- fuel, food, a single call -- not recurring
-- places waiting to be named. Adding locations shrinks it slowly and will
-- never take it to zero, because a share of "stopped somewhere" is just a
-- working day.
