-- inventory-package-type-fix.sql
--
-- Correct the wash/add-on classification (and the ceramic a-la-carte name) in
-- inventory.packages.
--
-- WHY THIS MATTERS BEYOND THE FORM LAYOUT
--   `package_type` is not cosmetic. calc.js reads it at RENDER time, so it
--   drives `total_wash_count` and the denominator of every CPC number the app
--   shows. Flipping a package from 'wash' to 'addon' therefore RESTATES EVERY
--   PAST VISIT at that site: the wash count drops, the add-on count rises, and
--   actual CPC goes UP because the same chemical cost is divided by fewer cars.
--   That is retroactive by design (there is no snapshot of package_type the way
--   there now is for price_per_ml). Run this knowing history will move.
--
-- WHAT THE SEED DATA CURRENTLY SAYS (491 rows, all sites):
--   already 'addon' and correct  Cer. Ala / Cer-Ala / Cer ala / Ceramic AlaCart
--                                (12 spellings), Graph. Ala (9 spellings),
--                                Hot Wax / Hot, Tire, Wheel*, Rain X
--   wrongly 'wash'               Graphene (9), Graphine (5)
--                                Cer.Pkg family (22, six spellings)
--
-- The ceramic-package rows are the one group worth a second look before you
-- run section 3 -- see the header comment there.
--
-- Matching is by NAME PATTERN against the live table, not by the seed's UUIDs,
-- because the Package Editor lets anyone rename or retype a package after the
-- seed ran. Names are matched case- and punctuation-insensitively.
--
-- Order of operations: run section 0 first, read it, then run 1-3.


-- ==========================================================================
-- 0. PREVIEW -- run this ALONE first. Changes nothing.
-- ==========================================================================
-- Every row this script would touch, and what it would become.
select
  p.location_code,
  p.name                                   as current_name,
  p.package_type                            as current_type,
  case
    when lower(p.name) ~ '^(cer|cre)[^a-z]*(ala|alacart|alacarte)$'
      or lower(p.name) ~ '^ceramic[^a-z]*(ala|alacart|alacarte)$'
      then 'Cer Add-On'
    else p.name
  end                                       as new_name,
  'addon'                                   as new_type,
  p.target_cpc
from inventory.packages p
where
  -- ceramic a-la-carte (rename only; already addon)
  lower(p.name) ~ '^(cer|cre)[^a-z]*(ala|alacart|alacarte)$'
  or lower(p.name) ~ '^ceramic[^a-z]*(ala|alacart|alacarte)$'
  -- graphene (reclassify)
  or lower(p.name) in ('graphene', 'graphine')
  -- ceramic package (reclassify)
  or lower(p.name) ~ '^cer[^a-z]*(pkg|pack)\.?$'
order by p.location_code, p.name;

-- Safety check: would the rename in section 1 collide with the
-- (location_code, name) unique constraint? Expect ZERO rows.
select location_code, count(*) as ala_variants
from inventory.packages
where lower(name) ~ '^(cer|cre)[^a-z]*(ala|alacart|alacarte)$'
   or lower(name) ~ '^ceramic[^a-z]*(ala|alacart|alacarte)$'
   or name = 'Cer Add-On'
group by location_code
having count(*) > 1;


-- ==========================================================================
-- 1. Normalise the ceramic a-la-carte name -> 'Cer Add-On'
-- ==========================================================================
-- Twelve spellings of the same product across the chain: Cer. Ala, Cer-Ala,
-- Cer ala, Cer. ALA, Cer.Ala, Cer. Ala., Cre-Ala (Elmira Heights' typo),
-- Ceramic AlaCart, Ceramic AlaCarte. One name so the reports collate.
-- These rows are ALREADY 'addon'; this is a rename only, but package_type is
-- set anyway so the statement is idempotent against future drift.
update inventory.packages
set name = 'Cer Add-On',
    package_type = 'addon'
where (
    lower(name) ~ '^(cer|cre)[^a-z]*(ala|alacart|alacarte)$'
    or lower(name) ~ '^ceramic[^a-z]*(ala|alacart|alacarte)$'
  )
  and name <> 'Cer Add-On';


-- ==========================================================================
-- 2. Graphene / Graphine -> add-on
-- ==========================================================================
-- Seeded 'wash' at 14 sites, but the same product is seeded 'addon' at the 17
-- sites that spell it "Graph. Ala" -- and the target CPCs are identical
-- (0.1225-0.175 either way), which is add-on money, not wash money. The
-- 'wash' rows are the mistake.
--
-- The name is deliberately NOT normalised here: "Graphene" vs "Graphine" is a
-- spelling difference Josh has not asked to collapse, and renaming is a
-- separate, reversible decision from reclassifying.
update inventory.packages
set package_type = 'addon'
where lower(name) in ('graphene', 'graphine')
  and package_type <> 'addon';


-- ==========================================================================
-- 3. Ceramic package -> add-on
-- ==========================================================================
-- READ BEFORE RUNNING. This is the one section where the data argues back.
--
-- Cer.Pkg is seeded 'wash' at all 22 sites that have it, and its target_cpc
-- (0.53-0.91) sits ABOVE Bubble Bath (0.43-0.70) at every single one -- i.e.
-- it is priced like the top rung of the wash ladder, not like an add-on. The
-- a-la-carte ceramic at those same sites costs 0.09-0.18. If Cer.Pkg really is
-- an upgrade sold on top of a base wash, then the base wash already counted
-- the car and this reclassification is correct; the 0.80 CPC just means the
-- add-on carries a full wash's chemical load, which will now be divided by a
-- smaller denominator and push actual CPC up at all 22 sites.
--
-- If instead Cer.Pkg is a standalone top-tier wash at some sites, skip this
-- section or scope it with an explicit location_code list.
update inventory.packages
set package_type = 'addon'
where lower(name) ~ '^cer[^a-z]*(pkg|pack)\.?$'
  and package_type <> 'addon';


-- ==========================================================================
-- 4. NOT INCLUDED -- four ambiguous ceramic names, left alone on purpose
-- ==========================================================================
-- These are all currently 'wash' and none of them match the patterns above:
--
--   'Ceramic'              11 sites (CT / Long Island), target_cpc 0.06-0.32.
--                          That is a-la-carte money, so these are probably
--                          mislabelled the same way Graphene was -- but the
--                          name is bare enough that it could equally be a wash
--                          tier. Uncomment below if it is the add-on.
--   'Ceramic Sealant'      westhaven, 1.06 -- reads as a full wash.
--   'Ceramic Suds'         newhaven, 0.50 -- reads as a full wash.
--   'Ceramic+Bubble Bath'  guilderland, 0.68 -- a bundle whose name contains a
--                          base wash; almost certainly a wash tier.
--   'Bubble Bath + Ceramic' same shape as above.
--
-- update inventory.packages
-- set package_type = 'addon'
-- where lower(name) = 'ceramic'
--   and package_type <> 'addon';


-- ==========================================================================
-- 5. VERIFY -- re-run after 1-3. Every row below should read 'addon'.
-- ==========================================================================
select package_type, name, count(*) as sites
from inventory.packages
where name = 'Cer Add-On'
   or lower(name) in ('graphene', 'graphine')
   or lower(name) ~ '^cer[^a-z]*(pkg|pack)\.?$'
group by package_type, name
order by package_type, name;

-- And nothing ceramic/graphene should still be sitting in 'wash':
select location_code, name, package_type, target_cpc
from inventory.packages
where package_type = 'wash'
  and (lower(name) like '%cer%' or lower(name) like '%graph%')
order by location_code, name;
