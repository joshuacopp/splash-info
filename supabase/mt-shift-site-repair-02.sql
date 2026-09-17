-- mt-shift-site-repair-02.sql
--
-- Repairs mt_shift_site, and removes the defect that destroyed it.
--
-- ===========================================================================
-- WHAT HAPPENED
-- ===========================================================================
-- The refresh re-derived mt_shift_site with this statement (refresh.ps1,
-- emitted to work/shift_site.sql):
--
--     update mt_shift_site s
--        set confidence = ..., site_number = x.site_number, derived_at = now()
--       from mt_connecteam_job_site x
--      where x.site_number is not null
--        and s.site_number is distinct from x.site_number;
--
-- THERE IS NO JOIN CONDITION BETWEEN s AND x. mt_shift_site had no job_id
-- column, so there was nothing to join on and nothing to notice: the statement
-- parses, runs, reports a row count, and the refresh logs OK. It is a CROSS
-- JOIN whose only filter is "the sites differ", so every shift matches some
-- crosswalk row with a different site and Postgres picks one arbitrarily.
--
-- Measured before this repair: all 1,723 shifts carried site_number 125
-- (Cicero) and confidence 'W'. One site, one grade, for every shift on record.
-- The run that did it is stamped 2026-09-17 11:42 and reported last_status OK.
--
-- WHY THE DASHBOARD NUMBERS WERE STILL RIGHT, WHICH IS WHY IT WENT UNSEEN
--   mt_site_month and mt_cost_centre_month attribute on g.matched_site_number
--   -- where the VEHICLE was, from GPS -- and never read billed_site. They
--   were unaffected.
--   mt_mechanic_week does read the allocation, but only as the SUMS
--   (onsite_billed_min + onsite_other_min) and
--   (billable_travel_min + other_site_travel_min). Those totals are invariant
--   to how the split is drawn, so they were right too.
--   Nothing else reads billed_site at all. So every published figure held
--   while the column underneath them was a constant -- a reminder that a
--   correct-looking dashboard is not evidence that its inputs are correct.
--
-- WHAT WAS ACTUALLY LOST: billed_site is the CLAIM -- the site the punch says
-- the mechanic was at. Comparing it to GPS is the entire verification purpose
-- of this tracker. With it pinned to one value that comparison was dead, and
-- silently: it would have reported every mechanic as off-site except at
-- Cicero, had anything been reading it yet.
--
-- ===========================================================================
-- THE FIX: STORE THE KEY, AND STOP MAINTAINING BY UPDATE
-- ===========================================================================
-- Root cause is that mt_shift_site is derived from (shift -> job -> site)
-- while storing only the last term. The shift -> job link lived exclusively in
-- Redshift raw_json, so no correct statement could have been written against
-- the table as it stood.
--
-- mt_shift_job now holds that link in Supabase, exported from Redshift each
-- run alongside punches and dwell (queries/30_shift_job.sql, READ-ONLY).
-- mt_shift_site gains job_id and is rebuilt by insert-on-conflict from the
-- join, never by a bare update.
--
-- SECOND DEFECT, FIXED BY THE SAME CHANGE: the old statement was an UPDATE and
-- nothing else. It had no insert path, so mt_shift_site could never acquire a
-- shift it did not already have -- frozen at the 1,723 rows of the first
-- build, while punches kept arriving. New shifts would have stayed
-- unattributed forever with no error anywhere.
--
-- A view over mt_shift_job x mt_connecteam_job_site would remove the class
-- entirely and is the better design. It is not taken here because five views
-- depend on this relation (mt_punch_allocation, and mt_cost_centre_month /
-- mt_mechanic_week / mt_offsite_time / mt_site_month above it); converting a
-- table to a view means dropping and recreating all of them, which is a larger
-- change than the bug warrants. Worth doing the next time that stack is
-- touched for another reason.

alter table public.mt_shift_site add column if not exists job_id text;

-- Rebuild. Rows are keyed by shift, and the site/confidence come from the
-- job's crosswalk entry -- the join that was missing.
insert into public.mt_shift_site (shift_id, job_id, site_number, confidence, derived_at)
select j.shift_id, j.job_id, x.site_number,
       case x.confidence
         when 'CONFIDENT'      then 'C'
         when 'LIKELY'         then 'L'
         when 'WEAK'           then 'W'
         when 'TOO_FEW_SHIFTS' then 'F'
         else 'I' end,
       now()
from mt_shift_job j
join mt_connecteam_job_site x on x.job_id = j.job_id
join mt_punch p on p.shift_id = j.shift_id
on conflict (shift_id) do update
   set job_id      = excluded.job_id,
       site_number = excluded.site_number,
       confidence  = excluded.confidence,
       derived_at  = excluded.derived_at;

-- Expected after repair (measured 2026-09-17, 1,723 rows):
--   C  838 shifts  39 sites     <- fit for cost attribution
--   L   26 shifts   4 sites     <- fit for cost attribution
--   W  283 shifts  13 sites
--   F  166 shifts  31 sites
--   I  410 shifts  10 sites
-- Any future run that produces ONE distinct site is this bug again.
