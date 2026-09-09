-- ===========================================================================
-- inventory suppliers: ROLLBACK
-- ===========================================================================
-- There is no rollback script anywhere else in supabase/. This file sets the
-- precedent, so it states its own rules explicitly rather than assuming a
-- house convention exists.
--
-- WHAT "ROLLBACK" CAN AND CANNOT MEAN HERE
--   01, 02 and 04 are fully reversible. 02 applies nothing at all.
--   03 and 05 are NOT symmetric with their forward files:
--     - 03's snapshot backfill is deliberately NOT undone. Re-NULLing
--       inventory_entries.price_per_ml would destroy the only record of what a
--       chemical cost on the day of a visit and re-arm the live-price fallback.
--       Those snapshots were already there before this series started (all
--       22,757 of them) and are not this series' to remove.
--     - 05's drop is restored FROM THE LEGACY SEED, not from the values the
--       column held at drop time. Those are the same today (03 seeds the legacy
--       offering from the column, and 03's own guard proves zero drift), but if
--       anyone edited a price through supplier_products after 05 ran, this
--       restores the CURRENT effective price, not the historical one. That is
--       the correct choice -- the current price is the one the app needs to
--       keep working -- but it is a real difference and you should know about it
--       before running section 1.
--
-- SECTIONS ARE INDEPENDENT AND ORDERED BY BLAST RADIUS
--   Run only the sections you need, bottom-up relative to the forward series:
--     Section 1  undo 05  restore products.price_per_ml
--     Section 2  undo 04  restore inventory_entry_calc and save_visit
--     Section 3  undo 03  remove the legacy seed rows (NOT the snapshots)
--     Section 4  undo 01  drop the new tables and columns
--   Running section 4 without section 2 leaves inventory_entry_calc calling a
--   function that no longer exists -- the costing engine errors on every select.
--   Section 4 refuses to run if that is the case.
--
-- WHAT THIS CANNOT UNDO
--   splash_code values assigned by hand. Section 4 drops the column and every
--   value in it. EXPORT THEM FIRST:
--     select id, name, splash_code from inventory.products
--      where splash_code is not null;
--   Same for location_products.supplier_id pins. Section 4 warns and aborts if
--   either holds data, so this cannot happen by accident -- see the FORCE flag.
--
-- HOW TO FORCE PAST THE DATA GUARDS
--   Section 4 aborts when splash_code or supplier_id is populated. If you have
--   exported them and genuinely want them gone, uncomment the single line
--   marked FORCE inside that section. It is commented out on purpose: a
--   rollback that silently discards hand-assigned mapping work would be worse
--   than one that stops.
-- ===========================================================================


-- ===========================================================================
-- SECTION 1 -- undo 05-drop-price: restore inventory.products.price_per_ml
-- ===========================================================================
-- Only needed if 05 actually ran. No-op otherwise.
--
-- The column comes back at the END of the column list, not in its original
-- third position. Postgres cannot reinsert a column mid-table. Nothing in this
-- codebase depends on ordinal position -- PostgREST selects by name and every
-- reader in the app names its columns -- but a `select *` snapshot taken before
-- and after will differ in column order.

begin;

do $$
declare
  v_exists    boolean;
  v_no_price  bigint;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema='inventory' and table_name='products'
       and column_name='price_per_ml'
  ) into v_exists;

  if v_exists then
    raise notice 'SECTION 1: products.price_per_ml already present. Nothing to do.';
    return;
  end if;

  -- The original column is NOT NULL with no default, so every product must have
  -- a restorable price BEFORE the constraint goes back on. Check first: adding
  -- the column and then failing the SET NOT NULL would leave the table in a
  -- half-restored state inside a transaction that then rolls back anyway --
  -- but the error would name the constraint, not the cause.
  select count(*) into v_no_price
    from inventory.products p
   where not exists (
     select 1 from inventory.supplier_products sp
      where sp.product_id = p.id and sp.effective_date <= current_date);

  if v_no_price > 0 then
    raise exception
      'ABORT: % products have no supplier_products offering effective today, '
      'so their price cannot be restored and the NOT NULL constraint cannot be '
      'reinstated. Seed those offerings first, or restore from a backup.',
      v_no_price;
  end if;

  execute 'alter table inventory.products add column price_per_ml numeric';

  -- Latest effective offering per product. Ties break on lowest price then id,
  -- matching inventory.resolve_price_per_ml exactly so the restored column
  -- agrees with whatever the resolver has been returning.
  execute $q$
    update inventory.products p
       set price_per_ml = x.price_per_ml
      from (
        select distinct on (sp.product_id)
               sp.product_id, sp.price_per_ml
          from inventory.supplier_products sp
         where sp.effective_date <= current_date
         order by sp.product_id, sp.effective_date desc, sp.price_per_ml asc, sp.id
      ) x
     where x.product_id = p.id
  $q$;

  execute 'alter table inventory.products alter column price_per_ml set not null';

  -- The original column carried a CHECK too. Dropping the column in 05 dropped
  -- the constraint with it, silently -- a restore that forgets this leaves the
  -- table accepting negative prices, which nothing downstream would flag.
  -- Name matched to what Postgres generated originally, so a re-run of the
  -- forward series sees the same constraint name it expects.
  if not exists (
    select 1 from pg_constraint
     where conname = 'products_price_per_ml_check'
       and conrelid = 'inventory.products'::regclass
  ) then
    execute 'alter table inventory.products
               add constraint products_price_per_ml_check
               check (price_per_ml >= 0)';
  end if;

  raise notice 'SECTION 1: products.price_per_ml restored from supplier_products, '
               'NOT NULL and >= 0 check reinstated.';
