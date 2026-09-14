# Brief 79: Work Orders — rename "Preventive" tab to "Preventative" + filter Preventive WOs more than 90 days overdue

**Status:** Completed (2026-05-09)
**Drafted:** 2026-05-09
**Blocks:** Two cosmetic-but-meaningful adjustments to the Preventive tab on
`/workorders` from operator's 2026-05-09 review.
1. Tab label spelling: operator prefers "Preventative" over "Preventive"
   (operator's framing: "preventive isn't a word"; both are valid English
   synonyms but operator's preference rules — pure label flip, no
   pushback).
2. The Preventive tab is accumulating ancient overdue rows that aren't
   operationally meaningful — old Preventive cycles that were never
   closed in MaintainX clutter the list and push current items off the
   first screen. Anything more than 90 days past `dueDate` should drop
   off the tab.

**Dependencies:**
- Brief 71 (`WorkOrdersTabsClient`, the Reactive/Preventive split, and
  the `bucketByType` helper this brief modifies).
- Brief 73 (`<DueDatePill>` and the dueDate semantics — Preventive's
  `dueDate` is the field this brief filters on).
- Brief 72 (conditional pagination — independent change, no conflict;
  the 90-day filter runs AFTER pagination so the cap math is unaffected).

## Read first

- CLAUDE.md (Work Orders glossary entry — Phase 4 of this brief
  extends it)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-071-workorders-v2-gating-grouping-assignees-types.md
  (the `bucketByType` helper this brief extends + the
  `WorkOrdersTabsClient` tab UI)
