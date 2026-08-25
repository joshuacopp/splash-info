-- ============================================================================
-- Migration 0006: splash-info integration
--
-- Re-homes the chemical-inventory app into the shared splashcarwashes.info
-- Supabase project. Supersedes the standalone-project migrations 0001–0005
-- (which created their own auth model). Run THIS file on the splash project;
-- do NOT run 0001–0005 there.
--
-- WHAT CHANGED vs. the standalone app
--  * Everything lives in a dedicated `inventory` Postgres schema, so nothing
--    collides with the splash project's public tables (public.locations,
--    public.user_permissions, public.pricing_simple, …).
--  * The app's own auth model is GONE. No user_profiles, no user_locations,
--    no `locations` table, no RLS helper fns, no auth.users trigger. Who may
--    use inventory + which sites they see is decided by the splash auth stack
--    (auth_unified + the new `inventory` tool grant) and enforced in the
--    inventory worker, which reaches these tables with the service key.
--  * Sites are referenced by `location_code` (text) — the same scoping key
--    splash uses everywhere (user_permissions.location_code, session.locations,
--    pricing_simple.location_code). It is a PLAIN indexed column, NOT a foreign
--    key: a chemical-inventory site can exist here before it exists in
--    pricing_simple (e.g. a location with two profit centers that use different
--    inventories but are collapsed into one pricing row). Reconciling those
--    into pricing_simple is a follow-up; this schema does not block it.
--
-- OPERATOR STEPS (once, in the Supabase dashboard) after running this file:
--   1. Project Settings → API → Exposed schemas: add `inventory`.
--      Without this, the worker's PostgREST/service client can't see the
--      tables. anon/authenticated are deliberately NOT granted usage, so the
--      schema stays reachable ONLY via the service key (i.e. the worker).
--
-- CALCULATIONS: still never stored. The views at the bottom compute usage,
-- cost, blended CPC, on-hand value and both flags live, exactly as before.
-- 1 gallon = 3785.411784 ml.
-- ============================================================================

create extension if not exists pgcrypto;          -- gen_random_uuid()
create schema if not exists inventory;

