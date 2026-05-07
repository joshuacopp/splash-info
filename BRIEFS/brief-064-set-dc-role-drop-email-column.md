# Brief 64: `setDcRole` drops `email` from `damage_claim_user_roles` upsert (column doesn't exist)

**Status:** Completed (2026-05-07)
**Started:** 2026-05-07
**Completed:** 2026-05-07
**Blocks:** Brief 61's "Set DC Role" tool 500s on every submission.
CF logs (2026-05-07, requestId `5ZAAKPF23IPE2KMG`) confirm Postgres
error 42703: `column damage_claim_user_roles.email does not exist`.
Operator can't grant or modify dc_role through the new tool.
**Dependencies:** Brief 61 (the helper this brief patches).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-061-sysadmin-set-dc-role-tool.md (the brief that
  introduced the bug)
- packages/db-supabase/src/users.ts (`setDcRole` helper — the
  upsert that includes the bad `email` column)
- packages/db-supabase/src/auth-context.ts (the canonical view
  contract; confirms `damage_claim_user_roles` shape is just
  `(user_id, dc_role)` — email is joined from `auth.users` by
  the view)

## Context

Brief 61 modeled `setDcRole` after `setRole` from
`packages/db-supabase/src/users.ts`. `setRole` writes to
`user_permissions`, which legitimately carries an `email`
column (denormalized for fraud-detection lookups per the
legacy schema).

`damage_claim_user_roles` does NOT carry email. Its columns are
just `user_id` (PK) and `dc_role`. Email-on-this-table was added
by Brief 61's executor as a parallel to `setRole`'s shape, but
the actual schema rejects it with 42703 (undefined column).

Operator-confirmed CF log shows the exact failure:
```
column damage_claim_user_roles.email does not exist
```

Fix: drop `email` from the upsert payload. The function
signature can keep its `email: string` argument (callers pass
it from session.email; useful for the audit-log entry which
DOES need the email in a non-database place) — but we don't
write it into the dc_role row.

## Scope

### Phase 1 — Drop email from the upsert payload

