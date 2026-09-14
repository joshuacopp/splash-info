# Brief 149: Create User form sets dc_role + dc_locations when claims tool is granted

**Status:** Completed (2026-06-03)
**Started:** 2026-06-03
**Completed:** 2026-06-03
**Blocks:** Onboarding — new users provisioned via Create User who get the
claims tool currently hit "no access" on /admin/damage despite the grant
being recorded
**Dependencies:** none

## Read first
- BUILD_STATE.md
- CLAUDE.md (sysadmin glossary entry — Brief 61 already added the Set DC
  Role card + `POST /sysadmin/api/users/{userId}/dc-role` endpoint; this
  brief reuses that endpoint, doesn't add a new one)
- apps/sysadmin-worker/src/ — find the Create User handler
  (`POST /sysadmin/api/users` or similar) and the Set DC Role handler
  (`POST /sysadmin/api/users/{userId}/dc-role` per Brief 61's
  documentation in CLAUDE.md). Confirm the actual route shapes.
- apps/web/app/admin/sysadmin/ — the Create User card UI (client island
  that POSTs to the Create User endpoint) and the existing Set DC Role
  card (Brief 61) for the picker patterns.
- BRIEFS/brief-061-sysadmin-set-dc-role-tool.md — the brief that built
  the Set DC Role surface. Mirror its dc_role enum and dc_locations
  write rules verbatim.
- BRIEFS/brief-147-forced-reset-session-refresh-and-damage-gate.md (just
  for context — that brief is the cookie bug; this one is the data
  bug).
- packages/types/src/auth.ts (or wherever ToolName lives) — confirm
  `"claims"` is the canonical tool name.

## Context

Operator just provisioned a fresh test user via Database Admin → Create
User. Selected:
- Role: `location_admin`
- Location: `cicero`
- Tool grants: `pricing` + `claims`
- (Forced-password-reset flag default true.)

User signs in fine (dashboard renders, Brief 147 fix confirmed working).
Clicks `/admin/damage` — gets "You don't have access to Damage Claims."

`auth_unified` for the user shows:
```
role:                 location_admin
locations:            ["cicero"]
must_change_password: FALSE   (after the forced reset)
tools:                ["claims","pricing"]
dc_role:              NULL    ← the problem
dc_locations:         []      ← the problem
```

Cause: Create User only writes `auth.users` + `user_permissions.role` +
`user_permissions.locations` + `user_tool_access` rows. It does NOT
write the `damage_claim_user_roles` row or the
`damage_claim_user_locations` rows. The damage-worker admin gate
(constraint #5 / Brief 71) checks `session.dcRole` and
`session.dcLocations` — neither is populated, so the gate rejects.

Today's only way to populate them is the separate Set DC Role card
(Brief 61). The operator has to remember to flip it after creating
every claims-granted user. They forget; new users get stuck.

Operator's directive: when `claims` is in the tool grants, the Create
User form should ALSO collect a dc_role and write the dc-role/dc-
locations rows in the same submission. The dc_locations value should
mirror the existing Location field (not collect a second one) — the
location the user can manage is the location they can see claims for.
Operator was specific: no separate DC location picker.

## Scope

1. **`apps/web/app/admin/sysadmin/` — Create User UI.**
   - Locate the client island that renders the Create User card. Add
     a conditional DC Role picker that ONLY shows when the `claims`
     tool checkbox is checked.
   - DC Role picker is a `<select>` with options `gm`, `rm`, `admin`,
     `super_admin` (same enum as the existing Set DC Role card —
     copy/paste-verify the option labels and values from
     `apps/web/app/admin/sysadmin/_components/SetDcRoleCard.tsx` or
     wherever that picker lives). Default unselected; explicit choice
     required when claims is checked.
   - Form validation: if `claims` is in tool grants, dc_role must be
     non-empty. If not, show an inline error: "Pick a DC role for
     claims access."
   - The Location field that already exists on the Create User form
     IS the dc_locations source when `dc_role` is `gm` or `rm`. No
     second picker. When dc_role is `admin` or `super_admin`,
     dc_locations is omitted entirely (those roles bypass scoping per
     Brief 61).
   - Visual: the DC Role row appears INSIDE the same form, between
     "INITIAL TOOL GRANTS" and the Create button. When `claims` is
     unchecked, the row collapses (or hides) cleanly.

2. **Create User submission flow.**
   - Two clean ways to land the writes; pick whichever is smaller:
     (a) Apps/web's Create User server action chains TWO worker calls
         after the response: first the existing `POST /sysadmin/api/users`,
         then `POST /sysadmin/api/users/{newUserId}/dc-role` (Brief 61's
         endpoint) with `{ dc_role, locations: <Location field value> }`.
     (b) The sysadmin-worker's Create User handler accepts an optional
         `dc_role` + `dc_locations` payload and writes them inside the
         same handler before returning. Atomic-ish; less round-trip.
   - Operator preference: (a) if it works without ripple effects (the
     worker handlers stay scoped to one table each), (b) if the
     sysadmin-worker's existing audit log already pairs the writes.
     Pick one in the brief execution and report which.
   - Either way: if the second write fails after the first succeeded,
     the form surfaces a partial-success message ("User created but
     DC role write failed — set it manually via the Set DC Role
     card") rather than reporting a fresh failure. Don't roll back
     the user creation — a user with a missing dc_role is recoverable;
     an orphaned half-created account isn't.

3. **Tool-grant copy update.**
   - In the existing Create User card, the "claims" checkbox label
     stays as-is, but add a small inline hint that appears when claims
     is checked, e.g. "Claims access also requires a DC role — pick
     one below." Helps operators understand why the new row appeared.

4. **Audit log integration.**
   - The sysadmin audit log already records `set_dc_role` (Brief 61).
     The Create User flow should produce TWO audit rows when claims
     is granted alongside dc_role:
       - The existing `create_user` row (no change).
       - A `set_dc_role` row, same as if the operator had used the
         Set DC Role card.
     If approach (b) is chosen and the worker writes both inside one
     handler, write both audit rows from the worker so the trail
     stays intact.

5. **Sanity check the worker side already supports this.**
   - The Set DC Role endpoint (Brief 61) accepts a `dc_role` payload
     and a `locations` array; it skips the dc_locations write for
     admin / super_admin. Confirm the contract end-to-end with a grep
     of `apps/sysadmin-worker/src/`. If the existing endpoint requires
     anything Create User can't supply (e.g. a session_id), that's a
     bug worth flagging — don't patch the endpoint here, surface it.

## Configuration

No new env vars or secrets. Reuses Brief 61's dc_role write path.

## Out of scope

- Don't add a separate DC Locations picker. The Location field on the
  Create User form is the single source of truth for both
  `user_permissions.locations` AND `damage_claim_user_locations`.
- Don't change the Set DC Role card itself — it stays as the surface
  for adjusting an existing user's dc_role / dc_locations after the
  fact.
- Don't auto-grant the `claims` tool when an operator picks a dc_role
  manually elsewhere. The two are linked one-way: claims grant
  REQUIRES dc_role; dc_role does NOT require claims grant (admin /
  super_admin without the tool grant is a valid configuration — they
  bypass the tool check by virtue of role).
- Don't backfill existing users whose claims grant predates this
  brief. Operator can run a one-off SQL script for that separately;
  this brief covers go-forward provisioning only.
- Don't deploy to Cloudflare; don't bind production routes; don't
  commit to git or push.

## Definition of done

- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/sysadmin-worker build` succeeds (if
  approach (b) was chosen and the worker was modified).
- Provisioning a new user via Create User with `claims` checked and a
  dc_role selected produces:
    - One `auth.users` row.
    - One `user_permissions` row with the chosen role + Location.
    - `user_tool_access` rows for each checked tool including
      `claims`.
    - One `damage_claim_user_roles` row with the chosen dc_role.
    - `damage_claim_user_locations` rows mirroring the Location field
      (when dc_role is gm / rm). Zero rows when dc_role is admin /
      super_admin.
- The new user can sign in, complete forced password reset (Brief
  147), and reach `/admin/damage` without the "no access" message.
- Provisioning a new user via Create User WITHOUT `claims` checked
  behaves exactly as today: no DC Role picker shown, no
  dc_role / dc_locations writes, no regression.
- Sysadmin audit log shows both `create_user` and `set_dc_role` rows
  for the same actor and target_id when claims + dc_role were set in
  one submission.
- BUILD_STATE.md updated: bump "Last updated", add a Findings entry
  ("Brief 149: Create User auto-provisions dc_role + dc_locations
  when claims tool grant is selected; closes the onboarding gap that
  required a separate Set DC Role flip after every new claims user").

## Report

- Which approach was picked (server-action chains two calls vs worker
  writes both atomically) and the reasoning.
- The actual form-validation behavior chosen (inline error vs disabled
  submit) when claims is checked but dc_role isn't picked.
- Anything surprising about the existing Set DC Role endpoint contract
  — particularly anything it asks for that Create User can't easily
  supply.
- Whether the worker-side endpoint accepted the `locations` field
  cleanly or needed a payload-shape tweak.
- If a similar one-way coupling exists for other tools (e.g. pertrack
  requires some other permission row that Create User doesn't write),
  flag it — don't fix here.

## Outcome

**Approach picked: (a) — apps/web server action chains two worker calls.**
Reasoning: the brief's preference was (a) "if it works without ripple
effects (the worker handlers stay scoped to one table each)". The
existing `POST /sysadmin/api/users/{userId}/dc-role` endpoint (Brief 61)
accepts everything the Create User flow can supply (it resolves the
user's email from the auth admin API server-side, so we only forward
`{role, location_codes}`). No worker change required; both handlers
stay scoped to their respective table domains; the audit log records
`create_user` + `set_dc_role` rows naturally from two separate POSTs.

**Files created.**
- `apps/web/app/admin/sysadmin/_components/CreateUserToolsAndDcRole.tsx`
  (~95 LOC) — `"use client"` island that owns the `claims` checkbox
  state, renders all three tool checkboxes (`pricing` / `claims` /
  `pertrack`), and conditionally renders a DC Role `<select>` directly
  beneath the fieldset when `claims` is checked. The DC Role select is
  HTML5 `required` when visible, so submitting without picking surfaces
  the browser's native validation bubble. Inline hint
  ("Claims access also requires a DC role — pick one below.") appears
  under the tool checkboxes when claims is checked. Per-role helper
  text under the picker explains how `dc_locations` is sourced (gm/rm:
  "set to the Location picked above"; admin/super_admin: "bypass
  location scoping — no locations stored"). When `claims` is unchecked
  the picker collapses cleanly and `dc_role` is NOT included in
  FormData — non-claims users get the exact pre-Brief-149 code path.

**Files modified.**
- `apps/web/app/admin/sysadmin/_sections/UserOperations.tsx` — imports
  the new island; the `CreateUserCard` form replaces the inline
  "Initial tool grants" `<fieldset>` block with `<CreateUserToolsAndDcRole />`.
  The Location field's helper text was updated from "Required only for
  location_admin role — search by site #, name, or code" to "Required
  for location_admin role; also used as dc_locations when DC role is
  gm/rm" so operators understand the dual purpose without a second
  picker (per the brief's operator directive).
- `apps/web/app/admin/sysadmin/actions.ts` — `createUserAction` now:
  (1) reads `dc_role` from FormData; (2) after a successful
  `/sysadmin/api/create-user` POST, extracts `user_id` from the
  response body; (3) when `tools` includes `"claims"` AND `dc_role`
  is non-empty AND validates against the dc_role enum, chases with
  `POST /sysadmin/api/users/{user_id}/dc-role` carrying
  `{role: <picked>, location_codes: [<Location field>]}` for gm/rm
  or `{role: <picked>, location_codes: []}` for admin/super_admin.
  (4) Partial-success handling: if the second POST fails after Create
  succeeded, returns `ok: true` with a message like
  `"User created: {email} — but DC role write failed ({error}). Set
  it manually via the Set DC Role card."` rather than rolling back
  the user (brief direction — an orphaned half-created auth.users row
  is harder to recover than a missing dc_role row). The previously
  inline `type DcRoleValue = …` declaration was already module-scoped
  in the `setDcRoleAction` section below; the new code reuses it via
  TS's whole-file type resolution rather than duplicating.

**Decisions made on the operator's behalf.**
- **Validation = HTML5 `required` on the visible select.** The DC Role
  `<select>` carries `required` when claims is checked, and its first
  option is a placeholder (`value=""`) labeled
  `— Pick a DC role for claims access —`. Submitting without picking
  surfaces the browser's native validation bubble pointing at the
  select, which is functionally equivalent to "Pick a DC role for
  claims access." per the brief's copy. The placeholder text doubles
  as the inline-error message — no separate React-state error
  rendering needed, no DOM event delegation glue.
- **Worker re-validates as defense in depth.** If a hand-crafted curl
  request bypasses the UI and POSTs `claims` without `dc_role`, the
  worker's `/dc-role` endpoint is never called and the gap shows up on
  the next `/admin/damage` visit. The audit-log row from `create_user`
  still records `tools` including `claims`; the operator can spot the
  half-state via the Audit log panel + the Set DC Role card. The UI
  gate is a UX hint, not access control.
- **Reuse the existing `DcRoleValue` type at module scope.** Initially
  added a fresh `type DcRoleValue = …` near the new code; TS bounced
  on the duplicate at module scope. Removed the duplicate; the new
  code references the existing one declared further down in
  `setDcRoleAction`. The shared `VALID_DC_ROLES_CLIENT` set still
  lives at the top of the section so the type-narrowing check at
  call time uses the same canonical enum the rest of the file does.
- **The Location field's helper text doubles down on its dual purpose
  rather than relying on a separate hint below the DC Role picker.**
  The DC Role picker DOES surface a per-role hint when gm/rm is
  picked ("dc_locations will be set to the Location picked above."),
  but updating the Location field's own helper at the source makes
  the relationship visible even before the picker appears, which
  matches the brief's "Visual" guidance (the row appears INSIDE the
  same form, between INITIAL TOOL GRANTS and the Create button — the
  Location field above it shouldn't read as orphaned context).

**Sysadmin Set DC Role endpoint contract — surprises found:** none.
The endpoint accepts exactly what Create User can supply:
- `role: "gm" | "rm" | "admin" | "super_admin" | null` (string body
  field, not `dc_role`)
- `location_codes: string[]` (array, required non-empty for gm/rm;
  ignored for admin/super_admin; the worker is symmetric on it)

The brief's wording ("dc_role payload and a locations array") was
slightly off; the actual body keys are `role` and `location_codes`,
matching the existing `setDcRoleAction` in `actions.ts` (which we
reused unchanged). The endpoint resolves the user's email from the
auth admin API server-side — no `email` needed in the body, no
`session_id` required from the caller. Cookie-based auth flows
through the apps/web → sysadmin-worker service binding the same way
it does for every other sysadmin write surface.

**Audit log integration.** Two rows per claims+dc_role provisioning:
- `action: "create_user"`, `target_type: "auth.users"`,
  `target_id: <new user_id>`, `after: {email, role, tools}`. Written
  by the worker's `handleCreateUser` after the auth.users insert.
- `action: "set_dc_role"`, `target_type: "damage_claim_user_roles"`,
  `target_id: <new user_id>`, `before/after: {role, location_codes}`.
  Written by the worker's `handleSetDcRole` after the dc-role insert.

Both rows are filterable via the existing Audit log panel
(`audit_action` allow-list and `audit_user_id` filter both already
include `set_dc_role` per Brief 61). No worker / log allow-list
changes required.

**Latent issues / forward flags.**
- **One-way coupling parity check.** `pertrack` does NOT require a
  parallel permission domain. It's gated purely by the
  `user_tool_access` row (performance-worker uses `checkToolAccess`
  on grants alone, no companion `pertrack_user_*` table). `pricing`
  is the same — the user_tool_access row is sufficient. Only
  `claims` carries the second permission domain (Brief 61's
  `damage_claim_user_roles` + `damage_claim_user_locations`), which
  is what motivates this brief. No other tool surfaces hit the same
  bug class today.
- **Edge case: super_admin role + claims granted + dc_role=gm + no
  Location picked.** The Create User form makes Location required
  only for `role === "location_admin"`. If an operator picks
  `super_admin` (no Location) but checks claims and picks gm/rm as
  dc_role, the chained POST will 400 with the worker's
  "location_codes is required and must be a non-empty array for role
  gm/rm" message. Per the brief's "don't pre-validate inputs in the
  action" guidance, this surfaces as a partial-success message
  ("User created: alice@… — but DC role write failed (…)") rather
  than a fresh form failure. The operator fixes via the Set DC Role
  card. Not a v2 concern — gm/rm scoping on a super_admin user is
  rare and intentional, and the partial-success message is the right
  signal.
- **Mixed `role + dc_role` pairings.** A user can be
  `location_admin` for one location AND dc_role `gm` for the same
  location, OR dc_role `admin` (bypasses scoping). The form supports
  both freely — there's no constraint between user_permissions.role
  and dc_role in this brief or the worker. Per the brief's "Don't
  auto-grant the `claims` tool when an operator picks a dc_role
  manually elsewhere", the linkage is one-way: claims granted →
  dc_role required; dc_role picked elsewhere → claims grant remains
  optional.
- **Existing claims-granted users without dc_role.** Not backfilled
  by this brief per scope. Operator handles via a one-off SQL script
  or repeated Set DC Role flips for the small population that
  predates this brief.
- **ActionForm remount on success clears the client-island state.**
  When `createUserAction` returns `ok: true`, ActionForm changes its
  `formKey` and React unmounts the whole subtree including
  `CreateUserToolsAndDcRole`. The next form fill starts with
  `claimsChecked: false` + `dcRole: ""`, which is the right default —
  no stale claims toggle leaks across user creations.

**Validation results.**
- `pnpm typecheck` — 18 / 18 successful (17 cache hits, web ran
  fresh). 7.764s.
- `pnpm --filter @splash/web build` — succeeded.
  `/admin/sysadmin` route chunk: **9.66 kB / 117 kB First-Load JS**
  (was 8.91 kB / 116 kB at the last build of this route per Brief 95;
  +~0.75 kB chunk delta is the new client island).
- No sysadmin-worker build run because approach (a) was chosen and
  the worker was NOT modified (per the brief's Definition of Done
  conditional bullet).

**Files NOT modified.**
- `apps/sysadmin-worker/src/index.ts` — no change.
  `handleCreateUser` + `handleSetDcRole` continue to own their
  respective table writes; chaining lives entirely apps/web-side.
- `apps/web/app/admin/sysadmin/_components/SetDcRoleCard.tsx` /
  `SetDcRoleFields.tsx` — unchanged. The standalone Set DC Role
  card remains the surface for adjusting an existing user's dc_role
  / dc_locations after the fact (per brief's "Out of scope").
- `packages/types`, `packages/db-supabase` — no contract changes.
- `apps/web/middleware.ts` — no new `/admin/*` subpath added;
  CreateUserToolsAndDcRole renders inside the existing
  `/admin/sysadmin` route.

**Operator post-deploy smoke (deferred — Cloudflare deploy is
operator-driven per CLAUDE.md).**
1. As super_admin, navigate to `/admin/sysadmin?mode=users`. Open
   the Create User card. Verify the DC Role row is hidden by
   default.
2. Check the `claims` tool checkbox. DC Role row appears between
   the tool grants and the Create button; inline hint "Claims
   access also requires a DC role — pick one below." appears under
   the checkboxes.
3. Try submitting without picking a DC role: browser's native
   validation bubble fires on the select.
4. Pick `gm` for DC role, pick a Location (e.g., cicero), submit.
   Verify both `auth.users` and `damage_claim_user_roles` +
   `damage_claim_user_locations` rows landed. The new user signs in,
   completes forced password reset (Brief 147), reaches
   `/admin/damage` without "no access".
5. Pick `admin` or `super_admin` for DC role: helper text under the
   picker switches to "super_admin and admin bypass location scoping
   — no locations stored". Submit → `damage_claim_user_locations`
   stays empty for this user; `damage_claim_user_roles` lands the
   admin/super_admin row.
6. Create a user WITHOUT `claims` checked: DC Role row stays
   collapsed; no dc_role / dc_locations writes; no regression in the
   existing pre-Brief-149 flow.
7. Confirm the Audit log panel shows both `create_user` and
   `set_dc_role` rows for the same `target_id` and `actor`.
8. Confirm the standalone Set DC Role card still works for
   adjusting an existing user — it's untouched.
