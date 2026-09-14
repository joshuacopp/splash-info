# Brief 46: Add `type: "USER"` to MaintainX assignee payload

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Nothing.
**Dependencies:** Brief 42 (the MaintainX helper this brief patches).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-042-maintainx-workorder-on-equipment-related.md
  (the brief this patches — review the assignee const arrays
  in Phase 3.2 to understand the encoding being changed)
- apps/damage-worker/src/maintainx.ts (the file with the bug)

## Context

MaintainX 400'd both form-submit and override-path WO creation
attempts on 2026-05-06 with:

```
{"errors":[{"error":"must have required property type","fieldPath":"assignees.0.type"}]}
```

Brief 42's executor encoded the assignees as `[{ id: <id> }]`,
matching the brief's documented shape. The MaintainX API spec
(operator-confirmed 2026-05-06) actually requires every assignee
object to include `type: "USER"`:

```json
"assignees": [
  { "type": "USER", "id": 409112 },
  { "type": "USER", "id": 426577 }
]
```

The brief's example referenced an abbreviated payload that omitted
`type`; that was a documentation gap the executor inherited from
the brief itself (operator's pasted sample didn't include the field
either). Brief 42's title-and-description payload, priority,
categories, and locationId are all correct — only the assignees
shape is wrong.

The error fires for both the customer-submission MaintainX call
and the GM-modal override call (both paths flow through the same
`createMaintainXWorkOrder` helper). One-line fix in the helper's
assignee const arrays makes both paths work.

## Scope

### Phase 1 — Fix the assignee shape

1.1 In `apps/damage-worker/src/maintainx.ts`, find the
module-level const arrays for assignees. Brief 42 spec'd them as:

```ts
const PRODUCTION_ASSIGNEES = [{ id: 409112 }, { id: 426577 }] as const;
const TEST_ASSIGNEES = [{ id: 443948 }] as const;
```

(Or similarly named — the executor's actual variable names may
differ. Search for `409112` and `443948` literals to find them.)

1.2 Replace with the typed shape MaintainX expects:

```ts
const PRODUCTION_ASSIGNEES = [
  { type: "USER", id: 409112 },  // Brett Sullivan (bsullivan@splashcarwashes.com)
  { type: "USER", id: 426577 }   // Scott Butler (scott.butler@splashcarwashes.com)
] as const;

const TEST_ASSIGNEES = [
  { type: "USER", id: 443948 }   // Josh Copp (josh.copp@splashcarwashes.com)
] as const;
```

Type annotations: if there's an explicit interface for the
assignee shape (e.g., `interface MaintainXAssignee { id: number }`),
extend it to `interface MaintainXAssignee { type: "USER"; id: number }`.
If the type is inferred from `as const`, no separate type change
is needed.

1.3 No other changes to `createMaintainXWorkOrder`, `buildPayload`,
or the call sites in `handleClaimSubmission` / the override
handler. The body shape is built from these const arrays
directly.

### Phase 2 — Update Brief 42's documentation

2.1 In `BRIEFS/brief-042-maintainx-workorder-on-equipment-related.md`,
find the assignee shape documentation in Phase 3.2 and the
reference request body in the Context section. Update both to
include `type: "USER"`. Add a short note like:

> Note: every assignee object MUST include `type: "USER"`.
> Confirmed via MaintainX 400 on 2026-05-06; Brief 46 fixed
> the helper.

This avoids a future executor reproducing the same bug.

2.2 Add a one-line fact to CLAUDE.md under "Working with workers"
near the existing MaintainX entry:

> MaintainX assignee objects require `type: "USER"` alongside
> the user ID. Omitting it returns 400 with
> `assignees.0.type` fieldPath.

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass for all 13 packages.
3.2 `pnpm --filter @splash/damage-worker build` — must succeed.

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 46 row added.

4.2 BUILD_STATE.md: Findings entry noting:
  - The assignee.type field requirement
  - Both customer-submit and GM-override paths affected
  - Outcome: after damage-worker redeploys (CF Workers Builds on
    push), operator should retry an equipment_related=yes
    submission AND a GM modal override and confirm both produce
    a `maintainx_workorder_created` activity log entry instead
    of a `maintainx_workorder_failed` one

## Out of scope

