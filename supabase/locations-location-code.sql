-- ============================================================================
-- public.locations.location_code — a site can exist before it sells memberships.
--
-- APPLIED 2026-10-23 to rewokyofschtvqgxrxwl (verified: column, check, index present).
--
-- WHY
--
-- New sites take chemical deliveries (and sometimes site visits) before they
-- open, and acquired sites run on their own systems for a while before moving
-- onto the signup system. Until now a location only got a code by having
-- pricing_simple rows, and a pricing_simple row IS a live customer signup page.
-- So a pre-signup site either had no code at all, or had to be published to
-- customers early.
--
-- This column lets the registry row carry the code from day one. The inventory
-- Admin > Sites tab writes it when it creates a standalone site; sysadmin's Add
-- Location later finds the row by that code and attaches the pricing rows to it
-- instead of 409ing on the site number. Inventory history is filed under the
-- code, so keeping it identical across that hand-off is what keeps the history.
--
-- This is step 6 of "splash-info docs/location-model-brief.md" WITHOUT the
-- backfill: existing rows stay NULL and nothing that reads `locations` today
-- selects the column, so applying it changes no current behaviour. The brief's
-- step 7 (backfill, NOT NULL, FK from pricing_simple) remains future work and
-- still has to decide sites 19/40/68 by hand.
--
-- UNIQUE is a partial index so the many NULLs don't collide. The format check
-- matches pricing_simple codes, inventory.locations, and LOCATION_CODE_RE in
-- the sysadmin worker.
-- ============================================================================

begin;

alter table public.locations
  add column if not exists location_code text;

alter table public.locations
  add constraint locations_location_code_format
  check (location_code is null or location_code ~ '^[a-z0-9_]+$');

create unique index if not exists locations_location_code_key
  on public.locations (location_code)
  where location_code is not null;

comment on column public.locations.location_code is
  'Location code (same value as pricing_simple.location_code). Set when a site is '
  'registered before it has pricing rows (inventory Admin > Sites); NULL on rows '
  'created before 2026-10. Not yet backfilled — see location-model-brief.md.';

commit;

-- VERIFY — expect the column, the check, and the index.
-- select column_name, data_type, is_nullable from information_schema.columns
--  where table_schema = 'public' and table_name = 'locations' and column_name = 'location_code';
-- select conname from pg_constraint where conname = 'locations_location_code_format';
-- select indexname from pg_indexes where indexname = 'locations_location_code_key';

-- ROLLBACK — safe while no row has a code set; otherwise those codes are lost.
-- begin;
-- drop index if exists public.locations_location_code_key;
-- alter table public.locations drop constraint if exists locations_location_code_format;
-- alter table public.locations drop column if exists location_code;
-- commit;
