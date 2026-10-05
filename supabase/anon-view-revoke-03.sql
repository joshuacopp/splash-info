-- anon-view-revoke-03.sql
--
-- APPLIED 2026-10-05 against production by operator instruction (migration
-- `anon_view_revoke_03`). An earlier header here claimed it was applied
-- 2026-10-02; a live check on 2026-10-05 (SB-sec.md H1) showed none of it had
-- landed. Verified after applying: 25 views security_invoker, authenticated
-- reads none of them, the 7 functions are service_role-only, both _dev views
-- gone, jotform_site_lookup still anon-readable (84 rows) for the JotForm widget.
-- The durable fix that anon-view-revoke-01.sql called "STILL OPEN" item 4, plus
-- item 1 (the `authenticated` grant). Supersedes the untracked
-- supabase/_phase1_ddl.txt draft, which was never applied -- and which would
-- have broken every login had it been, because it included auth_unified.
--
-- ===========================================================================
-- WHAT THIS DOES
-- ===========================================================================
--  1. security_invoker = on for 25 views, so they enforce the CALLER's grants
--     and RLS instead of running as their owner (postgres). Base tables carry
--     RLS with zero policies, so anon/authenticated now get nothing even if a
--     grant reappears.
--  2. Revokes SELECT from `authenticated` on the same 25. Every signed-in
--     operator holds an access token; with it they could read every mt_* view,
--     unsynced_signups and the daily P&L straight off PostgREST, skipping every
--     permission gate the workers enforce.
--  3. Revokes EXECUTE from PUBLIC/anon/authenticated on the 7 greeter/location
--     functions that read these views. They are SECURITY INVOKER (they run with
--     the CALLER's rights, not their own -- anon-view-revoke-02's note saying
--     otherwise was wrong) and were callable over /rest/v1/rpc by anyone,
--     including greeter_restamp_goals and site_restamp_monthly_targets, which
--     write. service_role keeps an explicit grant.
--  4. Drops fraud_stats_dev and recent_warnings_dev: dev leftovers in
--     production, no dependents, no repo references. Definitions below.
--
-- ===========================================================================
-- WHY NOTHING BREAKS (checked 2026-10-02)
-- ===========================================================================
--  - No code queries PostgREST as `authenticated`. createAnonClient() in
--    @splash/db-supabase has zero callers; @splash/auth's user-token calls all
--    hit /auth/v1/*, never /rest/v1/*; apps/inventory's browser client is a
--    throwing stub. Every worker reads with SUPABASE_SERVICE_KEY.
--  - service_role holds SELECT on every base table under these 25 views
--    (verified via pg_depend), so invoker rights still resolve for workers.
--  - All 7 functions are called only through the service client
--    (packages/db-supabase/src/greeter.ts).
--
-- ===========================================================================
-- DELIBERATELY LEFT AS DEFINER VIEWS
-- ===========================================================================
--  auth_unified          -- reads auth.users, on which service_role has NO
--                           SELECT. As invoker, getAuthContext() fails and
--                           nobody can log in. Not granted to anon or
--                           authenticated, so definer rights are not exposed.
--  pricing_simple_resolved -- anon-read by signup-worker and fleet; needs
--                           definer rights past pricing_simple's RLS.
--  jotform_site_lookup   -- anon-read by the JotForm prefill widget (operator
--                           confirmed 2026-10-02). Still exposes the whole
--                           management email directory; narrowing it to the
--                           columns the widget uses is the next step.
--
-- REVERSIBLE: `alter view ... set (security_invoker = off)`, `grant select on
-- ... to authenticated`, `grant execute on function ... to authenticated`.
-- Dropped view definitions:
--   create view public.fraud_stats_dev as
--     select tier, count(*) as count, avg(usage_count) as avg_usage
--     from suspicious_phones_dev group by tier order by tier;
--   create view public.recent_warnings_dev as
--     select phone, phone_formatted, location_pretty, action_taken,
--            user_response, "timestamp"
--     from phone_usage_log_dev
--     where tier = any (array['Warn'::text, 'Monitor'::text])
--     order by "timestamp" desc limit 50;

begin;

-- 1 + 2: invoker rights, and no authenticated grant.
do $$
declare
  v text;
  views text[] := array[
    'daily_signups_by_location', 'greeter_daily_live', 'location_daily_live',
    'mt_cost_centre_month', 'mt_cost_day', 'mt_device_health', 'mt_field_crew',
    'mt_job_site', 'mt_mechanic_day', 'mt_mechanic_week', 'mt_mechanic_workload',
    'mt_offsite_time', 'mt_punch_allocation', 'mt_punch_detail', 'mt_punch_kind',
    'mt_punch_out_of_footprint', 'mt_site_month', 'mt_site_name',
    'mt_site_work_orders', 'mt_work_attribution',
    'sds_inventory_candidates', 'sds_inventory_products', 'unsynced_signups',
    'v_pricing_by_location', 'v_pricing_by_location_wide'
  ];
begin
  foreach v in array views loop
    execute format('alter view public.%I set (security_invoker = on)', v);
    execute format('revoke select on public.%I from anon, authenticated', v);
  end loop;
end $$;

-- 3: the invoker functions are service-role only.
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'greeter_missing_days', 'greeter_period_report', 'greeter_restamp_goals',
      'greeter_rollup', 'greeter_scan_rates', 'location_period_rows',
      'site_restamp_monthly_targets')
  loop
    execute format('grant execute on function %s to service_role', f);
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- 4: dev leftovers.
drop view public.fraud_stats_dev;
drop view public.recent_warnings_dev;

commit;
