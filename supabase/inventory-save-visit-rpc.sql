-- ============================================================================
-- inventory.save_visit -- write a whole visit in ONE transaction.
--
-- RUN THIS AFTER inventory-entry-price-snapshot.sql AND BEFORE DEPLOYING THE
-- WORKER. The worker calls this function instead of issuing its own
-- delete/insert sequence, so a deploy that lands ahead of the SQL turns every
-- visit submit and edit into "function does not exist".
--
-- WHY
--
-- Editing a visit is a REPLACE: the client posts the full entry list, so the
-- worker deleted every inventory_entries and wash_counts row for the visit and
-- re-inserted from the payload. Those were four separate PostgREST calls with
-- no transaction around them. If the insert failed -- a constraint, a dropped
-- connection, an isolate evicted mid-flight -- the delete had already
-- committed, and the visit was left stripped of its entries.
--
-- That was recoverable while every number on an entry also existed in the
-- browser tab that submitted it. The price snapshot changed that: price_per_ml
-- is captured server-side and is the ONLY record of what a chemical cost on the
-- day of the visit. Nothing else holds it -- not the client, not the products
-- table, which by then has moved on. A half-completed edit would destroy it
-- permanently. The snapshot made an already-bad failure mode unrecoverable,
-- which is what makes this worth a function rather than a TODO.
--
-- Doing it here also closes a race that no amount of care in the worker could:
-- previously the worker READ the existing prices, then deleted, then inserted.
-- A bulk reprice landing in that window would have been picked up as though it
-- were the filed price. Reading the prior prices inside the same transaction as
-- the delete and insert makes that window zero-width.
--
-- SHAPE
--
-- One function for both create and update, because they differ only in whether
-- the site_visits row is inserted or patched -- everything after that line is
-- identical, and splitting it would mean maintaining the entry-writing logic
-- twice with the snapshot rule living in both copies.
--
-- SAFE TO RE-RUN (create or replace).
-- ============================================================================

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
  -- { "<product_id>": <price_per_ml> } for the entries already on this visit.
  -- A jsonb local rather than a temp table: it is a handful of keys, it needs
  -- no cleanup, and it cannot leak into another call on a pooled connection.
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
      -- Water readings stay NULL when absent rather than collapsing to 0: 0 gpg
      -- is a real reading at an RO or softened site, and the 1,628 imported
      -- visits have no water data at all. `->>` already yields NULL for a JSON
      -- null or a missing key, so no coalesce here on purpose.
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

  -- Read the snapshots BEFORE the delete below destroys them. On a create this
  -- is an empty object, so every entry falls through to the product's current
  -- price and is frozen there.
  --
  -- `price_per_ml is not null` keeps un-snapshotted rows (filed before the
  -- column existed) OUT of the map, so they fall through to the current price
  -- and pick up a snapshot on this write -- the same fallback the readers use.
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
    -- The price this visit was FILED at, falling back to the product's current
    -- price only for a product that was not on the visit before. That fallback
    -- is right: a chemical being added to the visit now is being recorded for
    -- the first time and has no prior price to preserve.
    --
    -- The lookup key is round-tripped through ::uuid::text rather than used as
    -- the client sent it. v_prior is keyed by product_id::text, which Postgres
    -- always renders lowercase and hyphenated; a client sending the same uuid
    -- uppercased or braced would MISS the map and be silently repriced at
    -- today's price -- the exact failure this whole file exists to prevent, and
    -- one that raises no error. Normalising both sides makes the miss
    -- impossible. (The cast also rejects a malformed uuid here rather than
    -- letting it through to the FK.)
    coalesce((v_prior ->> ((e ->> 'product_id')::uuid)::text)::numeric, p.price_per_ml),
    coalesce((e ->> 'starting_qty_gal')::numeric,  0),
    coalesce((e ->> 'qty_delivered_gal')::numeric, 0),
    -- Physical counts stay NULL when not recorded; MacTrack-format sites never
    -- record them and "not counted" must not read as "counted zero".
    nullif(e ->> 'reservoir_count_gal', '')::numeric,
    nullif(e ->> 'floor_count_gal', '')::numeric,
    coalesce((e ->> 'ending_qty_gal')::numeric, 0),
    coalesce((e ->> 'discount')::numeric, 0),
    nullif(e ->> 'metering_type', ''),
    nullif(e ->> 'tip_color', ''),
    nullif(e ->> 'versadial_number', '')::integer,
    nullif(e ->> 'injector_color', ''),
    nullif(e ->> 'injector_gpm', '')::numeric
  -- LEFT JOIN, not an inner join. An inner join would make an entry naming a
  -- product that no longer exists VANISH from the visit silently. Left-joined,
  -- product_id is still written and the on-delete-restrict FK rejects the whole
  -- transaction with a message naming the constraint.
  from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) e
  left join inventory.products p on p.id = (e ->> 'product_id')::uuid;

  insert into inventory.wash_counts (site_visit_id, package_id, wash_count)
  select
    p_visit_id,
    (w ->> 'package_id')::uuid,
    -- ::numeric::integer rounds rather than truncating, matching the worker's
    -- Math.round. A package box left blank arrives as 0, which is meaningful
    -- here (zero washes of that package) unlike a blank water reading.
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

-- Confirm -------------------------------------------------------------------
select p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'inventory' and p.proname = 'save_visit';
