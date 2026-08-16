-- ============================================================================
-- public.locations rows for the orphan pricing codes.
--
-- These codes have public.pricing_simple rows but NO public.locations row, so
-- they sell memberships while being invisible to everything that resolves a
-- site through the registry. Visible symptom: the inventory sidebar grouped
-- Auburn and Farmington under a bare "EARL BUDLONG" heading, separate from his
-- other sites, because with no registry row there is no rm_group.
--
-- Source: "splash-info docs/inventory-history-migration.md" line 33.
--
--   auburn      site 159  -- confirmed 2026-08-16
--   farmington  site 160  -- confirmed 2026-08-16
--   falmouth    site 092  -- confirmed 2026-08-16. It is a NEW site. The
--                            "DROP - no visit history" note against it in
--                            inventory-location-mapping.csv line 86 is an
--                            instruction about the SEED migration — the
--                            standalone app's 8-year history has no visits for
--                            a site that didn't exist yet — not a statement
--                            that the site is closed.
--   test                  -- STEP 2. Gets deleted, not backfilled.
--
-- WHY THE DERIVATION IS SAFE: every value below except site_number and rm_group
-- is copied out of the pricing_simple rows that already exist for these codes,
-- so the two tables agree the moment the row lands. That matters because
-- trg_sync_pricing_simple fires ON locations AFTER UPDATE — the insert itself
-- syncs nothing, but the FIRST later edit to one of these locations pushes
-- these values back down into pricing_simple. A wrong value here is a
-- delayed-action corruption of the pricing table, not a harmless typo.
--
-- Column mapping (locations <- pricing_simple), per the sysadmin Add Location
-- endpoint's own insert at apps/sysadmin-worker/src/index.ts:1081-1090:
--   site             <- location_pretty   (display name, NOT the number)
--   location         <- address           (yes, `location` is the address)
--   site_number      <- literal below     (159 / 160, from pricing_simple.site)
--   rm_group         <- derived           (see STEP 1 note)
--   area_manager / regional_manager / am_email / rm_email / site_email <- same
-- mla_location, hrt_email, hrt1, hrt2 and fivestar are left null; the supported
-- Add Location path leaves them null too.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- STEP 0 — verify. Two questions, then run STEP 1.
--
-- RUN THESE ONE BLOCK AT A TIME, not the whole file at once. Pasting the file
-- wholesale also trips the Supabase editor's destructive-query warning, which
-- regex-scans the raw text and matches the commented-out `delete` in STEP 2.
-- Nothing in this file drops a table.
-- ---------------------------------------------------------------------------

-- 0a. Confirm 92, 159 and 160 are free, and that none of the three is already
--     in the registry under a different number.
-- select id, site_number, site, location, rm_group
-- from public.locations
-- where site_number in (92, 159, 160)
--    or lower(site) like any (array['%auburn%','%farmington%','%falmouth%']);

-- 0b. REQUIRED. `id` is sequence-backed but the sequence is BEHIND max(id) —
--     a first attempt at STEP 1 failed with
--       23505 duplicate key ... locations_pkey ... Key (id)=(79) already exists
--     which means rows were inserted with explicit ids at some point (a restore
--     or a hand-written insert) without advancing the sequence. Resync it, or
--     STEP 1 keeps colliding, and so does the sysadmin Add Location endpoint,
--     which omits `id` the same way.
--
--     Safe and idempotent: nothing occupies ids above max(id), so pointing the
--     sequence at max(id) hands out max(id)+1 next.
-- select setval(
--          pg_get_serial_sequence('public.locations', 'id'),
--          (select max(id) from public.locations)
--        );

-- 0c. Sanity — should be one more than max(id), and should not already exist.
-- select last_value from public.locations_id_seq;


-- ---------------------------------------------------------------------------
-- STEP 1 — insert. Everything but site_number and rm_group comes from
-- pricing_simple.
--
-- rm_group is derived from Earl Budlong's OTHER registry rows rather than
-- hardcoded to 8, so if the territory is ever renumbered this file doesn't
-- silently plant a stale value. The scalar subquery returns null unless all of
-- his rows agree on one group, which is the right outcome — better ungrouped
-- than wrong.
--
-- distinct on (location_code) collapses the three per-package rows to one; the
-- order by makes the pick deterministic rather than whatever the planner
-- returns. `where not exists` makes the whole thing re-runnable.
-- ---------------------------------------------------------------------------

begin;

