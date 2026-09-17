-- mt-connecteam-job-site-01.sql
--
-- Recovers the Connecteam jobId -> Splash site crosswalk WITHOUT API access.
--
-- WHY THIS EXISTS
--   Phase 3b (PLAN.md 8) allocates each punch's cost to a site. Nothing in the
--   warehouse records which site a punch is billed to: connecteam_shifts.site_id
--   is the constant 'splash' (a tenant tag), connecteam_timesheets has no site
--   column, and the only site-bearing field is raw_json.jobId -- a UUID, with no
--   jobs table in Redshift to resolve it. The operator confirmed the naming
--   convention (a job is generally a site name; a sub-job is "site name +
--   project") but has lost the API access that would list them. So the mapping
--   is recovered from behaviour instead.
--
-- THE METHOD, AND THE ONE THAT DID NOT WORK
--   FIRST ATTEMPT, DISCARDED: nearest site to the PUNCH-OUT coordinate, on the
--   PLAN.md 8 reading that a mechanic "punches out of that location" when the
--   work is done. It gives 41% modal agreement on the busiest job and 0-1
--   punches inside a fence on the top three. A punch-out happens wherever the
--   mechanic chained one punch into the next -- roadside, at home, mid-drive --
--   not at the site whose work just finished. Only ~20% of punch-outs are
--   inside any fence at all.
--
--   WHAT WORKS: where the VEHICLE SAT during the shift. Per shift, the site
--   whose fence holds the longest residence; per job, the modal site across
--   shifts. Same jobs, same window: 100 / 96 / 94 / 93% modal agreement.
--
--   Residence is the SPAN between first and last ping inside the fence, never
--   the ping COUNT. Geotab goes quiet while parked (Layer B header: 25,491 of
--   25,534 gaps over 5 minutes involve under 100 m of movement), so a 3-hour
--   stay can be two pings while a drive-past at 5-second intervals is dozens.
--   Counting pings ranks the drive-past first. This is the same trap the dwell
--   sessionisation hit from the other direction.
--
-- CORROBORATION THE METHOD WAS NOT FITTED TO
--   Restricted to CONFIDENT+LIKELY, 45 jobs map to 41 distinct sites, and the
--   four sites reached by more than one job are reached by EXACTLY two. That is
--   the "site" + "site project" sub-job pattern the operator described, and
--   nothing in the derivation was told to look for it or could have produced it
--   by construction -- a noise-fitting method would scatter 1,3,5 across sites.
--
-- CIRCULARITY -- READ BEFORE USING THIS FOR COMPLIANCE
--   This crosswalk is derived FROM GPS. "Did the mechanic's GPS match the job's
--   site?" is therefore NOT an independent test of a billing claim: the shift
--   under test helped decide what the job's site is. For per-shift checks,
--   recompute the modal site EXCLUDING that shift (leave-one-out). With 28
--   shifts on the busiest job the difference is small; with 3 it is the whole
--   answer.
--
-- COVERAGE IS PART OF THE OUTPUT, NOT A FOOTNOTE
--   CONFIDENT      41 jobs  503 shifts  (65%)   >=5 shifts, >=80% modal
--   LIKELY          4 jobs   12 shifts  ( 2%)   3-4 shifts, >=80% modal
--   WEAK           13 jobs  125 shifts  (16%)   >=5 shifts, 60-79% modal
--   TOO_FEW_SHIFTS 38 jobs   56 shifts  ( 7%)   1-2 shifts
--   INCONSISTENT   10 jobs   75 shifts  (10%)   spread across sites
--   Only CONFIDENT and LIKELY are fit for cost attribution. The rest are stored
--   rather than dropped so the gap is visible: a crosswalk that silently omits
--   a third of shifts will be read as complete.
--
--   Jobs never worked by one of the 13 crew vehicles cannot appear at all --
--   150 jobIds exist on shifts, 106 are seen here. Absence is absence of GPS,
--   not evidence the job is not a site.
--
-- REFRESH: re-run apps/maintenance-tracker/queries/30_job_site.sql (READ-ONLY,
-- Redshift) and re-apply the insert. Confidence rises as shifts accumulate.

create table if not exists public.mt_connecteam_job_site (
  job_id          text primary key,
  site_number     integer not null,
  confidence      text not null check (confidence in
                    ('CONFIDENT','LIKELY','WEAK','TOO_FEW_SHIFTS','INCONSISTENT')),
  shifts_observed integer not null,
  modal_pct       integer not null,
  distinct_sites  integer not null,
  derived_at      timestamptz not null default now()
);
alter table public.mt_connecteam_job_site enable row level security;

-- Row data is generated; see queries/30_job_site.sql and the insert applied
-- 2026-09-17 (106 rows). Not reproduced here -- it is derived, not source.

-- ===========================================================================
-- THE OVERHEAD ("travel home at end of day") JOB -- LOOKED FOR, NOT FOUND IN USE
-- ===========================================================================
-- The operator states there is an overhead job for the drive home, punched on
-- leaving the last site of the day. Three tests were run to find it, and the
-- answer matters for PLAN.md 8's overhead-travel bucket.
--
--   1. Jobs whose vehicle never enters any fence. Only two qualify, at 12 and
--      7 crew shifts. Far too small to be a company-wide end-of-day habit
--      (13 mechanics x ~45 working days would be hundreds).
--
--   2. Jobs that are the last punch of the day. FIRST ATTEMPT WAS CONFOUNDED
--      and is recorded so it is not repeated: several jobs score 95-100%
--      last-of-day, but their avg_punches_that_day is 1 -- on a single-punch
--      day "last" is also "first" and the test is a tautology. Restricted to
--      days with 2+ punches the field flattens to a 56% maximum and NO job
--      stands out as an end-of-day job.
--
--   3. So where does the drive home live? Crew shifts, multi-punch days:
--
--        earlier punches        565 punches   43% end inside a fence   174 min
--        LAST punch of the day  284 punches    4% end inside a fence   250 min
--
--      The last punch of the day almost never ends at a Splash site, and runs
--      ~76 minutes longer than the others -- about a commute.
--
-- CONCLUSION: the overhead job is a convention that is not being punched. The
-- drive home is absorbed into the TAIL OF THE LAST SITE PUNCH, so it is
-- currently billed to that site rather than to overhead.
--
-- This does not block PLAN.md 8 -- it is the reason 8 defines the buckets by
-- where a leg TERMINATES rather than by what the punch claims. Overhead travel
-- is recoverable from GPS alone: the trailing movement of a punch that ends
-- outside every fence. It also predicts the bucket will be substantial, since
-- 96% of last punches qualify, and 8 already says so: "thirteen mechanics each
-- ending a day somewhere that is not a car wash is thirteen legs a day".
--
-- WHAT NOT TO DO WITH THIS. It is a finding about a punching convention, not
-- about any mechanic. Nobody is over-billing a site on purpose by failing to
-- switch jobs at the end of the day, and the sites' current charges reflect
-- the convention as practised. Moving that time to overhead changes what each
-- site is charged, so it is a decision for the operator, not a correction the
-- tracker should apply silently.
