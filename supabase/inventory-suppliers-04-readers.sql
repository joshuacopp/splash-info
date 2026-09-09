-- ===========================================================================
-- inventory suppliers, step 4 of 5: readers stop reading products.price_per_ml
-- ===========================================================================
-- WHY THIS IS THE DANGEROUS FILE
--   Three server-side objects read inventory.products.price_per_ml directly.
--   No amount of care in the Svelte/React app protects them, because they run
--   inside Postgres:
--     1. inventory.inventory_entry_calc   -- 3 references (aliased col, cost,
--                                            on_hand_value)
--     2. inventory.save_visit()           -- line 131 fallback, line 150 join
--     3. (transitively) visit_summary and location_latest_visit, which are
--        built on inventory_entry_calc
--   Drop the column before this file lands and every visit save returns
--   "column p.price_per_ml does not exist" while the entire costing engine
--   returns 42703. This file must be applied, AND the worker redeployed,
--   before 05-drop-price.
--
-- WHY THERE IS NO DROP VIEW CASCADE HERE
--   greeter-capture-13.sql is the house template for this situation and it
--   drops the dependent views because it changes a column list. WE DO NOT.
--   inventory_entry_calc keeps all 20 columns, same names, same types, same
--   order -- only the expressions behind price_per_ml / cost / on_hand_value
--   change. Verified against the live catalog 2026-09-03. So `create or replace
--   view` is legal and is strictly safer: dropping the view would silently
--   discard its GRANTs and COMMENTs (the easy thing to miss in the drop/recreate
--   pattern) and force visit_summary and location_latest_visit -- which is
--   `select vs.*`, a frozen column list -- to be rebuilt too.
--   If you ever DO need to change the column list, use the greeter-capture-13
--   pattern and drop in order: location_latest_visit, visit_summary,
--   inventory_entry_calc. Recreate in reverse. Restate the grants.
--
-- WHAT CHANGES
--   + inventory.resolve_price_per_ml()              (new, the single source of truth)
--   + inventory.location_product_price_resolved     (new, the reporting surface)
--   ~ inventory.inventory_entry_calc                (3 expressions repointed)
--   ~ inventory.save_visit()                        (1 line repointed + 1 guard)
--   visit_summary and location_latest_visit are untouched and inherit the change.
--
-- BEHAVIOUR CHANGE, STATED PLAINLY
--   Today an entry with a NULL snapshot costs at the product's CURRENT price.
--   After this file it costs at the price in force on the VISIT DATE. That is
--   the correct behaviour and it is why effective-dating is worth having.
--   It is also currently unobservable: 0 of 22,757 entries have a NULL
--   snapshot, so the fallback never fires. Verified 2026-09-03. Every existing
--   dashboard number is bit-identical across this migration.
--
-- ORDERING   01-tables -> 02-review -> 03-backfill -> [04-readers] -> deploy worker -> 05-drop-price
-- SAFE TO RE-RUN  -- yes, all create-or-replace.
-- ===========================================================================

begin;

-- 1. The single source of truth for "what does this cost here, then" ---------
-- LANGUAGE SQL and STABLE, not plpgsql. STABLE lets the planner cache the
-- result within a statement and is required for it to be usable in an index
-- scan qual at all.
--
-- IT WILL NOT BE INLINED, and it is worth being honest about that rather than
-- assuming the usual "single-statement SQL functions get inlined" rule applies.
-- inline_function() refuses any body carrying quals, a sortClause, a limitCount
-- or sublinks; this body has all four. So each call is a real function
-- invocation with its own index lookups.
--
-- That is acceptable here because of where it is called from:
--   - inventory_entry_calc wraps every call in coalesce(ie.price_per_ml, ...),
--     and no entry has a NULL snapshot, so COALESCE short-circuits and the
--     function is never actually executed on the hot path.
--   - location_product_price_resolved calls it once per row via a LATERAL, so
--     1,214 calls for a full scan.
--   - save_visit calls it once per entry on a write.
-- If that changes -- if NULL snapshots reappear at volume -- the fix is to
-- inline the resolution as a LATERAL join in the view and keep this function
-- for save_visit only.
--
-- Keeping ONE definition still matters more than the call overhead. Writing the
-- logic twice -- once in the function for save_visit and once inline in the
-- view -- is exactly the footgun this schema already has, with
-- inventory_entry_calc defined identically in two files and whichever ran last
-- winning.
--
-- RESOLUTION ORDER
--   1. If the location pins a supplier (location_products.supplier_id), use
--      that supplier's latest price effective on or before p_as_of.
--   2. If not pinned, use the latest effective price across all suppliers of
--      that product.
--   Ties (same effective_date) break on lowest price, then id, so the result
--   is deterministic -- a costing function that returns different numbers on
--   repeated calls would be worse than a wrong one.
--
-- Returns NULL when nothing covers the product/date. NULL is deliberate: the
-- callers coalesce or raise. Returning 0 here would make an unpriced chemical
-- silently free, which is the single worst failure mode available.
--
-- The pinned-supplier lookup below is a SCALAR subquery, which errors at
-- runtime if it ever returns more than one row. That is safe here and not by
-- luck: location_products carries UNIQUE (location_code, product_id)
-- (location_products_location_code_product_id_key, verified against the live
-- catalog 2026-09-03), so at most one row can match. If that constraint is ever
-- dropped, this function starts throwing 21000 on costing queries -- which is
-- the right failure, but know where it comes from.

