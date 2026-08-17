-- ============================================================================
-- inventory-seed-preflight.sql — verify every seed location resolves to a
-- location the app will actually SHOW, before importing the history.
--
-- WHY THIS FILE EXISTS
--
-- inventory.site_visits.location_code is a PLAIN indexed TEXT column, NOT a
-- foreign key (inventory-tables.sql lines 18-24, deliberate). So a seed row
-- carrying a code that nothing recognises does not error — it inserts fine and
-- then never appears anywhere. getLocations() in apps/inventory/worker/db.ts
-- enumerates public.pricing_simple codes UNIONed with inventory.locations, and
-- scopes/filters everything else against that list. A code outside the union
-- yields orphaned history: present in the table, invisible in the SPA, absent
-- from every rollup, and impossible to notice without this query.
--
-- That is the whole risk. The import cannot fail loudly, so it has to be
-- verified quietly, up front. Run STEP 1 through STEP 4 and read the counts.
--
-- Source of truth for the mapping: "splash-info docs/inventory-location-mapping.csv",
-- WITH THE 2026-08-15 CORRECTIONS APPLIED (see the CSV drift note in STEP 1).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- STEP 1 — every code the seed will write must exist in the union.
--
-- 81 seed locations carry visit history, totalling 1,628 visits. VERIFIED
-- against the standalone seed.sql directly on 2026-08-17: it holds exactly
-- 1,628 site_visits rows with 1,628 distinct ids across exactly 81 distinct
-- location uuids, and every per-location count agrees with the worksheet's
-- `visits` column with no disagreements. So the uuid -> code mapping below is
-- complete and one-to-one; the worksheet's uuid and visit columns are sound
-- and only its code column drifted (see below).
--
-- The 7 zero-visit seed rows (Bronx, Buckley IBA, Collegeville, Falmouth,
-- Nanuet, Personal Touch, Port Jefferson) are dropped and deliberately absent
-- below. 88 worksheet rows - 7 = 81.
--
-- CSV DRIFT — the worksheet's pricing_simple_code column is STALE for 8 rows
-- and the list below is what supersedes it. Seeding straight from the CSV
-- would silently do the wrong thing twice over:
--
--   blank in the CSV, now resolved:
--     Liberty IBA           -> batavia_liberty       (pricing-simple-inbays STEP 1)
--     Brockport IBA         -> brockport             (pricing-simple-inbays STEP 1)
--     Canandaigua           -> canandaigua           (pricing-simple-inbays STEP 1)
--     Liverpool Self Serves -> buckley_4s            (overlay, active = false)
--     Buckley IBA           -> dropped, 0 visits
--
--   pointed at the PARENT in the CSV, which would COLLAPSE the bay split that
--   was explicitly resolved against on 2026-08-15:
--     Seneca IBA   -> seneca_falls_iba      (CSV said seneca_falls)
--     Liverpool IBA-> liverpool_iba         (CSV said liverpool)
--     Vetts IBAs   -> batavia_veterans_iba  (CSV said batavia_veterans)
--
-- Collapsing those three would blend in-bay chemical usage into the tunnel's
-- CPC over two non-comparable wash counts — the exact outcome the overlay was
-- built to prevent. It would also not error, and the visit counts would still
-- total 1,628, so nothing downstream would reveal it.
--
-- EXPECT: 0 rows. Any row is a code the app cannot display.
-- ---------------------------------------------------------------------------
with seed(code, visits, seed_name) as (
  values
  ('middletown',           62,  'Wash Co - Middletown'),
  ('milford',              38,  'Milford'),
  ('easthaven',            35,  'East Haven'),
  ('shelton',              35,  'Shelton'),
  ('montogomery',          35,  'Wash Co - Montgomery'),
  ('tarrytown',            35,  'Wash Co - White Plains'),
  ('derby',                34,  'Derby'),
  ('greenwich',            33,  'Greenwich'),
  ('hamden',               33,  'Hamden'),
  ('newhaven',             33,  'New Haven'),
  ('whiteplainscentral',   33,  'White Plains (Central)'),
  ('wilton',               33,  'Wilton'),
  ('bedford',              32,  'Bedford Hills'),
  ('cheshire',             32,  'Cheshire'),
  ('cromwell',             32,  'Cromwell'),
  ('fairfield',            32,  'Fairfield'),
  ('westport',             32,  'Westport'),
  ('whiteplainskensico',   32,  'White Plains (Kensico)'),
  ('guilderland',          31,  'Knockout - Western Ave'),
  ('lindenhurst',          31,  'Lindenhurst'),
  ('norwalk',              31,  'Norwalk'),
  ('brewster',             30,  'Brewster'),
  ('coscob',               30,  'Cos Cob'),
  ('southeast',            30,  'Fast Lane - Brewster'),
  ('stamford',             30,  'Stamford'),
  ('westhaven',            30,  'West Haven'),
  ('bridgeport',           29,  'Bridgeport'),
  ('darien',               27,  'Darien'),
  ('williston',            25,  'Eco Car Wash - Williston'),
  ('rensselear',           25,  'Wash Boss - Albany'),
  ('randolph',             24,  'Randolph'),
  ('bohemia',              23,  'Bohemia'),
  ('shelburne',            23,  'Eco Car Wash - Shelburne'),
  ('plattsburgh',          23,  'Plattsburgh'),
  ('rutland',              21,  'Rutland'),
  ('southbury',            20,  'Southbury'),
  ('hempstead',            18,  'Hempstead'),
  ('eastnorthport',        17,  'Elwood'),
  ('newburgh',             17,  'Wash Co - Newburgh'),
  ('cortland',             15,  'Cortland'),
  ('batavia_liberty',      15,  'Liberty IBA'),
  ('vestal',               15,  'Vestal'),
  ('binghamton',           14,  'Binghamton'),
  ('brockport_ii',         14,  'Brockport Tunnel'),
  ('fairport',             14,  'Fairport'),
  ('geneva_ii',            14,  'Geneva'),
  ('johnson_city',         14,  'Johnson City'),
  ('rochester',            14,  'Long Pond'),
  ('newark',               14,  'Newark'),
  ('seneca_falls',         14,  'Seneca'),
  ('brockport',            13,  'Brockport IBA'),
  ('canandaigua',          13,  'Canandaigua'),
  ('chili',                13,  'Chili'),
  ('clay',                 13,  'Clay'),
  ('commack',              13,  'Commack'),
  ('elmira_heights',       13,  'Elmira'),
  ('fayetteville',         13,  'Fayetteville'),
  ('hamburg',              13,  'Hamburg'),
  ('henrietta',            13,  'Henrietta'),
  ('leray',                13,  'Leray'),
  ('liverpool',            13,  'Liverpool Tunnel'),
  ('oswego',               13,  'Oswego'),
  ('seneca_falls_iba',     13,  'Seneca IBA'),
  ('batavia_veterans',     13,  'Vetts Tunnel'),
  ('watertown',            13,  'Watertown'),
  ('williamsville',        13,  'Williamsville'),
  ('batavia_ii',           12,  '2 Mainstreet'),
  ('cicero',               12,  'Cicero'),
  ('spencerport',          12,  'Spencerport'),
  ('liverpool_iba',        11,  'Liverpool IBA'),
  ('batavia_veterans_iba', 9,   'Vetts IBAs'),
  ('springfield',          8,   'Springfield'),
  ('blackwood',            5,   'Blackwood #231'),
  ('cherry_hill',          5,   'Cherry Hill'),
  ('exton',                5,   'Exton'),
  ('wilmington',           5,   'Wilmington'),
  ('maple_shade',          4,   'Maple Shade'),
  ('newark_ii',            4,   'Newark DE'),
  ('buckley_4s',           3,   'Liverpool Self Serves'),
  ('auburn',               1,   'Auburn'),
  ('farmington',           1,   'Farmington')),
