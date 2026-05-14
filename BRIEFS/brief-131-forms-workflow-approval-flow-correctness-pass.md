# Brief 131: Workflow + approval flow correctness pass (picker mis-mapping, loading states, signature canvas, navigation, status auto-update, label polish, Quick Patterns)

**Status:** Completed (2026-05-14)
**Started:** 2026-05-14
**Completed:** 2026-05-14
**Blocks:** Neither — but blocks operator adoption. Multiple
correctness AND UX gaps surfaced during testing of Brief 125/127's
workflow + email infrastructure: the builder's approver/recipient
picker writes the wrong `approver_source` shape, the
auto-detected lookup is keyed by `field.id` instead of `field.key`
so the resolver can't find the payload value, signature input is
literal dev-placeholder text asking the operator to "paste an
existing r2_key," nav from approval-detail back to the queue
requires 5+ clicks, page navigation feels unresponsive (Review
button takes 5-10s with zero feedback), terminal-stage transitions
don't auto-update the submission's `status` column, and the
All Approvals admin view filters out the exact rows an admin would
need to debug a stuck workflow.
**Dependencies:** Brief 120 (workflow schema + resolver), Brief 121
(Pending Approvals page), Brief 125 (workflow builder + auto-
detect picker), Brief 127 (outbound_emails + email-step cascade),
Brief 92 (public form's signature canvas wiring — reused here).
The Brief 130 `<SubmitButton>` component is reused for transition
action pending states.

## Read first

- CLAUDE.md (`forms-worker` glossary — Brief 120 / 121 / 125 / 127
  entries)
- BRIEFS/brief-125-forms-workflow-builder-ux-redesign.md (the
  builder's approver/recipient picker that this brief fixes)
- BRIEFS/brief-127-outbound-email-queue-and-workflow-email-steps.md
  (email step cascade + recipients resolution)
- apps/forms-worker/src/workflow-resolution.ts (`resolveApproverEmails`
  + `extractLocationCode` — payload_field branch; the resolver this
  brief depends on being correct)
- apps/forms-worker/src/admin/submissions.ts (transition handler —
  email step cascade + new status-auto-update logic added here)
- apps/web/app/admin/forms/[id]/_workflow/* (Brief 125 builder
  — picker save logic gets the fix; email step card gets the
  label polish)
- apps/web/app/admin/forms/[id]/submissions/[subId]/page.tsx +
  WorkflowSection.tsx (approval detail page — signature canvas
  + back-to-approvals nav + transition SubmitButton)
- apps/web/app/admin/approvals/page.tsx (Brief 121 page — append
  ?from=approvals to Review links)
- apps/forms-worker/static/forms-public.js (Brief 92 — signature
  canvas wiring this brief clones into the admin modal)
- packages/ui (`signature_pad` library — already a workspace dep
  per Brief 92)
- apps/web/app/admin/_components/SubmitButton.tsx (Brief 130 —
  pending-state submit button this brief uses on transition
  actions)

## Context

Real-world testing surfaced a chain of bugs that together make the
workflow + approval flow effectively unusable today:

1. **Builder picker writes the wrong schema shape.** When the
   operator picks "Regional Manager email (resolved via Site
   Number lookup)" from the approver/recipient picker, the schema
   gets saved as `{type: "site_role", role: "rm_email"}` instead
   of `{type: "payload_field", field_key: <lookup payload key>}`.
   This forces the resolver to look for a `location` field on the
   form (which doesn't exist) and return empty.

2. **Even when manually patched to payload_field, the wrong
   identifier is used.** The builder (and the SQL hotfix we ran)
   uses the field's `id` (e.g., `UAF3V6jv`) but the payload is
   keyed by the field's `key` (e.g., `lookup_mvkcnf`). The
   resolver does `payload[source.field_key]` and gets undefined.
   Need to confirm and standardize: whatever value lives in the
   payload as the key is what `field_key` must reference.

3. **Pending Approvals page** ("Mine" + "All Approvals") filters
   by `current_approver_emails CONTAINS caller_email` — both
   correct, but when (1)+(2) cause `current_approver_emails` to be
   empty, the row never appears. The "All Approvals" view should
   widen to also show in-flight rows with empty approvers (as a
   diagnostic surface — admin sees "No approver resolved" pill and
   can investigate).

4. **No loading feedback on Review click.** The
   `/admin/forms/[id]/submissions/[subId]` page does SSR fetches
   (submission + form + version + schema + workflow + R2 fetches
   for signatures). Total cold load is ~5-10s in practice. Page
   sits unresponsive until the entire HTML returns. Next.js's
   `loading.tsx` convention solves this — a skeleton page renders
   immediately during navigation, then the real page swaps in.

5. **Transition actions feel slow.** Approve/Deny clicks take
   ~15s while the worker round-trips, runs the email step cascade,
   stamps workflow_history, etc. The button has no visible state
   change — operator wonders if it was clicked. The Brief 130
   `<SubmitButton>` component already exists; it just needs to
   replace the bare buttons on the WorkflowSection's transition
   forms.

6. **Signature canvas is dev placeholder text.** The current admin
   transition modal shows a literal text input labeled "SIGNATURE
   R2 KEY (REQUIRED)" with the placeholder "form-submission-
   files/.../signature.png" and the helper text "FULL SIGNATURE
   CANVAS WIRING IS A BRIEF (?) FOLLOW-UP; FOR V1 PASTE AN
   EXISTING R2_KEY." That's an unfinished implementation that
   shipped to production. The public form path already has a
   working `signature_pad` canvas wired via `forms-public.js`
   (Brief 92). Clone the wiring into the admin modal.

7. **Navigation from approval detail back to queue is hostile.**
   No "Back to Pending Approvals" link on the per-submission
   detail page. Operator has to navigate via top-nav: Dashboard →
   Operations → Pending Approvals — five clicks to deal with the
   next item. Simple fix: when navigated FROM the approvals
   queue, render a `← Back to Pending Approvals` link.

8. **Terminal stage doesn't auto-update status.** When workflow
   reaches an outcome (kind: "outcome"), the submission's
   `status` column (Brief 96 — new/in_progress/closed enum) stays
   at `new`. Operator has to manually edit Status from the
   "Status & Splash Notes" card. Auto-setting `status = 'closed'`
   on terminal transition matches operator expectation and
   removes a redundant manual step.

9. **Approval result not surfaced on per-form submissions
   list.** From `/admin/forms/[id]/submissions`, operator must
   click into each row to see if it was approved/denied. The
   Brief 96 list already has a Status column; add a Workflow
   Outcome column (or fold into Status — option B from operator
   discussion).

10. **Label polish from operator's testing notes.** Several copy
    fixes:
    - Email step "Who approves this step?" → "Send email to"
    - Email step "Pick an approver" placeholder → "Pick a
      recipient"
    - "Use placeholders like {field.label} or {field.key}" → "Use
      dynamic fields"
    - Step label edit affordance needs to be visually obvious
      (placeholder text, hover state, the input doesn't read as
      editable today)
    - Default email step labels: instead of "Email" + "Email
      step 2", derive from destination outcome ("Approval
      email" / "Denial email") for operator scan-ability.

11. **Quick Patterns "Approve + Deny email" template.** One-click
    that wires the common pattern: approval step's Approve action
    → new email step (recipient = submitter, body = approved
    template, attach_pdf = true) → Outcome Approved; Deny action
    → new email step (recipient = submitter, body = denied
    template, attach_pdf = false) → Outcome Denied. Brief 127
    spec'd Quick Patterns; the executor either didn't wire this
    one or wired it differently.

12. **Inline "+ Create and route to new email step" in Then-go-to
    dropdowns.** Eliminates the construction-order awkwardness
    operator surfaced (create email step downstream first, then
    go back to wire upstream).

## Scope

### Phase 1 — Diagnostic: confirm payload-key vs field-id

Before fixing the builder, confirm empirically what the payload
uses. The operator's manual SQL update worked with `lookup_mvkcnf`
(the field's `key`), not `UAF3V6jv` (the field's `id`). So payload
keys ARE `field.key`, not `field.id`. But verify:

1. Read one submission's payload + the form version's `fields[]`
   array. Compare the payload object's keys against
   `fields[i].id` vs `fields[i].key`.
2. Confirm the convention applies uniformly (all field types use
   the same key strategy).
3. Document the finding in the brief outcome.

Once confirmed, the builder + SQL fixes use the correct
identifier consistently.

### Phase 2 — Builder picker: save payload_field correctly

In `apps/web/app/admin/forms/[id]/_workflow/` (the approver +
recipient pickers from Brief 125), when the operator picks an
auto-detected lookup option ("X email (resolved via Y lookup)"):

- The saved schema must be `{type: "payload_field", field_key:
  <the lookup field's payload key>}`, NOT `{type: "site_role",
  role: "rm_email"}`.
- Same fix applies to email step `recipients[]` array entries.
- `site_role` should ONLY be saved when the operator picks an
  option backed by a `location` field type (or a lookup keyed
  on `pricing_simple.location_code` — those resolve through
  `getLocationContactInfo` correctly).

Audit the picker's `onChange` handler to ensure the right
`approver_source` shape is dispatched to the reducer based on
which option the operator picks.

### Phase 3 — Worker resolver hardening

In `apps/forms-worker/src/workflow-resolution.ts`:

- Confirm `resolveApproverEmails` for `payload_field` reads
  `ctx.payload[source.field_key]` — should match Phase 1's
  finding.
- Add a defensive log when `payload_field` resolution returns
  empty: `[forms.workflow.resolve] payload_field "{field_key}"
  resolved to empty / non-email value` so future debug is
  faster.

### Phase 4 — Status auto-update on terminal stage

In `apps/forms-worker/src/admin/submissions.ts` (transition
handler), after the transition succeeds and the destination is a
terminal outcome (`stage.kind === "outcome"` OR predicate-derived
terminal), update `form_submissions.status = 'closed'` IFF the
current status is `'new'` OR `'in_progress'` (don't override an
admin who's already set `closed`). Stamp
`status_updated_at = now()` + `status_updated_by =
'system@workflow'`.

Brief 96's status enum stays as is (`new`/`in_progress`/`closed`).

### Phase 5 — Loading state on Review click + transitions

5a. Add `apps/web/app/admin/forms/[id]/submissions/[subId]/loading.tsx`.
Renders a skeleton mimicking the real page's layout (header bar,
metadata grid placeholder, workflow section placeholder, payload
section placeholder). Next.js serves this immediately on click,
then swaps to real content when the SSR fetches complete.

5b. Replace every bare `<button type="submit">` inside
`WorkflowSection.tsx` (transition actions) with `<SubmitButton>`
from `apps/web/app/admin/_components/SubmitButton.tsx`. Pass
contextual `pendingText` per action label ("Approving…",
"Denying…", "Sending back…", etc. — derive from the action's
label).

5c. Same SubmitButton swap on the Status & Splash Notes Save
button (`pendingText="Saving…"`).

### Phase 6 — Inline signature canvas

Replace the literal-text r2_key paste input on the WorkflowSection
transition modal with a real `<canvas>`-backed signature pad.

- Clone the wiring from `apps/forms-worker/static/forms-public.js`
  (Brief 92's `wireSignature` function). The library
  (`signature_pad`) is already bundled.
- Component: `apps/web/app/admin/forms/[id]/submissions/[subId]/_components/SignatureCanvas.tsx`
  (client component, ~150-200px tall canvas with Clear button +
  Confirm button).
- On Confirm: POST the PNG blob to a new admin upload endpoint
  `POST /forms/admin/api/transition-signatures/{submission_id}`
  on splash-forms — admin-tier gated, stores to R2 at
  `transition-signatures/{submission_id}/{nanoid}.png`, returns
  `{r2_key}`. The hidden form input `signature_r2_key` gets
  populated with the returned key; the form submit then proceeds
  normally.
- Drop the helper text "FULL SIGNATURE CANVAS WIRING IS A BRIEF
  (?) FOLLOW-UP" and the r2_key paste input entirely.

### Phase 7 — Back-to-Approvals navigation

7a. Brief 121's `/admin/approvals/page.tsx` — append
`?from=approvals` to every Review button's `href`.

7b. Per-submission detail page (`/admin/forms/[id]/submissions/[subId]/page.tsx`):
when `searchParams.from === "approvals"`, render a `← Back to
Pending Approvals` link at the top of the page (replacing or
augmenting the existing breadcrumb back-to-submissions link).
Link target: `/admin/approvals`.

### Phase 8 — Surface outcome on per-form submissions list

In `apps/web/app/admin/forms/[id]/submissions/page.tsx` (Brief 96),
add a "Workflow" column (or extend the existing Status column —
operator confirmed Option A from Q2). Per row:

- No workflow on this submission → blank cell.
- Workflow in flight (current stage is non-terminal) → muted pill
  showing the stage label ("Approval", "GM Review", etc.).
- Workflow at terminal outcome → tinted pill matching the
  outcome's tint (success for Approved, danger for Denied, etc.)
  + label.

This eliminates the need to drill into detail to see if a
submission was approved/denied.

### Phase 9 — All Approvals widening (admin diagnostic surface)

In Brief 121's pending-approvals endpoint
(`apps/forms-worker/src/admin/pending-approvals.ts`):

- The `?all=1` query (admin-tier) should NOT filter by
  `current_approver_emails != '{}'`. It should return any row
  where `workflow_stage` is non-null AND the current stage's
  `approver_source` is set (i.e., the row IS expecting an
  approver, regardless of whether resolution succeeded).
- Each row in the response carries a new field
  `approver_resolution_status: "resolved" | "empty"`. When
  empty, the apps/web page renders a "No approver resolved"
  warning pill on the row.

Brief 121 page (`/admin/approvals`) — when "All Approvals" toggle
is active, show the warning pill on rows where
`approver_resolution_status === "empty"` so admins can spot stuck
workflows.

### Phase 10 — Builder label polish

In the email step card UI (Brief 127):
- "Who approves this step?" → "Send email to"
- "Pick an approver" placeholder → "Pick a recipient"
- "Use placeholders like {field.label} or {field.key}" → "Use
  dynamic fields" (the example pills below stay; just the header
  changes)
- The step label input (the "Email" / "Email step 2" text next
  to the EMAIL badge) gains a placeholder hint and a visible
  hover-edit affordance so operators recognize it's editable.
- Default new email step labels derived from destination
  outcome's label when set (e.g., "Approval email", "Denial
  email") instead of generic "Email" + auto-incrementing.

### Phase 11 — Inline "+ Create new email step" in Then-go-to dropdowns

In the approval step's action card's "Then go to" dropdown
(`apps/web/app/admin/forms/[id]/_workflow/ActionCard.tsx` or
equivalent):

- End the dropdown's options list with `+ Create new email step
  here` (after the existing Outcome and Step options).
- Picking it: dispatches a new reducer action
  `add_email_step_routed_from(actionId)` that:
  1. Creates a new email step with sensible defaults (recipient
     auto-detected if possible, subject + body from default
     template, attach_pdf based on Quick Patterns convention).
  2. Sets the approval action's `then_go_to` to the new email
     step's id.
  3. Sets the new email step's `then_go_to` to the first available
     outcome (likely "Approved" or "Denied" based on the action's
     keyword).
  4. Scrolls the new email step into view + focuses its label
     input.
- One click vs the current 3-step shuffle.

### Phase 12 — Quick Patterns "Approve + Deny email" template

In the Workflow tab's Quick Patterns popover (Brief 127):

- New template: **"Email submitter on approve + deny"**
- One-click action:
  1. Adds two email steps to the workflow if not present:
     - Approval email: recipient = `{submitter.email}`, subject =
       `"Your {form.title} submission was approved"`, body =
       sensible default, `attach_pdf: true`, `then_go_to:
       approved`.
     - Denial email: recipient = `{submitter.email}`, subject =
       `"Your {form.title} submission was denied"`, body =
       sensible default, `attach_pdf: false`, `then_go_to:
       denied`.
  2. Re-routes the approval step's Approve action → Approval
     email step, Deny action → Denial email step.
  3. Operator confirms / edits / publishes.

### Phase 13 — Validation

13.1 `pnpm typecheck` — must pass.
13.2 `pnpm --filter @splash/web build` — must succeed.
13.3 `pnpm --filter @splash/forms-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed.
13.4 No Supabase / R2 / wrangler.toml / secret changes.
13.5 Operator post-deploy smoke (deferred):
    - Open a form's Workflow tab. Add an approval step. Pick
      "RM email (via X lookup)" from the picker. Save + publish.
      Inspect the workflow JSON in Supabase: `approver_source`
      MUST be `{type: "payload_field", field_key: <lookup.key>}`.
    - Submit the form. Inspect `form_submissions` — `workflow_stage
      = "approval"`, `current_approver_emails = ['<rm email>']`,
      `workflow_history = []`.
    - Open `/admin/approvals` → row appears under "Mine". Click
      Review → URL has `?from=approvals` → page renders with a
      "← Back to Pending Approvals" link at the top.
    - Review page loads with a visible skeleton during nav (NOT
      a 5-second blank wait).
    - Click Approve → SubmitButton disables + shows "Approving…"
      with spinner.
    - On success: workflow transitions to email step → cascade
      enqueues an `outbound_emails` row → advances to Outcome:
      Approved. `form_submissions.status` auto-updates to
      `closed`.
    - Open `/admin/forms/[id]/submissions` → row shows the
      Workflow Outcome column with a "Approved" tinted pill.
    - Submit a second form. Use the workflow's
      "Pick a recipient" with "Specific person" → autosuggest
      surfaces auth_unified rows. Pick yourself.
    - On transition modal: signature canvas renders as a real
      `<canvas>`. Sign with mouse. Click Confirm → uploads to R2
      → form submits.
    - Toggle to "All Approvals" on `/admin/approvals` →
      previously stuck rows (with empty current_approver_emails)
      now appear with a "No approver resolved" warning pill.

### Phase 14 — Updates

14.1 BRIEFS/INDEX.md: Brief 131 row appended.

14.2 BUILD_STATE.md: Findings entry noting:
  - Brief 131 (YYYY-MM-DD) — workflow + approval flow
    correctness pass: fixed builder picker to write
    `payload_field` (with the correct payload-key identifier,
    not field.id) when auto-detecting lookups; signature canvas
    inline replacing dev-placeholder r2_key input; loading state
    on detail page nav; `<SubmitButton>` on transition actions;
    `← Back to Pending Approvals` nav when arrived from queue;
    status auto-update on terminal; Workflow Outcome column on
    per-form submissions list; All Approvals widening with
    "No approver resolved" warning pill; email-step label polish
    + inline "+ Create email step" in Then-go-to + new "Email
    submitter on approve + deny" Quick Pattern.

14.3 CLAUDE.md `forms-worker` glossary — extend the Brief 125 /
127 paragraph with a Brief 131 follow-up noting the picker fix
and the payload-key-vs-field-id clarification.

## Out of scope

- Refactoring the workflow schema itself (stages / transitions /
  approver_source / current_approver_emails). Pure UI + worker
  resolver + transition handler changes.
- Adding a transition undo / rollback affordance. v2.
- Inbox-style prev/next within the approvals queue (operator
  picked "simple now" — back link only). Future brief if the
  workflow volume justifies it.
- Bulk approve / deny across multiple submissions. v2.
- Signature input on the public form (already works per Brief
  92 — only the ADMIN modal is broken).
- Migrating any other webhooks to outbound_emails (Brief 32 / 101
  / 102 / 105 etc. stay where they are per the rule established
  in Brief 127).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- Builder picker saves `payload_field` (with correct payload-key
  identifier) when auto-detecting lookups, NOT `site_role`.
- Worker resolver logs `[forms.workflow.resolve] empty` on
  payload_field misses for future debug.
- Status auto-updates to `closed` on terminal-stage transition
  (when current status is new/in_progress).
- `loading.tsx` skeleton at submissions/[subId] route.
- `<SubmitButton>` on every transition action button + Status &
  Splash Notes Save button.
- Inline signature canvas replaces the r2_key paste input on the
  admin transition modal. Upload endpoint at
  `/forms/admin/api/transition-signatures/{submission_id}` works.
- `/admin/approvals` Review buttons append `?from=approvals`.
  Detail page renders `← Back to Pending Approvals` link when
  the param is set.
- Per-form submissions list (Brief 96) shows a Workflow Outcome
  column for workflow-enabled submissions.
- All Approvals view widens to show in-flight rows even when
  `current_approver_emails` is empty; warning pill rendered for
  unresolved-approver rows.
- Email step labeling polish landed (copy fixes + visible
  editable affordance + smart default labels).
- Inline "+ Create new email step" option in approval action's
  Then-go-to dropdown.
- Quick Patterns "Email submitter on approve + deny" template
  works.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 14.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate (apps/web + forms-worker + signature wiring).
- Validation results.
- The empirical answer to Phase 1's diagnostic — does payload
  use `field.id` or `field.key`? Confirm.
- Any places in the codebase that ALSO use the wrong identifier
  (e.g., other helpers that touch `payload[field.id]` vs
  `payload[field.key]`) — flag for fast-follow.
- Bundle size impact on the admin detail route (signature
  canvas client component).
- Generation time / size of the upload endpoint's R2 writes.

## Outcome

Completed 2026-05-14 by Claude Code in one pass.

### Phase 1 — Diagnostic result

**Payload keys are `field.key`, not `field.id`.** Three independent
sites in agreement:

- Submit handler — `apps/forms-worker/src/submit/parse.ts:53`:
  `payload[field.key] = { r2_key }` (and similar across all field
  types).
- Workflow resolver — `apps/forms-worker/src/workflow-resolution.ts:98`
  (`extractLocationCode`): `ctx.payload[f.key]`.
- Pending approvals — `apps/forms-worker/src/admin/pending-approvals.ts:203`:
  `payload[f.key]`.

Operator's earlier SQL hotfix using `lookup_mvkcnf` (the field's
`key`) was the correct shape; `UAF3V6jv` (the field's `id`) would
have failed for the same reason the picker save was failing — payload
isn't keyed on that. The fix applied throughout this brief uses
`field.key` consistently.

### Files created

- `apps/forms-worker/src/admin/transition-signatures.ts` — admin
  transition-signature upload endpoint (admin-tier gated, R2 at
  `transition-signatures/{submissionId}/{nanoid}.png`).
- `apps/web/app/admin/forms/[id]/submissions/[subId]/loading.tsx` —
  Next.js skeleton boundary for the per-submission detail page.
- `apps/web/app/admin/forms/[id]/submissions/[subId]/_components/SignatureCanvas.tsx` —
  inline canvas signature pad replacing Brief 120's r2_key paste
  input. Loads vendored `signature_pad.min.js` via `<Script>` at
  runtime.
- `apps/web/app/admin/forms/[id]/submissions/_components/WorkflowOutcomeCell.tsx` —
  per-row workflow stage / outcome pill renderer (3-state: no
  workflow / in flight / terminal outcome with tint).

### Files modified

Forms-worker:

- `apps/forms-worker/src/index.ts` — mount new
  `POST /forms/admin/api/transition-signatures/{submission_id}` +
  header comment.
- `apps/forms-worker/src/workflow-resolution.ts` — defensive
  `console.warn` on empty `payload_field` resolution.
- `apps/forms-worker/src/admin/submissions.ts` — auto-flip
  `form_submissions.status = 'closed'` on terminal-outcome
  transition (when current status is `new`/`in_progress`); imports
  `workflowStageIsOutcome` from `notifications.ts`.
- `apps/forms-worker/src/admin/pending-approvals.ts` — `?all=1`
  drops the `current_approver_emails != '{}'` filter; per-row
  `approver_resolution_status` field; skip rows whose current stage
  has no `approver_source`.
- `apps/forms-worker/src/db/admin-submissions.ts` —
  `SubmissionListItem.workflow_stage`, both DB row shapes' select
  list widened to include `workflow_stage`; `TransitionPatch` gains
  optional status columns; PATCH body conditionally writes them.

apps/web:

- `apps/web/app/admin/forms/_lib/worker-fetch.ts` —
  `SubmissionListItem.workflow_stage`,
  `PendingApprovalItem.approver_resolution_status`.
- `apps/web/app/admin/forms/[id]/_workflow/ApproverPicker.tsx` —
  `pickOption` fix (lookup_role → payload_field), `sourceToAutoKey`
  round-trips both shapes, new `mode: "approver" | "recipient"`
  prop, local `mode` variable renamed `selectMode`.
- `apps/web/app/admin/forms/[id]/_workflow/EmailStepCard.tsx` —
  copy fixes ("Use dynamic fields", step-label affordance), inner
  pickers get `mode="recipient"`.
- `apps/web/app/admin/forms/[id]/_workflow/StepCard.tsx` — new
  `onCreateAndRouteToEmailStep` prop on every ActionSubCard, sentinel
  `<option>` `+ Create new email step here` in Then-go-to dropdowns.
- `apps/web/app/admin/forms/[id]/_workflow/WorkflowTab.tsx` —
  `WorkflowTabDispatch.onCreateAndRouteToEmailStep`, passed through
  to StepCard.
- `apps/web/app/admin/forms/[id]/_workflow/QuickPatternsPopover.tsx` —
  new `email_submitter_on_approve_and_deny` template.
- `apps/web/app/admin/forms/[id]/_builder/BuilderClient.tsx` —
  `onCreateAndRouteToEmailStep` dispatch.
- `apps/web/app/admin/forms/[id]/_builder/reducer.ts` — new
  `workflow_add_email_step_from_action` action + reducer case; new
  `email_submitter_on_approve_and_deny` QuickPattern case.
- `apps/web/app/admin/forms/[id]/submissions/[subId]/page.tsx` —
  `searchParams.from === "approvals"` → back link, `submissionId`
  prop on WorkflowSection, SubmitButton on Status & Splash Notes
  Save.
- `apps/web/app/admin/forms/[id]/submissions/[subId]/_components/WorkflowSection.tsx` —
  inline `<SignatureCanvas>` replaces r2_key paste input,
  `<SubmitButton>` with contextual `pendingText` on transition
  modal.
- `apps/web/app/admin/forms/[id]/submissions/page.tsx` — Workflow
  column on both wide + compact tables.
- `apps/web/app/admin/approvals/page.tsx` — Review links append
  `?from=approvals`, `UnresolvedApproverPill` on empty rows.

Docs:

- `BRIEFS/INDEX.md` — Brief 131 row.
- `BUILD_STATE.md` — Last-updated bump + Findings row.
- `CLAUDE.md` — `forms-worker` glossary Brief 131 follow-up paragraph
  (under the Brief 129 paragraph + above the `outbound_emails table`
  entry).

### Decisions made on operator's behalf

1. `lookup_role` picks save as `payload_field` keyed on the LOOKUP
   field's `key` (matches Phase 1 diagnostic; removes the broken
   `extractLocationCode` round-trip).
2. `location_role` picks stay `site_role` (resolver finds
   `location_code` via `getLocationContactInfo`).
3. Status auto-update only flips `new`/`in_progress` → `closed`; an
   admin who already curated status isn't overridden.
4. `status_updated_by = "system@workflow"` (string marker; column is
   text).
5. Signature canvas R2 path bucketed at
   `transition-signatures/{submissionId}/` (separate namespace from
   public-form `form-submission-files/`).
6. Signature upload endpoint admin-tier gated (matches the page-gate
   context the modal renders from — RM/GM approvers can't reach the
   page UI today anyway).
7. Loading skeleton mimics the real page section layout (header +
   status + workflow + payload + metadata) rather than a generic
   shimmer.
8. Workflow column tint uses `stage.tint` first, keyword heuristic
   second (`/\bapprov/` → success, `/\bden|\breject|\bdecline/` →
   danger).
9. "⚠ No approver resolved" copy avoids schema vocabulary
   (`approver_source` / `payload_field`).
10. "+ Create new email step here" sentinel appended below all
    Outcomes + Steps in the dropdown.
11. Quick Pattern keys off each approval step independently — multiple
    approval steps each get both email steps inserted.
12. Approval email defaults `attach_pdf: true`; denial email defaults
    `attach_pdf: false`.

### Latent issues / forward flags

(a) Per-submission detail page is admin-tier gated on apps/web while
Brief 120's transition handler accepts any approver — RM/GM approvers
can hit the worker endpoint via curl but can't reach the apps/web
page UI today. Widening the page gate is a follow-up brief.

(b) "Email step label derived from destination outcome" (Phase 10
default-labels spec) only fires through the Phase 11
`workflow_add_email_step_from_action` reducer; the standalone
"+ Add step → Email" button keeps the generic labels because there's
no destination at creation time.

(c) Quick Pattern keyword matching against action labels
(`approve|accept|ok|yes|confirm` / `deny|reject|decline`) is
case-insensitive substring — non-English or unusual action labels
won't match and the pattern no-ops for that approval step.

(d) Status auto-update writes `system@workflow` as the audit actor
string — multi-language workflows or per-workflow auditors would need
a future enum widening.

(e) Signature canvas in `next dev` mode won't load the vendored
`signature_pad.min.js` from the forms-worker because dev URLs are
cross-origin and there's no rewrite for `/forms/api/static/*` in
`next.config.mjs`. Operator testing for the canvas defers to staging
or prod per the brief.

(f) Compact view's Workflow column shows stage_id only when the
schema isn't included in the row's response (no `include=payload`);
wide view gets the full pretty pill because `version.schema` is
embedded. A future widening of the metadata-only response shape to
include just the workflow definition (id / label / kind / tint per
stage) would unblock the pretty pill in compact too.

### Bundle size impact

- `/admin/forms/[id]` builder route: 37.7 kB / 145 kB First-Load JS
  (+0.9 kB vs Brief 129 baseline of 36.8 kB) — Quick Pattern +
  routed-from-action reducer additions + ApproverPicker `mode` prop
  + minor copy changes.
- `/admin/forms/[id]/submissions/[subId]` detail route: 5.59 kB /
  113 kB First-Load JS (+~1 kB) — SignatureCanvas client island +
  `<Script>` boilerplate.
- `/admin/approvals`: 193 B / 107 kB unchanged.
- forms-worker bundle: 2012.50 KiB raw / 442.32 KiB gzipped
  (≈ +3 KiB raw / +1 KiB gzip vs Brief 129 baseline of 2008.90 /
  441.54) — transition-signature handler + resolver console.warn +
  status auto-update.

### Other places using `field.id` vs `field.key` (Phase 1 audit)

Searched for `payload\[.*\.id\]` and `payload\[.*\.key\]` across the
worker tree. All identified payload-read sites correctly use
`field.key`. The only remaining `field.id` consumers are React-side
key attributes (e.g., `_field-types/*.tsx` render loops keying on
`f.id` for React's element-tracking purposes — that's the correct
identifier for React rendering and unrelated to payload keys).

### Validation results

- Root `pnpm typecheck`: 18/18 green. forms-worker + web ran fresh,
  rest cached. (Initial run flagged two TS2367 errors on lingering
  `mode === SPECIFIC_KEY` references in ApproverPicker that were
  shadowing the new `mode` prop after the rename to `selectMode` —
  fixed; re-run green.)
- `pnpm --filter @splash/web build`: succeeds. Bundle sizes per
  above. All 35 routes compile.
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build`: succeeds. Bundle 2012.50 KiB raw / 442.32
  KiB gzipped.

No Supabase / R2 / wrangler.toml / secret changes.

### Operator post-deploy smoke (deferred per Phase 13.5)

See brief Phase 13.5 for the full E2E sequence. Recap: pick "RM email
(via X lookup)" → save+publish → inspect schema (`approver_source:
{type: "payload_field", field_key: "<lookup.key>"}`); submit form →
`current_approver_emails = ["<rm email>"]`; visit /admin/approvals →
row appears; click Review → URL has `?from=approvals`, "← Back to
Pending Approvals" link present, skeleton during nav; click Approve
→ "Approving…" pending state; cascade enqueues email, advances to
Approved outcome, auto-flips `status = 'closed'`; per-form
submissions list shows "Approved" tinted pill in Workflow column;
toggle to All Approvals → previously stuck rows appear with "No
approver resolved" pill; transition with `requires.signature` →
canvas renders, sign with mouse, Confirm uploads to R2, form
submits.
