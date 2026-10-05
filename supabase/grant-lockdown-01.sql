-- grant-lockdown-01.sql
--
-- APPLIED 2026-10-05 against production by operator instruction (migration
-- `grant_lockdown_01`, applied without the begin/commit wrapper -- the
-- migration runner supplies the transaction). SB-sec.md M3.
-- Verified after applying:
--   - anon can read only pricing_simple_resolved + jotform_site_lookup, with
--     no write on either.
--   - authenticated can touch no relation in `public`.
--   - project functions are service_role-only, and service_role still has
--     SELECT on every relation.
--   - postgres default ACLs no longer list anon/authenticated.
--   - As anon: pricing_simple_resolved 353 rows; jotform_site_lookup returns
--     rows for sites 126/143.
--
-- ===========================================================================
-- THE PROBLEM
-- ===========================================================================
-- Supabase's default privileges grant `anon` and `authenticated`
--   tables     arwdDxtm  (SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER MAINTAIN)
--   sequences  USAGE SELECT UPDATE
--   functions  EXECUTE
-- on EVERY object created in `public`. Row-level security is the only thing
-- stopping those grants from being used. Disable RLS on one table, or add one
-- `USING (true)` policy (public.shortbreak, 2026-10-05), and the table is
-- readable/writable/deletable over PostgREST. TRUNCATE ignores RLS entirely.
--
-- Live state when drafted (2026-10-05): 79 tables, 27 views, 15 sequences and
-- 15 project-owned functions granted to anon and/or authenticated.
--
-- ===========================================================================
-- WHAT THIS DOES
-- ===========================================================================
--  1. Revokes ALL on every table, view, materialized view and sequence in
--     `public` from anon + authenticated.
--  2. Revokes EXECUTE on every PROJECT-OWNED function in `public` from
--     PUBLIC + anon + authenticated, and re-grants it to service_role.
--     Extension-owned functions (pg_trgm, btree_gist -- ~200 of them) are
--     skipped: they belong to the extension, and revoking them fights
--     extension upgrades. They are harmless helpers (moving the extensions out
--     of `public` is SB-sec L4).
--  3. Re-grants the two deliberately public reads:
--       pricing_simple_resolved -> anon  (customer signup; SECURITY DEFINER view)
--       jotform_site_lookup     -> anon  (JotForm prefill widget; ~150-175/day)
--  4. Changes default privileges FOR ROLE postgres in `public` so future
--     tables/sequences/functions are NOT auto-granted to anon/authenticated.
--     (Every object in `public` is owned by postgres.)
--
-- ===========================================================================
-- WHY NOTHING SHOULD BREAK (checked 2026-10-05)
-- ===========================================================================
--  - Every worker uses SUPABASE_SERVICE_KEY. service_role is untouched and
--    keeps every grant.
--  - Nothing queries /rest/v1 as `authenticated`: packages/auth only calls
--    /auth/v1, createAnonClient() has no callers (re-checked from
--    anon-view-revoke-03's analysis).
--  - API logs (sampled 2026-09-28, 2026-10-02, last 24h to 2026-10-05): the
--    ONLY non-service-role REST traffic is jotform_site_lookup and one
--    pricing_simple_resolved read. Both are re-granted in step 3.
--  - Trigger functions (set_updated_at, sync_pricing_simple_from_locations,
--    ...) do not need EXECUTE by the role firing the trigger.
--  - Policies that become dormant (harmless; can be dropped later):
--      user_permissions "Users can view own permissions"      [authenticated]
--      damage_claim_user_roles "Users can view own dc_role"   [authenticated]
--      damage_claim_user_locations "Users can view own dc_locations" [authenticated]
--      user_tool_access "users can read own access"           [public]
--      phone_usage_log_dev "Anon can write log_dev"           [anon] (dev table, SB-sec L6)
--  - Not touched: storage, auth, realtime, graphql schemas (Supabase-managed);
--    `inventory` and `archive` (anon/authenticated already have no USAGE).
--
-- ===========================================================================
-- KNOWN LIMITS
-- ===========================================================================
--  - Default privileges FOR ROLE supabase_admin still grant anon/authenticated.
--    `postgres` cannot alter another role's defaults. Objects created by
--    supabase_admin are platform-internal; ours are all created as postgres.
--    Re-run the verification query after any new migration to catch drift.
--  - Any FUTURE deliberately-public object needs an explicit grant, e.g.
--      grant select on public.<view> to anon;
--    That is the point: public becomes opt-in instead of opt-out.
--
-- ===========================================================================
-- BEFORE APPLYING
-- ===========================================================================
--  1. Re-run the API-log check: non-service-role /rest/v1 calls should still be
--     only jotform_site_lookup and pricing_simple_resolved.
--  2. After applying, smoke-test: one customer signup page load (/signup/{loc})
--     and one JotForm form with the site widget.
--
-- ROLLBACK (restores Supabase defaults; RLS still applies):
--   grant all on all tables    in schema public to anon, authenticated;
--   grant all on all sequences in schema public to anon, authenticated;
--   grant execute on all functions in schema public to anon, authenticated;
--   alter default privileges for role postgres in schema public
--     grant all on tables to anon, authenticated;
--   alter default privileges for role postgres in schema public
--     grant all on sequences to anon, authenticated;
--   alter default privileges for role postgres in schema public
--     grant execute on functions to anon, authenticated;
--   (Note: the blanket rollback would also re-open the 7 greeter functions and
--    the views locked by anon-view-revoke-03 -- re-apply that file afterwards.)

begin;

-- 1. Tables, views, materialized views, sequences.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- 2. Project-owned functions only (skip extension members).
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- 3. The deliberately public reads.
grant select on public.pricing_simple_resolved to anon;
grant select on public.jotform_site_lookup     to anon;

-- 4. Future objects: opt-in, not opt-out.
alter default privileges for role postgres in schema public
  revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

commit;

-- ===========================================================================
-- VERIFICATION (run after applying; expected results in comments)
-- ===========================================================================
-- Objects anon/authenticated can still touch -- expect exactly:
--   anon: pricing_simple_resolved, jotform_site_lookup
--   authenticated: (none)
-- select c.relname, c.relkind,
--   has_table_privilege('anon', c.oid, 'SELECT') anon_sel,
--   has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE') anon_write,
--   has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') auth_any
-- from pg_class c
-- where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m')
--   and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
--     or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'));
--
-- Signup path still works as anon -- expect ~353 rows:
-- begin; set local role anon; select count(*) from public.pricing_simple_resolved; rollback;
--
-- JotForm path still works as anon -- expect 1 row:
-- begin; set local role anon; select count(*) from public.jotform_site_lookup where site_number = '126'; rollback;
--
-- Defaults changed -- expect postgres rows WITHOUT anon=/authenticated= entries:
-- select pg_get_userbyid(defaclrole), defaclobjtype, defaclacl
-- from pg_default_acl where defaclnamespace = 'public'::regnamespace;
