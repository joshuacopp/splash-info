# Brief 61: Sysadmin "Set DC Role" tool — write `damage_claim_user_roles` + `damage_claim_user_locations`

**Status:** Completed (2026-05-07)
**Started:** 2026-05-06
**Completed:** 2026-05-07
**Blocks:** Every user created or role-changed through the
sysadmin UI ends up with NO `/admin/damage` access today, because
`damage_claim_user_roles` (dc_role) and `damage_claim_user_locations`
(dc_locations) are never written by any sysadmin handler. Operators
have been inserting those rows via direct SQL. Operator confirmed
2026-05-06: this gap should have been closed already.
**Dependencies:** None.

## Read first

- CLAUDE.md (`dc_role` glossary entry — `super_admin` sees all
  claims; `gm`/`rm` sees only their dcLocations)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-007-sysadmin-ui.md (the original sysadmin UI brief
  with the existing 5 user-mgmt cards)
- BRIEFS/brief-030-sysadmin-mode-hub-and-audit-log.md (the
  two-mode hub `?mode=users` / `?mode=tables` — this brief adds a
  6th card to Manage Users mode)
- BRIEFS/brief-039-set-role-location-code-picker.md (the
  LocationCodePicker that lives in `apps/web/app/admin/sysadmin/_components/`
  — this brief adds a multi-select sibling)
- packages/db-supabase/src/users.ts (`setRole`,
  `createUserPermissionsRow` — the sibling helpers; this brief
  adds a sibling for dc_role)
- packages/db-supabase/src/auth-context.ts (the canonical view
  contract — confirms `dc_role` comes from
  `damage_claim_user_roles` and `dc_locations` from
  `damage_claim_user_locations`)
- packages/auth/src/index.ts (auth contract — security item #5
  about dc_role precedence)
- apps/sysadmin-worker/src/index.ts (existing handler patterns:
  `handleSetRole`, `handleCreateUser`, `handleGrantTool`,
  `logSysadminAudit` — this brief adds a sibling
  `handleSetDcRole`)

## Context

`damage_claim_user_roles` carries one row per user with a
single `dc_role` value: `gm` / `rm` / `admin` / `super_admin`.
`damage_claim_user_locations` carries N rows per user — one
per location_code that user is scoped to. `gm`/`rm` users are
scope-restricted to their dc_locations on every damage-worker
read; `super_admin` and `admin` (the dc-system admin role,
distinct from user_permissions.super_admin) bypass scoping.

Setting these requires a dedicated tool because:
1. The values are independent of user_permissions.role. A user
   can be `location_admin` for Oswego (in user_permissions) AND
   `gm` for Oswego (in dc_role) — both are needed.
2. dc_locations is multi-value. The existing single-location
   LocationCodePicker (Brief 39) doesn't fit.
3. Atomicity: setting dc_role without dc_locations leaves a `gm`
   or `rm` with empty scope (sees nothing); setting dc_locations
   without a dc_role leaves the locations dangling. The two
   tables must be written together in one transaction-ish flow.

This brief adds a 6th Manage Users card: **Set DC Role**. It
mirrors the existing Set Role card's UX but writes to the dc_*
tables instead of user_permissions.

## Scope

### Phase 1 — Multi-select location picker

1.1 Create
`apps/web/app/admin/sysadmin/_components/LocationCodeMultiPicker.tsx`
(client component). Sibling to Brief 39's `LocationCodePicker`.

  - Inputs: `name: string` (form field name; rendered as
    repeated hidden inputs `<input type="hidden" name="..." value="...">`
    so server-side `formData.getAll(name)` returns the array),
    `defaultValues?: string[]`, `placeholder?: string`.
  - Behavior: search box typeahead against the existing
    `GET /sysadmin/api/pricing-simple/locations?q=` endpoint
    (Brief 39). Selected entries render as removable chips above
    the input. Clicking a typeahead result adds it to the
    selection. Clicking a chip's × removes it.
  - State: `useState<Array<{ code: string; pretty: string }>>`
    seeded from `defaultValues`. Each value resolved via the same
    search endpoint to get the pretty label (one resolution call
    on mount when `defaultValues.length > 0`).
  - Submit shape: emits one `<input type="hidden" name={name}
    value={code}>` per selected location_code so the server
    receives `formData.getAll(name)` as `string[]`.
  - Visual: matches Brief 39's picker styling. Chip color:
    `bg-splash-blue` text-white pill with × icon.

