# Brief 179: Report kit — one way to build reports (TanStack Table + Tremor)

**Status:** In progress — kit + pilot 1 (Fleet) done; pilots 2-3 next
**Started:** 2026-10-30
**Completed:**
**Blocks:** Neither
**Dependencies:** none

## Read first
- BUILD_STATE.md
- CLAUDE.md
- This brief's Inventory section (it is the evidence for every decision below)

## Context

Every report in apps/web was built on the day it was needed, and it shows.
Twelve report-style surfaces exist; none share a table, filter bar, date
model, export path or chart approach. The same helpers have been copied
between them (5 CSV escapers, 4 Eastern-time helpers, 4 copies of the
admin-tier predicate, `formatAbsolute`/`formatRelative` copied line for line
between fleet and signups), and the copies have drifted: some reports treat
"today" as Eastern, others as UTC; some CSVs end lines `\r\n`, others `\n`;
fleet/signups/forms render timestamps with a bare `toLocaleString()`, which is
UTC on Workers.

The operator wants a toolkit used IN CODE, not a hosted BI tool: a standard
way to declare a report so new ones are mostly configuration and every report
gets the same filters, table, totals, exports and date handling. Chosen
libraries: **TanStack Table** (headless table engine; we keep Splash styling)
and **Tremor** (KPI cards + charts on Tailwind).

## Inventory (2026-10-30)

| Report | Data | Scoping | Filters | Output | Exports |
|---|---|---|---|---|---|
| Damage reporting `/admin/damage/reporting` | D1 `/manage/api/reporting` | `damageScopeForSession` | 5 window presets (UTC), location, RD, RM | KPI tiles, cost-per-car table + total, expandable drilldown | none |
| Damage list `/admin/damage` | D1 `/manage/api/claims` | same | search, location, status, lifecycle, RD, RM, raw date inputs | flat table, row cap | CSV + XLSX (worker, `@splash/xlsx`), apps/web proxy |
| Car counts `/admin/damage/car-counts` | D1 | same | none | CRUD table | none |
| Greeter report `/admin/greeters/report` (2191 lines) | Supabase via performance-worker | `locationScopeFor` + RD/RM narrowing | view presets, from/to, location, greeter, RD, RM | KPI tiles w/ prior-period deltas, hand-rolled SVG charts, 3 tables | none |
| Maintenance `/admin/maintenance` | Supabase `mt_*` views | admin tier only | 7 period presets (Eastern), tabs | fact/figure tiles, grouped tables | none |
| Performance `/admin/performance` | Supabase | **tool gate only — see Latent issues** | raw dates, location, ~9 others | flat table | none |
| JotForm `/admin/jotform/{id}` | Supabase | site-number scope | DateRangePicker (today ET), site, RD, RM, location | grouped by site, 2000 cap | CSV (worker) |
| Signups `/admin/signups/{loc}` | Supabase | pricing gate + location | DateRangePicker (30d UTC) | flat table | CSV (worker, `\n`) |
| Forms submissions `/admin/forms/{id}/submissions` | Supabase | `submissionGate`/`formScopeFor` | DateRangePicker (30d UTC), status, submitter kind, view toggle | flat or wide schema-union table | CSV, PDF aggregate (`@splash/pdf-report`) |
| Fleet `/admin/fleet` | Supabase | admin tier | DateRangePicker (30d UTC) | flat table | CSV (proxy, `\n`) |
| Expenses `/admin/expenses` | Supabase | `locationScopeFor` copy | month, location, category, q | site × category pivot w/ budget/variance | none |
| Golden ticket `/admin/golden-ticket` | Supabase view | admin or tag | promo, status tabs, q | cards | none |

What 3+ of them share: URL-driven filters read in a server component (all 12),
a date range or period preset (10), a location filter and RD/RM filters (7 / 4),
a flat or grouped table (all), KPI tiles (3), CSV generated in the worker (5).

## Design

Two layers. The split follows the data: sources differ (PostgREST, D1,
MaintainX mirror, SQL rollups) and stay where they are; everything around the
data is standardised.

