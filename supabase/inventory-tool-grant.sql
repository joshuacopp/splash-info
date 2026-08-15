-- Allow the `inventory` tool grant.
--
-- public.user_tool_access.tool has a CHECK constraint enumerating the valid
-- tool names. Adding "inventory" to the ToolName union in
-- packages/types/src/auth.ts does NOT change Postgres — without this, every
-- attempt to grant the inventory tool fails at insert with a check violation.
--
-- Additive and safe: no existing row can violate the widened constraint. Note
-- that staging and prod share one Supabase project, so running this enables
-- the grant everywhere at once. That is fine on its own — a user still can't
-- reach the app until the route is live and the grant is actually issued.
--
-- Keep this list in sync with VALID_TOOLS in packages/types/src/auth.ts.

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
    'inventory'
  ]::text[]));

commit;

-- Verify:
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.user_tool_access'::regclass
--     and conname = 'user_tool_access_tool_check';
