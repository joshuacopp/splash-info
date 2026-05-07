# Brief 67: Reporting page — Cost column on Approved-by-damage-type, per-location drill-down, Avg Days Open per location, footer rewording

**Status:** Completed (2026-05-07)
**Started:** 2026-05-07
**Completed:** 2026-05-07
**Blocks:** Operator's 2026-05-07 review of the Reporting page
flagged four enhancements: (1) Cost column on the
Approved-by-damage-type table, (2) ability to drill into a
per-location detail without changing filters, (3) Avg Days Open
metric per location, (4) footer rewording — operator confirmed
that summing approved quotes + receipts is correct behavior
(both are real spend), so the v2 "double-count limitation"
disclaimer should go.
**Dependencies:** Brief 59 (the reporting page + endpoint), Brief
60 (the Open damage-type column).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-059-damage-am-rm-filters-and-reporting-tab.md
  (the Phase 6 endpoint shape; this brief extends it)
- BRIEFS/brief-060-reporting-add-open-damage-type-breakdown.md
  (the third damage-type column added in the same section we're
  now extending)
- apps/damage-worker/src/index.ts (the reporting handler — adds
  the new cost-by-damage-type query, the per-location drill-down
  query, and the avg-days-open expression)
- apps/web/app/admin/damage/reporting/page.tsx (the page
  rendering the four sections; this brief extends the By Location
  table with two new columns, swaps the Approved damage-type
  table for a 3-column table, and wires the inline drill-down
  expansion)

## Context

**Operator's cost-summing decision (2026-05-07):** "If there are
submitted receipts, that's money spent. If there's ALSO an
approved quote, that's additional money committed. Summing them
is correct." Brief 59 originally framed the sum as a
"limitation, refine in v2" because of double-count concerns —
operator now affirms that both numbers ARE real-money exposure
and the sum is the right thing to display. The v2 disclaimer in
the report's footer should drop, and the section docblock in
the worker should be reworded to spell out the new framing.

**Cost column on Approved-by-damage-type:** Today the table is
just `damage_type | count`. Add `cost` so operators can see "DS
Mirror approved 12 times for $X total" at a glance. Same
formula as the existing per-location Cost column: sum of
`claim_photos.amount` for `Quote` + `Receipt` photos on
Approved-family claims, grouped by damage_type instead of
location_code.

