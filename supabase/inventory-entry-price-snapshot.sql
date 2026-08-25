-- ============================================================================
-- Snapshot the chemical price onto each inventory entry.
--
-- RUN THIS FIRST -- it is step 1 of 3, in this order:
--
--   1. THIS FILE                          (adds the column, backfills, views)
--   2. inventory-save-visit-rpc.sql       (the function that reads the column)
--   3. git push                           (CI deploys the worker that calls it)
--
-- Two separate reasons the order is hard:
--
--   1. Step 2 will not compile against a database without this column -- the
--      function body selects and inserts price_per_ml -- and the deployed worker
--      writes every visit through that function, so getting the order wrong
--      means filing OR editing any visit fails outright. Deploys go out on a git
--      push, so both SQL files have to be applied before the push lands.
--   2. Until this file has run there is no record anywhere of what a chemical
--      cost on the day of a visit, and the first price change destroys that
--      information permanently.
--
-- WHY
--
-- inventory.inventory_entries stores quantities and a discount but not a price.
-- Cost has always been derived by joining to inventory.products and reading
-- price_per_ml as it stands RIGHT NOW -- see inventory.inventory_entry_calc
-- below, and src/lib/calc.js line 136, which is the path the app and the visit
-- report email actually render from.
--
-- The consequence is that a price change is retroactive to the beginning of
-- time. Change one chemical's price and every visit that ever used it reports a
-- different chemical cost, a different blended CPC and a different delivery
-- value than it did yesterday -- including visits already emailed out to site
-- managers, whose numbers now disagree with the report in their inbox. Nothing
-- warns anyone; the figures simply change.
--
-- That was survivable while repricing meant opening one product at a time. The
-- bulk editor makes it a routine monthly action, so the price has to be pinned
-- to the entry.
--
-- Note the precedent: `discount` is ALREADY stored per entry rather than read
-- off location_products at display time, for exactly this reason. This column
-- finishes the job that one started.
--
-- WHAT THIS DOES NOT DO
--
-- It does not recover history. There is no record of past prices, so the
-- backfill uses the current one. That is not a guess dressed up as data -- the
-- current price is precisely what every past visit is reporting today, so
-- freezing it changes no figure anywhere. Every number in the app and in every
-- past report reads identically before and after this migration. What changes
-- is only that they stop moving.
--
-- SAFE TO RE-RUN. Both statements are guarded; the backfill only ever fills
-- NULLs, so re-running cannot overwrite a snapshot that is already set.
-- ============================================================================

-- 1. The column ------------------------------------------------------------
--
-- Nullable on purpose. A NOT NULL default of 0 would silently price a chemical
-- at free if any writer ever missed it, and 0 is a legal price (see the Viper
-- Shine rows at 100% discount), so nothing downstream would catch it. NULL is
-- unambiguous -- it means "no snapshot", and the readers below fall back to the
-- product's current price, i.e. exactly today's behaviour. A row that somehow
-- misses a snapshot therefore degrades to the old semantics rather than to a
-- wrong number.
alter table inventory.inventory_entries
  add column if not exists price_per_ml numeric check (price_per_ml >= 0);

comment on column inventory.inventory_entries.price_per_ml is
  'Price per ml as of the visit, captured server-side at submit. Immutable once '
  'set: editing a visit deletes and re-inserts its entries but carries the '
  'snapshot across (inventory.save_visit), and changing '
  'inventory.products.price_per_ml does not touch it. NULL means no snapshot, '
  'in which case readers fall back to the product''s current price.';

-- 2. Backfill --------------------------------------------------------------
--
-- `where price_per_ml is null` is what makes this idempotent AND what makes it
-- safe: it can only ever add a snapshot, never replace one. If this file is run
-- again after a price change, the rows already pinned keep the price they were
-- pinned at.
update inventory.inventory_entries ie
   set price_per_ml = p.price_per_ml
  from inventory.products p
 where p.id = ie.product_id
   and ie.price_per_ml is null;

-- 3. Teach the views to prefer the snapshot --------------------------------
--
-- coalesce, not a straight swap, so the pre-backfill and un-snapshotted cases
-- behave exactly as they do today rather than costing out at NULL.
--
-- The app does not read these views -- the worker selects the raw tables and
-- calc.js does the arithmetic -- but they are the SQL statement of the same
-- model and calc.js's header promises it mirrors them. Leaving them on the live
-- product price would make that comment false and would quietly hand a
-- different chemical_cost to anything querying visit_summary directly.
create or replace view inventory.inventory_entry_calc as
  select
    ie.id,
    ie.site_visit_id,
    ie.product_id,
    sv.location_code,
    p.name  as product_name,
    coalesce(ie.price_per_ml, p.price_per_ml) as price_per_ml,
    ie.starting_qty_gal,
    ie.qty_delivered_gal,
    ie.reservoir_count_gal,
    ie.floor_count_gal,
    ie.ending_qty_gal,
    ie.discount,
    (ie.starting_qty_gal + ie.qty_delivered_gal - ie.ending_qty_gal)               as usage_gal,
    inventory.gal_to_ml(ie.starting_qty_gal + ie.qty_delivered_gal - ie.ending_qty_gal)
      * coalesce(ie.price_per_ml, p.price_per_ml) * (1 - ie.discount)              as cost,
    inventory.gal_to_ml(ie.ending_qty_gal)
      * coalesce(ie.price_per_ml, p.price_per_ml) * (1 - ie.discount)              as on_hand_value,
    lp.target_ml_per_car,
    vt.total_wash_count,
    case when vt.total_wash_count > 0
         then inventory.gal_to_ml(ie.starting_qty_gal + ie.qty_delivered_gal - ie.ending_qty_gal)
              / vt.total_wash_count
         else null end                                                            as actual_ml_per_car,
    -- usage >15% over target
    case when lp.target_ml_per_car is not null and lp.target_ml_per_car > 0
              and vt.total_wash_count > 0
              and inventory.gal_to_ml(ie.starting_qty_gal + ie.qty_delivered_gal - ie.ending_qty_gal)
                  / vt.total_wash_count > lp.target_ml_per_car * 1.15
         then true else false end                                                 as over_target_flag,
    -- reconciliation only meaningful when physical counts were recorded
    case when ie.reservoir_count_gal is not null and ie.floor_count_gal is not null
              and abs((ie.reservoir_count_gal + ie.floor_count_gal) - ie.ending_qty_gal) > 0.05
         then true else false end                                                 as reconciliation_flag
  from inventory.inventory_entries ie
  join inventory.site_visits sv on sv.id = ie.site_visit_id
  join inventory.products    p  on p.id  = ie.product_id
  left join inventory.location_products lp
         on lp.location_code = sv.location_code and lp.product_id = ie.product_id
  left join inventory.visit_wash_totals vt on vt.site_visit_id = ie.site_visit_id;

-- 4. Confirm ---------------------------------------------------------------
--
-- Expect missing_snapshot = 0. Anything else means a product row was deleted
-- out from under an entry, which the on-delete-restrict FK is supposed to make
-- impossible -- worth looking at before trusting the backfill.
select
  count(*)                                        as entries,
  count(*) filter (where price_per_ml is null)    as missing_snapshot,
  count(distinct product_id)                      as products_priced
from inventory.inventory_entries;