known as (
  select distinct location_code as code from public.pricing_simple
  union
  select code from inventory.locations
)
select s.code, s.visits, s.seed_name, 'MISSING - app cannot show this' as problem
  from seed s
 where not exists (select 1 from known k where k.code = s.code)
union all
-- The tally rides along so a typo in the list above cannot read as a clean
-- pass. If this row does not say 1628 / 81 / 81, the list is wrong and
-- "no missing rows" means nothing. 1,628 is the visit total recorded in
-- inventory-history-migration.md, arrived at independently of this file.
select '(tally)',
       sum(s.visits),
       count(*) || ' rows, ' || count(distinct s.code) || ' distinct codes',
       'expect 1628 visits / 81 rows / 81 distinct'
  from seed s
 order by 2 desc;


-- ---------------------------------------------------------------------------
-- STEP 2 — the overlay is internally consistent.
-- Same three checks as the bottom of inventory-locations-overlay.sql, folded
-- into one result so a single run answers all three. EXPECT: 0 rows.
-- ---------------------------------------------------------------------------
select 'parent_code does not resolve to a pricing_simple code' as problem,
       l.code, l.parent_code
  from inventory.locations l
 where l.parent_code is not null
   and not exists (
     select 1 from public.pricing_simple p where p.location_code = l.parent_code
   )
