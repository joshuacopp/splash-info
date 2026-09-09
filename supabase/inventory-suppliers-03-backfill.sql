-- ===========================================================================
-- inventory suppliers, step 3 of 4: snapshot guard + legacy price seed
-- ===========================================================================
-- WHY THIS FILE RUNS BEFORE ANY READER CHANGE
--   The brief's stated fear: inventory_entries.price_per_ml is nullable and
--   presumably falls back to the product's live price, so merging products
--   first would silently re-cost historical site visits and move every trend
--   on the dashboard.
--
--   The fallback is REAL. Confirmed in three places:
--     inventory.inventory_entry_calc   coalesce(ie.price_per_ml, p.price_per_ml)  x3
--     inventory.save_visit()  line 131 coalesce(v_prior->>..., p.price_per_ml)
--     apps/inventory/src/lib/calc.js:227-228
--        const price = e.price_per_ml != null ? num(e.price_per_ml)
--                                             : product ? num(product.price_per_ml) : 0
--
--   BUT THE PREMISE IS CURRENTLY INVERTED, and this is the single most useful
--   thing the investigation turned up:
--
--     22,757 inventory_entries rows.  NULL price_per_ml: 0.  Drifted from the
--     product's current price: 0.  (Verified against the live DB 2026-09-03.)
--
--   supabase/inventory-entry-price-snapshot.sql already backfilled every row,
--   and inventory.save_visit() actively preserves those snapshots across the
--   delete/re-insert of a visit edit. So the re-costing blast radius is ZERO
--   TODAY and the fallback is inert.
--
--   That is not a reason to skip the backfill. It is a reason to make it a
--   GUARD. Between now and whenever this actually gets applied, any new entry
--   filed through a path that skips the snapshot re-arms the fallback. Section
--   1 costs nothing when there is nothing to do and closes the hole when there
--   is. Section 3 then refuses to continue if a NULL survived.
--
--   One caveat worth holding onto: snapshot == live price on all 22,757 rows
--   is a COINCIDENCE, not an invariant. All 465 products were seeded in a
--   single transaction (created_at is identical to the microsecond across
--   every row) and no price has been edited since. There is no trigger keeping
--   them in sync. The moment a price changes, the snapshot becomes genuinely
--   load-bearing -- which is exactly what it is for.
--
-- WHAT CHANGES
--   1. Backfills any NULL inventory_entries.price_per_ml from its OWN product's
--      current price. Idempotent via `where price_per_ml is null` -- it can
--      only ever add a snapshot, never overwrite one.
--   2. Seeds inventory.suppliers with a single LEGACY row and one
--      supplier_products row per product, preserving each price EXACTLY.
--   3. Aborts the transaction if either step left the data in a state that
--      would make 04-readers lossy.
--
--   No product is merged. No FK is repointed. No price changes value.
--
-- WHY A "LEGACY" SUPPLIER RATHER THAN SPLITTING BY VENDOR PREFIX
--   Deriving the supplier from the `DS-`/`TL-`/`CT-` name prefix would be
--   exactly the inference the brief forbids. This seed makes no claim about
--   who sold what. It says only: "this was the price of record before we
--   tracked suppliers." Josh reassigns supplier_id from the 02-review sheet
--   afterwards, and every reassignment is a visible UPDATE rather than a guess
--   baked into a migration.
--
-- ORDERING   01-tables -> 02-review -> [03-backfill] -> 04-readers -> 05-drop-price
-- SAFE TO RE-RUN  -- yes, BEFORE 05-drop-price. Both inserts are ON CONFLICT DO
--                    NOTHING and the update is null-guarded, so re-running is a
--                    no-op.
--
--                    NOT re-runnable AFTER 05, and it cannot be made so: every
--                    price in this file is read from products.price_per_ml,
--                    which 05 removes. Sections 1 and 2 would fail 42703. If
--                    you have rolled 05 back and need to re-seed, run
--                    inventory-suppliers-rollback.sql SECTION 1 first to
--                    restore the column. Section 0 below checks this and says
--                    so rather than letting you read a bare "column does not
--                    exist".
-- ===========================================================================

begin;

