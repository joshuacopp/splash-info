# Brief 73: Work Orders — Due-date pill on Preventive tab + age inline under priority pill (both tabs)

**Status:** Completed (2026-05-07)
**Started:** 2026-05-07
**Completed:** 2026-05-07
**Blocks:** Operator scan-ability of `/workorders`. Today (post-Brief
72) the page renders priority + title + status + assignees +
updated; due date and age are buried inside the click-to-expand row
(Brief 71's expanded panel). Operator wants both surfaced on the
collapsed row so `/workorders` reads correctly at a glance — "what's
overdue, what's been sitting" — without having to expand each row.
**Dependencies:**
- Brief 71 (the Reactive/Preventive tabs + `WorkOrdersTabsClient`
  client island this brief modifies; `dueDate` and `createdAt`
  fields are already in the response shape from Phase 3.2).
- Brief 72 (the conditional-pagination Brief currently in flight —
  this brief layers on top once 72 lands; no shared file conflicts
  expected because 72 modifies the worker fetch loop, 73 modifies
  page render).
- Brief 68/69 (the AgePill convention for damage list — referenced
  for visual style only; this brief uses muted plain text, NOT the
  tiered AgePill, per operator decision 2026-05-07).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-071-workorders-v2-gating-grouping-assignees-types.md
  (the tab + expandable-row architecture this brief modifies)
- BRIEFS/brief-072-workorders-conditional-pagination.md (the
  in-flight brief; review Outcome before starting to confirm the
  files this brief touches haven't been refactored)
- BRIEFS/brief-068-age-pill-on-damage-claims-list.md (visual
  reference for age display — but NOTE: this brief uses muted plain
  text, not the AgePill component, per operator preference)
- BRIEFS/brief-069-age-pill-two-tier-thresholds.md (also reference;
  same NOT-using-the-tiers note applies)
- apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx
  (the client island this brief modifies — the row rendering
  inside each location section)
- apps/web/app/workorders/_components/PriorityPill.tsx (the
  existing priority component — this brief leaves it unchanged but
  positions the new age text below it)
- apps/web/app/workorders/_components/StatusPill.tsx (visual
  reference for the new DueDatePill — same pill shape, same
  Tailwind class structure)

## Context

Brief 71 introduced the `/workorders` page with two tabs (Reactive
/ Preventive), grouped by location, click-to-expand rows. Brief 72
fixed the data-volume problem (multi-location pagination). Brief 73
is purely UX polish:

1. **Due-date column on the Preventive tab.** Preventive work
   orders have meaningful scheduled `dueDate`s; operators currently
   have to expand each row to see them. The page should surface
   `dueDate` on the always-visible Preventive row with conditional
   formatting:
   - If `dueDate < now` → red pill "Overdue Nd" (where N is
     integer days past due)
   - If `dueDate` falls within today → amber pill "Due today"
   - If `dueDate >= tomorrow 00:00` → muted plain text
     "Due MMM D" (e.g., "Due May 15")
   - If `dueDate == null` → em-dash

2. **Age under priority on both tabs.** The collapsed row's
   left-most column (Priority) currently shows just the priority
   pill. This brief adds a second line below the pill: small muted
   text like `5d` or `30d`, computed as
   `Math.floor((now - createdAt) / 86400000)`. No tiered coloring
   — purely informational, doesn't compete with the priority pill
   for visual weight. Age 0 (created today) renders as `<1d` to
   match Brief 68/69 convention.

   Both tabs get this — even though Preventives also surface a
   due date, age is meaningful for them too (a 30-day-old preventive
   that's due tomorrow tells a different story than a same-day one).

**Reactive WOs do NOT get a due-date column** (operator decision
2026-05-07). Per the MaintainX sample data, Reactive `dueDate`
values are auto-set to same-day-creation and aren't operationally
meaningful for Splash's workflow. If that ever changes, layering
the same DueDatePill onto Reactive rows is a one-line addition.

## Scope

### Phase 1 — New `<DueDatePill>` component

1.1 Create `apps/web/app/workorders/_components/DueDatePill.tsx`:

```tsx
"use client";

import { ReactElement } from "react";

interface Props {
  /** ISO 8601 timestamp from MaintainX `dueDate`. Null = no due date set. */
  dueDate: string | null;
  /** Optional override for "now" — useful for testing / SSR consistency.
   *  Defaults to Date.now(). */
  now?: number;
}

const PILL_BASE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_OVERDUE   = `${PILL_BASE} bg-red-100   text-red-800`;
const PILL_DUE_TODAY = `${PILL_BASE} bg-amber-100 text-amber-800`;
const PLAIN_FUTURE   = "text-xs text-gray-500";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function DueDatePill({ dueDate, now = Date.now() }: Props): ReactElement {
  if (!dueDate) return <span className="text-xs text-gray-400">—</span>;

  const due = new Date(dueDate).getTime();
  if (Number.isNaN(due)) return <span className="text-xs text-gray-400">—</span>;

  // Compare at calendar-day resolution, not millisecond — operators think in
  // "is it overdue today" not "was it overdue 6 hours ago." Build day-floored
  // timestamps for both sides.
  const dayFloor = (ts: number) => {
    const d = new Date(ts);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  const dueDay = dayFloor(due);
  const nowDay = dayFloor(now);
  const diffDays = Math.floor((nowDay - dueDay) / 86_400_000);

  if (diffDays > 0) {
    return <span className={PILL_OVERDUE}>Overdue {diffDays}d</span>;
  }
  if (diffDays === 0) {
    return <span className={PILL_DUE_TODAY}>Due today</span>;
  }
  // diffDays < 0 → future
  const dueDateObj = new Date(due);
  const monthName = MONTHS[dueDateObj.getUTCMonth()];
  const dayNum = dueDateObj.getUTCDate();
  return <span className={PLAIN_FUTURE}>Due {monthName} {dayNum}</span>;
}
```

  - Uses UTC for day-floor comparison. MaintainX returns dueDate as
    UTC ISO 8601; rendering in UTC keeps everyone on the same page
    regardless of the operator's browser locale. (If operators
    later complain that "Due today" doesn't line up with their
    local day boundary, switch to local timezone — but UTC is the
    safer default for an org-wide internal tool.)
  - Day-floor comparison means a WO due at 16:00 UTC today renders
    as "Due today" all day, not "Overdue 0d" once the clock passes
    16:00. Same for "Overdue Nd" — it counts whole calendar days,
    not 24-hour windows.
  - `now` prop default is `Date.now()` evaluated at component
    render. SSR-vs-CSR hydration mismatch is possible if the page
    SSRs at 23:59 and the client renders at 00:01 — acceptable
    minor edge case, not worth fixing in v1.

### Phase 2 — Integrate into the row render

2.1 Modify `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`:

  - Import `DueDatePill`.
  - In the priority cell render, replace the bare priority pill with
    a two-line stack:
    ```tsx
    <td>
      <PriorityPill priority={wo.priority} />
      <div className="text-xs text-gray-500 mt-0.5">
        {ageLabel(wo.createdAt)}
      </div>
    </td>
    ```
    Where `ageLabel(iso)` is a module-local helper:
    ```ts
    function ageLabel(iso: string): string {
      const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
      return days < 1 ? "<1d" : `${days}d`;
    }
    ```
    Same `<1d` fallback as Brief 68/69.
  - The `mt-0.5` margin gives a tight vertical gap that reads as
    one cell rather than two stacked items. If it looks too cramped,
    bump to `mt-1`. Executor's call.
  - Both tabs render this. The age label is independent of tab.

2.2 For the Preventive tab specifically, add a "Due" column to the
table:

  - Brief 71's table layout for each location section (rough
    schema — verify against actual code):
    ```
    | Priority | Title | Status | Assignees | Updated | Open |
    ```
  - Preventive tab adds a Due column between Status and Assignees
    (so the time-sensitive signal sits adjacent to status):
    ```
    | Priority | Title | Status | Due | Assignees | Updated | Open |
    ```
  - The Reactive tab's table is unchanged — no Due column.
  - Implementation pattern: condition the `<th>Due</th>` and the
    matching `<td><DueDatePill dueDate={wo.dueDate} /></td>` on the
    active tab. The cleanest shape is to render two distinct
    table-row JSX paths in the same map function based on
    `activeTab === "preventive"`, OR render a `<td>` always but
    leave it empty on Reactive (allows column alignment but adds
    a useless empty column on Reactive — pick the conditional-row
    approach unless that becomes a maintenance headache).
  - Mobile responsiveness: the existing tables already accept
    horizontal scroll on narrow viewports (Brief 71 didn't add a
    distinct mobile layout). The new Due column inherits the same
    behavior — narrow viewports get a horizontal scrollbar,
    operators swipe to see the column. If operators surface
    complaints, a future brief can layer a mobile-stacked-card
    layout; out of scope here.

### Phase 3 — Expanded-row rendering

3.1 Brief 71's expanded row renders description / created date / age
/ assignees / categories. The age is now redundant with the
collapsed-row age — DROP it from the expanded row to avoid
duplication. Created date stays (more granular — "May 1, 2026"
not "6d ago"). Description, assignees, categories stay.

3.2 Optional: if the executor finds the expanded row visually
sparse after dropping age, it's fine to leave the explicit "Age:
6d" label intact — keeping it doesn't break anything, just shows
the operator the same number twice. Defer to executor judgment.

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass for all 14 packages.

4.2 `pnpm --filter @splash/web build` — must succeed. Bundle delta
on `/workorders` route documented in Outcome.

4.3 No worker change. No schema change. No new env vars.

4.4 Visual smoke test (operator post-deploy):
  - (a) Open `/workorders`, switch to Preventive tab. Confirm at
    least one row renders red "Overdue Nd", at least one renders
    amber "Due today" (if any happen to fall on the test day),
    and the rest render muted "Due MMM D".
  - (b) Confirm Reactive tab does NOT show a Due column.
  - (c) Confirm both tabs show "Nd" muted text under each
    priority pill.
  - (d) Click a row to expand — confirm the description / created
    date / assignees / categories all still render.
  - (e) Resize the viewport to ~375px wide (iPhone SE) — confirm
    the priority+age stack still reads as one cell, the Due pill
    is visible (possibly behind a horizontal scroll), nothing
    overlaps.

### Phase 5 — Documentation updates

5.1 CLAUDE.md — under the "Work Orders" glossary entry, append:

```
- Brief 73: Preventive rows surface a due-date pill (red "Overdue
  Nd" / amber "Due today" / muted "Due MMM D" / em-dash null);
  Reactive rows do not (MaintainX auto-sets reactive dueDate to
  same-day, not operationally meaningful). Both tabs show muted
  age text "Nd" beneath the priority pill in the collapsed row.
```

5.2 BUILD_STATE.md:
  - Bump "Last updated".
  - New row in "Open work — prioritized" for Brief 73.
  - Findings entry covering: visual additions, why Reactive skips
    Due (MaintainX's same-day auto-set), why age is plain muted
    text not the tiered AgePill (operator preference: don't
    compete with priority pill).

5.3 BRIEFS/INDEX.md — append Brief 73 row.

5.4 BRIEFS/QUEUE.md — append Brief 73 filename.

## Out of scope

- Adding a Due column to the Reactive tab. MaintainX same-day
  auto-set makes it noise. Revisit if Splash's reactive workflow
  ever uses meaningful due dates.
- Tiered color escalation on age (Brief 69 pattern). Operator
  preferred plain muted text; doesn't compete with priority pill.
- Distinct mobile-card layout. Existing horizontal-scroll behavior
  is acceptable v1; revisit if operators complain.
- Sorting by due date inside the Preventive tab. Brief 71's sort
  (priority desc, then `updatedAt` desc) stays. Operator could ask
  for "Preventive sorted by due date asc (most overdue first)" as
  a future enhancement.
- Surfacing time-of-day on the due date (e.g., "Due today at 4 PM").
  MaintainX returns a precise timestamp; we render at day
  resolution. Operators don't seem to need finer granularity.
- Filtering controls (e.g., "show only overdue"). Out of scope;
  this brief is purely visual.
- Don't deploy from headless. Push triggers CF Workers Builds
  auto-deploy on apps/web.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/web/app/workorders/_components/DueDatePill.tsx` exists with
  the three-tier render (red overdue / amber today / muted future
  / em-dash null), day-floored UTC comparison
- `WorkOrdersTabsClient.tsx` renders `<DueDatePill>` in a Due column
  on the Preventive tab table only; Reactive tab table unchanged
- Priority cell on both tabs renders the priority pill on top with
  muted "Nd" text below (same `ageLabel` helper, `<1d` fallback)
- Expanded-row Age line removed (or left as-is per Phase 3.2 — both
  acceptable)
- pnpm typecheck passes
- pnpm --filter @splash/web build succeeds
- No worker change, no schema change
- BRIEFS/INDEX.md, BRIEFS/QUEUE.md, BUILD_STATE.md, CLAUDE.md updated
- Status set to Completed (YYYY-MM-DD)

## Report

- Files created (~1: DueDatePill.tsx)
- Files modified (~2-3: WorkOrdersTabsClient.tsx, possibly
  worker-fetch.ts type if dueDate wasn't already typed, plus
  CLAUDE.md + BUILD_STATE.md)
- Bundle delta on apps/web `/workorders` route (kB First Load JS)
- Validation results
- Decisions made on the operator's behalf
- Latent issues / forward flags

## Outcome

**Files created:**

- `apps/web/app/workorders/_components/DueDatePill.tsx` — new
  `"use client"` component (~75 lines including the docblock).
  Three render tiers + null fallback per the brief: red pill
  `Overdue Nd` (`bg-red-100 text-red-800`) when `diffDays > 0`,
  amber pill `Due today` (`bg-amber-100 text-amber-800`) when
  `diffDays === 0`, muted plain text `Due MMM D`
  (`text-xs text-gray-500`) when `diffDays < 0`, muted em-dash
  for `null` / `NaN`. Day-floor comparison done in UTC via
  `Date.UTC(getUTCFullYear, getUTCMonth, getUTCDate)` for both
  `dueDate` and `now` so calendar-day semantics hold regardless
  of operator browser locale and a 16:00-UTC due-time renders
  "Due today" all day. Optional `now?: number` prop default
  (`Date.now()`) for testability. Pulled `dayFloor` out of the
  brief's inline IIFE into a module-local helper for legibility.
  `MONTHS` array for the future-tier label keeps the rendered
  string locale-stable.

**Files modified:**

- `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`:
  - Imported `DueDatePill`.
  - Added module-local `ageLabel(iso)` helper: returns `"<1d"`
    for `days < 1` (matches Brief 68/69 floor convention),
    `"${days}d"` otherwise; returns `"—"` on parse failure as
    a defensive fallback (the createdAt itself is null-guarded
    at the call site, so the parse-fail branch is theoretical).
  - Threaded `tab: TabKey` through `GroupSection` props; derives
    `showDueColumn = tab === "preventive"` and
    `colSpan = showDueColumn ? 8 : 7` once at the section level
    and passes both down to `WorkOrderRow` / `ExpandedRow`.
  - Conditional `<th>Due</th>` (between Status and Assignees) +
    matching `<td><DueDatePill dueDate={wo.dueDate} /></td>`
    rendered only when `showDueColumn`. `title={wo.dueDate}`
    on the cell so operators can hover for the raw ISO timestamp.
  - Priority `<td>` now stacks: `<PriorityPill priority={wo.priority} />`
    on top, `<div className="text-xs text-gray-500 mt-0.5">
    {wo.createdAt ? ageLabel(wo.createdAt) : "—"}</div>`
    underneath. Renders on BOTH tabs.
  - `ExpandedRow` props extended with `colSpan: number`; the
    Age `<dt>/<dd>` block deleted (now duplicates the
    collapsed-row label per Phase 3.1); expanded grid collapses
    from `sm:grid-cols-3` to `sm:grid-cols-2` (Created +
    Assignees only). Description + Categories blocks unchanged.
  - Dead `daysSince(iso)` helper removed (only consumer was the
    deleted Age block).
  - File's leading docblock updated: dropped the "expanded rows
    surface ... age in days" claim; added a Brief-73 paragraph
    documenting the collapsed-row additions (age label both
    tabs, Due column Preventive only) and the rationale for the
    expanded-row Age deletion.

- `CLAUDE.md` — appended a Brief 73 paragraph to the existing
  Work Orders glossary entry, calling out the three pill tiers
  on Preventive, the Reactive-skip rationale, and the muted
  age-under-priority on both tabs.

- `BUILD_STATE.md` — bumped "Last updated" with a Brief 73
  one-liner pinned at the front; new Brief 73 row in the Open
  work table; new Findings entry on 2026-05-07 with the full
  three-phase walkthrough, decisions, latent issues, and
  validation results.

- `BRIEFS/INDEX.md` — appended Brief 73 row.

- `BRIEFS/QUEUE.md` — Brief 73 line commented out as completed.

**Decisions made on the operator's behalf:**

1. **Conditional row over always-empty cell.** The brief left
   both options open. Picked the conditional `{showDueColumn ?
   <td>…</td> : null}` approach over rendering a `<td>` always
   and leaving it empty on Reactive — keeps the Reactive table
   column count at the original 7 (no useless empty column;
   matches the pre-Brief-73 layout exactly). The minor
   complexity of also threading `colSpan` is paid for by not
   visually hinting at a dead column on Reactive.

2. **Tab threaded through `GroupSection`, not derived deeper.**
   `WorkOrderRow` doesn't know which tab it's on, but
   `GroupSection` does (renders the table headers). Cheaper to
   compute `showDueColumn` once at the section level and pass
   it down as a boolean than to pass `tab` all the way through
   and re-derive on every row. Same `colSpan` consideration —
   computed once, passed down.

3. **Phase 3.1 (drop Age block) over Phase 3.2 (leave it).**
   Brief explicitly accepted both. Picked deletion: the same
   number rendered twice (once muted under priority, once on
   the expanded grid) reads more like a copy-paste bug than a
   feature, and the expanded grid still has Created (more
   granular: "2026-05-01") + Assignees + Categories +
   Description so it isn't visually sparse.

4. **`<1d` floor on `ageLabel`, not "0d".** Matches Brief
   68/69's AgePill convention verbatim. The brief specified
   this directly; not actually a discretionary call.

5. **`title={wo.dueDate}` on the Due `<td>`.** Brief didn't
   specify but the existing Updated `<td>` already does this
   for `wo.updatedAt`; consistency wins. Lets operators hover
   for the raw ISO timestamp if they need to disambiguate
   "Due today" between morning and evening.

6. **`mt-0.5` margin on the age label** (not `mt-1`). Brief
   said executor's call. `mt-0.5` reads as one cell at the
   tested viewport widths; bumping to `mt-1` would put extra
   visible whitespace between the priority pill and the muted
   age line, weakening the "this is one cell" gestalt.

**Latent issues / forward flags:**

1. **SSR/CSR hydration mismatch around midnight UTC.** The
   `now` prop default is evaluated at component render — if the
   server renders at 23:59 UTC and the client renders past
   00:00 UTC, the same WO could render "Overdue 0d" on the
   server and "Due today" on the client (or vice versa). Brief
   explicitly accepted this as v1 edge-case noise. Fix path
   would be to thread a server-side `now` ISO string down from
   page.tsx → WorkOrdersTabsClient → DueDatePill, but that
   trades hydration stability for staleness as the page sits
   open across midnight. No action needed today.

2. **Reactive Due column trivially addable later.** If
   MaintainX's reactive `dueDate` ever stops being auto-set to
   same-day-of-creation (e.g., Splash flow change to schedule
   reactive WOs into the future), drop the `tab === "preventive"`
   guard on the `<th>`/`<td>` and the Reactive table picks the
   column up. One-line addition.

3. **Sorting by due date inside the Preventive tab is OUT of
   scope.** Today the Brief 71 sort holds (priority desc, then
   `updatedAt` desc), so an overdue LOW-priority WO can sit
   below a future-dated MEDIUM. If operators ask for "Preventive
   sorted by `Overdue Nd` first" that's a future brief — would
   need either a worker-side sort change in `extractWorkOrders`
   or a client-side resort in `GroupSection`.

4. **Mobile-card layout still deferred.** Adding a column to
   the Preventive table marginally widens the horizontal scroll
   range on narrow viewports. Existing horizontal scrollbar
   from Brief 71 still works; if operators surface complaints
   on the Preventive tab specifically (now that there's one
   more column), a future brief can layer a mobile-stacked-card
   layout.

5. **Day-resolution rendering.** "Due today at 4 PM" is not
   surfaced — operators get day resolution only. MaintainX's
   raw `dueDate` is a precise timestamp; `title={wo.dueDate}`
   on the cell gives the hover-fallback for operators who need
   the exact time. Brief explicitly out-of-scoped this.

**Validation results:**

- `pnpm typecheck` — 14/14 green. Initial run failed once with
  `TS1484: 'ReactElement' is a type and must be imported using
  a type-only import when 'verbatimModuleSyntax' is enabled.`
  in `DueDatePill.tsx:15`; fixed by switching to
  `import type { ReactElement } from "react";` (matches every
  other apps/web type import). Second run clean.
- `pnpm --filter @splash/web build` — succeeds. Bundle delta
  for `/workorders`: **3.46 kB First Load JS (was 3.12 kB
  after Brief 72 — delta ~340 bytes)**. Total First Load JS
  unchanged at 105 kB. Other routes unaffected.
- No worker change. No schema change. No new env vars. No new
  secrets. No new bindings.

**Operator-side smoke test (post-deploy):**

1. Open `/workorders`, switch to Preventive tab. Confirm at
   least one row renders red "Overdue Nd"; if any WOs are due
   today (calendar-UTC), confirm they render amber "Due today";
   the rest render muted "Due MMM D". Null-due-date rows
   render an em-dash.
2. Confirm the Reactive tab does NOT show a Due column —
   table shape unchanged from Brief 71/72 (Priority / Title /
   Status / Assignees / Updated / MaintainX).
3. Confirm both tabs show "Nd" muted text under each priority
   pill. WOs created today render "<1d".
4. Click a row to expand on either tab — confirm description,
   created date (YYYY-MM-DD), assignees, and categories all
   still render. Confirm the Age line is gone from the
   expanded grid (now under priority on the collapsed row).
5. Resize the viewport to ~375px wide (iPhone SE) — confirm
   the priority+age stack reads as one cell, the Due pill on
   Preventive is reachable via horizontal scroll, nothing
   overlaps or wraps awkwardly.
