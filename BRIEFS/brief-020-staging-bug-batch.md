# Brief 20: Staging-test bug batch — sysadmin idempotency + damage UX/data integrity

**Status:** Completed (2026-05-05)
**Started:** 2026-05-05
**Completed:** 2026-05-05
**Blocks:** Real day-to-day usability of damage manager + sysadmin write
flows. Operator's first end-to-end test on staging surfaced 8 distinct
bugs spanning worker validation, worker idempotency, UI required-fields,
UI state-aware rendering, and UX guidance for empty states.
**Dependencies:** Brief 19 (server-action result + router.refresh
pattern — assumed landed and working), Brief 18 (UserPicker, dcRole
filter drop), Brief 17 (service bindings), Brief 7 (sysadmin),
Briefs 5c+5d (damage write actions + documents).

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-005c-damage-write-actions.md (transition + note shape)
- BRIEFS/brief-005d-damage-documents.md (upload/edit/delete shape)
- BRIEFS/brief-007-sysadmin-ui.md
- BRIEFS/brief-018-damage-and-sysadmin-fixes.md
- BRIEFS/brief-019-action-result-refresh.md
- apps/web/app/admin/damage/[id]/page.tsx
- apps/web/app/admin/damage/[id]/actions.ts
- apps/web/app/admin/damage/_lib/transitions.ts
- apps/web/app/admin/sysadmin/page.tsx
- apps/web/app/admin/sysadmin/actions.ts
- apps/sysadmin-worker/src/index.ts (handleGrantTool, handleRevokeTool)
- apps/damage-worker/src/index.ts (handleTransition, handleEditDocument,
  the per-status revert clearing logic)
- packages/types/src/claims.ts (ClaimRow approval-detail columns)

## Context

Operator's first real end-to-end smoke test on staging exposed 8 bugs.
Each is grouped below with a fix path.

### Sysadmin idempotency

**Bug 1 — revoke-tool says "revoked" when nothing was revoked.**
Worker accepts the request, runs DELETE which affects 0 rows, returns
ok. UI shows green success.

**Bug 2 — grant-tool says "granted" when the tool was already granted.**
Same shape: INSERT...ON CONFLICT DO NOTHING returns ok with 0 rows
affected; UI shows green success.

Fix path: worker returns `{ ok: true, changed: true | false }` so the
UI can distinguish a real state change from a no-op. UI message shape:
green "Granted X" on changed=true; neutral "Already had X (no change)"
on changed=false.

### Damage detail data integrity

**Bug 3 — stale Approval Details box.**
Reverting from "Approved — In House Parts Ordered" back to "Approved —
Pending Quotes" leaves `claim.vendor_name`, `claim.parts_ordered`, and
`claim.approved_amount` populated. The UI's ApprovalDetails box renders
those fields, so vendor "parts.com" and parts "roof" persist on a claim
whose current status is "Approved — Pending Quotes" — confusing.

Fix path (two-pronged):
  - **Worker**: when a transition's `to` status is one that should clear
    approval details (any status earlier than the in-house path —
    typically "Approved — Pending Quotes", "Pending GM Review", etc.),
    null out the affected columns as part of the UPDATE.
    The transition table at `apps/damage-worker/src/transitions.ts` (or
    inline in handleTransition) is the right place to encode "clear on
    revert" — add a `clearApprovalDetails?: boolean` flag per
    transition row, set true on the revert transitions; the handler
    nulls vendor_name, parts_ordered, approved_amount, approved_quote_id
    when the flag is true.
  - **UI defensive check**: ApprovalDetails should only render when at
    least one of vendor_name / parts_ordered / approved_amount /
    approved_quote_id is non-null AND the current status indicates the
    approval is still relevant. The "non-null" gate alone catches the
    worker-cleared case; the status check is belt-and-suspenders.

### Damage detail UX guidance

**Bug 4 — "no quotes on file" dead end.**
The "Approve Quote (submit Check Request)" transition requires
`requiresApprovedQuoteId`. If the claim has no Quote-typed photos,
the dropdown is empty + the button is disabled. No guidance toward
fixing.

Fix path: when the Quote select is empty, replace the disabled
form with a small inline hint card: "No quotes uploaded yet. Use the
Documents section below to upload one." Render an anchor link
`<a href="#upload-document">Upload a Quote</a>` that scrolls to the
upload card. Add `id="upload-document"` to the upload card section
on the same page.

### Damage detail required fields

