# Brief 60: Reporting page — add "Open" damage-type breakdown alongside Approved / Denied

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Operator wants visibility into what damage types are
*currently in the pipeline* (in some stage of review), not just
which types end up Approved or Denied. Brief 59 only included the
two terminal-outcome breakdowns; Open claims were absent.
**Dependencies:** Brief 59 (the reporting endpoint and page that
this brief extends).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-059-damage-am-rm-filters-and-reporting-tab.md
  (Phase 6 — the reporting endpoint with Queries F/G; Phase 7.2 —
  the "By Damage Type" two-column layout)
- apps/damage-worker/src/index.ts (the new
  `GET /manage/api/reporting` handler from Brief 59 — the file
  this brief extends)
- apps/web/app/admin/damage/reporting/page.tsx (the reporting page
  Brief 59 created — the "By Damage Type" section is where the
  third column lands)

## Context

Brief 59's Reporting page renders a "By Damage Type" section with
two side-by-side tables: Approved (Query F) and Denied (Query G).
The categorization is by terminal outcome — Approved family +
closed-paid states vs. Closed — Denied.

Operator's 2026-05-06 follow-up: the operationally most useful
damage-type breakdown is "what's currently in flight" — the Open
pipeline (any non-`Closed —` status). That answers "where's the
volume coming from this period?" without waiting for claims to
close. Add a third column matching the existing two.

"Open" matches the existing `lifecycle_state === 'Open'`
definition Brief 59 already uses for the KPI tile and per-location
table — claim_status NOT starting with `Closed —`. This includes
the New / Pending / Approved-family-but-not-yet-closed states
(parts ordered, repaired, check-issued before paid, etc.).

## Scope

### Phase 1 — Damage-worker: new query in the reporting endpoint

1.1 In `apps/damage-worker/src/index.ts`'s reporting handler
(the one Brief 59 added), find the block that builds Queries F
(Approved damage-type breakdown) and G (Denied damage-type
breakdown). Add a sibling Query H:

```sql
SELECT COALESCE(damage_type, '(none)') as damage_type, COUNT(*) as n
FROM claims
WHERE location_code IN (...) AND submitted_at BETWEEN ? AND ?
  AND lifecycle_state = 'Open'
GROUP BY damage_type
ORDER BY n DESC
```

  - Same `location_code IN (...)` and `submitted_at BETWEEN ?
    AND ?` filters the other queries use.
  - `lifecycle_state = 'Open'` is the inverse of the
    Approved/Denied filters — a claim is in this breakdown iff
    its claim_status doesn't start with `Closed —`. Brief 59
    already exposed `lifecycle_state` as a queryable column.
  - `COALESCE(damage_type, '(none)')` mirrors the existing F/G
    pattern (legacy rows pre-Brief 41 lack damage_type).
  - `ORDER BY n DESC` for consistency.

1.2 Add the query result to the response shape under a new key:

```json
{
  "by_damage_type_open": [
    { "damage_type": "DS Mirror", "count": 12 },
    { "damage_type": "Antenna", "count": 7 }
  ]
}
```

  - Sits alongside `by_damage_type_approved` and
    `by_damage_type_denied`.

1.3 Update the response-typing on the worker side (the
TypeScript interface for the reporting response) to include
the new field.

### Phase 2 — apps/web: render the third column

2.1 In `apps/web/app/admin/damage/reporting/page.tsx`, find the
"By Damage Type" section. Brief 59 rendered a two-column layout
inside a `<two-col>` (Approved | Denied). Convert to three-column:

```tsx
<section id="by-damage-type">
  <h2>By Damage Type</h2>
  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
    <DamageTypeTable title="Open" rows={data.by_damage_type_open} />
    <DamageTypeTable title="Approved" rows={data.by_damage_type_approved} />
    <DamageTypeTable title="Denied" rows={data.by_damage_type_denied} />
  </div>
</section>
```

  - Order: Open / Approved / Denied. Open first because it's the
    "what's coming in" view operators glance at most often;
    Approved and Denied are terminal lookbacks.
  - On mobile (single-column), the order matters more — Open
    first surfaces the actionable information.
  - The existing `DamageTypeTable` component (or inline JSX
    Brief 59 used) gets reused; only the table title and
    rows-prop change.

2.2 If Brief 59's executor inlined the two tables rather than
extracting a `<DamageTypeTable>` helper, factor it out now —
three side-by-side variants justify the helper, and a shared
component prevents drift between the three.

