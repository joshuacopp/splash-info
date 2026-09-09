-- ===========================================================================
-- inventory suppliers, step 2 of 4: duplicate review (READ ONLY -- APPLIES NOTHING)
-- ===========================================================================
-- WHY
--   The brief is explicit: do not infer duplicate groups from name similarity.
--   This file does not decide anything. It surfaces evidence so Josh can assign
--   splash_codes by hand. Every query here is a SELECT. There is no BEGIN, no
--   DDL, no DML. Running the whole file changes nothing.
--
-- WHAT THE DATA ACTUALLY LOOKS LIKE (as of 2026-09-03)
--   465 products. ZERO normalised-name collisions -- every name is distinct
--   even after lowercasing and stripping all punctuation. Zero identical
--   descriptions. So a dedup keyed on name will find nothing, and the
--   duplication is NOT where you would look for it first.
--
--   It is in three places instead:
--     A. vendor-coded row vs bare-name row for one chemical, cross-identified
--        by the coded row's description (DS-X55-CS "X55 Drying Agent" vs X55)
--     B. the UF series: L-UFnnn-CS vs UFnnn, 21 pairs
--     C. pack-size siblings under one vendor code (TL-ESSENCE -5/-15/-30/-CS)
--
--   335 of 465 products (72%) are referenced by NOTHING -- no location_products,
--   no package_products, no inventory_entries. Three entire vendor catalogues
--   (MC 58, QC 37, CK 33) were loaded and never used once. Retire those before
--   assigning codes; it cuts the review surface from 465 to 130.
--
-- HOW TO USE
--   Run Q1 first and retire the orphans. Then run Q2/Q3/Q4 and fill in the
--   splash_code column. Q7 turns your filled-in sheet into the UPDATE
--   statements. Nothing is applied until you run those yourself.
-- ===========================================================================


-- Q1. Retire-first list: products referenced by nothing at all ---------------
-- 335 rows expected. These can be deleted or ignored; either way they should
-- not consume review attention.
select p.id,
       p.name,
       p.description,
       p.price_per_ml,
       split_part(p.name, '-', 1) as vendor_prefix
  from inventory.products p
 where not exists (select 1 from inventory.location_products  x where x.product_id = p.id)
   and not exists (select 1 from inventory.package_products   x where x.product_id = p.id)
   and not exists (select 1 from inventory.inventory_entries  x where x.product_id = p.id)
 order by vendor_prefix, p.name;


-- Q2. THE REVIEW SHEET: every referenced product with its full usage ---------
-- 130 rows expected. This is the sheet to fill in. Export it, add a
-- splash_code column, and hand it back.
--
-- Read the columns as: can I retire this (low refs), and is it the same
-- chemical as the row above it (similar price, related name)?
select p.id,
       p.name,
       p.description,
       p.price_per_ml,
       split_part(p.name, '-', 1)                     as vendor_prefix,
       (select count(*) from inventory.location_products x where x.product_id = p.id) as loc_products,
       (select count(*) from inventory.package_products  x where x.product_id = p.id) as pkg_products,
       (select count(*) from inventory.inventory_entries x where x.product_id = p.id) as entries,
       (select count(distinct sv.location_code)
          from inventory.inventory_entries ie
          join inventory.site_visits sv on sv.id = ie.site_visit_id
         where ie.product_id = p.id)                   as distinct_locations,
       (select min(sv.visit_date)
          from inventory.inventory_entries ie
          join inventory.site_visits sv on sv.id = ie.site_visit_id
         where ie.product_id = p.id)                   as first_used,
       (select max(sv.visit_date)
          from inventory.inventory_entries ie
          join inventory.site_visits sv on sv.id = ie.site_visit_id
         where ie.product_id = p.id)                   as last_used,
       p.splash_code                                    as splash_code_ASSIGN_ME
  from inventory.products p
 where exists (select 1 from inventory.location_products  x where x.product_id = p.id)
    or exists (select 1 from inventory.package_products   x where x.product_id = p.id)
    or exists (select 1 from inventory.inventory_entries  x where x.product_id = p.id)
 order by entries desc, p.name;


