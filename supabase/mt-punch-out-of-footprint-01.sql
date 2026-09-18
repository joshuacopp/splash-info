-- UNITS: distances in these comments are MILES and FEET, which is what the
-- operator reads. Stored values stay metric (locations.geofence_radius_m, and
-- the metre arithmetic in the equirectangular distance formula) and are given
-- in parentheses where a comment quotes one, so the prose still ties to the
-- code. The raw data has no units at all -- Geotab supplies degrees.
-- mt-punch-out-of-footprint-01.sql
--
-- Records the Connecteam punches whose phone coordinates sit far outside the
-- Splash footprint. It CREATES A VIEW AND CHANGES NO DATA. Nothing in mt_punch
-- is corrected, deleted or flagged: these rows are recorded as they exist.
--
-- WHY A VIEW AND NOT A COLUMN
--   A boolean column called something like `is_anomalous` would freeze one
--   person's judgement into the table and invite every later reader to treat it
--   as a finding. Distance from the nearest site is a measurement; "anomalous"
--   is a conclusion. The view carries the measurement and the threshold is
--   visible in one place where it can be argued with.
--
-- THE THRESHOLD IS A ROUND NUMBER, NOT A DISCOVERY
--   31 miles (stored as 50,000 m -- in_distance_m is metres). The distance
--   distribution has no natural cliff -- 473 punches are
--   within 1,000 ft of a site, 1,003 within 3 miles, 585 within 31 miles, and
--   then it thins to 94. 31 miles is simply "further than a mechanic plausibly drives
--   between a Splash site and the next one". Move it if that is wrong.
--
-- WHAT THIS IS NOT EVIDENCE OF
--   Not timesheet fraud. Not location spoofing. Not anything, on its own. The
--   rows below include at least one person who appears to live and work
--   remotely, two mechanics who drove out of the footprint on the same day and
--   worked the same four days in the same distant place (which reads far more
--   like a trip somebody authorised than like two people faking one city),
--   and a batch of single-day entries in holiday regions during summer.
--   Read them before concluding.

create or replace view public.mt_punch_out_of_footprint as
select p.shift_id,
       p.connecteam_user_id,
       p.is_mechanic,
       p.start_utc,
       p.end_utc,
       p.duration_minutes,
       p.timezone,
       p.source_type,
       p.in_lat,  p.in_lon,  p.in_distance_m,
       p.out_lat, p.out_lon, p.out_distance_m,
       greatest(coalesce(p.in_distance_m, 0),
                coalesce(p.out_distance_m, 0)) as furthest_m
  from public.mt_punch p
 -- 50,000 m = 31 miles. The threshold stays in metres because the column is
 -- metres; converting it here would change which punches are flagged.
 where p.in_distance_m  > 50000
    or p.out_distance_m > 50000;

comment on view public.mt_punch_out_of_footprint is
'Punches whose phone coordinates are more than 31 miles from the nearest Splash
site, recorded as they exist. NOT a fraud signal -- see the header of
supabase/mt-punch-out-of-footprint-01.sql before drawing any conclusion.
Rows with no coordinates at all (544 of 2,699, almost all source_type=admin)
can never appear here: absence of a location is not distance from one.';

-- ---------------------------------------------------------------------------
-- OBSERVED STATE at 2026-09-16, over the full load (2,699 shifts, 2026-07-11
-- to 2026-09-16). Recorded so a later reader can tell whether something moved.
-- People are identified by connecteam_user_id only -- names stay out of the
-- repo, which is why PLAN.md is gitignored.
--
--   97 rows: 94 by punch-in, plus 3 more where only the CLOCK-OUT was distant.
--   11 distinct people. 11 mechanic shifts, by just 3 mechanics.
--
--   users 13333061 and 9611831  BOTH MECHANICS  10 shifts  2026-08-23..08-27
--     THE CLEAREST THING IN THIS VIEW, and it only reads correctly if you
--     include the clock-out side. On 2026-08-23 both clocked IN near a
--     Splash site -- 2.5 and 17 miles -- and clocked OUT at ~41.6 N, -93.8 W
--     (Des Moines, Iowa area), 780 miles away, after 668 and 728 minutes. That
--     is a shift whose length IS the drive. They then worked 2026-08-24..08-27
--     from the same Iowa coordinates, 591-840 minutes a day, and these 10
--     shifts are 10 of the 11 mechanic shifts in this view.
--     Two people, one origin, one destination, one set of dates. That is a
--     trip somebody scheduled, not two people independently faking Iowa.
--     A distance filter alone would have shown the 8 Iowa days and hidden the
--     travel day that explains them -- which is the whole argument for
--     recording these rows rather than scoring them.
--
--   user 16191076  not a mechanic  56 shifts  2026-07-11..09-16
--     South Florida (~25.7-26.7 N, -80.1 to -81.0), plus single days near
--     Savannah GA and in Virginia. Spans the ENTIRE window, ~117 min average,
--     consistently. A person who is simply not in New York looks exactly like
--     this. Nothing episodic about it.
--
--   user 2217720  not a mechanic  17 shifts  2026-08-04..09-15
--     Three separate clusters: Pennsylvania (Allentown / Harrisburg area,
--     Aug 4-6), Indiana (~39.9 N, -86.3 W, Aug 11-14, 9 shifts), Illinois
--     (~42.4 N, -87.9 W, Sep 15). Moves around; each cluster is contiguous.
--
--   user 19146811  not a mechanic  1 shift  2026-09-16
--     Honolulu (21.3 N, -157.8 W), 5,305 miles, 121 min. A single day, and the
--     day this was recorded.
--
--   remaining singles/pairs: Maine (~44.4,-68.2), Vermont/NH border
--     (~42.9,-72.9), Adirondacks (~43.8,-73.8), New Jersey (~40.8,-74.5),
--     Rhode Island (~41.6,-71.7 -- 52 miles, a mechanic), the Carolinas.
--     Mostly one day each, mostly summer.
--
-- THE TIMEZONE COLUMN IS NOT AN INDEPENDENT CHECK ON THE COORDINATES.
--   It tracks the device, so it usually just restates where the phone was --
--   Florida punches read America/New_York because Florida IS Eastern. It also
--   disagrees with itself: user 9611831 punched from the same Iowa coordinates
--   as America/Chicago on 8/24-8/26 and America/New_York on 8/27. Do not treat
--   a non-Eastern timezone as a signal, and do not treat an Eastern one as
--   reassurance. 2,680 of 2,699 shifts say America/New_York including every
--   one of the 1,003 mile Florida punches.