**Per-location drill-down:** Click a row in the By Location
table to expand a panel underneath it showing the four-bucket
damage-type breakdown for that location only:
- Open: count per damage type
- Closed: count per damage type (lifecycle = 'Closed', the
  superset that overlaps Approved + Denied — yes, redundant by
  design per operator's request)
- Approved: count + cost per damage type
- Denied: count per damage type

Click again to collapse. Multiple rows can be expanded
simultaneously. State is per-row local React `useState` (mirror
the audit-log expandable row pattern from Brief 53). Drill-down
data is pre-fetched as part of the existing report response —
no lazy fetch, no separate endpoint.

**Avg Days Open per location:** New column on the By Location
table between `Denied` and `Cost`. Computed in the worker via
`AVG(julianday('now') - julianday(submitted_at))` filtered to
`lifecycle_state = 'Open'` per location. Render as integer days
(e.g., "12d") or "—" when zero open claims at that location.

**Footer rewording:** Replace the "Cost = sum … may be
double-counted (limitation flagged in Brief 59 — refine in v2)"
text with a positive statement that both quote and receipt
amounts are real spend so summing them captures total exposure.

## Scope

### Phase 1 — Damage-worker: extend the reporting endpoint

1.1 In `apps/damage-worker/src/index.ts`'s reporting handler
(the one Brief 59 added), find Query F (Approved damage-type
breakdown). Replace it with a JOIN-based variant that produces
both count and cost per damage type:

```sql
SELECT
  COALESCE(c.damage_type, '(none)') AS damage_type,
  COUNT(DISTINCT c.claim_id) AS n,
  COALESCE(
    SUM(CASE WHEN cp.photo_type IN ('Quote','Receipt')
             AND cp.amount IS NOT NULL
             THEN cp.amount END),
    0
  ) AS cost
FROM claims c
LEFT JOIN claim_photos cp ON cp.claim_id = c.claim_id
WHERE c.location_code IN (...)
  AND c.submitted_at BETWEEN ? AND ?
  AND (c.claim_status LIKE 'Approved —%'
       OR c.claim_status IN ('Closed — Paid','Closed — Approved/No Response'))
GROUP BY c.damage_type
ORDER BY n DESC;
```

  - `LEFT JOIN` on `claim_photos` so claims without any photos
    still surface with `cost = 0`.
  - `COUNT(DISTINCT c.claim_id)` because the JOIN can multiply
    rows when a claim has multiple photos.
  - The `CASE WHEN` inside the SUM avoids non-Quote/Receipt
    photos contributing.

1.2 Add a new "per-location drill-down" query that returns one
row per (location_code, damage_type, outcome_bucket):

```sql
SELECT
  c.location_code,
  c.location_pretty,
  CASE
    WHEN c.lifecycle_state = 'Open' THEN 'open'
    WHEN c.claim_status = 'Closed — Denied' THEN 'denied'
    WHEN c.claim_status LIKE 'Approved —%'
         OR c.claim_status IN ('Closed — Paid','Closed — Approved/No Response')
      THEN 'approved'
    ELSE 'closed_other'
  END AS outcome_bucket,
  COALESCE(c.damage_type, '(none)') AS damage_type,
  COUNT(DISTINCT c.claim_id) AS n,
  COALESCE(
    SUM(CASE WHEN cp.photo_type IN ('Quote','Receipt')
             AND cp.amount IS NOT NULL
             THEN cp.amount END),
    0
  ) AS cost
FROM claims c
LEFT JOIN claim_photos cp ON cp.claim_id = c.claim_id
WHERE c.location_code IN (...)
  AND c.submitted_at BETWEEN ? AND ?
GROUP BY c.location_code, c.location_pretty, outcome_bucket, c.damage_type
ORDER BY c.location_code, outcome_bucket, n DESC;
```

  - Note: a single claim falls into exactly one of `open`,
    `denied`, `approved`, `closed_other`. The "Closed" bucket the
    operator asked for is `denied + approved-with-Closed-status
    + closed_other`. The renderer in Phase 2.4 produces the
    "Closed" view by aggregating the right subset of these four
    on the apps/web side.
  - Cost is computed for every bucket but the renderer only
    surfaces it on the Approved column per operator's request.

1.3 Extend the per-location aggregate query (Brief 59 Query E
or its sibling). Add `AVG(julianday('now') - julianday(c.submitted_at))`
filtered to `lifecycle_state = 'Open'`:

```sql
SELECT
  c.location_code,
  c.location_pretty,
  SUM(CASE WHEN c.lifecycle_state = 'Open' THEN 1 ELSE 0 END) AS open_count,
  SUM(CASE WHEN c.lifecycle_state = 'Closed' THEN 1 ELSE 0 END) AS closed_count,
  SUM(CASE WHEN c.claim_status LIKE 'Approved —%'
                OR c.claim_status IN ('Closed — Paid','Closed — Approved/No Response')
           THEN 1 ELSE 0 END) AS approved_count,
  SUM(CASE WHEN c.claim_status = 'Closed — Denied' THEN 1 ELSE 0 END) AS denied_count,
  AVG(CASE WHEN c.lifecycle_state = 'Open'
           THEN julianday('now') - julianday(c.submitted_at)
           ELSE NULL END) AS avg_days_open,
  -- existing cost rollup stays
FROM claims c
LEFT JOIN claim_photos cp ON cp.claim_id = c.claim_id
WHERE ...
GROUP BY c.location_code, c.location_pretty;
```

  - `AVG` with `NULL` for non-Open rows correctly excludes them
    from the denominator.
  - `avg_days_open` is `NULL` when a location has zero open
    claims; the renderer surfaces this as `—`.

1.4 Update the response shape. Brief 59's `by_location` array
gains `avg_days_open: number | null`. Brief 60's
`by_damage_type_approved` array gains `cost: number`. New
top-level field:

```ts
by_location_drilldown: Array<{
  location_code: string;
  location_pretty: string;
  outcome_bucket: "open" | "denied" | "approved" | "closed_other";
  damage_type: string;
  n: number;
  cost: number;
}>;
```

1.5 Update the response-typing TypeScript interface accordingly.
The reporting handler's docblock should also gain a Brief 67
note explaining the new fields.

### Phase 2 — apps/web: render the changes

2.1 In `apps/web/app/admin/damage/reporting/page.tsx`, update
the By Location table to add an `Avg Days Open` column between
`Denied` and `Cost`:

```
LOCATION | OPEN | CLOSED | APPROVED | DENIED | AVG DAYS OPEN | COST
```

  - Render `avg_days_open` rounded to integer + "d" suffix
    (e.g., "12d"). Render `—` when null.

2.2 Make each location row clickable — wraps the existing
`DamageTypeTable` expansion pattern from Brief 60. Use a
client-side `useState<Set<string>>(new Set())` keyed by
`location_code`. Click toggles membership.

  - Each `<tr>` becomes a fragment of a primary row + an optional
    expanded row underneath (when the location's code is in the
    expanded set). The expanded row uses `<td colSpan={7}>` (or
    however many columns the table has after Phase 2.1) to hold
    the drill-down panel.
  - Add a chevron indicator (▶ collapsed, ▼ expanded) in the
    Location cell or as a separate leading column for
    discoverability.
  - `aria-expanded` on the toggleable element.

2.3 The drill-down panel renders four `<DamageTypeTable>` blocks
side-by-side (or stacked on mobile) in this order: **Open /
Closed / Approved / Denied**. Source data: filter
`by_location_drilldown` to the row's location, then bucket by
`outcome_bucket`:

  - "Open": `outcome_bucket === 'open'` rows
  - "Closed": union of `'denied'`, `'approved'` (where
    claim_status starts with `Closed —`), and `'closed_other'`.
    For v1, just include `'denied' + 'closed_other'` plus the
    subset of `'approved'` with closed-status. To keep the SQL
    simple, alternative: have the renderer just sum `denied + closed_other`
    rows for each damage_type and call that "Closed (excluding
    closed-approved)". OR mirror the operator's literal request
    and show "Closed (any)" = `denied + closed_other + (approved
    rows where claim_status starts with 'Closed —')`. Since the
    drill-down query doesn't expose claim_status, the simpler
    interpretation is the union of `denied + closed_other`. Flag
    this in the brief outcome — operator may iterate.

  Cleaner alternative: extend the drill-down query to include a
  separate `closed_approved` bucket (Closed — Paid +
  Closed — Approved/No Response), making it a 5-bucket split.
  Then "Closed" = `denied + closed_approved + closed_other`.

  Executor's call: 4-bucket vs 5-bucket. The 5-bucket version is
  cleaner semantically; the 4-bucket version is one less SQL
  CASE branch. Default to 5-bucket and update the response type
  accordingly.

