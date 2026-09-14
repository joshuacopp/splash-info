# Brief 159: Sysadmin "Set Promo Role" tool — write `promo_user_roles`

**Status:** Completed (2026-06-06)
**Started:** 2026-06-06
**Completed:** 2026-06-06
**Blocks:** Every user who needs `/admin/promotions` access today is granted via direct SQL INSERT into `promo_user_roles`. The promotions feature (Briefs 153–158b) ships functionally complete, but the role-grant gap means non-super_admin operators can't onboard new users to the feature without engineering involvement. Same gap class Brief 61 closed for `damage_claim_user_roles` (dc_role).
**Dependencies:** Brief 61 (canonical reference implementation — Set DC Role; this brief mirrors its UX + helper + endpoint shapes), Brief 153 (`promo_user_roles` table + `auth_unified` extension; `Session.promoRole` surface), Brief 158a (the existing dashboard tile `visibleTo: s?.promoRole != null` immediately surfaces the new role grant after cookie refresh).

## Read first

- CLAUDE.md (`promo-worker` glossary entry — `promo_role` enum `super_admin | it | marketing | ops | null` on `auth_unified`; `Session.promoRole`; the role-by-role permission table under "Promotions feature")
- BUILD_STATE.md
- BRIEFS/brief-061-sysadmin-set-dc-role-tool.md (canonical reference — this brief is a near-mechanical port of Brief 61 with `dc_role` → `promo_role`, `damage_claim_user_roles` → `promo_user_roles`, and the locations multi-picker dropped entirely since promo_role is a single scalar)
- BRIEFS/brief-153-promo-worker-foundation.md (`promo_user_roles` schema + `auth_unified` join shape)
- BRIEFS/brief-158a-promo-apps-web-read-pages.md (the dashboard tile already gates on `s?.promoRole != null` — once this brief lands, newly-granted users see the Promotions tile after their next cookie refresh)
- packages/db-supabase/src/users.ts (`setRole`, `setDcRole` — sibling helpers; this brief adds `setPromoRole`)
- packages/db-supabase/src/auth-context.ts (canonical view contract — confirms `promo_role` comes from `promo_user_roles`)
- apps/sysadmin-worker/src/index.ts (existing handler patterns: `handleSetDcRole` is the closest sibling — search for `DC_ROLE_PATH_RE` and copy that dispatch shape; `logSysadminAudit`; `ALLOWED_AUDIT_ACTIONS` + `ALLOWED_AUDIT_TARGET_TYPES` + `USER_TARGET_TYPES_CSV`)
- apps/web/app/admin/sysadmin/_components/SetDcRoleCard.tsx + SetDcRoleFields.tsx (the visual + state-handling sibling — `SetPromoRoleCard` mirrors this but drops the locations sub-picker)
- apps/web/app/admin/sysadmin/actions.ts (existing `setDcRoleAction` — sibling pattern for `setPromoRoleAction`)
- apps/web/app/admin/sysadmin/_sections/UserOperations.tsx (where the new card mounts — sibling position after `<SetDcRoleCard>`)
- apps/web/app/admin/sysadmin/_sections/AuditLogPanel.tsx (`ALLOWED_ACTIONS` + `ALLOWED_TARGET_TYPES` allow-lists — both extended by this brief)

## Context

