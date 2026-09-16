-- locations-coordinates-03-geocoded.sql
--
-- Gap G1, second pass: the 26 sites the punch-derived pass could not reach.
-- Takes public.locations from 58/86 to 85/86.
--
-- WHY THESE NEEDED A DIFFERENT METHOD. The 02 backfill derived centres from
-- Connecteam punches, so it could only ever cover sites the maintenance team
-- actually visits. These 26 are mostly sites they do not -- CT, NJ, DE, PA, MA.
-- No amount of punch data was going to produce them.
--
-- TWO GEOCODERS, NEITHER OF WHICH NEEDS A KEY
--   1. US Census Bureau (geocoding.geo.census.gov) -- free, no key,
--      authoritative for US street addresses. 24 of 26.
--   2. OpenStreetMap Nominatim -- as an INDEPENDENT CHECK, not a fallback,
--      rate-limited to 1 req/sec with a real User-Agent per their policy.
--
-- 18 of 26 agreed within 250 m. That agreement is the actual cross-check here.
--
-- THE THIRD SIGNAL SETTLED THE TWO DISPUTES, AND IT SETTLED THEM THE SAME WAY.
-- Sites 137 (Williamsville) and 149 (Hamburg) disagreed by 1,047 m and 647 m.
-- Geotab dwell arbitrated: 170 stationary pings at the Census point vs 0 at
-- OSM's, and 66 vs 1. Census won both. Its coordinate is what is stored.
--
-- ZERO GEOTAB DWELL IS NOT DISQUALIFYING HERE, AND THIS IS THE ONE SUBTLETY
-- WORTH READING TWICE. In the 02 backfill a coordinate came FROM a punch
-- claiming somebody stood there, so no vehicles ever stopping there falsified
-- it -- which is exactly why site 241 was rejected in that pass. A geocoded
-- coordinate makes no such claim: it comes from the address alone, and the
-- maintenance team never visiting a site in Delaware says nothing about
-- whether the address is right. Applying the 02 rule here would have thrown
-- away perfectly good coordinates for every site outside the team's territory.
--
-- UNCERTAINTY IS ENCODED IN geofence_radius_m rather than lost:
--   150 m  both geocoders within 100 m
--   200 m  both within 250 m
--   250 m  arbitrated by Geotab, or single-source WITH dwell confirming
--   300 m  single-source, nothing corroborating   (241 Exton, 252 Wilmington)
--
-- STILL NULL: exactly one row. Geneva III (158) has no address in the table at
-- all, so there is nothing to geocode. It needs an address before it needs a
-- coordinate.
--
-- APPLIED 2026-09-16. Guarded with `and l.latitude is null`, so re-running can
-- never overwrite a gps-derived centre or a hand-set 'manual' one with a
-- geocode -- the geocode is the weaker source and must not win a rerun.
--
-- Applied out-of-band (Supabase SQL editor / MCP apply_migration), matching the
-- convention of the other scripts in this directory.

update public.locations l set
  latitude          = v.lat,
  longitude         = v.lon,
  geofence_radius_m = v.radius,
  geo_source        = 'geocoded',
  geo_verified_at   = now()
from (values
  (21,41.428852,-73.577025,250),
  (22,41.188502,-73.200805,150),
  (23,41.188834,-73.20017,150),
  (32,41.036641,-73.602093,150),
  (40,41.016287,-73.649588,150),
  (60,41.336454,-72.97836,200),
  (73,41.476832,-73.21549,200),
  (76,41.033674,-73.784992,150),
  (91,42.164429,-71.058438,150),
  (92,41.565507,-70.595682,150),
  (124,42.87794,-77.255096,200),
  (137,42.96607,-78.725245,250),
  (146,43.119571,-76.159223,150),
  (147,43.460966,-76.48495,250),
  (149,42.789696,-78.811012,250),
  (157,43.006509,-78.215057,200),
  (183,40.838589,-73.329235,250),
  (184,40.681802,-73.359428,150),
  (197,42.699049,-73.894484,150),
  (222,44.416848,-73.213346,150),
  (232,39.93175,-75.031461,150),
  (233,39.938756,-74.970619,250),
  (234,39.91255,-74.154702,150),
  (241,40.026081,-75.635762,300),
  (251,39.652645,-75.750457,150),
  (252,39.764388,-75.51429,300)
) as v(site_number, lat, lon, radius)
where l.site_number = v.site_number
  and l.latitude is null;
