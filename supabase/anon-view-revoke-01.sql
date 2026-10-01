-- anon-view-revoke-01.sql
--
-- APPLIED 2026-10-01 against production by operator instruction.
--
-- ===========================================================================
-- WHAT THIS CLOSES
-- ===========================================================================
-- Supabase's advisor flagged public.fraud_stats_dev as a SECURITY DEFINER
-- view. It was right, and it was the mildest instance: 29 of the 31 views in
-- `public` were readable by the `anon` role AND ran with definer rights,
-- because a Postgres view runs as its owner (postgres) unless it carries
-- `security_invoker = on`.
--
-- The base tables are NOT the problem -- they are correctly locked down with
-- RLS enabled and zero policies. The views walked around that. MEASURED as the
-- anon role before this change:
--
--     mt_punch                   (base table)  ->     0 rows   RLS holding
--     mt_punch_detail            (view)        -> 1,385 rows   RLS bypassed
--     maxpass_signups            (base table)  ->     0 rows
--     daily_signups_by_location  (view)        -> 6,607 rows
--     beekeeper_users            (base table)  ->     0 rows
--     mt_field_crew              (view)        ->    12 rows
--
-- What was reachable: customer phone numbers and IP addresses
-- (unsynced_signups), named employee timesheets with start/end times and GPS
-- corroboration (mt_punch_detail), the mechanic roster with cross-system ids
-- (mt_field_crew), and per-location daily revenue (daily_signups_by_location).
--
-- ===========================================================================
-- WHAT IS DELIBERATELY NOT REVOKED
-- ===========================================================================
-- pricing_simple_resolved, v_pricing_by_location and v_pricing_by_location_wide
-- KEEP their anon grant. They are load-bearing public surface:
-- fleet-inquiry-worker and signup-worker read pricing with the ANON key, and
-- they need definer rights precisely because pricing_simple's RLS would
-- otherwise return nothing. Revoking these breaks the public signup and fleet
-- pricing paths. jotform_site_lookup is left alone pending the same check.
--
-- Nothing revoked here has a non-service-key consumer: every worker that reads
-- these views does so with SUPABASE_SERVICE_KEY, which is unaffected.
--
-- ===========================================================================
-- STILL OPEN AFTER THIS
-- ===========================================================================
--  1. `authenticated` retains SELECT on all 29. That role is every operator
--     who signs in, so a GM holding their own access token can still read
--     every mt_* view straight off PostgREST, bypassing the permission gates
--     the workers enforce. Arguably a sharper risk than anon, because those
--     tokens certainly exist and are held by dozens of staff.
--  2. location_daily_live was not in the operator's list and is untouched.
--  3. suspicious_phones_dev is a TABLE (RLS on, 2 policies), not a view, so it
--     is out of scope here.
--  4. The durable fix is `security_invoker = on` plus real RLS policies for
--     the public pricing path. That is a larger change and needs the policies
--     written first; this revoke is the containment step.
--
-- REVERSIBLE: `grant select on public.<view> to anon;` restores any row below.

begin;

-- Maintenance tracker: named employees, punches, GPS, cost.
revoke select on public.mt_cost_centre_month      from anon;
revoke select on public.mt_cost_day               from anon;
revoke select on public.mt_device_health          from anon;
revoke select on public.mt_field_crew             from anon;
revoke select on public.mt_job_site               from anon;
revoke select on public.mt_mechanic_day           from anon;
revoke select on public.mt_mechanic_week          from anon;
revoke select on public.mt_mechanic_workload      from anon;
revoke select on public.mt_offsite_time           from anon;
revoke select on public.mt_punch_allocation       from anon;
revoke select on public.mt_punch_detail           from anon;
revoke select on public.mt_punch_kind             from anon;
revoke select on public.mt_punch_out_of_footprint from anon;
revoke select on public.mt_site_month             from anon;
revoke select on public.mt_site_name              from anon;
revoke select on public.mt_site_work_orders       from anon;
revoke select on public.mt_work_attribution       from anon;

-- Customer signups: phone numbers, IP addresses, per-location revenue.
revoke select on public.daily_signups_by_location from anon;
revoke select on public.unsynced_signups          from anon;

-- Greeter scorecard.
revoke select on public.greeter_daily_live        from anon;

-- SDS inventory.
revoke select on public.sds_inventory_candidates  from anon;
revoke select on public.sds_inventory_products    from anon;

-- Dev leftovers living in production. Deletion candidates in their own right.
revoke select on public.fraud_stats_dev           from anon;
revoke select on public.recent_warnings_dev       from anon;

commit;
