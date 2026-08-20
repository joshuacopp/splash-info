-- Step 3 of the 2026 workbook cost backfill. Run ONLY after wb_cost_load.sql
-- and after the coverage SELECT looks sane.
--
-- Fills approved_amount only where it is currently NULL, so anything the live
-- approval flow set is left alone and a second run is a no-op.

UPDATE claims
SET approved_amount = (
      SELECT w.cost FROM _wb_cost w
      WHERE 'jotform:DC' || w.jot = claims.idempotency_key
         OR claims.staff_notes LIKE '%JOT# ' || w.jot || '%'
      LIMIT 1
    )
WHERE deleted_at IS NULL
  AND approved_amount IS NULL
  AND submitted_at >= '2026-01-01'
  AND EXISTS (
      SELECT 1 FROM _wb_cost w
      WHERE 'jotform:DC' || w.jot = claims.idempotency_key
         OR claims.staff_notes LIKE '%JOT# ' || w.jot || '%');

SELECT COUNT(*) AS with_amount
FROM claims
WHERE deleted_at IS NULL AND submitted_at >= '2026-01-01' AND approved_amount > 0;
