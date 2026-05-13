# Brief 123: Forms workflow builder UX fixes (focus loss, cascade rename, terminal stages, preview, validators)

**Status:** Completed (2026-05-13)
**Started:** 2026-05-13
**Completed:** 2026-05-13
**Blocks:** Neither — fast-follow polish on Brief 120's workflow
builder. None of the bugs prevent shipping a workflow; they make the
builder hostile to use.
**Dependencies:** Brief 120 (workflow schema + WorkflowEditor + reducer).
Brief 95 (KeyEditor + ActionForm patterns reused here).

## Read first

- CLAUDE.md (`forms-worker` glossary — Brief 120 entry)
- BRIEFS/brief-120-forms-workflow-schema-and-transitions.md
  (the underlying data model + Phase 4's `WorkflowEditor`)
- apps/web/app/admin/forms/[id]/_builder/WorkflowEditor.tsx
  + sibling `ApproverSourceEditor` + per-stage/per-transition row
  components
- apps/web/app/admin/forms/[id]/_builder/reducer.ts
  (workflow reducer actions added by Brief 120 —
  `enable_workflow`, `add_stage`, `update_stage`,
  `update_transition`, etc.)
- apps/web/app/admin/forms/[id]/_builder/KeyEditor.tsx
  (Brief 95 — snake_case sanitization reference)
- packages/forms-schema/src/validators/field-config.ts
  (Brief 120 — `formSchemaSchema.superRefine` workflow validators
  that this brief extends)

## Context

Operator reviewed the post-Brief-120 WorkflowEditor and surfaced
five concrete defects:

1. **Focus loss on every keystroke** — the Stage ID and Display Label
   inputs (and likely the transition Label input) drop focus after
   each character, forcing the operator to re-click into the field
   per keystroke. Classic React anti-pattern: a component defined
   inside a render function, an unstable `key` prop, or a state-tied
   `key` causes the input to remount instead of re-render.
2. **Stage ID is editable but rename doesn't cascade.** Renaming
   `stage_vbpltj` → `rm_approval` updates the stage's own id but
   leaves `default_stage` and every `transition.to` referencing the
   old id, silently breaking the workflow at publish.
3. **"Advance" is a useless default transition label.** Transition
   labels become the button text on the per-submission detail page
   (the actual UX an approver sees). `"Advance"` tells them nothing
   about what the button does.
4. **No terminal-stage model in the builder.** Brief 120's data
   model supports terminal stages (no outgoing transitions, no
   approver_source) but the builder doesn't surface this concept.
   Operators creating a single stage land in a confused state where
   the only transition destination is the stage itself (self-loop).
   There's no obvious way to model "done" / "approved" / "denied"
   states.
5. **No publish-time guardrails** for workflow shape. An operator
   can save and publish a workflow with an orphaned non-terminal
   stage (no transitions out, submissions stuck forever) or with a
   `default_stage` that has no path to any terminal state.

## Scope

### Phase 1 — Fix focus-loss in stage text inputs

Diagnose first. Likely causes (in descending probability):

1. A component is defined inside another component's render body
   (e.g., `function StageEditor() { function StageRow() {...} ... }`)
   so React sees a fresh component identity on every parent render
   → remounts every input. Fix: lift the inner component out to a
   module-level declaration.
2. An unstable `key` prop on the input or its wrapper. Look for
   `key={someValue}` where `someValue` is the value being edited
   (so it changes on every keystroke). Fix: key by `stage.id` /
   `transition.id` (immutable identifiers), never by the value being
   edited.
3. The reducer dispatching a new array reference for `stages` such
   that the entire list re-renders with new identities. Stage `id`
   should be a nanoid generated at `add_stage` time and preserved
   across edits; reducer actions should mutate fields on the
   matching stage object, returning a new top-level array but with
   the same per-stage `id` so list keys stay stable.

Verify focus retention via manual smoke after the fix — type a
multi-character word into each of: Stage ID, Display Label, Transition
Label, ApproverSource static_emails field. Cursor stays in the field
across all keystrokes.

### Phase 2 — snake_case sanitization + cascade rename for stage_id

Mirror the Brief 95 `KeyEditor` pattern:

- On every keystroke, sanitize the stage_id input value via
  `value.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, '')`
  (lowercase → strip non-alphanumeric-underscore → drop leading
  non-letters so the result always matches `^[a-z][a-z0-9_]*$`).
- Dispatch a NEW reducer action `rename_stage(oldId, newId)` that:
  1. Updates `stages.find(s => s.id === oldId).id = newId`.
  2. If `workflow.default_stage === oldId`, updates it to `newId`.
  3. For every stage in `stages`, for every transition in
     `stage.transitions`, if `transition.to === oldId`, updates to
     `newId`.
- Validate uniqueness during sanitization: if `newId` collides with
  another existing stage's id, refuse the rename and surface a
  red-bordered hint "Stage ID must be unique within the workflow."
  Operator picks a different name.

The stable React `id` for keying (Phase 1's stable identity) is a
SEPARATE nanoid stored at `_uiKey` (or similar private field), NOT
the semantic `stage.id`. The semantic stage_id can change; `_uiKey`
never does for the lifetime of the editor. This decoupling is what
lets us rename cleanly without unmounting the editor row.

Cascade should happen as a single reducer dispatch (one
`rename_stage` action that does all three updates atomically) so the
editor renders one consistent state, not three intermediate states.

### Phase 3 — Default transition labels

When `add_transition` runs for a stage:

- Compute the default label from the destination stage's display
  label: `"Move to {destination.label}"`. If no destination is yet
  selected, leave empty.
- When a transition's `to` field changes via the destination
  dropdown, AND the current transition.label is empty OR matches
  the prior default pattern (`/^Move to /`), update the label to
  the new default. If the operator has typed a custom label, leave
  it alone (don't clobber operator edits).
- Placeholder text on the label input: `"e.g. Approve, Decline,
  Send back"`.

Drop the existing `"Advance"` literal entirely.

### Phase 4 — Auto-seed terminal stages on workflow enable

When the WorkflowEditor's "Enable workflow" button is clicked, the
reducer's `enable_workflow` action should NOT create a single
`stage_{nanoid}` stub. Instead, seed three stages:

1. **`{default_stage_id}`** (operator-renameable) — the approval
   step. Default label `"Approval"`. Approver source defaults to
   `site_role: rm_email`. Two default transitions out:
   `"Approve"` → `approved`, `"Decline"` → `denied`.
2. **`approved`** — terminal. Display label `"Approved"`. No
   approver source. No transitions out. `_terminal: true` flag
   (advisory — `_` prefix indicates not persisted to the schema
   JSONB; recomputed from `stages.transitions.length === 0 &&
   !approver_source`).
3. **`denied`** — terminal. Display label `"Denied"`. No approver
   source. No transitions out.

`default_stage` is the first stage's id.

If the operator deletes `approved` or `denied`, that's fine — they
can build their own terminal stages with different names. The
auto-seed is just a starting template, not a hard constraint.

### Phase 5 — Visually mark terminal stages

A stage is terminal when `stage.transitions.length === 0` AND
`!stage.approver_source` (no approver needed because no one needs
to act on a submission resting here).

In the stage row renderer:

- Add a small pill "TERMINAL" next to the stage id, slate-toned
  (`bg-slate-100 text-slate-600`).
- Tint the row background slightly cooler / muted
  (`bg-gray-50/60`) to distinguish from active approval stages.
- Hide the ApproverSource picker entirely (since terminal stages
  have no approver).
- Disable the "+ Add transition" button with a hover title-attr
  hint: `"Terminal stages have no outgoing transitions. Add an
  approver source to convert this back to an approval step."`.

If the operator adds an approver_source to a terminal stage OR
adds a transition out, the stage automatically loses its terminal
status on the next render (the badge disappears, the picker
reappears, the button enables). No explicit "Make terminal" toggle
needed — it's a derived state.

### Phase 6 — Disable self-transitions

In the transition `to` destination dropdown:

- Render every stage in the workflow as an option.
- The CURRENT stage (the one this transition belongs to) is
  rendered as disabled (`<option disabled>`) with the label
  `"{display_label} (current — cannot self-transition)"`.
- If the operator somehow has an existing transition pointing at
  the current stage (e.g., from before this fix), surface a red
  hint under the transition row: `"This transition points to the
  current stage. Pick a different destination or remove this
  transition."` — the publish-time validator from Phase 8 will
  reject it.

### Phase 7 — Workflow preview (Mermaid)

Below the stages list (and above "+ Add stage"), render a small
Mermaid flowchart of the workflow graph.

- Use the `mermaid` library (~250 KB minified; the artifact CDN
  rules from the artifact guide allow Mermaid). Lazy-load via
  dynamic import on the `/admin/forms/[id]` route so the bundle
  cost only hits operators editing workflows.
- Source: convert the workflow's stages + transitions to Mermaid
  flowchart syntax:
  ```
  flowchart LR
    rm_approval[RM Approval]:::approval -->|Approve| approved[Approved]:::terminal
    rm_approval -->|Decline| denied[Denied]:::terminal
    classDef approval fill:#fff,stroke:#1e3a8a,color:#1e3a8a
    classDef terminal fill:#f1f5f9,stroke:#64748b,color:#475569
  ```
- Highlight the `default_stage` node with a thicker border or a
  small "START" annotation.
- Re-renders live as the operator edits. Debounce the Mermaid
  re-render at 300ms to avoid jank.
- Renders nothing (empty div) when workflow is disabled or has
  zero stages.

Read-only preview only — clicking nodes / edges doesn't do
anything. Visual drag-edit graph editor is firmly v2+ and
out of scope.

### Phase 8 — Publish-time validators

Extend `packages/forms-schema/src/validators/field-config.ts`'s
strict `formSchemaSchema.superRefine` for the workflow block:

1. **No orphaned approval stages.** For every stage where
   `transitions.length === 0` AND `approver_source` is set, emit
   a Zod issue: `"Stage '{id}' has an approver but no transitions
   out — submissions would be stuck. Either add a transition or
   remove the approver source to make it a terminal stage."`.
2. **No unreachable terminals.** Build the directed graph from
   `transitions`. BFS from `default_stage`. If no terminal stage
   (zero outgoing transitions, no approver) is reachable, emit:
   `"Workflow has no reachable terminal stage from
   '{default_stage}'. Add a transition path that leads to a
   stage with no outgoing transitions."`.
3. **No self-transitions.** For every stage, for every transition,
   if `transition.to === stage.id`, emit:
   `"Stage '{id}' has a self-referencing transition. Pick a
   different destination."`.
4. **Brief 120's existing validators stay:** no duplicate stage
   ids, default_stage references a real stage, every transition.to
   references a real stage, payload_field.field_key references a
   real form field. Phase 8 adds to those — doesn't replace.

The relaxed DRAFT validator (so operators can save mid-build) does
NOT enforce 1-3; only the strict publish-time validator does.
Brief 120 already wired the draft-vs-strict split.

The publish endpoint surfaces validator errors via the existing
`PATCH /draft` → `POST /publish` Zod-error response shape. apps/web
TopBar's "Publish" button already renders Zod errors inline (Brief
95); these new errors land in the same surface with no apps/web
changes.

### Phase 9 — Validation

9.1 `pnpm typecheck` — must pass.
9.2 `pnpm --filter @splash/web build` — must succeed.
9.3 `pnpm --filter @splash/forms-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up.
9.4 No Supabase / R2 / wrangler.toml / secret changes.
9.5 Operator post-deploy smoke (deferred):
    - Open any form in the builder, enable workflow → three stages
      auto-seed (default approval + approved + denied), default
      stage has two pre-wired transitions.
    - Type "rm_approval" into the Stage ID field of the default
      stage → focus stays in the field across all 11 keystrokes;
      the value is sanitized to lowercase and the underscore is
      preserved.
    - Confirm `default_stage` in the workflow JSON (use a debug
      `<pre>` or just publish + read the version) is now
      `"rm_approval"`, not the original auto-id.
    - Confirm the two transitions out of `rm_approval` (Approve,
      Decline) still point at `approved` and `denied` —
      cascade-rename worked.
    - Edit the "Approve" transition's destination dropdown — the
      current stage `rm_approval` is rendered disabled with the
      "(current — cannot self-transition)" hint.
    - Delete the `denied` stage. Mermaid preview updates live to
      show only `rm_approval → approved`.
    - Try to publish a workflow where `rm_approval` has the
      approver_source set but no transitions out. Publish surface
      shows the orphaned-stage error.
    - Add the `"Approve"` transition back. Publish succeeds.

### Phase 10 — Updates

10.1 BRIEFS/INDEX.md: Brief 123 row appended.

10.2 BUILD_STATE.md: Findings entry noting:
  - Brief 123 (YYYY-MM-DD) — workflow builder UX overhaul: fixed
    focus-loss on stage/transition text inputs (component
    remount bug); stage_id rename now cascades to default_stage
    + transition.to references (snake_case sanitization mirrors
    Brief 95 KeyEditor pattern); terminal stages auto-seed on
    workflow enable (approved/denied default templates) and
    render with TERMINAL badge + suppressed approver picker;
    self-transitions disabled in destination dropdown; Mermaid
    flowchart preview renders live below the stages list;
    publish-time validators added for orphaned approval stages,
    unreachable terminals, self-transitions.

10.3 CLAUDE.md `forms-worker` glossary: extend the Brief 120
paragraph with a Brief 123 follow-up sentence noting the
builder UX improvements.

## Out of scope

- Visual graph EDITING (drag stages around, draw edges by
  clicking nodes). Mermaid preview is read-only. v2 candidate
  if operators want it after using the text editor for a while.
- Conditional transitions (transition allowed only when payload
  field X has value Y). v2 — requires schema additions to the
  Transition type.
- Stage / transition reordering via drag-drop. Brief 120's
  up/down arrows are sufficient for v1.
- Multi-user editing conflict resolution. Workflow drafts inherit
  the form's draft single-editor semantics (Brief 95 didn't
  solve concurrent edits either).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- Stage ID + Display Label + Transition Label inputs retain
  focus across all keystrokes.
- Stage ID renames cascade to default_stage + transition.to
  references atomically.
- New transition default label is `"Move to {dest label}"`
  (not `"Advance"`).
- Enabling a workflow auto-seeds three stages
  (`{default_stage}` + `approved` + `denied`) with two default
  transitions wired.
- Terminal stages render with a `TERMINAL` badge, muted
  background, hidden approver source picker, and disabled
  "Add transition" button.
- Destination dropdowns disable the current stage as an option.
- Mermaid flowchart preview renders below the stages list,
  updates live as edits happen.
- Publish-time strict validator rejects orphaned approval
  stages, unreachable terminals, and self-transitions.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 10.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate.
- Validation results.
- Root cause of the focus-loss bug (which of the three causes
  in Phase 1 it turned out to be).
- Mermaid bundle cost impact on `/admin/forms/[id]` first-load
  JS (was 131 kB pre-this-brief per Brief 95 outcome).
- Any reducer actions added beyond `rename_stage` (e.g., if
  derived terminal-status detection needed its own action or
  if it works purely as a render-time computation).

## Outcome

### Files created
- `apps/web/app/admin/forms/[id]/_builder/WorkflowMermaidPreview.tsx`
  — Lazy-loaded Mermaid client island; debounced 300 ms; builds
  `flowchart LR` source from `workflow.stages` + transitions;
  `securityLevel: "strict"` + `theme: "neutral"`. Renders nothing for
  zero-stage workflows. Failure surface: inline `"Preview failed to
  render: {message}"`.

### Files modified
- `packages/forms-schema/src/types.ts` — `WorkflowStage.approver_source`
  flipped to optional `?:`; new `_uiKey?: string` builder artifact.
- `packages/forms-schema/src/validators/field-config.ts` — both Zod
  variants made `approver_source` optional; strict `superRefine`
  extended with three new issue classes (orphaned approval +
  approval-without-approver mirror, self-transitions, unreachable
  terminals via BFS from `default_stage`).
- `apps/forms-worker/src/submit/index.ts` — default-stage seed guards
  `approver_source` (`if (defaultStage.approver_source) { ... }`);
  terminal default stage seeds `current_approver_emails = []`.
- `apps/forms-worker/src/admin/submissions.ts` — `handleTransition`
  guards both current-stage and destination-stage `approver_source`;
  non-admin caller on terminal current stage returns 403
  `not_approver` with empty `allowed_emails`; terminal destination
  stamps `[]` for `current_approver_emails`.
- `apps/web/app/admin/forms/[id]/_builder/WorkflowEditor.tsx` —
  full rewrite. Stage rows keyed by `stage._uiKey`. New `StageIdInput`
  sub-component with sanitize-on-keystroke + cascade rename dispatch.
  Terminal-stage visual model (TERMINAL pill + muted bg + suppressed
  ApproverSourceEditor + disabled Add Transition). `START` pill on
  default stage. Self-transition disabled in destination dropdown
  via `<option disabled>` with `(current — cannot self-transition)`
  suffix; existing self-transitions get red border + inline hint.
  Mermaid preview rendered below the stages list via
  `next/dynamic({ ssr: false })`. Make terminal / Make approval step
  CTAs.
- `apps/web/app/admin/forms/[id]/_builder/reducer.ts` — new actions
  (`workflow_rename_stage`, `workflow_clear_approver_source`); new
  helpers (`ensureUiKey`, `ensureWorkflowUiKeys`,
  `stripBuilderArtifacts`, `isDefaultishTransitionLabel`,
  `makeWorkflowSeed`); `workflow_enable` flipped to three-stage
  seed; `workflow_add_transition` seeds `label: ""`;
  `workflow_update_transition` auto-relabels `"Move to {dest.label}"`
  on destination change when prior label is empty / default-pattern
  / legacy `"Advance"`.
- `apps/web/app/admin/forms/[id]/_builder/Inspector.tsx` —
  `WorkflowDispatch` extended with `onClearApproverSource` +
  `onRenameStage`.
- `apps/web/app/admin/forms/[id]/_builder/BuilderClient.tsx` —
  wires the new dispatchers; `saveDraftAction` invoked through
  `stripBuilderArtifacts(state.workflow)`.
- `apps/web/package.json` — `mermaid: ^11.4.0` added to
  dependencies. `pnpm install` ran successfully (110 packages added).
- `BRIEFS/INDEX.md` — Brief 123 row appended above Brief 122.
- `BRIEFS/QUEUE.md` — Brief 123 entry marked completed.
- `BUILD_STATE.md` — Last-updated bumped; new top-of-table
  Findings entry for Brief 123.
- `CLAUDE.md` — `forms-worker` glossary Brief 120 entry extended
  with a Brief 123 follow-up paragraph.

### Decisions made on operator's behalf
1. **`_uiKey` lives on `WorkflowStage` itself** rather than in a
   parallel `Map<stageId, uiKey>` inside `BuilderState`. Adding a
   private optional field keeps the data flow simple (every stage
   carries its own identity through reducer actions). Zod's default
   `.strip()` behavior cleans it up at the worker boundary; the new
   `stripBuilderArtifacts` helper does the same client-side as
   defense-in-depth + a self-documenting call site at `saveDraft`.
2. **Cascade rename strictly refuses collisions** rather than the
   softer "show red border, dispatch anyway, let publish catch it"
   model. Keeps the editor's logical invariant clean (no two stages
   share an id at any moment) and matches the brief verbatim. The
   visual reset on a refused keystroke is invisible in practice
   because sanitization produces the same string that was typed.
3. **`approver_source` made optional at TypeScript + Zod**, not a
   sentinel `null` value. Operators conceptually think "this stage
   does NOT have an approver", not "this stage has a null approver".
   `WorkflowStage.approver_source?:` reads naturally; the worker
   call sites guard with `if (stage.approver_source) { ... }` which
   is also natural.
4. **`workflow_enable` seeds `approval` / `approved` / `denied`**
   rather than abstract `default_stage` / `stage_a` / `stage_b` ids.
   Operator-recognizable terms that match common org vocabulary;
   `approval` is the expected rename target (e.g. `rm_approval`,
   `gm_approval`) and the cascade-rename guarantees no broken refs.
5. **"Make approval step" CTA defaults to `static_emails: []`**
   rather than restoring the Brief 120 seed of `static_emails: []`
   verbatim or a `site_role: rm_email` choice. Empty static is the
   safest restoration (no surprise email resolution); operators
   pick the actual source via the radio after.
6. **`MOVE_TO_LABEL_RE = /^Move to /`** uses a prefix match
   rather than exact-match-against-prior-destination's label.
   Tolerates trailing punctuation but treats a complete custom
   label as operator-edited. Imperfect heuristic; documented.
7. **`next/dynamic({ ssr: false })`** for Mermaid lazy-load, not
   a raw `await import("mermaid")` inside an effect. Lets Next
   handle the chunk-split + Suspense boundary cleanly + keeps the
   heavy library out of the OpenNext-on-Workers SSR runtime
   entirely (Mermaid uses browser APIs).
8. **Three Brief 95 KeyEditor utilities inlined** in the
   StageIdInput rather than imported from
   `_field-types/_shared/KeyEditor.tsx`. The KeyEditor is wired
   to the Brief 95 field-key edit path; pulling its component
   into the workflow editor's stage-id rename flow would couple
   two unrelated concerns. The `sanitizeStageId` helper lives in
   `WorkflowEditor.tsx` next to its single caller.

### Latent issues / forward flags
- (a) Visual graph EDITING (drag stages around, draw edges by
  clicking nodes) firmly v2+. The brief is explicit.
- (b) Conditional transitions (transition allowed only when
  payload field X has value Y) v2 — requires schema additions
  to `WorkflowTransition`.
- (c) Stage / transition drag-to-reorder v2 — Brief 120's
  up/down arrows hold for v1.
- (d) Multi-user editing conflict resolution inherited from
  Brief 95 (single-editor draft semantics; not solved here).
- (e) The `MOVE_TO_LABEL_RE` heuristic can produce false
  positives: an operator who types a custom label starting with
  "Move to" loses their custom label when they change
  destination. Acceptable trade-off.
- (f) The "Make terminal" button on the ApproverSourceEditor
  only clears `approver_source` — to make a stage truly terminal
  the operator also needs to remove transitions out (the button
  reflects "convert from approval to terminal-ish", not a
  one-click full conversion). A future polish could pair the
  two actions.
- (g) Mermaid's bundle cost (~250 KB) is real even with
  code-splitting — operators on slow connections see a brief
  "Rendering…" placeholder the first time. Brief explicitly
  accepts this.
- (h) Backward compat: existing workflows saved by Brief 120
  don't carry `_uiKey` — `initialState` generates one on load
  via `ensureWorkflowUiKeys`.
- (i) Existing single-stage workflows from before Phase 4's
  seed change keep working — the seed only applies to fresh
  `workflow_enable` dispatches, not loaded workflows.
- (j) The Brief 121 cron's per-recipient digest still reads
  `current_approver_emails` directly from the column — terminal
  stages naturally have `current_approver_emails = []` from the
  Brief 123 worker guards, so they're filtered out of the
  digest by the existing `neq.{}` predicate. No cron change
  needed.

### Validation
- **`pnpm typecheck`**: 18/18 green. forms-schema + forms-worker
  + web ran fresh after the type changes; others cached.
- **`pnpm --filter @splash/web build`**: succeeds.
  `/admin/forms/[id]` 30.7 kB / 138 kB First-Load JS (was
  28.4 kB / 133 kB at Brief 120 per outcome notes; the +2.3 kB
  route-specific delta covers the cascade-rename logic,
  terminal styling, Mermaid dynamic-import shim, and `_uiKey`
  plumbing — the Mermaid library itself code-splits to a
  separate chunk that stays out of First Load JS).
- **`pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build`**: succeeds. Bundle 1094.24 KiB
  raw / 209.86 KiB gzipped (≈ +3 KiB raw / unchanged gzip vs
  Brief 121 baseline, all worker-side `approver_source`
  optional-guard adds). `.tmp-build` cleaned up after.
- **No Supabase / R2 / wrangler.toml / secret changes**, as
  expected (Phase 9.4).

### Diff size estimate
- ~370 LOC added / ~50 LOC removed across the 8 modified files
  + 1 new file. `WorkflowEditor.tsx` is the largest delta
  (full rewrite from ~500 to ~570 LOC).

### Root cause of focus-loss bug
**Cause #2 from the brief's diagnostic checklist** — Brief 120's
`<StageEditor key={stage.id}>` keyed the row on the same
`stage.id` value that the controlled Stage ID input was editing.
Every keystroke into the Stage ID input dispatched
`workflow_update_stage` which updated `stage.id`, which changed
the React key on the parent StageEditor row, which caused React
to unmount the old StageEditor and remount a fresh one. The new
`<input>` DOM node lost focus because it's not the same element
as the one the user was typing into. Cause #1 (inner-component
remount) and Cause #3 (reducer-array-identity-thrash) were both
ruled out by reading the existing source — `StageEditor`,
`ApproverSourceEditor`, and `TransitionEditor` are all
module-level declarations; the reducer mutates fields on the
matching stage and returns a new top-level array, so identity
churn isn't the issue.