union all
select 'parent_code points at another overlay row (chains not supported)',
       c.code, c.parent_code
  from inventory.locations c
  join inventory.locations p on p.code = c.parent_code
union all
select 'overlay code shadows a pricing_simple code', l.code, null
  from inventory.locations l
 where exists (
   select 1 from public.pricing_simple p where p.location_code = l.code
 );


-- ---------------------------------------------------------------------------
-- STEP 3 — the target tables are empty, so the import is a clean load rather
-- than a merge. 465 products are already seeded and are expected.
--
-- EXPECT: products 465, everything else 0. Non-zero elsewhere means a partial
-- import already ran — stop and reconcile before re-running, because the seed
-- has no natural key to dedupe visits on.
-- ---------------------------------------------------------------------------
select 'products'          as tbl, count(*) from inventory.products
union all select 'site_visits',        count(*) from inventory.site_visits
union all select 'inventory_entries',  count(*) from inventory.inventory_entries
union all select 'location_products',  count(*) from inventory.location_products
union all select 'packages',           count(*) from inventory.packages
union all select 'package_products',   count(*) from inventory.package_products
order by 1;


-- ---------------------------------------------------------------------------
-- STEP 4 — POST-IMPORT reconciliation. Run this AFTER the seed, not before.
--
-- 4a. Anything that landed on an unknown code. EXPECT 0 rows. This is STEP 1
--     re-asked against reality instead of against the mapping list, and it is
--     the check that catches a bug in the uuid -> code rewrite itself.
-- ---------------------------------------------------------------------------
select sv.location_code, count(*) as visits
  from inventory.site_visits sv
 where not exists (
     select 1 from public.pricing_simple p where p.location_code = sv.location_code
   )
   and not exists (
     select 1 from inventory.locations l where l.code = sv.location_code
   )
 group by 1 order by 2 desc;

-- 4b. Per-code visit counts, to diff against the STEP 1 list. A code whose
--     count is the SUM of two seed locations is a silent collapse.
-- select location_code, count(*) as visits
--   from inventory.site_visits group by 1 order by 2 desc, 1;

-- 4c. Totals. EXPECT 1,628 visits across 81 codes.
-- select count(*) as visits, count(distinct location_code) as codes
--   from inventory.site_visits;

-- 4d. Entries whose visit vanished, and visits with no entries. EXPECT 0 / 0.
--     The FK on site_visit_id makes the first impossible; the second catches a
--     visit that imported with its entries silently dropped.
-- select count(*) from inventory.site_visits sv
--  where not exists (select 1 from inventory.inventory_entries ie
--                     where ie.site_visit_id = sv.id);
