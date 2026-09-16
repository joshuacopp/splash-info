-- mt-work-attribution-01.sql  --  Phase 3, Layer C
--
-- One row per (reactive work order, mechanic who logged time on it), with the
-- field evidence that the mechanic was actually there. Creates a VIEW: no data
-- is written, and the tiers recompute as the event log accumulates.
--
-- ============================================================================
-- THE MEASUREMENT THAT DETERMINED THIS DESIGN, AND WHY IT INVERTS THE PLAN
-- ============================================================================
-- PLAN.md 7 makes the IN_PROGRESS interval the "backbone" of Layer C and calls
-- the GPS dwell match a "day-granularity fallback for historical periods".
-- Measured over the punch window on 2026-09-16, that is backwards.
--
-- Each candidate signal was tested against a NULL MODEL built by re-running it
-- with the WRONG mechanic: take the same work orders, ask the same question of
-- all 13 crew members, and compare the true pairing against the other twelve.
-- That controls for time of day, which a naive base rate does not -- work
-- orders are completed during business hours, when most mechanics are on the
-- clock, so "was he clocked in?" is nearly free.
--
--   signal                              coverage   true    false    lift
--   completed while clocked in            92.7%    92.7%   57.6%     1.6x
--   GPS dwell at the work order's site     46.5%    46.5%    0.9%      52x
--
-- TEMPORAL OVERLAP IS NOT ATTRIBUTION. It is satisfied by more than half of
-- randomly assigned mechanics, so on its own it can confirm almost nothing.
-- Presence at the work order's own site is all but conclusive: a 0.9% false
-- positive floor. Anybody tempted to simplify this view by dropping the dwell
-- join should read those two rows again -- the result would look almost
-- identical (92.7% "matched"!) and mean nothing.
--
-- The IN_PROGRESS interval is not weak, it is ABSENT: 2.3% of the cohort,
-- because mx_work_order_event only began retaining on 2026-09-14. It should
-- grow, and the tier exists so that it can.
--
-- ============================================================================
-- WHAT THE TIERS DO NOT MEAN
-- ============================================================================
-- PUNCH_ONLY IS NOT A FINDING ABOUT A MECHANIC. PLAN.md 9 records that some
-- reactive work orders are resolved by phone without anyone leaving, and others
-- are administrative cleanup of stale records. Neither should produce a site
-- visit and neither is a failure of anything. A mechanic can also be at a
-- genuinely-visited site that we geocoded rather than verified, or in a vehicle
-- that is not theirs. Read PUNCH_ONLY as "GPS did not independently place this
-- person here", never as "this person was not here".
--
-- One thing was checked before shipping these tiers, because it would have made
-- them dishonest: whether some mechanics simply have no Geotab device, so their
-- work could never reach GPS_CONFIRMED. All 8 mechanics appearing in the window
-- have dwell intervals (41 to 442 each), so the tier separates evidence from
-- absence of evidence rather than instrumented from uninstrumented. If a 14th
-- crew member is added WITHOUT a device, that stops being true and this view
-- needs a NOT_INSTRUMENTED tier before anyone reads a rate off it.
--
-- The +/- 12 hour window on the dwell join is a parameter, not a discovery. The
-- 46.5%/0.9% figures above were measured at that value.
--
-- SCOPE: completed_at outside 2026-07-11..2026-09-16 cannot be attributed at
-- all -- Connecteam punches do not exist before that. 440 rows and 1,669 logged
-- hours sit outside it. They are in the view, and they are not a tier.

create or replace view public.mt_work_attribution as
with crew as (
  select maintainx_user_id, connecteam_user_id, device_id
  from mt_device_person where maintainx_user_id is not null),
base as (
  select w.id work_order_id, w.mx_location_id, w.completed_at, w.status,
         c.connecteam_user_id, c.maintainx_user_id, c.device_id,
         l.site_number,
         sum(t.duration_total_seconds) logged_seconds
  from mx_work_order w
  join mx_work_order_time_item t on t.work_order_id = w.id
  join crew c on c.maintainx_user_id = t.user_id
  left join public.locations l on l.maintainx_id = w.mx_location_id
  where w.type = 'REACTIVE' and w.deleted_at is null and w.completed_at is not null
  group by 1,2,3,4,5,6,7,8)
select b.*,
  p.shift_id                 as punch_shift_id,
  p.duration_minutes         as punch_minutes,
  g.dwell_minutes            as site_dwell_minutes,
  (g.id is not null)         as gps_at_site,
  (p.shift_id is not null)   as completed_while_clocked_in,
  exists (select 1 from mx_work_order_event e
           where e.work_order_id = b.work_order_id
             and e.event_type = 'STATUS_CHANGE'
             and (e.new_value->>'status' = 'IN_PROGRESS' or e.old_value->>'status' = 'IN_PROGRESS')
             -- user 520201 is "MX Friendly Integration Bot". A bot transition
             -- is not a mechanic flipping a toggle; 100 of 750 status changes
             -- are its work and must not count as evidence of a human on site.
             and coalesce(e.actor_user_id, 0) <> 520201) as has_inprogress_event,
  case
    when g.id is not null then 'GPS_CONFIRMED'
    when exists (select 1 from mx_work_order_event e
                  where e.work_order_id = b.work_order_id
                    and e.event_type='STATUS_CHANGE'
                    and (e.new_value->>'status'='IN_PROGRESS' or e.old_value->>'status'='IN_PROGRESS')
                    and coalesce(e.actor_user_id,0) <> 520201) then 'INTERVAL_ONLY'
    when p.shift_id is not null then 'PUNCH_ONLY'
    else 'WO_NO_FIELD_EVIDENCE'
  end as evidence_tier
from base b
left join lateral (
  select pp.shift_id, pp.duration_minutes from mt_punch pp
   where pp.connecteam_user_id = b.connecteam_user_id
     and b.completed_at between pp.start_utc and pp.end_utc
   order by pp.start_utc limit 1) p on true
left join lateral (
  select gg.id, gg.dwell_minutes from mt_gps_dwell gg
   where gg.device_id = b.device_id and gg.within_geofence
     and gg.matched_site_number = b.site_number
     and gg.arrived_at  <= b.completed_at + interval '12 hours'
     and gg.departed_at >= b.completed_at - interval '12 hours'
   order by gg.dwell_minutes desc limit 1) g on true;

comment on view public.mt_work_attribution is
'Phase 3 / Layer C. Reactive work orders with mechanic-logged time, tiered by
the strength of the field evidence placing that mechanic at that site.
GPS_CONFIRMED has a measured 0.9% false-positive floor; PUNCH_ONLY has a 57.6%
one and is NOT confirmation of anything. PUNCH_ONLY is not a finding about a
mechanic -- see the header of supabase/mt-work-attribution-01.sql.';

-- OBSERVED 2026-09-16, completed_at within 2026-07-11..09-16 (342 rows,
-- 1,323 logged hours, 8 mechanics):
--   GPS_CONFIRMED         155  45.3%   476 h   6 mechanics
--   PUNCH_ONLY            160  46.8%   694 h   7 mechanics
--   WO_NO_FIELD_EVIDENCE   19   5.6%   141 h   5 mechanics
--   INTERVAL_ONLY           8   2.3%    12 h   4 mechanics
-- Plus 440 rows / 1,669 h completed before Connecteam data begins.