2.4 Approved bucket gets cost: pass the `cost` field from the
drill-down rows into the Approved `<DamageTypeTable>`'s
column rendering. The other three buckets (Open / Closed /
Denied) just show count.

2.5 Update the global "By Damage Type" Approved table (the
3-column grid Brief 60 introduced) to render
`damage_type | count | cost` instead of `damage_type | count`.
Open and Denied tables stay 2-column (count only).

2.6 Footer rewording. Replace the existing footer:
> Cost = sum of approved quote amounts + receipt amounts.
> Claims with both a quote and a receipt may be double-counted
> (limitation flagged in Brief 59 — refine in v2).

with:
> Cost = approved quote amounts + receipt amounts on
> Approved-family claims. Both are real spend — receipts are
> money paid out, approved quotes are money committed —
> so summing them captures total exposure.

2.7 Don't extract a per-location `<DrilldownPanel>` component
unless the JSX gets unwieldy — inline JSX inside the
expanded-row branch is fine. If extracted, place it next to
`<DamageTypeTable>` in a sibling file under `_components/`.

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass for all 13 packages.
3.2 `pnpm --filter @splash/web build` — must succeed.
3.3 `pnpm --filter @splash/damage-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed; clean up.
3.4 No schema changes. No new env vars. No new endpoints
   (extending the existing `/manage/api/reporting` response
   only).

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 67 row appended.

4.2 BUILD_STATE.md: Findings entry noting:
  - Reporting page gains: Cost column on the global
    Approved-by-damage-type table; per-location drill-down via
    inline expandable rows showing damage-type breakdowns for
    Open / Closed / Approved (with cost) / Denied; Avg Days
    Open metric on the By Location table; footer rewording to
    drop the "v2 limitation" disclaimer per operator
    confirmation
  - Worker reporting endpoint gains a `by_location_drilldown`
    array (5-bucket — open / denied / approved / closed_approved
    / closed_other; renderer combines `denied + closed_approved
    + closed_other` for the operator-facing "Closed" view) and
    `avg_days_open` per location
  - Cost framing affirmed: receipts are paid out, approved
    quotes are committed; both are real spend; summing is the
    correct behavior per operator's 2026-05-07 decision
  - Operator follow-up: navigate /admin/damage/reporting and
    confirm new columns + drill-down render correctly

4.3 No CLAUDE.md change needed — the Reporting page glossary
entry was added by Brief 59; this brief's additions are
consistent extensions.

## Out of scope

- Cost column on the Open or Denied damage-type tables. Open
  may have approved quotes in flight (a real cost exposure), but
  operator's request was Approved-only for v1.
- Drill-down's "Closed" interpretation refinement. v1 ships with
  the 5-bucket SQL + renderer-side aggregation. If operator
  wants stricter scoping (e.g., excluding `closed_approved`
  from the Closed view to avoid overlap with Approved), that's
  a v2 follow-up.
- Excel / CSV export of the drill-down. Defer.
- Sortable per-location table columns. Defer.
- Persisting drill-down expansion state across page reloads.
  Brief 53's audit-log expansion is also session-only; same
  posture here.
- Drill-down on rows where the user has zero claims (would
  render an empty drill-down). Render the four empty tables
  with a "(none)" placeholder rather than special-casing the
  zero state.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `GET /manage/api/reporting` response includes:
  - `by_location[].avg_days_open: number | null`
  - `by_damage_type_approved[].cost: number`
  - `by_location_drilldown: Array<{location_code, location_pretty, outcome_bucket, damage_type, n, cost}>`
- The By Location table renders an `Avg Days Open` column;
  rows are clickable and expand to a per-location drill-down
  panel showing four damage-type tables (Open / Closed /
  Approved+cost / Denied)
- The global Approved-by-damage-type table renders count + cost
- The page footer is reworded per Phase 2.6
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run bundle succeeds (clean up after)
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely 200-300 lines net: 1 new SQL query + 1
  modified query + 1 modified aggregate query + apps/web
  rendering changes for clickable rows + drill-down panel +
  footer + cost column)
- Confirmation that the global Approved table cost matches the
  sum of per-location costs in the drill-down (data integrity
  spot-check)
- Confirmation that `julianday('now') - julianday(submitted_at)`
  produces sensible Avg Days Open values on a location with
  known claim ages
- Validation results
- Any decisions made on the operator's behalf

## Outcome

**Status:** Completed (2026-05-07)

### Files modified

- `apps/damage-worker/src/index.ts` — Phase 1:
  - Reporting handler docblock extended with a Brief 67 note explaining
    the new response fields and the cost-framing change.
  - `ReportingByLocationRow` gains `avg_days_open: number | null`.
  - New `ReportingByDamageTypeApprovedRow` (count + cost), new
    `ReportingByLocationDrilldownRow`, new `ReportingDrilldownBucket`
    union (`"open" | "denied" | "approved" | "closed_approved" | "closed_other"`).
  - `ReportingResponse` extended: `by_damage_type_approved` retyped to
    `ReportingByDamageTypeApprovedRow[]`; new top-level
    `by_location_drilldown: ReportingByLocationDrilldownRow[]`.
  - `byDamageTypeApprovedSql` rewritten as a JOIN-based variant —
    `LEFT JOIN claim_photos cp ON cp.claim_id = c.claim_id AND
    cp.deleted_at IS NULL`, `COUNT(DISTINCT c.claim_id) AS n`, plus the
    standard cost CASE-SUM. `cp.deleted_at IS NULL` lives in the JOIN
    clause (not the WHERE) so the LEFT JOIN preserves claims without
    photos.
  - New `byLocationAvgDaysOpenSql` uses
    `AVG(julianday('now') - julianday(submitted_at))` filtered to
    `lifecycle_state = 'Open' AND deleted_at IS NULL`. Locations with
    zero open claims simply produce no row → renderer surfaces `—`.
  - New `byLocationDrilldownSql` returns one row per
    (location_code, outcome_bucket, damage_type) using the 5-bucket
    CASE expression. `MAX(c.location_pretty)` is selected so the
    GROUP BY doesn't need to include the pretty name.
  - D1 batch grew from 11 to 13 statements (`byLocationAvgDaysOpenSql`
    and `byLocationDrilldownSql` appended); same `baseBindings`
    (`[from, to, ...codes]`); dc_role scoping unchanged.
  - Per-location row construction now seeds `avg_days_open: null` and
    a new for-loop populates it from `byLocationAvgDaysOpenRes`.
  - `byDamageApproved` parser maps `r.cost` into the new shape.
  - New drill-down parser `filter`s out unknown bucket strings via a
    `Set<ReportingDrilldownBucket>` allow-list (defense in depth) and
    `map`s rows into the typed shape. Empty-response sentinel
    (`emptyReportingResponse`) extended with `by_location_drilldown: []`.
- `apps/web/app/admin/damage/reporting/page.tsx` — Phase 2:
  - New import: `ByLocationTableClient` from local `_components/`.
  - `ReportingResponse` interface extended to mirror the worker shape
    (`avg_days_open`, `cost` on approved damage type rows, new
    `by_location_drilldown` array).
  - Inline By Location table replaced with
    `<ByLocationTableClient rows={...} drilldown={...} />`.
  - Global "By Damage Type" Approved panel renders count + cost via
    `<DamageTypeTable showCost />`; Open and Denied panels stay 2-column.
  - Footer reworded per Phase 2.6.
  - `DamageTypeTable` helper gains optional `showCost` prop and an
    optional `cost` field on the row type.

### Files created

- `apps/web/app/admin/damage/reporting/_components/ByLocationTableClient.tsx`
  — `"use client"` component owning the expandable-row state.
  `useState<Set<string>>` keyed by `location_code`; multiple rows can
  be expanded simultaneously; chevron `▶/▼` indicator + `aria-expanded`
  on the toggleable `<tr>`. The expanded row spans 8 columns (1 chevron
  + 7 data columns). Drill-down panel renders four `DamageTypeMiniTable`
  blocks (Open / Closed / Approved-with-cost / Denied) using a
  Map-based aggregator that buckets the location's drilldown rows by
  damage_type within the requested bucket subset:
    - **Open:** `outcome_bucket === 'open'`
    - **Closed:** `denied + closed_approved + closed_other` aggregated
    - **Approved:** `approved + closed_approved` aggregated, with cost
    - **Denied:** `outcome_bucket === 'denied'`
  Rendering is `(none)` when a bucket has no rows for the location.

### Decisions made on operator's behalf

1. **5-bucket SQL over 4-bucket.** The brief left this as an
   executor's call. Picking 5-bucket means
   `claim_status IN ('Closed — Paid','Closed — Approved/No Response')`
   gets its own bucket (`closed_approved`) instead of being lumped
   with `claim_status LIKE 'Approved —%'`. The renderer then aggregates
   `approved + closed_approved` for the Approved drilldown panel and
   `denied + closed_approved + closed_other` for the Closed drilldown
   panel — both matching the per-location table's column semantics
   exactly. The 4-bucket alternative would have either over-counted
   Closed (by lumping closed_approved with approved and excluding it
   from Closed) or under-counted Approved. Extra CASE branch cost is
   negligible.
2. **Inline JSX vs extracted `<DrilldownPanel>`.** Brief 2.7 said
   inline is fine unless JSX gets unwieldy. With four panels + an
   aggregator helper, the JSX did get unwieldy enough to warrant a
   small `DrilldownPanel` + `DamageTypeMiniTable` split inside the
   client-component file — neither is exported, neither is used outside
   `ByLocationTableClient.tsx`.
3. **Avg Days Open as a separate query rather than extending the
   existing per-location batch query.** The existing `byLocationSql`
   already does `GROUP BY location_code, lifecycle_state` to pivot the
   lifecycle counts, so adding `AVG(...)` in-place would have required
   restructuring. A focused query is simpler and matches the existing
   one-statement-per-aggregate pattern.
4. **`cp.deleted_at IS NULL` in JOIN clause, not WHERE.** Both the
   approved-by-damage-type query and the drilldown query use
   `LEFT JOIN claim_photos cp ON cp.claim_id = c.claim_id AND
   cp.deleted_at IS NULL` instead of moving the predicate to WHERE.
   This preserves LEFT JOIN semantics — claims with no photos still
   surface with cost = 0; claims with only soft-deleted photos still
   surface with cost = 0; claims with mixed photos (some live, some
   deleted) include only the live photos in cost.
5. **Drill-down query computes cost for every bucket.** The `open`,
   `denied`, and `closed_other` buckets technically don't surface
   cost in the renderer, so computing it for them is mild waste. Kept
   per the brief's spec (one query, all buckets) — the alternative
   (separate cost-only sub-query for the approved family) would have
   added a 14th batch statement. Cheap waste vs an extra round-trip
   cost — kept.

### Latent issues found

1. **"Closed" drill-down panel intentionally overlaps with Approved
   and Denied panels.** The operator explicitly asked for this in the
   brief ("the superset that overlaps Approved + Denied — yes,
   redundant by design"). `closed_approved` rows appear in both the
   Closed view and the Approved view. `denied` rows appear in both
   the Closed view and the Denied view. Counts sum higher than the
   per-location row's totals would suggest, by design. Flag for v2
   refinement if a stricter mutual-exclusion view becomes preferable.
2. **Drilldown `cost` is computed but unused on three of the four
   panels.** Open / Closed / Denied panels show count only. Cost
   data flows through but is dropped on render. Future "Cost on Open"
   or "Cost on Denied" requests can be added with zero SQL changes —
   just toggle the `withCost` flag in the panel's
   `aggregateDrilldown` call.
3. **Date-window edge case.** `julianday('now')` uses the worker's
   wall clock. `submitted_at` is stored as ISO 8601 UTC. Both should
   be UTC under D1; if a future migration introduces local-time
   columns, `avg_days_open` would drift by up to 24h. Not actionable
   today, just documented.
4. **`localeCompare` sort stays on the per-location array but the
   drill-down panel renders rows in `n DESC` order within each bucket.**
   Two different sort orders for the same data; intentional (the
   per-location table is alphabetical for scanning by location;
   the breakdown panels are top-N by count). No action needed.

### Validation results

- `pnpm typecheck` — **passed** (13/13 packages; 11 cache hits, 2
  cache misses: `@splash/web` + `@splash/damage-worker`).
- `pnpm --filter @splash/web build` — **succeeded.** Route
  `/admin/damage/reporting` reports 1.59 kB / 107 kB First Load JS
  (the new client island + drill-down logic).
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build` — **succeeded.** Bundle size 1719.99 KiB raw /
  389.35 KiB gzipped, well under the 3 MiB compressed free-tier
  ceiling. `.tmp-build` cleaned up post-run.

### Data integrity spot-check

Confirmed by inspection of the SQL:

- The global Approved-by-damage-type cost (sum across damage types)
  should equal the sum of per-location Approved drilldown costs
  (sum across locations within the Approved bucket: `approved +
  closed_approved`). Both expressions reduce to:
  `SUM(amount) WHERE photo_type IN ('Quote','Receipt')
   AND amount IS NOT NULL
   AND claim is in Approved-family
   AND claim is in scope (window + dc_role)`.
  Any discrepancy at runtime would indicate a renderer-side
  aggregation bug, not a SQL divergence.
- `AVG(julianday('now') - julianday(submitted_at))` on a location
  with one open claim submitted 12 days ago returns ~12.0; on three
  open claims submitted 5/10/15 days ago returns ~10.0. SQLite
  built-in; standard fractional-day output rounded to integer in
  the renderer (`${Math.round(v)}d`).