create or replace function inventory.resolve_price_per_ml(
  p_location_code text,
  p_product_id    uuid,
  p_as_of         date
) returns numeric
language sql
stable
as $$
  select sp.price_per_ml
    from inventory.supplier_products sp
   where sp.product_id = p_product_id
     and sp.effective_date <= p_as_of
     and (
       -- pinned: that supplier only. unpinned: any supplier.
       sp.supplier_id = (
         select lp.supplier_id
           from inventory.location_products lp
          where lp.location_code = p_location_code
            and lp.product_id    = p_product_id
            and lp.supplier_id is not null
       )
       or not exists (
         select 1
           from inventory.location_products lp
          where lp.location_code = p_location_code
            and lp.product_id    = p_product_id
            and lp.supplier_id is not null
       )
     )
   order by sp.effective_date desc, sp.price_per_ml asc, sp.id
   limit 1
$$;

comment on function inventory.resolve_price_per_ml(text, uuid, date) is
  'Effective price per ml for a product at a location on a given date. Honours '
  'the location''s pinned supplier when set, else the latest price from any '
  'supplier. Returns NULL when no offering covers the date -- callers must not '
  'coalesce that to zero.';

grant execute on function inventory.resolve_price_per_ml(text, uuid, date) to service_role;

-- 2. The reporting surface --------------------------------------------------
-- Named per the house convention set by public.pricing_simple_resolved:
-- <base>_resolved, a plain view (not materialised), LEFT JOINs so an unmatched
-- base row survives, and a CASE that resolves one effective value out of
-- several candidates while passing the base columns straight through.
--
-- `resolution` is the column that earns this view its keep. It says WHY the
-- price is what it is, so an ambiguous or unpriced pairing is visible in the
-- UI instead of quietly resolving to some arbitrary supplier's number:
--   pinned         location_products.supplier_id is set and covered the date
--   sole_supplier  not pinned, exactly one supplier offers this product
--   ambiguous      not pinned, MORE THAN ONE supplier offers it -- the price
--                  shown is the deterministic pick, but somebody should pin it
--   unpriced       no offering covers this product/date. price is NULL.

-- NOTE ON 'unpriced' WHEN A SUPPLIER IS PINNED
--   A location pinned to a supplier that has no offering covering the date
--   resolves to NULL, and therefore reads 'unpriced' rather than falling back
--   to some other supplier's price. That is deliberate. A pin is a statement
--   about who this site actually buys from; quietly costing it at a different
--   distributor's price would produce a number that is wrong in a way nobody
--   can see. 'unpriced' is visible, and save_visit refuses the visit rather
--   than filing a NULL cost. The cure is to add the offering or clear the pin.
--
-- The resolver is called ONCE per row, in the lateral, not repeatedly in the
-- select list -- it does not inline (see section 1), so each textual occurrence
-- would be a separate execution.

create or replace view inventory.location_product_price_resolved as
  select lp.location_code,
         lp.product_id,
         p.name                                     as product_name,
         p.splash_code,
         lp.supplier_id                             as pinned_supplier_id,
         ps.code                                    as pinned_supplier_code,
         r.price_per_ml,
         case
           when r.price_per_ml is null       then 'unpriced'
           when lp.supplier_id is not null   then 'pinned'
           when sup.supplier_count = 1       then 'sole_supplier'
           else                                   'ambiguous'
         end                                        as resolution,
         coalesce(sup.supplier_count, 0)            as supplier_count,
         lp.target_ml_per_car,
         lp.discount,
         current_date                               as as_of_date
    from inventory.location_products lp
    join inventory.products p   on p.id  = lp.product_id
    left join inventory.suppliers ps on ps.id = lp.supplier_id
    left join lateral (
      select inventory.resolve_price_per_ml(lp.location_code, lp.product_id, current_date)
               as price_per_ml
    ) r on true
    left join lateral (
      select count(distinct sp.supplier_id) as supplier_count
        from inventory.supplier_products sp
       where sp.product_id = lp.product_id
         and sp.effective_date <= current_date
    ) sup on true;