-- Resync the id sequence FIRST, in the same block, so this can't be skipped.
-- It is behind max(id) (see STEP 0b), and every failed attempt burns another
-- value — the first try collided on 79, the retry on 80. Idempotent: nothing
-- occupies ids above max(id).
select setval(
         pg_get_serial_sequence('public.locations', 'id'),
         (select max(id) from public.locations)
       );

with wanted (location_code, site_number) as (
  values
    ('auburn',     159),
    ('farmington', 160),
    ('falmouth',    92)
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
    p.site_email,
    (
      select min(l.rm_group)
      from public.locations l
      where l.regional_manager = p.regional_manager
        and l.rm_group is not null
      having count(distinct l.rm_group) = 1
    ) as rm_group
  from public.pricing_simple p
  join wanted w on w.location_code = p.location_code
  order by p.location_code, p.sort nulls last, p.pkg
)
insert into public.locations
  (site_number, site, location, area_manager, regional_manager, rm_group,
   am_email, rm_email, site_email)
select
  s.site_number,
  s.location_pretty,
  s.address,
  s.area_manager,
  s.regional_manager,
  s.rm_group,
  s.am_email,
  s.rm_email,
  s.site_email
from src s
where not exists (
  select 1 from public.locations l where l.site_number = s.site_number
);

-- Expect 3 rows: auburn + farmington under Earl Budlong, falmouth under Anibal
-- Rodriguez, each picking up its RM's group. Check BEFORE commit:
--   select id, site_number, site, location, rm_group, area_manager,
--          regional_manager, am_email, rm_email, site_email
--   from public.locations where site_number in (92, 159, 160);

commit;


-- ---------------------------------------------------------------------------
-- STEP 1B — fallback if you would rather not touch the sequence in STEP 0b.
-- Same insert with an explicit id computed from max(id). Not concurrency-safe,
-- which is fine for a one-shot admin backfill and not fine for anything else —
-- and note it leaves the sequence just as stale as it found it, so the next
-- sysadmin Add Location will still 23505.
-- ---------------------------------------------------------------------------
-- ... same `with wanted / src` CTEs as above ...
-- insert into public.locations
--   (id, site_number, site, location, area_manager, regional_manager, rm_group,
--    am_email, rm_email, site_email)
-- select
--   (select coalesce(max(id), 0) from public.locations)
--     + row_number() over (order by s.location_code),
--   s.site_number, s.location_pretty, s.address, s.area_manager,
--   s.regional_manager, s.rm_group, s.am_email, s.rm_email, s.site_email
-- from src s;


-- ============================================================================
-- STEP 2 — remove the `test` code from pricing_simple.
--
-- `test` gets deleted rather than backfilled because every DISTINCT
-- pricing_simple code enumerates into user-facing pickers: the public signup
-- location list (listDistinctLocations), promo-worker GET /promo/api/locations,
-- and the forms location field. Giving it a registry row would make a fake site
-- more visible, not less.
--
-- RUN 2a AND 2b FIRST. Deleting a code that a real signup or a live grant
-- points at is not recoverable from this file.
-- ============================================================================

-- 2a. What is actually there? Also worth a look at updated_at — if it moved
--     recently somebody is using it for something.
-- select location_code, pkg, "pkg$", ongoing, site, location_pretty, updated_at
-- from public.pricing_simple
-- where location_code = 'test'
-- order by pkg;

-- 2b. Is anyone granted it? A non-zero count means clean up the grants first;
--     a grant naming a code that no longer exists is dead weight that will
--     confuse the next person to read user_permissions.
-- select id, email, role, locations
-- from public.user_permissions
-- where locations @> array['test']::text[];

-- 2c. Delete. Bounded to the one code; re-running is harmless.
-- begin;
-- delete from public.pricing_simple where location_code = 'test';
-- -- expect 0:
-- --   select count(*) from public.pricing_simple where location_code = 'test';
-- commit;


-- ---------------------------------------------------------------------------
-- AFTER
--
-- 1. auburn and farmington each carry 1 visit (2026-08-10, Earl Budlong) in the
--    standalone seed, so they need a user_permissions grant for whoever runs
--    them before the inventory history migration lands. falmouth has no seed
--    history — it is new — but still needs a grant to be usable going forward.
-- 2. The inventory overlay loader has a 60s isolate cache — give it a minute
--    before deciding the sidebar grouping didn't change.
-- ---------------------------------------------------------------------------
