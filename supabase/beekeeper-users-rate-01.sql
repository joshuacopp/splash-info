-- Beekeeper users — pay columns, ALTER 01.
--
-- Adds the two Beekeeper custom-profile fields the scheduler needs to price a
-- week: `rate` and `payType`. Run in the Supabase SQL editor. There is no
-- CREATE file for beekeeper_users in this repo — the table predates the
-- supabase/ convention and was provisioned directly — so this is ALTER-only.
--
-- Every statement is guarded; the whole file is safe to re-run.
--
-- WHERE THE VALUES COME FROM (verified against the live tenant 2026-08-22):
--
--   GET /api/2/users?limit=200&offset=0  returns, per user, a `custom_fields`
--   ARRAY (not a keyed map) of objects shaped:
--
--     { "key": "rate", "label": "Rate", "required": false, "type": "number",
--       "value": 42, "visibility": "admin", "editable": true }
--
--   SUPERSEDED 2026-08-26 — `rate` is now a TEXT field, "type": "text", and its
--   value arrives as a STRING ("18.50"). See the note below.
--
--   Sixteen entries per user. Nine are visibility "public"; seven are
--   visibility "admin" — workLocationDashDescription, payType,
--   employmentStatus, middle_initial, post_id, csa_y_or_n, and rate.
--
--   ENDPOINT ASYMMETRY, the reason this works at all: GET /users/{id} strips
--   every admin-visibility field and returns only the nine public ones. The
--   LIST endpoint returns all sixteen with the same bot token. This is
--   per-endpoint, not per-user and not per-token — confirmed against both a
--   tablet "Location Profile" account and a human General Manager. The sync
--   path (runBeekeeperSync -> listAllUsers) already uses the list endpoint, so
--   no extra requests are needed to populate these columns.
--
-- WHY numeric(10,2) AND NOT integer:
--   Storing integer would silently truncate 18.75 to 18 and understate every
--   week that person is scheduled.
--
--   CORRECTION 2026-08-26 — the original note here claimed Beekeeper's "number"
--   type does not constrain the scale. That was WRONG: it accepts whole
--   integers only, which is why no half-dollar rate could be entered at all.
--   The field's type cannot be changed in place, so on 2026-08-26 the integer
--   `rate` field was DELETED and recreated as a TEXT field, same key (`rate`),
--   same admin visibility, and all 36 populated rates were re-entered by hand.
--   Verified end to end the same day: 18.50 entered in Beekeeper lands here as
--   18.50.
--
--   DO NOT "FIX" THE BEEKEEPER FIELD BACK TO TYPE number. It looks like the
--   tidier choice and it silently removes the ability to express cents. The
--   text field is deliberate.
--
--   Because the value now arrives as a string typed by a human, beekeeper.ts
--   parses it through `parseMoneyish`, which tolerates "$18.50", "18,50",
--   "18.50/hr" and stray whitespace, and REJECTS anything ambiguous ("16-18")
--   to null rather than guessing. Null renders as an explicit unrated flag on
--   the schedule; a guess would ship a wrong pay rate silently.
--
-- WHY NULLABLE, AND WHY NO DEFAULT:
--   Most of the tenant has not been backfilled yet (at Vestal, 2 of 11 users
--   have a rate). NULL means "not entered", which the scheduler renders as an
--   explicit "unrated shifts" flag on the day. A DEFAULT 0 would be
--   indistinguishable from a genuine zero and would make an unpriced day look
--   cheap instead of unknown — the exact failure this feature exists to avoid.
--
-- WHY pay_type IS STORED EVEN THOUGH THE COST MATH MAY NOT USE IT:
--   A salaried manager's cost does not vary with the hours you schedule them,
--   so hours x rate is the wrong model for them. Whether the grid treats
--   salaried people as a fixed baseline or folds them in, the distinction has
--   to survive the sync to be available at all. Cheap to carry, expensive to
--   re-derive.

-- ===========================================================================
-- 1. beekeeper_users — rate + pay_type.
-- ===========================================================================

ALTER TABLE beekeeper_users ADD COLUMN IF NOT EXISTS rate     numeric(10,2);
ALTER TABLE beekeeper_users ADD COLUMN IF NOT EXISTS pay_type text;

-- Non-negative rather than positive: 0 is a legitimate entry for an unpaid or
-- stipend-only profile, and the tablet "Location Profile" accounts are not
-- people at all. NULL is always allowed — see the header note.
ALTER TABLE beekeeper_users DROP CONSTRAINT IF EXISTS beekeeper_users_rate_nonneg;
ALTER TABLE beekeeper_users ADD CONSTRAINT beekeeper_users_rate_nonneg
  CHECK (rate IS NULL OR rate >= 0);

COMMENT ON COLUMN beekeeper_users.rate IS
  'Beekeeper custom_fields[key=rate].value, visibility=admin. Sync-owned: '
  'overwritten on every runBeekeeperSync. Edit in Beekeeper, never here.';

COMMENT ON COLUMN beekeeper_users.pay_type IS
  'Beekeeper custom_fields[key=payType].value, visibility=admin. Observed '
  'values: "Salary", "Hourly". Sync-owned — see the note on rate.';

-- ===========================================================================
-- 2. Verification — run after applying.
-- ===========================================================================
-- Expect two rows: rate | numeric | YES, and pay_type | text | YES.
--
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'beekeeper_users'
--      AND column_name IN ('rate', 'pay_type')
--    ORDER BY column_name;
--
-- Then force a cache refill (POST /schedule/api/sync-users as a super_admin)
-- and confirm the values landed. Vestal is the seeded location:
--
--   SELECT display_name, pay_type, rate
--     FROM beekeeper_users
--    WHERE org_unit_ids @> '["8d4fbb4d-0137-48b3-a6f7-7e11dc45c0c4"]'::jsonb
--    ORDER BY rate DESC NULLS LAST;
--
-- As of 2026-08-22 that should show Kaylee Shoemaker at 42.00 (Salary) and the
-- Vestal Wash tablet profile at 20.00, with the other nine users NULL.