end $$;

commit;


-- ===========================================================================
-- SECTION 2 -- undo 04-readers: put the original definitions back
-- ===========================================================================
-- REQUIRES products.price_per_ml to exist. Run section 1 first if 05 ran.
--
-- Both bodies below are the pre-migration definitions, taken from the live
-- catalog on 2026-09-03 (inventory_entry_calc) and from
-- inventory-save-visit-rpc.sql (save_visit). They are reproduced here in full
-- rather than referenced, because a rollback that tells you to "go re-run the
-- other file" is not a rollback.

begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema='inventory' and table_name='products'
       and column_name='price_per_ml'
  ) then
    raise exception
      'ABORT: inventory.products.price_per_ml does not exist. The definitions '
      'restored by this section read it directly and would not compile. Run '
      'SECTION 1 of this file first.';
  end if;
end $$;

-- 2a. inventory_entry_calc, original ----------------------------------------
-- Same 20 columns, same order. The three resolve_price_per_ml() calls become
-- p.price_per_ml again.

create or replace view inventory.inventory_entry_calc as
  select
    ie.id,
    ie.site_visit_id,
    ie.product_id,
    sv.location_code,
    p.name  as product_name,
    coalesce(ie.price_per_ml, p.price_per_ml)                                     as price_per_ml,
    ie.starting_qty_gal,
    ie.qty_delivered_gal,
    ie.reservoir_count_gal,
    ie.floor_count_gal,
    ie.ending_qty_gal,
    ie.discount,
    (ie.starting_qty_gal + ie.qty_delivered_gal - ie.ending_qty_gal)               as usage_gal,
    inventory.gal_to_ml(ie.starting_qty_gal + ie.qty_delivered_gal - ie.ending_qty_gal)
      * coalesce(ie.price_per_ml, p.price_per_ml)
      * (1 - ie.discount)                                                         as cost,
    inventory.gal_to_ml(ie.ending_qty_gal)
      * coalesce(ie.price_per_ml, p.price_per_ml)
      * (1 - ie.discount)                                                         as on_hand_value,
    lp.target_ml_per_car,
    vt.total_wash_count,
    case when vt.total_wash_count > 0
         then inventory.gal_to_ml(ie.starting_qty_gal + ie.qty_delivered_gal - ie.ending_qty_gal)
              / vt.total_wash_count
         else null end                                                            as actual_ml_per_car,
    case when lp.target_ml_per_car is not null and lp.target_ml_per_car > 0
              and vt.total_wash_count > 0
              and inventory.gal_to_ml(ie.starting_qty_gal + ie.qty_delivered_gal - ie.ending_qty_gal)
                  / vt.total_wash_count > lp.target_ml_per_car * 1.15
         then true else false end                                                 as over_target_flag,
    case when ie.reservoir_count_gal is not null and ie.floor_count_gal is not null
              and abs((ie.reservoir_count_gal + ie.floor_count_gal) - ie.ending_qty_gal) > 0.05
         then true else false end                                                 as reconciliation_flag
  from inventory.inventory_entries ie
  join inventory.site_visits sv on sv.id = ie.site_visit_id
  join inventory.products    p  on p.id  = ie.product_id
  left join inventory.location_products lp
         on lp.location_code = sv.location_code and lp.product_id = ie.product_id
  left join inventory.visit_wash_totals vt on vt.site_visit_id = ie.site_visit_id;

