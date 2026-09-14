-- One-off correction for costs that were stored 100x too large.
--
-- WHAT WENT WRONG
--
--   money() in apps/workorders-worker/src/mx-map.ts multiplied every value that
--   did not literally end in "Cents" by 100, on the assumption that MaintainX
--   sends dollars. It does not. The API sends CENTS already:
--
--       "unitCost": 12300      is $123.00, not $12,300.00
--       "costPerUnit": 350     is $3.50,   not $350.00
--
--   so a $123.00 part landed in Postgres as 1230000 -- $12,300.00. The schema
--   header in maintainx-ingest-01-tables.sql has said "all money is stored in
--   CENTS as integers, matching the MaintainX API" since day one, so the mapper
--   and the schema disagreed from the first row ever written.
--
--   Fixed in 9a920d1: money() now rounds and stores what MaintainX sent.
--
-- WHY A BACKFILL IS NEEDED AT ALL
--
--   The mapper fix only corrects a row when that row is written again. The
--   incremental cron re-fetches work orders whose updatedAt moved, and a
--   closed work order's updatedAt never moves again -- so historical rows stay
--   wrong forever unless corrected here.
--
-- RUN ORDER -- THIS MATTERS
--
--   1. Push and let Workers Builds deploy 9a920d1.
--   2. Confirm the new code is live.
--   3. Set the cutoff below to the deploy time and run this.
--
--   Running it BEFORE the deploy corrupts data a second time: the old mapper
--   would re-inflate any row the cron touched between the divide and the
--   deploy, and a row divided twice is off by 10,000x with nothing left in the
--   data to distinguish it from a correct one.
--
-- WHY THE CUTOFF IS synced_at AND NOT "everything"
--
--   Rows written by the FIXED code are already right. Dividing those by 100
--   would break them. synced_at is stamped on every write by the ingest, so
--   "written before the deploy" is exactly "synced_at < cutoff".
--
--   As of 2026-09-14 every row in all three tables was synced between
--   2026-09-12 and now, i.e. all of them are affected -- but the predicate is
--   written properly anyway so that a re-run after a partial application, or a
--   run delayed by a day, cannot double-divide.
--
-- IDEMPOTENCY
--
--   This is NOT idempotent on its own -- dividing twice is a real hazard. The
--   synced_at cutoff is what makes a second run safe: the first run does not
--   change synced_at, so a blind re-run WOULD divide again. Therefore:
--   run it once, inside the transaction below, and check the counts before
--   COMMIT.

begin;

-- ---------------------------------------------------------------------------
-- Set this to the moment the fixed worker went live. Everything synced before
-- it was written by the broken mapper; everything after is already correct.
-- ---------------------------------------------------------------------------
create temporary table _cutoff on commit drop as
select timestamptz '2026-09-14 00:00:00+00' as at;   -- <<< EDIT ME

-- Before: what we are about to change.
select 'BEFORE' as phase,
       (select count(*) from public.mx_work_order_part, _cutoff
          where synced_at < at and coalesce(unit_cost_cents,0) <> 0) as parts,
       (select count(*) from public.mx_work_order_expenditure, _cutoff
          where synced_at < at and (coalesce(cost_per_unit_cents,0) <> 0
                                 or coalesce(row_total_cents,0) <> 0)) as expenditures,
       (select count(*) from public.mx_work_order, _cutoff
          where synced_at < at and (coalesce(total_cost_cents,0) <> 0
                                 or coalesce(part_cost_cents,0) <> 0
                                 or coalesce(expenditure_cents,0) <> 0)) as work_orders,
       (select round(sum(total_cost_cents)/100.0, 2) from public.mx_work_order) as sum_dollars_now;

-- ---------------------------------------------------------------------------
-- The correction. round() not trunc(): the inflated value is exactly 100x an
-- integer in every observed row, so the two agree -- but if any row was ever
-- written from a fractional dollar value, rounding lands on the nearest cent
-- rather than silently shaving one off.
--
-- synced_at is deliberately NOT touched. It records when the row was last
-- fetched from MaintainX, and this is not a fetch. Moving it would also
-- destroy the only marker that distinguishes corrected rows from fresh ones.
-- ---------------------------------------------------------------------------

update public.mx_work_order_part p
   set unit_cost_cents = round(p.unit_cost_cents / 100.0)
  from _cutoff
 where p.synced_at < _cutoff.at
   and coalesce(p.unit_cost_cents, 0) <> 0;

update public.mx_work_order_expenditure e
   set cost_per_unit_cents = round(e.cost_per_unit_cents / 100.0),
       row_total_cents     = round(e.row_total_cents / 100.0)
  from _cutoff
 where e.synced_at < _cutoff.at
   and (coalesce(e.cost_per_unit_cents, 0) <> 0 or coalesce(e.row_total_cents, 0) <> 0);

-- The three work-order columns are derived sums the mapper computes from the
-- same inflated inputs, so they carry the identical 100x error and are divided
-- the same way rather than recomputed from the children -- recomputing would
-- silently "fix" work orders whose children were never ingested by zeroing
-- them.
update public.mx_work_order w
   set part_cost_cents   = round(w.part_cost_cents / 100.0),
       expenditure_cents = round(w.expenditure_cents / 100.0),
       total_cost_cents  = round(w.total_cost_cents / 100.0)
  from _cutoff
 where w.synced_at < _cutoff.at
   and (coalesce(w.total_cost_cents, 0) <> 0
     or coalesce(w.part_cost_cents, 0) <> 0
     or coalesce(w.expenditure_cents, 0) <> 0);

-- After: the same totals, which should now be 1/100 of the BEFORE figure.
select 'AFTER' as phase,
       (select round(sum(total_cost_cents)/100.0, 2) from public.mx_work_order) as sum_dollars_now,
       (select max(total_cost_cents) from public.mx_work_order) as max_total_cents;

-- Spot check: the part the discrepancy was reported on. 123.00 must read 12300.
select wo_id, name, unit_cost_cents,
       round(unit_cost_cents / 100.0, 2) as dollars
  from public.mx_work_order_part
 where coalesce(unit_cost_cents, 0) <> 0
 order by unit_cost_cents desc
 limit 10;

-- Read the output above. If the dollar figures look like real money, COMMIT.
-- If anything is off by a factor of anything, ROLLBACK -- there is no second
-- chance once this commits, because the inflated value is not recoverable from
-- the corrected one.
-- commit;
rollback;
