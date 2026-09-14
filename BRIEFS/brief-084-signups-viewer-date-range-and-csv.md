# Brief 84: Signups admin viewer — add date-range filter + CSV export (reuse Brief 83 components)

**Status:** Completed (2026-05-09)
**Drafted:** 2026-05-09
**Blocks:** Brief 56's signups admin viewer (`/admin/signups` and
`/admin/signups/{loc}`) currently has only a fixed 1/7/30 day
filter via a dropdown. Brief 83 introduced a richer
`<DateRangePicker>` (arbitrary `from`/`to` date pickers) and
`<CsvExportButton>` for fleet inquiries. This brief retrofits the
same UX onto the signups viewer so the operator gets symmetric
filtering and CSV export across both signup and fleet customer-
data surfaces.

**Dependencies:**
- Brief 83 (the fleet viewer that introduces
  `<DateRangePicker>` and `<CsvExportButton>` shared components,
  the worker-side CSV rendering pattern, and the admin endpoint
  shape this brief mirrors). MUST land first.
- Brief 56 (the signups viewer this brief enhances).

## Read first

- CLAUDE.md.
- BUILD_STATE.md.
- BRIEFS/INDEX.md.
- BRIEFS/brief-083-fleet-submissions-admin-viewer.md (the
  pattern this brief mirrors).
- BRIEFS/brief-056-signup-admin-rename-and-signups-viewer.md
  (the existing viewer being enhanced).
