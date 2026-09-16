-- Layer B: collapse geotab_gps into stay intervals.
--
-- READ-ONLY. SELECT only.
--
-- THE MODEL, AND WHY IT IS NOT THE ONE THE PLAN DESCRIBES
--
--   PLAN.md §5 describes dwell as "consecutive GPS points below a speed
--   threshold, staying within a tolerance, merged across short gaps". That
--   assumes the tracker keeps logging while the vehicle sits. Measured
--   2026-09-16, it does not:
--
--     median gap between pings          5 s
--     90th percentile gap              15 s
--     gaps longer than 5 minutes   25,534
--     ...of those, with <100m of movement  25,491   (99.8%)
--
--   Geotab logs densely while moving and goes quiet while parked. So a stay is
--   encoded mostly as the ABSENCE of pings, and a rule that looks for runs of
--   slow pings would miss nearly all of it. Only 20% of pings are at speed <= 3
--   at all.
--
--   This therefore sessionises on IMPLIED SPEED between consecutive pings:
--   step distance divided by the time it took. A parked vehicle's next ping --
--   whether 6 seconds or 4 hours later -- is in the same place, so the implied
--   speed is ~0 and the stay continues; its duration comes from the timestamps
--   at each end.
--
--   A RAW DISTANCE THRESHOLD DOES NOT WORK HERE AND THE FIRST VERSION OF THIS
--   QUERY USED ONE. With a 150 m step threshold at 5-second ping intervals, a
--   vehicle can travel 108 km/h without ever breaking the run -- 100 km/h is
--   139 m per ping. Entire motorway drives collapsed into single "stays": 90%
--   of the intervals it produced had a spread over 300 m and 100% contained
--   speeds above 15, including one 43-minute "stay" spanning 7.4 km at up to
--   66. Distance per ping is meaningless without the time that produced it.
--
-- THE GUARD THAT REMAINS: a genuine slow crawl in stop-start traffic can still
-- creep under the implied-speed threshold. spread_m -- the distance from the
-- centroid to the furthest ping in the stay -- is emitted so the build step can
-- discard those. It is NOT filtered here, on purpose: a rejected interval
-- should be visible and countable, not silently absent.
--
-- Tunables are inlined rather than parameterised because changing one changes
-- what a "stay" means, and that should be a visible diff, not a flag someone
-- passes differently one day.
--   MOVE_KMH       5   implied speed above which the vehicle is travelling, not
--                      staying. Walking pace; below it, GPS jitter dominates.
--   MAX_GAP_S    21600 6 hours. Beyond this the vehicle is not "staying", it is
--                      parked overnight or the tracker was off; splitting keeps
--                      an overnight out of a working-day dwell.
--   MIN_DWELL_S    300 5 minutes. Below this it is a traffic light, not a visit.
with stepped as (
  select
    device_id,
    date_time,
    latitude,
    longitude,
    speed,
    datediff(second,
             lag(date_time) over (partition by device_id order by date_time),
             date_time) as gap_s,
    sqrt(
      power((latitude  - lag(latitude)  over (partition by device_id order by date_time)) * 111320, 2) +
      power((longitude - lag(longitude) over (partition by device_id order by date_time)) * 111320
            * cos(radians(latitude)), 2)
    ) as step_m
  from razayya_agent_collector.geotab_gps
),
flagged as (
  select *,
         case
           when step_m is null or gap_s is null then 1          -- first ping for this device
           when gap_s > 21600 then 1                            -- overnight / tracker off
           -- Implied speed, km/h. gap_s can be 0 when two pings share a second;
           -- any real movement in zero time is travel, and none is a stay.
           when gap_s = 0 then case when step_m > 25 then 1 else 0 end
           when (step_m / gap_s) * 3.6 > 5 then 1
           else 0
         end as is_new_stay
  from stepped
),
grouped as (
  select *,
         sum(is_new_stay) over (partition by device_id order by date_time
                                rows between unbounded preceding and current row) as stay_id
  from flagged
),
agg as (
  select
    device_id,
    stay_id,
    min(date_time) as arrived_at,
    max(date_time) as departed_at,
    datediff(second, min(date_time), max(date_time)) as dwell_seconds,
    avg(latitude)  as centroid_lat,
    avg(longitude) as centroid_lon,
    count(*)       as ping_count,
    max(speed)     as max_speed
  from grouped
  group by device_id, stay_id
)
select
  a.device_id,
  a.arrived_at,
  a.departed_at,
  round(a.dwell_seconds / 60.0, 1) as dwell_minutes,
  a.centroid_lat,
  a.centroid_lon,
  a.ping_count,
  a.max_speed,
  -- Furthest ping from the centroid. The crawl guard: a real stay is tight,
  -- a chained crawl is not.
  round(max(sqrt(
    power((g.latitude  - a.centroid_lat) * 111320, 2) +
    power((g.longitude - a.centroid_lon) * 111320 * cos(radians(g.latitude)), 2)
  ))) as spread_m
from agg a
join grouped g on g.device_id = a.device_id and g.stay_id = a.stay_id
where a.dwell_seconds >= 300
group by a.device_id, a.arrived_at, a.departed_at, a.dwell_seconds,
         a.centroid_lat, a.centroid_lon, a.ping_count, a.max_speed
order by a.device_id, a.arrived_at;