-- 0. Precondition -----------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'inventory' and table_name = 'products'
       and column_name  = 'price_per_ml'
  ) then
    raise exception
      'ABORT: inventory.products.price_per_ml does not exist, so there is no '
      'price for this file to snapshot or seed from. 05-drop-price has already '
      'run. Restore the column with inventory-suppliers-rollback.sql SECTION 1 '
      'before re-running this file.';
  end if;
end $$;

-- 1. Snapshot guard ---------------------------------------------------------
-- Straight from inventory-entry-price-snapshot.sql. Expected to affect 0 rows.
-- If it affects any, something has been writing entries without a price since
-- 2026-08-17 and that path needs finding before this series continues.

update inventory.inventory_entries ie
   set price_per_ml = p.price_per_ml
  from inventory.products p
 where p.id = ie.product_id
   and ie.price_per_ml is null;

-- 2. Legacy supplier + one offering per product -----------------------------
-- effective_date is the sentinel 1900-01-01, meaning "in force since forever".
-- It has to predate every site_visits.visit_date or a date-scoped price lookup
-- would find no row for historical visits and resolve to NULL. The earliest
-- visit_date in the table is 2002-08-13 (itself a mis-dated row -- one visit
-- carrying 16 entries, which is where the bogus 2002 first-seen dates on 15
-- high-volume products come from). The sentinel covers it either way.

insert into inventory.suppliers (name, code, active)
values ('Legacy / unattributed', 'LEGACY', true)
on conflict (code) do nothing;

insert into inventory.supplier_products
       (product_id, supplier_id, supplier_sku, supplier_desc, price_per_ml, effective_date)
select p.id,
       s.id,
       p.name,          -- the vendor-coded name IS the SKU we have on record
       p.description,   -- vendor's own wording, verbatim, nulls included
       p.price_per_ml,
       date '1900-01-01'
  from inventory.products p
 cross join (select id from inventory.suppliers where code = 'LEGACY') s
on conflict (supplier_id, supplier_sku, effective_date) do nothing;

-- 3. Abort guards -----------------------------------------------------------
-- RAISE EXCEPTION, not NOTICE: these are pasted into the Supabase dashboard
-- editor, which does not reliably surface NOTICE.

do $$
declare
  v_null_snapshots  bigint;
  v_unpriced        bigint;
  v_drift           bigint;
begin
  select count(*) into v_null_snapshots
    from inventory.inventory_entries where price_per_ml is null;
  if v_null_snapshots > 0 then
    raise exception
      'ABORT: % inventory_entries still have a NULL price snapshot after the '
      'backfill. Their product row is missing a price. Do NOT proceed to '
      '04-readers -- those entries would re-cost.', v_null_snapshots;
  end if;

  -- Every product must have at least one supplier offering, or 04-readers
  -- resolves it to NULL and its cost silently becomes zero.
  select count(*) into v_unpriced
    from inventory.products p
   where not exists (select 1 from inventory.supplier_products sp
                      where sp.product_id = p.id);
  if v_unpriced > 0 then
    raise exception
      'ABORT: % products have no supplier_products row. The legacy seed did '
      'not cover them.', v_unpriced;
  end if;

  -- The seeded offering must reproduce the current price to the cent.
  select count(*) into v_drift
    from inventory.products p
    join inventory.supplier_products sp
      on sp.product_id = p.id and sp.effective_date = date '1900-01-01'
   where sp.price_per_ml is distinct from p.price_per_ml;
  if v_drift > 0 then
    raise exception
      'ABORT: % legacy offerings do not match their product price. The seed '
      'is not faithful and applying 04-readers would change historical cost.',
      v_drift;
  end if;

  raise notice 'inventory-suppliers-03-backfill applied cleanly.';
end $$;

commit;

-- Confirm -------------------------------------------------------------------
select
  (select count(*) from inventory.inventory_entries)                          as entries,
  (select count(*) from inventory.inventory_entries where price_per_ml is null) as missing_snapshot,
  (select count(*) from inventory.products)                                    as products,
  (select count(*) from inventory.supplier_products)                           as supplier_offerings,
  (select count(*) from inventory.supplier_products where product_id is null)  as needs_mapping,
  (select count(*) from inventory.suppliers)                                   as suppliers;
