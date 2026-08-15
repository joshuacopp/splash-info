-- Add the Splash 24 in-bay (IBA) profit centres to public.pricing_simple.
--
-- Source: Josh's "Splash 24 - Inbays" pricing sheet, 2026-08-15.
-- Sites 123 / 124 / 131 already exist in public.locations but have NO
-- pricing_simple rows, which is why the chemical-inventory app can't see them
-- (worker/db.ts synthesizes its location list from pricing_simple alone).
--
-- ############################################################################
-- # STOP — RUN STEP 0 FIRST. Two column semantics are inferred, not verified. #
-- ############################################################################
--
-- Assumption A: `single` is the single-wash price and `pkg$` is the unlimited
--   monthly price, i.e. one row per package carrying both (Express = $10
--   single / $20 unlimited) rather than separate IB- and UL- package rows.
-- Assumption B: `flash2` / `flash5` are promotional price points. The sheet
--   doesn't give them, so they're set equal to `single` — no accidental
--   discount if someone flips the location into a flash mode. `pricing` is
--   set to 'full' so full price is the active mode regardless.
-- Assumption C: package names are bare ('Express', 'Bath', …). The sheet's
--   IB- / UL- prefixes are read as column headings, not package names.
--
-- If Step 0 shows otherwise, tell me and I'll regenerate — do not hand-patch,
-- the composite PK is (location_code, pkg) and a typo'd pkg silently creates a
-- duplicate package rather than erroring.

-- ---------------------------------------------------------------------------
-- STEP 0 — verify the assumptions against a known-good site.
--
-- `select *`, not a column list. packages/types/src/pricing.ts flags both
-- names AND semantics as unverified — verbatim: "`single` — name suggests
-- 'same as today' baseline (single wash price?). Confirm semantics." If
-- `single` is really the "same"-mode MONTHLY price, STEP 1 writes $10/mo into
-- a membership column. The resolved view also carries a `pretty_pkg` that
-- STEP 1 does not set.
-- ---------------------------------------------------------------------------
-- select * from public.pricing_simple
-- where location_code in ('batavia_veterans','liverpool','brockport_ii')
-- order by location_code, sort, pkg;
--
-- ...and the customer-facing side of those same rows:
-- select * from public.pricing_simple_resolved
-- where location_code in ('batavia_veterans','liverpool','brockport_ii')
-- order by location_code, sort;

-- ---------------------------------------------------------------------------
-- STEP 1 — the three sites with NO pricing_simple presence at all.
--
-- ALREADY RUN 2026-08-15 (Josh), and `single` is confirmed: it is the
-- single-wash price, and also the first month's price when pricing = 'same'.
-- Kept here as the record of what went in. Re-running is harmless — the insert
-- is `on conflict (location_code, pkg) do nothing`.
--
-- Denormalized columns are filled by hand here on purpose:
-- trg_sync_pricing_simple fires ON locations AFTER UPDATE, not AFTER INSERT,
-- so an insert gets no help from the trigger (same reason the sysadmin
-- Add Location endpoint carries them explicitly).
--
-- location_code choices — must match ^[a-z0-9_]+$:
--   site 131 Batavia Liberty -> batavia_liberty
--   site 123 Brockport       -> brockport        (brockport_ii = site 140)
--   site 124 Canandaigua     -> canandaigua
-- ---------------------------------------------------------------------------

begin;

insert into public.pricing_simple
  (location_code, location_pretty, pkg, "pkg$", single, flash2, flash5,
   sort, pricing, site, area_manager, regional_manager,
   am_email, rm_email, site_email, address)
