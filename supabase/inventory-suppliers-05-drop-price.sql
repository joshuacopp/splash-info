-- ===========================================================================
-- inventory suppliers, step 5 of 5: drop products.price_per_ml
-- ===========================================================================
-- DO NOT RUN THIS UNTIL ALL THREE ARE TRUE
--   1. inventory-suppliers-04-readers.sql has been applied to THIS database.
--   2. The worker carrying the 04 shape is DEPLOYED (not merged -- deployed).
--   3. The AdminProducts price editor and worker db.ts price writers have been
--      repointed at inventory.supplier_products. Until then this file breaks
--      every product price edit, because those writers UPDATE the column this
--      file removes.
--
-- WHY IT IS SEPARATE AND LAST
--   Dropping the column is the only irreversible step in the series. 01-04 are
--   all additive or replace-in-place: applied out of order they are recoverable.
--   This one is not -- once the column is gone, the price of record lives only
--   in supplier_products, and the rollback script can restore the column but
--   only from the legacy seed, not from whatever the column held at drop time
--   (they are the same today -- see 03-backfill -- but that is a coincidence,
--   not a guarantee).
--
--   Applying this BEFORE 04 takes down:
--     - inventory.save_visit()      line 131 reads p.price_per_ml
--     - inventory.inventory_entry_calc  reads it three times
--   Both are server-side. Every visit submit and edit starts failing with
--   "column p.price_per_ml does not exist", and the entire costing engine --
--   inventory_entry_calc -> visit_summary -> location_latest_visit -- errors
--   on select. No amount of app-code care prevents that.
--
-- WHAT THIS FILE DOES
--   1. Refuses to run unless the 04 shape is actually in place (section 1).
--   2. Refuses to run if any live app path would lose data (section 2).
--   3. Drops the column.
--
-- SAFE TO RE-RUN -- yes, but only in the trivial sense: the second run finds
--   the column already gone and the guards short-circuit. There is no undo
--   inside this file. See inventory-suppliers-rollback.sql.
-- ===========================================================================

begin;

-- 1. Preflight: is the 04 shape actually applied? ---------------------------
-- Checking the catalog, not trusting the runbook. The reader rewrite is what
-- makes this drop survivable, so its absence must abort rather than warn.

do $$
declare
  v_col_exists     boolean;
  v_resolver       boolean;
  v_calc_reads_p   boolean;
  v_savevisit_p    boolean;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'inventory'
       and table_name   = 'products'
       and column_name  = 'price_per_ml'
  ) into v_col_exists;

  if not v_col_exists then
    raise notice 'inventory.products.price_per_ml is already dropped. Nothing to do.';
    return;
  end if;

  -- The resolver function introduced by 04.
  select exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'inventory'
       and p.proname = 'resolve_price_per_ml'
  ) into v_resolver;

  if not v_resolver then
    raise exception
      'ABORT: inventory.resolve_price_per_ml() does not exist. '
      'inventory-suppliers-04-readers.sql has not been applied to this '
      'database. Dropping price_per_ml now would break save_visit() and the '
      'entire inventory_entry_calc -> visit_summary -> location_latest_visit '
      'chain.';
  end if;

  -- The view definition must no longer mention the column. pg_get_viewdef
  -- returns the rewritten, fully-qualified body, so a surviving reference is
  -- unambiguous.
  select pg_get_viewdef('inventory.inventory_entry_calc'::regclass, true)
         ~* 'products?\.price_per_ml|p\.price_per_ml'
    into v_calc_reads_p;

  if v_calc_reads_p then
    raise exception
      'ABORT: inventory.inventory_entry_calc still reads products.price_per_ml. '
      'The 04 reader rewrite did not take. Dropping the column would leave the '
      'view uncompilable.';
  end if;

  -- Same for the function body -- but pg_proc.prosrc stores the body VERBATIM,
  -- comments included, and save_visit is heavily commented. A naive match would
  -- fire on any comment that merely mentions the old expression, making this
  -- file permanently unrunnable for a reason that looks like a real failure.
  -- Strip `--` line comments before matching. (Block comments and string
  -- literals are not stripped; neither appears in this function, and a guard
  -- that over-reports is the right way to be wrong here.)
  select exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'inventory'
       and p.proname = 'save_visit'
       and regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g')
             ~* 'p\.price_per_ml'
  ) into v_savevisit_p;

  if v_savevisit_p then
    raise exception
      'ABORT: inventory.save_visit() still reads p.price_per_ml. The 04 '
      'rewrite did not take. Every visit submit and edit would fail the '
      'moment this column is dropped.';
  end if;