-- Q3. Axis A/B candidates: coded row whose DESCRIPTION names a bare row ------
-- This is the strongest signal in the dataset and it is textual evidence, not
-- a similarity guess: the vendor-coded row's description literally contains
-- the other row's name.
--
-- Judge these on the price ratio. Real supplier pairs cluster tightly:
--   ~1.446  (X55, Flash Wax White, Rust Repel)
--   ~1.127  (Clean Foam, HP300, Results 2x)
--   ~1.4845 (every single UF pair -- 21 of them, identical ratio)
-- A ratio far off those clusters is more likely a different chemical.
select coded.id                                as coded_id,
       coded.name                              as coded_name,
       coded.description                       as coded_desc,
       coded.price_per_ml                      as coded_price,
       bare.id                                 as bare_id,
       bare.name                               as bare_name,
       bare.price_per_ml                       as bare_price,
       round(coded.price_per_ml / nullif(bare.price_per_ml, 0), 4) as price_ratio,
       (select count(*) from inventory.inventory_entries x where x.product_id = coded.id) as coded_entries,
       (select count(*) from inventory.inventory_entries x where x.product_id = bare.id)  as bare_entries
  from inventory.products coded
  join inventory.products bare
    on bare.id <> coded.id
   and coded.description is not null
   and length(bare.name) >= 3
   and lower(coded.description) like '%' || lower(bare.name) || '%'
 order by price_ratio, coded.name;


-- Q4. Axis C: pack-size siblings under one vendor code -----------------------
-- Same vendor + same base code, different pack suffix. Almost certainly one
-- chemical in different containers -- which is what supplier_products models
-- as separate OFFERINGS of one product, not as separate products.
--
-- NOTE: unit_type cannot be used for this. It is 97% NULL (452 of 465) and 11
-- of the 13 populated rows all say '5gal case'. Pack size lives in the name
-- suffix and nowhere else.
with base as (
  select p.id, p.name, p.description, p.price_per_ml,
         regexp_replace(p.name, '\s*-\s*(CS|[0-9]+\s*(gal|gl)?)\s*$', '', 'i') as base_code
    from inventory.products p
)
select b.base_code,
       count(*)                                  as variants,
       string_agg(b.name || ' @' || b.price_per_ml::text, '  |  ' order by b.name) as members,
       sum((select count(*) from inventory.inventory_entries x where x.product_id = b.id)) as total_entries
  from base b
 group by b.base_code
having count(*) > 1
 order by total_entries desc, b.base_code;


-- Q5. Merge-collision preflight ---------------------------------------------
-- Before collapsing any group, prove no composite UNIQUE would be violated.
-- Run this AFTER assigning splash_codes: it groups by splash_code and counts
-- rows that would collide.
--
-- As of 2026-09-03 all 36 observed candidate groups return zero on all three
-- counts -- the estate is supplier-partitioned by territory, so no location has
-- ever been billed both forms of the same chemical. Re-verify anyway; that
-- fact is data, not a guarantee.
select p.splash_code,
       (select count(*) from (
          select lp.location_code
            from inventory.location_products lp
            join inventory.products q on q.id = lp.product_id
           where q.splash_code = p.splash_code
           group by lp.location_code having count(*) > 1) z)      as location_products_collisions,
       (select count(*) from (
          select pp.package_id
            from inventory.package_products pp
            join inventory.products q on q.id = pp.product_id
           where q.splash_code = p.splash_code
           group by pp.package_id having count(*) > 1) z)         as package_products_collisions,
       (select count(*) from (
          select ie.site_visit_id
            from inventory.inventory_entries ie
            join inventory.products q on q.id = ie.product_id
           where q.splash_code = p.splash_code
           group by ie.site_visit_id having count(*) > 1) z)      as inventory_entries_collisions
  from inventory.products p
 where p.splash_code is not null
 group by p.splash_code
 order by p.splash_code;


-- Q6. Observed vendor prefixes -> candidate inventory.suppliers rows ---------
-- Evidence for which prefixes are real distributors. Confirm before inserting;
-- MC / QC / CK are entirely unreferenced and may not be live relationships
-- at all.
select split_part(p.name, '-', 1)                       as prefix,
       count(*)                                          as products,
       count(*) filter (where not exists (
         select 1 from inventory.inventory_entries x where x.product_id = p.id)) as unused_products,
       sum((select count(*) from inventory.inventory_entries x where x.product_id = p.id)) as entries
  from inventory.products p
 group by 1
 order by entries desc nulls last, products desc;


-- Q7. Template: turn the filled-in sheet into UPDATEs ------------------------
-- NOT EXECUTED. Copy, fill in real values, run separately.
--
--   update inventory.products set splash_code = 'X55'      where id = 'c8aa2fc8-...';
--   update inventory.products set splash_code = 'X55'      where id = '9c4a680c-...';
--   update inventory.products set splash_code = 'FLASHWAX' where id = '3f43bc66-...';
--
-- Assign the SAME splash_code to every product that is the same physical
-- chemical. Leave splash_code NULL for anything you are not sure about --
-- NULL is a legitimate, permanent state and the unique constraint permits
-- many of them. Do not guess to make the sheet look complete.