`promo_user_roles` carries one row per user with a single `promo_role` value: `super_admin | it | marketing | ops`. Unlike `damage_claim_user_roles` it has no companion location-scoping table — promo_role is a single scalar that controls feature-level access. The role-by-role permission matrix (full table in CLAUDE.md's "Promotions feature" glossary entry) is enforced server-side via `gatePromoRole` in `@splash/db-supabase` and surfaced to apps/web via `Session.promoRole`.

Today this role is settable only via SQL:

```sql
INSERT INTO promo_user_roles (user_id, promo_role)
VALUES ('<uuid>', 'it')
ON CONFLICT (user_id) DO UPDATE SET promo_role = EXCLUDED.promo_role;
```

That works for super_admin remediation but isn't a sustainable onboarding mechanism — every new IT engineer, marketing operator, or ops user requires a database round-trip through someone with service-key credentials. Brief 159 closes the gap with a sysadmin UI card parallel to Brief 61's Set DC Role, scoped to the single-scalar shape of `promo_role`.

The card is the **7th** Manage Users card (after Brief 61's 6th). Like Set DC Role, it's a distinct permission domain from user_permissions.role and dc_role — a user can be `location_admin` in user_permissions, `gm` in dc_role, AND `marketing` in promo_role; all three are independent.

## Scope

### Phase 1 — `packages/db-supabase` — new helper

1.1 In `packages/db-supabase/src/users.ts`, add:

```ts
export type PromoRole = "super_admin" | "it" | "marketing" | "ops";

/**
 * Set a user's promo_role atomically. Mirrors setDcRole but for the
 * promotions permission table. promo_user_roles is a single-scalar
 * table — no companion locations table.
 *
 * - role !== null: upsert promo_user_roles with the new role
 * - role === null: delete the row (revokes all /admin/promotions access)
 */
export async function setPromoRole(
  client: SupabaseClient,
  args: {
    userId: string;
    role: PromoRole | null;
  }
): Promise<{
  before: { role: PromoRole | null };
  after: { role: PromoRole | null };
}>
```

1.2 Implementation outline:
  1. Read `promo_user_roles` for the user. Stash old role.
  2. If `role === null`:
     - Delete from `promo_user_roles` where user_id eq.
  3. Else:
     - Upsert `promo_user_roles` row with `(user_id, promo_role)`.
       Confirm against the live schema whether the upsert column is
       `promo_role` (matches CLAUDE.md's "new `promo_role` column" prose)
       or a sibling name; the source of truth is
       `supabase/promo-tables.sql` (the schema artifact created during
       Brief 153 planning) and the live `promo_user_roles` table.
  4. Return `{ before, after }` for the audit log.

  No `email` column on this table — `auth_unified` joins email from
  `auth.users` at read time. (Confirm against the live table — if
  `email` is denormalized into `promo_user_roles` the way it is on
  `damage_claim_user_roles`, widen the upsert payload to match.)

1.3 Export from `packages/db-supabase/src/index.ts`.

### Phase 2 — Sysadmin worker — new endpoint + handler

2.1 In `apps/sysadmin-worker/src/index.ts`, add:

```
POST /sysadmin/api/users/{userId}/promo-role
```

  - Auth: super_admin only (same as Set DC Role / Set Role). Reuse
    the existing gate.
  - Body shape:
    ```json
    { "role": "super_admin" | "it" | "marketing" | "ops" | null }
    ```
  - Validation:
    - role must be in the allow-list above OR null (clear).
    - Path userId must match `UUID_RE` (reuse Brief 61's regex).
  - Look up the user by userId via the existing helper (same as
    Set DC Role).
  - Call `setPromoRole(sb, { userId, role })`.
  - Audit log:
    ```ts
    await logSysadminAudit(sb, {
      actor,
      action: "set_promo_role",
      target_type: "promo_user_roles",
      target_id: userId,
      before: { role: oldRole },
      after: { role: newRole }
    });
    ```
  - Return:
    ```json
    {
      "ok": true,
      "user_id": "<uuid>",
      "role": "it"
    }
    ```

2.2 Dispatch — `POST /sysadmin/api/users/{userId}/promo-role` is the
**second** dynamic-path endpoint on the sysadmin-worker (Brief 61
introduced `DC_ROLE_PATH_RE` + `isOwnedDcRolePost` for the first).
Add a sibling `PROMO_ROLE_PATH_RE` and `isOwnedPromoRolePost`
short-circuit alongside the dc-role one. Don't refactor the existing
exact-path Sets.

2.3 Module constants: add `VALID_PROMO_ROLES`, `PROMO_ROLE_PATH_RE`
sibling to Brief 61's `VALID_DC_ROLES` / `DC_ROLE_PATH_RE`. No
`PROMO_ROLE_MAX_LOCATIONS` — promo_role is scalar.

2.4 Audit allow-list extensions:
  - `ALLOWED_AUDIT_ACTIONS` gains `"set_promo_role"`.
  - `ALLOWED_AUDIT_TARGET_TYPES` gains `"promo_user_roles"`.
  - `USER_TARGET_TYPES_CSV` gains `promo_user_roles` so the audit-log
    `audit_user_id` filter surfaces promo-role rows alongside the
    user_permissions / damage_claim_user_roles ones.

2.5 Worker leading docblock: extend with the new endpoint description
(mirrors how Brief 61 added the dc-role line).

### Phase 3 — Apps/web — new "Set Promo Role" card

3.1 Create
`apps/web/app/admin/sysadmin/_components/SetPromoRoleCard.tsx`
(server component containing an `<ActionForm>` client wrapper per
Brief 19's pattern).

  - Fields:
    - User picker (existing `UserPicker` component — same one Set
      Role / Set DC Role use)
    - Promo Role select: `(none — clear access)` / `super_admin` /
      `it` / `marketing` / `ops`
  - No locations sub-picker — promo_role is scalar.
  - No conditional rendering — the field is always visible.
  - Inline hint copy below the select:
    - `(none)`: "This will revoke all /admin/promotions access."
    - `super_admin`: "Full read + write on every promotion."
    - `it`: "Full IT queue access + ticket edits + materials + announcements."
    - `marketing`: "Create + announce promotions; materials + PTP; read all."
    - `ops`: "Read-only access to all promotions."
    - Pull the copy from the role-by-role permission table in
      CLAUDE.md's "Promotions feature" glossary entry so the UI and
      the docs stay in sync.
  - Submit calls a server action that POSTs to
    `/sysadmin/api/users/{userId}/promo-role`.

3.2 No need for a `SetPromoRoleFields.tsx` wrapper — without a
conditional sub-picker, the role select can be a plain `<select>` in
the card itself. (Brief 61 needed the wrapper because the locations
picker visibility was driven by the chosen role; this brief doesn't.)

3.3 Server action: implement `setPromoRoleAction` in
`apps/web/app/admin/sysadmin/actions.ts` returning `ActionResult` per
Brief 19's contract. Mirror `setDcRoleAction` — build `{ role }` JSON
body and POST to `/sysadmin/api/users/{userId}/promo-role` via the
existing `sysadminPostJson` helper (the path takes the dynamic userId
as URL segment, encoded with `encodeURIComponent`). Result message
reflects the role.

3.4 Mount `<SetPromoRoleCard>` in
`apps/web/app/admin/sysadmin/_sections/UserOperations.tsx` immediately
after `<SetDcRoleCard>`. Update the section header comment from
"Six user-management cards" to "Seven".

3.5 `AuditLogPanel.tsx`: extend `ALLOWED_ACTIONS` with
`"set_promo_role"` and `ALLOWED_TARGET_TYPES` with `"promo_user_roles"`
in the same positions as the worker-side allow-lists.

### Phase 4 — Cookie refresh note

4.1 No code change here — the user must log out / log back in for
the new `promo_role` to surface on `Session.promoRole` (the session
is sourced from the access-token cookie set at login, which is
cached until next login). Same constraint as Set DC Role and Set
Role. Document the requirement:
  - In the card's success-message copy: "Role set. The user must
    sign out and back in to see the change take effect."
  - In CLAUDE.md's sysadmin glossary entry (Phase 5.2 below).

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass for all 14 packages (13 from
Brief 61 + the promo-worker added in Brief 153).
5.2 `pnpm --filter @splash/web build` — must succeed.
5.3 `pnpm --filter @splash/sysadmin-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up.
5.4 No schema changes (the `promo_user_roles` table already exists
    per Brief 153).
5.5 No new env vars or wrangler bindings.
5.6 Confirm the audit log surfaces the new `set_promo_role` action
    correctly in the panel.

### Phase 6 — Docs

6.1 BRIEFS/INDEX.md: Brief 159 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
  - Pre-Brief-159 gap: `promo_role` settable only via SQL INSERT
    into `promo_user_roles`; new tool closes that gap with a single
    atomic write path
  - New endpoint `POST /sysadmin/api/users/{userId}/promo-role`
  - New helper `setPromoRole` in `packages/db-supabase`
  - New apps/web component `SetPromoRoleCard`
  - 7th Manage Users card
  - Cookie refresh required for the new role to surface on
    `Session.promoRole`
  - Audit log filter allow-lists extended: `set_promo_role` action
    + `promo_user_roles` target_type

6.3 CLAUDE.md updates:
  - sysadmin glossary entry: add "**Set Promo Role**" tool
    description (7th Manage Users card)
  - Note that user_permissions.role, dc_role, and promo_role are
    three independent permission domains and must be set separately
  - Cross-reference the role-by-role permission table in the
    "Promotions feature" glossary entry
  - Brief 158a's tile-visibility note (`visibleTo: s?.promoRole != null`)
    already surfaces the Promotions tile automatically — no separate
    dashboard wiring needed

## Out of scope

- Bundling promo_role into the Create User card (defer per the same
  rationale Brief 61 deferred Create-User-plus-dc_role: distinct
  permission domains in one form conflates the mental model).
- Bundling promo_role into Set Role or Set DC Role cards. Three
  distinct domains; conflating breaks the model.
- Backfilling existing promo_role grants programmatically. Operator
  re-runs each grant via the new tool only if needed; existing rows
  in `promo_user_roles` are unaffected by this brief.
- A separate "search users by promo_role" filter. The audit-log
  panel's existing `audit_user_id` filter covers user-level lookup;
  the role-by-role distribution can be SQL'd if ever needed.
- Per-promotion role overrides (e.g., "user X is marketing for
  promo Y only"). The role is global; per-promo authorization is
  out of scope.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- New helper `setPromoRole(client, args)` exported from
  `packages/db-supabase`; writes `promo_user_roles`; returns
  before/after snapshots for audit
- New endpoint `POST /sysadmin/api/users/{userId}/promo-role` on
  sysadmin-worker; super_admin gate; validates role allow-list;
  audits via `set_promo_role` action
- New `<SetPromoRoleCard>` mounted on `/admin/sysadmin?mode=users`,
  positioned after Set DC Role (7th card)
- New `setPromoRoleAction` server action in
  `apps/web/app/admin/sysadmin/actions.ts`
- Audit-log panel allow-lists extended (`set_promo_role` action,
  `promo_user_roles` target_type)
- `USER_TARGET_TYPES_CSV` extended so the audit-log `audit_user_id`
  filter surfaces promo-role rows
- pnpm typecheck passes (all 14 packages)
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/sysadmin-worker exec wrangler deploy
  --dry-run bundle succeeds (clean up after)
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (expected 200-300 lines net: new helper + endpoint +
  card + server action + audit-log allow-list extensions; smaller
  than Brief 61 because no multi-picker)
- Confirmation that:
  - Setting role=null clears the row
  - Setting role=it upserts cleanly when no prior row exists
  - Setting role=marketing upserts cleanly when prior row was it
  - Audit log shows the before/after promo_role
- Validation results
- Any decisions made on the operator's behalf

## Outcome

### Files created

- `apps/web/app/admin/sysadmin/_components/SetPromoRoleCard.tsx` — 7th
  Manage Users card. Server component wrapping `<ActionForm>` +
  `<UserPicker>` + plain `<select>` (no client-component wrapper —
  Brief 61's `SetDcRoleFields.tsx` was needed for the conditional
  sub-picker, which this card doesn't have). Inline event-delegated
  script `PROMO_ROLE_HINT_SCRIPT` toggles `<p data-promo-role-hint="…">`
  blurbs to match the current select value — mirrors
  `PASSWORD_MATCH_SCRIPT` in `ResetPasswordCard`'s pattern so the
  listener survives `<ActionForm>`'s post-success remount per Brief 19.
  Per-role hint copy sourced from CLAUDE.md's "Promotions feature"
  role-by-role permission table.

### Files modified

- `packages/db-supabase/src/users.ts` — added `PromoRole` type
  re-export (alongside `DcRole`) + new `setPromoRole(client, {userId,
  role, createdBy?})` helper. Upserts on `(user_id)` when role is set
  (mirroring `setDcRole`'s post-Brief-64 schema — no `email` column on
  `promo_user_roles`; `auth_unified` joins from `auth.users` at read
  time), deletes the row when role=null. Stamps `created_by =
  actor.id` on upsert so a re-grant overwrites with the latest
  granter (matches the column's intent: "who created this grant").
  Returns `{before: {role}, after: {role}}` for the audit log.
- `apps/sysadmin-worker/src/index.ts` — new endpoint
  `POST /sysadmin/api/users/{userId}/promo-role` + new
  `handleSetPromoRole` handler. Reuses `UUID_RE` + `adminGetUser` from
  Brief 61's pattern. Second dynamic-path endpoint via new
  `PROMO_ROLE_PATH_RE` + `isOwnedPromoRolePost` short-circuit
  alongside the dc-role one. New `VALID_PROMO_ROLES` Set (parallel to
  `VALID_DC_ROLES`). `ALLOWED_AUDIT_ACTIONS` gains `set_promo_role`;
  `ALLOWED_AUDIT_TARGET_TYPES` gains `promo_user_roles`;
  `USER_TARGET_TYPES_CSV` extended with `promo_user_roles`. Leading
  docblock extended with the new endpoint description (mirrors
  Brief 61's dc-role line).
- `apps/web/app/admin/sysadmin/actions.ts` — new `setPromoRoleAction`
  + `PromoRoleValue` type + `SetPromoRoleBody` interface. Mirrors
  `setDcRoleAction`'s `{role}` JSON POST shape (no `location_codes`
  array — promo_role is scalar). Success copy explicitly notes the
  cookie-refresh constraint: "The user must sign out and back in to
  see the change take effect."
- `apps/web/app/admin/sysadmin/_sections/UserOperations.tsx` —
  mounted `<SetPromoRoleCard>` immediately after `<SetDcRoleCard>` in
  the card list. Section docblock comment updated from "Six
  user-management cards" → "Seven", with cards enumeration extended.
- `apps/web/app/admin/sysadmin/_sections/AuditLogPanel.tsx` —
  `ALLOWED_ACTIONS` gains `set_promo_role`; `ALLOWED_TARGET_TYPES`
  gains `promo_user_roles` (positioned to match the worker-side
  allow-list order).
- `BUILD_STATE.md` — "Last updated" bumped to 2026-06-06 with the
  Brief 159 summary; new prioritized work list row + new Findings &
  decisions log row.
- `BRIEFS/INDEX.md` — Brief 159 row appended at the top of the
  table (above Brief 158b).
- `CLAUDE.md` — sysadmin glossary entry extended with the **Set Promo
  Role** description (7th Manage Users card) including the
  three-independent-permission-domains note, schema note (no `email`
  column on `promo_user_roles`), audit-log allow-list extensions,
  cookie-refresh constraint, and cross-reference to the "Promotions
  feature" role-by-role permission table.

### Decisions made on the operator's behalf

1. **`promo_user_roles.created_by` stamped on every upsert** with the
   acting super_admin's `actor.id`. The brief sketch passed only
   `(user_id, promo_role)` in the upsert payload; the table schema
   carries a `created_by uuid` audit column with the comment "auth.users.id;
   NULL for self-grants / migration seeds" so populating it from the
   sysadmin handler matches the column's intent. A re-grant overwrites
   the prior `created_by` with the latest granter — also matches
   intent because re-granting is the operator path for "user moved
   from `ops` → `it`" and the latest super_admin is the meaningful
   actor for the new grant.
2. **Per-role hint copy uses an inline event-delegated script**
   (`PROMO_ROLE_HINT_SCRIPT`) rather than a client component wrapper.
   The brief explicitly said no `SetPromoRoleFields.tsx` wrapper is
   needed because there's no conditional sub-picker, but the hint
   copy IS conditional per-role. Mirrors the existing
   `PASSWORD_MATCH_SCRIPT` pattern in `ResetPasswordCard` — keeps the
   card a server component while still providing the right
   per-selection hint. Listener uses `document.addEventListener`
   delegation so it survives `<ActionForm>`'s post-success remount
   per the Brief 19 convention.
3. **`PromoRole` re-exported from `@splash/db-supabase`** alongside
   the existing `DcRole` re-export, for symmetry. The underlying
   type still lives in `@splash/types/promo` (Brief 153) — this is a
   convenience re-export for `@splash/db-supabase` consumers.
4. **`VALID_PROMO_ROLES` worker-side allow-list** added as a new
   `ReadonlySet<PromoRole>` parallel to `VALID_DC_ROLES`. Defense in
   depth on the worker side even though `@splash/types/promo` already
   constrains the union.
5. **`adminGetUser` user-exists pre-check** kept in the handler even
   though `promo_user_roles` doesn't carry an `email` column. The
   check serves as defense-in-depth against accidental promo grants
   to non-existent UUIDs and matches `handleSetDcRole`'s shape.
6. **Success message copy bakes in the cookie-refresh note** ("The
   user must sign out and back in to see the change take effect")
   for every successful set (clear or grant). The brief said to
   document the requirement in copy; placing it on the success banner
   means an operator sees it immediately after the write and doesn't
   have to remember it from the docs.

### Latent issues / forward flags

- **Inline hint script's initial pass** uses `DOMContentLoaded` (or
  fires immediately if document is already interactive). If the
  operator opens the `<details>`-collapsible Set Promo Role card
  AFTER the page hydrates, no `change` event fires on the select
  until they make a selection, so the displayed hint is the default
  "clear access" blurb. Acceptable v1 UX — the select's empty
  default-value IS the clear-access option, so the hint matches the
  default state. Future polish could fire `update()` from a `details`
  `toggle` event, but it's not load-bearing.
- **`PROMO_ROLE_HINT_SCRIPT`** is wired specifically by the
  `id="set-promo-role-role"` of the select. If another card ever
  reuses that ID the script would mis-target. Low risk because the
  Brief 30 cards conventionally use unique per-card ID prefixes.
- **Audit-log filter UI ordering**: the `ALLOWED_ACTIONS` /
  `ALLOWED_TARGET_TYPES` arrays drive dropdown render order in
  `AuditLogPanel`. Brief 159 inserts `set_promo_role` /
  `promo_user_roles` adjacent to the dc-role siblings to keep the
  grouping coherent. If a future brief adds more roles, consider
  alphabetizing.
- **Per-promo role overrides** explicitly remain out of scope per
  the brief. Today's promo_role is global; per-promo authorization
  ("user X is marketing for promo Y only") would need a separate
  table.
- **No "search users by promo_role" filter** added — the existing
  `audit_user_id` filter on `/admin/sysadmin?mode=users#audit-log`
  covers user-level lookup, and a future filter can be added
  additively if the operator needs role-distribution searches.

### Validation results

- `pnpm typecheck` → 19/19 packages green (caught one transient
  turbo-graph false-positive on `signup-worker` for missing
  `@splash/storage-r2/assets`; resolved on rerun — unrelated to
  Brief 159 changes).
- `pnpm --filter @splash/web build` → succeeded. `/admin/sysadmin`
  route bundle 9.66 kB / 117 kB First-Load (vs ~9.1 kB pre-brief —
  the new card + inline script add ~0.6 kB).
- `pnpm --filter @splash/sysadmin-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build` → bundled at 763.39 KiB raw /
  143.66 KiB gzip. `.tmp-build` cleaned up after.

### Operator action items

- Run the new tool to grant promo_role to any operator who currently
  has a SQL-INSERT'd grant (the existing rows are unaffected, so
  this is optional — only needed if you want the audit log to
  capture the historical grants).
- After deploying `splash-sysadmin` + `splash-web` via the normal CF
  Builds push flow, smoke-test the card on staging by setting a
  promo_role on a non-promo user and verifying (a) the
  `promo_user_roles` row materializes correctly, (b) the audit log
  surfaces the new entry, and (c) the affected user sees the
  Promotions dashboard tile after signing out and back in.