values
  -- site 131 — Batavia Liberty, 15 Liberty St
  ('batavia_liberty','Batavia Liberty','Express',    20.00, 10.00, 10.00, 10.00, 1, 'full', '131',
   'Mike Grubka','Paul Morgan','mgrubka@splashcarwashes.com','paul.morgan@splashcarwashes.com',
   'batavaiawash@splashcarwashes.com','15 Liberty St, Batavia, NY 14020'),
  ('batavia_liberty','Batavia Liberty','Bath',       25.00, 11.00, 11.00, 11.00, 2, 'full', '131',
   'Mike Grubka','Paul Morgan','mgrubka@splashcarwashes.com','paul.morgan@splashcarwashes.com',
   'batavaiawash@splashcarwashes.com','15 Liberty St, Batavia, NY 14020'),
  ('batavia_liberty','Batavia Liberty','Ultra Bath', 33.00, 14.00, 14.00, 14.00, 3, 'full', '131',
   'Mike Grubka','Paul Morgan','mgrubka@splashcarwashes.com','paul.morgan@splashcarwashes.com',
   'batavaiawash@splashcarwashes.com','15 Liberty St, Batavia, NY 14020'),
  ('batavia_liberty','Batavia Liberty','Bubble Bath',39.00, 16.00, 16.00, 16.00, 4, 'full', '131',
   'Mike Grubka','Paul Morgan','mgrubka@splashcarwashes.com','paul.morgan@splashcarwashes.com',
   'batavaiawash@splashcarwashes.com','15 Liberty St, Batavia, NY 14020'),

  -- site 123 — Brockport, 4653 Lake Rd  (site_email is null in locations)
  ('brockport','Brockport','Express',    20.00, 10.00, 10.00, 10.00, 1, 'full', '123',
   'Mike Grubka','Paul Morgan','mgrubka@splashcarwashes.com','paul.morgan@splashcarwashes.com',
   null,'4653 Lake Rd, Brockport, NY 14420'),
  ('brockport','Brockport','Bath',       25.00, 11.00, 11.00, 11.00, 2, 'full', '123',
   'Mike Grubka','Paul Morgan','mgrubka@splashcarwashes.com','paul.morgan@splashcarwashes.com',
   null,'4653 Lake Rd, Brockport, NY 14420'),
  ('brockport','Brockport','Ultra Bath', 33.00, 14.00, 14.00, 14.00, 3, 'full', '123',
   'Mike Grubka','Paul Morgan','mgrubka@splashcarwashes.com','paul.morgan@splashcarwashes.com',
   null,'4653 Lake Rd, Brockport, NY 14420'),
  ('brockport','Brockport','Bubble Bath',39.00, 16.00, 16.00, 16.00, 4, 'full', '123',
   'Mike Grubka','Paul Morgan','mgrubka@splashcarwashes.com','paul.morgan@splashcarwashes.com',
   null,'4653 Lake Rd, Brockport, NY 14420'),

  -- site 124 — Canandaigua, 330 Eastern Blvd
  ('canandaigua','Canandaigua','Express',    20.00, 10.00, 10.00, 10.00, 1, 'full', '124',
   'Mike Grubka','Earl Budlong','mgrubka@splashcarwashes.com','earl.budlong@splashcarwashes.com',
   'canandaiguawash@splashcarwashes.com','330 Eastern Blvd, Canandaigua, NY 14424'),
  ('canandaigua','Canandaigua','Bath',       25.00, 11.00, 11.00, 11.00, 2, 'full', '124',
   'Mike Grubka','Earl Budlong','mgrubka@splashcarwashes.com','earl.budlong@splashcarwashes.com',
   'canandaiguawash@splashcarwashes.com','330 Eastern Blvd, Canandaigua, NY 14424'),
  ('canandaigua','Canandaigua','Ultra Bath', 33.00, 14.00, 14.00, 14.00, 3, 'full', '124',
   'Mike Grubka','Earl Budlong','mgrubka@splashcarwashes.com','earl.budlong@splashcarwashes.com',
   'canandaiguawash@splashcarwashes.com','330 Eastern Blvd, Canandaigua, NY 14424'),
  ('canandaigua','Canandaigua','Bubble Bath',39.00, 16.00, 16.00, 16.00, 4, 'full', '124',
   'Mike Grubka','Earl Budlong','mgrubka@splashcarwashes.com','earl.budlong@splashcarwashes.com',
   'canandaiguawash@splashcarwashes.com','330 Eastern Blvd, Canandaigua, NY 14424')