grant select on inventory.inventory_entry_calc to service_role;

-- 2b. save_visit, original --------------------------------------------------
-- Verbatim from inventory-save-visit-rpc.sql. The v_location_code /
-- v_visit_date locals, the site_visits read-back, and the unpriced guard added
-- by 04 are all removed; line 131's p.price_per_ml fallback returns.

create or replace function inventory.save_visit(
  p_visit_id    uuid,
  p_visit       jsonb,
  p_entries     jsonb,
  p_wash_counts jsonb,
  p_create      boolean
) returns uuid
language plpgsql
as $$
declare
  v_prior jsonb;
  v_rows  integer;
begin
  if p_create then
    insert into inventory.site_visits (
      id, location_code, visit_date, submitter, notes, water_hardness_gpg, tds_ppm
    ) values (
      p_visit_id,
      p_visit ->> 'location_code',
      (p_visit ->> 'visit_date')::date,
      nullif(p_visit ->> 'submitter', ''),
      nullif(p_visit ->> 'notes', ''),
      (p_visit ->> 'water_hardness_gpg')::numeric,
      (p_visit ->> 'tds_ppm')::numeric
    );
  else
    update inventory.site_visits
       set visit_date         = (p_visit ->> 'visit_date')::date,
           submitter          = nullif(p_visit ->> 'submitter', ''),
           notes              = nullif(p_visit ->> 'notes', ''),
           water_hardness_gpg = (p_visit ->> 'water_hardness_gpg')::numeric,
           tds_ppm            = (p_visit ->> 'tds_ppm')::numeric
     where id = p_visit_id;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'visit % not found', p_visit_id
        using errcode = 'no_data_found';
    end if;
  end if;

  select coalesce(jsonb_object_agg(product_id::text, price_per_ml), '{}'::jsonb)
    into v_prior
    from inventory.inventory_entries
   where site_visit_id = p_visit_id
     and price_per_ml is not null;

  delete from inventory.inventory_entries where site_visit_id = p_visit_id;
  delete from inventory.wash_counts       where site_visit_id = p_visit_id;

  insert into inventory.inventory_entries (
    site_visit_id, product_id, price_per_ml,
    starting_qty_gal, qty_delivered_gal, reservoir_count_gal, floor_count_gal,
    ending_qty_gal, discount,
    metering_type, tip_color, versadial_number, injector_color, injector_gpm
  )
  select
    p_visit_id,
    (e ->> 'product_id')::uuid,
    coalesce((v_prior ->> ((e ->> 'product_id')::uuid)::text)::numeric, p.price_per_ml),
    coalesce((e ->> 'starting_qty_gal')::numeric,  0),
    coalesce((e ->> 'qty_delivered_gal')::numeric, 0),
    nullif(e ->> 'reservoir_count_gal', '')::numeric,
    nullif(e ->> 'floor_count_gal', '')::numeric,
    coalesce((e ->> 'ending_qty_gal')::numeric, 0),
    coalesce((e ->> 'discount')::numeric, 0),
    nullif(e ->> 'metering_type', ''),
    nullif(e ->> 'tip_color', ''),
    nullif(e ->> 'versadial_number', '')::integer,
    nullif(e ->> 'injector_color', ''),
    nullif(e ->> 'injector_gpm', '')::numeric
  from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) e
  left join inventory.products p on p.id = (e ->> 'product_id')::uuid;

  insert into inventory.wash_counts (site_visit_id, package_id, wash_count)
  select
    p_visit_id,
    (w ->> 'package_id')::uuid,
    coalesce((w ->> 'wash_count')::numeric, 0)::integer
  from jsonb_array_elements(coalesce(p_wash_counts, '[]'::jsonb)) w
  where nullif(w ->> 'package_id', '') is not null;

  return p_visit_id;
