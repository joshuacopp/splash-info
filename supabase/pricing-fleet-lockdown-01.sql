-- pricing-fleet-lockdown-01.sql
--
-- APPLIED 2026-10-05 against production by operator instruction. SB-sec.md
-- findings M1 (pricing_simple half), M2 and M4.
--
-- ===========================================================================
-- WHAT THIS DOES
-- ===========================================================================
--  pricing_simple:
--    - drops "Public can read pricing_simple" (anon SELECT USING true). It
--      handed the whole management email directory (am_email, rm_email,
--      site_email, area_manager, regional_manager) to anyone with the anon key.
--    - drops "Super admins full access to pricing_simple" and "Email-based
--      location access" (authenticated ALL). They let a super_admin write
--      pricing straight over PostgREST, skipping sysadmin_audit_log; the second
--      calls user_has_location_access(), which authenticated cannot EXECUTE,
--      so for everyone else it threw rather than filtered.
--    - revokes all anon/authenticated table privileges (defence in depth).
--    - KEEPS "Service role full access to pricing_simple" (harmless; service
--      role bypasses RLS anyway).
--  fleet_submissions:
--    - drops "Allow anonymous inserts" (role public, INSERT, WITH CHECK true),
--      which let anyone POST rows straight to PostgREST past the worker's
--      Turnstile check, into a table Power Automate syncs to SharePoint.
--    - revokes all anon/authenticated table privileges.
--
-- ===========================================================================
-- WHAT STILL WORKS / WHAT STOPS
-- ===========================================================================
--  - Signup (customer /signup, /q, /join) reads pricing_simple_resolved, a
--    SECURITY DEFINER view owned by postgres; it never depended on these
--    policies or on anon's base-table grant. Untouched.
--  - Every worker reads/writes with SUPABASE_SERVICE_KEY, which bypasses RLS.
--  - FLEET STOPS. Operator confirmed 2026-10-05 that fleet is not in
--    production use. Both copies -- legacy `broad-shape-38b8` and monorepo
--    `splash-fleet-inquiry` -- still serve the form with SUPABASE_ANON_KEY and
--    will now (a) list no locations (they read pricing_simple anonymously:
--    location_pretty,location_code,pkg,single,address,sort,site) and
--    (b) fail to submit (they insert fleet_submissions anonymously).
--
-- ===========================================================================
-- REVIVING FLEET
-- ===========================================================================
--  Preferred: switch the public form's reads and insert to SUPABASE_SERVICE_KEY
--  (already bound on splash-fleet-inquiry for /admin/api/*). No DB change.
--  Without a code change, the minimum DB grant is column-scoped, NOT a
--  return of the full-table policy:
--    grant select (location_pretty, location_code, pkg, single, address, sort, site)
--      on public.pricing_simple to anon;
--    create policy "fleet anon read" on public.pricing_simple
--      for select to anon using (true);
--    grant insert on public.fleet_submissions to anon;
--    create policy "fleet anon insert" on public.fleet_submissions
--      for insert to anon with check (status = 'new' and splash_notes is null);

drop policy if exists "Public can read pricing_simple"             on public.pricing_simple;
drop policy if exists "Super admins full access to pricing_simple" on public.pricing_simple;
drop policy if exists "Email-based location access"                on public.pricing_simple;
revoke all on public.pricing_simple from anon, authenticated;

drop policy if exists "Allow anonymous inserts" on public.fleet_submissions;
revoke all on public.fleet_submissions from anon, authenticated;
