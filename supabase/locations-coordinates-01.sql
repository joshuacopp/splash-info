-- locations-coordinates-01.sql
--
-- Site coordinates on public.locations. Gap G1 in
-- apps/maintenance-tracker/PLAN.md -- nothing downstream in the maintenance
-- tracker means anything until these exist, because every compliance question
-- is "was the mechanic near the site" and there is currently no "near".
--
-- Additive, nullable, no default, so this is a metadata-only change: it does
-- not rewrite the table and does not disturb the inbound foreign keys from
-- mx_work_order, mx_work_request and performance_tracking.
--
-- NO POSTGIS, deliberately. PostGIS 3.3.7 is available and not installed, and
-- installing an extension into a production database to compute point-to-point
-- distance against 86 fixed centres is not a trade worth making -- haversine in
-- a CTE is adequate and has no dependency. Revisit only if real polygon
-- geofences are ever needed. (earthdistance and cube are likewise not
-- installed.)
--
-- Applied out-of-band (Supabase SQL editor / MCP apply_migration), matching the
-- convention of the other scripts in this directory.

begin;

alter table public.locations
  add column if not exists latitude          double precision,
  add column if not exists longitude         double precision,
  -- Metres. Per-site rather than global: a small in-bay site and a large lot
  -- with a lube building do not deserve the same tolerance, and a single
  -- constant would be tuned to whichever site complained first.
  add column if not exists geofence_radius_m integer,
  -- How the coordinate was arrived at. Load-bearing for trust rather than
  -- decoration: a GPS-derived centre and a geocoded one fail in different ways
  -- and an exception report needs to say which kind it is standing on.
  --   'gps-derived' | 'geocoded' | 'manual'
  add column if not exists geo_source        text,
  add column if not exists geo_verified_at   timestamptz;

-- Partial: the tracker's hot path is "sites that have a usable centre", and
-- until the backfill is done that is a minority of the table.
create index if not exists locations_geo_idx
  on public.locations (latitude, longitude)
  where latitude is not null and longitude is not null;

comment on column public.locations.latitude is
  'Site centre, WGS84. See geo_source for provenance. Populated by the Gap G1 backfill; null means the maintenance tracker cannot score this site.';
comment on column public.locations.geo_source is
  'gps-derived (median of observed stationary positions) | geocoded (address lookup) | manual (hand-set by an operator). Never blank when latitude is set.';
comment on column public.locations.geofence_radius_m is
  'Per-site match tolerance in metres. Null means fall back to the tracker default.';

commit;