end;
$$;

comment on function inventory.save_visit(uuid, jsonb, jsonb, jsonb, boolean) is
  'Creates or replaces a visit and its full set of entries and wash counts in '
  'one transaction. Preserves inventory_entries.price_per_ml across the '
  'delete/re-insert, so editing a visit never reprices it.';

grant execute on function inventory.save_visit(uuid, jsonb, jsonb, jsonb, boolean)
  to service_role;

-- 2c. the objects 04 introduced ---------------------------------------------
-- Dropped last, after nothing references them any more. Order matters: the
-- view calls the function.

drop view     if exists inventory.location_product_price_resolved;
drop function if exists inventory.resolve_price_per_ml(text, uuid, date);

do $$
begin
  raise notice 'SECTION 2: inventory_entry_calc and save_visit restored to pre-04 definitions.';
end $$;

commit;


-- ===========================================================================
-- SECTION 3 -- undo 03-backfill: remove the legacy seed
-- ===========================================================================
-- Deletes ONLY the sentinel-dated legacy offerings and the LEGACY supplier.
-- Real offerings entered since (effective_date <> 1900-01-01, or under any
-- other supplier) are left alone -- this section will abort rather than delete
-- work that was not part of the seed.
--
-- THE SNAPSHOT BACKFILL IS NOT UNDONE, deliberately. See the header.

begin;

do $$
declare
  v_legacy   uuid;
  v_non_seed bigint;
  v_deleted  bigint;
begin
  select id into v_legacy from inventory.suppliers where code = 'LEGACY';
  if v_legacy is null then
    raise notice 'SECTION 3: no LEGACY supplier. Nothing to do.';
    return;
  end if;

  -- Anything under LEGACY that is not the sentinel-dated seed row was added by
  -- hand and is not ours to remove.
  select count(*) into v_non_seed
    from inventory.supplier_products
   where supplier_id = v_legacy and effective_date <> date '1900-01-01';

  if v_non_seed > 0 then
    raise exception
      'ABORT: % supplier_products rows under LEGACY have a non-sentinel '
      'effective_date -- they were added after the seed. Remove or reassign '
      'them by hand first; this rollback will not delete them for you.',
      v_non_seed;
  end if;

  delete from inventory.supplier_products
   where supplier_id = v_legacy and effective_date = date '1900-01-01';
  get diagnostics v_deleted = row_count;

  delete from inventory.suppliers where id = v_legacy;

  raise notice 'SECTION 3: removed % legacy offerings and the LEGACY supplier. '
               'inventory_entries price snapshots were NOT touched.', v_deleted;
end $$;

commit;


