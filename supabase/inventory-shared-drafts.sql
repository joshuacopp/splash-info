-- ============================================================================
-- inventory.drafts — one shared, unfinished visit or delivery per site.
--
-- APPLIED 2026-10-23 to rewokyofschtvqgxrxwl (table empty, RLS on, service_role
-- granted, anon not). Had to precede the worker that reads it; before that
-- the forms fall back to device-only drafts (the draft routes 500, the SPA
-- treats that as offline and keeps saving locally).
--
-- WHY
--
-- Field request (October 2026). Drafts lived in each browser's localStorage,
-- keyed per user, so a count started on the site tablet could not be finished
-- on a phone, and two techs splitting a chem room could not see each other's
-- numbers. Now there is ONE draft per (site, kind), shared by everyone who can
-- write at that site:
--
--   * last save wins — every save is accepted;
--   * if someone ELSE saved since you last loaded or saved, the response hands
--     back what you just replaced so the form can warn and offer to restore it;
--   * the submitter is not stored here: whoever presses Submit is recorded;
--   * submitting deletes the draft (worker, after the visit/delivery is saved),
--     and a later save from someone still holding the old draft is refused
--     rather than resurrecting it.
--
-- `version` increments on every save and is what "saved since you opened it"
-- is measured against. The worker writes with `where version = <read>` so two
-- saves racing between read and write cannot both believe they won.
--
-- The SPA still mirrors every draft to localStorage, so a dropped connection
-- in a wash bay costs nothing; see src/lib/useSharedDraft.js.
--
-- RLS on with no policies, like the rest of the schema: only the worker's
-- service key touches it.
-- ============================================================================

begin;

create table if not exists inventory.drafts (
  location_code text        not null,
  kind          text        not null check (kind in ('visit', 'delivery')),
  "values"      jsonb       not null,
  version       integer     not null default 1,
  updated_by    text        not null,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  primary key (location_code, kind)
);

alter table inventory.drafts enable row level security;

-- Default privileges (inventory-tables.sql) already cover new tables; stated
-- explicitly so this file does not depend on them. No anon/authenticated.
grant all privileges on inventory.drafts to service_role;

comment on table inventory.drafts is
  'One shared unfinished visit or delivery per site. Last save wins; version '
  'detects saves made by someone else since you loaded. Deleted on submit.';

commit;

-- VERIFY
-- select count(*) from inventory.drafts;   -- expect 0
-- select relrowsecurity from pg_class where oid = 'inventory.drafts'::regclass;  -- expect true

-- ROLLBACK (loses any drafts in progress; devices still hold their own copy)
-- drop table if exists inventory.drafts;