- apps/signup-worker/src/admin/* (or wherever the existing
  `GET /admin/api/locations/{loc}/signups` endpoint lives —
  executor should grep for the handler).
- apps/web/app/admin/signups/page.tsx and
  `apps/web/app/admin/signups/[location]/page.tsx` (the pages
  being modified).
- apps/web/app/_components/DateRangePicker.tsx and
  `apps/web/app/_components/CsvExportButton.tsx` (the shared
  components landed in Brief 83 and reused here verbatim).

## Context

### What changes vs Brief 56

Brief 56's existing endpoint:
```
GET /admin/api/locations/{loc}/signups?days=N
```
where `N ∈ {1, 7, 30}` (default 7), max 200 rows.

This brief extends with arbitrary date-range filtering and CSV
export:
```
GET /admin/api/locations/{loc}/signups?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=N
GET /admin/api/locations/{loc}/signups.csv?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Back-compat: the existing `?days=N` param keeps working unchanged
— if `from`/`to` are absent and `days` is present, the worker
computes `from = today - days` and `to = today`. New callers use
`from`/`to` directly.

### Why retrofit not redesign

The signups viewer's existing 1/7/30 dropdown was the simplest
thing in Brief 56. After using it for a few weeks, the operator
wants to look at specific date ranges (e.g., "the week of the
marketing push", "all signups in March") and export bulk data
for follow-up campaigns. Same need fleet has. Building two
date-range UIs would be duplicative; building one shared one
(Brief 83) and applying it to both surfaces is the right move.

### Worker-side CSV rendering

Mirror Brief 83's posture: the worker generates the CSV with
correct `Content-Disposition` headers; apps/web's CSV button is
just a `<a download>`. The CSV row schema for signups: every
user-facing column on `maxpass_signups` — name, email, phone,
location_code, package, terms_text, country, city, region,
created_at, confirmation_token (for support lookups), and any
other columns currently surfaced in the list page.

Same CSRF allow-list (Origin gate) as Brief 83's CSV endpoint.
Same 10000-row safety cap.

## Scope

### Phase 1 — Worker enhancement

**File:** `apps/signup-worker/src/admin/...` (executor greps for
the existing `handleSignupsForLocation` or similar handler from
Brief 56).

Extend the existing endpoint to accept `from` / `to` query params
in addition to the existing `days` param. Param resolution:
1. If both `from` AND `to` present: use them. Validate as
   `YYYY-MM-DD` strings; reject malformed with 400.
2. Else if `days` present: existing behavior unchanged
   (`from = today - days`, `to = today`).
3. Else: default `from = today - 30 days`, `to = today`.

PostgREST query gains `created_at=gte.{from}T00:00:00Z` and
`created_at=lte.{to}T23:59:59.999Z` filters.

Add a sibling endpoint:
```
GET /admin/api/locations/{loc}/signups.csv?from=YYYY-MM-DD&to=YYYY-MM-DD
```
Same auth gate (`adminGate` + `userCanAccessLocation`, both
exported from Brief 56). Renders CSV via the same `toCsv`
helper Brief 83 introduced — duplicate the helper into
signup-worker for now (cross-worker shared helpers are out of
scope; if both workers grow more shared utilities, a future
brief can extract a `@splash/csv` package). 10000-row safety cap.

Filename pattern:
`signups-{location_code}-{from}-to-{to}.csv`

### Phase 2 — Apps/web list pages

**Files:**
- `apps/web/app/admin/signups/page.tsx` (overview / location picker)
- `apps/web/app/admin/signups/[location]/page.tsx` (per-location list)

Per-location page changes:
1. Replace the existing `?days=N` dropdown with the shared
   `<DateRangePicker>` component (from Brief 83). Reads
   `searchParams.from` / `searchParams.to`; falls back to
   30-day default identical to fleet.
2. Add `<CsvExportButton csvUrl={...}>` next to the date picker.
   URL constructed by passing through current `from`/`to` params
   to the worker's `.csv` endpoint via the apps/web worker-fetch
   helper.
3. Update `apps/web/app/admin/signups/_lib/worker-fetch.ts` (or
   wherever the helper lives) to:
   - Accept `from`/`to` instead of (or in addition to) `days`.
     Keep `days` working for back-compat — anything that still
     calls with `days` keeps working.
   - Add a `getSignupsCsvUrl({ location, from, to })` helper
     that returns the URL string for the `<CsvExportButton>`.

Overview `/admin/signups` page is intentionally untouched (it's
a per-location picker, no filter / export at that level).

### Phase 3 — Validation

```sh
pnpm --filter @splash/signup-worker typecheck
pnpm --filter @splash/signup-worker build
pnpm --filter @splash/web typecheck
pnpm --filter @splash/web build
pnpm typecheck
```

Smoke test (after operator deploys both signup-worker AND
apps/web):
1. Navigate to `/admin/signups/oswego` (or any location with
   recent signups)
2. Date pickers default to last-30-days; list renders
3. Adjust dates — list updates
4. Click "Export CSV" — file downloads with all matching rows
5. Verify back-compat: an old bookmark URL with `?days=7`
   still works (renders last 7 days of signups, no error)

### Phase 4 — Documentation

1. **CLAUDE.md** — under the "Signup admin" glossary entry,
   note the date-range + CSV addition. Mention the back-compat
   `days=N` param.

2. **PRE_DEPLOY_SIGNUP.md** (or whatever the per-deployable file
   for signup-worker is called — executor greps to confirm) —
   add a smoke-test step for the new CSV endpoint.

3. **BUILD_STATE.md** — bump "Last updated" + Findings entry.

4. **BRIEFS/INDEX.md** — append Brief 84 row.

5. **BRIEFS/QUEUE.md** — entry already appended.

## Definition of Done

- `apps/signup-worker` exposes a new
  `GET /admin/api/locations/{loc}/signups.csv?from=&to=`
  endpoint with admin auth gate, location-scoped access check,
  worker-rendered CSV, and 10000-row safety cap.
- The existing `GET /admin/api/locations/{loc}/signups` endpoint
  accepts `from`/`to` params; `days` param continues to work.
- `apps/web/app/admin/signups/[location]/page.tsx` uses the
  shared `<DateRangePicker>` (from Brief 83) and shows a CSV
  Export button.
- `apps/web/app/admin/signups/_lib/worker-fetch.ts` (or
  equivalent) supports both old (`days`) and new (`from`/`to`)
  callers and exposes a helper for the CSV URL.
- `pnpm typecheck` passes; `pnpm --filter @splash/signup-worker
  build` and `pnpm --filter @splash/web build` succeed.
- Old `?days=7` URLs continue to render (back-compat verified
  in smoke test).
- Documentation updated per Phase 4.
- This brief's `Status:` flips to `Completed (YYYY-MM-DD)`.

## Out of scope

- Adding date-range filter to the `/admin/signups` overview
  page (it has no per-row data — just a location picker).
- Cross-location CSV (e.g., "all signups across every location
  in March") — the existing endpoint shape is location-scoped,
  matching the existing UX. A combined endpoint is a future
  brief if operator wants it.
- Editing / deleting signups — read-only.
- Per-day chart / aggregate view — out of scope; current list
  format is sufficient for v1.
- Extracting `toCsv` helper to a shared `@splash/csv` package
  (deferred until a third worker grows a CSV need).
- Touching the public signup form on `/signup/{location}/{pkg}`.

## Outcome

### Files created
None — Brief 84 reuses Brief 83's `<DateRangePicker>` and `<CsvExportButton>`
verbatim, and the existing signup-worker `admin-signups.ts` handler is the
home for the new CSV endpoint (no new module).

### Files modified
- `apps/signup-worker/src/handlers/admin-signups.ts` — rewritten to add
  `parseDateRange` (precedence: explicit `from`+`to` → legacy `days` →
  default last-30-days; mixed half-defaults rejected with 400),
  `parseLimit` (1..200 → default 200), expanded JSON response shape
  (`from`, `to`, `limit` added alongside the legacy `since`; `days` is
  non-null only when the caller used `?days=N`), and a new
  `handleGetAdminLocationSignupsCsv` handler. CSV export uses
  `select=*` to capture all 18 user-facing columns; RFC 4180 quoting;
  `Content-Disposition: attachment; filename="signups-{loc}-{from}-to-{to}.csv"`;
  same `adminGate` + `userCanAccessLocation` gate as the JSON list;
  defense-in-depth `isOriginAllowed` (CSRF on GET); 10000-row safety
  cap with 416 on overflow. Filter column = `submitted_at` (NOT
  `created_at` like fleet — `maxpass_signups` was indexed on
  `submitted_at` from Brief 56 onward).
- `apps/signup-worker/src/index.ts` — one new dispatcher branch for
  `GET /admin/api/locations/{loc}/signups.csv`, import for the new
  handler, route-table doc updated.
- `apps/web/app/admin/pricing/_lib/worker-fetch.ts` — new
  `SignupsParams` shape (`{from?, to?, days?, limit?}`),
  `buildSignupsQuery` helper, `getSignupsCsvUrl()` that returns an
  absolute URL when `NEXT_PUBLIC_SIGNUP_WORKER_URL` is set or a
  same-origin relative URL otherwise (mirrors `getFleetCsvUrl`).
  `getSignupsForLocation()` accepts either a `SignupsParams` object or
  the legacy bare `SignupDays` for back-compat with any existing caller.
  `SignupsResponse` type extended (`from`/`to`/`limit` added; `days`
  → `number | null`).
- `apps/web/app/admin/signups/[location]/page.tsx` — rewritten:
  swapped the 1/7/30 `<Link>` row for `<DateRangePicker>` (from
  `apps/web/app/_components/`) and added `<CsvExportButton>` next to
  it. Search-param resolution honors `from`/`to` first, then `days`,
  then default last-30-days. Legacy `?days=N` URLs render an inline
  back-compat day-filter strip beneath the date picker so the URL
  parameter doesn't appear ignored; the strip vanishes once the
  operator submits the new picker (URL moves to `from/to` shape).
- `CLAUDE.md` — "Signup admin" glossary entry rewritten with the new
  endpoint inventory, Brief 84 date-range + CSV semantics, the
  `submitted_at`-vs-`created_at` filter-column distinction, and the
  10000-row safety cap.
- `PRE_DEPLOY_SIGNUP.md` — six new smoke-test steps (10-15) covering
  the legacy `days` shape, the new `from/to` shape, malformed-`from`
  400, CSV download with `Content-Disposition` verification, bad-origin
  CSRF rejection, and per-location scope rejection.
- `BUILD_STATE.md` — "Last updated" line bumped with Brief 84 chunk;
  new entry at the top of the Findings & decisions log.
- `BRIEFS/INDEX.md` — Brief 84 row's Status flipped to
  `Completed (2026-05-09)`; description appended with the
  `submitted_at` filter-column distinction, 10000-row safety cap, and
  the legacy day-filter back-compat strip note.
- `BRIEFS/QUEUE.md` — `brief-084-...md` line moved into the
  completed-tombstone block above the queue.
- `BRIEFS/brief-084-signups-viewer-date-range-and-csv.md` — Status
  flipped; this Outcome section filled in.

### Decisions made on operator's behalf
- **Filter column = `submitted_at`** (NOT `created_at` like fleet).
  Fleet's CSV picked `created_at` because that's the Supabase row-creation
  default and the brief explicitly specified it. Signups was indexed on
  `submitted_at` from Brief 56 forward and the existing handler queried
  it; switching to `created_at` would require a Supabase index rebuild.
  Documented in CLAUDE.md and PRE_DEPLOY_SIGNUP.md.
- **Mixed half-default rejection.** When only `from` OR only `to` is
  passed (without the other), the worker returns 400 instead of silently
  filling in the other half from the legacy default. Avoids ambiguous
  bookmark URLs like `/admin/signups/{loc}?from=2026-01-01` that would
  silently expand to a different range than the operator intended. Both
  must be passed together.
- **Legacy day-filter strip preserved.** The inline 1/7/30 strip renders
  only when an old URL bookmark passes `?days=N`. Operators using the
  new picker never see it; the strip is removed from the URL on the
  next submit (since `from`+`to` take precedence). This keeps Brief 56
  bookmark URLs from looking broken without polluting the new UX.
- **`getSignupsForLocation` overload for back-compat.** The function
  now accepts either `SignupsParams` or the bare `SignupDays`
  (legacy Brief 56 signature). Any existing caller that still passes a
  number keeps working.
- **`getSignupsCsvUrl` returns a same-origin relative URL when
  `NEXT_PUBLIC_SIGNUP_WORKER_URL` is unset.** Mirrors
  `getFleetCsvUrl` from Brief 83. Works post-cutover when apps/web
  + signup-worker share the `splashcarwashes.info` zone; requires the
  env var on staging today (apps/web on `staging.splashcarwashes.info`,
  signup-worker on `splash-signup-next.<account>.workers.dev`).
- **CSV column inventory via `select=*` rather than an explicit
  allow-list.** The brief asked for "every user-facing column". Using
  `*` means future schema additions surface in the CSV automatically;
  the trade-off is the CSV header reorders if Postgres column order
  changes (rare). The explicit `CSV_COLUMNS` array still controls
  which columns the worker formats and labels — `select=*` just makes
  sure the row hash has every key the column array might reference.
- **`signups.csv` mounted as a separate dispatcher branch** (third-
  segment string-match) rather than a `?format=csv` query param on
  the existing endpoint. Keeps the 200 JSON / 200 text/csv content-type
  split clean and lets `<a download>` bind to a stable URL the browser
  can resolve without a custom Accept header.
- **CSV `isOriginAllowed` check applied** even though GET endpoints
  aren't traditionally CSRFable. Defense-in-depth only — same posture
  as the fleet CSV endpoint.

### Latent issues / forward flags
- (i) **Browser-issued CSV download depends on cookie domain scope.**
  Same caveat Brief 83 flagged for fleet — works post-cutover when
  signup-worker is on the `splashcarwashes.info` zone (the
  dashboard-worker's `Domain=splashcarwashes.info` cookie covers it).
  On workers.dev today the browser-issued CSV download from apps/web
  staging won't authenticate because the auth cookie isn't scoped to
  the workers.dev hostname. The service-binding-routed JSON list works
  regardless. PRE_DEPLOY_SIGNUP.md smoke step 13 documents this.
- (ii) **Mixed-shape URL precedence is silent.** If an operator hits
  `/admin/signups/{loc}?from=2026-01-01&to=2026-01-31&days=7` (e.g.,
  copy-pasted both shapes), the `days=7` is ignored — `from`+`to` take
  precedence. The legacy strip will render once and then drop on the
  next submit. Acceptable; the URL self-corrects.
- (iii) **No cross-location CSV.** Endpoint is location-scoped to match
  Brief 56's existing UX. Brief explicitly defers a global "all
  locations in March" export.
- (iv) **CSV column order reorders if Postgres column order changes.**
  `select=*` returns rows in column-definition order from PostgREST.
  The explicit `CSV_COLUMNS` array controls header order in the output,
  so this is mostly fine — but a column added in the middle of the
  `maxpass_signups` schema doesn't show up in the CSV until
  `CSV_COLUMNS` is updated. Acceptable trade-off — explicit allow-list
  was the alternative.

### Validation results
- `pnpm --filter @splash/signup-worker typecheck`: **green**.
- `pnpm --filter @splash/web typecheck`: **green**.
- `pnpm typecheck` (root, all 15 packages): **green**, 3.9s.
- `pnpm --filter @splash/signup-worker exec wrangler deploy --dry-run`:
  **green**, total upload 777.63 KiB / 150.21 KiB gzip — modest growth
  absorbed inside `admin-signups.ts` (no new package weight; CSV-rendering
  and date-parsing helpers are inline).
- `pnpm --filter @splash/web build`: **green**, Next.js 15.5.15 compiled
  in 4.5s; all 14 routes generated. `/admin/signups/[location]` 920 B /
  106 kB First Load JS — matches `/admin/fleet` exactly (same component
  set). No regressions on prior routes.
- `pnpm --filter @splash/signup-worker build`: **n/a** — workers don't
  have a `build` script (per Brief 79's latent finding); deploy-time
  bundling happens via `wrangler deploy`. The dry-run above is the
  build verification.

### Operator follow-ups before the new endpoints are usable
1. Deploy `splash-signup-next`:
   ```powershell
   pnpm --filter @splash/signup-worker exec wrangler deploy
   # or push-to-GH if CF Builds is wired
   ```
2. Deploy apps/web (push-to-GH).
3. (Optional, only if running on cross-origin staging today) set
   `NEXT_PUBLIC_SIGNUP_WORKER_URL` on apps/web's CF Workers Builds
   environment to `https://splash-signup-next.<account>.workers.dev`
   so the CSV export `<a download>` can resolve. Skip post-cutover.
4. Smoke per PRE_DEPLOY_SIGNUP.md steps 10-15:
   - Log in as super_admin (or location_admin with `pricing` grant +
     scope), navigate to `/admin/signups/{loc}`, confirm last-30-days
     renders.
   - Adjust the date range; confirm list updates.
   - Click "Export CSV"; confirm download with the right filename.
   - Open an old `?days=7` bookmark; confirm the page renders the
     legacy day-filter strip and lists the last 7 days.
   - Repeat as a `location_admin` for a different location; confirm
     403 → "no access" card.
