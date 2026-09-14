# Brief 21: Re-enable dcRole gating (show-disabled) + cleanup + hide contact_status

**Status:** Completed (2026-05-05)
**Started:** 2026-05-05
**Completed:** 2026-05-05
**Blocks:** Damage detail UX correctness + production-ready polish.
**Dependencies:** Brief 18 (debug line + dropped filter), Brief 19
(server-action result pattern — operator confirmed dcRole is working
on staging).

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-018-damage-and-sysadmin-fixes.md (Outcome — debug line
  + filter drop + diagnostic logs are slated for removal once dcRole
  confirmed working)
- apps/web/app/admin/damage/[id]/page.tsx
- apps/web/app/admin/damage/[id]/actions.ts
- apps/web/app/admin/damage/_lib/transitions.ts
- packages/types/src/claims.ts (contact_status)

## Context

Operator confirmed via Brief 18's `DcRoleDebugLine` that
`session.dcRole` IS populating correctly on staging
(super_admin in the test). Brief 18's workaround (drop the dcRole
filter) was always meant as a temporary "show all transitions while
we investigate." Time to restore proper gating with a better UX:

  - **Show-disabled instead of hide.** Lower-role users see every
    transition that's valid from the current claim status, but actions
    outside their dc_role render as disabled buttons with an inline
    hint about what role is required. Better than hiding because
    users learn what's possible at this status, even if they
    personally can't act on it.
  - "Submit for Payment" specifically (per operator request): visible
    to all viewers, disabled for non-admin with hint text "Pending
    final approval" per operator wording.

Plus two cleanup items:
  - Remove the diagnostic noise added in Brief 18 now that dcRole is
    confirmed working.
  - Hide the `contact_status` "Not Started" pill that always renders
    "Not Started" and adds visual noise without information.

## Scope

### Part A — Re-enable dcRole gating with show-disabled pattern

A.1 `apps/web/app/admin/damage/[id]/page.tsx`:
  - Remove the Brief 18 workaround that produced
    `validTransitions = transitionsFrom(claim.claim_status)` (every
    valid-from-status transition shown).
  - Replace with a richer compute step:
    ```ts
    const allValid = transitionsFrom(claim.claim_status);
    const roleAllowed = (t: UITransition) =>
      session?.dcRole != null && t.allowedRoles.includes(session.dcRole);
    const transitions = allValid.map(t => ({
      transition: t,
      enabled: roleAllowed(t)
    }));
    ```
  - Render each row with the existing form/markup, but when
    `enabled === false`:
    - Submit button: `disabled={true}` + grey/muted styling.
    - Below the action label, render a small hint text in
      `text-splash-navy/60`:
      - For "Submit for Payment" specifically: "Pending final approval"
        (per operator wording).
      - For all other gated transitions: "Requires <highest role from
        t.allowedRoles>". Pick the LOWEST role from the union as the
        "minimum required" — e.g., if allowedRoles = ["admin",
        "super_admin"], hint reads "Requires admin or higher".
    - The form's submit handler doesn't need to change; the worker
      still re-validates and rejects on POST as defense-in-depth.

  - When `session.dcRole === null` (defensive — middleware should
    redirect unauth before reaching here, but cover it): every
    transition disabled with hint "Requires a damage role assignment".

  - For super_admin, every valid transition is enabled (no hint).

A.2 Update the Hint copy mapping. New helper function alongside the
   transitions:
   ```ts
   function transitionDisabledHint(
     t: UITransition,
     dcRole: DamageRole | null
   ): string {
     if (!dcRole) return "Requires a damage role assignment";
     if (t.label === "Submit for Payment") return "Pending final approval";
     // Generic fallback — name the lowest-required role.
     const roleHierarchy: DamageRole[] = ["gm", "rm", "admin", "super_admin"];
     const minRole = roleHierarchy.find(r => t.allowedRoles.includes(r));
     if (!minRole) return "Not available";
     return `Requires ${minRole} or higher`;
   }
   ```
   The "Submit for Payment" check is name-based; if the label changes
   in transitions.ts, this hint won't fire. Acceptable v1; flag in a
   comment so future maintainers know to update.

### Part B — Cleanup of Brief 18 diagnostics

B.1 `apps/web/app/admin/damage/[id]/page.tsx`:
  - Remove the `DcRoleDebugLine` component definition and its render
    site below the page banner.
  - Update the leading comment block to remove the Brief 18
    diagnostic mention; replace with a Brief 21 note about gating
    being in place.

B.2 `apps/web/app/admin/damage/[id]/actions.ts`:
  - Remove the `logActionEntry` and `logActionResult` helper functions.
  - Remove the calls to them inside each action (transitionAction,
    addNoteAction, uploadDocumentAction, editDocumentAction,
    deleteDocumentAction).
  - Update the leading comment block to drop the Brief 18 logging
    note.

### Part C — Hide "Not Started" contact_status pill