2.3 Update the report's footnote to reflect the three-column
layout if it explicitly counted "two" — e.g., if the prior
footnote read "Approved / Denied breakdowns above," change to
"Open / Approved / Denied breakdowns above."

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass for all 13 packages.
3.2 `pnpm --filter @splash/web build` — must succeed.
3.3 `pnpm --filter @splash/damage-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed; clean
   up afterward.
3.4 No schema changes. No new env vars. No new endpoints.

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 60 row appended.

4.2 BUILD_STATE.md: Findings entry noting:
  - Reporting page's "By Damage Type" section gains a third
    column: Open (lifecycle_state = 'Open' — claims in the
    review pipeline, not yet closed)
  - Order on the page is Open / Approved / Denied — Open first
    because it's the "what's coming in" view operators glance
    at most often
  - Worker reporting endpoint's response now includes
    `by_damage_type_open` alongside the existing
    `by_damage_type_approved` / `by_damage_type_denied`
  - Operator follow-up: navigate /admin/damage/reporting and
    confirm the third column populates

4.3 No CLAUDE.md change needed — Brief 59 already documented the
Reporting endpoint and page; the additional column is consistent
with the documented behavior.

## Out of scope

- Sub-segmenting the Open column by stage (e.g., New vs. Pending
  GM vs. Pending RM vs. Approved-but-not-paid). The single
  "Open" bucket is the v1 ask. If operator later wants finer
  granularity, that's a v2 brief.
- Adding an "Open" KPI count or per-location Open column —
  those already exist on the Reporting page from Brief 59.
- Reordering or restyling the existing Approved/Denied tables
  beyond what's needed to fit a third sibling.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `GET /manage/api/reporting` response includes
  `by_damage_type_open: { damage_type: string; count: number }[]`
- The "By Damage Type" section on /admin/damage/reporting
  renders three tables (Open / Approved / Denied) instead of
  two
- Three-column grid on desktop; single-column stack on mobile
  with Open first
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run bundle succeeds (clean up after)
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely 30-50 lines net: one new SQL query +
  response field + JSX column + TypeScript interface
  extension)
- Confirmation that the worker's existing
  `lifecycle_state = 'Open'` filter pattern matches what's
  already used in the KPI block (Phase 6.2 Query A in Brief 59)
- Validation results
- Any decisions made on the operator's behalf

## Outcome

### Files modified

- `apps/damage-worker/src/index.ts` — added `byDamageTypeOpenSql`
  next to the existing `byDamageTypeApprovedSql` /
  `byDamageTypeDeniedSql`; appended to the `env.DB.batch` array
  (now 11 stmts instead of 10) at the next slot; added
  `byDamageOpenRes` from the batch result; added `byDamageOpen`
  mapping fold (`n → count`) identical to the existing
  approved/denied folds; extended `ReportingResponse` interface
  with `by_damage_type_open: ReportingByDamageTypeRow[]` (sibling
  to the existing approved/denied fields); placed
  `by_damage_type_open` between `by_location` and the existing
  damage-type fields in the response object so siblings stay
  grouped; extended `emptyReportingResponse` with
  `by_damage_type_open: []` so the no-data branch matches the
  populated shape.
- `apps/web/app/admin/damage/reporting/page.tsx` — extended the
  `ReportingResponse` TypeScript interface with
  `by_damage_type_open: Array<{ damage_type: string; count: number }>`;
  changed the "By Damage Type" section grid from `md:grid-cols-2`
  to `md:grid-cols-3`; invoked the existing `<DamageTypeTable>`
  helper a third time with `heading="Open"` +
  `rows={report.by_damage_type_open}` placed BEFORE the existing
  Approved + Denied tables (so mobile single-column stack surfaces
  Open first).
- `BRIEFS/INDEX.md` — Brief 60 row appended.
- `BRIEFS/QUEUE.md` — `brief-060-reporting-add-open-damage-type-breakdown.md`
  entry commented out with `(completed 2026-05-06)` suffix per the
  established pattern.
- `BUILD_STATE.md` — line 3 "Last updated" stamp prepended with
  Brief 60 narrative; new Findings & decisions log row inserted at
  the top of the table (above the prior Brief 58 row, since Brief
  59 was not added to the table by its executor — only line 3).

### Files created

None.

### Decisions made on operator's behalf

1. **Filter expressed as `lifecycle_state = 'Open'`** rather than
   re-deriving from `claim_status NOT LIKE 'Closed —%'` — the
   column is already exposed and Brief 59's KPI tile + per-location
   pivot already use this predicate; consistency wins. Confirmed
   by reading `getReporting`'s `lifecycleSql` Query A: it groups
   by `lifecycle_state` and the totals.open path keys off
   `r.lifecycle_state === "Open"`.
2. **No new helper component extraction** — the brief's Phase 2.2
   said "factor out a `<DamageTypeTable>` helper if Brief 59
   inlined the two tables" but Brief 59 already extracted the
   helper at the bottom of the page (lines 420-450). Reused as-is.
3. **Order Open / Approved / Denied** matches the brief's
   specified order; preserved verbatim. Open first because that's
   the "what's coming in" view operators glance at most often;
   on mobile (single-column) Open surfaces above the terminal
   lookbacks.
4. **`by_damage_type_open` is the SECOND key in the response
   object** (between `by_location` and `by_damage_type_approved`)
   so a future reader sees it grouped with its siblings.
5. **Queue commented in place + Findings table row inserted** —
   following the pattern from prior briefs (e.g., Brief 55, Brief
   58); Brief 59's executor skipped the Findings table row
   (only updated line 3), but Brief 60 follows the documented
   convention.
6. **Footnote left untouched** — the existing footnote at the
   bottom of the page reads "Cost = sum of approved quote amounts
   + receipt amounts. Claims with both a quote and a receipt may
   be double-counted (limitation flagged in Brief 59 — refine in
   v2)." It talks about cost-aggregation methodology, not the
   breakdown count, so the brief's Phase 2.3 conditional
   ("Update the report's footnote to reflect the three-column
   layout if it explicitly counted 'two'") doesn't apply.

### Latent issues / forward flags

- **Approved + Denied subset relationship to Open** — by design,
  an Open claim can later transition to Approved (counted by the
  Approved column once it terminates) or Denied. The three columns
  are NOT mutually exclusive over time, but for any given snapshot
  `submitted_at BETWEEN from AND to`, an individual claim row
  contributes to exactly one of {Open, Approved-family-closed,
  Denied-closed} based on its current `claim_status`. Sum of
  (Open + Approved + Denied) ≤ total claims for the window because
  some closed states (e.g., `Closed — Withdrawn`) are neither
  Approved-family nor Denied.
- **Bundle delta** — `apps/damage-worker` total upload **1705.76
  KiB / gzip 385.98 KiB** (Brief 55 baseline 1688.34 / 382.64;
  +17.42 KiB / +3.34 KiB gzip; the larger-than-expected delta
  reflects the cumulative effect of Briefs 56-59 on the
  damage-worker bundle, not Brief 60 specifically — Brief 60's
  diff is one ~10-line SQL block + ~5-line interface + result
  mapping). `apps/web` `/admin/damage/reporting` route 172 B /
  105 kB First Load JS — unchanged from Brief 59 baseline (same
  component tree, same client surface, just one extra
  `<DamageTypeTable>` instance).
- **No headless smoke test possible** — operator must navigate to
  `/admin/damage/reporting` after the next CF Workers Builds
  redeploys both `splash-damage` and `splash-web`, click QTD (or
  any window with claims in flight), and confirm the third Open
  column populates with non-zero rows. Open should be the leftmost
  column on desktop (`md:grid-cols-3`) and the topmost on mobile
  (single-column stack).
- **No schema change, no new env var, no new endpoint** — per
  brief Phase 3.4.

### Validation results

- `pnpm typecheck` — 13/13 successful (5.15s, 11 cache hits +
  fresh `@splash/web` and `@splash/damage-worker` rebuilds).
- `pnpm --filter @splash/web build` — succeeded; Next.js compiled
  in 3.6s; 13 static pages generated; all 14 routes present
  including `/admin/damage/reporting` at 172 B / 105 kB First
  Load JS (unchanged from Brief 59 baseline).
- `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build` — succeeded; Total Upload
  **1705.76 KiB / gzip 385.98 KiB**; all 6 bindings (DB /
  R2_BUCKET / IMAGES / MAINTAINX_MODE="test" / MAINTAINX_BASE_URL
  / APPS_WEB_BASE_URL) resolved cleanly. `.tmp-build` cleaned up
  afterward.

### Diff size

~30 lines net across the two source files:
- damage-worker: +13 (SQL block) +1 (interface field) +1
  (`emptyReportingResponse` field) +1 (batch stmt) +1 (batch
  result indexing) +4 (mapping fold) +1 (response field) ≈ 22
  lines.
- apps/web: +1 (interface field) +5 (additional `<DamageTypeTable>`
  invocation) +1 (`md:grid-cols-3` swap) ≈ 7 lines.

### Confirmation: lifecycle_state = 'Open' filter pattern matches existing usage

Verified by reading `getReporting` in `apps/damage-worker/src/index.ts`:
- The lifecycle Query A (`lifecycleSql`) groups by
  `lifecycle_state` and the totals.open path keys off
  `r.lifecycle_state === "Open"`.
- The per-location pivot Query (`byLocationSql`) does the same:
  groups by `(location_code, lifecycle_state)`, then per-row
  `r.lifecycle_state === "Open"` populates `row.open`.
- The new `byDamageTypeOpenSql` filters on
  `lifecycle_state = 'Open'` directly. Behaviorally equivalent.
