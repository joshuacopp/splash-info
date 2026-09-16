-- locations-coordinates-02-backfill.sql
--
-- Gap G1 backfill: site centres for 56 of the 86 locations rows.
--
-- HOW THESE WERE DERIVED, because the provenance is the only thing that makes
-- them trustworthy and `geo_source` only has room for one word.
--
-- NO GEOCODER WAS USED. Two independent signals already in the warehouse agree,
-- which is the cross-check PLAN.md §4 asks for and is strictly better than a
-- geocoder on its own -- a geocoded address routinely lands on a road centroid
-- or a parcel edge rather than the part of the lot people actually stand in.
--
--   1. CONNECTEAM PUNCHES. Every mobile punch carries a coordinate AND a
--      reverse-geocoded address string. A punch is attributed to a site only
--      when BOTH the site's ZIP and its street number appear in that string --
--      ZIP alone matches half a town and drags the centre into the next
--      village. The centre is the median of the matches, then anything over
--      150 m from that median is dropped and the median retaken, so a punch
--      from the lot next door cannot move it.
--
--   2. GEOTAB DWELL. Every resulting coordinate was then checked against
--      886,870 vehicle pings: do the mechanics' own vehicles actually sit
--      still here? 56 of 57 candidates had stationary pings (speed <= 3) in a
--      ~200 m box, most in the hundreds or thousands.
--
-- THE ONE THAT FAILED IS INSTRUCTIVE AND IS EXCLUDED. Site 241 (Exton, PA) had
-- exactly one matching punch and ZERO Geotab pings. One punch is not a
-- location, it is a coincidence with a house number, and the second signal
-- said so. It is left null rather than written and flagged.
--
-- geofence_radius_m is the observed 90th-percentile punch spread widened by
-- half and floored at 100 m. The floor is deliberate: a tight cluster is not
-- evidence the site is small, it is evidence the mechanics park in the same
-- spot. Most sites came out at the floor.
--
-- STILL NULL AFTER THIS: 30 rows. 25 sites had no punch that matched on both
-- ZIP and street number -- overwhelmingly sites the maintenance team does not
-- visit -- plus Geneva III (158), which has no address in the table at all, and
-- the duplicate site_number rows that share a centre with their twin. They
-- need a geocoder or a hand-set coordinate, and until they have one the tracker
-- cannot score them. That is the honest state, not a failure of this script.
--
-- SAFE TO RE-RUN. Pure UPDATE keyed on site_number; re-running rewrites the
-- same values and re-stamps geo_verified_at. It does NOT touch rows it has no
-- value for, so a hand-set 'manual' coordinate for one of the 30 survives this
-- being run again.
--
-- Applied out-of-band (Supabase SQL editor / MCP apply_migration), matching the
-- convention of the other scripts in this directory.

update public.locations l set
  latitude          = v.lat,
  longitude         = v.lon,
  geofence_radius_m = v.radius,
  geo_source        = 'gps-derived',
  geo_verified_at   = now()
from (values
  (123,43.202231,-77.943356,100),
  (68,41.295342,-73.107852,100),
  (90,41.244355,-73.027929,100),
  (89,41.312736,-73.056796,100),
  (221,43.582509,-72.966419,100),
  (135,43.975371,-75.953834,100),
  (84,44.475885,-73.114133,100),
  (77,41.041751,-73.790347,100),
  (156,42.124771,-75.969792,100),
  (125,43.154523,-76.122271,100),
  (121,43.010265,-78.208413,100),
  (65,41.123686,-73.399344,100),
  (159,42.949762,-76.546201,100),
  (70,41.138319,-73.338441,100),
  (134,42.086686,-76.048906,100),
  (145,43.147932,-76.231268,100),
  (187,40.838571,-73.321256,100),
  (127,42.130407,-76.825746,100),
  (74,41.296705,-72.950847,100),
  (144,43.179567,-76.26097,100),
  (83,44.698009,-73.479766,100),
  (49,41.088238,-73.459333,100),
  (143,43.182414,-77.805097,100),
  (19,41.228059,-73.710616,100),
  (75,41.033435,-73.755894,100),
  (122,42.146457,-75.901138,100),
  (126,42.574168,-76.216807,100),
  (51,41.366707,-72.919694,100),
  (82,41.600603,-72.677434,100),
  (160,42.975019,-77.365339,100),
  (133,42.906673,-76.826336,180),
  (150,43.029016,-76.014158,100),
  (53,41.081645,-73.520856,100),
  (191,41.5143,-74.2096,100),
  (50,41.148752,-73.246657,100),
  (185,40.700603,-73.616217,100),
  (30,41.529032,-72.896239,100),
  (85,41.281598,-72.86838,100),
  (151,43.086396,-77.616731,100),
  (182,40.774412,-73.106215,100),
  (186,40.847415,-73.260958,100),
  (139,42.857411,-77.011319,100),
  (148,44.039373,-75.841899,100),
  (196,42.650931,-73.695604,100),
  (88,41.423881,-73.578286,100),
  (138,43.129039,-77.440448,100),
  (131,42.99565,-78.179622,100),
  (95,42.122011,-72.584478,100),
  (132,43.047533,-77.11316,100),
  (140,43.197669,-77.931337,100),
  (141,43.130511,-77.693692,100),
  (80,41.208596,-73.430637,100),
  (231,39.748557,-75.046395,100),
  (86,41.508041,-74.068204,100),
  (57,41.422354,-74.426881,100),
  (142,43.210503,-77.695143,100)
) as v(site_number, lat, lon, radius)
where l.site_number = v.site_number;
