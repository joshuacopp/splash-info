# Brief 120: Custom forms — workflow schema + transitions + per-stage approver resolution

**Status:** Completed (2026-05-13)
**Started:** 2026-05-13
**Completed:** 2026-05-13
**Blocks:** Brief 121 (Pending Approvals dashboard surface
depends on the schema + transition machinery this brief
lands).
**Dependencies:** Brief 95 (form builder — extends `form_versions.schema`
to include an optional `workflow` block + adds Workflow inspector
panel), Brief 96 (submissions admin — adds transition action +
modal to the detail page). Closest pattern analog is the damage
workflow (Briefs 19 / 59 / 66 / 101 — the
`apps/damage-worker/src/transitions.ts` + `notifications.ts`
shapes that this brief generalizes).

## Read first

- CLAUDE.md (`forms-worker` glossary + damage transitions /
  notifications paragraphs)
- BRIEFS/brief-095-forms-builder-admin-ui.md (form builder + the
  schema this brief extends)
- BRIEFS/brief-096-forms-submissions-admin.md (submissions detail
  page where transition buttons render)
- BRIEFS/brief-101-damage-claim-update-webhook.md (notification
  reuse pattern — same helper module gets touched here)
- apps/damage-worker/src/transitions.ts (transition allow-list +
  role gating shape — the model this brief generalizes)
- apps/damage-worker/src/notifications.ts (Brief 101 — reused
  here for `site_role` approver resolution from `pricing_simple`)
- packages/forms-schema/src/types.ts (Field discriminated union
  — adds `WorkflowStage` and `WorkflowTransition` types alongside)
