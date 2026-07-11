-- Feature 4 — add vehicle_condition to claims.
--
-- Plain TEXT column, nullable, no CHECK constraint: the allow-list
-- ("Poor" | "Fair" | "Good" | "Excellent") is enforced in the worker on
-- submit, mirroring how damage_type/damage_other are handled. Existing rows
-- keep NULL. Additive and backwards-compatible — apply before or after the
-- code deploy; the writeClaimBatch legacy fallback tolerates the column being
-- briefly absent during the deploy window.
ALTER TABLE claims ADD COLUMN vehicle_condition TEXT;