- BRIEFS/brief-073-workorders-due-date-pill-and-age-under-priority.md
  (`<DueDatePill>` semantics — overdue computation done in UTC,
  day-floor comparison; this brief's filter mirrors that math)
- apps/workorders-worker/src/index.ts (the worker file gaining the
  90-day filter inside `bucketByType`)
- apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx (the
  client island where the tab label flips — five sites)

## Context

### Why "Preventative" not "Preventive"

Operator preference. Both spellings are valid English (Merriam-Webster
lists "preventative" as a variant of "preventive"); operator's framing
on 2026-05-09 was "preventive isn't a word" — that's incorrect, but
the executor SHOULD NOT push back on the spelling. This is a
user-facing label and the operator's choice rules. Internal state
keys (`activeTab === "preventive"`, `tab === "preventive"`,
`TabKey = "reactive" | "preventive" | "new"`) and MaintainX API
references (`wo.type === "PREVENTIVE"`, the `PREVENTIVE` literal
in `bucketByType`) STAY UNCHANGED. The MaintainX upstream enum is
`PREVENTIVE` (their spelling, their API contract); aligning Splash
internal state to that enum keeps the code grep-able with MaintainX
documentation. This brief flips display labels only.

### Why a 90-day filter

Operator scan-ability. The Preventive tab today shows every open
preventive WO regardless of how far past due — many MaintainX
preventive cycles get auto-spawned and never closed, leaving a
long tail of "Overdue 200+ days" rows that crowd out the WOs an
operator can actually act on. 90 days is the operator-chosen
threshold. WOs more than 90 days past due are still visible in
MaintainX itself; this filter only suppresses them from
`/workorders`.

### Filter location: worker-side, not page-side

Filter inside `bucketByType` (or its caller) on the worker. Worker-
side filtering means:
- The filter runs once per request, not on every render
- The page receives a clean pre-filtered list — no client-side
  date math duplicated across renders
- The truncation banner copy (Brief 72) stays accurate; the
  90-day-overdue rows never count toward the 1000-WO ceiling
- Future surfaces (mobile widget, email digest) consuming
  `GET /workorders/api/list` automatically inherit the filter

Implementation: `bucketByType` accepts the work-orders array and
returns `{ reactive, preventive }`. Add a constant
`PREVENTATIVE_MAX_OVERDUE_DAYS = 90` at module scope. Inside the
loop, when a WO matches `wo.type === "PREVENTIVE"` AND has a
non-null `dueDate` AND that dueDate parses to a valid epoch AND
is more than 90 days in the past (UTC day-floor comparison
matching `<DueDatePill>` semantics), DROP it — don't push to
either bucket. NULL dueDate Preventive WOs are KEPT (operator
can still see undated preventives; they aren't part of the
clutter being trimmed). Reactive WOs are unaffected by the
filter regardless of dueDate.

### Day-floor math (mirror Brief 73)

Brief 73's `<DueDatePill>` does:
```ts
const todayUtc = Math.floor(Date.now() / 86_400_000);
const dueUtc = Math.floor(new Date(dueDate).getTime() / 86_400_000);
const daysOverdue = todayUtc - dueUtc;
```
This brief's filter uses the same shape:
```ts
const dueMs = Date.parse(wo.dueDate);
if (Number.isFinite(dueMs)) {
  const todayUtc = Math.floor(nowMs / 86_400_000);
  const dueUtc = Math.floor(dueMs / 86_400_000);
  if (todayUtc - dueUtc > PREVENTATIVE_MAX_OVERDUE_DAYS) {
    continue; // drop — too far overdue
  }
}
```
Pin `nowMs = Date.now()` once before the loop so all WOs use the
same reference (defensive against loops that span a midnight
boundary at scale). `Date.parse` returns NaN on malformed input;
`Number.isFinite(NaN)` is false, so malformed dueDate rows
implicitly fall through to the kept branch — same posture as
NULL dueDate.

### Tab label flip — five sites in WorkOrdersTabsClient.tsx

Per `Grep` audit on 2026-05-09:
- Line 3 (docblock): "// Brief 71 — Reactive / Preventive tabbed view…" → "// Brief 71 — Reactive / Preventative tabbed view…"
- Line 15 (docblock): "Due column on the Preventive tab only" → "Due column on the Preventative tab only"
- Line 301 (button): `label="Preventive"` → `label="Preventative"`
- Line 393 (`BucketEmptyState`): `tab === "reactive" ? "Reactive" : "Preventive"` → `"Reactive" : "Preventative"`

Lines that DO NOT change (internal state / type references):
- Line 6 (`useState<"reactive"|"preventive"|"new">`)
- Line 39 (`type TabKey = "reactive" | "preventive" | "new"`)
- Line 43 (`preventive: WorkOrdersGroup[]`)
- Line 82 (`tabParam === "preventive"` URL parsing)
- Lines 134, 137, 167, 280, 285, 299, 300, 392, 415, 417 (state, prop
  names, conditionals — all internal)

Plus Brief 73's `<DueDatePill>` docblock and Brief 74's
`NewRequestForm` docblock may reference "Preventive" in comments
— grep them and flip user-facing comment text only. Internal
literals stay.

## Scope

### Phase 1 — Worker-side 90-day overdue filter

**File:** `apps/workorders-worker/src/index.ts`

1. Add a module-scope constant near the other tunables (e.g., next
   to `PRIORITY_NONE_RANK`):
   ```ts
   /**
    * Brief 79 — Preventive WOs whose `dueDate` is more than this many
    * days in the past are dropped from the response. The Preventative
    * tab on /workorders accumulates a long tail of stale auto-spawned
    * MaintainX preventive cycles; this trim keeps the tab focused on
    * what an operator can act on. NULL dueDate / unparseable dueDate
    * Preventive WOs are KEPT — only dated rows past the threshold
    * drop. Reactive WOs are never filtered (their dueDate is
    * MaintainX-auto-set to creation-day and not operationally
    * meaningful).
    */
   const PREVENTATIVE_MAX_OVERDUE_DAYS = 90;
   ```

2. Extend `bucketByType` (currently at L359) to apply the filter:
   ```ts
   function bucketByType(workOrders: RawWorkOrder[]): {
     reactive: RawWorkOrder[];
     preventive: RawWorkOrder[];
   } {
     const reactive: RawWorkOrder[] = [];
     const preventive: RawWorkOrder[] = [];
     const nowMs = Date.now();
     const todayUtc = Math.floor(nowMs / 86_400_000);
     for (const wo of workOrders) {
       if (typeof wo.type === "string" && wo.type === "PREVENTIVE") {
         // Brief 79 — drop preventives more than 90 days overdue.
         if (typeof wo.dueDate === "string" && wo.dueDate.length > 0) {
           const dueMs = Date.parse(wo.dueDate);
           if (Number.isFinite(dueMs)) {
             const dueUtc = Math.floor(dueMs / 86_400_000);
             if (todayUtc - dueUtc > PREVENTATIVE_MAX_OVERDUE_DAYS) {
               continue;
             }
           }
         }
         preventive.push(wo);
       } else {
         reactive.push(wo);
       }
     }
     return { reactive, preventive };
   }
   ```

3. Update the `bucketByType` docblock (L352-L358) to mention the
   filter:
   ```ts
   /**
    * Canonical filter is `wo.type === "PREVENTIVE"`. Everything else
    * (REACTIVE, CYCLE_COUNT, null, unknowns) lands in the Reactive
    * bucket — operators day-to-day work the reactive queue. If
    * MaintainX adds new preventive-flavored types (e.g.
    * "PREVENTIVE_DAILY"), widen this rule to
    * `type?.startsWith("PREVENT")` after operator confirmation.
    *
    * Brief 79: Preventive WOs whose `dueDate` is more than
    * `PREVENTATIVE_MAX_OVERDUE_DAYS` past today (UTC day-floor) are
    * dropped — they don't land in either bucket. NULL / malformed
    * dueDate Preventive WOs are kept.
    */
   ```

4. Add an observability log line at the call site so the dropped
   count surfaces in CF Workers Logs. Modify the existing console.log
   at L316-L318 to include the dropped count, OR add a sibling line:
   ```ts
   const droppedCount = result.workOrders.filter(
     (wo) =>
       typeof wo.type === "string" &&
       wo.type === "PREVENTIVE" &&
       typeof wo.dueDate === "string" &&
       Number.isFinite(Date.parse(wo.dueDate)) &&
       Math.floor(Date.now() / 86_400_000) -
         Math.floor(Date.parse(wo.dueDate) / 86_400_000) >
         PREVENTATIVE_MAX_OVERDUE_DAYS
   ).length;
   ```
   That's clearer than threading a return value out of `bucketByType`
   for one log line. If it feels redundant to walk the array twice,
   thread the count via a third return field on `bucketByType`
   (`{ reactive, preventive, droppedOverduePreventive }`) — choose
   based on what reads cleanest in the file. Either pattern is fine.

### Phase 2 — Client-side tab label flip

**File:** `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`

Surgical edits — flip ONLY the user-facing display strings. Internal
state literals, type unions, prop names, and URL search-param values
stay as `"preventive"` lowercase to match MaintainX's `PREVENTIVE`
enum spelling and avoid breaking back-compat with any
existing-tab URLs operators may have bookmarked
(`?tab=preventive&request_ok=N`).

1. Line 301 — `label="Preventive"` → `label="Preventative"`
2. Line 393 — `const label = tab === "reactive" ? "Reactive" : "Preventive";`
   → `: "Preventative";`
3. Docblock line 3 — "Reactive / Preventive tabbed view" → "Reactive / Preventative tabbed view"
4. Docblock line 15 — "Due column on the Preventive tab only" → "Due column on the Preventative tab only"

Then `Grep` for any remaining "Preventive" / "preventive" in display
contexts inside `apps/web/app/workorders/`. Any match that ends up
in rendered JSX (button label, heading, banner copy, alt text,
title attribute) gets flipped to "Preventative". Any match in
state values, prop names, type unions, URL query strings, console
logs, or comments-about-MaintainX-API stays. Common false hits to
watch for and KEEP unchanged:
- The `WorkOrdersGroup` field name `preventive`
- The `TabKey` union member `"preventive"`
- Any `useState<"reactive" | "preventive" | "new">` declarations
- The URL-init branch `tabParam === "preventive"`

If there's a docblock that talks about MaintainX's `PREVENTIVE`
enum (e.g., "MaintainX returns `wo.type === \"PREVENTIVE\"`"),
that quoted enum name stays — it's documenting MaintainX's
contract, not Splash UI copy.

### Phase 3 — Validation

From the worker-worker directory:
```sh
pnpm --filter @splash/workorders-worker typecheck
pnpm --filter @splash/workorders-worker build
```
From repo root:
```sh
pnpm typecheck
pnpm --filter @splash/web build
```

Smoke test (after operator deploys):
1. Load `/workorders` and confirm tab label reads "Preventative"
2. Confirm the Preventative tab still loads its grouped list
   (filter shouldn't have broken structure)
3. Confirm an obviously-stale Preventive WO (>90 days overdue) is
   no longer visible — operator can pick a known-old row from a
   pre-deploy screenshot and verify it's gone
4. Confirm WOs with NULL dueDate are still visible (em-dash in
   the Due column)
5. Confirm Reactive tab is unchanged

### Phase 4 — Update documentation

1. **CLAUDE.md** — under the existing "Work Orders" glossary entry,
   add a sentence to the Brief 73 / 74 / 76 paragraph cluster:
   > Brief 79: Preventative tab spelling preferred over "Preventive"
   > on user-facing labels (internal state literals stay
   > `"preventive"` to match MaintainX's `PREVENTIVE` enum).
   > Worker-side filter drops Preventive WOs more than 90 days past
   > `dueDate` — `PREVENTATIVE_MAX_OVERDUE_DAYS = 90` constant in
   > `apps/workorders-worker/src/index.ts`. NULL / malformed dueDate
   > preventives are kept.

2. **BUILD_STATE.md** — bump "Last updated" to 2026-05-09. Add a
   Findings & decisions log entry summarizing the rename and the
   90-day filter, including:
   - The internal-vs-display-label split (why state stays
     "preventive" lowercase)
   - The constant name and value (`PREVENTATIVE_MAX_OVERDUE_DAYS = 90`)
   - The day-floor UTC math posture (mirrors Brief 73's pill)
   - Where to bump the threshold if operator wants 60 or 120 days
     instead

3. **BRIEFS/INDEX.md** — append a row for Brief 79.

4. **BRIEFS/QUEUE.md** — confirm the `# brief-079-...` entry is
   present (Cowork appends; this brief should mention it as a
   self-check).

## Definition of Done

- `apps/workorders-worker/src/index.ts` exports `bucketByType` with
  the 90-day filter applied; `PREVENTATIVE_MAX_OVERDUE_DAYS = 90`
  module constant lands; docblock updated.
- `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`
  display strings flipped to "Preventative" in the four sites
  enumerated above; internal state literals untouched.
- `pnpm --filter @splash/workorders-worker typecheck` passes.
- `pnpm --filter @splash/workorders-worker build` succeeds.
- `pnpm typecheck` (root) passes.
- `pnpm --filter @splash/web build` succeeds.
- CLAUDE.md Work Orders entry mentions the rename + filter.
- BUILD_STATE.md "Last updated" date and Findings entry added.
- BRIEFS/INDEX.md row added for Brief 79.
- This brief's `Status:` flips to `Completed (YYYY-MM-DD)` and the
  `## Outcome` section is filled in.

## Out of scope

- Renaming the internal state literal `"preventive"` →
  `"preventative"`. Would cascade into `TabKey`, response shape
  field name, URL search-param value, every conditional. Internal
  literals stay aligned with MaintainX's `PREVENTIVE` enum for
  grep-ability against MaintainX docs.
- Renaming the response shape field `preventive` →
  `preventative` on `GET /workorders/api/list`. Same reason.
  apps/web type stays in lockstep with the worker.
- Adding a per-tab "show overdue" toggle for operators who want
  to see the dropped rows. Out of scope for this brief; operator
  can fall back to MaintainX's UI for the long tail.
- Changing the threshold dynamically based on user / role / location.
  Single project-wide constant; future extension if needed.
- Reactive-side filtering. Reactive `dueDate` is auto-set to
  same-day by MaintainX (per Brief 73 docblock); a 90-day filter
  there would never fire.

## Outcome

**Status:** Completed 2026-05-09 by Claude Code (headless execution).

### Files modified

1. `apps/workorders-worker/src/index.ts`
   - Added module-scope constant `PREVENTATIVE_MAX_OVERDUE_DAYS = 90`
     immediately above `PRIORITY_NONE_RANK` with the brief's docblock.
   - `bucketByType` return type widened from
     `{ reactive, preventive }` to
     `{ reactive, preventive, droppedOverduePreventive }`. Loop pins
     `nowMs = Date.now()` and `todayUtc` once before iterating; for
     each `wo.type === "PREVENTIVE"` entry, parses `wo.dueDate` (when
     non-null and `Number.isFinite`), day-floors it, and `continue`s
     past the bucket push when `todayUtc - dueUtc > 90`. NULL /
     malformed dueDate Preventive WOs are kept; Reactive WOs are
     unaffected by the filter. Docblock above `bucketByType` extended
     with the Brief 79 paragraph from the spec.
   - `console.log` at the call site now appends
     `droppedOverduePreventive=${buckets.droppedOverduePreventive}` so
     the dropped count surfaces in CF Workers Logs without an extra
     log emission. Chose the third-return-field pattern over walking
     the array a second time at the call site — single source of
     truth for the count, no risk of the inline filter expression
     drifting from `bucketByType`'s logic.

2. `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`
   - Line 3 docblock: "Reactive / Preventive tabbed view" →
     "Reactive / Preventative tabbed view".
   - Line 15 docblock: "Due column on the Preventive tab only" →
     "Preventative tab only".
   - L301 `<TabButton label="Preventive">` → `label="Preventative"`.
   - L393 `BucketEmptyState`'s
     `tab === "reactive" ? "Reactive" : "Preventive"` →
     `: "Preventative"`.
   - All internal state literals (`TabKey = "reactive" | "preventive"
     | "new"`, `useState<"reactive" | "preventive" | "new">`, the
     `WorkOrdersGroup.preventive` field, every `tab === "preventive"`
     conditional, the `tabParam === "preventive"` URL parsing branch,
     prop names like `preventiveCount`, etc.) stay unchanged per the
     brief's internal-vs-display split.

3. `apps/web/app/workorders/_components/DueDatePill.tsx`
   - L3 docblock: "Preventive-tab due-date indicator" →
     "Preventative-tab due-date indicator". Sibling flip per the brief's
     "Brief 73's `<DueDatePill>` docblock may reference 'Preventive' in
     comments — flip user-facing comment text only" guidance.

4. `CLAUDE.md`
   - Work Orders glossary entry extended with the Brief 79 paragraph
     verbatim from the brief's Phase 4 spec, immediately after the
     Brief 76 paragraph.

5. `BUILD_STATE.md`
   - "Last updated" date bumped to 2026-05-09 with a Brief 79 summary
     entry inlined ahead of Brief 78 in the giant single-line log
     blob (line 3).
   - New row added at the top of the Findings & decisions log table
     (above Brief 78's row, position 116) with full implementation
     summary, internal-vs-display rationale, validation results, and
     the latent finding about the missing `build` script.

6. `BRIEFS/INDEX.md`
   - Brief 79's row Status flipped from "Ready for Claude Code" to
     "Completed (2026-05-09)". Description tightened to mention the
     sibling `DueDatePill.tsx` flip and the new
     `droppedOverduePreventive` return field.

### Files created

None. (`BRIEFS/QUEUE.md` already had `brief-079-...md` listed — the
self-check item from the brief; no edit needed.)

### Decisions made on the operator's behalf

1. **Third-return-field pattern over inline filter at the call site.**
   The brief offered both options ("either pattern is fine"). Chose
   `bucketByType` return widening because it keeps the filter logic
   in one place and avoids a second pass over the WO array. Cost is
   one extra named field on the inline return type; benefit is no
   risk of drift between the inlined log expression and the bucket
   logic if a future brief changes either side.

2. **Sibling `DueDatePill.tsx` docblock flip.** The brief said to
   grep Brief 73's `<DueDatePill>` and Brief 74's `NewRequestForm`
   docblocks for "Preventive" and flip user-facing references.
   `DueDatePill.tsx` L3 says "Preventive-tab due-date indicator" —
   that's a user-facing reference to the tab name, so flipped.
   `NewRequestForm.tsx` had zero `[Pp]reventive` matches in the grep,
   so no change there. Other `[Pp]reventive` hits across `apps/web/
   app/workorders/` (page.tsx, worker-fetch.ts, the rest of
   WorkOrdersTabsClient.tsx) are all internal state / type / API-
   contract references and stay unchanged.

3. **`bucketByType` docblock rewrite.** Adopted the brief's exact
   suggested phrasing for the docblock paragraph instead of
   paraphrasing — keeps the cross-reference to
   `PREVENTATIVE_MAX_OVERDUE_DAYS` exact and the wording aligned with
   the constant's own docblock.

### Latent issues found

1. **`apps/workorders-worker/package.json` has no `build` script.**
   The brief's Definition of Done bullet
   `pnpm --filter @splash/workorders-worker build` is unrunnable in
   the current workspace shape — `pnpm --filter` returned "None of
   the selected packages has a 'build' script". The package.json
   only declares `dev`, `deploy`, `typecheck`, `lint`, `clean`. This
   is the established posture across all 5 workers (CF workers don't
   bundle ahead of `wrangler deploy`); future brief drafters should
   spec `typecheck` only for worker validation. Executor relied on
   typecheck + the root build for validation. Logged as a latent
   finding in BUILD_STATE.md so future briefs don't repeat the spec.

2. **`BRIEFS/QUEUE.md` already contained the Brief 79 entry** (line
   62: `brief-079-workorders-preventative-rename-and-90-day-filter.md`,
   appended by Cowork at brief-draft time). No edit needed; the
   brief's Phase 4 self-check is satisfied.

### Validation results

- `pnpm --filter @splash/workorders-worker typecheck` — green (no
  TypeScript output beyond the script invocation; `tsc --noEmit`
  succeeded).
- `pnpm typecheck` (root, all 14 workspace packages via Turbo) —
  14/14 green; 12 cache hits, 2 cache misses (workorders-worker and
  web — both rebuilt because the source files changed). 6.097s.
- `pnpm --filter @splash/workorders-worker build` — N/A (script does
  not exist; see latent finding 1).
- `pnpm --filter @splash/web build` — green. Next 15.5.15 compiled
  in 5.5s; all 13 routes generate; `/workorders` reports
  5.39 kB / 107 kB First Load JS, identical to the Brief 78 baseline.

### Smoke test (deferred to operator post-deploy)

1. Load `/workorders`; confirm the second tab reads
   "Preventative" with its count badge intact.
2. Confirm the Preventative tab still renders its grouped list
   (grouping by location, sort order, expand-on-click, Due column,
   age "Nd" label under priority pill — all unchanged).
3. Pick a known-old (>90 days overdue) Preventive WO from a
   pre-deploy screenshot and confirm it's no longer in the list.
4. Confirm Preventive WOs with NULL `dueDate` still appear (em-dash
   in the Due column).
5. Confirm Reactive tab is unchanged (no filter applies; row count
   should match pre-deploy).
6. (Optional) Tail CF Workers Logs for the
   `workorders-worker list:` line and confirm the new
   `droppedOverduePreventive=N` field is populated with a sensible
   count.