-- ===========================================================================
-- SECTION 4 -- undo 01-tables: drop the new schema objects
-- ===========================================================================
-- Last, and the only section that destroys hand-entered mapping work. Read the
-- header before running.

begin;

-- The guard below is written so a SECOND run is a clean no-op rather than an
-- error: by then splash_code, supplier_id and supplier_products are gone, and a
-- direct `select ... from inventory.supplier_products` would fail 42P01 partway
-- through the block. Every count is therefore existence-checked first and run
-- through EXECUTE, so the reference is not resolved at parse time.

do $$
declare
  v_codes    bigint := 0;
  v_pins     bigint := 0;
  v_offers   bigint := 0;
  v_calc_ref boolean;
begin
  -- Refuse to leave the costing engine pointing at a function this section is
  -- about to drop.
  select pg_get_viewdef('inventory.inventory_entry_calc'::regclass, true)
         ~* 'resolve_price_per_ml' into v_calc_ref;
  if v_calc_ref then
    raise exception
      'ABORT: inventory.inventory_entry_calc still calls '
      'inventory.resolve_price_per_ml. Run SECTION 2 first or every select '
      'against the costing engine will error.';
  end if;

  if exists (select 1 from information_schema.columns
              where table_schema='inventory' and table_name='products'
                and column_name='splash_code') then
    execute 'select count(*) from inventory.products where splash_code is not null'
      into v_codes;
  end if;

  if exists (select 1 from information_schema.columns
              where table_schema='inventory' and table_name='location_products'
                and column_name='supplier_id') then
    execute 'select count(*) from inventory.location_products where supplier_id is not null'
      into v_pins;
  end if;

  if to_regclass('inventory.supplier_products') is not null then
    execute 'select count(*) from inventory.supplier_products' into v_offers;
  end if;

  if (v_codes > 0 or v_pins > 0 or v_offers > 0) then
    raise exception
      'ABORT: this section would destroy % assigned splash_codes, % supplier '
      'pins and % supplier offerings. Export them first:%  select id, name, '
      'splash_code from inventory.products where splash_code is not null;%  '
      'select location_code, product_id, supplier_id from '
      'inventory.location_products where supplier_id is not null;%'
      'To proceed anyway, delete this entire DO block and re-run the section.',
      v_codes, v_pins, v_offers, chr(10), chr(10), chr(10);
  end if;
end $$;

-- FORCE: there is no flag to flip. The guard above RAISES, so commenting a line
-- out below would not help -- if you have exported the data and genuinely want
-- it gone, delete the DO block above and re-run. Making that an edit rather
-- than an uncomment is the point: discarding hand-assigned mapping work should
-- take a deliberate act, not a one-character change.

drop view  if exists inventory.supplier_products_unmapped;

alter table inventory.location_products
  drop constraint if exists location_products_supplier_id_fkey;
alter table inventory.location_products
  drop column if exists supplier_id;

alter table inventory.products
  drop constraint if exists products_splash_code_key;
alter table inventory.products
  drop column if exists splash_code;

-- supplier_products first: it FKs suppliers.
drop table if exists inventory.supplier_products;
drop table if exists inventory.suppliers;

do $$
begin
  raise notice 'SECTION 4: all inventory-suppliers objects removed. The schema '
               'is back to its pre-migration shape.';
end $$;

commit;


-- Confirm -------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_schema='inventory' and table_name='products'
      and column_name='price_per_ml')                     as price_col_restored,
  (select count(*) from information_schema.columns
    where table_schema='inventory' and table_name='products'
      and column_name='splash_code')                      as splash_code_col_remaining,
  (select count(*) from information_schema.tables
    where table_schema='inventory'
      and table_name in ('suppliers','supplier_products')) as new_tables_remaining,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='inventory' and p.proname='resolve_price_per_ml') as resolver_remaining,
  (select count(*) from inventory.inventory_entries
    where price_per_ml is null)                           as entries_missing_snapshot;