-- gallons -> milliliters (schema-local so it can't clash with a public fn)
create or replace function inventory.gal_to_ml(gal numeric)
returns numeric language sql immutable as $$
  select gal * 3785.411784
$$;

-- ===========================================================================
-- CORE TABLES
-- ===========================================================================

-- Products (shared master price list across all locations) -------------------
create table inventory.products (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  price_per_ml  numeric not null check (price_per_ml >= 0),
  unit_type     text,                       -- e.g. "5gal case", "30gal"
  description   text,                        -- MacTrack SKUs like "L-UF260-CS"
  created_at    timestamptz not null default now()
);

-- Which products a location stocks + that location's target ml/car & discount -
create table inventory.location_products (
  id                uuid primary key default gen_random_uuid(),
  location_code     text not null,
  product_id        uuid not null references inventory.products(id) on delete restrict,
  target_ml_per_car numeric check (target_ml_per_car >= 0),
  -- discount = 1 is legal and means the product is supplied free (Viper Shine
  -- at williamsville and newark). The standalone schema's exclusive `< 1`
  -- rejected real config; see supabase/inventory-discount-allow-full.sql.
  discount          numeric not null default 0 check (discount >= 0 and discount <= 1),
  unique (location_code, product_id)
);
create index on inventory.location_products (location_code);

-- A location's wash/add-on packages (differ per location) --------------------
create table inventory.packages (
  id            uuid primary key default gen_random_uuid(),
  location_code text not null,
  name          text not null,
  package_type  text not null default 'wash' check (package_type in ('wash','addon')),
  target_cpc    numeric check (target_cpc >= 0),   -- dollars; fallback when no package_products
  created_at    timestamptz not null default now(),
  unique (location_code, name)
);
create index on inventory.packages (location_code);

-- Package composition: which products a package uses and how many uses --------
create table inventory.package_products (
  id          uuid primary key default gen_random_uuid(),
  package_id  uuid not null references inventory.packages(id) on delete cascade,
  product_id  uuid not null references inventory.products(id) on delete cascade,
  uses        numeric not null default 1 check (uses > 0),
  unique (package_id, product_id)
);
create index on inventory.package_products (package_id);

-- Site visits ---------------------------------------------------------------
-- water_hardness_gpg / tds_ppm: one reading of each, taken at the visit. The
-- hardness column names its unit because gpg and "ppm as CaCO3" differ by a
-- factor of ~17.1 and a bare "10" is ordinary municipal water in one and
-- nearly distilled in the other. Only `>= 0` is enforced -- see
-- inventory-water-readings.sql for why there is deliberately no ceiling.
-- Both nullable with no default: the 1,628 imported visits have no water data
-- and never will, so NULL means "not recorded" and stays distinguishable from
-- a real 0 gpg reading (RO or softened water).
create table inventory.site_visits (
  id                 uuid primary key default gen_random_uuid(),
  location_code      text not null,
  visit_date         date not null,
  submitter          text,
  notes              text,
  water_hardness_gpg numeric
    constraint site_visits_water_hardness_gpg_check check (water_hardness_gpg >= 0),
  tds_ppm            numeric
    constraint site_visits_tds_ppm_check check (tds_ppm >= 0),
  created_at         timestamptz not null default now()
);
create index on inventory.site_visits (location_code, visit_date desc);

-- Inventory entries (one row per product per visit) --------------------------
-- reservoir/floor are nullable: MacTrack-format sites record no physical counts.
create table inventory.inventory_entries (
  id                  uuid primary key default gen_random_uuid(),
  site_visit_id       uuid not null references inventory.site_visits(id) on delete cascade,
  product_id          uuid not null references inventory.products(id)    on delete restrict,
  starting_qty_gal    numeric not null default 0,
  qty_delivered_gal   numeric not null default 0,
  reservoir_count_gal numeric,
  floor_count_gal     numeric,
  ending_qty_gal      numeric not null default 0,
  -- <= 1, matching location_products: NewVisit.jsx seeds this from the
  -- location's discount, so a free product would fail on submit. Same note.
  discount            numeric not null default 0 check (discount >= 0 and discount <= 1),
  -- Price snapshot (migration: inventory-entry-price-snapshot.sql). Captured
  -- server-side at submit and immutable after: editing a visit preserves it,
  -- and repricing the product does not touch it. Without this, cost was derived
  -- from products.price_per_ml as it stands right now, so one price change
  -- retroactively restated every visit that ever used the chemical.
  -- Nullable, not `default 0`: 0 is a legal price (see the 100%-discount rows),
  -- so a zero default would silently price a chemical at free and nothing
  -- downstream would catch it. NULL means "no snapshot" and readers fall back
  -- to the product's current price, i.e. the old behaviour.
  price_per_ml        numeric check (price_per_ml >= 0),
  -- equipment tracking (migration 0005): a location meters with a colored tip
  -- OR a versadial number 1-32, never both; injector color identifies flow rate.
  metering_type       text check (metering_type in ('tip','versadial')),
  tip_color           text,
  versadial_number    integer check (versadial_number between 1 and 32),
  injector_color      text,
  injector_gpm        numeric check (injector_gpm >= 0),
  -- usage_gal & cost are computed on read, never stored.
  unique (site_visit_id, product_id)
);
create index on inventory.inventory_entries (site_visit_id);
create index on inventory.inventory_entries (product_id);

-- Wash counts (one row per package per visit) --------------------------------
create table inventory.wash_counts (
  id             uuid primary key default gen_random_uuid(),
  site_visit_id  uuid not null references inventory.site_visits(id) on delete cascade,
  package_id     uuid not null references inventory.packages(id)    on delete restrict,
  wash_count     integer not null default 0 check (wash_count >= 0),
  unique (site_visit_id, package_id)
);
create index on inventory.wash_counts (site_visit_id);

-- Email recipients for the visit-report email --------------------------------
create table inventory.notification_recipients (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  name          text,
  active        boolean not null default true,
  all_locations boolean not null default true,
  created_at    timestamptz not null default now()
);

create table inventory.notification_recipient_locations (
  recipient_id  uuid not null references inventory.notification_recipients(id) on delete cascade,
  location_code text not null,
  primary key (recipient_id, location_code)
);

-- Flag resolutions (Attention page). flag_key is a stable text key computed in
-- the app (e.g. 'overtarget:<visit_id>:<product_id>'), not a foreign key.
create table inventory.flag_resolutions (
  id            uuid primary key default gen_random_uuid(),
  flag_key      text not null unique,
  location_code text,
  resolved_by   text not null,
  note          text,
  resolved_at   timestamptz not null default now()
);
create index on inventory.flag_resolutions (location_code);

-- ===========================================================================
-- COMPUTED VIEWS  (single source of truth for all calculations)
-- Re-keyed location_id -> location_code. security_invoker not needed: only the
-- service role reads these (the worker), and it bypasses RLS anyway.
-- ===========================================================================

-- Total wash count per visit ------------------------------------------------
create or replace view inventory.visit_wash_totals as
  select site_visit_id, coalesce(sum(wash_count), 0)::bigint as total_wash_count
  from inventory.wash_counts
  group by site_visit_id;

-- Per-entry line: usage, cost, on-hand value, ml/car, and both flags --------
create or replace view inventory.inventory_entry_calc as
  select
    ie.id,
    ie.site_visit_id,
    ie.product_id,
    sv.location_code,
    p.name  as product_name,
    -- The snapshot first, the live product price only as a fallback for rows
    -- filed before the snapshot column existed. coalesce rather than a straight
    -- swap so an un-snapshotted row costs out exactly as it does today instead
    -- of NULL, which would poison every sum built on this view.
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

-- Per-visit rollup ----------------------------------------------------------
create or replace view inventory.visit_summary as
  select
    sv.id                as site_visit_id,
    sv.location_code,
    sv.visit_date,
    sv.submitter,
    sv.notes,
    sv.created_at,
    coalesce(vt.total_wash_count, 0)                       as total_wash_count,
    coalesce(c.chemical_cost, 0)                           as chemical_cost,
    coalesce(c.inventory_on_hand_value, 0)                 as inventory_on_hand_value,
    case when coalesce(vt.total_wash_count,0) > 0
         then c.chemical_cost / vt.total_wash_count end    as blended_cpc,
    case when coalesce(vt.total_wash_count,0) > 0
         then tgt.target_weighted / vt.total_wash_count end as blended_target_cpc,
    coalesce(c.flag_count, 0)                              as flag_count
  from inventory.site_visits sv
  left join inventory.visit_wash_totals vt on vt.site_visit_id = sv.id
  left join (
        select site_visit_id,
               sum(cost)          as chemical_cost,
               sum(on_hand_value) as inventory_on_hand_value,
               sum( (over_target_flag)::int + (reconciliation_flag)::int ) as flag_count
        from inventory.inventory_entry_calc
        group by site_visit_id
      ) c on c.site_visit_id = sv.id
  left join (
        select wc.site_visit_id,
               sum(pk.target_cpc * wc.wash_count) as target_weighted
        from inventory.wash_counts wc
        join inventory.packages pk on pk.id = wc.package_id
        group by wc.site_visit_id
      ) tgt on tgt.site_visit_id = sv.id;

-- Latest visit per location (drives the All-Locations dashboard) -------------
create or replace view inventory.location_latest_visit as
  select vs.*
  from inventory.visit_summary vs
  join (
        select location_code, max(visit_date) as max_date
        from inventory.site_visits group by location_code
      ) m on m.location_code = vs.location_code and m.max_date = vs.visit_date;

-- ===========================================================================
-- ACCESS: worker-only. The inventory worker reaches everything here with the
-- service key (which bypasses RLS). anon/authenticated get NO grants, so the
-- schema is invisible to the browser-facing PostgREST roles even after it is
-- added to Exposed schemas. RLS is left off because there is no direct-from-
-- client access path to protect.
-- ===========================================================================
grant usage on schema inventory to service_role;
grant all privileges on all tables    in schema inventory to service_role;
grant all privileges on all sequences in schema inventory to service_role;
grant execute on function inventory.gal_to_ml(numeric) to service_role;

alter default privileges in schema inventory
  grant all privileges on tables to service_role;
alter default privileges in schema inventory
  grant all privileges on sequences to service_role;
