-- Task #17 close-out. Run AFTER the targeted 2025 seed
-- (POST /manage/api/seed/jotform?...&only=DC2025...), which inserts these 13
-- at their initial determination status with no amount.
--
-- WHY THIS EXISTS: the 2026 books need the paperwork for cheques cut in 2026,
-- and 13 of those cheques were raised against 2025 claims. The seeder is phase
-- 1 only — it never sets a final status, because for 2026 that job belongs to
-- the master workbook. There is no 2025 workbook, so the check requests
-- themselves are the authority: a cheque was cut, therefore the claim was paid,
-- and the cheque amount is the approved amount.
--
-- Amounts are transcribed from the check-request form's `unresolved` dump
-- (form 250654062100038), one row per uniqueId.
--
-- Guarded on lifecycle_state = 'Open' so a second run is a no-op and so nothing
-- a human has since touched gets stamped back over.

DROP TABLE IF EXISTS _cr_2025;
CREATE TABLE _cr_2025 (uid TEXT PRIMARY KEY, amount REAL NOT NULL);

INSERT INTO _cr_2025 (uid, amount) VALUES
  ('jotform:DC202500539', 1392.02),
  ('jotform:DC202500629', 3258.60),
  ('jotform:DC202500663', 553.02),
  ('jotform:DC202500706', 1396.98),
  ('jotform:DC202500715', 694.07),
  ('jotform:DC202500724', 2435.15),
  ('jotform:DC202500736', 387.09),
  ('jotform:DC202500747', 724.61),
  ('jotform:DC202500790', 791.35),
  ('jotform:DC202500798', 1836.00),
  ('jotform:DC202500801', 367.31),
  ('jotform:DC202500804', 220.32),
  ('jotform:DC202500815', 35.28);

UPDATE claims
SET claim_status = 'Closed — Paid',
    lifecycle_state = 'Closed',
    approved_amount = (SELECT c.amount FROM _cr_2025 c WHERE c.uid = claims.idempotency_key),
    status_updated_by = 'migration',
    status_updated_at = datetime('now')
WHERE deleted_at IS NULL
  AND lifecycle_state = 'Open'
  AND idempotency_key IN (SELECT uid FROM _cr_2025);

-- Verify: all 13 should read Closed — Paid with the amount above.
SELECT c.claim_id, c.idempotency_key, c.customer_name, c.claim_status,
       c.lifecycle_state, c.approved_amount
FROM claims c
WHERE c.deleted_at IS NULL
  AND c.idempotency_key IN (SELECT uid FROM _cr_2025)
ORDER BY c.idempotency_key;

DROP TABLE _cr_2025;
