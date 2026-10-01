-- anon-view-revoke-02.sql
--
-- APPLIED 2026-10-01 against production by operator instruction.
-- Follows anon-view-revoke-01.sql, which closed 24 of the 29 anon-readable
-- SECURITY DEFINER views. This closes a 25th that was not in that round's list.
--
-- WHAT location_daily_live CARRIES
--
--   Per site per day: total_cars, wash_sales, package_dollars, extras_dollars,
--   sign_ups, labor_budget, revenue_goal, labor/revenue trends, total_members,
--   churn_pct, reactivations, google_reviews -- plus created_by_email,
--   updated_by_email and voided_by_email. Effectively the company's daily
--   operating P&L by location, readable with nothing but the anon key.
--
-- WHY THIS IS SAFE
--
--   No code path reads it through PostgREST. Every reference in the repo is
--   either a comment or goes through a Postgres function (greeter_missing_days
--   and the greeter rollups read it server-side), and a function executes with
--   its own rights rather than the caller's grant. The workers that touch the
--   greeter surface use SUPABASE_SERVICE_KEY, which is unaffected.
--
-- STILL ANON-READABLE AFTER THIS, deliberately:
--
--   pricing_simple_resolved, v_pricing_by_location, v_pricing_by_location_wide
--     -- load-bearing public surface; fleet-inquiry-worker and signup-worker
--     read pricing with the ANON key and need definer rights because
--     pricing_simple's RLS would otherwise return nothing.
--
--   jotform_site_lookup -- HELD, not cleared. It exposes area_manager,
--     am_email, regional_manager, rm_email, general_manager,
--     general_manager_email, hrt_email and site_email for every site: a
--     complete internal management email directory. It has ZERO references in
--     this repo, which suggests an external consumer (a JotForm prefill or a
--     Power Automate flow) may read it with the anon key. Revoking blind could
--     break that silently, so it needs confirmation first. It should not stay
--     this way.
--
-- REVERSIBLE: `grant select on public.location_daily_live to anon;`

begin;

revoke select on public.location_daily_live from anon;

commit;