1.2 Add a "(none — all locations)" affordance: when role is
`super_admin` or `admin`, dc_locations is irrelevant (those
roles bypass scoping). The form-side rendering can grey out the
picker in that case. Worker still validates the same way:
super_admin/admin paths skip the locations write.

### Phase 2 — `packages/db-supabase` — new helper

2.1 In `packages/db-supabase/src/users.ts`, add:

```ts
export type DcRole = "gm" | "rm" | "admin" | "super_admin";

/**
 * Set a user's dc_role + dc_locations atomically. Mirrors the
 * setRole/clearRole pattern but for the damage-claim permission
 * tables.
 *
 * - role !== null: upsert damage_claim_user_roles + replace
 *   damage_claim_user_locations rows
 * - role === null: delete from both tables (clears DC access)
 *
 * For super_admin / admin, dc_locations is irrelevant — those
 * roles bypass scoping. The helper still wipes the user's
 * dc_locations rows on those roles to avoid stale data leakage
 * if the role is later downgraded.
 */
export async function setDcRole(
  client: SupabaseClient,
  args: {
    userId: string;
    email: string;
    role: DcRole | null;
    /** Required for gm/rm; ignored otherwise. */
    locationCodes?: string[];
  }
): Promise<{
  before: {
    role: DcRole | null;
    location_codes: string[];
  };
  after: {
    role: DcRole | null;
    location_codes: string[];
  };
}>
```

2.2 Implementation outline:
  1. Read `damage_claim_user_roles` for the user. Stash old
     dc_role.
  2. Read `damage_claim_user_locations` for the user. Stash old
     location_codes.
  3. If `role === null`:
     - Delete from `damage_claim_user_roles` where user_id eq.
     - Delete from `damage_claim_user_locations` where user_id eq.
  4. Else:
     - Upsert `damage_claim_user_roles` row with the new
       `(user_id, email, dc_role)`.
     - Delete all existing `damage_claim_user_locations` rows for
       user_id.
     - For `gm`/`rm`: insert one row per `locationCodes[i]` —
       `{ user_id, location_code }`.
     - For `super_admin`/`admin`: skip the location inserts (the
       roles are global).
  5. Return `{ before, after }` for the audit log.

  Atomicity note: Supabase JS client doesn't expose
  transactions; the calls run sequentially. If a step fails
  mid-flight, the helper throws — the audit log captures
  whatever state it ended in. This matches how the existing
  `setRole` handles its delete-then-insert (no rollback).

2.3 Export from `packages/db-supabase/src/index.ts`.

### Phase 3 — Sysadmin worker — new endpoint + handler

3.1 In `apps/sysadmin-worker/src/index.ts`, add:

```
POST /sysadmin/api/users/{userId}/dc-role
```

  - Auth: super_admin only (same as the existing Set Role
    endpoint). Re-use the existing gate.
  - Body shape:
    ```json
    {
      "role": "gm" | "rm" | "admin" | "super_admin" | null,
      "location_codes": ["oswego", "binghamton"]   // omit/empty for null/super_admin/admin
    }
    ```
  - Validation:
    - role must be in the allow-list above OR null (clear).
    - For role === "gm" || "rm": location_codes required, must
      contain at least one valid `^[a-z0-9_]+$` slug, max 50
      entries.
    - For role === "super_admin" / "admin": location_codes
      ignored (worker silently drops them).
    - For role === null: location_codes ignored.
  - Look up the user by userId via existing helper (same as the
    Set Role endpoint does).
  - Call `setDcRole(sb, { userId, email, role, locationCodes })`.
  - Audit log:
    ```ts
    await logSysadminAudit(sb, {
      actor,
      action: "set_dc_role",
      target_type: "damage_claim_user_roles",
      target_id: userId,
      before: { role: oldRole, location_codes: oldLocations },
      after: { role: newRole, location_codes: newLocations }
    });
    ```
  - Return:
    ```json
    {
      "ok": true,
      "user_id": "<uuid>",
      "role": "gm",
      "location_codes": ["oswego"]
    }
    ```