- Changing any other field of the MaintainX payload (title,
  description, priority, categories, locationId). Those are
  correct and tested via the 400 error that ONLY mentions
  `assignees.0.type`.
- Changing the fail-soft posture or dedupe logic.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/damage-worker/src/maintainx.ts` assignee arrays include
  `type: "USER"` on each entry
- Brief 42's documentation reflects the corrected shape
- CLAUDE.md notes the requirement
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff (likely 4-6 lines across the helper + the brief + CLAUDE.md)
- Confirmation that the type signature compiles cleanly
- Validation results

## Outcome

**Files modified:**

- `apps/damage-worker/src/maintainx.ts` — `ASSIGNEES_PRODUCTION` and
  `ASSIGNEES_TEST` const arrays each entry now carries
  `type: "USER"` alongside the user `id`. `assigneesByMode`'s return
  type narrowed from `ReadonlyArray<{ id: number }>` to
  `ReadonlyArray<{ type: "USER"; id: number }>`. JSDoc on
  `ASSIGNEES_PRODUCTION` extended with the rationale + Brief 46
  cross-reference so a future reader doesn't drop the field.
  Inline trailing-comments retained for grep-ability when an
  assignee leaves the company. No other helper code touched —
  `buildPayload`, `createMaintainXWorkOrder`, `extractWorkOrderId`,
  the call sites in `handleClaimSubmission`, and the override
  helper `tryCreateMaintainXIfMissing` all consume the array
  unchanged.
- `BRIEFS/brief-042-maintainx-workorder-on-equipment-related.md` —
  the JSON example in the Context section now shows the
  `type: "USER"` shape and includes a "must include `type: USER`"
  note pointing at Brief 46. Phase 3.2's bullet-list assignee
  examples updated to the corrected shape with the same note.
- `CLAUDE.md` — appended a one-line fact at the end of the
  "MaintainX integration (Brief 42)" entry under "Working with
  workers": `MaintainX assignee objects require type: "USER"
  alongside the user ID. Omitting it returns 400 with
  assignees.0.type fieldPath (Brief 46).`
- `BRIEFS/brief-046-maintainx-assignee-type-field.md` — Status set
  to `Completed (2026-05-06)`, Started/Completed dates filled,
  this Outcome section.
- `BRIEFS/INDEX.md` — Brief 46 row added.
- `BUILD_STATE.md` — Last updated bumped, Findings entry added.

**Files created:** none.

**Files deleted:** none.

**Decisions made on operator's behalf:**

1. **Type narrowing on `assigneesByMode`** — the brief left the
   choice of "extend a separate `interface MaintainXAssignee`" vs.
   "let `as const` infer the shape" up to the executor based on the
   actual code. The current code had no separate interface; the
   return type was inline-annotated as
   `ReadonlyArray<{ id: number }>`. I tightened that inline
   annotation to `ReadonlyArray<{ type: "USER"; id: number }>` so
   the helper's contract documents the requirement at the function
   boundary too (not only at the const). No new `interface`
   introduced — minimal, in-line, matches the existing style.
2. **JSDoc note placement** — extended the existing
   `ASSIGNEES_PRODUCTION` JSDoc rather than adding a separate
   block comment. The note ("Every object MUST include
   `type: USER`; MaintainX 400s otherwise with `assignees.0.type`
   fieldPath (confirmed 2026-05-06, Brief 46)") sits where someone
   editing the array will read it.
3. **Comment style** — Brief 42's existing module-level header
   comment still lists the assignees by ID + email but doesn't
   mention the `type` field. I left that header untouched (the
   const arrays' inline trailing-comments + the new JSDoc carry
   the new info, and the header comment is already 17 lines —
   bloating it for one more fact would clutter the file). The
   header still answers "who is 409112?", which is what it's for.
4. **No new tests / probes added** — the brief was a one-line
   schema fix; the operator will exercise the live MaintainX 400
   → 200 transition on the next damage-worker redeploy. Headless
   can't reach the live MaintainX API.

**Latent issues / forward flags:**

- **Operator must redeploy damage-worker** — CF Workers Builds
  triggers on push to `main`, so the next git commit/push will
  redeploy. After redeploy, retry an `equipment_related = yes`
  customer submission AND a GM modal override on a claim with
  `equipment_related = 0`. Each path should produce a
  `[maintainx] work order created` (or similar) entry in the
  claim's activity log instead of `[maintainx] failed: MX 400:
  ...assignees.0.type...`.
- **Other field-shape gaps from MaintainX docs may still lurk** —
  Brief 42's JSON example (and the operator's pasted sample that
  the brief was built from) omitted `type` on every assignee
  entry; that gap survived a brief, an executor, and a code
  review. The 400 was the first signal. If MaintainX adds new
  required fields in the future (e.g., on `categories`,
  `priority`), the same fail-soft + activity-log path will catch
  it and the operator will see another `[maintainx] failed`
  entry. No defensive change here — the helper is already
  fail-soft, and pre-emptively guessing field shapes from
  incomplete docs would just trade one bug for a different one.
- **Mode-switch unchanged** — `MAINTAINX_MODE` defaults to
  `"test"` in `apps/damage-worker/wrangler.toml`. After the fix
  is verified in test mode (WO assigned to Josh only), the
  operator must flip the var to `"production"` to start paging
  Brett + Scott. That's a separate config change, not gated by
  this brief.
- **`buildPayload` echo in `MaintainXResult.request`** — the
  helper's result includes the full request body for audit/log
  purposes. Activity log entries previously logged the
  pre-Brief-46 (broken) shape; post-redeploy the logged shape
  will include the new `type: "USER"` entries. No migration
  needed — the column is plain text.

**Validation:**

- `pnpm typecheck` — ✅ 13/13 packages successful (2.518s, 12
  cache hits, fresh build on `@splash/damage-worker` only — the
  one package modified). The narrowed `assigneesByMode` return
  type compiled cleanly (the `as const` assertion already pinned
  `type` to the literal `"USER"`, so the new annotation matches
  the inferred shape).
- `pnpm --filter @splash/damage-worker build` — N/A; the worker
  has no `build` script (its `package.json` has only `dev`,
  `deploy`, `typecheck`, `lint`, `clean`). Workers bundle at
  deploy time via wrangler. Equivalent dry-run validation:
  `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run --outdir=.wrangler/dry-run` — ✅ succeeded (Total
  Upload 1685.75 KiB / gzip 381.94 KiB; bindings DB / R2_BUCKET
  / IMAGES / MAINTAINX_MODE="test" / MAINTAINX_BASE_URL /
  APPS_WEB_BASE_URL all resolved). Bundle assembles without
  diagnostics.

**Diff summary** (5 lines of meaningful code change):

```
- const ASSIGNEES_PRODUCTION = [{ id: 409112 }, { id: 426577 }] as const;
+ const ASSIGNEES_PRODUCTION = [
+   { type: "USER", id: 409112 },  // Brett Sullivan (bsullivan@splashcarwashes.com)
+   { type: "USER", id: 426577 }   // Scott Butler   (scott.butler@splashcarwashes.com)
+ ] as const;

