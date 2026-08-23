-- Beekeeper users — roster eligibility columns, ALTER 01.
--
-- Companion to beekeeper-users-rate-01.sql. That file made the week priceable;
-- this one keeps the price from drifting as people leave.
--
-- Run in the Supabase SQL editor. Every statement is guarded, so the whole file
-- is safe to re-run.
--
-- THE PROBLEM THIS SOLVES
--
--   runBeekeeperSync is upsert-only — it never deletes. That is correct for a
--   cache (a failed or partial listing must not wipe the roster), but it means
--   a row, once written, lives forever. Combined with the scheduler's payroll
--   card, which derives the SALARIED baseline from the roster rather than from
--   shifts, a departed General Manager keeps contributing rate x 40h to the
--   week total indefinitely. Nobody would notice: the number is plausible, it
--   just quietly overstates the budget by ~$3.4k a week per ghost.
--
-- WHY THREE SIGNALS, AND WHY synced_at IS THE ONE THAT FIRES
--
--   Resolved 2026-08-23 against the live tenant, using a real case: Carter
--   Mullen (Batavia Veterans, suspended 2026-08-06) was still showing in the
--   scheduler's employee dropdown weeks after leaving.
--
--     GET /users/688450a6-fc9c-4517-b15c-83ea048b01c7
--       -> suspended: true, suspended_at "2026-08-06T20:36:47",
--          state "suspended", org_unit_ids STILL containing Batavia.
--
--     GET /users?limit=200&org_unit_id=6c40c0d8-0534-4f3b-9720-e2ffdd8443c6
--       -> exactly 8 users, matching the Beekeeper location UI. Carter absent.
--
--   So THE LIST ENDPOINT EXCLUDES SUSPENDED USERS. The sync reads the list, so
--   it can never observe suspended:true — a deactivated person does not come
--   back flagged, they stop coming back at all. And because the sync is
--   upsert-only and never deletes, their row survives untouched with stale
--   org_unit_ids still pointing at the location, which is exactly what put
--   Carter in that dropdown. Falling out of the listing IS the signal, and
--   synced_at is the only column that records it.
--
--   employmentStatus is worse: it reads "Active" on every user ever observed,
--   Carter included. It is not maintained on offboarding.
--
--   So beekeeper_users carries all three and db.ts::isRosterEligible ORs them:
--
--     suspended          Beekeeper-native, top-level, set by the platform
--                        rather than typed by a human — least likely to be
--                        forgotten during offboarding. Only TRUE disqualifies.
--
--     employment_status  custom_fields[key=employmentStatus], visibility=admin,
--                        free text. Only a non-empty non-"Active" value
--                        disqualifies; blank means "nobody filled it in" and
--                        must not silently remove a real employee.
--
--     synced_at          The load-bearing one. A row more than
--                        ROSTER_STALE_DAYS (2) behind THE NEWEST ROW is treated
--                        as departed. Row-relative, not wall-clock: if the sync
--                        itself dies, every row ages together, nothing is stale
--                        relative to anything else, and no roster is emptied.
--                        The filter only bites while the sync is provably alive.
--
--   NOT USED: the top-level `state` field ("created" | "invited" | "active").
--   It tracks the Beekeeper login lifecycle, not employment. 414 of ~1000
--   observed records are "created" or "invited" — new hires and tablet
--   profiles who never signed in. Filtering on it would delete a third of the
--   roster from the dropdown.
--
-- WHY suspended IS NOT NULL DEFAULT false
--   A three-valued eligibility flag is a trap: NULL would have to mean either
--   "assume employed" or "assume gone", and both are wrong in some case. The
--   sync writes an explicit boolean on every run, so the default only ever
--   applies to the instant between this ALTER and the next sync.

-- ===========================================================================
-- 1. beekeeper_users — eligibility columns.
-- ===========================================================================

ALTER TABLE beekeeper_users
  ADD COLUMN IF NOT EXISTS employment_status text;

ALTER TABLE beekeeper_users
  ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;

-- Should already exist (the sync has been writing it), but the table predates
-- the supabase/ convention so there is no CREATE file to point at.
ALTER TABLE beekeeper_users
  ADD COLUMN IF NOT EXISTS synced_at timestamptz;

COMMENT ON COLUMN beekeeper_users.employment_status IS
  'Beekeeper custom_fields[key=employmentStatus].value, visibility=admin. '
  'Sync-owned: overwritten on every runBeekeeperSync. Edit in Beekeeper, '
  'never here. Only a non-empty non-Active value removes someone from the '
  'assignable roster — see db.ts::isRosterEligible.';

COMMENT ON COLUMN beekeeper_users.suspended IS
  'Beekeeper top-level `suspended` flag (NOT a custom field). Sync-owned. '
  'True removes the user from the assignable roster and from the salaried '
  'payroll baseline. Not the same as `state`, which is login lifecycle.';

COMMENT ON COLUMN beekeeper_users.synced_at IS
  'Last runBeekeeperSync touch. A row older than ROSTER_STALE_DAYS (7) is '
  'treated as a departed user: the sync never deletes, so a hard-deleted '
  'Beekeeper account shows up here as a row that stopped advancing.';

-- Partial index: reads always want the eligible set, which is nearly the whole
-- table today but will not be forever.
CREATE INDEX IF NOT EXISTS beekeeper_users_active_idx
  ON beekeeper_users (id)
  WHERE suspended = false;

-- ===========================================================================
-- 2. Verification — run after applying.
-- ===========================================================================
-- Expect three rows: employment_status | text | YES, suspended | boolean | NO,
-- synced_at | timestamp with time zone | YES.
--
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'beekeeper_users'
--      AND column_name IN ('employment_status', 'suspended', 'synced_at')
--    ORDER BY column_name;
--
-- After the next sync (6 AM ET daily, or POST /schedule/api/sync-users), every
-- row should be suspended = false and employment_status = 'Active'. That is
-- the expected steady state for this tenant TODAY — the filter is a no-op on
-- current data by design, and only starts removing people once Beekeeper
-- reports someone as gone.
--
--   SELECT employment_status, suspended, count(*)
--     FROM beekeeper_users
--    GROUP BY 1, 2
--    ORDER BY 3 DESC;
--
-- Anyone the roster filter will drop. Unlike the two queries above this is NOT
-- expected to be empty — it is the ghost list, and Carter Mullen
-- (688450a6-fc9c-4517-b15c-83ea048b01c7, suspended 2026-08-06) should appear:
--
--   SELECT display_name, pay_type, rate, employment_status, suspended, synced_at
--     FROM beekeeper_users
--    WHERE suspended
--       OR (coalesce(employment_status, '') <> '' AND employment_status <> 'Active')
--       OR synced_at < (SELECT max(synced_at) FROM beekeeper_users)
--                      - interval '2 days'
--    ORDER BY synced_at;
--
-- Batavia Veterans specifically — should return the same 8 names the Beekeeper
-- location page shows, with Carter, Cayleigh Havens and Sofia Branche stale:
--
--   SELECT display_name, suspended, synced_at
--     FROM beekeeper_users
--    WHERE org_unit_ids @> '["6c40c0d8-0534-4f3b-9720-e2ffdd8443c6"]'::jsonb
--    ORDER BY synced_at DESC, display_name;
