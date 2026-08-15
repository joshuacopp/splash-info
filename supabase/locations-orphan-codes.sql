-- ============================================================================
-- public.locations rows for the orphan pricing codes: auburn, falmouth,
-- farmington.
--
-- These three have public.pricing_simple rows but NO public.locations row, so
-- they sell memberships while being invisible to everything that resolves a
-- site through the registry. Source: "splash-info docs/inventory-history-
-- migration.md" line 33.
--
-- The fourth orphan is `test`. It is deliberately NOT in this file — it should
-- be deleted from pricing_simple, not given a locations row, because every
-- distinct pricing_simple code enumerates into the public signup picker
-- (listDistinctLocations), the promo-worker location list and the forms
-- location field. Check whether it is actually live before touching it.
--
-- ############################################################################
-- # STOP — RUN STEP 0 FIRST. site_number cannot be derived, and I have not    #
-- # seen this table's DDL, only the row interface in                          #
-- # packages/types/src/locations.ts.                                          #
-- ############################################################################
--
-- Two things STEP 0 has to settle:
--   1. Does `id` have an identity/serial default? The interface types it as a
--      plain `number` and the sysadmin Add Location endpoint omits it on
--      insert (apps/sysadmin-worker/src/index.ts:1081), which implies a
--      default — but "implies" is not "verified". If there is no default, use
--      the STEP 1B variant instead.
--   2. What `site` (the site NUMBER, as text) holds on the pricing_simple rows
--      for these three codes. If it is populated, reuse it; if it is null,
--      you have to supply the real site numbers by hand — inventing one would
--      collide with a real site.
--
-- WHY THE DERIVATION IS SAFE: every value below except site_number is copied
-- out of the pricing_simple rows that already exist for these codes, so the
-- two tables agree the moment the row lands. That matters because
-- trg_sync_pricing_simple fires ON locations AFTER UPDATE — the insert itself
-- syncs nothing, but the FIRST later edit to one of these locations pushes
-- these values back down into pricing_simple. A wrong value here is therefore
-- a delayed-action corruption of the pricing table, not a harmless typo.
--
-- Column mapping (locations <- pricing_simple), per the sysadmin endpoint's
-- own insert at apps/sysadmin-worker/src/index.ts:1081-1090:
--   site             <- location_pretty   (display name, NOT the number)
--   location         <- address           (yes, `location` is the address)
--   site_number      <- supplied by hand  (see STEP 0)
--   area_manager / regional_manager / am_email / rm_email / site_email <- same
-- mla_location, rm_group, hrt_email, hrt1, hrt2 and fivestar are left null;
-- the supported Add Location path leaves them null too.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- STEP 0 — verify. Run all three; do not skip to STEP 1.
-- ---------------------------------------------------------------------------

-- 0a. Does `id` default, and is site_number really NOT NULL?
-- select column_name, data_type, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'locations'
-- order by ordinal_position;

-- 0b. What do the orphan pricing rows actually carry? One row per package, so
--     expect several rows per code — they should agree with each other.
-- select location_code, site, location_pretty, address,
--        area_manager, regional_manager, am_email, rm_email, site_email
-- from public.pricing_simple
-- where location_code in ('auburn','falmouth','farmington')
-- order by location_code, pkg;

-- 0c. Confirm they really are missing, and that the site numbers you are about
--     to use are free. Replace the numbers first.
-- select * from public.locations
-- where site_number in (0, 0, 0)
--    or lower(site) like any (array['%auburn%','%falmouth%','%farmington%']);

-- ---------------------------------------------------------------------------
-- STEP 1 — insert, deriving everything except site_number from pricing_simple.
--
-- FILL IN THE SITE NUMBERS BELOW. The zeros are placeholders and will insert
-- three rows with site_number 0 if you run this as-is.
--
-- distinct on (location_code) collapses the per-package rows to one; the
-- order by makes the pick deterministic rather than whatever the planner
-- returns. `where not exists` makes the whole thing re-runnable.
-- ---------------------------------------------------------------------------

begin;

with wanted (location_code, site_number) as (
  values
    ('auburn',     0),   -- TODO real site number
    ('falmouth',   0),   -- TODO real site number
    ('farmington', 0)    -- TODO real site number
),
src as (
  select distinct on (p.location_code)
    p.location_code,
    w.site_number,
    p.location_pretty,
    p.address,
    p.area_manager,
    p.regional_manager,
    p.am_email,
    p.rm_email,
    p.site_email
  from public.pricing_simple p
  join wanted w on w.location_code = p.location_code
  order by p.location_code, p.sort nulls last, p.pkg
)
insert into public.locations
  (site_number, site, location, area_manager, regional_manager,
   am_email, rm_email, site_email)
select
  s.site_number,
  s.location_pretty,
  s.address,
  s.area_manager,
  s.regional_manager,
  s.am_email,
  s.rm_email,
  s.site_email
from src s
where not exists (
  select 1 from public.locations l where l.site_number = s.site_number
);

-- Expect 3 rows. Check before committing:
--   select id, site_number, site, location, area_manager, regional_manager,
--          am_email, rm_email, site_email
--   from public.locations
--   where site_number in (0, 0, 0);   -- your three numbers

commit;

-- ---------------------------------------------------------------------------
-- STEP 1B — ONLY if STEP 0a showed `id` has no default. Same insert with an
-- explicit id. Not concurrency-safe, which is fine for a one-shot admin
-- backfill and not fine for anything else.
-- ---------------------------------------------------------------------------
-- ... same `with wanted / src` CTEs as above ...
-- insert into public.locations
--   (id, site_number, site, location, area_manager, regional_manager,
--    am_email, rm_email, site_email)
-- select
--   (select coalesce(max(id), 0) from public.locations)
--     + row_number() over (order by s.location_code),
--   s.site_number, s.location_pretty, s.address, s.area_manager,
--   s.regional_manager, s.am_email, s.rm_email, s.site_email
-- from src s;

-- ---------------------------------------------------------------------------
-- AFTER: two follow-ups, neither of them SQL.
--
-- 1. falmouth has ZERO visits in the standalone seed and is marked DROP in
--    "splash-info docs/inventory-location-mapping.csv" line 86. It is being
--    added here because it has live pricing_simple rows — which means it is
--    currently sellable on the signup page. Decide which is true: if the site
--    is gone, the fix is to remove its pricing_simple rows, not to give it a
--    registry entry.
--
-- 2. auburn and farmington each carry 1 visit (2026-08-10, Earl Budlong) in
--    the seed, so they need a user_permissions grant for whoever runs them
--    before the inventory history migration lands.
-- ---------------------------------------------------------------------------
