-- ===========================================================================
-- inventory suppliers, step 1 of 5: the new tables (PURELY ADDITIVE)
-- ===========================================================================
-- WHY
--   Different chemical suppliers sell the same physical chemical under their
--   own SKU, their own wording, and their own price. Because price_per_ml sits
--   directly on inventory.products, the only way to record a second supplier's
--   price today is to create a second products row. That is exactly what has
--   happened: `DS-X55-CS` and `X55` are one chemical from two distributors,
--   as are `L-UF260-CS` / `UF260` and 34 other pairs. The dashboard lists each
--   twice and cross-supplier cost comparison is impossible.
--
--   This series splits the supplier's OFFERING away from the canonical product.
--
-- WHAT CHANGES HERE
--   + inventory.suppliers            (new)
--   + inventory.supplier_products    (new, effective-dated price rows)
--   + inventory.products.splash_code (new nullable column, unique)
--   + inventory.location_products.supplier_id (new nullable column)
--   Nothing is dropped. No existing row is modified. No reader changes.
--   The app behaves identically after this file as before it.
--
-- ORDERING  -- this matters more than anything else in the series
--   01-tables      <- you are here.  Additive. Safe to apply any time.
--   02-review      Diagnostic SELECTs only. Produces the sheet Josh fills in
--                  to assign splash_codes. Applies nothing.
--   03-backfill    Guards the entry price snapshot, then seeds one
--                  supplier_products row per existing product.
--   04-readers     Rewrites inventory_entry_calc / visit_summary /
--                  location_latest_visit and inventory.save_visit() to stop
--                  reading products.price_per_ml.
--   05-drop-price  Drops products.price_per_ml. LAST, and only after the
--                  worker carrying the 04 shape is deployed.
--
--   Applying 05 before 04 takes down every visit save AND the whole costing
--   engine: inventory.save_visit() line 131 and inventory_entry_calc read
--   p.price_per_ml directly, server-side, where no amount of app-code care
--   can protect them.
--
-- DEVIATION FROM THE BRIEF -- read this, it is deliberate
--   The brief specified `location_products.supplier_product_id -> supplier_products`.
--   That column cannot work as specified. supplier_products is effective-dated,
--   so a row in it is a PRICE AT A POINT IN TIME, not a durable offering. A
--   location pinned to a specific supplier_products.id would be pinned to one
--   historical price row and would never pick up that supplier's next price
--   change -- you would have to re-pin all 1,214 location_products rows on
--   every price letter. Pinning to the SUPPLIER and resolving the effective
--   price by date gives the intended behaviour and self-maintains.
--   Hence: location_products.supplier_id, not supplier_product_id.
--
-- SAFE TO RE-RUN  -- yes. Every statement is IF NOT EXISTS guarded.
-- ===========================================================================

begin;

-- 1. Suppliers --------------------------------------------------------------
-- `code` is the short slug used in product names today (DS, TL, CT, VER, VC,
-- MC, QC, CK, L, SI, ECP, Blair). It is NOT seeded here -- 02-review reports
-- the observed prefixes and Josh confirms which are real distributors versus
-- naming noise before anything is inserted.

create table if not exists inventory.suppliers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  code        text not null unique,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint suppliers_code_format check (code ~ '^[A-Za-z0-9_-]+$')
);

comment on table inventory.suppliers is
  'A distributor we buy chemical from. One row per real vendor relationship, '
  'not per territory -- the same supplier serves many locations.';

-- 2. Supplier offerings, effective-dated ------------------------------------
-- One row = "this supplier charged this price for this SKU starting this date".
-- Current price for an offering is the latest row per (supplier_id,
-- supplier_sku) with effective_date <= the as-of date. History comes free;
-- there is no separate price-history table.
--
-- product_id IS NULLABLE ON PURPOSE. That is the "needs mapping" state the
-- brief asked for. A new SKU off a vendor price letter lands here with
-- product_id null: it is visible, it is priced, it is queryable, and it is
-- obviously not yet tied to a canonical chemical. Nothing vanishes and nothing
-- is silently guessed at. inventory.supplier_products_unmapped (below) is the
-- worklist.

create table if not exists inventory.supplier_products (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid references inventory.products(id) on delete restrict,
  supplier_id    uuid not null references inventory.suppliers(id) on delete restrict,
  supplier_sku   text not null,
  supplier_desc  text,
  price_per_ml   numeric not null check (price_per_ml >= 0),
  effective_date date not null default current_date,
  created_at     timestamptz not null default now(),
  unique (supplier_id, supplier_sku, effective_date)
);

-- THE UNIQUE KEY IS THE SKU, NOT THE PRODUCT -- on purpose, and it has a
-- consequence worth stating. One supplier CAN hold several offerings for the
-- same product_id on the same date, because that is what pack sizes are:
-- TL-ESSENCE-5, -15, -30 and -CS are one chemical in four containers from one
-- distributor, and modelling them as one row each is the whole reason this
-- table is keyed on the vendor's SKU. When that happens,
-- inventory.resolve_price_per_ml picks the LOWEST price among them (see
-- 04-readers) -- deterministic, and the right default for a per-ml cost, but it
-- is a choice rather than a fact. If a location should be costed at a specific
-- pack size, that is a further pin the schema does not model yet.

comment on column inventory.supplier_products.product_id is
  'NULL = needs mapping. The SKU is known and priced but has not yet been tied '
  'to a canonical inventory.products row. See inventory.supplier_products_unmapped.';
comment on column inventory.supplier_products.supplier_desc is
  'The vendor''s own wording, verbatim. Never normalised -- it is the evidence '
  'trail back to the price letter.';