**Bug 5 — Quote upload form: amount + pay_to_type are optional.**
The worker stores them as nullable; UI should require them on Quote
uploads (Receipts can stay optional since they don't drive the
check-request PDF).

**Bug 6 — when pay_to_type=vendor, vendor + vendor_address should be
required.**
Currently both are always optional even when pay_to_type=vendor.

Fix path:
  - UI: add `required` attribute on `amount` and `pay_to_type` when
    `doc_type === "Quote"`. Add conditional `required` on `vendor` and
    `vendor_address` when `pay_to_type === "vendor"`. Use a small
    client component (`UploadDocumentCard` upgrade) with `useState`
    for doc_type and pay_to_type to drive the conditional required
    attrs.
  - Worker: tighten validation on POST /document and POST /document/
    {id}/edit — reject Quote rows missing amount or pay_to_type with
    400 "amount is required for Quote documents" / "pay_to_type is
    required for Quote documents". Reject vendor pay_to_type rows
    missing vendor or vendor_address.

### Damage detail edit-flow bugs

**Bug 7 — edit-quote save throws a generic Next.js client error
(E394) but the worker still advances claim status with incomplete
data.**
Two issues stacked. The E394 error is "An unexpected response was
received from the server" — server action returned a non-RSC content
type. Symptom suggests `editDocumentAction`'s response shape isn't
serializable (e.g., returning a non-plain object) OR the action throws
mid-execution and Next surfaces the raw error to the client.

Worker advancing status with incomplete data: this is part of Bug 5/6
fix — worker rejects 400 if Quote is missing amount/pay_to_type, so
the document update fails BEFORE any transition would be allowed.

Fix path:
  - Action side: ensure `editDocumentAction` always returns a plain
    `{ ok: true, message } | { ok: false, error }` and never throws
    uncaught. Wrap any worker errors into the result.
  - Worker side: tighten edit validation (covered in Bug 5/6 fix
    section).

**Bug 8 — edit-quote `<details>` stays open after save.**
ActionForm's `key` trick remounts the form on success which clears
uncontrolled inputs, but the surrounding `<details open>` element
persists in the open state.

Fix path: when result.ok in the edit form's ActionForm, additionally
flip the `<details>` element's `open` state via React state. Either:
  - Make `DocumentEditForm` a client component that owns `open` state
    and closes the `<details>` programmatically when ActionForm's
    result.ok fires.
  - Or use the `key` trick on the `<details>` element itself so it
    remounts in the closed state on successful submit.

The `key`-on-details approach is simpler and matches existing
pattern.

## Scope

### Part A — Worker changes (sysadmin + damage)

A.1 `apps/sysadmin-worker/src/index.ts` — `handleGrantTool` +
`handleRevokeTool`:
  - After the INSERT/DELETE, check the affected-rows count.
  - Return `{ ok: true, changed: true }` when a row was inserted or
    deleted, `{ ok: true, changed: false }` when the operation was
    a no-op (already granted / not granted).
  - Update the audit-log to note no-op cases distinctly so super_admins
    can see "attempted to grant claims to alice — already granted" in
    sysadmin_audit_log.

A.2 `apps/damage-worker/src/transitions.ts` (or inline in
handleTransition):
  - Add a `clearApprovalDetails?: boolean` flag to UITransition /
    CLAIM_TRANSITIONS rows. Set true on transitions that revert from a
    later state to an earlier one (e.g., "send back to GM Review",
    "send back to Pending Quotes", "Deny", any "back to" path).
  - In handleTransition, when the chosen transition has
    `clearApprovalDetails === true`, NULL out:
    - `vendor_name`
    - `parts_ordered`
    - `approved_amount`
    - `approved_quote_id`
    - Audit stamps (`gm_approved_at/by`, `rm_approved_at/by`,
      `ceo_approved_at/by`) — these get reset since the approval is no
      longer valid.
  - Update the activity_log row's notes to mention the clearing
    ("Reset approval details on revert").
  - Mirror the flag into apps/web's `_lib/transitions.ts` to keep the
    shared shape in sync (per the sync-checklist comment in 5c).