end $$;

-- 2. Preflight: would anything lose its price? ------------------------------
-- The column is about to stop being the price of record. Prove supplier_products
-- can answer for every product that anything actually references.

do $$
declare
  v_no_offering  bigint;
  v_null_snap    bigint;
  v_unresolvable bigint;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema='inventory' and table_name='products'
       and column_name='price_per_ml'
  ) then
    return;   -- already dropped; section 1 said so.
  end if;

  -- Every referenced product needs at least one offering to resolve against.
  -- Orphans (the 335 from 02-review) are deliberately exempt: nothing costs
  -- them, so a missing price cannot move a number.
  select count(*) into v_no_offering
    from inventory.products p
   where not exists (select 1 from inventory.supplier_products sp
                      where sp.product_id = p.id)
     and (exists (select 1 from inventory.location_products x where x.product_id = p.id)
       or exists (select 1 from inventory.package_products  x where x.product_id = p.id)
       or exists (select 1 from inventory.inventory_entries x where x.product_id = p.id));

  if v_no_offering > 0 then
    raise exception
      'ABORT: % referenced products have no inventory.supplier_products row. '
      'After this drop they have no price anywhere and their cost silently '
      'becomes zero. Run 03-backfill first.', v_no_offering;
  end if;

  -- Historical cost must be carried by the entry snapshot, not by this column.
  select count(*) into v_null_snap
    from inventory.inventory_entries where price_per_ml is null;

  if v_null_snap > 0 then
    raise exception
      'ABORT: % inventory_entries have a NULL price snapshot. Their cost is '
      'currently supplied by the fallback to products.price_per_ml, which this '
      'file removes. Run 03-backfill first.', v_null_snap;
  end if;

  -- Forward-looking: a NEW entry filed after the drop resolves through
  -- supplier_products. Anything the resolver cannot answer for today would be
  -- written with a NULL price tomorrow.
  select count(*) into v_unresolvable
    from inventory.location_products lp
   where inventory.resolve_price_per_ml(lp.location_code, lp.product_id, current_date) is null;

  if v_unresolvable > 0 then
    raise exception
      'ABORT: % location_products rows resolve to a NULL price as of today. '
      'New visits at those sites would file entries with no cost. Inspect '
      'inventory.location_product_price_resolved where resolution in '
      '(''ambiguous'',''unpriced'').', v_unresolvable;
  end if;
end $$;

-- 3. The drop ---------------------------------------------------------------
-- No CASCADE. If a dependency was missed, this fails loudly and names it --
-- which is exactly what we want. CASCADE would silently delete whatever it
-- found, and the things that depend on this column are views the dashboard
-- is built on.
--
-- This also silently takes the column's CHECK constraint with it
-- (products_price_per_ml_check, `price_per_ml >= 0`). That is unavoidable and
-- fine going forward -- supplier_products carries its own `>= 0` check -- but
-- it is easy to forget on the way back. inventory-suppliers-rollback.sql
-- section 1 reinstates it explicitly.

alter table inventory.products
  drop column if exists price_per_ml;

do $$
begin
  raise notice 'inventory-suppliers-05-drop-price applied. products.price_per_ml is gone; '
               'supplier_products is now the sole price of record.';
end $$;

commit;

-- Confirm -------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_schema='inventory' and table_name='products'
      and column_name='price_per_ml')                        as price_col_remaining,
  (select count(*) from inventory.products)                  as products,
  (select count(*) from inventory.supplier_products)         as offerings,
  (select count(*) from inventory.inventory_entries
    where price_per_ml is null)                              as entries_missing_snapshot,
  (select count(*) from inventory.location_product_price_resolved
    where resolution in ('ambiguous','unpriced'))            as unresolved_location_products;
