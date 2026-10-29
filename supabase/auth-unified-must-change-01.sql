-- auth-unified-must-change-01.sql
--
-- NOT YET APPLIED. Run in the Supabase SQL editor (production). Safe to
-- re-run. Apply BEFORE the code that writes app_metadata deploys -- though
-- either order is harmless: until this runs the new flag is simply not read.
--
-- BUG: auth_unified.must_change_password was read ONLY from user_permissions
-- rows. An account with no pricing role (CRD queue logins: a plain login plus
-- a form access tag) has no such rows, so the flag could never be set -- new
-- accounts were not forced to change the admin-chosen password, and Sysadmin
-- "Reset password" did nothing for them either.
--
-- FIX: the flag is now ALSO stored on the login, auth.users
-- raw_app_meta_data.must_change_password (written by adminCreateUser and
-- setMustChangePassword; only the service role can write app_metadata), and
-- this view ORs the two. Everything else is the live definition from
-- pg_get_viewdef on 2026-10-29, unchanged, same columns in the same order.
--
-- create or replace view does not restate reloptions (e.g. security_invoker),
-- so the DO block captures them first and puts them back.

do $$
declare
  opts text[];
begin
  select c.reloptions into opts from pg_class c where c.oid = 'public.auth_unified'::regclass;

  execute $v$
    create or replace view public.auth_unified as
    select u.id as user_id,
        u.email,
        max(up.role) as role,
        coalesce(array_agg(distinct up.location_code) filter (where up.location_code is not null), array[]::text[]) as locations,
        coalesce(bool_or(up.must_change_password), false)
          or coalesce(bool_or(u.raw_app_meta_data ->> 'must_change_password' = 'true'), false)
          as must_change_password,
        coalesce(array_agg(distinct uta.tool) filter (where uta.tool is not null), array[]::text[]) as tools,
        dcur.dc_role,
        coalesce(array_agg(distinct dcul.location_code) filter (where dcul.location_code is not null), array[]::text[]) as dc_locations,
        pur.promo_role
       from auth.users u
         left join user_permissions up on up.user_id = u.id
         left join user_tool_access uta on uta.user_id = u.id
         left join damage_claim_user_roles dcur on dcur.user_id = u.id
         left join damage_claim_user_locations dcul on dcul.user_id = u.id
         left join promo_user_roles pur on pur.user_id = u.id
      group by u.id, u.email, dcur.dc_role, pur.promo_role
  $v$;

  if opts is not null then
    execute format('alter view public.auth_unified set (%s)', array_to_string(opts, ', '));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- OPTIONAL: accounts created before this fix with no pricing role never got
-- the flag. To force a password change for specific ones, list them:
--
--   select u.email, u.created_at
--     from auth.users u
--    where not exists (select 1 from user_permissions up where up.user_id = u.id)
--    order by u.created_at desc;
--
-- then set it (replace the emails):
--
--   update auth.users
--      set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"must_change_password": true}'::jsonb
--    where lower(email) in ('someone@splashcarwashes.com');
-- ---------------------------------------------------------------------------
