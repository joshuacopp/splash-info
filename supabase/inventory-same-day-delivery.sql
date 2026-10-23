-- ============================================================================
-- inventory.site_visits — allow a visit AND a delivery on the same day.
--
-- APPLIED 2026-10-22 to rewokyofschtvqgxrxwl (verified via the VERIFY query).
--
-- WHY
--
-- inventory-visit-natural-key.sql made (location_code, visit_date) unique. That
-- predates deliveries, which are stored in the same table with
-- visit_kind = 'delivery', so a site visit in the morning blocked logging the
-- truck that afternoon. Operators hit this in October 2026.
--
-- The key is widened to (location_code, visit_date, visit_kind):
--   * still one inspection per site per day — the protection the original
--     constraint exists for (two people filing the same visit double-counts
--     gallons and wash counts into the site's CPC);
--   * one delivery per site per day, operator-confirmed 2026-10-22 (two trucks
--     on one day goes on one delivery).
--
-- ORDERING. With two rows on one date, "the latest row" is no longer decided by
-- visit_date alone. The worker (lastKnownEndingQuantities) and the SPA
-- (calc.js ledger sort) break the tie on created_at, i.e. the order the rows
-- were FILED. That is the only order the data knows; a delivery entered before
-- the morning visit it physically followed will chain the wrong way round.
--
-- The worker maps a violation of the new constraint to a readable message by
-- matching its NAME, so keep the name below in step with
-- SAME_DAY_CONSTRAINT in apps/inventory/worker/db.ts.
--
-- Safe to run on live data: every existing row satisfies the narrower key, so
-- it necessarily satisfies the wider one. Both statements run in one
-- transaction, so there is no window with no constraint at all.
-- ============================================================================

begin;

alter table inventory.site_visits
  drop constraint site_visits_location_date_key;

alter table inventory.site_visits
  add constraint site_visits_location_date_kind_key
  unique (location_code, visit_date, visit_kind);

commit;

-- VERIFY — expect exactly one row, the new key.
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--  where conrelid = 'inventory.site_visits'::regclass and contype = 'u';

-- ROLLBACK — only if no same-day visit+delivery pair has been filed yet
-- (the narrower key would reject it):
-- begin;
-- alter table inventory.site_visits drop constraint site_visits_location_date_kind_key;
-- alter table inventory.site_visits add constraint site_visits_location_date_key
--   unique (location_code, visit_date);
-- commit;