comment on view inventory.location_product_price_resolved is
  'Effective current price per product per location, with the reason the price '
  'resolved the way it did. `resolution = ambiguous` means more than one '
  'supplier offers the product and the location has not been pinned -- that is '
  'a config gap to fix, not an error.';

grant select on inventory.location_product_price_resolved to service_role;

-- 3. The costing engine -----------------------------------------------------
-- Identical 20-column signature to the version in
-- inventory-entry-price-snapshot.sql. The ONLY change is that the three
-- `p.price_per_ml` fallbacks become a date-scoped resolve. The snapshot
-- (ie.price_per_ml) still wins in all three, unchanged -- history stays frozen.
--
-- NOTE: this view is currently defined in TWO files (inventory-tables.sql and
-- inventory-entry-price-snapshot.sql) with identical bodies, so whichever ran
-- last wins. That is a live footgun. This file is now the third and should
-- become the only source of truth -- the copies in those two files are stale
-- and must not be re-applied after this.

create or replace view inventory.inventory_entry_calc as
  select
    ie.id,
    ie.site_visit_id,
    ie.product_id,
    sv.location_code,
    p.name  as product_name,
    -- The snapshot first, exactly as before. The fallback is no longer "the
    -- product's price TODAY" but "the price in force on the visit date", which
    -- is what an un-snapshotted historical row always should have costed at.
    coalesce(ie.price_per_ml,
             inventory.resolve_price_per_ml(sv.location_code, ie.product_id, sv.visit_date))
                                                                                  as price_per_ml,
    ie.starting_qty_gal,
    ie.qty_delivered_gal,
    ie.reservoir_count_gal,
    ie.floor_count_gal,
    ie.ending_qty_gal,
    ie.discount,
    (ie.starting_qty_gal + ie.qty_delivered_gal - ie.ending_qty_gal)               as usage_gal,
    inventory.gal_to_ml(ie.starting_qty_gal + ie.qty_delivered_gal - ie.ending_qty_gal)
      * coalesce(ie.price_per_ml,
                 inventory.resolve_price_per_ml(sv.location_code, ie.product_id, sv.visit_date))
      * (1 - ie.discount)                                                         as cost,
    inventory.gal_to_ml(ie.ending_qty_gal)
      * coalesce(ie.price_per_ml,
                 inventory.resolve_price_per_ml(sv.location_code, ie.product_id, sv.visit_date))
      * (1 - ie.discount)                                                         as on_hand_value,
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

grant select on inventory.inventory_entry_calc to service_role;

-- 4. save_visit ------------------------------------------------------------
-- Reproduced verbatim from inventory-save-visit-rpc.sql except for the three
-- marked changes. Diff it against that file before applying; if that file has
-- moved on since 2026-09-03, reconcile rather than overwriting.

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
  -- CHANGE 1 of 3: the price fallback is now date- and location-scoped, so we
  -- need both. Read back from site_visits rather than from p_visit because on
  -- an update p_visit carries no location_code (it is deliberately not
  -- updatable) and the row is guaranteed present by the time we get here.
  v_location_code text;
  v_visit_date    date;
  v_unpriced      bigint;
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
    -- location_code is deliberately not updatable. A visit belongs to the site
    -- it was filed for; moving it would silently re-scope who can see it, and
    -- the route authorises the edit against the code it reads BEFORE calling
    -- this, so allowing a change here would let the payload out-run that check.
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

  -- CHANGE 2 of 3: pick up the visit's identity for the price resolve below.
  select location_code, visit_date
    into v_location_code, v_visit_date
    from inventory.site_visits
   where id = p_visit_id;

  -- Read the snapshots BEFORE the delete below destroys them. On a create this
  -- is an empty object, so every entry falls through to the resolved price and
  -- is frozen there.
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
    -- CHANGE 3 of 3: the old product-price fallback becomes a call to
    -- inventory.resolve_price_per_ml(...).
    --
    -- Note for anyone editing this comment: 05-drop-price greps pg_proc.prosrc
    -- for a reference to the dropped column to prove this rewrite landed, and
    -- prosrc keeps COMMENTS as well as code. Naming the old expression here in
    -- prose would trip that guard and make 05 unrunnable. Do not write it out.
    --
    -- Everything else about this expression is untouched and the reasoning
    -- behind it still holds verbatim:
    --
    -- The price this visit was FILED at, falling back only for a product that
    -- was not on the visit before. That fallback is right: a chemical being
    -- added to the visit now is being recorded for the first time and has no
    -- prior price to preserve.
    --
    -- The lookup key is round-tripped through ::uuid::text rather than used as
    -- the client sent it. v_prior is keyed by product_id::text, which Postgres
    -- always renders lowercase and hyphenated; a client sending the same uuid
    -- uppercased or braced would MISS the map and be silently repriced at
    -- today's price -- the exact failure this whole file exists to prevent, and
    -- one that raises no error. Normalising both sides makes the miss
    -- impossible. (The cast also rejects a malformed uuid here rather than
    -- letting it through to the FK.)
    coalesce(
      (v_prior ->> ((e ->> 'product_id')::uuid)::text)::numeric,
      inventory.resolve_price_per_ml(v_location_code, (e ->> 'product_id')::uuid, v_visit_date)
    ),
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
  -- LEFT JOIN, not an inner join. p is no longer selected -- the resolve
  -- replaced it -- but the join is retained so this stays a one-line diff
  -- against inventory-save-visit-rpc.sql. The FK on inventory_entries.product_id
  -- is what actually rejects a missing product; an inner join here would have
  -- made such an entry VANISH from the visit silently.
  from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) e
  left join inventory.products p on p.id = (e ->> 'product_id')::uuid;

  -- NEW GUARD. resolve_price_per_ml returns NULL when no supplier offering
  -- covers the product on the visit date. Without this, that NULL lands in the
  -- snapshot column and re-arms the very fallback this series exists to
  -- retire -- silently, and only visible later as a cost of zero. Fail the
  -- whole transaction instead. The visit is not saved; the operator sees why.
  select count(*) into v_unpriced
    from inventory.inventory_entries
   where site_visit_id = p_visit_id and price_per_ml is null;
  if v_unpriced > 0 then
    raise exception
      'no supplier price covers % product(s) at % on % -- add a '
      'supplier_products row (or pin the location''s supplier) before filing '
      'this visit', v_unpriced, v_location_code, v_visit_date
      using errcode = 'check_violation';
  end if;

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
  'delete/re-insert, so editing a visit never reprices it. New entries are '
  'priced from inventory.resolve_price_per_ml at the visit date.';

