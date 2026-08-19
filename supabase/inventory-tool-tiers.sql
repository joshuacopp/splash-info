-- Allow the `inventory_view` and `inventory_admin` tool grants.
--
-- Splits the single `inventory` grant into three nested capability tiers:
--
--     inventory_view    read-only
--     inventory         read + write        (unchanged meaning)
--     inventory_admin   read + write + admin
--
-- public.user_tool_access.tool has a CHECK constraint enumerating the valid
-- tool names, so widening the ToolName union in packages/types/src/auth.ts does
-- NOT change Postgres. Without this, granting either new tier fails at insert
-- with a check violation. Supersedes supabase/inventory-tool-grant.sql, which
-- added `inventory`; that file is left in place as the historical record.
--
-- NO DATA MIGRATION. `inventory` keeps exactly the meaning it already had, so
-- every existing row stays correct and nobody's access changes when this runs.
-- The only people whose capabilities move are ones you explicitly re-grant.
--
-- Additive and safe: no existing row can violate the widened constraint. Note
-- that staging and prod share one Supabase project, so running this enables the
-- grants everywhere at once. That's fine on its own — widening the constraint
-- doesn't issue anything.
--
-- ORDER OF OPERATIONS: run this BEFORE deploying, or at worst alongside it. The
-- console will offer the two new tick boxes as soon as the web build ships, and
-- ticking one before this runs produces a check violation rather than a useful
-- error message.
--
-- Keep this list in sync with VALID_TOOLS in packages/types/src/auth.ts and the
-- copy in apps/sysadmin-worker/src/index.ts.

begin;

alter table public.user_tool_access
  drop constraint if exists user_tool_access_tool_check;

alter table public.user_tool_access
  add constraint user_tool_access_tool_check
  check (tool = any (array[
    'pricing',
    'claims',
    'pertrack',
    'form_submissions',
    'schedule',
    'inventory_view',
    'inventory',
    'inventory_admin'
  ]::text[]));

commit;

-- Verify the constraint:
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.user_tool_access'::regclass
--     and conname = 'user_tool_access_tool_check';

-- Who currently holds an inventory grant, and at which tier:
--   select tool, count(*)
--   from public.user_tool_access
--   where tool like 'inventory%'
--   group by tool
--   order by tool;

-- Promote a specific user to inventory admin without granting super_admin.
-- Note this ADDS a row; drop the old tier separately if you want a clean
-- single-tier record (the worker takes the strongest grant either way).
--   insert into public.user_tool_access (user_id, tool, granted_by, notes)
--   select id, 'inventory_admin', null, 'chemical program manager'
--   from auth.users
--   where email = 'REPLACE_ME@splashcarwashes.com'
--   on conflict do nothing;
--
--   delete from public.user_tool_access
--   where tool = 'inventory'
--     and user_id = (select id from auth.users
--                    where email = 'REPLACE_ME@splashcarwashes.com');