The fix is the `_uiKey` indirection: the stable identity used
for React keying is decoupled from the semantic `stage.id` value
that can change via rename. The same `_uiKey` is also used to
key the destination-dropdown `<option>` lists so the dropdown
DOM is stable across renames.

### Mermaid bundle cost
The `/admin/forms/[id]` First-Load JS bumped from 131 kB to
138 kB (per the Brief 95 outcome baseline of 131 kB). The
route-specific chunk went from 25.8 kB to 30.7 kB. **Mermaid
itself is NOT included in the First Load JS** — it
code-splits to a separate chunk that's loaded on demand via
`next/dynamic({ ssr: false })` when the WorkflowEditor mounts.
Operators who never open a form's builder page never download
the Mermaid bundle. The +5 kB First-Load delta is the
dynamic-import shim, the new reducer actions, the
StageIdInput / terminal-styling / Mermaid-preview-wrapper
React components, and the additional Zod validator code paths
that ship to the strict-validator branch.

### Reducer actions added beyond `rename_stage`
Two beyond the planned `workflow_rename_stage`:
1. **`workflow_clear_approver_source`** — drops `approver_source`
   from a stage entirely (rest-spread destructure pattern). The
   "Make terminal" CTA in the ApproverSourceEditor header
   dispatches this. The brief flagged terminal-status as a
   "derived state" (Phase 5) but the operator-driven transition
   from approval-step to terminal needed an explicit action
   because we can't have the editor magically delete the
   approver_source on its own — that would lose typed emails on
   any keystroke that produces an empty array.
2. Plus the planned `workflow_rename_stage` itself.

Terminal-stage VISUAL state is purely derived at render time
(`stage.transitions.length === 0 && !stage.approver_source`).
No `_terminal` boolean stored. The reducer changes that produce
a terminal-status flip (removing the last transition, clearing
the approver_source, etc.) all happen via existing actions —
the visual reacts automatically on the next render. No new
action needed for that.