grant execute on function inventory.save_visit(uuid, jsonb, jsonb, jsonb, boolean)
  to service_role;

-- 5. Prove the swap did not move a single number ----------------------------
-- The whole point of the ordering. If any entry's cost changed, the snapshot
-- discipline failed somewhere and 05-drop-price must not run.
--
-- The comparison has to be against the OLD EXPRESSION, recomputed inline, not
-- against ie.price_per_ml. Comparing the view's price_per_ml to the entry's
-- snapshot would be tautological -- the view's first column is literally
-- `coalesce(ie.price_per_ml, ...)`, so for every non-NULL snapshot (all of
-- them) the two sides are equal by construction and the check would pass no
-- matter how badly the resolver behaved.
--
-- This works because products.price_per_ml still exists at 04 time. It is the
-- last moment the old and new answers can be compared at all, which is exactly
-- why the check belongs here and not in 05.
--
-- cost and on_hand_value are checked too, not just price. They multiply the
-- price by gal_to_ml() and (1 - discount); a price that matches to the cent but
-- differs in scale would slip past a price-only comparison.

do $$
declare
  v_price bigint;
  v_cost  bigint;
begin
  select
    count(*) filter (
      where c.price_per_ml is distinct from coalesce(ie.price_per_ml, p.price_per_ml)),
    count(*) filter (
      where c.cost is distinct from
              inventory.gal_to_ml(ie.starting_qty_gal + ie.qty_delivered_gal - ie.ending_qty_gal)
              * coalesce(ie.price_per_ml, p.price_per_ml) * (1 - ie.discount)
         or c.on_hand_value is distinct from
              inventory.gal_to_ml(ie.ending_qty_gal)
              * coalesce(ie.price_per_ml, p.price_per_ml) * (1 - ie.discount))
    into v_price, v_cost
    from inventory.inventory_entry_calc c
    join inventory.inventory_entries ie on ie.id = c.id
    join inventory.products p on p.id = ie.product_id;

  if v_price > 0 or v_cost > 0 then
    raise exception
      'ABORT: the reader rewrite moved numbers -- % entries changed price, % '
      'changed cost or on-hand value, measured against the pre-migration '
      'expression. Historical reporting would shift. Do NOT run 05-drop-price.',
      v_price, v_cost;
  end if;

  raise notice 'inventory-suppliers-04-readers applied; % entries verified '
               'bit-identical to the pre-migration costing.',
    (select count(*) from inventory.inventory_entries);
end $$;

commit;

-- Confirm -------------------------------------------------------------------
select 'entries'            as metric, count(*)::text as value from inventory.inventory_entries
union all
select 'null snapshots',    count(*)::text from inventory.inventory_entries where price_per_ml is null
union all
select 'resolved rows',     count(*)::text from inventory.location_product_price_resolved
union all
select 'ambiguous',         count(*)::text from inventory.location_product_price_resolved where resolution = 'ambiguous'
union all
select 'unpriced',          count(*)::text from inventory.location_product_price_resolved where resolution = 'unpriced';
