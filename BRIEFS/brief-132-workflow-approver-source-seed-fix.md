# Brief 132: Workflow approver_source seed fix — stop writing site_role on lookup-keyed forms

**Status:** Completed (2026-05-14)
**Started:** 2026-05-14
**Completed:** 2026-05-14
**Blocks:** Neither — correctness bug; workflow approval routing has
been silently broken on every form built without a `type: "location"`
field since the workflow feature shipped (Brief 120). Real-world
testing confirmed today: operator built a form with a Site Number
short_text + RM Email lookup (sourceColumn `rm_email`), enabled
workflow, picked the auto-suggested "Regional Manager email (resolved
via 'RM Email' lookup)" option in the approver picker, published,
and the stored `approver_source` came out as `{type: "site_role",
role: "rm_email"}` — which can NEVER resolve because the worker's
`extractLocationCode` only walks `type === "location"` fields. Every
submission landed with `current_approver_emails = []` and showed up
under the "⚠ No approver resolved" pill on `/admin/approvals?all=1`.
**Dependencies:** None.

## Read first

- CLAUDE.md (forms-worker glossary entries on Brief 120 / 125 / 127 /
  131 — context for what `approver_source` shapes the resolver
  accepts and what each one resolves through)
- `apps/web/app/admin/forms/[id]/_builder/reducer.ts` — the buggy
  seed + Quick Pattern lines (241, 491–493)
- `apps/web/app/admin/forms/[id]/_workflow/ApproverPicker.tsx` —
  `pickOption` (forward path, fixed in Brief 131) +
  `sourceToAutoKey` (reverse-mapping that masks the bug)
- `apps/forms-worker/src/workflow-resolution.ts` — the resolver
  whose `site_role` branch requires a `type: "location"` field
