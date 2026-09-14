# Brief 125: Forms workflow builder UX redesign + outcome notification webhook wiring

**Status:** Completed (2026-05-14)
**Started:** 2026-05-14
**Completed:** 2026-05-14
**Blocks:** Neither — but blocks operator adoption of the workflow
feature. The Brief 120 + 123 builder is functionally complete but
fights the operator's mental model at every step. This brief replaces
the Inspector-panel WorkflowEditor with a top-level Workflow tab and
reframes every operator-facing label from schema language (stages /
transitions / approver_source / payload_field / site_role) to user
language (steps / actions / approvers / outcomes).
**Dependencies:** Brief 120 (workflow schema + transition machinery;
this brief keeps the schema intact, only the UI changes). Brief 121
(pending-approvals endpoint; the new outcome webhook is the
fast-follow complement). Brief 123 (focus-loss fix + Mermaid preview;
this brief widens the preview's scope but reuses the loader). Brief
95 (form builder structure — this brief introduces the tab layer
above it).

## Read first

- CLAUDE.md (`forms-worker` glossary — Brief 120 / 121 / 123 entries)
- BRIEFS/brief-120-forms-workflow-schema-and-transitions.md
  (data model — NOT changing in this brief)
- BRIEFS/brief-121-forms-pending-approvals-dashboard-and-digest.md
  (digest webhook pattern — the outcome webhook mirrors it)
- BRIEFS/brief-123-forms-workflow-builder-ux-fixes.md
  (Mermaid preview + focus fix; reuse the lazy-load wiring)
- apps/web/app/admin/forms/[id]/page.tsx + _builder/* (the existing
  builder — this brief restructures it under a tab layer)
- apps/web/app/admin/forms/[id]/_builder/WorkflowEditor.tsx +
  ApproverSourceEditor + WorkflowMermaidPreview (the components
  being replaced)
- apps/web/app/admin/forms/[id]/_builder/reducer.ts (workflow
  reducer — new actions added here)
- packages/forms-schema/src/types.ts +
  validators/field-config.ts (schema additions: `notifications`
  block on workflow)
- apps/forms-worker/src/workflow-resolution.ts +
  admin/submissions.ts (transition handler — outcome webhook fires
  here)
- apps/forms-worker/src/cron/approval-digest.ts (webhook fire
  pattern reference — same fail-soft posture)

## Context

Operator review of the Brief 120/123 workflow builder surfaced a
fundamental mismatch: every concept in the UI is a schema concept
(stage, transition, approver_source type, default_stage, terminal
stage, payload_field, site_role). None of these match how someone
who has built workflows in JotForm / Microsoft Forms / Power
Automate thinks about approval flows.

The user model is concrete: "First, RM approves. When they approve,
the request is done. When they deny, it's also done — but denied."
That's it. Three concepts: steps, approvers, outcomes.

The current UI buries the Workflow editor in the right-panel
Inspector (so clicking any field unmounts it and there's no path
back without a full reload), uses snake_case stage IDs as a
first-class operator surface, requires the operator to model "done"
as a stage with no transitions, and labels the approver picker
with the schema-shaped vocabulary `Site role / Static emails /
Payload field` — none of which a non-developer can interpret.

Operator's design feedback after reviewing two wireframe iterations:

- Workflow is a top-level Form tab (sibling to Fields + Settings),
  not an Inspector panel.
- Approver picker auto-detects from the form's existing fields. If
  a lookup resolves to `am_email` / `rm_email` / `site_email`, that
  lookup appears as a labeled approver option ("RM email (resolved
  via 'Site Number' lookup)"). If a field of type `email` exists,
  it surfaces too. "Specific person" auto-suggests from the org
  directory (`auth_unified`) as you type.
- Each step has actions (Approve / Deny / custom). Each action has
  a "Required action" sub-section for sig / note / typed-name
  (these are requirements the form maker sets on the approver — not
  choices the approver makes), and a "Then go to" destination
  (another step OR an outcome).
- Outcomes are a separate visual section. Approved and Denied are
  pre-seeded. Operator can add more (Closed, Needs Revision,
  Withdrawn). Outcomes have no approver and no transitions out —
  but the operator NEVER sees the words "terminal stage" or
  manages a "no transitions" attribute. An outcome is just a final
  label.
- Notifications are user-language checkboxes grouped by trigger:
  per-step (notify the new approver) and per-outcome (notify the
  submitter, optionally the approvers who acted). "Attach PDF of
  completed form with approvals" lives here as a `v2` disabled
  placeholder.
- Live flow preview at the bottom — Mermaid diagram showing Form
  Submitted → Step 1 → outcomes with action labels on the edges.
- Outcome email PA flow does NOT yet exist. The webhook wiring
  lands HERE so when the operator builds the PA flow on their
  side, no apps/web or worker change is needed — just bind the
  secret. (Same posture Brief 121 took for the digest webhook.)

The underlying Brief 120 schema (stages / transitions /
approver_source / current_approver_emails) is preserved verbatim.
Submissions written under the current UI continue to render and
transition correctly after this brief lands. The mapping from
operator concepts to schema happens at save time.

## Scope

### Phase 1 — Form builder tab restructure

Restructure `apps/web/app/admin/forms/[id]/page.tsx` so the builder
gains a top-level tab layer: **Fields | Workflow | Settings**.
Currently the entire builder is a single 3-pane layout (palette /
canvas / inspector). After this phase:

- A `<FormBuilderTabs>` component renders at the top of the page,
  visually similar to `SignupAdminTabs` (Brief 56) and
  `FormsAdminTabs` (Brief 100). Three tabs: Fields, Workflow,
  Settings.
- URL-driven active tab via `?tab=fields|workflow|settings`. Default
  `fields` when omitted (back-compat for existing direct URLs).
- The save/publish toolbar (TopBar) sticks at the top across all
  tabs.
- Fields tab: current 3-pane builder, unchanged at this phase.
- Workflow tab: new component (Phases 2-8).
- Settings tab: placeholder at this phase — drops the form-meta
  editing widgets currently in the Inspector (title, audience,
  notify_webhook, etc.) into their own tab. This unblocks the
  Brief 95 limitation where form-meta edits were client-only and
  not persisted (the PATCH /draft endpoint already accepts these
  fields per Brief 94; this phase just gives them a real home and
  wires save).
- The reducer's dirty-state tracking spans all three tabs — saving
  on the Workflow tab clears the dirty flag for everything, etc.
  `beforeunload` warning behavior unchanged.

The middleware allow-list at `apps/web/middleware.ts` doesn't need
updating — `/admin/forms/[id]` is multi-segment so it doesn't trip
the Brief 109/121 redirect rule. (Cross-reference the CLAUDE.md
working-with-apps/web bullet for the rule itself.)

### Phase 2 — Workflow tab layout

Build the Workflow tab component at
`apps/web/app/admin/forms/[id]/_workflow/WorkflowTab.tsx` (new
folder; lifts most of Brief 120's `WorkflowEditor.tsx` content but
restructures fundamentally).

Top-level layout, top to bottom:

1. **Header** — "Approval workflow" h2 + description text + Disable
   workflow button (red-bordered, top-right). Mirrors the Brief 120
   disable affordance.
2. **"Form submitted" entry node** — non-interactive pill-shaped
   element, visual anchor showing where the flow starts. Below it,
   a single downward arrow `↓`.
3. **Step cards stack** — vertical list of approval steps with drag
   handles, separated by `↓` arrows. Each step has a numbered badge
   ("Step 1", "Step 2"). Renumbering happens automatically when
   reordered (Phase 4).
4. **"+ Add approval step" dashed button** — full-width, at the
   bottom of the steps stack.
5. **Outcomes section** — h3 + description + horizontal pill row
   with "+ Add outcome" affordance.
6. **Notifications section** — h3 + description + a settings panel
   (Phase 7).
7. **Flow preview section** — h3 + Mermaid diagram (Phase 8).

The terminal-stage / "Make approval step" UX from Brief 123 is
removed entirely. Outcomes live in their own section (Phase 6) and
the operator NEVER sees the word "terminal" anywhere.

Schema mapping: the workflow JSONB's `stages[]` array contains BOTH
approval steps AND outcomes. The Workflow tab UI splits them at
render time based on `stages.transitions.length === 0 &&
!stage.approver_source` (the same terminal-detection predicate from
Brief 123, just used differently — to bucket stages into the
correct UI section, not to render a "TERMINAL" badge inside a
unified stages list).

A new schema field `stage.kind?: "step" | "outcome"` is added as a
HINT to disambiguate stages that haven't been wired up yet (e.g.,
operator adds a new step but hasn't picked an approver or
transitions). Default behavior: omitted `kind` falls back to the
predicate-based detection. This avoids re-classifying stages
mid-build.

### Phase 3 — Step cards

Each step card renders as a self-contained block:

**Header row:**
- Drag handle (⋮⋮) — visual only at this phase; Phase 4 wires
  drag-to-reorder.
- "Step N" badge (blue-toned per the design system info color).
- Step label input — defaults to "Approval", operator can rename.
  Renaming this is what the operator-facing identity actually IS
  in this UI. The underlying `stage.id` is auto-generated (nanoid)
  and never shown.
- Duplicate button — adds a new step below this one with the same
  approver + action configuration.
- Remove button (red-bordered).

**Body — "Who approves?" section:**

A single dropdown with three `<optgroup>` sections:

1. **From your form** — auto-detected options from the form's
   schema. See Phase 5 for the detection rules.
2. **Specific person** — one option "Type or pick from org
   directory…" which expands inline (or opens a popover) to an
   auto-suggest input querying `auth_unified` (Phase 5).
3. **Multiple people** — one option "Build a list…" which expands
   to a tag-input where the operator adds emails one at a time
   (also auto-suggested from `auth_unified`).

Below the dropdown: a small hint paragraph "Options come from your
form's fields. Add another lookup or an email field on the Fields
tab to surface more choices here."

**Body — "What can the approver do?" section:**

A grid (2 columns at desktop width) of action sub-cards. Each
action sub-card represents a button the approver will see on the
review page. Default seeded actions (when a step is first created):
"Approve" (success-tinted) → outcome `Approved`, "Deny"
(danger-tinted) → outcome `Denied`.

Each action sub-card:

- A colored dot (green for positive, red for negative — picked
  heuristically from label keywords; operator can swap via the
  inline radio later if needed).
- Editable action label input ("Approve" / "Deny" / custom). This
  becomes the button text on the approver's review page.
- **"Required action"** subsection — three checkboxes (Signature,
  Note, Typed name). These are requirements the form maker sets on
  the approver before submit. NOT "Requires before submit" — the
  operator was explicit that the framing is "required action",
  reflecting that the form maker is dictating, not the approver
  choosing.
- **"Then go to"** dropdown — destination after this action fires.
  Options listed in this order: every Outcome from the Outcomes
  section (prefixed `Outcome: `), every other Step (prefixed
  `Step N: {label}`). Self-step is disabled with the Brief 123
  hover hint pattern.

Below the action cards grid: "+ Add another action" dashed button.

### Phase 4 — Drag-to-reorder

Use `@dnd-kit/sortable` (already a workspace dep per Brief 95) to
make step cards draggable. Reorder by dragging the ⋮⋮ handle.

- Renumbering is automatic — "Step 1" / "Step 2" labels are
  computed from array index at render time, NOT stored.
- The schema's `stages[]` array order is the order of steps.
  Outcomes also live in `stages[]` but their order is preserved
  separately (the UI sorts by the kind predicate before render).
- `default_stage` always references the FIRST non-outcome step's
  id. If the operator reorders such that Step 1 becomes Step 2,
  `default_stage` updates atomically to point at the new first
  step. New reducer action `reorder_steps(fromIndex, toIndex)`
  handles this in one dispatch.
- Outcome pills (Phase 6) are not drag-reorderable at v1 — they
  render in insertion order. Adding outcome reorder is a v2 nit.

### Phase 5 — Approver picker auto-detection + org directory autosuggest

Two pieces:

**5a. Auto-detect approver options from the form's schema.**

When rendering the "Who approves?" dropdown's "From your form"
`<optgroup>`, scan `state.workflow.draft.schema.fields` for:

- **Lookup fields with email-shaped value column.** Inspect
  `field.config.valueColumn` (or whatever the lookup config calls
  it — confirm against the Brief 89 LOOKUP_SOURCES registry).
  If the value column is one of `am_email`, `rm_email`,
  `site_email`, OR matches a generic `_email`-suffix pattern, OR
  matches an explicit email-shaped column allow-list from
  LOOKUP_SOURCES, surface as:
  - `"RM email (resolved via '{field.label}' lookup)"` if
    valueColumn is `rm_email`.
  - `"AM email (resolved via '{field.label}' lookup)"` if
    valueColumn is `am_email`.
  - `"Site email (resolved via '{field.label}' lookup)"` if
    valueColumn is `site_email`.
  - `"Email from '{field.label}' lookup"` for any other email-
    shaped value column.
- **Fields of type `email`.** Surface as `"Email entered in
  '{field.label}' field"`.
- **Fields of type `location`.** Surface three sub-options under
  one parent: `"AM for the picked location"`, `"RM for the picked
  location"`, `"Site email for the picked location"`. These map to
  the existing `site_role` approver_source.

Selecting any of these maps internally to the schema's
`approver_source` shape:
- Lookup field → `{type: "payload_field", field_key: field.id}`
  (NOT `field.key` — the canonical schema reference is the
  field's id; the resolver reads from `payload[field_key]` and
  payload keys ARE the field ids per Brief 92 convention).
- Email-type field → same `{type: "payload_field", field_key:
  field.id}`.
- Location field → `{type: "site_role", role:
  "am_email"|"rm_email"|"site_email"}` based on which sub-option
  was picked.

When the operator clicks save, this mapping translates back from
the dropdown option to the schema. On load, the schema maps back
to the appropriate dropdown option (best-effort — if the
underlying approver_source field/role doesn't match any current
form field, show a "missing field" warning hint and let the
operator re-pick).

**5b. Org directory auto-suggest for "Specific person" + "Multiple
people".**

New worker endpoint:
`GET /forms/admin/api/users/search?q={query}` — returns the first
N matching users from `auth_unified` (the view that joins
`auth.users` with role info).

- Auth: any admin-tier session (the same gate Brief 94 uses on
  the admin builder API: `session.role === "super_admin"` OR
  `session.dcRole === "admin"|"super_admin"`).
- Query matches against `email` (substring, case-insensitive) and
  `full_name` (when present in `auth_unified`).
- Cap at 20 results; sort by email ascending.
- Returns `{email, full_name?, dc_role?}` per row.

apps/web client component `<PersonAutosuggest>` consumes this
endpoint via the existing `worker-fetch.ts` helper pattern.
Debounce 200ms on input changes. Shows a popover list below the
input.

Selecting a user inserts their email into the schema as either:
- `{type: "static_emails", emails: [picked_email]}` for "Specific
  person".
- `{type: "static_emails", emails: [...existing, picked_email]}`
  for "Multiple people" (the tag-input adds to the list).

The operator can ALSO type a raw email and hit enter — accepted
verbatim (validated as email-shaped client-side, schema-validated
server-side). This is the only path to invite an external user
not in `auth_unified`.

### Phase 6 — Outcomes section

Below the steps stack and above the Notifications section.

- h3 "Outcomes"
- Subtitle "Terminal states. Submissions reach these and stop."
- Horizontal pill row. Each pill represents one Outcome stage.
  Default pills (auto-seeded when workflow is enabled, mirroring
  Brief 123's seed but only the outcomes — the approval step gets
  seeded separately): **Approved** (success-tinted pill) and
  **Denied** (danger-tinted pill).
- Click a pill → opens an edit panel inline below the row: rename
  the outcome (display label), pick a tint (success / danger /
  warning / info / neutral via the design system semantic colors),
  remove the outcome.
- "+ Add outcome" dashed button at the end of the row.

Outcomes are stages in the schema with `transitions: []`,
`approver_source: undefined`, AND `kind: "outcome"`. The `kind`
field is the hint; the predicate-based detection still works as a
fallback.

`stage.id` for outcomes auto-generates (nanoid). Operator never
sees the id; only the display label.

If the operator removes an outcome that is the destination of some
action's "Then go to", surface a confirmation dialog: "X actions
currently point here. Remove anyway?" — on confirm, those actions
have their "Then go to" reset to the first remaining outcome (or
the first step, if no outcomes remain).

### Phase 7 — Notifications section

Three trigger groups, each with one or more checkboxes:

**When a step gets a new approver:**
- [✓] Email the approver — "You have a new item to review"

**When the workflow reaches an outcome:**
- [✓] Email the submitter — "Your submission was {outcome}"
- [ ] Email each approver who acted on it
- [ ] Attach a PDF of the completed form with all approvals
  `v2` ← rendered as disabled with the v2 chip

**Already running (informational):**
- Daily digest of pending items per approver — Brief 121
  webhook, no per-form opt-out, configured globally.

These checkboxes write to a new `workflow.notifications` block:

```ts
interface WorkflowNotifications {
  notify_approver_on_assignment: boolean;
  notify_submitter_on_outcome: boolean;
  notify_approvers_on_outcome: boolean;
  // v2: attach_pdf_on_outcome: boolean;
}
```

Schema additions: extend `packages/forms-schema/src/types.ts` and
`validators/field-config.ts` to accept the new block. Defaults
(when omitted): `notify_approver_on_assignment: true`,
`notify_submitter_on_outcome: true`,
`notify_approvers_on_outcome: false`. Set in the worker's
`getWorkflowNotifications(version)` helper, not in the schema
defaults — keeps stored schemas minimal and lets us evolve
defaults without re-publishing every form.

The "Sent via Power Automate (admin-managed)" subtitle is the only
infrastructure hint the operator sees. No mention of webhook URLs
or secret bindings.

### Phase 8 — Live flow preview (Mermaid)

Extend Brief 123's `WorkflowMermaidPreview` (rename to
`WorkflowFlowPreview` — "Mermaid" is implementation, not user
language).

- Sits at the bottom of the Workflow tab.
- h3 "Flow preview" + subtitle "Live diagram of how submissions
  move through this workflow."
- Mermaid `flowchart LR` source with three node classes:
  - `:::entry` — "Form submitted" node (gray-toned).
  - `:::step` — Approval step nodes (blue/info-toned).
  - `:::outcome` — Outcome nodes (success/danger/etc by their tint).
- Edges labeled with action labels ("Approve" / "Deny" / custom).
- Renders empty (or hides) when workflow is disabled.
- Re-renders live as operator edits, debounced 300ms (per Brief
  123's wiring).

Brief 123's lazy `next/dynamic({ ssr: false })` loader stays
intact — the redesign re-exports the renamed component from the
same module so the existing bundle-split structure is preserved.

### Phase 9 — Outcome notification webhook wiring (PA flow doesn't exist yet)

New optional secret on splash-forms:
`FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` — single PA flow handles
both per-step "you have a new item" and per-outcome "your
submission was approved/denied" emails. Discriminated by a `type`
field in the payload. Same fail-soft posture as Brief 121's
digest.

**Two fire points** in the worker:

**9a. Per-step (assignment) fire.** Inside the submit handler
(after `current_approver_emails` is seeded on insert) AND inside
the transition handler (after the destination stage's
`current_approver_emails` is computed and the row is updated). If
the workflow's `notify_approver_on_assignment` is true AND the new
`current_approver_emails` is non-empty, fire one POST per email
with payload:

```json
{
  "type": "assignment",
  "submission_id": "abe1ebd9-...",
  "form_id": "9bf...",
  "form_title": "Equipment Repair Request",
  "step_label": "RM Approval",
  "recipient_email": "rm@example.com",
  "submitter_email": "gm@example.com",
  "submitted_at": "2026-05-14T11:00:00Z",
  "review_url": "https://splashcarwashes.info/admin/forms/{form_id}/submissions/{submission_id}"
}
```

Skip-on-empty: zero recipients = zero POSTs. Skip-on-unchanged:
if the destination stage's resolved approver email list equals the
caller's email (the approver acting on their own forwarded
submission), skip the fire — Brief 101 actor-exclusion pattern.

**9b. Per-outcome fire.** Inside the transition handler, AFTER the
row is written, IF the destination stage is an outcome (no
approver_source AND no transitions out). Read the workflow's
`notify_submitter_on_outcome` + `notify_approvers_on_outcome`
booleans. Build recipient list:
- Submitter email (when `notify_submitter_on_outcome` true AND
  the submission has a non-null `submitter_email`).
- Every approver who acted on this submission (when
  `notify_approvers_on_outcome` true) — derive from
  `workflow_history[]` entries.
- Dedupe + lowercase + filter empties.

For each recipient, fire one POST with payload:

```json
{
  "type": "outcome",
  "submission_id": "abe1ebd9-...",
  "form_id": "9bf...",
  "form_title": "Equipment Repair Request",
  "outcome_label": "Approved",
  "outcome_kind": "success",
  "recipient_email": "gm@example.com",
  "recipient_role": "submitter",
  "submitter_email": "gm@example.com",
  "submitted_at": "2026-05-14T11:00:00Z",
  "outcome_reached_at": "2026-05-14T15:30:00Z",
  "actor_history": [
    {"step_label": "RM Approval", "email": "rm@example.com", "action": "Approve", "at": "2026-05-14T15:30:00Z", "note": null, "typed_name": null, "signature_r2_key": "..."}
  ],
  "review_url": "https://splashcarwashes.info/admin/forms/{form_id}/submissions/{submission_id}"
}
```

`outcome_kind` is the pill tint (success / danger / warning / info
/ neutral) — gives PA an easy switch on rendering color in the
email template. `recipient_role` distinguishes "submitter" vs
"actor" so PA can change the subject line accordingly. The PDF
attach is NOT in this payload at v1 — when v2 lands, an
`attached_pdf_base64` (~3 MB cap, Brief 32 pattern) gets added.

`actor_history` is the trail PA needs to render the email body
("RM Jane approved with note 'looks good'; GM John approved with
signature attached"). Each entry is one transition event.

**9c. Fire infra.** New module
`apps/forms-worker/src/notifications.ts` (mirrors damage-worker's
`notifications.ts` from Brief 101 — single home for all forms
notification webhooks, including the existing submission webhook
which can be moved here in a future cleanup). Two functions:
`fireAssignmentNotification(env, payload)` and
`fireOutcomeNotification(env, payload)`. Both 15s
AbortController timeout, swallow non-2xx, log
`[forms.notify.{assignment|outcome}]`. Both `ctx.waitUntil`-ed
from the calling handler so the transition response isn't
blocked.

When `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` is unbound, both
fires no-op (silent log). Allows the brief to land before the PA
flow exists — operator binds the secret later and emails start
flowing.

**9d. PA flow build guide.** New doc
`C:\Users\Coppsrv\Documents\splash-info\PA_FLOWS_BRIEF_125.md`
(mirrors `PA_FLOWS_BRIEF_121.md`). Documents the two payload
shapes, the discriminator field, recommended Power Automate
flow structure: a single HTTP-trigger flow with a Condition
control branching on `triggerBody().type`. Each branch composes
the email subject/body for its case. Operator builds the flow
on their side post-deploy; flagged as their work item, not
Claude Code's.

### Phase 10 — Backward compatibility + migration

Schema additions are additive and optional:
- `workflow.notifications` defaults to true/true/false (per Phase
  7) when missing.
- `stage.kind` defaults to predicate-derived behavior when missing.

Existing test submission from the operator's pre-Brief-125
workflow:
- workflow_stage = "approval" — continues to resolve via the new
  reducer/render path.
- workflow.stages[].id = "approval" / "approved" / "denied" —
  these continue to back the new "Step 1" / "Outcome: Approved"
  etc. labels, because:
  - "approval" has approver_source AND transitions → renders as a
    Step in the new UI (label "Approval", carried from
    `stage.label`).
  - "approved" / "denied" have no approver_source AND no
    transitions → render as Outcomes (labels "Approved" / "Denied"
    from `stage.label`).
- No re-publish needed. The form continues to accept submissions,
  and any new submissions to the same version see the new UI when
  an admin opens the detail page (the Brief 120 `WorkflowSection`
  on the per-submission detail page renders unchanged — that
  surface uses the same schema and isn't touched here).

If a workflow exists where some stage has `approver_source` set
AND ZERO transitions (orphan approver — Brief 123's strict
validator already blocks this at publish), it renders in the UI
as a Step with a missing-action hint. Operator fixes by adding
an action or removing the approver source.

### Phase 11 — Validation

11.1 `pnpm typecheck` — must pass.
11.2 `pnpm --filter @splash/web build` — must succeed.
11.3 `pnpm --filter @splash/forms-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up.
11.4 No Supabase / R2 schema changes (Brief 120's
    `form_submissions` columns + Brief 121's GIN index are reused
    as-is).
11.5 New secret bind documented (deferred operator step):
    `pnpm --filter @splash/forms-worker exec wrangler secret put
    FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` once PA flow URL
    exists.
11.6 Operator post-deploy smoke (deferred):
    - Navigate to `/admin/forms/[id]`. Tab bar visible. Click
      Workflow tab. Click a field on the Fields tab → return to
      Workflow tab via the tab nav → workflow content persists
      (the focus-loss + navigation bug from Brief 123 is fixed).
    - Enable workflow on a new form. Step 1 auto-seeds with
      "Approve → Approved" + "Decline → Denied". Outcomes section
      has Approved + Denied pills.
    - "Who approves?" dropdown lists "From your form" options
      reflecting any lookup / email / location fields on the
      form. With a Site Number lookup → rm_email config, the
      dropdown shows "RM email (resolved via '{lookup label}'
      lookup)".
    - Pick "Specific person" → autosuggest fires against
      auth_unified. Type "josh" → top result is
      josh.copp@splashcarwashes.com.
    - Mark Approve action's "Required action" as Signature; mark
      Decline action's "Required action" as Note.
    - Publish. Open the public form, submit it.
    - Open the submission detail page → Workflow section renders
      the two action buttons (Approve / Decline) with the correct
      required-action enforcement (Signature canvas inline on
      Approve modal; Note textarea inline on Decline modal).
    - Click Approve → submission moves to Outcome: Approved.
      With `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` bound, the
      submitter receives an outcome email. With it unbound, the
      transition still succeeds (log line
      `[forms.notify.outcome] webhook unbound — skipping`).
    - Re-submit the form against another step config: when the
      submission lands at the default stage and
      `notify_approver_on_assignment` is true, the approver
      receives an assignment email (or a log line if webhook
      unbound).

### Phase 12 — Updates

12.1 BRIEFS/INDEX.md: Brief 125 row appended.

12.2 BUILD_STATE.md: Findings entry noting:
  - Brief 125 (YYYY-MM-DD) — workflow builder UX redesign:
    top-level Form tabs (Fields / Workflow / Settings),
    user-language workflow editor (steps / actions / outcomes,
    no schema vocabulary in the UI), approver picker auto-detects
    from form fields + auto-suggests org users from auth_unified,
    Required Action checkbox model for sig/note/typed-name,
    live flow preview, outcome-triggered notification webhook
    (`FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL`) covering both
    assignment + outcome events under one PA flow.
  - Schema additions: `workflow.notifications` block (three
    booleans, defaults true/true/false). `stage.kind` hint for
    UI disambiguation (still derives from predicate when
    omitted).

12.3 CLAUDE.md `forms-worker` glossary entry: replace the
Brief 120 / 123 paragraphs with a Brief 125-current paragraph
documenting the redesigned UX surface, the schema additions, and
the outcome webhook contract. Preserve a note that the schema
shape (stages / transitions / approver_source / etc.) is
unchanged and that submissions written under the old UI continue
to work.

12.4 PA flow build guide: new doc
`C:\Users\Coppsrv\Documents\splash-info\PA_FLOWS_BRIEF_125.md`
covering the two payload shapes + discriminator + flow build
steps (mirrors Brief 121's pattern).

## Out of scope

- The PA flow itself (operator builds it after the brief lands
  and the secret is bound).
- PDF-of-completed-form-with-approvals generator. Flagged in the
  notifications panel as `v2`. Separate brief (call it Brief 127
  when drafted) — non-trivial build (pdf-lib layout, signature
  embed via R2 fetch, approval audit trail rendering).
- Conditional transitions ("only allow Approve if payload field
  X equals Y"). v2 candidate.
- Visual drag-edit canvas (vs. our drag-to-reorder vertical
  list). v3 if there's demand.
- Per-step approver_source customization beyond what Brief 120
  exposes (the auto-detect approach in Phase 5 already covers
  every existing source type — no schema additions needed).
- Reordering Outcomes via drag (renders in insertion order at
  v1).
- "My Requests" view (Brief 126 — drafted in parallel).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `/admin/forms/[id]` has Fields / Workflow / Settings tabs at the
  top, URL-driven via `?tab=`.
- Workflow tab renders the redesigned UI: entry node + step cards
  + outcomes pill row + notifications panel + flow preview.
- No operator-facing reference anywhere in the Workflow tab to
  "stage" / "transition" / "approver_source" / "payload_field" /
  "site_role" / "terminal" / "default_stage" / "make approval
  step".
- Approver picker dropdown auto-detects email-shaped lookup
  fields, email fields, and location fields from the form's
  schema.
- "Specific person" autosuggests from `auth_unified` via
  `GET /forms/admin/api/users/search?q=`.
- Required Action checkboxes (Signature / Note / Typed name) per
  action sub-card.
- Then-go-to dropdown lists every Outcome + every other Step.
- Outcomes section is visually separate; Approved + Denied
  pre-seeded; "+ Add outcome" works.
- Notifications panel has the three checkboxes + the disabled
  `v2` PDF placeholder.
- Flow preview renders live as the operator edits.
- `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` is read by the worker;
  assignment fires on submit + transition; outcome fires on
  terminal transition. Fail-soft when unbound.
- Existing operator-created test submission continues to render
  and transition correctly without re-publishing.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 12.
- PA_FLOWS_BRIEF_125.md exists.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate (apps/web + forms-worker + forms-schema).
- Validation results.
- Any approver_source mapping cases that don't round-trip cleanly
  (e.g., schemas saved under the old UI that don't map back to
  a current form field — surface as warnings in the builder).
- Bundle size impact on `/admin/forms/[id]` first-load JS
  (current baseline 131 kB pre-Brief-95, plus ~250 kB Mermaid
  lazy-loaded per Brief 123 — confirm the redesign doesn't push
  the eager bundle past 200 kB).
- Any subtle cases in the transition handler where the
  assignment/outcome webhook fires twice or zero times when it
  should fire once (e.g., transition pairs that bounce through
  multiple stages).

## Outcome

### Files created

- `packages/forms-schema/src/types.ts` — extended (additive): `WorkflowStage.kind`, `WorkflowStage.tint`, `WorkflowNotifications` interface, `FormWorkflow.notifications`.
- `packages/forms-schema/src/validators/field-config.ts` — extended (additive): Zod for `kind` / `tint` / `notifications` in both strict and draft variants.
- `apps/forms-worker/src/admin/users-search.ts` — new `GET /forms/admin/api/users/search?q=` handler (admin-tier gate; queries `auth_unified` ilike on `email`; 20-row cap). `full_name` reserved on the response shape; populated as null today because the view doesn't expose the column yet.
- `apps/forms-worker/src/notifications.ts` — canonical notification helpers module. Exports `fireAssignmentNotification`, `fireOutcomeNotification`, `getWorkflowNotifications`, `workflowStageIsOutcome`, `buildReviewUrl`, `buildActorHistory`.
- `apps/web/app/admin/forms/[id]/_components/FormBuilderTabs.tsx` — URL-driven Fields / Workflow / Settings tab nav.
- `apps/web/app/admin/forms/[id]/_workflow/WorkflowTab.tsx` — top-level Workflow tab orchestrator.
- `apps/web/app/admin/forms/[id]/_workflow/StepCard.tsx` — single approval step card (drag-handle, label, duplicate/remove, ApproverPicker, action sub-cards).
- `apps/web/app/admin/forms/[id]/_workflow/ApproverPicker.tsx` — "Who approves?" dropdown with auto-detected `From your form` options + Specific person / Multiple people.
- `apps/web/app/admin/forms/[id]/_workflow/PersonAutosuggest.tsx` — debounced org-directory autosuggest input.
- `apps/web/app/admin/forms/[id]/_workflow/OutcomesSection.tsx` — horizontal pill row + inline edit panel.
- `apps/web/app/admin/forms/[id]/_workflow/NotificationsPanel.tsx` — three user-language trigger groups + v2 PDF placeholder.
- `apps/web/app/admin/forms/[id]/_workflow/SettingsTab.tsx` — form-meta editors lifted out of the Inspector.
- `apps/web/app/admin/forms/[id]/_workflow/WorkflowFlowPreview.tsx` — renamed from `WorkflowMermaidPreview`; new entry / step / outcome node classes.
- `PA_FLOWS_BRIEF_125.md` — Power Automate build guide (mirrors Brief 121).

### Files modified

- `apps/forms-worker/src/index.ts` — mounted `GET /forms/admin/api/users/search`; widened `Env` with `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL?`; threaded `ctx` into `handleTransition`.
- `apps/forms-worker/src/submit/index.ts` — fires `fireAssignmentNotification` for each member of `current_approver_emails` on every freshly-inserted workflow submission (when `notify_approver_on_assignment` true); submitter actor-exclusion.
- `apps/forms-worker/src/admin/submissions.ts` — `handleTransition` now fires assignment events when transitioning into a non-outcome destination AND fires outcome events when transitioning into an outcome; recipient list is submitter (when opt-in) + acted-on approvers from `workflow_history` (when opt-in); both fail-soft + ctx.waitUntil-ed.
- `apps/web/app/admin/forms/[id]/page.tsx` — reads `?tab=`, renders `FormBuilderTabs`, passes `activeTab` into `BuilderClient`.
- `apps/web/app/admin/forms/[id]/_builder/BuilderClient.tsx` — tab-aware rendering (Fields keeps the 3-pane, Workflow mounts `WorkflowTab`, Settings mounts `SettingsTab`); new `WorkflowTabDispatch` wires the new reducer actions.
- `apps/web/app/admin/forms/[id]/_builder/Inspector.tsx` — gutted to Fields-tab only (form-meta + workflow editor lifted to other tabs).
- `apps/web/app/admin/forms/[id]/_builder/reducer.ts` — added `stageIsOutcome` predicate, new actions (`workflow_add_step`, `workflow_duplicate_step`, `workflow_remove_step`, `workflow_reorder_steps`, `workflow_update_step_label`, `workflow_set_step_approver`, `workflow_add_outcome`, `workflow_remove_outcome`, `workflow_update_outcome`, `workflow_set_notifications`), seed updated to mark outcomes with `kind: "outcome"` + `tint`, and the `makeWorkflowSeed` notifications block (true/true/false).
- `BRIEFS/INDEX.md` — Brief 125 row appended above Brief 108.
- `BUILD_STATE.md` — Last-updated bumped to 2026-05-14 + Brief 125 narrative prepended.
- `CLAUDE.md` — forms-worker glossary entry extended with the Brief 125 paragraph.

### Files deleted

- `apps/web/app/admin/forms/[id]/_builder/WorkflowEditor.tsx` — replaced by `_workflow/WorkflowTab.tsx`.
- `apps/web/app/admin/forms/[id]/_builder/WorkflowMermaidPreview.tsx` — replaced by `_workflow/WorkflowFlowPreview.tsx`.

### Decisions made on operator's behalf

1. **`auth_unified` schema unchanged.** The view does NOT expose `full_name` today (confirmed via `packages/db-supabase/src/summary.ts` docblock). The user-search endpoint matches `email` only and returns `full_name: null`; the response shape reserves the field so a future view widening lights up the autosuggest "name" hint without contract change.
2. **Form-meta persistence stays client-only.** Brief 95's limitation persists — the Settings tab renders the editors but `PATCH /draft` accepts schema only. A follow-up brief should widen the worker endpoint with a `meta` accept path; this brief chose to make the editors visible (per the brief's "this phase just gives them a real home and wires save" language) without introducing the meta-PATCH endpoint that the brief assumed already existed but doesn't.
3. **`@dnd-kit/utilities` NOT added as a dep.** The single use site (`CSS.Transform.toString`) is replaced by an inline serializer in `StepCard.tsx`. Avoids dependency churn for a 5-line helper.
4. **Outcome pill colors are operator-picked via the inline edit panel.** Defaults: Approved → success, Denied → danger, all new outcomes → neutral. Tint heuristic was deferred; explicit picker keeps the schema deterministic.
5. **Action-card dot tint via keyword heuristic.** Words like "approve"/"accept" → green, "deny"/"decline"/"reject" → red, default neutral. Future executors can extend `POSITIVE_TOKENS` / `NEGATIVE_TOKENS` in `StepCard.tsx` if more vocabulary lands.
6. **Workflow seed action label flipped from `"Decline"` to `"Deny"`** to match the brief's user-model copy ("First, RM approves. When they approve, the request is done. When they deny, it's also done — but denied."). Existing schemas with "Decline" continue to work — the value is the operator's free-text label.
7. **Notification fire from the transition handler includes form_title.** Added a tiny inline `fetchFormTitleForNotification` helper that hits `/rest/v1/forms?select=title&id=eq.{id}` once per transition. `getSubmission` doesn't carry the form's title row; widening it would have affected unrelated callers.
8. **`form_title` on the submit-time fire** comes from the already-fetched `form` object inside `handleSubmit` — no extra round-trip.
9. **Tab default is `fields`** when `?tab=` is omitted — preserves the back-compat for every existing operator bookmark of `/admin/forms/{id}`.
10. **Outcome notification fire's `outcome_kind` defaults to `"neutral"`** when the outcome stage has no `tint`. Legacy schemas (Brief 120/123) won't have `tint`; PA can switch on `neutral` to fall through to a generic copy.

### Latent issues / forward flags

- Settings tab editors are client-only (see Decision 2 above). Save Draft persists schema only; form-meta widgets revert on page reload until the worker endpoint is widened.
- The user-search endpoint matches `email` only; if operators want to type a person's name into "Specific person" before they remember the email, the autosuggest will return no hits. Surface the `full_name` extension on `auth_unified` as a follow-up.
- Brief 120's `WorkflowSection` per-submission detail page (`apps/web/app/admin/forms/[id]/submissions/[subId]/_components/WorkflowSection.tsx`) is unchanged — it still uses the schema vocabulary internally (transition `requires`, etc.) but only renders the action button labels operators typed, so the user-facing surface there is already in the right vocabulary. No edits needed.
- The strict publish-time validator (`formSchemaSchema.superRefine`) still emits "approver but no transitions → orphaned" and "transitions but no approver → broken" issues, which now fire against the user-language `step` cards. The error path catches partial step setups at publish time correctly. Could be re-phrased with user-language hints in a follow-up if operators see them often.
- The default outcome pill colors (`success` / `danger`) bake operator intent into the seed; if the underlying meaning ever diverges (a workflow where "Denied" is actually positive — e.g., a deny-list workflow), the operator has to flip the tint manually. Same trade-off as the keyword heuristic on action dots.

### Validation results

- `pnpm typecheck` — 18/18 packages green (cache hits: 5; fresh: 13).
- `pnpm --filter @splash/web build` — succeeded. `/admin/forms/[id]` route bundle 34.5 kB / 142 kB First Load JS (was 30.7 kB / 138 kB pre-Brief — ~4 kB increase, comfortably under the 200 kB DoD threshold). Mermaid still code-splits to a separate chunk and stays out of First Load.
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — bundle 1103.92 KiB raw / 211.76 KiB gzipped (Brief 123 baseline 1094.24 KiB raw / 209.86 KiB gzipped → ~+10 KiB raw / +2 KiB gzip, all webhook + autosuggest + helper module). `.tmp-build` cleaned up after.
- No Supabase / R2 / wrangler.toml / secret changes at this brief — the new optional secret `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` is operator-bound post-deploy.

### Report

- **Diff size estimate**: apps/web added ~9 new files in `_workflow/` (~900 LOC) plus minor edits to `BuilderClient`/`Inspector`/`reducer`/`page`; forms-schema picked up ~30 LOC additive types + Zod; forms-worker added ~200 LOC (`notifications.ts` + `users-search.ts` + transition-handler wiring + submit-handler hook).
- **approver_source mapping cases that don't round-trip cleanly**: If a saved `payload_field` `approver_source` references a `field_key` that no longer exists on the schema, the `ApproverPicker` surfaces a `"⚠ Saved approver no longer matches a form field"` placeholder option (selected by default) and the dropdown's other options are pickable to re-route. A `static_emails` source with the field count mismatch (e.g., the picker tries to render Specific-person mode but the array is empty) renders the Specific-person input clean — operator can type a new address.
- **Bundle size impact on `/admin/forms/[id]`**: First Load 142 kB, route-specific 34.5 kB. Mermaid chunk lazy-loaded as before. Within the 200 kB threshold the brief's Report section called out.
- **Transition handler webhook-fire edge cases**:
  - Self-transition / loop transition: the schema's strict validator already blocks self-transitions. A loop through multiple stages firing assignment N times is the intended behavior (each stage hop is a real event); the actor-exclusion filter ensures we don't double-notify the caller of their own forward.
  - When the same email is on `notify_submitter_on_outcome` AND `notify_approvers_on_outcome` (caller submitted, then approved at the only step), the Map-keyed recipient list dedupes to a single outcome fire with `recipient_role: "submitter"` (submitter takes precedence per Map insertion order).
  - Admin-tier escape hatch transitions still fire approver-side webhooks; that's intended (a submission moved is a real event regardless of who moved it). The actor-exclusion strips the caller's own email so the admin who took the action isn't self-notified about an assignment they made.