- packages/forms-schema/src/validators/* (Zod schemas — adds
  validators for the new workflow block)
- apps/forms-worker/src/handlers/submissions-admin.ts (Brief 96
  — adds the transition POST endpoint)
- apps/web/app/admin/forms/[id]/* (Brief 95 builder + Brief 96
  submissions pages)

## Context

Operator review on 2026-05-13 asked for approval flows on
custom forms. Pattern is already well-trodden by the damage
workflow (Briefs 19 / 59 / 66 / 101 / 102) — status enum,
server-action transitions with role gating, per-stage
notification webhooks, activity-log audit trail. This brief
generalizes that to form-builder-configurable workflows.

Design:

- **Workflow lives in `form_versions.schema.workflow`** —
  optional. Forms without a workflow block behave as today
  (submit → no stages, terminal). Snapshotted per-version
  alongside the form's field schema.
- **Approver resolution** has four sources at v1:
  - `site_role` → look up `am_email` / `rm_email` / `site_email`
    from `pricing_simple` (via `getLocationContactInfo`) using
    the row's `site_number` (the 3-digit code captured in the
    submission's payload). Reuses Brief 101's helper.
  - `static_emails` → form-builder-configured list. Single-
    approver use case (`["jford@splashcarwashes.com"]`) is the
    common one; multi-element list supported for committees.
  - `payload_field` → read approver email from a field on the
    form itself (operator picks an approver at submission time).
  - (v2 / Brief 120.5) `department` → look up `departments`
    table for finance / marketing / it approver groups.
    Out of scope here; flagged for v2.
- **Per-transition requirements** — form-builder declares per
  transition: requires signature? requires typed approver name?
  requires note? Combinations of the above. Just "click to
  approve" with the session user stamped on `approved_by` is
  the simplest case.
- **No editing of past submissions' workflow** — workflows are
  versioned with the form. A submission against v2 follows v2's
  workflow forever, even if v3 changes the stages.

The notification surface (who gets emailed when a stage transitions
into "their" stage) is the subject of Brief 121 — this brief lands
the data model and transition machinery; Brief 121 builds the
pending-approvals dashboard + daily digest cron on top.

## Scope

### Phase 1 — Schema package additions

Edit `packages/forms-schema/src/types.ts`:

```ts
export type ApproverSource =
  | { type: "site_role"; role: "am_email" | "rm_email" | "site_email" }
  | { type: "static_emails"; emails: string[] }
  | { type: "payload_field"; field_key: string };

export interface WorkflowTransitionRequirements {
  signature?: boolean;
  typed_name?: boolean;
  note?: boolean;
  // v2: amount_field?: string, custom_field?: { key, label, type }
}

export interface WorkflowTransition {
  to: string;                    // destination stage id
  label: string;                 // button label (e.g., "Approve")
  requires?: WorkflowTransitionRequirements;
}

export interface WorkflowStage {
  id: string;                    // slug, snake_case
  label: string;                 // display name
  approver_source: ApproverSource;
  transitions: WorkflowTransition[];
  // Terminal stages (no transitions, e.g., "approved" / "denied")
  // have transitions: []
}

export interface FormWorkflow {
  default_stage: string;         // id matching one of stages[].id
  stages: WorkflowStage[];
}
```

Extend `FormSchema` to include optional `workflow?: FormWorkflow`.

Edit `packages/forms-schema/src/validators/*` — add Zod schemas
matching the types. Validator must enforce:
- `default_stage` matches some `stages[].id`.
- Every `WorkflowTransition.to` matches some `stages[].id`.
- No duplicate stage ids.
- `approver_source.field_key` references a real form field
  (for `payload_field` type — cross-reference against the
  form's `fields[].key`).

### Phase 2 — Supabase schema

New columns on `form_submissions`:

- `workflow_stage text` — current stage id; defaults to
  `version.schema.workflow.default_stage` on insert if the
  version has a workflow, else `NULL`.
- `workflow_history jsonb` — append-only array of
  `{from, to, actor_email, actor_session_role, note, signature_r2_key,
  typed_name, at}` per transition. Defaults to `[]`.
- `current_approver_emails text[]` — denormalized email list for
  fast "pending for me" queries; recomputed on every stage
  transition (Brief 121 uses this).

Indexes:
- `CREATE INDEX form_submissions_workflow_stage_idx ON form_submissions (form_id, workflow_stage) WHERE workflow_stage IS NOT NULL;`
- `CREATE INDEX form_submissions_current_approver_emails_idx ON form_submissions USING GIN (current_approver_emails);`

Operator runs the SQL via Supabase SQL editor (no migration
framework per CLAUDE.md). Document the exact SQL in the brief
Outcome.

### Phase 3 — Worker transition handler

Edit `apps/forms-worker/src/handlers/submissions-admin.ts`
(Brief 96). Add a new endpoint:

`POST /forms/admin/api/forms/{id}/submissions/{subId}/transition`

Body:

```json
{
  "to": "approved",
  "note": "Looks good, approving.",
  "typed_name": "Josh Copp",
  "signature_r2_key": "form-submission-files/.../signature.png"
}
```

Handler logic:
1. Auth gate: any authenticated session.
2. Load the submission row + version's schema (1 PostgREST call
   embedding `form_versions`).
3. Validate the row has a workflow (`schema.workflow` present);
   if not, return 400 "form has no workflow."
4. Look up the current stage (`row.workflow_stage`) in
   `schema.workflow.stages`. Find a transition where
   `transition.to === body.to`.
5. Validate the caller is allowed:
   - Resolve current stage's `approver_source` to email list (same
     resolution logic as Phase 4 below).
   - Caller's `session.email` must be in that list.
   - super_admin / admin tier bypass this check (escape hatch for
     stuck workflows).
6. Validate `requires`:
   - If `requires.signature` set, body must include `signature_r2_key`.
   - If `requires.typed_name` set, body must include `typed_name`.
   - If `requires.note` set, body must include `note`.
   - Reject 400 with missing-field message otherwise.
7. Append to `workflow_history` JSONB.
8. Update `workflow_stage` to `body.to`.
9. Recompute `current_approver_emails` for the new stage and
   write the array.
10. Optional notification webhook fire (Brief 121's
    `FORMS_WORKFLOW_TRANSITION_WEBHOOK_URL` — fail-soft).
11. Return updated row.

The single PostgREST `PATCH` does steps 7-9 atomically via a
single UPDATE with JSONB array concat.

### Phase 4 — Approver resolution helper

New module `apps/forms-worker/src/workflow-resolution.ts`:

```ts
export async function resolveApproverEmails(
  env: Env,
  source: ApproverSource,
  submission: FormSubmissionRow
): Promise<string[]> {
  switch (source.type) {
    case "static_emails":
      return source.emails.filter(e => e.trim().length > 0);

    case "payload_field": {
      const value = submission.payload?.[source.field_key];
      if (typeof value === "string" && value.includes("@")) {
        return [value.trim()];
      }
      return [];
    }

    case "site_role": {
      // Resolve site_number from the submission's payload.
      // Submission's payload should have a site/site_number lookup
      // field (common — most internal forms do). If not, return [].
      const siteNumber = extractSiteNumber(submission.payload);
      if (!siteNumber) return [];
      const contact = await getLocationContactInfo(env, siteNumber);
      const email = contact?.[source.role];
      return email ? [email] : [];
    }
  }
}
```

`extractSiteNumber(payload)` walks the payload looking for a
field whose value matches a 3-digit site number pattern.
Convention: the form builder enforces a `site_number` lookup
field on any form whose workflow uses `site_role` approver
sources — validator-time check (Phase 1).

`getLocationContactInfo` is the Brief 101 helper in
`@splash/db-supabase`. Reuse directly.

### Phase 5 — Builder UI: Workflow inspector panel

Edit `apps/web/app/admin/forms/[id]/_builder/*` (Brief 95 builder).
Add a new "Workflow" panel accessible from the right-hand
inspector (existing field-edit inspector pattern):

- Toggle "Enable workflow" on the form. Off = no workflow block
  in the schema. On = render the editor below.
- Default stage selector (dropdown of stage ids).
- Stage list (drag-to-reorder is v2; v1 just renders in array
  order with up/down buttons).
- Per-stage edit panel:
  - Stage id input (snake_case, regex-validated)
  - Display label input
  - **Approver source picker** — radio buttons for type, then
    sub-form per type:
    - `site_role`: dropdown for `am_email` / `rm_email` /
      `site_email`. Validation: warn the operator if the form
      doesn't have a site lookup field.
    - `static_emails`: textarea (one email per line) OR a
      repeating single-input "Add another approver" pattern.
      Operator picks whichever the UX team prefers (executor
      decides; both shapes save to the same string[] in the
      data model).
    - `payload_field`: dropdown of fields in the current form
      that are email-typed.
  - Transitions list — per-transition:
    - To stage (dropdown of stage ids)
    - Label (button text)
    - Requires checkboxes: signature / typed_name / note
- Drag-add new stage button.

The builder's existing draft-then-publish flow (Brief 94) carries
workflow changes through unchanged — workflow is part of the
schema JSONB.

### Phase 6 — Submission detail page transition UI

Edit `apps/web/app/admin/forms/[id]/submissions/[subId]/page.tsx`
(Brief 96 detail page). If the submission's version has a
workflow:

- Render the current stage prominently at top: "Stage: {label}"
- Below: render transition buttons for transitions the caller
  is allowed to take (resolved client-side from
  `current_approver_emails` + `session.email` membership).
- Click → modal with the `requires` config:
  - Note textarea (if required)
  - Typed-name input (if required)
  - Signature pad (if required)
  - Submit → POST to the transition endpoint
- Below the buttons: render `workflow_history` as a vertical
  timeline (mirrors the damage activity log pattern).

Server action wraps the POST with the Brief 19 `useActionState`
pattern for form-action UX consistency.

### Phase 7 — Validation

7.1 `pnpm typecheck` — must pass.
7.2 `pnpm --filter @splash/web build` — must succeed.
7.3 `pnpm --filter @splash/forms-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up.
7.4 Supabase SQL changes: operator runs the column-add SQL once
    in the Supabase editor; provide the exact statements in the
    Outcome.
7.5 Operator post-deploy smoke (deferred):
    - Build a test form with a 3-stage workflow:
      submitted → site_review (site_role: site_email) →
      approved (terminal) | denied (terminal).
    - Publish the form. Fill it out as a non-approver. Submit.
    - As the configured site_email approver, log in, go to
      `/admin/forms/{id}/submissions/{subId}` → see "Site Review"
      stage + Approve / Deny buttons. Click Approve, fill required
      fields per config, submit → row stage flips to approved,
      history row appended.
    - As a non-approver (different RM), try transitioning → 403.

### Phase 8 — Updates

8.1 BRIEFS/INDEX.md: Brief 120 row appended.

8.2 BUILD_STATE.md: Findings entry noting:
  - Brief 120 (YYYY-MM-DD) — custom forms gained per-form
    workflow schema (`form_versions.schema.workflow`), workflow
    state on submissions (`workflow_stage` + `workflow_history`
    + `current_approver_emails`), transition POST endpoint with
    role gating + requirements validation, builder UI for stages
    / transitions / approver sources (site_role / static_emails /
    payload_field at v1; department deferred to v2). Submission
    detail page renders transition buttons + history timeline.

8.3 CLAUDE.md `forms-worker` glossary entry: append a Brief 120
paragraph documenting the workflow schema shape + transition
endpoint contract + approver resolution rules.

## Out of scope

- Notification webhook fire / Pending Approvals dashboard /
  daily digest — Brief 121 owns this.
- Department-approver source — v2 candidate, needs
  `departments` table design.
- Conditional / branching transitions (e.g., "if amount > $500
  route to RM"). v2 candidate.
- Edit form workflows on past submissions. Versioning means
  past rows follow their original workflow forever.
- Bulk transitions (approve multiple at once). v2.
- Workflow analytics / SLA reporting. v2.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `packages/forms-schema` exports `FormWorkflow` /
  `WorkflowStage` / `WorkflowTransition` / `ApproverSource` types
  + Zod validators.
- `form_submissions` table has `workflow_stage` /
  `workflow_history` / `current_approver_emails` columns + indexes.
- `POST /forms/admin/api/forms/{id}/submissions/{subId}/transition`
  endpoint exists with auth gate, role-check, requirements
  validation, history append, stage update, and
  `current_approver_emails` recompute.
- `apps/forms-worker/src/workflow-resolution.ts` exposes
  `resolveApproverEmails(env, source, submission)` with all three
  v1 source types.
- Builder UI's "Workflow" inspector panel exists in the form
  builder.
- Submission detail page renders current stage + transition
  buttons + history timeline.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 8.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate (this is sizeable — likely 600+ LOC
  across schema package, worker, builder UI, detail page).
- Validation results.
- Exact Supabase SQL the operator needs to run.
- Any tricky edge cases on the builder UI side (e.g., how to
  handle a stage whose approver source references a now-deleted
  field).

## Outcome

### Files created

- `apps/forms-worker/src/workflow-resolution.ts` — `resolveApproverEmails(env, source, {schema, payload})` resolver with all three v1 source types; `static_emails` filters empties, `payload_field` reads the payload, `site_role` walks the schema for the first `location` field (or `lookup` keyed on `pricing_simple.location_code`) and calls Brief 101's `getLocationContactInfo`. Emails are deduped + lower-cased + trimmed before return.
- `apps/web/app/admin/forms/[id]/_builder/WorkflowEditor.tsx` — ~330 LOC client component rendered inside `Inspector` when no field is selected. Off-state shows "Enable workflow" CTA. On-state renders Disable button, default-stage dropdown, per-stage cards (id input snake_case-sanitized, label input, `ApproverSourceEditor` with radio + per-type sub-form, transitions list with to-stage / label / requires-checkboxes, remove button, move-up/down), "Add stage" footer button.
- `apps/web/app/admin/forms/[id]/submissions/[subId]/_components/WorkflowSection.tsx` — ~250 LOC client component for the detail page. Renders current stage label + per-transition buttons (disabled with title-attr hint when caller is not an approver), inline `requires` modal (Brief 19 `<ActionForm>` pattern), vertical history timeline.

### Files modified

- `packages/forms-schema/src/types.ts` — added `ApproverSource` discriminated union, `WorkflowTransitionRequirements`, `WorkflowTransition`, `WorkflowStage`, `FormWorkflow`, `WorkflowHistoryEntry`. Extended `FormSchema` with optional `workflow`, `FormSubmission` with `workflowStage` / `workflowHistory` / `currentApproverEmails`.
- `packages/forms-schema/src/validators/field-config.ts` — added strict + lenient-draft workflow Zod schemas. Strict variant's `.superRefine()` enforces no-duplicate-stage-ids, `default_stage` references a real stage, every `transition.to` references a real stage, and `payload_field.field_key` references a real form field. `formSchemaSchema` is now a `z.object(...).superRefine(...)` instead of a plain `z.object(...)`.
- `apps/forms-worker/src/index.ts` — mounted `POST /forms/admin/api/forms/{id}/submissions/{subId}/transition` BEFORE the bare `/{subId}` route so the `/transition` suffix doesn't get treated as part of the UUID. Header comment updated.
- `apps/forms-worker/src/admin/submissions.ts` — added `handleTransition` handler + `findCurrentStage` helper. Imports `authenticate` from `@splash/auth` (broader than the admin-tier gate; RM/RD/GM can take stage-scoped transitions).
- `apps/forms-worker/src/db/admin-submissions.ts` — widened `SubmissionDetail` + `SubmissionDetailDbRow` with the three new columns + populated them in `getSubmission`'s select clause + result mapper. Added `transitionSubmission(env, formId, subId, patch)` helper — single PostgREST PATCH writes `workflow_stage` + `workflow_history` + `current_approver_emails`.
- `apps/forms-worker/src/db/forms.ts` — `insertSubmissionIdempotent` accepts optional `workflowStage` / `workflowHistory` / `currentApproverEmails` args and writes them on insert.
- `apps/forms-worker/src/submit/index.ts` — after validation passes, reads `version.schema.workflow` and pre-resolves the default stage's approver emails via `resolveApproverEmails` (fail-soft — exceptions collapse to `[]` so submission still succeeds). Passes `workflowStage` + `currentApproverEmails` into the insert.
- `apps/web/app/admin/forms/_lib/worker-fetch.ts` — widened `SubmissionDetail` with the three workflow columns; added `TransitionPatchBody`, `TransitionResponse`, `TransitionResult` types and `transitionSubmissionAdmin(formId, subId, body)` helper. 403 `not_approver` response re-surfaces `allowed_emails`; 400 `missing_required` re-surfaces `missing[]`.
- `apps/web/app/admin/forms/[id]/actions.ts` — `saveDraftAction` widened to `(formId, fields, workflow)` and builds `{ fields, workflow }` (or `{ fields }` when workflow is null — Zod treats missing-vs-null as different shapes).
- `apps/web/app/admin/forms/[id]/_builder/BuilderClient.tsx` — wires the new `workflowDispatch` object (12 callbacks) to `Inspector` and includes `state.workflow` in the saveDraftAction call.
- `apps/web/app/admin/forms/[id]/_builder/Inspector.tsx` — renders `WorkflowEditor` BELOW the `FormMetaInspector` when no field is selected (rather than as a separate inspector tab) — operator sees both simultaneously. New `WorkflowDispatch` interface exported for the BuilderClient.
- `apps/web/app/admin/forms/[id]/_builder/reducer.ts` — `BuilderState` gains `workflow: FormWorkflow | null`. 12 new actions: `workflow_enable`, `workflow_disable`, `workflow_set_default_stage`, `workflow_add_stage`, `workflow_remove_stage`, `workflow_move_stage`, `workflow_update_stage`, `workflow_set_approver_source`, `workflow_add_transition`, `workflow_update_transition`, `workflow_remove_transition`. `makeBlankStage()` helper produces a `stage_xxxxxx` slug + matching default label. `workflow_remove_stage` defensively strips dangling transitions targeting the removed stage so the schema stays self-consistent.
- `apps/web/app/admin/forms/[id]/submissions/[subId]/page.tsx` — conditionally renders `<WorkflowSection>` between the existing Status & Notes section and the Payload section when the version has a workflow. Passes `session.email` + `isAdminTier` boolean for client-side button enablement (worker re-validates on POST).
- `apps/web/app/admin/forms/[id]/submissions/[subId]/actions.ts` — added `transitionAction` server action that translates the `TransitionResult` into an `ActionResult`. Maps `not_approver` → `allowed_emails` listing, `missing_required` → `missing[]` listing, anything else → raw error message.
- `BRIEFS/INDEX.md` — Brief 120 row inserted above Brief 119.
- `BUILD_STATE.md` — Last-updated bumped, current-brief findings entry written, previous Brief 122 entry demoted to "(Previously: …".
- `CLAUDE.md` — `forms-worker` glossary entry gains a Brief 120 paragraph documenting the workflow schema shape, transition endpoint contract, approver resolution rules, builder UI additions, deferred items, and the "adding a new approver source" extension recipe.

### Supabase SQL (operator runs once in the Supabase SQL editor)

```sql
ALTER TABLE form_submissions
  ADD COLUMN IF NOT EXISTS workflow_stage text;

ALTER TABLE form_submissions
  ADD COLUMN IF NOT EXISTS workflow_history jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE form_submissions
  ADD COLUMN IF NOT EXISTS current_approver_emails text[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE INDEX IF NOT EXISTS form_submissions_workflow_stage_idx
  ON form_submissions (form_id, workflow_stage)
  WHERE workflow_stage IS NOT NULL;

CREATE INDEX IF NOT EXISTS form_submissions_current_approver_emails_idx
  ON form_submissions USING GIN (current_approver_emails);
```

Backward compatible: every new column is nullable / has a sensible default, so existing rows continue to work. New rows inserted before the migration runs simply carry the defaults; the worker's `?? []` fallback in `getSubmission`'s mapper means an unmigrated table reads cleanly too.

### Decisions made on operator's behalf

1. **`site_role` resolves through the form's Location field, not a `extractSiteNumber` payload walk.** The brief mentioned `extractSiteNumber(payload)` looking for a 3-digit value, but the existing `getLocationContactInfo` is keyed by `location_code` (the slug) and the Location field's payload value IS the slug (`apps/forms-worker/src/render/fields/location.ts`). Walking back through `pricing_simple` for site_number → slug would have added a round-trip with no benefit. Form-builder convention: forms using `site_role` should include a Location field (or a Lookup field keyed on `pricing_simple.location_code`).
2. **Approver-email membership is case-insensitive lowercased.** Defends against email-casing drift between `pricing_simple` (often lower-cased) and `session.email` (sometimes mixed-case). All emails are `trim().toLowerCase()`'d at resolve time and at compare time.
3. **`WorkflowEditor` renders BELOW `FormMetaInspector`, not as a separate inspector tab.** Operator sees both simultaneously and doesn't need a tab toggle. The brief was ambiguous on placement; the chosen position keeps form-meta + workflow on one scrollable surface.
4. **Modal renders inline above the transition buttons rather than as a true `<dialog>` overlay.** Same UX affordance with less JS scaffolding; consistent with the rest of the apps/web admin surface.
5. **`default_stage` auto-set on first stage add; auto-recovered (or emptied) on default-stage delete.** Matches the strict validator's requirement that `default_stage` references a real stage — the reducer keeps the invariant by construction.
6. **Stage-id input sanitizes to `[a-z0-9_]` lowercased + drops leading non-letters on every keystroke** (matches the existing KeyEditor pattern in the field-types directory). Prevents silently invalid stage ids from reaching the worker validator.
7. **`current_approver_emails` is populated at insert + recomputed on every transition, not lazily.** Brief 121's "pending for me" dashboard query is a GIN index lookup, not a per-row resolve.
8. **Reducer's `workflow_remove_stage` also strips transitions targeting the removed stage**, so a Save Draft after deletion doesn't 422 on a dangling `transition.to`. The strict publish-time validator would still catch a `transition.to: ""` (empty string from an unfinished add), so this is purely a UX nicety.
9. **`saveDraftAction`'s payload omits `workflow` entirely when null** rather than sending `workflow: null`. Zod's optional-field schema treats missing-vs-null as different shapes; passing `null` would fail the lenient draft variant's `.optional()` qualifier.
10. **Signature canvas on the transition modal punted to Brief 121.** v1 accepts an existing `signature_r2_key` text input — the operator pastes a key produced by the Brief 92 signature canvas (or any other R2 upload). Full canvas capture on the admin detail page is a non-trivial lift that's not blocking the data-model + transition machinery this brief lands.
11. **Notification webhook fire on transition deferred to Brief 121.** The handler comment-flags the integration point but doesn't fire today.

### Latent issues / forward flags

- (a) Signature canvas on the transition modal is a paste-an-existing-r2_key text field at v1.
- (b) `site_role` approver source requires the form to have a Location field (or lookup keyed on `pricing_simple.location_code`); operator-onboarding doc not added yet.
- (c) Past submissions whose version had no workflow but whose form has since been re-published with one carry `workflow_stage = null` and can't be transitioned (correct: workflow versioning means past submissions follow their original workflow forever).
- (d) Edge case — operator adds a transition but never picks a destination: `transition.to = ""` survives the lenient draft variant; strict publish-time validator catches it with a 422 `transition.to "" not in stages[]`.
- (e) Approver-email gate is case-insensitive lowercase compare; if a future Supabase column ends up with whitespace-wrapped emails the existing `trim()` in `normaliseEmails` handles it.
- (f) Department-approver source flagged for v2 (Brief 120.5) per the brief's out-of-scope section.
- (g) Conditional / branching transitions (e.g., "if amount > $500 route to RM") flagged for v2.
- (h) Bulk transitions (approve multiple at once) flagged for v2.
- (i) Workflow analytics / SLA reporting flagged for v2.
- (j) The transition endpoint allows admin-tier to advance ANY transition the schema defines from the current stage; the per-transition `requires` block is still enforced (admin can't skip a `requires.note` step) but the per-stage approver list is bypassed by design.

### Self-correction

Initial Inspector.tsx changes broke the relative import path from the new `WorkflowSection.tsx` (needed 5 `..`s to reach `apps/web/app/admin/_components/ActionForm`, not 4 — `WorkflowSection` is one directory deeper than the `page.tsx` that already imported `ActionForm`). Typecheck caught it on the first run; fixed in place to `../../../../../_components/ActionForm`.

### Validation

- `pnpm typecheck` — 18/18 green. forms-schema + db-supabase + forms-worker + web + auth + workorders / sysadmin / jotform / fleet / signup / damage / performance / dashboard-worker ran fresh; types-only changes propagated through the package graph. The forms-worker + web both ran a clean pass after the relative-import fix.
- `pnpm --filter @splash/web build` — succeeds. `/admin/forms/[id]` 28.4 kB / 133 kB First-Load JS (≈ +2.6 kB vs Brief 95 baseline of 25.8 kB, all WorkflowEditor); `/admin/forms/[id]/submissions/[subId]` 2.63 kB / 108 kB (≈ +1 kB for WorkflowSection).
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — succeeds. Bundle 1081.89 KiB raw / 207.37 KiB gzipped (≈ +15 KiB raw / +3 KiB gzip vs Brief 122 baseline; all workflow code + db helpers). `.tmp-build` cleaned up after.

### Operator post-deploy smoke (deferred per brief Phase 7.5)

1. Run the Phase 2 SQL in the Supabase SQL editor.
2. Push to trigger CF Workers Builds; wait for `splash-forms` + `splash-web` redeploy.
3. Build a test internal-audience form with a Location field + a 3-stage workflow: `submitted` → `site_review` (`site_role: site_email`) → `approved` (terminal) | `denied` (terminal). Configure transitions: from `submitted` → `site_review` (label "Send for review", no requires); from `site_review` → `approved` (label "Approve", `requires: {note: true}`); from `site_review` → `denied` (label "Deny", `requires: {note: true}`). Publish.
4. Fill out the form as a non-approver. Submit. Confirm the freshly-inserted row in Supabase carries `workflow_stage = 'submitted'` and `current_approver_emails = []` (submitted stage's approver source isn't site_role at v1, but it's whatever you set — adjust accordingly).
5. Log in as the configured site_email approver. Open `/admin/forms/{id}/submissions/{subId}` → see "Submitted" stage + the "Send for review" button. Click → modal renders with no required fields → Confirm. Row flips to `site_review` and `current_approver_emails = [site_email]`.
6. Page refreshes via `revalidatePath`; stage now reads "Site review" with Approve / Deny buttons enabled. Click Approve → modal renders with note textarea → fill + Confirm. Row flips to `approved` and `workflow_history` carries two entries.
7. As a non-approver (different RM), open the same submission and try to transition → 403 `not_approver` with the allowed-emails list re-surfaced in the action error message.
8. As super_admin / admin-tier, try transitioning a stuck workflow without being on the approver list → succeeds (escape hatch).

### Out-of-scope (confirmation)

- Notification webhook fire / Pending Approvals dashboard / daily digest — Brief 121.
- Department-approver source — v2 (Brief 120.5).
- Conditional / branching transitions — v2.
- Edit past submissions' workflow — never (versioning forbids).
- Bulk transitions — v2.
- Workflow analytics / SLA reporting — v2.
- No deploy / branch / push performed.

### Diff size estimate

Total ≈ 1700 LOC across the schema package, worker (handler + db + submit + resolver), apps/web builder + detail + worker-fetch + actions, plus docs. Breakdown approximate:

- `packages/forms-schema` — ~250 LOC (types + Zod + superRefine)
- `apps/forms-worker` — ~330 LOC (workflow-resolution.ts + handleTransition + db helper + submit-handler seed + insertSubmissionIdempotent extension)
- `apps/web` — ~900 LOC (WorkflowEditor.tsx ~330, WorkflowSection.tsx ~250, reducer additions ~180, BuilderClient + Inspector + actions + worker-fetch + page.tsx + actions.ts ~140)
- Docs — ~220 LOC (CLAUDE.md glossary paragraph + INDEX.md row + BUILD_STATE.md entry + Outcome)