comment on column inventory.supplier_products.effective_date is
  'First date this price applies. Current price = latest row per '
  '(supplier_id, supplier_sku) with effective_date <= as-of date.';

create index if not exists supplier_products_product_idx
  on inventory.supplier_products (product_id);
create index if not exists supplier_products_lookup_idx
  on inventory.supplier_products (product_id, supplier_id, effective_date desc);
create index if not exists supplier_products_unmapped_idx
  on inventory.supplier_products (supplier_id) where product_id is null;

-- 3. Canonical code on products ---------------------------------------------
-- Nullable, unique. Nullable because Josh assigns these by hand from the
-- 02-review sheet and 465 products will not all get one on day one; unique
-- because two products sharing a splash_code is precisely the duplicate state
-- this series exists to eliminate.
--
-- NOTE: a UNIQUE constraint on a nullable column permits many NULLs in
-- Postgres, which is what we want -- unassigned products do not collide.

alter table inventory.products
  add column if not exists splash_code text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'products_splash_code_key'
       and conrelid = 'inventory.products'::regclass
  ) then
    alter table inventory.products
      add constraint products_splash_code_key unique (splash_code);
  end if;
end $$;

comment on column inventory.products.splash_code is
  'Our internal code for the physical chemical. Two products sharing one '
  'splash_code are the same chemical from different suppliers and are '
  'candidates to collapse. Assigned by hand -- never inferred from name.';

-- 4. Which supplier a site actually buys from -------------------------------
-- Nullable: most sites will not be pinned, and the resolved view falls back
-- (see 04-readers). Regions use different distributors; this is where that
-- fact lives.
--
-- FK is ON DELETE RESTRICT to match location_products.product_id. Note the
-- schema is inconsistent here already: package_products.product_id is
-- ON DELETE CASCADE while location_products and inventory_entries are
-- RESTRICT, so deleting a product would silently drop package recipe lines
-- while being blocked elsewhere. Not fixed here -- flagged, out of scope.

alter table inventory.location_products
  add column if not exists supplier_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'location_products_supplier_id_fkey'
       and conrelid = 'inventory.location_products'::regclass
  ) then
    alter table inventory.location_products
      add constraint location_products_supplier_id_fkey
      foreign key (supplier_id) references inventory.suppliers(id) on delete restrict;
  end if;
end $$;

comment on column inventory.location_products.supplier_id is
  'The distributor this site buys this product from. NULL = not pinned; the '
  'resolved view falls back to the sole supplier of the product, or reports '
  'the choice as ambiguous. Pinned to the SUPPLIER, not to a price row -- see '
  'the DEVIATION note in inventory-suppliers-01-tables.sql.';

-- 5. The needs-mapping worklist ---------------------------------------------
-- A view rather than a status column: the state is derivable, so it cannot
-- drift out of sync with reality.

create or replace view inventory.supplier_products_unmapped as
  select sp.id,
         s.code as supplier_code,
         s.name as supplier_name,
         sp.supplier_sku,
         sp.supplier_desc,
         sp.price_per_ml,
         sp.effective_date,
         sp.created_at
    from inventory.supplier_products sp
    join inventory.suppliers s on s.id = sp.supplier_id
   where sp.product_id is null
   order by sp.created_at desc, s.code, sp.supplier_sku;

comment on view inventory.supplier_products_unmapped is
  'Supplier SKUs not yet tied to a canonical product. This is a worklist, not '
  'an error state -- new vendor SKUs are expected to land here first.';

-- 6. ACCESS -----------------------------------------------------------------
-- Matching the inventory house style: worker-only via the service key,
-- no grants to anon/authenticated.
--
-- RLS: inventory-tables.sql states RLS is deliberately left off for this
-- schema. THAT IS NO LONGER TRUE OF THE LIVE DATABASE. As of 2026-09-03 all
-- 11 inventory tables have relrowsecurity = true with ZERO policies -- enabled
-- out-of-band, almost certainly via the Supabase dashboard's advisor prompt,
-- and never reflected back into the repo.
--
-- That combination is deny-all for any role without BYPASSRLS. It is currently
-- harmless ONLY because the worker uses the service key (which has BYPASSRLS)
-- and anon/authenticated hold no grant on the schema at all -- they cannot
-- reach these tables regardless. RLS is enforcing nothing today.
--
-- The new tables are made to MATCH THE LIVE STATE, not the stale DDL comment:
-- RLS enabled, no policies, service_role only. This is defence-in-depth and it
-- is deliberately not a behaviour change. Adding permissive policies here would
-- be strictly worse than adding none -- it would grant access that the missing
-- schema-level GRANT currently denies outright.
--
-- If per-user access is ever wanted from the browser, that is a separate
-- decision requiring: a GRANT USAGE on the schema, table grants, AND policies
-- written against the app's identity model. Do not do it piecemeal.

grant all privileges on table inventory.suppliers          to service_role;
grant all privileges on table inventory.supplier_products  to service_role;
grant select         on inventory.supplier_products_unmapped to service_role;

alter table inventory.suppliers          enable row level security;
alter table inventory.supplier_products  enable row level security;

revoke all on table inventory.suppliers         from public;
revoke all on table inventory.supplier_products from public;

commit;

-- Confirm -------------------------------------------------------------------
select 'suppliers'                as object, count(*)::text as rows
  from inventory.suppliers
union all
select 'supplier_products',         count(*)::text
  from inventory.supplier_products
union all
select 'products.splash_code col',
       (select count(*)::text from information_schema.columns
         where table_schema='inventory' and table_name='products'
           and column_name='splash_code')
union all
select 'location_products.supplier_id col',
       (select count(*)::text from information_schema.columns
         where table_schema='inventory' and table_name='location_products'
           and column_name='supplier_id');