1.1 In `packages/db-supabase/src/users.ts`, locate `setDcRole`
(introduced in Brief 61). Find the upsert call to
`damage_claim_user_roles` (typically inside the `role !== null`
branch — Brief 61's Phase 2.2 step 4). The payload looks like:

```ts
.upsert({
  user_id: args.userId,
  email: args.email,      // ← BUG: column doesn't exist
  dc_role: args.role
})
```

Remove the `email` line:

```ts
.upsert({
  user_id: args.userId,
  dc_role: args.role
})
```

1.2 Keep the function's `email: string` argument intact. Callers
(the sysadmin-worker handler from Brief 61) already pass it,
and the audit-log path may reference it. Argument-shape change
isn't necessary; we're only fixing the SQL payload.

1.3 If Brief 61's executor wrote a docblock claiming
`damage_claim_user_roles` has an email column (e.g., "writes
`(user_id, email, dc_role)`"), update it to "writes
`(user_id, dc_role)`. Email lives on auth.users and is joined
by the auth-context view at read time."

1.4 No other change in this file. The
`damage_claim_user_locations` writes (per-location row inserts)
are untouched — that table also has no email column, but the
helper wasn't passing one to it (verified via Brief 61's Phase
2.2 step 4 — only `(user_id, location_code)`). So this fix is
isolated to the dc_role table's upsert.

### Phase 2 — Validation

2.1 `pnpm typecheck` — must pass for all 13 packages. (No
TypeScript signature change is expected; this is a runtime SQL
fix.)
2.2 `pnpm --filter @splash/sysadmin-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed; clean
   up afterward.
2.3 No schema changes. No new env vars. No new endpoints.

### Phase 3 — Updates

3.1 BRIEFS/INDEX.md: Brief 64 row appended.

3.2 BUILD_STATE.md: Findings entry noting:
  - Brief 61's `setDcRole` shipped with a Postgres 42703 bug:
    upsert payload included `email`, but
    `damage_claim_user_roles` only has `(user_id, dc_role)`
  - Symptom: every Set DC Role submission 500s with
    `column damage_claim_user_roles.email does not exist`
  - Fix: drop the `email` field from the upsert call
  - Lesson: `damage_claim_user_roles` and
    `damage_claim_user_locations` both omit email (it's joined
    from auth.users by the auth-context view); future helpers
    touching these tables should NOT model their writes after
    `user_permissions` (which legitimately carries email)
  - Operator follow-up: re-test Set DC Role on the same user
    that triggered requestId `5ZAAKPF23IPE2KMG` and confirm a
    200 response

3.3 CLAUDE.md updates:
  - Glossary entry for `damage_claim_user_roles` (or the
    sysadmin section that documents the table) — add a one-line
    note: "Schema: `(user_id, dc_role)`. Email lives on
    auth.users; the auth-context view joins it on read.
    Sysadmin writes do NOT include email — that pattern is
    user_permissions-specific."

## Out of scope

- Adding `email` to `damage_claim_user_roles` as a denormalized
  column. The auth-context view already joins; no operational
  reason to denormalize.
- Refactoring `setDcRole` to accept fewer arguments. The email
  argument stays for audit-log use; only the SQL payload
  changes.
- Backfilling. Nothing to backfill — failed submissions never
  wrote anything.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `setDcRole`'s upsert into `damage_claim_user_roles` passes
  only `(user_id, dc_role)` — no `email` field
- Function signature unchanged (still takes `email: string`)
- Docblock updated to reflect the table's actual columns
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/sysadmin-worker exec wrangler deploy
  --dry-run bundle succeeds (clean up after)
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely 1-3 lines net: payload field removal +
  docblock update)
- Confirmation that `damage_claim_user_locations` writes were
  already correct (no email column referenced)
- Validation results
- Any decisions made on the operator's behalf

## Outcome

**Files modified:** 3
- `packages/db-supabase/src/users.ts` — dropped `email` from
  `DamageRoleRow` interface; dropped `email` from upsert payload
  (Phase 1.1); dropped `email` from BOTH `.select(...)` calls (the
  unconditional before-snapshot read on the dc_role table and the
  upsert RETURNING select); appended a Brief 64 schema note to the
  `setDcRole` docblock explaining that writes pass only
  `(user_id, dc_role)` and the `email` arg is kept on the signature
  for the audit-log path.
- `apps/sysadmin-worker/src/index.ts` — `handleSetDcRole` docblock
  rewritten to drop the "damage_claim_user_roles.email is NOT NULL on
  inserts" claim; inline `// Resolve email — damage_claim_user_roles.email
  is NOT NULL.` comment rewritten to clarify that the email arg is
  passed to the helper for the audit-log path only (not written to
  the dc_role table).
- `CLAUDE.md` — schema note appended to the existing sysadmin /
  audit-log paragraph: `damage_claim_user_roles` is `(user_id, dc_role)`,
  `damage_claim_user_locations` is `(user_id, location_code)`; email
  lives on `auth.users` and is joined by the `auth_unified` view at
  read time; future dc_role helpers must NOT model their writes after
  `user_permissions` (which legitimately denormalizes email for
  fraud-detection lookups).

Plus standard tracking-doc updates: `BRIEFS/INDEX.md` (Brief 64 row
appended), `BUILD_STATE.md` (line-3 stamp prepend + Findings entry),
brief Status flipped to `Completed (2026-05-07)`.

**Files created:** none.

**Decisions made on operator's behalf:**
1. **Extended the fix beyond Phase 1.1's literal scope.** The brief
   asked to drop `email` from the upsert payload only, with Phase 1.4
   stating "No other change in this file." But the helper also has
   two `.select("user_id,email,dc_role")` calls — the unconditional
   before-snapshot read at users.ts:366 (which would 42703 *before*
   the upsert is reached) and the upsert RETURNING select at
   users.ts:421 (part of the same INSERT-ON-CONFLICT-RETURNING
   statement, same column-doesn't-exist failure). Both had to drop
   `email` for the function to succeed end-to-end; the operator
   follow-up step in the brief — re-test on the failing user, expect
   200 — is otherwise unreachable. Strict literal compliance with
   Phase 1.4 would have left the function still 42703-failing on the
   first SELECT. Phase 1.4's stated rationale was about
   `damage_claim_user_locations` writes (which were already correct
   and remain untouched), so I read the directive as "don't touch
   the dc_locations writes" rather than "don't fix the in-table
   email selects on dc_role." The fix correctness is unchanged
   either way; only the diff size is bigger.
2. **Function signature kept (per Phase 1.2).** `email: string`
   stays on the args type. Callers (sysadmin-worker
   `handleSetDcRole`) continue to resolve it from the auth admin
   API and pass it through. The helper just doesn't write it to
   the dc_role table.
3. **Touched `apps/sysadmin-worker/src/index.ts`'s comment.** The
   brief's Phase 3.3 only called out CLAUDE.md updates, but leaving
   the misleading inline "damage_claim_user_roles.email is NOT NULL"
   comment in `handleSetDcRole` would propagate the same wrong
   assumption to the next reader. One-line correction.
4. **`DamageRoleRow` interface dropped `email`.** The interface was
   used as the type for both `.select(...)` results; with email gone
   from the selects, the `email: string` field was dead. Removing it
   keeps the type honest about the actual row shape.
5. **No `.tmp-build` artifact left behind.** The Definition-of-Done
   step says "clean up after"; the directory was removed
   post-validation.

**Confirmation that `damage_claim_user_locations` writes were
already correct:** verified — the inserts at users.ts:454
(`{ user_id, location_code }`) reference only the two columns that
exist on that table; no email field referenced anywhere in the
helper's locations writes (deletes, inserts) or selects.

**Latent issues found:**
- **PostgREST behavior question.** The brief identified the upsert
  as the failing call, suggesting the operator's CF log message was
  tagged to the upsert specifically. If PostgREST's column-resolution
  follows PostgreSQL semantics, the line-366 SELECT should have
  failed first (it's unconditional and runs before the upsert is
  reached). The discrepancy is unresolved here, but doesn't affect
  the correctness of the fix — both refs to `email` are removed, so
  whichever statement was actually failing is now resolved.
- **Audit-log entries pre-Brief-64 do not exist.** Failed
  submissions never wrote any rows. The audit-log filter
  `target_type = damage_claim_user_roles` will have zero rows
  until the first successful invocation post-fix. (Not a bug —
  noted for clarity.)

**Validation results:**
- `pnpm typecheck` — 13 successful, 13 total (3.504s, 6 cache hits +
  fresh rebuilds on `@splash/db-supabase`, `@splash/auth`,
  `@splash/sysadmin-worker`, `@splash/dashboard-worker`,
  `@splash/signup-worker`, `@splash/performance-worker`,
  `@splash/damage-worker`).
- `pnpm --filter @splash/sysadmin-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build` — bundle succeeded; Total Upload
  **760.66 KiB / gzip 143.35 KiB** (Brief 61 baseline 760.70 KiB /
  gzip 143.35 KiB → essentially identical, as expected for a
  few-line diff in a single helper). `.tmp-build` cleaned up
  afterward via `rm -rf apps/sysadmin-worker/.tmp-build`.
- No schema change. No new env vars. No new endpoints.
- No git commit, no push, no Cloudflare deploy (per CLAUDE.md
  headless rules).

**Diff size:** ~6 functional lines removed (3 references to
`email` dropped from the helper's selects/upsert + 1 field dropped
from the interface) plus ~10 lines of docblock/comment rewrite
across 2 files. Net change is small and surgical.