A.3 `apps/damage-worker/src/index.ts` — `handleAddDocument` +
`handleEditDocument`:
  - When `photo_type === "Quote"`:
    - reject if `amount` is null/missing → 400 "amount is required for
      Quote documents".
    - reject if `pay_to_type` is null/missing → 400 "pay_to_type is
      required for Quote documents".
    - when `pay_to_type === "vendor"`:
      - reject if `vendor` is null/empty → 400 "vendor is required
        when pay_to_type is vendor".
      - reject if `vendor_address` is null/empty → 400 "vendor_address
        is required when pay_to_type is vendor".
  - Receipt rows stay loose — same fields are optional there.

### Part B — UI changes (damage detail + sysadmin)

B.1 `apps/web/app/admin/damage/[id]/page.tsx` — ApprovalDetails:
  - Render only when at least one of vendor_name / parts_ordered /
    approved_amount / approved_quote_id is non-null.
  - The new worker behavior (Part A.2) clears these on revert, so this
    UI gate is defensive — should be a no-op once the worker fix
    deploys.

B.2 `apps/web/app/admin/damage/[id]/page.tsx` — Approve Quote no-quotes
hint:
  - Inside the TransitionSection, when a transition has
    `requiresApprovedQuoteId === true` AND the claim has no Quote-typed
    photos (filter `photos` by `photo_type === "Quote"`), replace the
    disabled `<select>` + button with a small hint card:
    "No quotes uploaded yet. <a href='#upload-document'>Upload a quote
    first</a>." styled as muted text. The anchor should scroll the
    page to the upload card.
  - Add `id="upload-document"` to the UploadDocumentCard wrapper so
    the anchor lands at the right scroll position.

