-- ============================================================================
-- inventory.locations — the profit-centre overlay
--
-- Companion to supabase/pricing-simple-inbays.sql STEP 2. Read that comment
-- block first; the short version:
--
--   `public.pricing_simple` is the customer-facing membership catalogue.
--   Every row in it becomes a buyable monthly plan on the signup page
--   (fetchPricingResolvedByLocation returns all rows for a code with no
--   active/sellable filter, and pricing_simple_resolved.ongoing is the
--   recurring charge). Wash-only in-bays have no monthly price, so they
--   cannot live there — and self-serves never will either.
--
--   But the chemical-inventory app needs them as separate locations, because
--   blending in-bay chemical usage into the tunnel's CPC averages two
--   non-comparable wash counts together.
--
-- So inventory gets its own location list, unioned on top of pricing_simple
-- by getLocations() in apps/inventory/worker/db.ts. This is the case
-- inventory-tables.sql lines 18-24 reserved when it made `location_code` a
-- PLAIN indexed TEXT column and deliberately NOT a foreign key.
--
-- Run this AFTER supabase/inventory-tables.sql.
-- ============================================================================

create table if not exists inventory.locations (
  code        text primary key,
  name        text not null,
  -- The pricing_simple.location_code this profit centre rolls up to.
  -- Purpose is ACCESS, not reporting: a user_permissions grant on the parent
  -- implies a grant on the child, so nobody has to be granted two codes for
  -- one physical site. NULL = standalone; only super_admin sees it unless
  -- somebody is granted `code` directly.
  --
  -- No FK is possible: pricing_simple's PK is composite (location_code, pkg).
  -- Not enforceable in a CHECK either, so two rules live in the worker:
  --   1. parent_code must be a pricing_simple code, never another overlay
  --      code. Expansion is deliberately ONE level; no chains.
  --   2. `code` must not collide with a pricing_simple code (see the
  --      collision query at the bottom of this file).
  parent_code text,
  -- false = sold or closed, NOT deleted. The row and its history stay; the
  -- worker loads inactive rows too and passes the flag to the SPA, which drops
  -- them from the sidebar and from company rollups but still renders the
  -- location page (with an "inactive" pill) if you go to its URL. Grants
  -- expand to inactive children as well, so whoever could see the site while
  -- it was open can still read its history.
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  -- Same shape splash uses everywhere else (LOCATION_CODE_RE in the workers).
  constraint locations_code_format check (code ~ '^[a-z0-9_]+$'),
  constraint locations_parent_not_self check (parent_code is distinct from code)
);

create index if not exists locations_parent_code_idx
  on inventory.locations (parent_code);

-- Service-role only, matching the rest of the schema. The default privileges
-- set in inventory-tables.sql cover a table created later, but this is
-- explicit so the file stands alone if run out of order.
grant all privileges on inventory.locations to service_role;

-- ---------------------------------------------------------------------------
-- Seed: the profit centres the standalone seed.sql tracks separately and
-- pricing_simple has no room for. Visit counts are from
-- "splash-info docs/inventory-location-mapping.csv".
-- ---------------------------------------------------------------------------
insert into inventory.locations (code, name, parent_code, active) values
  -- site#121 Batavia Veterans, 4120 Veterans Memorial Dr.
  -- seed "Vetts IBAs" (9 visits) vs "Vetts Tunnel" (13) on batavia_veterans.
  ('batavia_veterans_iba', 'Batavia Veterans IBA', 'batavia_veterans', true),

  -- site#133 Seneca Falls — the only Seneca row in public.locations.
  -- seed "Seneca IBA" (13 visits) vs "Seneca" (14) on seneca_falls.
  ('seneca_falls_iba',     'Seneca Falls IBA',     'seneca_falls',     true),

  -- site#145 Liverpool, 7795 Oswego Rd.
  -- seed "Liverpool IBA" (11 visits) vs "Liverpool Tunnel" (13) on liverpool.
  ('liverpool_iba',        'Liverpool IBA',        'liverpool',        true),

  -- site#146 4S-Buckley Rd, 7192 Buckley Rd — "4S" = 4 self serves. A DISTINCT
  -- site from Liverpool (145), not a bay of it, but it has no pricing_simple
  -- code and self-serves sell no memberships, so it belongs here rather than
  -- in STEP 1's insert. seed "Liverpool Self Serves", 3 visits.
  --
  -- SOLD (Josh, 2026-08-15) — history only. active=false, which is the whole
  -- reason this table carries the flag: the 3 visits have to land somewhere
  -- when the seed is migrated, and they need a location row to hang off. It
  -- stays out of the sidebar, out of the rollups, and out of the New Visit
  -- picker; its dashboard still opens by URL.
  --
  -- parent_code is `liverpool` so the Liverpool grant carries the history
  -- (same cluster, same area manager, Earl Budlong). Set it null if only
  -- super_admin should be able to read it.
  ('buckley_4s',           '4S-Buckley Rd (sold)', 'liverpool',        false)
on conflict (code) do nothing;

-- `do nothing` above means a re-run won't correct an already-seeded row, and an
-- earlier draft of this file had buckley_4s active. Force it.
update inventory.locations
   set active = false, name = '4S-Buckley Rd (sold)'
 where code = 'buckley_4s';

-- ---------------------------------------------------------------------------
-- Verify.
-- ---------------------------------------------------------------------------
-- 1. Every parent_code resolves to a real pricing_simple location. Expect 0.
-- select l.code, l.parent_code
-- from inventory.locations l
-- where l.parent_code is not null
--   and not exists (
--     select 1 from public.pricing_simple p
--     where p.location_code = l.parent_code
--   );

-- 2. No parent_code points at another overlay row (one level only). Expect 0.
-- select c.code, c.parent_code
-- from inventory.locations c
-- join inventory.locations p on p.code = c.parent_code;

-- 3. No overlay code shadows a pricing_simple code. Expect 0.
-- select distinct l.code
-- from inventory.locations l
-- join public.pricing_simple p on p.location_code = l.code;
