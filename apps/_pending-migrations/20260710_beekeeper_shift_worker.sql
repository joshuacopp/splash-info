-- Beekeeper Shift Worker — cache tables + `schedule` tool grant.
--
-- Two cache tables, refilled daily by the beekeeper-worker `scheduled`
-- handler (and the manual POST /api/sync-users endpoint), plus a widening of
-- the user_tool_access tool domain so the new `schedule` tool can be granted
-- through the existing sysadmin grant/revoke flow.
--
-- Place under supabase/migrations/ with your standard timestamp-prefixed name
-- and apply through the normal migration flow.

-- =============================================================================
-- 1. beekeeper_users — name-resolution + roster cache.
-- =============================================================================
-- Mirrors the maintainx_users cache pattern (Brief 71). `id` is Beekeeper's
-- internal user UUID — the key every shift references via shift.userId.
-- org_unit_ids is the list of Beekeeper location UUIDs the user belongs to;
-- the roster for a schedule is (users whose org_unit_ids contains the
-- schedule's locationIds[0]) UNION (the schedule's own userIds[]).
create table if not exists public.beekeeper_users (
  id            uuid primary key,            -- Beekeeper internal user UUID
  tenantuserid  text,                        -- dashboard User-ID (lowercase)
  display_name  text,
  firstname     text,
  lastname      text,
  org_unit_ids  jsonb not null default '[]'::jsonb,
  synced_at     timestamptz not null default now()
);

-- Roster lookup pushes a containment filter on org_unit_ids; GIN keeps it fast
-- across the ~80-site tenant-wide table.
create index if not exists beekeeper_users_org_unit_ids_idx
  on public.beekeeper_users using gin (org_unit_ids);

-- =============================================================================
-- 2. beekeeper_schedules — schedule picker + location_code mapping.
-- =============================================================================
-- schedule_id / name / location_ids / user_ids come straight from Beekeeper's
-- GET /shifts/schedules. `location_code` is the Splash-side mapping used by the
-- route schedule.splashcarwashes.info/{location_code} to resolve which
-- Beekeeper schedule to drive. It is NULLABLE and NOT overwritten by the sync
-- (the sync only touches the Beekeeper-owned columns) — operators map each
-- schedule to a Splash location_code once and it sticks.
create table if not exists public.beekeeper_schedules (
  schedule_id   uuid primary key,            -- Beekeeper schedule UUID
  name          text,
  location_ids  jsonb not null default '[]'::jsonb,
  user_ids      jsonb not null default '[]'::jsonb,
  location_code text,                        -- Splash mapping (operator-set)
  synced_at     timestamptz not null default now()
);

create unique index if not exists beekeeper_schedules_location_code_idx
  on public.beekeeper_schedules (location_code)
  where location_code is not null;

-- Seed the one verified mapping (Johnson City). Extend as schedules are mapped.
insert into public.beekeeper_schedules (schedule_id, name, location_ids, location_code)
values (
  '2838f08a-7fe2-42a5-8e91-7ec405baaceb',
  'Johnson City',
  '["fef0485e-cdaa-4c1a-a5e8-955e156d0174"]'::jsonb,
  'johnsoncity'
)
on conflict (schedule_id) do update
  set location_code = coalesce(public.beekeeper_schedules.location_code, excluded.location_code),
      name = excluded.name;

-- =============================================================================
-- 3. Widen user_tool_access.tool to include 'schedule'.
-- =============================================================================
-- Enables the existing sysadmin grantTool/revokeTool + create-user flows to
-- assign the new tool with NO handler change (they validate against
-- @splash/types VALID_TOOLS, which now lists 'schedule'). Location assignment
-- is unchanged — it lives on user_permissions and is shared across all tools.
--
-- The tool column may be plain text (no constraint) OR carry a CHECK. Both
-- branches below are idempotent no-ops when not applicable; run whichever your
-- schema actually uses. If tool is a Postgres ENUM instead, use:
--     alter type <enum_name> add value if not exists 'schedule';
do $$
begin
  if exists (
    select 1 from information_schema.constraint_column_usage
    where table_name = 'user_tool_access' and column_name = 'tool'
      and constraint_name = 'user_tool_access_tool_check'
  ) then
    alter table public.user_tool_access drop constraint user_tool_access_tool_check;
    alter table public.user_tool_access
      add constraint user_tool_access_tool_check
      check (tool in ('pricing', 'claims', 'pertrack', 'form_submissions', 'schedule'));
  end if;
end $$;
