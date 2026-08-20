-- Retype the "check request only" claims so their cost is reported.
--
-- WHY: the dashboard's cost figures sum claim_photos.amount for photo_type IN
-- ('Quote','Receipt'). 'Check Request' is deliberately excluded there, because a
-- claim normally has BOTH an estimate and a check request for the same money and
-- counting both would double the cost.
--
-- These claims are the exception: the check-request importer generated a PDF for
-- them because the submission carried an amount and a payee but no attached
-- file, so there is no estimate row behind it. The generated PDF is the only
-- document the payment has. Retyping it to 'Receipt' and giving it the amount
-- makes it count, and there is nothing to double-count against — the WHERE
-- clause below requires the claim to have no Quote or Receipt row at all.
--
-- Safe to re-run: after the first pass these rows are no longer photo_type
-- 'Check Request', so they fall out of the filter.

UPDATE claim_photos
SET photo_type = 'Receipt',
    amount = (SELECT c.approved_amount FROM claims c WHERE c.claim_id = claim_photos.claim_id),
    notes = COALESCE(notes || ' ', '')
            || 'Retyped from Check Request during the 2026 migration so the amount reports.'
WHERE id IN (
  -- MIN(id): a claim with two generated check requests gets the amount once.
  SELECT MIN(p.id)
  FROM claim_photos p
  JOIN claims c ON c.claim_id = p.claim_id
  WHERE p.deleted_at IS NULL
    AND p.photo_type = 'Check Request'
    AND c.deleted_at IS NULL
    AND c.claim_status = 'Closed — Paid'
    AND c.submitted_at >= '2026-01-01'
    AND c.approved_amount IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM claim_photos q
      WHERE q.claim_id = c.claim_id
        AND q.deleted_at IS NULL
        AND q.photo_type IN ('Quote', 'Receipt')
    )
  GROUP BY p.claim_id
);

-- Re-run of the four-way split. Expect 'check request only' to drop to 0 and
-- 'counted' to rise by the same number.
SELECT CASE
         WHEN EXISTS (SELECT 1 FROM claim_photos p WHERE p.claim_id = c.claim_id
                        AND p.deleted_at IS NULL AND p.photo_type IN ('Quote','Receipt')
                        AND p.amount IS NOT NULL) THEN 'counted'
         WHEN EXISTS (SELECT 1 FROM claim_photos p WHERE p.claim_id = c.claim_id
                        AND p.deleted_at IS NULL AND p.photo_type = 'Check Request')
              THEN 'check request only — NOT counted'
         WHEN EXISTS (SELECT 1 FROM claim_photos p WHERE p.claim_id = c.claim_id
                        AND p.deleted_at IS NULL AND p.photo_type IN ('Quote','Receipt'))
              THEN 'doc but no amount'
         ELSE 'no document at all'
       END AS bucket,
       COUNT(*) AS n
FROM claims c
WHERE c.deleted_at IS NULL
  AND c.claim_status = 'Closed — Paid'
  AND c.submitted_at >= '2026-01-01'
GROUP BY 1
ORDER BY n DESC;
