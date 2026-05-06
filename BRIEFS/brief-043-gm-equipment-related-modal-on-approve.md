# Brief 43: GM/RM equipment-related modal on Approve transitions

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Nothing.
**Dependencies:**
- Brief 41 (damage_type, damage_other on claims). Completed 2026-05-06.
- Brief 42 (`createMaintainXWorkOrder` helper, the
  `maintainx_workorder_id` column on claims, the
  `getMaintainXLocationId` Supabase helper, the
  MAINTAINX_MODE/BASE_URL/APPS_WEB_BASE_URL vars in damage-worker
  wrangler.toml). Completed 2026-05-06.

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-042-maintainx-workorder-on-equipment-related.md
  (the helper this brief reuses + the dedupe pattern via
  `maintainx_workorder_id`)
- apps/web/app/admin/damage/[id]/page.tsx (the detail page —
  status-transition action buttons render here; CLAUDE.md notes
  every valid-from-status transition shows, with allowedRoles
  gating)
- apps/web/app/admin/damage/[id]/_components/* if any (the
  client-side form/button components for transitions; hunt for
  the existing pattern Brief 5c/19 established)
- apps/damage-worker/src/index.ts (the transition write handler
  — search for `claim_status` UPDATE statements or
  `transitionStatus` style helpers; this is the endpoint that
  apps/web posts to when a transition fires)
- packages/types/src/claims.ts (ClaimStatus enum; the two
  target statuses are
  `"Approved — In House — Parts Ordered"` and
  `"Approved — Pending Quotes"` — em-dash is U+2014, gotcha
  flagged in the file's comment)
- legacy/damagemanager.js if any of the existing transition
  fields aren't obvious from the worker code (the in-house
  transition captures free-form notes per `ClaimRow.staff_notes`
  comment around line 179 in claims.ts; preserve whatever the
  current transition already collects)

## Context

The customer claim form's employee section captures
`equipment_related` (1 if equipmentInvolved ≠ "" / "N/A", else 0).
Brief 42 fires a MaintainX work order when an employee submits
with `equipment_related === 1`.

Some claims slip through with `equipment_related === 0` even when
the damage IS equipment-related — the employee either didn't
notice or didn't want to flag it. The GM/RM/super_admin reviewing
the claim is the second-chance gate. When they approve a claim
into one of the two "active repair" branches — "Approved — In
House — Parts Ordered" or "Approved — Pending Quotes" — and
the claim is still flagged equipment_related=0, the system
should ask them: "Was this damage equipment related?"

If they say Yes, the system:
- Updates `equipment_related = 1` and `equipment_piece = <selected>`
- Fires the existing `createMaintainXWorkOrder` helper (Brief 42)
  with dedupe via `maintainx_workorder_id` (defense-in-depth — at
  this point the column SHOULD be NULL since equipment_related
  was 0, but the gate stays in place)
- Logs to `claim_activity_log`
- Performs the status transition as it would have anyway

If they say No, the transition proceeds unchanged. No DB writes
beyond the existing transition columns.

The modal does NOT pop when:
- `claim.equipment_related === 1` already (employee already said
  yes; Brief 42 handled it OR a prior GM modal handled it)
- The transition target is anything other than the two listed
  approve-branch statuses (the modal isn't relevant to "No
  Responsibility" closures, "Pending RM Review" handoffs, etc.)
- The caller's role isn't in the transition's `allowedRoles`
  (the button is already disabled in that case — the modal
  question never gets asked)

`damage_type` is NOT collected here. The employee's damage_type
selection (Brief 41, mandatory at submit) stands. If a GM wants
to amend damage_type, that's a separate brief.

## Scope

### Phase 1 — Worker: extend the transition handler

1.1 Find the existing transition handler in
`apps/damage-worker/src/index.ts`. Look for the route that
accepts a `claim_status` change — likely `POST
/claims-api/{id}/status` or a similar transition endpoint
landed by Brief 5c. Confirm the input shape.

1.2 Extend the input schema to optionally accept:

```ts
override_equipment_related?: "yes" | "no" | undefined;
override_equipment_piece?: string;  // required when override_equipment_related === "yes"
```

The `override_` prefix makes it grep-able and signals the
distinction from the form-time fields. Both keys are optional;
when absent, the transition behaves exactly as before
(back-compat with the existing buttons).

1.3 Server-side validation:
  - If `override_equipment_related === "yes"`:
    - `override_equipment_piece` must be a non-empty string
      (≤ 200 chars)
    - The current claim's `equipment_related` must be 0 (this
      flow only flips no→yes; rejecting yes→yes-with-override
      avoids accidental dedupe defeats)
  - If `override_equipment_related === "no"` or absent: ignore
    `override_equipment_piece` if sent

1.4 When the override fires (yes branch):
  - In the existing transition transaction (whatever pattern the
    worker uses — D1 batch, sequential UPDATEs, etc.), add an
    UPDATE that sets `equipment_related = 1` and
    `equipment_piece = ?` on the claim row. Order: do this
    BEFORE the status UPDATE so the in-memory claim row read
    after the transition has the new equipment fields visible.
  - After the transaction commits, call
    `createMaintainXWorkOrder` (from Brief 42's
    `apps/damage-worker/src/maintainx.ts`) with the same
    fail-soft posture: timeout, try/catch, never throw past the
    handler. Dedupe gate: re-read the claim's
    `maintainx_workorder_id` column inside a small helper
    `tryCreateMaintainXIfMissing(env, claimId)` and skip the
    POST if it's already non-null. Brief 42's
    `updateMaintainXWorkOrderId` is the pattern.
  - Activity log entries:
    - One `note` row (or whatever activity type is closest;
      Brief 32 used `note` with `[mx]` prefix per CLAUDE.md
      glossary) with body
      `{actor} flipped equipment_related to yes during {transition_to} approval (equipment_piece: {piece})`
    - On MaintainX success: one `[maintainx]` activity entry
      same as Brief 42 records on form submission
    - On MaintainX failure: one `[maintainx]` activity entry
      with the error/status; the status transition itself
      still succeeds (fail-soft)

1.5 Activity log: the action recorded should be the status
transition, with the equipment override mentioned in the
notes/body. Don't introduce a separate "equipment_overridden"
activity_type — the existing `status_change` row is the
authoritative event; the override is a side-effect logged in
the same transaction.

### Phase 2 — apps/web: modal on the two transition buttons

2.1 Identify the two transition buttons on
`apps/web/app/admin/damage/[id]/page.tsx`. They render via the
status-transition pattern referenced in CLAUDE.md ("every
valid-from-status transition renders"). Find the one that
targets `"Approved — Pending Quotes"` and the one that targets
`"Approved — In House — Parts Ordered"`. The detail page may
already have a client component for transition forms — extend
that, don't fork a new file unless the existing component is
hopelessly tangled.

2.2 Add a client-side modal component
`apps/web/app/admin/damage/[id]/_components/EquipmentOverrideModal.tsx`
(or extend an existing modal component if `ModalShell` from
`packages/ui` is already in use on this page). Modal contents:

  - Header: "Was this damage equipment related?"
  - Body: brief context — "You're approving this claim into
    {transitionLabel}. The employee marked it equipment_related =
    no, but you can override that here. If you say Yes, a
    MaintainX work order will be created and assigned to
    maintenance."
  - Two segmented-toggle buttons or radios: No (default) / Yes
  - When Yes is selected, reveal an `equipment_piece` dropdown.
    Use the same option list the public claim form's
    equipmentInvolved dropdown uses (DRY: import the source-of-truth
    constant — search the apps/damage-worker render tree for
    where `equipmentOpts` is generated; if the constant lives
    in the worker, mirror it in a shared `packages/types` const
    for cross-package reuse, OR hard-fork into apps/web with a
    comment pointing at the worker as canonical. Executor's
    judgment call.)
  - Submit button: "Confirm — {transitionLabel}"
  - Cancel button: closes the modal, transition does NOT fire

2.3 Modal-show condition (client-side): show the modal on
button click ONLY when:
  - `claim.equipment_related === 0`
  - The user clicked one of the two target-status transition
    buttons (Approved — Pending Quotes OR Approved — In House —
    Parts Ordered)

In all other cases (other transitions, or equipment_related
already 1), the existing button submits its form directly,
unchanged.

2.4 On modal submit:
  - Add hidden inputs to the transition form:
    - `override_equipment_related` = "yes" or "no"
    - `override_equipment_piece` = selected piece (only when yes)
  - Submit the form (re-using the existing server action / route
    handler / direct fetch — whatever the existing transition
    button does). The hidden fields land in the worker's input
    body alongside whatever fields the transition already
    captured (e.g., in-house notes for the in-house branch).

  Do NOT replace the form's submission path. The modal is a
  pre-flight gate that adds two fields; everything downstream
  is unchanged.

2.5 Do NOT show the modal at all when the role gate already
hides the transition button. CLAUDE.md notes UI gating is a
hint and the worker re-validates — same posture here.

### Phase 3 — apps/web: server action / route plumbing

3.1 Whatever server action or route handler currently dispatches
the transition (Brief 19 pattern: `useActionState` →
`router.refresh()`) needs to forward the two new optional fields
to the worker. Read them from `formData.get(...)`. Forward
verbatim — no transformation in the apps/web layer.

3.2 Result handling: success path is identical to today
(message + refresh). On worker error, surface the existing
error pattern. The MaintainX failure mode is fail-soft per
Phase 1.4 — the worker returns 200 even if MaintainX 5xx'd, so
apps/web won't see a distinct error for that.

3.3 Add a small UX afterthought: if the worker response includes
a flag like `maintainx_attempted: true, maintainx_ok: false`,
surface a toast/alert "Approved, but the MaintainX work order
couldn't be created — see activity log." Otherwise just the
normal success message. This requires extending the worker's
response shape on the transition endpoint to optionally include
those flags.

### Phase 4 — Manager detail page

4.1 The "MaintainX WO" / "WO not created" rows landed in Brief 42
already render correctly off `claim.maintainx_workorder_id` and
`claim.equipment_related`. After the override flow runs, both
columns are updated, so the page automatically renders the new
state on refresh. No additional changes here unless the
existing render has a stale-data issue (e.g., relies on a
client-side state that wasn't bumped).

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 43 row added with Outcome summary.

5.2 BUILD_STATE.md: Findings entry noting:
  - Two paths now create MaintainX WOs: form-submit
    (Brief 42) and GM-side approve override (Brief 43)
  - Both share the `createMaintainXWorkOrder` helper +
    `maintainx_workorder_id` dedupe key
  - The override flow only fires on no→yes flips; yes→yes is
    rejected to keep the dedupe gate honest
  - The modal's equipment_piece options are sourced from
    {wherever the executor put the shared constant}

5.3 If the executor created a shared equipment-piece constant in
`packages/types`, note the new export there.

## Out of scope

- Letting GMs amend `damage_type` / `damage_other`. The
  employee's selection stands. If ops needs this later, separate
  brief.
- Letting GMs flip `equipment_related` from yes back to no
  (closing an erroneously-fired WO). If a WO was created in
  error, ops handles it on the MaintainX side; we don't
  retract the row in our system.
- Showing the modal on transitions other than the two listed.
- Any change to the public claim form (Brief 41 owns that
  surface).
- Don't deploy from headless. Operator pushes for apps/web (CF
  Workers Builds redeploys); operator runs `pnpm --filter
  @splash/damage-worker exec wrangler deploy` after smoke
  testing.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- Worker transition handler accepts
  `override_equipment_related` and `override_equipment_piece`
  optional fields with correct validation
- When override=yes, claim row's `equipment_related` flips to 1,
  `equipment_piece` is set, and `createMaintainXWorkOrder`
  fires with the existing fail-soft + dedupe behavior
- Activity log captures the override + the MaintainX outcome
- apps/web modal renders ONLY on the two target transitions
  AND when `claim.equipment_related === 0`
- Modal submit forwards `override_equipment_related` (always)
  and `override_equipment_piece` (when yes) to the worker
- Cancel from modal does not fire the transition
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/damage-worker build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Files created / modified
- Where the equipment-piece option list ended up (shared constant
  vs. duplicated)
- Confirmation that smoke-testing both paths in test mode
  produced exactly one MaintainX WO per claim (no duplicates from
  the dedupe gate)
- Bundle-size delta on apps/web /admin/damage/[id]
- Bundle-size delta on damage-worker (likely zero — Brief 42
  already imported the helper)
- Validation results
- Any decisions made on the operator's behalf

## Outcome

### Files created
- `apps/web/app/admin/damage/_components/EquipmentOverrideModal.tsx` — single
  named export `EquipmentOverrideSubmit`. Client island ("use client") that
  renders the transition form's submit button + a modal-gated pre-flight.
  Click handler intercepts `e.preventDefault()` only when `modalEnabled &&
  enabled`; otherwise the form submits normally. Modal asks "Was this
  damage equipment related?" with segmented No/Yes radios (No defaulted),
  reveals an `equipment_piece` `<select required>` on Yes (6 options
  hard-forked from worker `EQUIPMENT_CHOICES` with an in-file comment
  pinning the worker as canonical). On confirm, `appendHiddenInput` writes
  `override_equipment_related` ("yes"/"no") + `override_equipment_piece`
  (when yes) hidden inputs onto the parent `<form>` (deduping by name so
  re-opens update in place rather than appending) and calls
  `form.requestSubmit(submitButton)` so React 19's form-action pipeline
  picks up the existing `useActionState` formAction identically to a
  native click. ESC + click-outside both cancel without submitting.

### Files modified
- `apps/damage-worker/src/index.ts` — `handleStatusTransition` reads
  `override_equipment_related` + `override_equipment_piece` from the
  posted form; new `eqOverrideTargets` set holds the two target statuses
  ("Approved — Pending Quotes", "Approved — In House — Parts Ordered");
  validates yes-only on the two target statuses, only no→yes flips,
  equipment_piece required + ≤200 chars (rejecting yes→yes-with-override
  avoids accidentally defeating the dedupe gate); folds
  `equipment_related = 1` + `equipment_piece = ?` into the same UPDATE
  that lands the status change so the writes are atomic with the
  status_change activity-log INSERT in `env.DB.batch([...])`. Activity
  notes composition rewritten to a `noteParts: string[]` array so the
  pre-existing `[Reset approval details on revert]` sentinel and the new
  `[Equipment override] {actor} flipped equipment_related to yes during
  "{finalTo}" approval (equipment_piece: P)` sentinel can coexist on the
  same `status_change` row when both fire (no new activity_type
  introduced — D1 CHECK constraint still rejects values outside the
  legacy union per Brief 42's same finding). After the batch commits, a
  new module-local `tryCreateMaintainXIfMissing` helper fires Brief 42's
  `createMaintainXWorkOrder` with the same fail-soft posture: re-reads
  `claims.maintainx_workorder_id` via `getClaimById` BEFORE issuing the
  POST so a concurrent writer that already landed a WO short-circuits
  this path (defense-in-depth dedupe on top of Brief 42's
  `updateMaintainXWorkOrderId` UPDATE-only-when-NULL semantics);
  constructs a transient post-UPDATE `ClaimRow` (`equipment_related=1`,
  `equipment_piece=overrideEquipmentPiece`, `claim_status=finalTo`,
  `lifecycle_state=lifecycleForStatus(finalTo)`); calls the helper with
  an 8 s `AbortController` timeout; writes a `[maintainx]` `note`-typed
  activity-log entry on success ("Work order #N created via
  approval-time override (mode: M)") or failure ("Override WO creation
  failed — {error} (status: S, mode: M)"). Helper return shape
  `{ attempted: boolean, ok: boolean }`. The transition's JSON response
  was extended to optionally include `maintainx_attempted` +
  `maintainx_ok` flags (only on the override path) so apps/web can
  distinguish the create-failed branch.
- `apps/web/app/admin/damage/[id]/page.tsx` — imported
  `EquipmentOverrideSubmit` from `../_components/EquipmentOverrideModal`;
  threaded `equipmentRelated: 0 | 1` through `TransitionSection` →
  `TransitionForm`; added module-local `EQUIPMENT_OVERRIDE_TARGETS` set
  with the two target statuses; swapped the inline `<button
  type="submit">` for `<EquipmentOverrideSubmit label={label}
  enabled={enabled} modalEnabled={equipmentRelated === 0 &&
  EQUIPMENT_OVERRIDE_TARGETS.has(to)} transitionLabel={label} />`. The
  button's enabled/disabled styling is preserved inside the new
  component so the show-disabled pattern (Brief 21) still renders
  identically when the dcRole gate fails.
- `apps/web/app/admin/damage/[id]/actions.ts` — `transitionAction` now
  inspects `result.body` and on `maintainx_attempted === true &&
  maintainx_ok === false` returns `{ ok: true, message: "Status
  updated to X, but the MaintainX work order couldn't be created — see
  activity log." }` instead of the plain success message. Failure is
  fail-soft on the worker (the status transition committed even though
  MaintainX 5xx'd / timed out / WO ID couldn't be parsed); the
  success-toned message names the failure so the operator can check
  the activity log without thinking the transition itself broke.
- `BRIEFS/INDEX.md` — Brief 43 row added with Outcome summary.
- `BRIEFS/QUEUE.md` — Brief 43 line moved to the completed-tombstone
  block (orchestrator-style).
- `BUILD_STATE.md` — "Last updated" bumped, Findings entry added,
  prioritized work list row 43 inserted.

### Where the equipment-piece option list ended up
**Hard-forked into `apps/web/app/admin/damage/_components/EquipmentOverrideModal.tsx`**
with an in-file comment pinning `apps/damage-worker/src/render/claim-form.ts:18`
as the canonical source. The brief explicitly delegated this choice to
the executor. Rationale documented in the BUILD_STATE Findings entry —
short list (6 entries), rare changes, and the cross-package alternative
(hoisting into `@splash/types`) would have required converting that
package from types-only to runtime-export plus three touch points
(types, worker, apps/web).

### Confirmation that smoke-testing both paths in test mode produced exactly one MaintainX WO per claim
**Deferred to operator.** Headless Claude cannot exercise live MaintainX
(same constraint as Brief 42). Operator should run:
1. Submit a customer claim with `equipment_related=1` (Brief 42 path),
   confirm one WO appears in Josh's MaintainX inbox under `MAINTAINX_MODE=test`.
2. On a separate claim, submit with `equipment_related=0`, then GM-approve
   into one of the two target statuses with the modal saying Yes; confirm
   one WO appears.
3. Attempt the override modal twice on the same claim (re-open the page,
   click the same transition button again). The second attempt's worker
   call should reject with "Equipment override only flips no→yes; this
   claim already has equipment_related=yes" (because the first attempt
   already flipped the column to 1) — and the post-batch
   `tryCreateMaintainXIfMissing` re-read short-circuits before issuing
   the MaintainX POST. Net: exactly one WO per claim.

### Bundle-size delta on apps/web /admin/damage/[id]
- 3.1 kB → 4.11 kB (+1.01 kB) route bundle
- 108 kB → 109 kB (+1 kB) First Load JS

The `EquipmentOverrideSubmit` client island accounts for the delta.

### Bundle-size delta on damage-worker
- 1679.53 KiB → 1685.55 KiB uncompressed (+6.02 KiB)
- 380.73 KiB → 381.86 KiB gzip (+1.13 KiB)

The `tryCreateMaintainXIfMissing` helper + the override-validation
branch + the response-shape spread account for the delta. Comfortably
within CF's 3 MiB compressed limit.

### Validation results
- `pnpm typecheck` — 13/13 successful, 7.119s. Cache hit on 11, fresh
  build on `@splash/web` + `@splash/damage-worker` as expected — only
  those two packages were modified.
- `pnpm --filter @splash/web build` — succeeded; `next build` compiled
  in 9.3s, all 12 routes generated; `/admin/damage/[id]` route bundle
  4.11 kB / 109 kB First Load JS.
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run` —
  succeeded; bundle 1685.55 KiB / 381.86 KiB gzip; dry-run binding
  table confirms the three Brief-42 `[vars]` entries
  (`MAINTAINX_MODE`, `MAINTAINX_BASE_URL`, `APPS_WEB_BASE_URL`) are
  still wired.

### Decisions made on operator's behalf
1. **Equipment-piece options hard-forked into the modal file** rather
   than hoisted into `@splash/types`. Executor's call per the brief.
2. **Modal-show condition is purely client-side** (`equipmentRelated
   === 0` + target ∈ {two statuses} + button enabled). Worker
   re-validates as defense-in-depth.
3. **`form.requestSubmit(submitButton)`** invoked with the button as
   the submitter so React 19's form-action pipeline picks up the
   `useActionState` formAction identically to a native click.
4. **Defense-in-depth dedupe re-read** in `tryCreateMaintainXIfMissing`
   short-circuits when `maintainx_workorder_id != null` already.
5. **Override side-effect logged on the same status_change row** rather
   than as a separate activity row — per brief Phase 1.5 ("don't
   introduce a separate `equipment_overridden` activity_type").
6. **Modal styling uses inline tailwind classes** rather than
   `ModalShell` from `@splash/ui` — `ModalShell` is sized for the
   signup-worker's success/deny/warn cards (max 420px, padded `40px
   30px`, centered text) and didn't fit the override modal's
   left-aligned copy + segmented choice + conditional dropdown +
   two-column action row layout cleanly.
7. **Worker response shape extension is conditional** —
   `maintainx_attempted` + `maintainx_ok` only emit on the override
   path; non-override transitions return the same shape they always
   did, so existing apps/web message handling is unchanged for every
   other transition.
8. **The `appendHiddenInput` helper dedupes by name** so re-opens of
   the modal after a previous confirm update in place rather than
   appending duplicates. Without this, a user who opens the modal,
   cancels, then re-opens and confirms would post two entries for the
   same field; FormData would then read the LAST value — safer to
   update in place.

### Latent issues / forward flags
- **Empirical MaintainX probe still pending** — inherited from Brief 42;
  flipping `MAINTAINX_MODE` to `"production"` is still gated on the
  operator running the probe and confirming the WO ID extractor's
  fallback chain works. Brief 43 doesn't introduce a new MaintainX
  call shape; the helper signature was stable before this brief
  landed.
- **The override modal's "Yes" branch fires the MaintainX hook
  synchronously inside the request lifecycle** — adds up to 8 seconds
  (the AbortController timeout) to the transition's response time on
  the WO-failure path. apps/web's `<ActionForm>` shows the loading
  state via `data-pending="true"`; operators on a slow MaintainX
  response will see the button disabled for the duration. Acceptable
  for v1; future polish could move the hook to `ctx.waitUntil()` (out
  of scope per CLAUDE.md "no abstractions beyond what the task
  requires").
- **No headless smoke test possible** — see "Confirmation" section
  above; operator must run the three-step smoke test post-deploy.
- **PA Parse JSON schema doesn't need updating for Brief 43** — the
  override path doesn't extend the `claimData` payload; the WO ID
  lives on the `claims` row in D1 and is updated post-status-change,
  not on the transition's PA hook.
- **Worker bundle delta (+6 KiB / +1 KiB gzip) is small but
  non-trivial** — the `tryCreateMaintainXIfMissing` helper is ~60 lines
  of helper plus call-site wrapping. The transient `ClaimRow`
  construction uses `{...claim, ...overrides}` spread, which is
  smaller than re-building each field but still adds bytes per
  override fire.

### Operator action items
1. Run the three-step smoke test described in "Confirmation" above.
2. If modal copy needs tweaking ("Was this damage equipment related?"
   / "...assigned to maintenance.") edit
   `apps/web/app/admin/damage/_components/EquipmentOverrideModal.tsx`.
3. If a GM ever needs to flip `equipment_related` from yes back to no
   (the brief explicitly out-of-scoped this), ops handles the WO
   retraction on the MaintainX side; the override flow only flips
   no→yes.
4. The Brief 42 follow-up empirical probe (still pending from that
   session) covers Brief 43 too — same MaintainX call shape, same
   response parser.