3.2 Add `"set_dc_role"` to the audit-log action allow-list in
`AuditLogPanel.tsx` (`apps/web/app/admin/sysadmin/_sections/AuditLogPanel.tsx`)
and to `ALLOWED_TARGET_TYPES` add `"damage_claim_user_roles"` so
the new entries are filterable in the activity log panel.

### Phase 4 — Apps/web — new "Set DC Role" card

4.1 Create
`apps/web/app/admin/sysadmin/_components/SetDcRoleCard.tsx`
(server component containing an `<ActionForm>` client wrapper
per Brief 19's pattern).

  - Fields:
    - User picker (existing `UserPicker` component)
    - DC Role select: `(none — clear access)` / `gm` / `rm` /
      `admin` / `super_admin`
    - Locations multi-picker (Phase 1) — visible only when role
      is gm or rm
  - Conditional rendering: if role is super_admin / admin /
    none, hide the locations picker. Add an inline hint:
    "super_admin and admin bypass location scoping — no
    locations needed." For "(none)": "This will revoke all
    /admin/damage access."
  - Submit calls a server action that POSTs to
    `/sysadmin/api/users/{userId}/dc-role`.

4.2 Server action: implement `setDcRoleAction` returning
`ActionResult` per Brief 19's contract. Handle 401/403/4xx the
same way the Set Role action does.

4.3 In `apps/web/app/admin/sysadmin/page.tsx`, mount the new
`<SetDcRoleCard>` inside the Manage Users mode (`?mode=users`).
Position: after Set Role (so the user-permissions and dc_role
roles render adjacent for visual symmetry).

### Phase 5 — Optional: Create User integration

5.1 OUT OF SCOPE for v1. Adding dc_role + dc_locations to the
Create User card would be a nice convenience, but conflates
two distinct permission domains in one form. Defer to a
follow-up brief if the operator asks. v1 expectation: admin
runs Create User → then runs Set DC Role (two-step).

### Phase 6 — Validation

6.1 `pnpm typecheck` — must pass for all 13 packages.
6.2 `pnpm --filter @splash/web build` — must succeed.
6.3 `pnpm --filter @splash/sysadmin-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed; clean up.
6.4 No schema changes (the dc_* tables already exist).
6.5 No new env vars or wrangler bindings.
6.6 Confirm the audit log surfaces the new `set_dc_role` action
   correctly in the panel.

### Phase 7 — Updates

7.1 BRIEFS/INDEX.md: Brief 61 row appended.

7.2 BUILD_STATE.md: Findings entry noting:
  - Pre-Brief-61 gap: every user created or role-changed through
    sysadmin tools had NO /admin/damage access by default
    because `damage_claim_user_roles` and
    `damage_claim_user_locations` were never written by any
    sysadmin handler — operators had to insert via direct SQL
  - New sysadmin tool "Set DC Role" closes that gap with a
    single atomic write path: super_admin user picks user + role
    + dc_locations; worker upserts both tables and audits
  - New endpoint `POST /sysadmin/api/users/{userId}/dc-role`
  - New helper `setDcRole` in `packages/db-supabase`
  - New multi-select component `LocationCodeMultiPicker`
  - dc_role for super_admin/admin skips the dc_locations write
    (those roles bypass scoping by design); switching between
    gm/rm and super_admin/admin/none always wipes existing
    dc_locations rows to prevent stale-data leakage on downgrade
  - Operator follow-up: backfill existing users via the new tool
    (any user who got created via sysadmin pre-Brief-61 has empty
    dc_role/dc_locations and currently sees no claims)
  - Audit log filter allow-lists extended:
    `set_dc_role` action + `damage_claim_user_roles` target_type

7.3 CLAUDE.md updates:
  - sysadmin glossary entry: add "**Set DC Role**" tool
    description (6th Manage Users card)
  - Note that user_permissions.role and dc_role are independent
    permission domains and must be set separately

## Out of scope

- Bundling dc_role into the Create User card (Phase 5 — defer).
- Bundling dc_role into Set Role card. They're distinct domains;
  conflating breaks the mental model.
- Adding a "search users by dc_role" filter to the existing
  audit log or user list. The audit-log panel's existing
  `audit_user_id` filter covers this.
- Backfilling existing users programmatically. Operator runs
  Set DC Role manually for each affected user.
- Adding row-level UI feedback when a user's dc_role + role
  combination is mismatched (e.g., user_permissions.location_admin
  for a different location than their dc_locations). The
  permissions are independent; mismatches are valid for
  operational reasons.
- Touching `damage_claim_user_roles.must_change_password` (the
  view INTENTIONALLY ignores it per the auth-context comment).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- New helper `setDcRole(client, args)` exported from
  `packages/db-supabase`; writes both `damage_claim_user_roles`
  and `damage_claim_user_locations` atomically; returns
  before/after snapshots for audit
- New endpoint `POST /sysadmin/api/users/{userId}/dc-role` on
  sysadmin-worker; super_admin gate; validates role + locations;
  audits via `set_dc_role` action
- New component `LocationCodeMultiPicker` mirrors Brief 39's
  picker pattern; emits repeated hidden inputs
- New `<SetDcRoleCard>` mounted on `/admin/sysadmin?mode=users`,
  positioned after Set Role
- Audit-log panel allow-lists extended (`set_dc_role` action,
  `damage_claim_user_roles` target_type)
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/sysadmin-worker exec wrangler deploy
  --dry-run bundle succeeds (clean up after)
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely 350-500 lines net: new helper + endpoint +
  card + multi-picker + audit-log allow-list extensions)
- Confirmation that:
  - Setting role=gm with empty locations is rejected
  - Setting role=super_admin silently drops any submitted
    locations (and wipes existing rows)
  - Setting role=null clears both tables
  - Audit log shows the before/after dc_role + location_codes
- Validation results
- Any decisions made on the operator's behalf

## Outcome

**Files created (3):**
- `packages/db-supabase/src/users.ts` was modified, but the new
  `LocationCodeMultiPicker.tsx`, `SetDcRoleFields.tsx`, and
  `SetDcRoleCard.tsx` are new files under
  `apps/web/app/admin/sysadmin/_components/`.

**Files modified (7):**
- `packages/db-supabase/src/users.ts` — new `DcRole` type alias (re-export
  of `@splash/types/claims` `DamageRole`) and new `setDcRole(client,
  args)` helper. The helper reads current state for both
  `damage_claim_user_roles` and `damage_claim_user_locations`, applies
  the change (delete-both for `role: null`, upsert role + replace
  locations otherwise), and returns `{ before, after }` snapshots for
  the audit log. For `super_admin`/`admin` the locations insert is
  skipped but the locations DELETE still runs (prevents stale-data
  leakage on downgrade). Multi-picker entries are de-duped before insert.
- `apps/sysadmin-worker/src/index.ts` — new `handleSetDcRole` handler;
  imports `setDcRole` + `type DcRole` from `@splash/db-supabase`; new
  module constants `VALID_DC_ROLES`, `DC_ROLE_MAX_LOCATIONS`,
  `DC_ROLE_PATH_RE`; dispatch logic extended to recognize the dynamic
  `POST /sysadmin/api/users/{userId}/dc-role` path via regex (the only
  dynamic-path endpoint on this worker — every other endpoint matches an
  exact path Set). Validation: role allow-list, UUID-shape on path
  userId, `LOCATION_CODE_RE` per location_code, max 50 entries. For
  `gm`/`rm`, location_codes is required; for super_admin/admin/null it's
  silently dropped. Audit-log writes use `action: "set_dc_role"` and
  `target_type: "damage_claim_user_roles"`. Worker leading docblock
  extended with the new endpoint description.
- `apps/sysadmin-worker/src/index.ts` (continued) —
  `ALLOWED_AUDIT_ACTIONS` gains `"set_dc_role"`,
  `ALLOWED_AUDIT_TARGET_TYPES` gains `"damage_claim_user_roles"`,
  `USER_TARGET_TYPES_CSV` gains `damage_claim_user_roles` so the
  audit-log `audit_user_id` filter surfaces DC-role rows.
- `apps/web/app/admin/sysadmin/_components/LocationCodeMultiPicker.tsx`
  (new) — client component sibling to Brief 39's `LocationCodePicker`.
  Multi-select typeahead hitting the same
  `GET /sysadmin/api/pricing-simple/locations?q=` endpoint. Selected
  entries render as `bg-splash-blue` removable chips above a search
  input that re-uses Brief 39's keyboard nav + outside-click dismiss.
  Submit shape: one `<input type="hidden" name={name} value={code}>`
  per selected location_code so the action reads
  `formData.getAll("location_codes")` as `string[]`. On-mount resolution
  call for any pre-filled `defaultValues` so existing dc_locations
  surface as pretty-labelled chips on first render (fail-soft — chips
  fall back to the raw code if resolution fails).
- `apps/web/app/admin/sysadmin/_components/SetDcRoleFields.tsx` (new) —
  small `"use client"` wrapper that owns the chosen role's `useState`
  and renders the locations picker conditionally (visible for `gm`/`rm`,
  hidden with inline hint for `admin` / `super_admin` / `null`). The
  picker itself stays a separate client island handed in as a
  `locationPicker` ReactNode prop so the role-state and picker-state
  don't have to share a component.
- `apps/web/app/admin/sysadmin/_components/SetDcRoleCard.tsx` (new) —
  server component containing an `<ActionForm>` (Brief 19 pattern). User
  picker + DC role select + locations multi-picker, posting to the new
  `setDcRoleAction`. Card is mounted on `/admin/sysadmin?mode=users`
  immediately after `<SetRoleCard>` for visual symmetry between the two
  permission domains.
- `apps/web/app/admin/sysadmin/actions.ts` — new `setDcRoleAction`
  server action. Builds `{ role, location_codes }` JSON body and POSTs
  to `/sysadmin/api/users/{userId}/dc-role` via the existing
  `sysadminPostJson` helper (the path takes the dynamic userId as URL
  segment, encoded with `encodeURIComponent`). Empty `location_codes`
  is sent verbatim for super_admin/admin/null; the worker ignores the
  field for those roles and rejects empty arrays for gm/rm. Result
  message reflects role + chosen-locations count.
- `apps/web/app/admin/sysadmin/_sections/UserOperations.tsx` — imports
  `<SetDcRoleCard>` and renders it after `<SetRoleCard>`. Header
  comment updated from "Five user-management cards" to "Six".
- `apps/web/app/admin/sysadmin/_sections/AuditLogPanel.tsx` —
  `ALLOWED_ACTIONS` and `ALLOWED_TARGET_TYPES` extended in the same
  positions as the worker-side allow-lists.

**Decisions made on operator's behalf:**

1. **Dynamic path dispatch** — the brief's `POST
   /sysadmin/api/users/{userId}/dc-role` is the only dynamic-path
   endpoint on the sysadmin-worker (every other endpoint takes the
   user_id in the body). Added a regex `DC_ROLE_PATH_RE` and an
   `isOwnedDcRolePost` short-circuit in the dispatcher rather than
   refactoring every endpoint to a router pattern. Keeps the change
   focused; the existing exact-path Sets remain unchanged.
2. **`UUID_RE` re-used** — the existing audit-log handler already
   defined a UUID regex; reused it in `handleSetDcRole`'s path
   validation rather than declaring a sibling.
3. **`LOCATION_CODE_RE` re-used** — same instinct; the existing const
   from the create-location handler matches the brief's required
   `^[a-z0-9_]+$` regex exactly.
4. **`SetDcRoleFields` is a separate client wrapper** holding the role
   state. The brief allowed "form-side rendering can grey out the
   picker"; opted for the cleaner show/hide rather than a disabled
   state because the locations field is *strictly* irrelevant for
   super_admin/admin (the worker ignores it). Inline hint copy fires
   for both the bypass-scoping case and the clear-access case.
5. **Multi-picker dedupes silently** before insert — accidentally
   selecting the same location twice (which the picker already
   prevents on the visible side, but defense-in-depth at helper level
   handles any odd race or programmatic re-submit) collapses to one
   row. Mirrors how `setRole`'s replace-all semantics handle their
   own atomicity.
6. **Always wipe `damage_claim_user_locations`** when setting role to
   super_admin/admin (not just when clearing). Matches the brief's
   "switching between gm/rm and super_admin/admin/none always wipes
   existing dc_locations rows" guidance — the row would otherwise be
   load-bearing again if the operator later downgrades to gm/rm.
7. **Dynamic URL via `sysadminPostJson`** — kept the helper as-is
   (path argument is already a string) instead of introducing a
   user_id-as-body alternative. `encodeURIComponent` on the userId
   guards the URL.
8. **Audit-log `before` / `after` shapes** are
   `{ role, location_codes }` objects (not the raw row arrays the
   worker tables use). Matches the brief's audit example and is
   stable to render in the existing AuditLogPanel diff view.
9. **No Create User integration** (brief Phase 5 explicitly
   out-of-scope) — operator runs Create User → Set DC Role as a
   two-step flow.

**Latent issues / forward flags:**

- **Operator backfill** — every user created or role-changed via the
  sysadmin tool pre-Brief-61 currently has empty
  `damage_claim_user_roles` / `damage_claim_user_locations` and sees
  no claims. The new tool is the supported way to remediate; flagged
  in BUILD_STATE.md as a follow-up.
- **`damage_claim_user_roles.email` column assumed** — the brief
  specifies the upsert row shape `(user_id, email, dc_role)`; the
  helper writes that shape verbatim. If the live table schema doesn't
  carry `email`, the upsert will throw and the `set_dc_role` audit row
  never lands. Operator's first invocation of Set DC Role on a real
  user is the empirical confirmation.
- **Multi-picker on-mount resolution issues N requests** for N
  pre-filled defaultValues (one per code). The Set DC Role card today
  doesn't pre-fill (the operator picks role and locations fresh on
  each invocation), so this is dormant — but if a future "edit
  existing assignment" UX wires defaultValues, the helper's per-code
  fetch could be batched into a single `or=(eq.code1,eq.code2,...)`
  request to the existing endpoint. Not blocking.
- **No headless smoke test possible** — operator must redeploy
  splash-sysadmin (CF Workers Builds on push to `main`) and apps/web,
  then exercise the new card from `/admin/sysadmin?mode=users` to
  confirm: (a) gm with no locations is rejected; (b) super_admin
  with submitted locations succeeds, locations are dropped, and any
  pre-existing dc_locations rows are wiped; (c) clearing access deletes
  both rows; (d) the Activity log surfaces a `set_dc_role` row with
  before/after dc_role + location_codes side-by-side via Brief 53's
  full-width diff panel.
- **Bundle deltas** — sysadmin-worker dry-run **760.70 KiB / gzip
  143.35 KiB** (Brief 54 baseline 755.79 / 142.42; +4.91 KiB / +0.93
  KiB gzip; expected delta from new handler + helper + audit-list
  extensions). apps/web `/admin/sysadmin` route bundle **9.2 kB / 114
  kB First Load JS** (Brief 53 baseline 8.38 kB / 113 kB; +0.82 kB /
  +1 kB FLJ from the new client islands `<LocationCodeMultiPicker>` +
  `<SetDcRoleFields>`). Comfortably within budget.
- **CLAUDE.md updated** in the sysadmin glossary entry to describe the
  Set DC Role tool and the user_permissions/dc_role independence
  rule — the latter is the load-bearing context for why the brief
  added a new card rather than folding dc_role into the existing Set
  Role flow.

**Validation:**

- `pnpm typecheck` 13/13 successful, 4.002s (10 cache hits + fresh
  builds on `@splash/db-supabase` + `@splash/auth` +
  `@splash/sysadmin-worker` + `@splash/web` + downstream worker
  consumers — all expected since `users.ts` is in the cache hash).
- `pnpm --filter @splash/web build` succeeded — Next 15.5.15 compiled
  in 5.7s; all 13 routes generated; `/admin/sysadmin` route 9.2 kB /
  114 kB First Load JS.
- `pnpm --filter @splash/sysadmin-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build` succeeded — Total Upload **760.70
  KiB / gzip 143.35 KiB**. `.tmp-build` cleaned up.
