-- ============================================================================
-- inventory.site_visits — add the natural key.
--
-- RUN THIS BEFORE THE HISTORY IMPORT. Adding it afterward means unpicking real
-- data if a duplicate slipped in.
--
-- WHY
--
-- inventory-tables.sql gave site_visits a bare uuid primary key and no unique
-- constraint on (location_code, visit_date). Both child tables DO carry natural
-- keys — inventory_entries is unique (site_visit_id, product_id) and
-- wash_counts is unique (site_visit_id, package_id) — so the visit itself is
-- the one level in the tree where duplicates are unconstrained.
--
-- Two consequences, both bad:
--
--   1. The history import is not idempotent. With nothing to conflict on, a
--      re-run inserts 1,628 more visits rather than colliding, and a
--      half-finished run can only be cleaned up by hand. This constraint is
--      what lets the import use `on conflict (location_code, visit_date) do
--      nothing` and be safely re-runnable.
--
--   2. Two people can record the same site on the same day, which silently
--      double-counts gallons and wash counts into that location's CPC. Nothing
--      in the app or the DB currently stops it.
--
-- SAFETY CHECK — already done, 2026-08-17. Parsed the standalone repo's
-- supabase/seed.sql: 1,628 site_visits rows, 1,628 distinct ids, 81 distinct
-- location uuids, and ZERO same-site same-day pairs. So the constraint cannot
-- reject the import. Re-verify with STEP 1 below if the seed is regenerated.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1 — confirm no duplicates exist right now. EXPECT 0 rows.
-- Safe to run on an empty table; returns nothing either way.
-- ---------------------------------------------------------------------------
select location_code, visit_date, count(*) as visits
  from inventory.site_visits
 group by 1, 2
having count(*) > 1
 order by 3 desc;


-- ---------------------------------------------------------------------------
-- STEP 2 — add the constraint.
--
-- A UNIQUE CONSTRAINT rather than a unique index, because `on conflict
-- (location_code, visit_date)` needs an inferrable arbiter and a named
-- constraint also gives a readable error at the app layer.
--
-- This supersedes the plain index on (location_code, visit_date desc) created
-- by inventory-tables.sql for lookup — but do NOT drop that one. The DESC
-- ordering serves "latest visit per location", which the dashboards and the
-- `max(visit_date)` rollup in the views rely on; the unique constraint's
-- implicit ASC index does not serve it as well.
-- ---------------------------------------------------------------------------
alter table inventory.site_visits
  add constraint site_visits_location_date_key unique (location_code, visit_date);


-- ---------------------------------------------------------------------------
-- STEP 3 — verify it landed. EXPECT one row, contype 'u'.
-- ---------------------------------------------------------------------------
-- select conname, contype, pg_get_constraintdef(oid) as def
--   from pg_constraint
--  where conrelid = 'inventory.site_visits'::regclass
--    and conname = 'site_visits_location_date_key';


-- ============================================================================
-- APP-LAYER FOLLOW-UP — not done by this file.
--
-- createVisit() in apps/inventory/worker/db.ts inserts the visit row bare and
-- rethrows the Postgres message on error. Once this constraint exists, a
-- second submission for the same site and day surfaces to the operator as a
-- raw "duplicate key value violates unique constraint
-- site_visits_location_date_key" — accurate but not useful.
--
-- Worth catching 23505 there and returning a 409 with something like "A visit
-- for {location} on {date} already exists — open it and edit instead." That is
-- the right message anyway: the edit path (PUT /api/visits/{id}) is a full
-- replace of the visit plus its entries and wash counts, so editing is
-- strictly better than a second submission.
--
-- Note the edit path is super_admin only (isInventoryAdmin in worker/auth.ts),
-- so today that message tells a site user to do something they cannot do.
-- ============================================================================