### 1. `packages/report-kit` (new; plain TS, no React, runs in Workers and Next)

- **`defineReport(def)`** — a typed declaration, shared by the worker and the page:
  ```ts
  export const fleetReport = defineReport({
    id: "fleet-inquiries",
    title: "Fleet inquiries",
    dateColumn: "submitted_at",
    defaultRange: "last_30",
    filters: [statusFilter(["new", "reviewed", "contacted", "closed"])],
    columns: [
      col.datetime("submitted_at", "Submitted"),
      col.text("company_name", "Company"),
      col.text("location_code", "Location"),
      col.enum("status", "Status"),
    ],
    groupBy: null,
    totals: ["count"],
    exports: ["csv", "xlsx"],
  });
  ```
- **Column kinds** carry formatting once: `text`, `number`, `currency` (dollars),
  `cents` (integer cents — the MaintainX convention), `percent`, `date`,
  `datetime` (always rendered in America/New_York), `email`, `enum`, `link`.
- **Time: ONE Eastern implementation.** `todayEastern()`, `resolveRange(preset |
  {from,to}) -> {fromDate, toDate, fromUtc, toUtc}` with presets `today`,
  `yesterday`, `last_7`, `last_30`, `mtd`, `past_month`, `qtd`, `past_quarter`,
  `ytd`, `custom`, and `formatEt(iso)`. Lifted from jotform-worker's
  `todayInEastern` / `easternWallClockToUtcMs` (DST-aware, already proven). This
  replaces the four existing Eastern helpers and every `ymdUtc` default as
  reports migrate — NOT in a big-bang sweep.
- **Params:** `parseReportParams(def, searchParams)` — one parser used by the
  page (to render the filter bar) and the worker (to run the query), so the two
  cannot disagree about defaults. Unknown params ignored; bad dates fall back to
  the default range rather than 400ing a bookmarked URL.
- **Exports:** `toCsv(def, rows)` — RFC 4180, `\r\n`, UTF-8 BOM so Excel opens
  it as UTF-8, one escaper; `toXlsx(def, rows)` wrapping `@splash/xlsx`; one
  filename rule `{report-id}-{from}-to-{to}.{ext}` using Eastern dates.
- **Aggregation:** `groupRows`, `totals` (count/sum/avg) for reports that
  aggregate in JS. Reports whose totals come from SQL (expenses rollup) pass
  them through and the kit renders them; the kit never recomputes a total the
  database already owns.
- **Scope helpers:** `isAdminTier(session)` — the single copy of the predicate
  now duplicated in four workers. Row scoping itself stays in each worker's
  existing gate (`submissionGate`, `damageScopeForSession`, ...); the kit only
  standardises how a scope reaches a query (`locationScope: string[] |
  undefined`, where `undefined` means unscoped and `[]` means match nothing —
  the distinction forms-worker already learned the hard way).

### 2. apps/web `app/_components/report/` (React; TanStack + Tremor)

- **`<ReportPage def data>`** — the standard layout: title, filter bar, KPI
  row (optional), chart (optional), table, export buttons, "showing N of M" /
  cap banner. A report page becomes: parse params, fetch, render `<ReportPage>`.
- **`<ReportFilterBar>`** — preset chips + the existing `DateRangePicker` for
  custom ranges, location / RD / RM selects fed by a roster, status selects.
  URL-driven (server components keep working; no client state for filters).
- **`<ReportTable>`** — TanStack Table: sortable headers, optional grouping
  with per-group counts, totals footer, sticky header, column visibility,
  cell rendering from the column kind. Client island; rows arrive from the
  server component.
- **`<KpiRow>` / charts** — Tremor `Card` + metric, `BarChart`, `LineChart`,
  `DonutChart`. Prior-period delta support (greeters already need it).