C.1 `apps/web/app/admin/damage/[id]/page.tsx`:
  - Locate the status row where `claim.contact_status` is rendered
    (small text next to the status pill — currently shows "Not
    Started" persistently).
  - Hide the rendering when `contact_status` is null, empty string,
    or `"Not Started"`. Effectively: only render when it has a
    meaningful value.
  - Add a code comment pointing at the legacy intent: contact_status
    was originally meant to track customer-contact lifecycle (call
    left voicemail, scheduled appointment, etc.) but the new worker
    never writes it. A future brief can build out a proper
    contact-tracking feature; for now, suppress the pill.

### Part D — Updates

D.1 BRIEFS/INDEX.md — add Brief 21 row marked Completed.

D.2 BUILD_STATE.md — bump Last updated, add Findings entry
   describing the gating restoration + cleanup + contact_status
   hiding. Note that the dcRole-null mystery from Brief 11b was
   resolved by operator-side data (the row in
   damage_claim_user_roles populated the view as expected once the
   `/api/me` 'bad origin' gate was removed in Brief 11b — no
   worker-side bug existed).

D.3 CLAUDE.md — extend the damage manager subsection in "Working
   with apps/web" with a one-line note that transitions are
   show-disabled when the user's dc_role doesn't match.

## Out of scope

- Building out a real contact-status tracking feature (separate brief
  if/when operator wants it).
- Fully refactoring transitions.ts to a shared package — keep the
  dual-source mirror with sync comments.
- Adding tests for the gating logic.
- Performance tracker / sysadmin gating changes.
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- Damage detail transitions show all valid-from-status transitions
- Disabled transitions render with greyed button + inline hint text
- "Submit for Payment" specifically renders "Pending final approval"
  hint when user is not admin/super_admin
- DcRoleDebugLine + diagnostic console.log calls are removed
- contact_status pill hidden when null/empty/"Not Started"
- BUILD_STATE.md and BRIEFS/INDEX.md updated; CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Whether the show-disabled pattern feels right or if any transitions
  should be hidden entirely instead (e.g., destructive operations)
- Bundle-size delta on /admin/damage/[id] (should shrink slightly
  from removing the debug line + diagnostic helpers)
- Latent issues in the transitions table — any rows with empty
  allowedRoles or missing labels
- Validation results

## Outcome

### Files modified

- `apps/web/app/admin/damage/[id]/page.tsx`
  - Header comment block: dropped the Brief 18 "REVERTED" subsection;
    added a Brief 21 dc_role gating subsection describing show-disabled.
  - `DamageRole` added to the `@splash/types/claims` import group.
  - Replaced `validTransitions = transitionsFrom(claim.claim_status)` with
    a richer compute step producing
    `{ transition, enabled, disabledHint }[]`. `enabled` is
    `dcRole !== null && t.allowedRoles.includes(dcRole)`. `disabledHint`
    is computed eagerly via the new `transitionDisabledHint(t, dcRole)`
    helper.
  - New helper `transitionDisabledHint(t, dcRole)` lives alongside the
    transition section. Returns `"Requires a damage role assignment"`
    when dcRole is null, `"Pending final approval"` when label is
    `"Submit for Payment"` (operator wording), else
    `"Requires <minRole> or higher"` where minRole is the lowest member
    of `["gm", "rm", "admin", "super_admin"]` that's present in
    `allowedRoles`.
  - `TransitionSection` props changed: `transitions: UITransition[]` →
    `transitions: TransitionRow[]`. New `TransitionRow` interface
    `{ transition: UITransition; enabled: boolean; disabledHint: string }`.
  - `TransitionForm` props gained `enabled: boolean` and
    `disabledHint: string`. Action header now renders the hint as
    `text-xs italic text-splash-navy/60` immediately under the to-status
    mono line when `!enabled`. Submit button toggles between the active
    splash-blue class and a muted
    `bg-splash-navy/20 text-splash-navy/50 cursor-not-allowed` class via
    the `disabled` attribute. Required input fields and markup
    otherwise unchanged (per brief — "render each row with the existing
    form/markup, but when enabled === false: submit disabled + hint").
  - `DcRoleDebugLine` component definition + render site removed. The
    `dcRole` variable is still computed for the gating math.
  - `claim.contact_status` render gate now also rejects the literal
    `"Not Started"`. Multi-line comment added describing the legacy
    customer-contact-lifecycle intent and flagging it as a future
    feature candidate.

- `apps/web/app/admin/damage/[id]/actions.ts`
  - Header comment: brief list updated to "5c + 5d + 19 + 20 + 21";
    Brief 18 diagnostic logging paragraph removed.
  - Removed `logActionEntry` and `logActionResult` helper functions.
  - Removed every call to those helpers across `transitionAction`,
    `addNoteAction`, `uploadDocumentAction`, `editDocumentAction`,
    `deleteDocumentAction` (10 call sites).
  - Removed unused `DamagePostResult` type import (only consumed by
    `logActionResult`).
  - Brief 20's defensive try/catch on `editDocumentAction` retained
    (separate concern — E394 cover, not Brief 18 diagnostic).

- `BRIEFS/INDEX.md` — Brief 21 row added.
- `BUILD_STATE.md` — Last updated bumped; prioritized work list row
  added; Findings entry appended.
- `CLAUDE.md` — apps/web subsection extended with a one-line note that
  damage detail transitions are show-disabled when caller's `dc_role`
  doesn't match.

### Files created

None.

### Decisions made on operator's behalf

1. **Hint copy**: `text-xs italic text-splash-navy/60` — italic
   distinguishes it from the to-status mono line above without
   competing with the action label, and `splash-navy/60` matches the
   secondary-text opacity used elsewhere in the page (audit stamps,
   empty-transitions message).
2. **Disabled-button styling**: same shape/padding/typography as the
   active button; only color and cursor change
   (`bg-splash-navy/20 text-splash-navy/50 cursor-not-allowed`). Keeps
   row layout stable across enable/disable.
3. **Required input fields stay rendered + `required` on disabled rows.**
   The brief said "existing form/markup, but when enabled === false:
   submit disabled + hint." HTML5 validation only fires on submit
   attempt and the disabled button can't submit, so the `required`
   attribute is harmless. Considered `<fieldset disabled>` for full
   input disable but that would have changed the inputs' visual
   styling unnecessarily.
4. **Name-based "Submit for Payment" branch in
   `transitionDisabledHint`** — explicitly noted in the helper's
   comment and in the brief itself. If the label changes in
   `_lib/transitions.ts` the hint silently won't fire and the row
   falls back to "Requires admin or higher" (which is correct for that
   transition's `allowedRoles = ["admin", "super_admin"]` anyway).
5. **`contact_status` legacy comment** — chose a multi-line block
   explaining the legacy intent + flagging future tracking-feature
   candidacy, rather than a one-line "// hidden until used". Brief
   explicitly asked the comment to point at the legacy intent.
6. **Diagnostic helper removal includes `DamagePostResult` import** —
   was only consumed by `logActionResult`; dead after removal. Kept
   the per-action `result.ok` checks themselves (they predate Brief
   18 and gate the action's return value).
7. **No section-level "transitions are gated" hint added** — every
   disabled row carries its own hint, which is more discoverable and
   row-specific.

### Latent issues / forward flags

- **Transition table integrity:** scanned all 33 entries in
  `_lib/transitions.ts` — every row has a non-empty `allowedRoles`
  (constructed via `rolesAtLeast(role)`) and a non-empty `label`. No
  empties to flag.
- **Show-disabled vs. hide for destructive operations:** every reopen /
  revert renders show-disabled. The brief explicitly chose this over
  hiding so users learn what's possible at this status. If an operator
  later decides certain destructive transitions should be hidden
  entirely (e.g., the "Reopen to GM Review (admin)" row when the user
  is a GM), that's a separate brief — the table already carries the
  data needed to switch the gating mode per row.
- **Role hierarchy duplication:** `transitionDisabledHint` reproduces
  the `["gm", "rm", "admin", "super_admin"]` hierarchy that
  `_lib/transitions.ts` already encodes via `DAMAGE_ROLE_HIERARCHY`.
  Tiny duplication; if a new role tier is ever added, both files need
  updating. Not worth a shared export today.
- **Bundle size for `/admin/damage/[id]` unchanged at 3.08 kB / 108 kB
  First Load JS.** The brief expected a slight shrink from removing the
  diagnostic helpers + DcRoleDebugLine, but those were server-only and
  never shipped to the client bundle. The shrink is in the server-side
  bundle, not the route's client First Load JS.
- **Brief 11b dcRole-null mystery resolution:** per brief D.2 — the row
  in `damage_claim_user_roles` populated `auth_unified` as expected
  once the `/api/me` 'bad origin' gate was removed in Brief 11b. No
  worker-side bug existed. The Brief 18 workaround + DcRoleDebugLine
  were always meant as temporary; restoring proper gating in Brief 21
  is the resolution.
- **Required attrs on disabled-row inputs:** noted under decision (3) —
  HTML5 won't validate on a disabled-button form, but if a future
  change ever re-enables the form via JS or alternate submit path the
  required validation will fire on placeholder text. Acceptable
  trade-off for staying inside the brief's "existing markup" guidance.

### Validation

- `pnpm typecheck`: **13/13 successful**, 3.931s (12 cached + 1 ran
  fresh — `@splash/web` source changes invalidated turbo cache).
- `pnpm --filter @splash/web build`: **succeeded** — Next 15.5.15
  compiled in 5.0s, 12/12 static pages generated, all type checks
  green.
- **Bundle deltas:** `/admin/damage/[id]` 3.08 kB / 108 kB (unchanged
  from Brief 20). All other route bundles unchanged.

### Report

- **Show-disabled feels right.** Every transition that's structurally
  valid for the claim's current status is visible; users learn the
  workflow shape even when they can't act. Worker re-validates on POST
  as defense in depth, so misclicks (browser DevTools removing the
  `disabled`, network replay) still surface as 400/403 from the worker
  rather than executing.
- **Bundle delta:** `/admin/damage/[id]` is unchanged at 3.08 kB / 108
  kB First Load JS. Removing server-only diagnostic code doesn't
  affect the client bundle.
- **Latent issues in transitions table:** none — all 33 rows have
  non-empty `allowedRoles` and labels.
