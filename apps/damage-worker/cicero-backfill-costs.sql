-- Cicero backfill — repair-cost line item (Coudriet only).
--
-- WHY THIS EXISTS: the Damage Reporting "cost" figure is NOT read from
-- claims.approved_amount. It sums claim_photos.amount across rows whose
-- photo_type is 'Quote' or 'Receipt', joined to approved/paid claims (see the
-- costSql / byLocationCostSql queries in src/index.ts). The bare cicero
-- backfill set approved_amount on the claim but created no Quote/Receipt line
-- items, so reporting shows Cicero cost = $0 even though four claims were paid.
--
-- SCOPE: this file now covers ONLY Fran Coudriet (1252026001, $1812.99) — the
-- one paid claim with no check-request PDF on hand. The other three paid claims
-- are being given a REAL Receipt via the dashboard document upload (type =
-- Receipt, with the amount entered), which both files the actual PDF and feeds
-- the cost rollup:
--   1252026002 Purna Tamang    1029.24  → upload real PDF as Receipt
--   1252026004 David Bliss      110.00  → upload real PDF as Receipt
--   1252026007 Jennifer Clark  1314.26  → upload real PDF as Receipt
-- DO NOT also add placeholder Receipt rows for those three — it would
-- double-count against the amounts entered on upload.
--
-- SIDE EFFECT TO KNOW: claim_photos.filename and r2_key are NOT NULL, so this
-- row carries a placeholder key. No actual file exists in R2, so on the claim
-- detail page it appears as a Receipt document whose download link 404s. The
-- notes column flags it as backfill. Inert for reporting; only affects the
-- per-claim document list. Replace it with a real upload if a document surfaces.
--
-- PREREQUISITE: run cicero-backfill.sql first (the parent claim row must exist).
--
-- Run (from apps/damage-worker):
--   wrangler d1 execute splash-damage-claims --remote --file=cicero-backfill-costs.sql
-- Or paste into the D1 console. Drop --remote to dry-run the local replica.

INSERT INTO claim_photos
  (claim_id, photo_type, filename, r2_key, uploaded_by, amount, notes)
VALUES
  ('1252026001','Receipt','backfill-no-file','backfill/1252026001/receipt',
   'backfill',1812.99,'Legacy backfill — amount only, no receipt document on file');