- **`<ExportButtons>`** — replaces `CsvExportButton`; one delivery rule:
  same-origin path where the worker is path-carved, apps/web proxy route where
  it is not (fleet's subdomain is the reason the proxy pattern exists).

### Tremor version decision (executor confirms before installing)
`@tremor/react` v3 declares a React 18 peer; apps/web is React 19 and
Tailwind 3.4. Check current Tremor peer ranges first. If v3 does not support
React 19 cleanly, use Tremor's copy-in components (they are source files built
on Tailwind + Recharts) placed under `app/_components/report/tremor/`, and
confirm they build on Tailwind 3. Do not upgrade Tailwind for this brief.

## Scope

1. Create `packages/report-kit` (types, `defineReport`, column kinds, Eastern
   time, params parser, CSV/XLSX, aggregation, `isAdminTier`) with vitest
   coverage for: DST boundaries in `resolveRange`, every preset, CSV escaping
   (quotes, commas, newlines, leading `=`/`+`/`-`/`@` formula injection), and
   the `undefined` vs `[]` scope rule.
2. Add `@tanstack/react-table` and Tremor (per the decision above) to apps/web.
3. Build `app/_components/report/` (`ReportPage`, `ReportFilterBar`,
   `ReportTable`, `KpiRow`, chart wrappers, `ExportButtons`).
4. **Pilot 1 — Fleet.** Simplest report (admin-only, flat, CSV). Convert page +
   fleet-inquiry-worker CSV to the kit. Removes fleet's UTC default and bare
   `toLocaleString()`.
5. **Pilot 2 — Signups.** Same shape, but scoped (pricing gate + location) and
   currently a line-for-line copy of fleet's helpers. Proves the kit with
   scoping and kills the duplication.
6. **Pilot 3 — Damage reporting KPIs + one chart.** Proves Tremor on a real
   aggregate page; also moves its windows from UTC to Eastern. Data endpoint
   unchanged apart from window resolution.
7. Document the kit in CLAUDE.md (Glossary: "report kit") including the
   rule: **new reports use `defineReport` + `<ReportPage>`; do not hand-roll a
   table, date default, CSV escaper or Eastern helper.**

Remaining reports (jotform, forms, damage list, maintenance, expenses,
greeters, performance) migrate in follow-up briefs, one or two per brief, so
each is reviewable on its own.

## Out of scope
- Rewriting the greeter report or expenses pivot (follow-ups; biggest and
  most bespoke).
- Changing any worker's permission rules. The kit standardises how a scope is
  passed, not who gets which rows.
- The performance submissions scoping bug (below) — fixed separately 2026-10-30.
- Customer-facing URLs (constraint #1) — reports are admin-only.
- Hosted BI (Metabase etc.) — operator chose code.
- Don't deploy, don't bind routes, don't commit or push without instruction.

## Definition of done
- `pnpm typecheck` passes; `pnpm --filter @splash/web build` succeeds.
- `packages/report-kit` tests pass.
- Fleet, signups and damage reporting render via `<ReportPage>`; their
  CSVs come from `toCsv`; their dates are Eastern; their old local
  `formatAbsolute` / `formatRelative` / `ymdUtc` copies are deleted.
- Bookmarked URLs for those pages keep working (same param names, or the
  parser accepts the old ones).
- BUILD_STATE.md and CLAUDE.md updated.

## Latent issues found during the inventory (not fixed here)
- **FIXED 2026-10-30 (separately): `GET /pertrack/api/submissions` had no row scoping.**
  `apps/performance-worker/src/index.ts` checks only the `pertrack` tool, then
  `apiListSubmissions(url, env)` receives no session and lists every site's
  rows. Anyone with Performance access can read all locations. Separate brief:
  pass the session and apply the same `locationScopeFor` the greeter endpoints
  use.
- Fleet, signups and forms timestamps display in UTC (`toLocaleString()` with
  no `timeZone` on Workers) — fixed for fleet/signups by the pilots; forms
  follows when it migrates.
- `@splash/pdf-report` exports a `formatEst` returning a string; apps/web's
  `formatEst` returns `{absolute, relative}`. Same name, different contract —
  the kit's `formatEt` should become the one both use.
- Expenses `_lib/ui.tsx` is an admitted copy of greeter report components.

## Report
(Filled in on completion.)

## Outcome
(Filled in on completion.)