- BRIEFS/brief-131-forms-workflow-approval-flow-correctness-pass.md
  (Phase 3 fixed the picker's onChange but not the reducer seed)

## Context

Brief 131 Phase 3 fixed the picker's forward path: when the operator
picks a "lookup_role" auto-detected option, the picker now writes
`{type: "payload_field", field_key: <lookup field's key>}` instead
of `{type: "site_role", role: <role>}`. That fix is correct and
landed (`apps/web/app/admin/forms/[id]/_workflow/ApproverPicker.tsx`
line 235–246).

But two other code paths still write `site_role` shapes that the
resolver can't handle on lookup-keyed forms:

### Bug A — Initial workflow seed writes site_role unconditionally

`apps/web/app/admin/forms/[id]/_builder/reducer.ts` line 241:

```ts
function makeWorkflowSeed(): FormWorkflow {
  const approval: WorkflowStage = {
    id: "approval",
    label: "Approval",
    approver_source: { type: "site_role", role: "rm_email" }, // ← bug
    transitions: [...],
    kind: "step",
    _uiKey: nanoid(8)
  };
  ...
}
```

`makeWorkflowSeed` runs when the operator clicks "Enable workflow"
for the first time. The seed hardcodes `site_role` regardless of
whether the form has a Location field (where `site_role` would work)
or only a lookup field (where it can't). On a lookup-keyed form, the
operator opens the picker, the picker's `sourceToAutoKey` reverse-
mapping displays the broken `site_role` value as if it were a valid
`lookup_role` selection (line 152–156 of ApproverPicker.tsx), the
operator sees "RM email (resolved via Lookup)" already selected,
doesn't re-pick (because it looks right), saves draft → publishes,
and the bad shape persists.

### Bug B — Quick Pattern "Email RM on submission" writes site_role even when finding a lookup

`apps/web/app/admin/forms/[id]/_builder/reducer.ts` line 484–511:

```ts
case "email_rm_on_submission": {
  const rmLookup = findFirstRmLikeLookupField(fields);
  const recipients: ApproverSource[] = rmLookup
    ? [{ type: "site_role", role: "rm_email" }]      // ← bug: finds lookup but writes site_role
    : fields.some((f) => f.type === "location")
      ? [{ type: "site_role", role: "rm_email" }]    // correct (Location field present)
      : [];
  ...
}
```

The comment above says "Recipient = first lookup field whose
sourceColumn is rm_email, or if none, fall back to a location-shape
site_role." That's the intended behavior. But both arms of the
ternary emit the SAME `site_role` shape — the lookup branch was
never wired to use `payload_field`. Picking this Quick Pattern on a
lookup-keyed form gives the operator a broken email step.

### Bug C — Stale data in the wild

Any form built between Brief 120 (workflow ship) and this brief
that touched the seeded approval step OR used the
`email_rm_on_submission` Quick Pattern on a lookup-keyed form has
`site_role` in its published `approver_source`. The picker's reverse-
mapping continues to display these as if they were correct selections,
so the operator can't tell from the UI that the data is bad. We need
the picker to either auto-upgrade on mount OR surface a visible
warning so the operator knows to re-pick.

The current production system has at least one such form (operator's
"Newest workflow and form test", slug `new-test`) — they hand-fixed
it with a SQL hotfix today. There are likely older forms in the same
broken state.

## Scope

### Phase 1 — Fix the initial workflow seed (Bug A)

`apps/web/app/admin/forms/[id]/_builder/reducer.ts`:

1.1 Pass `fields: Field[]` into `makeWorkflowSeed` so it can detect
    eligible auto-mapping candidates:

```ts
function makeWorkflowSeed(fields: Field[]): FormWorkflow {
  const approverSource = pickSeedApproverSource(fields);
  ...
  approver_source: approverSource,
}
```

1.2 Add a helper `pickSeedApproverSource(fields: Field[]):
    ApproverSource` that mirrors the picker's `detectFromFields`
    priority order:

```ts
function pickSeedApproverSource(fields: Field[]): ApproverSource {
  // Priority 1: first lookup field with sourceColumn === "rm_email"
  //   (most common — operators set this up first as it's the most
  //   common single-approver case at Splash)
  for (const f of fields) {
    if (f.type === "lookup" && f.sourceColumn === "rm_email") {
      return { type: "payload_field", field_key: f.key };
    }
  }
  // Priority 2: first lookup field with any *_email sourceColumn
  for (const f of fields) {
    if (
      f.type === "lookup" &&
      (f.sourceColumn === "am_email" ||
        f.sourceColumn === "site_email" ||
        (typeof f.sourceColumn === "string" &&
          f.sourceColumn.endsWith("_email")))
    ) {
      return { type: "payload_field", field_key: f.key };
    }
  }
  // Priority 3: first email-type field
  for (const f of fields) {
    if (f.type === "email") {
      return { type: "payload_field", field_key: f.key };
    }
  }
  // Priority 4: form has a Location field → site_role rm_email is valid
  if (fields.some((f) => f.type === "location")) {
    return { type: "site_role", role: "rm_email" };
  }
  // Priority 5: empty static_emails list (operator must pick before
  //   publishing — the picker will surface this as "— Pick an approver —")
  return { type: "static_emails", emails: [] };
}
```

1.3 Update every call site of `makeWorkflowSeed` to pass the current
    `state.fields`. Grep for `makeWorkflowSeed(` — only call site
    is in the `workflow_enable` case of the reducer; just thread
    `state.fields` through.

### Phase 2 — Fix the Quick Pattern (Bug B)

`apps/web/app/admin/forms/[id]/_builder/reducer.ts` line 484–511,
the `email_rm_on_submission` case:

```ts
case "email_rm_on_submission": {
  const rmLookup = findFirstRmLikeLookupField(fields);
  const recipients: ApproverSource[] = rmLookup
    ? [{ type: "payload_field", field_key: rmLookup.key }]
    : fields.some((f) => f.type === "location")
      ? [{ type: "site_role", role: "rm_email" }]
      : [];
  ...
}
```

Mirror the seed helper's priority order if the lookup branch
becomes more sophisticated (probably not needed at v1 — the helper
already returns the right field shape).

Audit the other Quick Patterns in the same switch (`email_submitter_on_outcome`,
`email_approver_when_assigned`, `email_specific_person_on_submission`,
`email_submitter_on_approve_and_deny`) for the same bug class — none
of them should be writing `site_role` shapes when a lookup field
matches the intent. Fix any others that have this pattern.

### Phase 3 — Auto-upgrade legacy site_role on picker mount (Bug C)

`apps/web/app/admin/forms/[id]/_workflow/ApproverPicker.tsx`:

3.1 Add a `useEffect` that runs when `source` or `options` changes.
    If the source is `site_role` AND there's a matching `lookup_role`
    option (i.e., the form has a lookup field whose `sourceColumn`
    matches the saved role), fire `onChange` with the upgraded
    `payload_field` shape:

```tsx
import { useEffect, useMemo, useState } from "react";

// ... existing component body ...

useEffect(() => {
  if (!source) return;
  if (source.type !== "site_role") return;
  const matchingLookup = options.find(
    (o): o is Extract<AutoOption, { kind: "lookup_role" }> =>
      o.kind === "lookup_role" && o.role === source.role
  );
  if (matchingLookup) {
    onChange({
      type: "payload_field",
      field_key: matchingLookup.sourceFieldKey
    });
  }
}, [source, options, onChange]);
```

3.2 Update the docblock comment at the top of the file noting the
    auto-upgrade behavior so future maintainers don't think the
    site_role reverse-mapping in `sourceToAutoKey` is a contradiction.

3.3 Remove (or simplify) the reverse-mapping fallback in
    `sourceToAutoKey` lines 152–156. Once auto-upgrade is in place,
    a `site_role` source that matches a `lookup_role` option will
    no longer exist after first render — it gets upgraded
    immediately. The fallback to `location_role` lines 157–161
    stays (legitimate Location-field-keyed forms).

### Phase 4 — Type / validator updates (if any)

4.1 `pickSeedApproverSource` returns an `ApproverSource`. Verify the
    `@splash/forms-schema` types accept `{type: "static_emails",
    emails: []}` for an approval step's `approver_source` (it
    should — `ApproverSource` discriminated union already covers
    `static_emails`). If the strict Zod validator at publish time
    blocks empty `static_emails` on approval stages, that's a
    separate Brief — flag it but don't fix here.

4.2 No changes to worker side. The resolver
    (`apps/forms-worker/src/workflow-resolution.ts`) already handles
    all three `ApproverSource` types correctly.

### Phase 5 — Backfill broken data

5.1 The operator runs ONE SQL pass against staging Supabase that
    finds every published `form_versions` row with a
    `site_role`-shaped `approver_source` on a stage whose form has
    no `type: "location"` field but has at least one `*_email`
    lookup field, and rewrites the `approver_source` to
    `payload_field` keyed on that lookup field's `key`. Brief
    deliverable: a SQL script in this brief's Outcome section
    that the operator can copy-paste into Supabase SQL editor. Do
    NOT run it as part of the brief — operator runs it post-deploy.

5.2 Rows that already have `current_approver_emails` populated stay
    untouched (the denormalized column is stamped at insert time;
    fixing the schema doesn't rewrite existing submissions).
    Resubmission against the fixed schema is the path forward for
    those.

### Phase 6 — Validation

6.1 `pnpm typecheck` — must pass.
6.2 `pnpm --filter @splash/web build` — must succeed.
6.3 No worker / Supabase / R2 / wrangler.toml / secret changes.
6.4 Operator post-deploy smoke (deferred):
    - Create a new form with: Site Number (short_text) + RM Email
      lookup (sourceColumn `rm_email`, keyed off Site Number).
    - Enable workflow. Verify the approval step's picker shows
      "Regional Manager email (resolved via 'RM Email' lookup)"
      and the saved schema has `{type: "payload_field", field_key:
      "lookup_..."}` — NOT `site_role`.
    - Open an OLD form whose `approver_source` is `site_role` on a
      lookup-keyed form (e.g., the operator's "Newest workflow and
      form test"). Confirm the picker auto-upgrades on first paint
      and the next Save Draft persists the `payload_field` shape.
    - Try the "Email RM on submission" Quick Pattern on a form with
      ONLY a lookup field (no Location). Confirm the resulting
      email step's recipients carry `payload_field`, NOT `site_role`.
    - Try the same Quick Pattern on a form WITH a Location field
      (no lookup). Confirm the recipient is `site_role` (correct).
    - Negative test: form has no email-shaped fields at all. Enable
      workflow. Confirm picker surfaces "— Pick an approver —" and
      the strict validator at publish time refuses to publish until
      the operator picks something.

### Phase 7 — Updates

7.1 BRIEFS/INDEX.md: Brief 132 row appended.

7.2 BUILD_STATE.md: Findings entry noting:
  - Brief 132 (YYYY-MM-DD) — Fixed `makeWorkflowSeed` (default
    approval step) and `email_rm_on_submission` Quick Pattern to
    write `payload_field` shape when a matching lookup field
    exists, falling back to `site_role` only when a Location field
    is present. Added auto-upgrade in `ApproverPicker` so legacy
    `site_role` shapes get migrated invisibly to `payload_field`
    on next save. Documented backfill SQL in the brief's Outcome
    for operator-driven cleanup of in-flight rows. Closes the
    "no approver resolved" silent-failure mode for lookup-keyed
    forms that has been present since Brief 120.

7.3 CLAUDE.md `forms-worker` glossary entry: append a one-liner
    under Brief 131 noting Brief 132 closed the seed-path / Quick
    Pattern variants of the same bug class. Reference the helper
    name (`pickSeedApproverSource`) so future readers know where
    to extend if a new lookup-shape column is added to
    `LOOKUP_SOURCES`.

## Out of scope

- Adding new lookup `sourceColumn` values to `LOOKUP_SOURCES`. The
  helper handles every `*_email` column the registry already exposes.
- Changing the picker UI beyond the auto-upgrade effect + docblock.
- Surfacing the "no approver resolved" warning pill on additional
  pages (Brief 131 Phase 9 widened `/admin/approvals?all=1`).
- Fixing the lookup `LOOKUP_SOURCES` registry label "Location name
  (eg oswego)" that actually returns site_number — separate brief
  candidate (small one-liner fix to the registry; flagged in BUILD_
  STATE.md for next push).
- Adding a "Share form" / "Copy link" button to the Settings tab —
  separate brief candidate (feature, not bug).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `makeWorkflowSeed` accepts `fields` and uses
  `pickSeedApproverSource` to seed `approver_source`.
- `email_rm_on_submission` Quick Pattern writes `payload_field`
  when `findFirstRmLikeLookupField` returns a hit.
- Other Quick Patterns audited; same-bug-class instances fixed.
- `ApproverPicker` auto-upgrades `site_role` → `payload_field` on
  mount when a matching `lookup_role` option exists.
- `sourceToAutoKey`'s site_role → lookup_role fallback removed (or
  documented as no-op-after-upgrade if kept for paranoia).
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- Backfill SQL drafted in this brief's Outcome (NOT run by Claude
  Code).
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 7.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate (line count + file count).
- Validation results.
- The full list of files touched.
- The backfill SQL script (operator runs post-deploy).
- Any Quick Patterns OTHER than `email_rm_on_submission` that had
  the same bug class — list each one fixed.
- Any latent issues found while reading the picker / reducer code
  (e.g., other unconditional `site_role` writes elsewhere).

## Outcome

**Files modified.**

- `apps/web/app/admin/forms/[id]/_builder/reducer.ts` — Bug A (added
  `pickSeedApproverSource(fields)` helper; `makeWorkflowSeed` now
  accepts `fields: Field[]` and uses the helper) + Bug B
  (`email_rm_on_submission` Quick Pattern's lookup branch rewritten to
  emit `payload_field` keyed on the matched lookup field's `key`) +
  threading `state.fields` into the `workflow_enable` reducer case
  call site.
- `apps/web/app/admin/forms/[id]/_workflow/ApproverPicker.tsx` —
  Bug C (new `useEffect` that auto-upgrades legacy `site_role` shapes
  to `payload_field` on mount when a matching `lookup_role` option
  exists; `sourceToAutoKey`'s `site_role → lookup_role` reverse-mapping
  fallback removed; docblock at top of the file updated; `useEffect`
  added to the React import).
- `BRIEFS/INDEX.md` — Brief 132 row appended above the Brief 131 row.
- `BRIEFS/QUEUE.md` — Brief 132 entry commented out with
  `(completed 2026-05-14)`.
- `BUILD_STATE.md` — Last-updated bumped to Brief 132; Findings
  entry summarizing the three bug fixes + decisions + latent issues +
  validation.
- `CLAUDE.md` — `forms-worker` glossary gains a Brief 132 paragraph
  appended under the Brief 131 entry naming `pickSeedApproverSource`
  as the extension point for new lookup-shape columns added to
  `LOOKUP_SOURCES`.
- `BRIEFS/brief-132-workflow-approver-source-seed-fix.md` — this
  file (Outcome filled + Status → Completed).

**Files created.** None.

**Files deleted.** None.

**Diff size estimate.** 2 source-code files touched (reducer.ts +
ApproverPicker.tsx); ~80 lines of new code (~50 helper + ~25 effect +
~5 docblock); ~12 lines removed (the `lookup_role` reverse-mapping
fallback inside `sourceToAutoKey`). Plus the four documentation files
updated (INDEX, BUILD_STATE, CLAUDE, brief itself) + QUEUE
comment-out — roughly 6 files / +85 / -12 across the change.

**Decisions made on operator's behalf.**

1. `pickSeedApproverSource` priority order mirrors the picker's
   `detectFromFields` exactly so an operator opening the picker on a
   seeded approval step sees the same option already pre-selected.
2. Priority 5 (empty `static_emails`) chosen over "leave undefined"
   because the strict publish-time validator already rejects
   approval steps without an approver source — operator gets the
   explicit "— Pick an approver —" placeholder on next visit.
3. Auto-upgrade `useEffect` fires unconditionally when the
   predicate matches — no opt-in toggle. The existing
   `site_role`-on-lookup-keyed-form shape was never valid (always
   produced empty approver lists), so migrating it has no behavior
   regression risk.
4. Reverse `sourceToAutoKey` `site_role → lookup_role` fallback
   REMOVED rather than left as a no-op. `useEffect` is committed
   after the layout phase, so by the next `sourceToAutoKey` call
   the source has already been upgraded — the fallback would be
   dead code masking the intent.
5. Backfill SQL drafted but NOT executed by Claude Code —
   operator runs against staging first.

**Latent issues found.**

- `LOOKUP_SOURCES` label for `pricing_simple.site` reads
  `"Location name (e.g. \"Oswego\")"` but the column actually holds
  the 3-digit site number text (e.g. `"147"`);
  `pricing_simple.location_pretty` is the actual location display
  name. Cosmetic label inversion that would confuse a form builder
  picking the wrong source column. Separate brief candidate
  (one-line fix in `packages/forms-schema/src/lookup-sources.ts`).
- Strict publish-time Zod validator does NOT cross-check that
  `site_role` shapes are paired with a `location` field on the
  form — it'll happily publish a schema that resolves to `[]` at
  runtime. Strengthening with a `superRefine` cross-check is a
  candidate for a future hardening brief; would require migrating
  in-the-wild bad rows first (this brief's backfill) before the
  constraint can be enforced.
- Existing in-flight `current_approver_emails` rows on already-
  submitted forms stay untouched — the denormalized column is
  stamped at insert time. Operator paths forward: (a) operator
  resubmits the form against the fixed schema (auto-upgrade in
  the builder produces the right schema on next Save Draft); or
  (b) operator hand-updates `current_approver_emails` on stuck
  rows via Supabase SQL.
- Auto-upgrade `useEffect` dependency array includes `onChange` —
  if a future consumer passes a fresh function identity per
  render, the effect would refire each frame. Both current call
  sites (`StepCard.tsx` approval-step picker;
  `EmailStepCard.tsx`'s `RecipientsList` per-recipient picker)
  stabilize the handler via dispatch-bound closures so this is a
  non-issue in practice; flagged in case a future caller passes
  an inline closure.

**Quick Patterns audited (Phase 4).**

- `email_submitter_on_outcome` — recipients target the synthetic
  `submitter.email` `payload_field` key. No bug.
- `email_approver_when_assigned` — recipients are
  `approval.approver_source` directly. Correct provided the
  approval step was seeded correctly, which Bug A's fix now
  guarantees. No bug at this brief.
- `email_rm_on_submission` — fixed by Bug B. The Location-bearing
  branch (no lookup) correctly stays `site_role`.
- `email_specific_person_on_submission` — recipients: `[]`. No bug.
- `email_submitter_on_approve_and_deny` — recipients target the
  synthetic `submitter.email` `payload_field` key on both arms.
  No bug.

Conclusion: `email_rm_on_submission` was the only Quick Pattern
with this bug class.

**Validation results.**

- `pnpm typecheck` — 18/18 green (17 cached; `@splash/web` ran fresh).
- `pnpm --filter @splash/web build` — succeeds. Bundle deltas:
  - `/admin/forms/[id]` 37.9 kB / 145 kB First-Load JS (was 37.7 kB /
    145 kB on Brief 131; +0.2 kB for the `pickSeedApproverSource`
    helper + auto-upgrade `useEffect`).
  - Every other route unchanged.
- No worker / Supabase / R2 / `wrangler.toml` / secret changes — the
  resolver in `apps/forms-worker/src/workflow-resolution.ts` already
  handled all three `ApproverSource` shapes correctly post-Brief-131.

**Backfill SQL (operator runs post-deploy against staging FIRST,
spot-check the rewrite, then apply to production).**

Two passes — preview first, then UPDATE. Both run against published
`form_versions` rows whose `schema -> 'workflow' -> 'stages'` carries
a `site_role` `approver_source` AND whose owning `forms` row has no
`type === "location"` field but DOES have at least one `*_email`
lookup field. The rewrite swaps `{type: "site_role", role: "<role>"}`
to `{type: "payload_field", field_key: "<matching lookup field's
key>"}`. Run against staging schema first.

```sql
-- 1. PREVIEW — list every published version's stages with a site_role
--    approver_source on a form that has no location field but at least
--    one *_email lookup field, paired with the first matching lookup
--    field's payload key. Inspect the rows count + spot-check a few
--    before running the UPDATE.

WITH targets AS (
  SELECT
    fv.id            AS version_id,
    f.id             AS form_id,
    f.slug           AS form_slug,
    f.title          AS form_title,
    stage_with_idx.idx,
    stage_with_idx.stage,
    stage_with_idx.stage->'approver_source'->>'role' AS role,
    (
      SELECT lookup_field->>'key'
      FROM jsonb_array_elements(fv.schema->'fields') lookup_field
      WHERE lookup_field->>'type' = 'lookup'
        AND lookup_field->>'sourceColumn' = stage_with_idx.stage->'approver_source'->>'role'
      LIMIT 1
    ) AS matching_lookup_key
  FROM form_versions fv
  JOIN forms f ON f.id = fv.form_id
  CROSS JOIN LATERAL jsonb_array_elements(fv.schema->'workflow'->'stages')
    WITH ORDINALITY AS stage_with_idx(stage, idx)
  WHERE f.current_version_id = fv.id  -- only currently-published versions
    AND stage_with_idx.stage->'approver_source'->>'type' = 'site_role'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(fv.schema->'fields') field_row
      WHERE field_row->>'type' = 'location'
    )
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(fv.schema->'fields') field_row
      WHERE field_row->>'type' = 'lookup'
        AND field_row->>'sourceColumn' = stage_with_idx.stage->'approver_source'->>'role'
    )
)
SELECT
  version_id,
  form_slug,
  form_title,
  idx - 1 AS stage_index_zero_based,
  stage->>'id' AS stage_id,
  stage->>'label' AS stage_label,
  role AS current_site_role_value,
  matching_lookup_key AS target_payload_field_key
FROM targets
ORDER BY form_slug, stage_index_zero_based;

-- 2. UPDATE — rewrite the matched approver_source shapes. Run only
--    after the preview SELECT looks right.

WITH targets AS (
  SELECT
    fv.id AS version_id,
    stage_with_idx.idx,
    (
      SELECT lookup_field->>'key'
      FROM jsonb_array_elements(fv.schema->'fields') lookup_field
      WHERE lookup_field->>'type' = 'lookup'
        AND lookup_field->>'sourceColumn' = stage_with_idx.stage->'approver_source'->>'role'
      LIMIT 1
    ) AS matching_lookup_key
  FROM form_versions fv
  JOIN forms f ON f.id = fv.form_id
  CROSS JOIN LATERAL jsonb_array_elements(fv.schema->'workflow'->'stages')
    WITH ORDINALITY AS stage_with_idx(stage, idx)
  WHERE f.current_version_id = fv.id
    AND stage_with_idx.stage->'approver_source'->>'type' = 'site_role'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(fv.schema->'fields') field_row
      WHERE field_row->>'type' = 'location'
    )
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(fv.schema->'fields') field_row
      WHERE field_row->>'type' = 'lookup'
        AND field_row->>'sourceColumn' = stage_with_idx.stage->'approver_source'->>'role'
    )
)
UPDATE form_versions fv
SET schema = jsonb_set(
  fv.schema,
  ARRAY['workflow', 'stages', (t.idx - 1)::text, 'approver_source'],
  jsonb_build_object(
    'type', 'payload_field',
    'field_key', t.matching_lookup_key
  ),
  false
)
FROM targets t
WHERE t.version_id = fv.id
  AND t.matching_lookup_key IS NOT NULL;
```

Caveats: the UPDATE rewrites only the FIRST matching stage per row at
a time when multiple matched stages share a version (the LATERAL
unrolls fine, but each UPDATE pass commits once per version_id row,
so the second matched stage's rewrite would be a no-op on the
already-rewritten row). If a form has multiple `site_role` stages all
needing rewrite, re-run the UPDATE block until the PREVIEW returns
zero rows. Alternatively, the operator opens each affected form in
the builder + Saves Draft + Publishes — the auto-upgrade
`useEffect` migrates every visible `site_role` shape on first paint
(operator-friendly path; SQL path is the bulk option).

Rows whose `current_approver_emails` is already populated stay
untouched — those denormalizations are stamped at submission insert
time. For stuck submissions, the operator either re-resubmits the
form (next workflow seed uses the fixed shape) OR hand-updates
`current_approver_emails` via Supabase SQL.