B.3 `apps/web/app/admin/damage/[id]/page.tsx` — UploadDocumentCard +
DocumentEditForm: required-field upgrades.
  - Convert UploadDocumentCard to a client component (`"use client"`),
    `useState` for `docType` and `payToType`. The `required` attrs on
    `amount`, `pay_to_type`, `vendor`, `vendor_address` are conditional
    on docType / payToType.
    - amount: `required={docType === "Quote"}`
    - pay_to_type: `required={docType === "Quote"}`
    - vendor: `required={docType === "Quote" && payToType === "vendor"}`
    - vendor_address: `required={docType === "Quote" && payToType === "vendor"}`
  - DocumentEditForm: same pattern. Already has docType (per-tile, fixed
    by row's photo_type) so it's a useState for payToType only when
    photo_type === "Quote".

B.4 `apps/web/app/admin/damage/[id]/page.tsx` — DocumentEditForm
close-on-save:
  - Use the ActionForm's success state to close the `<details>` element.
    Either:
    - Make DocumentEditForm a client component owning the details-open
      state, controlled by a `useState`. On ActionForm result.ok, set
      open to false.
    - OR use the `key` trick on `<details>` so it remounts (closed) on
      success. Needs the parent re-render that ActionForm's
      router.refresh() already provides.
  - The latter (key-trick) is simpler if router.refresh() reliably
    re-renders the details. Pick whichever is cleaner during the
    refactor.

B.5 `apps/web/app/admin/sysadmin/actions.ts` — Surface the worker's
`changed` flag in the user-facing message:
  - `grantToolAction`: success message "Granted <tool>" when changed,
    "<tool> was already granted (no change)" when not.
  - `revokeToolAction`: success message "Revoked <tool>" when changed,
    "<tool> wasn't granted (no change)" when not.
  - The ActionForm renders these in green vs. a neutral/info color
    based on a new `result.kind: "changed" | "noop"` field if needed —
    or just keep result.ok=true with a different message text and let
    the visual treatment stay green (simpler v1; user reads the
    message).

### Part C — Updates

C.1 BRIEFS/INDEX.md — mark Brief 20 Completed.

C.2 BUILD_STATE.md — Last updated, Findings entry summarizing the
batch, list each bug + its fix.

C.3 CLAUDE.md — add "no-op detection" to the Server actions subsection
if it lands cleanly (sysadmin's pattern is reusable elsewhere).

## Out of scope

- Refactoring pricing admin's already-working pattern.
- Adding bulk operations on sysadmin (multi-grant, multi-revoke).
- Rewriting the transition table to a fully shared package
  (`@splash/damage-shared` etc.) — keep the dual-source mirror with
  sync comments.
- Performance tracker submission UX changes.
- Don't deploy from headless mode. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- sysadmin grant-tool / revoke-tool return changed=true|false; UI
  shows distinct messages for state change vs. no-op
- damage transitions with clearApprovalDetails=true clear vendor /
  parts_ordered / approved_amount / approved_quote_id / audit stamps
- ApprovalDetails box hidden when all four fields are null
- "Approve Quote (submit Check Request)" without quotes-on-file shows
  the hint-with-anchor instead of disabled select
- Quote upload + edit forms enforce required attrs on amount,
  pay_to_type (always for Quote) and vendor + vendor_address
  (when pay_to_type=vendor)
- Worker rejects Quote uploads/edits missing those fields with 400
- DocumentEditForm closes the `<details>` after successful save
- BUILD_STATE.md and BRIEFS/INDEX.md updated; CLAUDE.md updated if
  applicable
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- For each of the 8 bugs: which fix path was taken (worker / UI /
  both), any latent issues found while reading the relevant code
- Bundle-size delta on /admin/damage/[id] from converting
  UploadDocumentCard / DocumentEditForm to client components (likely
  +1-2 kB)
- Any places where the existing transition table needed clearing
  flags retroactively (full audit + all "back to X" transitions
  marked)
- Validation results

## Outcome

### Bug-by-bug fix paths

| Bug | Fix path | Notes |
|---|---|---|
| 1 — revoke-tool says "revoked" on no-op | Worker: `handleRevokeTool` returns `{ ok: true, changed: bool }` (was `was_present`) + writes a `revoke_tool_noop` audit row when changed=false. UI: `revokeToolAction` reads `changed` via `readChanged(body)`; success message is "Revoked X" vs. "X wasn't granted (no change)". | The noop audit row uses a distinct `action` value rather than overloading `revoke_tool` — clean SQL filter. |
| 2 — grant-tool says "granted" on no-op | Symmetric to Bug 1 (worker + action update). | "Granted X" vs. "X was already granted (no change)". |
| 3 — stale Approval Details box on revert | Worker: new `clearApprovalDetails` flag on `ClaimTransitionDef` (canonical in `apps/damage-worker/src/transitions.ts`), 18 transitions flagged. `handleStatusTransition` appends `approved_amount = NULL`, `approved_quote_id = NULL`, `parts_ordered = NULL`, `vendor_name = NULL`, plus 6 audit-stamp NULLs to the UPDATE; activity_log note suffixed with `[Reset approval details on revert]`. apps/web `_lib/transitions.ts` mirrors the flag (no UI rendering driven by it yet — flag is visible for code review). UI defensive null gate on `ApprovalDetails` retained (existing populated-fields check already covered the case; comment updated to explain the dual layer). | Intra-workflow steps where approval is still valid (Submitted → Check-Request, Check-Issued → Check-Request, In-House Repaired → In-House Parts Ordered, Closed-Approved/No-Response → Check-Request) intentionally do NOT carry the flag. |
| 4 — "no quotes on file" dead end | UI: `TransitionForm` early-returns a hint card with `<a href="#upload-document">Upload a quote first</a>` instead of rendering a disabled `<select>` + button when `requiresQuoteSelection && quotes.length === 0`. New `UploadDocumentCard` component carries `id="upload-document"` on its root `<div>` so the anchor lands at the right scroll position. | Hint replaces the entire form row (label + select + button), not just the disabled state. |
| 5 — Quote upload: amount + pay_to_type optional | Worker: `handleDocumentUpload` rejects 400 on Quote rows missing amount or pay_to_type. UI: `UploadDocumentCard` is a new client island with `useState` for `docType` and `payToType`, drives `required={isQuote}` on amount + pay_to_type. Receipt rows stay loose. | |
| 6 — vendor + vendor_address optional when pay_to=vendor | Worker: `handleDocumentUpload` + `handleDocumentEdit` reject 400 on Quote+vendor pay_to_type missing vendor (display name) or vendor_address. UI: `required={isVendorPayTo}` on vendor + vendor_address (in both UploadDocumentCard and DocumentEditDetails). | UI gates show conditional "(optional)" / no marker on labels based on docType + payToType. |
| 7 — edit-quote E394 + worker advance with incomplete data | Action side: `editDocumentAction` wrapped in try/catch as defensive cover; catch returns `{ ok: false, error }`. Worker side: covered by Bug 5/6 fix — Quote edit now rejects 400 when amount/pay_to_type are missing OR vendor/vendor_address missing on vendor pay_to_type, so any incomplete edit fails BEFORE an approval transition could pick it up. | E394 was almost certainly an uncaught throw inside the action body. Try/catch defends against future regressions in `damagePostForm`. |
| 8 — edit `<details>` stays open after save | Replaced inline server-rendered `<details>` + DocumentEditForm with new client island `DocumentEditDetails` that owns the open state via `useState`. ActionForm gains a new optional `onResult` prop (callback fires on every fresh result, stored in a ref so identity needn't be stable); DocumentEditDetails passes `onResult={(r) => { if (r.ok) setOpen(false); }}`. | Picked option 1 (controlled `<details>`) over option 2 (key-trick) — the key-trick required propagating the success state up through DocumentMutateRow, which is awkward. The ActionForm extension is small and reusable elsewhere. |

### Files created
- `apps/web/app/admin/damage/_components/UploadDocumentCard.tsx` — client island for the upload form (Bugs 4-6).
- `apps/web/app/admin/damage/_components/DocumentEditDetails.tsx` — client island wrapping the per-doc edit `<details>` reveal (Bugs 5, 6, 8).

### Files modified
- `apps/sysadmin-worker/src/index.ts` — `handleGrantTool` + `handleRevokeTool` return `changed` flag, write no-op audit rows.
- `apps/damage-worker/src/transitions.ts` — `clearApprovalDetails` field added to `ClaimTransitionDef`; 18 transitions flagged true.
- `apps/damage-worker/src/index.ts` — `handleStatusTransition` clears approval columns + audit stamps when flagged; activity-log note suffix; `handleDocumentUpload` + `handleDocumentEdit` Quote-row required-field rejects.
- `apps/web/app/admin/damage/_lib/transitions.ts` — UITransition mirrors `clearApprovalDetails`; 14 entries flagged.
- `apps/web/app/admin/damage/[id]/page.tsx` — TransitionForm no-quotes hint card; ApprovalDetails comment update; UploadDocumentCard + DocumentEditDetails imports replace inline definitions; DocumentMutateRow rewired.
- `apps/web/app/admin/damage/[id]/actions.ts` — `editDocumentAction` defensive try/catch.
- `apps/web/app/admin/_components/ActionForm.tsx` — optional `onResult` callback prop, ref-stashed.
- `apps/web/app/admin/sysadmin/actions.ts` — `grantToolAction` + `revokeToolAction` surface `changed` via `readChanged(body)` helper; success messages distinguish state change vs. no-op.
- `PRE_DEPLOY_SYSADMIN.md` — smoke-test wording for grant/revoke updated for `changed` shape + noop audit row.

### Decisions made on operator's behalf

1. **Worker response shape: rename `was_new`/`was_present` → `changed`** rather than retain both. The only consumer is the apps/web action which moves in lockstep, so backwards-compat shims would be dead code.
2. **No-op audit row uses distinct action names** (`grant_tool_noop` / `revoke_tool_noop`) instead of reusing the success action with a `notes` discriminator. Cleaner SQL filtering and unambiguous when scanning the log.
3. **clearApprovalDetails scope: 18 of 33 worker transitions flagged** — every "send back to GM/RM Review", every "send back to Pending Quotes", every Closed-→-pre-approval reopen, the two multi-step "Submit-for-Payment-→-RM-Quote-Approval" reverts, plus the "No Responsibility → Pending GM Review" rm-role reopen and "Pending RM Review → Pending GM Review" rm-role send-back (latter two are defensive — clearing is a no-op when columns are already null). Intra-workflow reverts (one-step backward where approval is still valid) intentionally NOT flagged.
4. **Activity log note: `[Reset approval details on revert]` suffix** appended to the operator's note (or used standalone when no note typed). Avoids a new activity_type and the D1 CHECK rebuild that would entail.
5. **Stamps reset bundled with approval-detail nulls** in a single UPDATE SET clause — atomic.
6. **ActionForm `onResult` callback** rather than per-call useActionState replication in DocumentEditDetails. Smaller surface, reusable.
7. **Edit form: required attrs enforce Quote shape on save**, not inheritance from existing row. Form pre-fills with defaultValue so unmodified saves succeed; explicit clears reject with a useful 400 inline.
8. **Defensive try/catch on editDocumentAction only.** Brief specifically called out E394 on edit. Pattern is now established if the same symptom appears elsewhere.
9. **dcRole transition filter on damage detail page stays dropped** (Brief 18 condition). DcRoleDebugLine + diagnostic logging stay. Cleanup brief, not Brief 20.
10. **Bug 4 hint card replaces the entire form row**, not just the disabled state. Eliminates "why is this greyed out" confusion entirely.
11. **CLAUDE.md no-op-detection subsection deferred.** Sysadmin's grant/revoke is currently the only instance; codifying without a second reference instance feels premature.

### Latent issues / forward flags

- **Receipt-row Quote-shape validation gap.** Worker now strictly enforces Quote required fields; Receipts stay loose. Per brief, intentional — Receipts don't drive the check-request PDF — but a Receipt with vendor pay-to and no vendor_address is silently allowed. Cleanup candidate if Receipts ever start driving downstream flows.
- **Edit form `vendor` field on a Quote-customer row is no longer marked required by the UI**, and remains optional on the worker. If pay-to is `customer`, vendor is informational only.
- **`<details>` open state via React** vs. native HTML — switching to controlled means open/close goes through React state. Some browsers animate `<details>` natively; controlled may lose the micro-animation. Acceptable trade-off.
- **`clearApprovalDetails` flag on UI side has no rendering today** — the UITransition mirror carries the flag for code-review parity and so a future "This action will reset approval details" hint can be added without another sync round.
- **`PRE_DEPLOY_DAMAGE.md` is unchanged** — no smoke-test step references the changed worker behavior at the response-body level. Quote required-field validation surfaces as 400 on the existing tests. Worth a flag if the operator runs the full PRE_DEPLOY tests.
- **Brief 18 cleanup brief grows by one item:** Brief 20 closes Bug 7's edit-quote E394, but the dcRole transition filter drop, DcRoleDebugLine, and `[damage-action]` diagnostic logging are still pending. Recipe unchanged: confirm dcRole populates → restore filter → remove DcRoleDebugLine → remove logActionEntry/logActionResult.
- **Activity log note suffix renders on the timeline as appended text after the operator's note.** Functionally correct; visually it looks like part of the operator's text. A future polish brief could italicize or separate the system-appended portion.

### Validation

- `pnpm typecheck`: **13/13 successful, 4.207s** (10 cached + apps/web, damage-worker, sysadmin-worker fresh after source changes).
- `pnpm --filter @splash/web build`: **succeeded** — Next 15.5.15 compiled in 4.3s, 12/12 static pages generated.
- Bundle deltas:
  - `/admin/damage/[id]`: 1.33 kB → **3.08 kB** / 106 kB → **108 kB** (+1.75 kB route, +2 kB First Load — UploadDocumentCard + DocumentEditDetails are now client islands; DocumentEditDetails is reused per-tile so its budget is bounded regardless of doc count).
  - `/admin/sysadmin`: 2.27 kB → **2.31 kB** / 107 kB → **107 kB** (+40 B route, 0 First Load — `readChanged` helper alone).
  - All other route bundles unchanged from Brief 19 snapshot.

### Transition table audit (clearApprovalDetails)

Worker (`apps/damage-worker/src/transitions.ts`) — 18 entries flagged true:

| from | to | role | flagged |
|---|---|---|---|
| No Responsibility — Pending Review | Pending GM Review | rm | ✓ |
| Pending RM Review | Pending GM Review | rm | ✓ |
| Approved — Pending Quotes | Pending GM Review | admin | ✓ |
| Approved — Pending Quotes | Pending RM Review | admin | ✓ |
| Pending RM Quote Approval | Pending GM Review | admin | ✓ |
| Pending RM Quote Approval | Approved — Pending Quotes | admin | ✓ |
| Approved — In House — Parts Ordered | Pending GM Review | admin | ✓ |
| Approved — In House — Repaired | Approved — In House — Parts Ordered | admin |  (intra-workflow) |
| Approved — Check Request Submitted | Pending RM Quote Approval | admin | ✓ |
| Approved — Submitted for Payment | Approved — Check Request Submitted | admin |  (intra) |
| Approved — Submitted for Payment | Pending RM Quote Approval | admin | ✓ |
| Approved — Check Issued | Approved — Check Request Submitted | admin |  (intra) |
| Closed — Paid | Pending GM Review | admin | ✓ |
| Closed — Paid | Pending RM Review | admin | ✓ |
| Closed — Denied | Pending GM Review | admin | ✓ |
| Closed — Denied | Pending RM Review | admin | ✓ |
| Closed — Approved/No Response | Pending RM Quote Approval | admin | ✓ |
| Closed — Approved/No Response | Approved — Check Request Submitted | admin |  (re-energize for payment) |

apps/web mirror table flags the same set minus the obvious intra-workflow steps; verified by code-review diff.