- const ASSIGNEES_TEST = [{ id: 443948 }] as const;
+ const ASSIGNEES_TEST = [
+   { type: "USER", id: 443948 }   // Josh Copp (josh.copp@splashcarwashes.com)
+ ] as const;

- function assigneesByMode(mode: "production" | "test"): ReadonlyArray<{ id: number }>
+ function assigneesByMode(mode: "production" | "test"): ReadonlyArray<{ type: "USER"; id: number }>
```

Plus JSDoc/comment additions on `ASSIGNEES_PRODUCTION`, plus the
brief-042 + CLAUDE.md doc edits described above.

**Operator action items (post-merge):**

1. After CF Workers Builds redeploys damage-worker on push, find
   a claim with `equipment_related = no` in "Pending GM Review"
   and click an Approve transition through the equipment-related
   modal (Brief 43 path). Verify the activity log gets a
   `[maintainx]` success entry instead of the `assignees.0.type`
   400.
2. Submit a brand-new customer claim with `equipment_related = yes`
   (Brief 42 path). Verify the same: `[maintainx]` success entry
   on the claim's activity log; the WO surfaces in MaintainX.
3. With `MAINTAINX_MODE = "test"`, the WO will be assigned to
   Josh only. Once verified, flip
   `MAINTAINX_MODE = "production"` in
   `apps/damage-worker/wrangler.toml` (or via the CF dashboard
   var) to start paging Brett + Scott.