on conflict (location_code, pkg) do nothing;

-- Verify before committing:
--   select location_code, pkg, single, "pkg$", sort
--   from public.pricing_simple
--   where location_code in ('batavia_liberty','brockport','canandaigua')
--   order by location_code, sort;

commit;

-- ---------------------------------------------------------------------------
-- STEP 2 — sites 121 / 133 / 145: NO pricing_simple rows. Deliberately.
--
-- Batavia Veterans (121), Seneca Falls (133) and Liverpool (145) already have
-- pricing_simple codes for their tunnels. The obvious moves are to collapse
-- ('IB-Express' etc. as extra pkg rows on the existing code) or to split
-- (new codes + new public.locations rows). Both are wrong here, for the same
-- reason: **the sheet marks all three in-bays "Wash Only" — no unlimited
-- tier — and pricing_simple is the customer-facing membership catalogue.**
--
-- Evidence, not inference:
--   * packages/db-supabase/src/pricing.ts fetchPricingResolvedByLocation()
--     returns EVERY pricing_simple_resolved row for a location_code, ordered
--     by `sort`, with no active/sellable filter. There is no such column on
--     the table (see PricingSimpleRow in packages/types/src/pricing.ts).
--   * `pricing_simple_resolved.ongoing` is the recurring monthly price the
--     signup form charges.
--   So any row added here becomes a buyable monthly membership on the public
--   signup page. A wash-only in-bay has no monthly price to put in `pkg$`,
--   and inventing one is a customer-facing pricing defect.
--
-- Collapse fails for a second reason: getLocations() in
-- apps/inventory/worker/db.ts dedupes on location_code, so extra pkg rows
-- give the inventory app nothing — tunnel and in-bay chemical usage still
-- land in one blended CPC across non-comparable wash counts.
--
-- Split fails for a third: 41 files read pricing_simple, and at least
-- promo-worker GET /promo/api/locations, signup listDistinctLocations() and
-- the forms location field all enumerate distinct location_codes into user-
-- facing pickers. Three in-bays would leak into all of them, plus each needs
-- its own user_permissions grant and trips the sysadmin Add Location 409
-- (see inventory-history-migration.md, "Known defect").
--
-- WHERE THEY GO INSTEAD: inventory-only location codes. inventory-tables.sql
-- lines 18-24 reserved exactly this case — location_code is a PLAIN indexed
-- TEXT column, NOT a foreign key, specifically so "a chemical-inventory site
-- can exist here before it exists in pricing_simple (e.g. a location with two
-- profit centers that use different inventories but are collapsed into one
-- pricing row)."
--
-- IMPLEMENTED 2026-08-15 in supabase/inventory-locations-overlay.sql plus
-- apps/inventory/worker/{overlay.ts,auth.ts,db.ts}. No schema change to
-- public. Run the overlay file; nothing further is needed in this one.
--
-- Overlay codes created there (parent in parens):
--   batavia_veterans_iba  (batavia_veterans)  -- seed "Vetts IBAs",       9 visits
--   seneca_falls_iba      (seneca_falls)      -- seed "Seneca IBA",      13 visits
--   liverpool_iba         (liverpool)         -- seed "Liverpool IBA",   11 visits
--   buckley_4s            (liverpool)         -- site#146 self serves,    3 visits
--                                             -- SOLD; seeded active=false
--
-- buckley_4s rides along for the same reason: site#146 has no pricing_simple
-- code and self serves sell no memberships either. It is a distinct site, not
-- a bay of Liverpool; the parent_code is about who can see it, not reporting.
-- The site has since been sold, so it goes in inactive — history only. That is
-- another thing pricing_simple could not have expressed: it has no active or
-- sellable column at all, so a sold site cannot be represented there except by
-- deleting it, which would take the history with it.
--
-- The in-bay single-wash prices from the sheet have no home in pricing_simple
-- for these three. If they need to be published, that's the pricing tool's
-- problem (a non-membership price list), not this table's.
-- ---------------------------------------------------------------------------
