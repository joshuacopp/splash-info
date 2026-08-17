-- ============================================================================
-- Allow discount = 1 (i.e. free) on inventory.location_products and
-- inventory.inventory_entries.
--
-- RUN THIS BEFORE inventory-history-01-config.sql.
--
-- WHY
--
-- inventory-tables.sql wrote `check (discount >= 0 and discount < 1)` on both
-- tables, carried over verbatim from the standalone repo's 0002_v2_network.sql
-- lines 24-27. The exclusive upper bound rejects a 100% discount.
--
-- The live standalone data has two such rows -- both Viper Shine
-- (489a744d-8bc7-462f-bca0-c28cefa36453), target 22 ml/car, discount 1:
--
--     williamsville   Viper Shine   discount = 1
--     newark          Viper Shine   discount = 1
--
-- That is a real configuration, not corrupt data: the product is supplied at no
-- cost, so its contribution to CPC is zero. The rest of the import is clean --
-- the only other discount values anywhere in the 1,241 location_products and
-- 22,715 inventory_entries rows are 0, 0.1121675063, 0.2 and 0.25, and there
-- are no negatives.
--
-- So the constraint is what is wrong, and the fix is to widen it rather than to
-- edit two rows of history down to 0.99 or drop them.
--
-- NOT JUST AN IMPORT PROBLEM. `inventory_entries` has no discount = 1 rows
-- today, but it will the moment somebody records a visit at either site:
-- src/pages/NewVisit.jsx line 56 seeds each entry's discount from the
-- location_products row (`discount: num(lp.discount)`), and mapEntryRow in
-- worker/db.ts line 320 writes it straight through. The first Williamsville or
-- Newark visit that includes Viper Shine would fail on submit with the same
-- 23514. Both tables are widened here for that reason, not for symmetry.
--
-- SAFE DIRECTION. This only ADMITS values that were previously rejected, so no
-- existing row can be invalidated by it and nothing needs backfilling. The
-- lower bound and the exclusion of discount > 1 both stay: the multiplier
-- (1 - discount) used throughout inventory.inventory_entry_calc and
-- src/lib/calc.js stays in [0, 1], so cost, on_hand_value and CPC can reach
-- zero but never go negative.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1 -- what is there now. Empty tables return nothing; that is expected
-- if you have not run part 01 yet.
-- ---------------------------------------------------------------------------
select 'location_products' as tbl, discount, count(*)
  from inventory.location_products group by 1, 2
union all
select 'inventory_entries', discount, count(*)
  from inventory.inventory_entries group by 1, 2
 order by 1, 2;


-- ---------------------------------------------------------------------------
-- STEP 2 -- widen both constraints to include 1.
--
-- Names are the ones Postgres auto-generated in inventory-tables.sql, which is
-- what the error message quotes. Drop-then-add rather than a NOT VALID add,
-- because the tables are small and the check has to bind to new rows anyway.
-- ---------------------------------------------------------------------------
alter table inventory.location_products
  drop constraint if exists location_products_discount_check;
alter table inventory.location_products
  add constraint location_products_discount_check
  check (discount >= 0 and discount <= 1);

alter table inventory.inventory_entries
  drop constraint if exists inventory_entries_discount_check;
alter table inventory.inventory_entries
  add constraint inventory_entries_discount_check
  check (discount >= 0 and discount <= 1);


-- ---------------------------------------------------------------------------
-- STEP 3 -- verify. EXPECT two rows, both ending in `<= 1::numeric`.
-- ---------------------------------------------------------------------------
select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid) as def
  from pg_constraint
 where conname in ('location_products_discount_check',
                   'inventory_entries_discount_check')
 order by 1;


-- ============================================================================
-- FOLLOW-UP -- supabase/inventory-tables.sql still carries the old `< 1` on
-- lines 66 and 115. Worth correcting there too so a fresh project build does
-- not reintroduce this, since that file is the schema of record.
-- ============================================================================
