-- mt-cost-centre-month-01.sql
--
-- OPERATOR DECISION, 2026-09-17: the end-of-day drive home is OVERHEAD and is
-- charged to MANAGEMENT, not to the last site worked.
--
-- This view is that decision made concrete. Every paid mechanic hour lands in
-- exactly one cost centre per month, and the three kinds sum to 100% of paid
-- time -- nothing falls off the edge, which is the whole point of a cost
-- allocation as opposed to a report.
--
--   SITE          on-site time plus the inbound leg, charged to the site the
--                 vehicle ACTUALLY touched. The destination pays.
--   MANAGEMENT    travel on a leg terminating at no known site. Mostly the
--                 drive home; also parts counters and anywhere without a
--                 geofence.
--   UNATTRIBUTED  stationary somewhere that is not a Splash site, plus time
--                 the device reported nothing for.
--
-- MEASURED 2026-09-17, 1,178 crew punches:
--
--   SITE          2,225 h   48.6%
--   UNATTRIBUTED  1,392 h   30.4%
--   MANAGEMENT      962 h   21.0%
--   -------------------------------
--   TOTAL         4,579 h  100.0%   = paid hours, to the hour
--
-- WHY UNATTRIBUTED IS NOT FOLDED INTO MANAGEMENT
--   It would be tidier and it would be wrong. A lunch stop, a parts counter
--   with no geofence, and a two-hour hole where the tracker reported nothing
--   are three different things, and only the middle one is arguably
--   management overhead. Folding them in would grow Management from 21% to
--   51% and bury a data-quality problem inside a cost centre, where nobody
--   would ever look for it again. At 30.4% it is the largest single thing this
--   pipeline does not yet explain, and it should stay visible until it shrinks.
--
--   The two halves want different fixes: the 849 h of stationary-not-at-a-site
--   needs more geofences (parts suppliers, the shop, wherever crews actually
--   stop), and the 544 h of no-GPS needs the device gaps chased.
--
-- THIS IS NOT WHAT THE SITES ARE CHARGED TODAY
--   The overhead job exists in Connecteam but is not being punched (see
--   mt-connecteam-job-site-01.sql), so that 962 h currently sits on whichever
--   site was worked last. This view is the post-decision picture. Moving the
--   books to match it is a separate act, and the gap between the two is
--   precisely 962 hours of site charges.
--
-- Hours here are a CEILING on productive time, never evidence of it.

create or replace view public.mt_cost_centre_month as
with a as (select *, date_trunc('month', start_utc)::date mth from mt_punch_allocation)
select s.month,
       'SITE'::text                     as kind,
       s.site_number,
       ('Site ' || s.site_number)::text as cost_centre,
       s.onsite_h,
       s.inbound_travel_h               as travel_h,
       s.total_h                        as hours
from mt_site_month s
union all
select a.mth, 'MANAGEMENT', null, 'Management',
       0::numeric,
       round(sum(a.overhead_travel_min)/60, 1),
       round(sum(a.overhead_travel_min)/60, 1)
from a group by a.mth
union all
select a.mth, 'UNATTRIBUTED', null, 'Unattributed',
       round(sum(a.unaccounted_min)/60, 1),
       0::numeric,
       round(sum(a.unaccounted_min + a.no_gps_min)/60, 1)
from a group by a.mth;
