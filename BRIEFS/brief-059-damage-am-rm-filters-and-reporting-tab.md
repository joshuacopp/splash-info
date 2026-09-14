# Brief 59: Damage list filters by Regional Director / Regional Manager + new Reporting tab with anchor-nav layout

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Operator wants to slice damage claims by who's
accountable (Regional Director = `area_manager` field, Regional
Manager = `regional_manager` field) on both the existing list view
and a new corporate-style Reporting tab. Today the only filters are
location/status/lifecycle/search; AM/RM accountability isn't
surfaced.
**Dependencies:** None.

## Read first

- CLAUDE.md (label mapping note: org's `area_manager` field stores
  the Regional Director's name; `am_email` is their email.
  `regional_manager` / `rm_email` are the Regional Manager.
  Field names stay; UI labels become "Regional Director" /
  "Regional Manager")
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-005a-damage-claim-list.md (the existing list page —
  current filters: location/status/lifecycle/search)
- BRIEFS/brief-027-sysadmin-update-location.md (the editor that
  feeds `pricing_simple.area_manager` / `regional_manager` /
  `am_email` / `rm_email` via the locations-side cascade trigger)
- apps/damage-worker/src/index.ts (`getClaimsList` ~L464,
  `listClaims` import; `damageScopeForSession` for dc_role
  scoping)
- packages/db-d1/src/claims.ts (`listClaims`, `ClaimsListFilters`)
- packages/types/src/claims.ts (`ClaimStatus` — 15 values; the
  `Approved —` prefix family + the three `Closed —` outcomes)
- packages/db-d1/src/photos.ts (cost data on `claim_photos.amount`;
  `photo_type` allow-list includes 'Quote' and 'Receipt')
- apps/web/app/admin/damage/page.tsx (the existing list page)
- apps/web/app/admin/damage/_components/* (existing filter
  components — pattern to mirror for the new AM/RM dropdowns)
- packages/db-supabase/src/locations.ts (the
  `getActiveLocationByCode` helper — same module will gain a
  sibling for "list distinct AM/RM emails+names")

## Context

Claims data lives in D1; AM/RM accountability lives in Supabase
(`pricing_simple` / `locations`). To filter or aggregate claims by
Regional Director or Manager, the worker needs to:

1. Pull the set of `location_code`s assigned to a given AM/RM
   (Supabase query against `pricing_simple` or `locations`)
2. Apply that set as an `IN` clause on `claims.location_code`
   (D1 query)

This is the same two-step join the existing Brief 27 / Brief 33
helpers used. It costs one extra Supabase round-trip per filtered
request — acceptable for a manager-facing report.

Cost data per the operator's 2026-05-06 decision: "approved
amounts from approved quotes + amount from submitted receipts."
Quotes are "approved" when the parent claim's `claim_status`
matches the Approved-family prefix (`Approved —*`) or one of the
Closed-paid outcomes (`Closed — Paid`, `Closed — Approved/No
Response`). The cost cell sums `claim_photos.amount` across both
photo_types ('Quote' AND 'Receipt') for those qualifying claims.

Edge case (operator-acknowledged): if a claim has BOTH a quote
AND a receipt, the sum double-counts. v1 accepts this as
"close enough"; v2 could resolve per-claim (prefer receipt when
present). Brief flags this in the Findings entry and in the
report's footer hint.

Status families for the Reporting tab:
- **Open** = `lifecycle_state === 'Open'` (any non-`Closed —`
  status)
- **Closed** = `lifecycle_state === 'Closed'` (any `Closed —`
  status)
- **Approved** = claim_status starts with `Approved —` OR equals
  `Closed — Paid` OR equals `Closed — Approved/No Response` (the
  approved-outcome closed states)
- **Denied** = claim_status equals `Closed — Denied`
- **Pending review** = anything else (the `New —`, `Pending GM
  Review`, `Pending RM Review`, `No Responsibility — Pending Review`
  states)

## Scope

### Phase 1 — New signup-worker-side helper for AM/RM lists

1.1 In `packages/db-supabase/src/locations.ts`, add a sibling
helper:

```ts
export interface ContactRosterEntry {
  email: string;          // canonical (am_email or rm_email)
  name: string;           // display (area_manager or regional_manager)
  location_codes: string[]; // locations they're assigned to
}

export async function listContactRoster(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  role: "regional_director" | "regional_manager"
): Promise<ContactRosterEntry[]>
```

  - Reads `pricing_simple` (single source of truth post-Brief 33).
  - role === "regional_director" → groups by `am_email`, label
    field is `area_manager`.
  - role === "regional_manager" → groups by `rm_email`, label
    field is `regional_manager`.
  - Skip rows where the email field is null or empty.
  - Group: `{ email → { name: first non-null name seen,
    location_codes: [...] } }`. If two rows have the same email but
    different names (rare data hygiene case), use the most-common
    name; ties broken by lexicographic.
  - Return sorted by name asc.
  - Fail-soft: any thrown error returns `[]`.
  - PostgREST query:
    ```
    ${env.SUPABASE_URL}/rest/v1/pricing_simple
      ?select=location_code,am_email,area_manager,rm_email,regional_manager
      &<email_field>=not.is.null
      &order=<name_field>.asc
      &limit=1000
    ```

1.2 Export the helper from
`packages/db-supabase/src/index.ts` so callers can import it.

### Phase 2 — Damage-worker endpoint: AM/RM rosters

2.1 In `apps/damage-worker/src/index.ts`, add:

```
GET /manage/api/contact-roster?role=regional_director|regional_manager
```

  - Auth: same gate as `/manage/api/claims` (dc_role required;
    `denied` → 403; `scoped` → roster filtered to locations the
    user can see; `global` → full roster).
  - Returns `ContactRosterEntry[]` as JSON.
  - For `scoped` users, intersect each entry's `location_codes`
    with `scope.codes`; drop entries whose intersected list is
    empty (so a location_admin doesn't see RDs/RMs who don't cover
    any of their locations).

2.2 Wire the new endpoint into the worker's router alongside the
existing `/manage/api/claims` handler.

### Phase 3 — Damage-worker: extend `listClaims` with AM/RM filters

3.1 In `packages/db-d1/src/claims.ts`, extend `ClaimsListFilters`:

```ts
export interface ClaimsListFilters {
  // existing fields
  locationCodes?: string[];
  lifecycle?: LifecycleState | "All";
  claimStatus?: ClaimStatus;
  search?: string;
  // Brief 59
  submittedFrom?: string;  // ISO; inclusive
  submittedTo?: string;    // ISO; inclusive
}
```

  - The AM/RM filter is implemented by the worker resolving AM/RM
    → location_codes via the new helper, then passing the
    intersected `locationCodes` array to `listClaims`. So
    `ClaimsListFilters` itself doesn't need an `am_email` field —
    the resolution happens upstream.
  - Date range as ISO strings; both inclusive. SQL:
    `submitted_at >= ?` and `submitted_at <= ?`. Skip when
    undefined.

3.2 Update the `WHERE` clause builder in `listClaims` to include
the new date conditions.

### Phase 4 — Damage-worker: extend `getClaimsList` (the existing endpoint) with AM/RM + date params

4.1 In `apps/damage-worker/src/index.ts`'s `getClaimsList` handler
(~L476), accept new query params:

  - `regional_director_email` — single email; resolve via
    `listContactRoster("regional_director")` to a set of
    location_codes. Intersect with the user's dc_role scope.
  - `regional_manager_email` — same pattern for RM.
  - `submitted_from` / `submitted_to` — ISO date strings; pass
    through to `listClaims`.

4.2 If both `regional_director_email` and `regional_manager_email`
are set, intersect both sets (claim must match both — same
location must be covered by both the named RD and RM). If the
intersection is empty, return `[]` immediately without hitting D1.

4.3 If a single AM/RM email doesn't resolve to any locations the
user can access, return `[]` (out-of-scope → empty, same posture
as existing location filter).

### Phase 5 — apps/web filter UI on /admin/damage list page

5.1 In `apps/web/app/admin/damage/page.tsx`'s filter section, add
two new selects:
  - "Regional Director" — fetches options from
    `/manage/api/contact-roster?role=regional_director` on initial
    server render.
  - "Regional Manager" — fetches options from
    `/manage/api/contact-roster?role=regional_manager`.
  - Both default to "(any)". Selection writes to URL search params
    `regional_director_email` / `regional_manager_email`.

5.2 The filter form is GET-method (consistent with existing damage
list filter), so submit reloads the page with new search params.
Existing filters preserved.

5.3 Add a date-range pair: "Submitted from" / "Submitted to" with
HTML5 date inputs. URL params: `submitted_from` /
`submitted_to`. Invalid dates fall through (treated as missing).

### Phase 6 — Damage-worker: new reporting endpoint

6.1 Add:

```
GET /manage/api/reporting?location=<code|All>
                         &regional_director_email=<email>
                         &regional_manager_email=<email>
                         &window=current_month|past_month|qtd|past_quarter|ytd
```

  - Auth: same dc_role gate as `getClaimsList`.
  - Window resolution (server-side, anchored to "now" at request
    time):
    - `current_month`: from first day of current month 00:00 UTC
      to now
    - `past_month`: full previous calendar month
    - `qtd`: from first day of current calendar quarter (Jan/Apr/
      Jul/Oct) to now
    - `past_quarter`: full previous calendar quarter
    - `ytd`: from Jan 1 of current year to now
  - Default window if missing: `qtd`.
  - All filters compound (intersect) with the user's dc_role scope.

6.2 Inside the handler:
  1. Resolve the target `location_codes` set (same path as
     `getClaimsList` Phase 4).
  2. Compute window start/end ISO.
  3. Run a single D1 batch:
     - Query A: claim counts grouped by `lifecycle_state` for the
       full filter set.
       ```sql
       SELECT lifecycle_state, COUNT(*) as n
       FROM claims
       WHERE location_code IN (...) AND submitted_at BETWEEN ? AND ?
       GROUP BY lifecycle_state
       ```
     - Query B: claim count for "Approved" outcome family.
       ```sql
       SELECT COUNT(*) as n FROM claims
       WHERE location_code IN (...) AND submitted_at BETWEEN ? AND ?
         AND (claim_status LIKE 'Approved —%'
              OR claim_status = 'Closed — Paid'
              OR claim_status = 'Closed — Approved/No Response')
       ```
     - Query C: claim count for "Denied".
       ```sql
       SELECT COUNT(*) as n FROM claims
       WHERE location_code IN (...) AND submitted_at BETWEEN ? AND ?
         AND claim_status = 'Closed — Denied'
       ```
     - Query D: total cost via JOIN to claim_photos.
       ```sql
       SELECT SUM(cp.amount) as cost
       FROM claim_photos cp
       JOIN claims c ON c.claim_id = cp.claim_id
       WHERE c.location_code IN (...)
         AND c.submitted_at BETWEEN ? AND ?
         AND cp.photo_type IN ('Quote', 'Receipt')
         AND (c.claim_status LIKE 'Approved —%'
              OR c.claim_status IN ('Closed — Paid','Closed — Approved/No Response'))
         AND cp.amount IS NOT NULL
       ```
     - Query E: per-location breakdown (used for "By Location"
       section).
       ```sql
       SELECT location_code, location_pretty, lifecycle_state, COUNT(*) as n
       FROM claims
       WHERE location_code IN (...) AND submitted_at BETWEEN ? AND ?
       GROUP BY location_code, lifecycle_state
       ORDER BY location_code
       ```
     - Query F: damage-type breakdown for Approved.
       ```sql
       SELECT COALESCE(damage_type, '(none)') as damage_type, COUNT(*) as n
       FROM claims
       WHERE location_code IN (...) AND submitted_at BETWEEN ? AND ?
         AND (claim_status LIKE 'Approved —%'
              OR claim_status IN ('Closed — Paid','Closed — Approved/No Response'))
       GROUP BY damage_type
       ORDER BY n DESC
       ```
     - Query G: damage-type breakdown for Denied (same shape, with
       claim_status = 'Closed — Denied' instead).

6.3 Return:

```json
{
  "window": "qtd",
  "from": "2026-04-01T00:00:00.000Z",
  "to": "2026-05-06T18:00:00.000Z",
  "filters": { "location": "All", "rd_email": null, "rm_email": null },
  "totals": {
    "open": 23,
    "closed": 41,
    "approved": 31,
    "denied": 8,
    "repair_cost": 18745.50
  },
  "by_location": [
    { "location_code": "oswego", "location_pretty": "Oswego",
      "open": 4, "closed": 7, "approved": 5, "denied": 2,
      "repair_cost": 3210.00 }
  ],
  "by_damage_type_approved": [
    { "damage_type": "DS Mirror", "count": 12 },
    { "damage_type": "Antenna", "count": 7 }
  ],
  "by_damage_type_denied": [
    { "damage_type": "Pre-existing damage", "count": 3 }
  ]
}
```

  - `repair_cost` is the sum from Query D (treats null as 0).
  - `by_location` rows assemble per-location counts from Query E
    (lifecycle pivoted to columns) plus per-location cost from a
    sibling JOIN-grouped variant of Query D (executor's call:
    can be a separate query or a JOIN+GROUP BY in one).
  - `damage_type` "(none)" surfaces claims missing `damage_type`
    (legacy rows pre-Brief 41).

### Phase 7 — apps/web: new /admin/damage/reporting page

7.1 Create `apps/web/app/admin/damage/reporting/page.tsx`. Server
component. Reads filters from URL searchParams; calls the new
`/manage/api/reporting` endpoint.

7.2 Layout (multi-section with anchor nav per operator's
2026-05-06 decision):

```
<DamageTabs active="reporting" />        ← new tab nav (Phase 8)

<sticky-nav>
  <a href="#overview">Overview</a>
  <a href="#by-location">By Location</a>
  <a href="#by-damage-type">By Damage Type</a>
</sticky-nav>

<filter-row>
  Window:    [Current month] [Past month] [QTD] [Past quarter] [YTD]
  Location:  <select>
  Reg. Director: <select>
  Reg. Manager:  <select>
  [Apply]
</filter-row>

<section id="overview">
  <h2>Overview</h2>
  <kpi-grid>
    [Open: 23] [Closed: 41] [Approved: 31] [Denied: 8]
    [Repair Cost: $18,745.50]
  </kpi-grid>
</section>

<section id="by-location">
  <h2>By Location</h2>
  <table>
    Location | Open | Closed | Approved | Denied | Cost
    ...
  </table>
</section>

<section id="by-damage-type">
  <h2>By Damage Type</h2>
  <two-col>
    <table>Approved: [type | count] (sorted desc)</table>
    <table>Denied: [type | count] (sorted desc)</table>
  </two-col>
</section>

<footnote>Cost = sum of approved quote amounts + receipt
amounts; claims with both may be double-counted (limitation
flagged in Brief 59 — refine in v2).</footnote>
```

7.3 Sticky nav: position-sticky at top, scrolls with page,
anchor links scroll to sections smoothly. Use `scroll-mt-20` or
similar Tailwind pattern on each section heading so the sticky
nav doesn't cover the title.

7.4 Window button group: five buttons; active styled like the
existing day-filter on signups page (Brief 56 pattern). URL param
`window=` updates on click.

7.5 Use the centered Tailwind pattern (`mx-auto w-full
max-w-[1100px] px-5 py-9`) per Brief 58's convention.

7.6 KPI tiles: 5-column grid on desktop (collapses to 2-col on
mobile). Each tile is a card with the metric label + the value
in the splash-navy heading style.

### Phase 8 — Tab nav: list ↔ reporting

8.1 Create `apps/web/app/admin/damage/_components/DamageTabs.tsx`
(server component). Two tabs:
  - "Claims" → `/admin/damage`
  - "Reporting" → `/admin/damage/reporting`

8.2 Mount it on both `apps/web/app/admin/damage/page.tsx` and
`apps/web/app/admin/damage/reporting/page.tsx`. Visual style
mirrors the SignupAdminTabs from Brief 56 (pill-tabs).

8.3 The detail page `/admin/damage/[id]` does NOT get the tab
nav (it's a deeper drill-down inside Claims). The "← Back to
list" link there preserves the prior behavior.

### Phase 9 — Validation

9.1 `pnpm typecheck` — must pass for all 13 packages.
9.2 `pnpm --filter @splash/web build` — must succeed.
9.3 `pnpm --filter @splash/damage-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed; clean up
   afterward.
9.4 No schema changes (Brief 41 already added `damage_type`;
`claim_photos.amount` already exists).
9.5 No new env vars or secrets.
9.6 No new wrangler bindings.
9.7 Confirm dc_role scoping holds: a `gm` user with one location
should see only their location's data in both filters and
report; the AM/RM dropdowns should only contain RDs/RMs who
cover that location.

### Phase 10 — Updates

10.1 BRIEFS/INDEX.md: Brief 59 row appended.

10.2 BUILD_STATE.md: Findings entry noting:
  - Damage list filter row gains Regional Director / Regional
    Manager / Submitted-from / Submitted-to filters
  - New `/admin/damage/reporting` page with sticky anchor nav,
    KPI tiles, by-location table, damage-type breakdowns
  - 5 window presets: current month / past month / QTD / past
    quarter / YTD; default QTD
  - New endpoints: `GET /manage/api/contact-roster?role=`,
    `GET /manage/api/reporting?...`
  - New `DamageTabs` component at
    `apps/web/app/admin/damage/_components/DamageTabs.tsx`
  - Repair cost = sum of Quote+Receipt amounts on Approved-family
    claims; flagged limitation: double-counts when a claim has
    both quote AND receipt (v2 candidate)
  - dc_role scoping continues to apply: RD/RM dropdowns and
    report data are intersected with the user's dcLocations
  - Operator follow-up: navigate /admin/damage → click Reporting
    tab → confirm KPIs populate with QTD numbers; flip windows
    + filters to verify scoping; confirm "Regional Director"
    label matches operator's mental model (org calls this role
    "Regional Director" but the data field is `area_manager` —
    label vs data divergence preserved per CLAUDE.md note)

10.3 CLAUDE.md updates:
  - Glossary: add **Reporting** entry (corporate-style
    aggregate view of claims; QTD default; cost = approved
    quotes + receipts)
  - "Working with apps/web" Real-pages list: add
    `/admin/damage/reporting`
  - Damage-worker section: add
    `GET /manage/api/contact-roster` and
    `GET /manage/api/reporting` to the endpoint summary
  - Note the label-vs-data divergence: UI uses "Regional
    Director" but the underlying `pricing_simple.area_manager` /
    `am_email` fields keep their data-name (sysadmin Update
    Location editor still shows "Area manager")

## Out of scope

- Per-claim cost resolution (preferring receipt over quote when
  both exist). Documented as a v2 candidate; v1 sums both.
- Charts / visualizations beyond the KPI tiles + tables. Defer
  Chart.js or similar until the operator confirms the table
  format is workable.
- CSV / Excel export of the report. Defer; can layer on later
  via a "Download" button that re-uses the same endpoint.
- Comparing windows (e.g., QTD vs prior-QTD delta percentages).
  Useful but adds endpoint complexity; defer to v2.
- Per-RD or per-RM aggregate roll-ups in the report (e.g., "Bill
  Trabulsy: 12 open, 3 approved across his 8 locations"). Filter
  by RD then look at by-location is the v1 path; explicit RD
  roll-up is v2.
- Touching the existing claim list rendering / detail page.
  Brief 59 only adds filters, not redesigns.
- Auto-refresh / polling on the report page. Operator hits
  refresh manually.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- New helper `listContactRoster(env, role)` exported from
  `packages/db-supabase`
- New endpoint `GET /manage/api/contact-roster?role=` on
  damage-worker; dc_role-scoped
- `getClaimsList` accepts `regional_director_email`,
  `regional_manager_email`, `submitted_from`, `submitted_to`
  query params; resolves via the new helper; returns
  scope-filtered results
- `ClaimsListFilters` extended with `submittedFrom` /
  `submittedTo`; `listClaims` SQL builder uses them
- New endpoint `GET /manage/api/reporting?...` returns the
  Phase 6.3 JSON shape; 5 window presets resolved server-side
- New page `/admin/damage/reporting` renders sticky-anchor-nav
  layout with Overview / By Location / By Damage Type sections
- New `DamageTabs` component mounted on damage list + reporting
  pages
- Damage list filter row gains 2 dropdown filters + 2 date
  inputs (RD / RM / submitted_from / submitted_to)
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run bundle succeeds (clean up after)
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (substantial — 600-900 lines net across:
  packages/db-supabase helper, packages/db-d1 filter extension,
  damage-worker 2 new endpoints + getClaimsList extension,
  apps/web new page + new components + filter UI on existing
  page)
- Confirmation that:
  - dc_role scoping holds across both filter and report paths
  - The repair-cost sum produces sensible numbers on a
    spot-check claim (executor calls out a sample claim_id
    they used)
  - The window presets resolve correctly relative to a fixed
    "now" timestamp
- Validation results
- Any decisions made on the operator's behalf

## Outcome

**Files created (2):**
- `apps/web/app/admin/damage/_components/DamageTabs.tsx` — Claims /
  Reporting pill nav (server component; mirrors
  `SignupAdminTabs` from Brief 56).
- `apps/web/app/admin/damage/reporting/page.tsx` — server component
  rendering the new Reporting view (window picker, filter form,
  Overview / By Location / By Damage Type sections with sticky
  anchor nav and footer cost-double-counting hint).

**Files modified (5):**
- `packages/db-supabase/src/locations.ts` — added
  `ContactRosterEntry` interface + `listContactRoster(env, role)`
  helper. Reads `pricing_simple` (single source of truth post-Brief
  33), groups by `am_email`/`rm_email`, picks most-common name on
  ties, sorts by name asc, returns `[]` on any throw / non-2xx /
  bad shape (fail-soft).
- `packages/db-d1/src/claims.ts` — extended `ClaimsListFilters`
  with `submittedFrom?: string` and `submittedTo?: string`; the
  WHERE-clause builder appends `submitted_at >= ?` / `submitted_at
  <= ?` when set.
- `apps/damage-worker/src/index.ts` — wired three new endpoints
  into `dispatchManageApi`:
  (a) `GET /manage/api/contact-roster?role=...` (handler
      `getContactRoster`, dc_role-scoped: scope.kind === "scoped"
      filters out RDs/RMs whose `location_codes` don't intersect
      the user's dcLocations).
  (b) `GET /manage/api/claims` extended (handler `getClaimsList`)
      to accept `regional_director_email`,
      `regional_manager_email`, `submitted_from`, `submitted_to`.
      The AM/RM resolution lives in a new
      `resolveLocationCodesWithFilters` helper that intersects (a)
      dc_role scope, (b) explicit `location` filter, and (c) the
      RD/RM email-derived sets in three layers; empty intersection
      short-circuits to `[]` without hitting D1.
  (c) `GET /manage/api/reporting?...` (handler `getReporting`)
      runs a 10-statement D1 batch: lifecycle counts, approved
      total, denied total, total cost, per-location lifecycle
      pivot, per-location approved/denied/cost, damage-type
      breakdowns for Approved + Denied. Window resolution helper
      `resolveReportingWindow(window, now)` produces ISO `from` /
      `to` for the 5 presets. When scope is global with no
      filters, the worker first runs a `SELECT DISTINCT
      location_code FROM claims WHERE submitted_at BETWEEN ? AND
      ?` to bound the IN-clause; otherwise the resolved set drives
      it directly.
- `apps/web/app/admin/damage/page.tsx` — mounts `<DamageTabs
  active="claims" />`, fetches RD/RM rosters in parallel with the
  claims list, adds 4 new filter inputs (RD select / RM select /
  Submitted from / Submitted to). All four round-trip through URL
  search params; reset link clears them all.
- `BRIEFS/INDEX.md`, `BUILD_STATE.md`, `CLAUDE.md` — index row +
  Last-updated entry + glossary entries (Reporting + Regional
  Director/Manager label-vs-data divergence) + apps/web Real-pages
  list + damage-worker manage-endpoint summary.

**Decisions made on the operator's behalf:**
1. **Window picker is a row of `<Link>`s outside the filter form.**
   The brief (7.4) specified "URL param `window=` updates on
   click". An in-form radio group only fires on Apply, which
   contradicts that. Kept the styling per the brief (matches Brief
   56's signup day filter); active windows survive when the user
   changes other filters via a hidden `<input name="window">` in
   the form below.
2. **Single hidden-input `<DamageTabs>` for the auth-error and
   fetch-error branches too.** Both error states on the list page
   now render the tab nav so a user who bounces off /admin/damage
   for auth reasons can still see (and click into) Reporting if
   they have access there. Cheap; no downside.
3. **For scope.kind === "global" with no location/RD/RM filters,
   the reporting endpoint pulls the location set from D1 itself**
   (distinct `location_code` within the window) rather than calling
   into Supabase for the full list. That keeps the worker
   self-sufficient and avoids an extra round-trip; the cost is one
   extra D1 statement against `claims` which is negligible.
4. **`damage_type` "(none)" bucket** explicit (per brief 6.2) so
   pre-Brief-41 claims (those without `damage_type`) don't silently
   disappear from the breakdown. Surfaces as a single `(none)` row.
5. **`location_pretty` resolution in the by-location pivot uses
   `MAX(location_pretty)` per location_code.** Defensive — if a
   single location_code has multiple `location_pretty` values
   across claims (data drift), this picks one deterministically
   without raising a SQL error. Effectively no-op for clean data.

**Latent issues found:**
- **Repair-cost double-counting on claims with both Quote AND
  Receipt** — flagged in the brief and surfaced in the report's
  footer hint. v1 sums both; v2 candidate is per-claim resolution
  preferring receipt over quote.
- **The window picker's hidden input only carries the *currently
  active* window into the filter form's Apply.** If the user
  clicks a window pill and then clicks Apply without it
  re-rendering the form, the value is correct because the
  navigation re-renders the page. Not a bug, but worth flagging:
  the picker and the form share state via the URL, not via
  in-page mutable state.
- **The reporting endpoint's distinct-location query bounds the
  IN-clause for global+unfiltered.** D1 has a 100-parameter
  cap per prepared statement, so worst case ~67 locations × 1
  date pair = 69 params for the largest aggregates is comfortably
  under the cap. If the location count grows past ~95, the
  endpoint may need to fan out into multiple batches.

**Validation results:**
- `pnpm typecheck` — 13/13 packages passed (initial run surfaced 10
  D1 batch-result possibly-undefined errors; fixed by switching
  from destructuring + `.results` to indexed access + `?.results`,
  which `noUncheckedIndexedAccess` requires).
- `pnpm --filter @splash/web build` — succeeded; new
  `/admin/damage/reporting` route present at 172 B / 105 kB First
  Load JS (server-rendered on demand, no client JS beyond shared
  chunks). `/admin/damage` 172 B / 105 kB unchanged.
- `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build` — bundle succeeded at 1705.15 KiB
  raw / 385.92 KiB gzipped (well under CF's 3 MiB free / 10 MiB
  paid compressed limits). `.tmp-build` cleaned up.
- No schema changes, no new env vars, no new wrangler bindings —
  brief 9.4 / 9.5 / 9.6 honoured.
- dc_role scoping confirmed at three places: (1) the contact-roster
  endpoint filters entries by intersection with `scope.codes`;
  (2) the RD/RM resolver in `getClaimsList` and `getReporting`
  intersects the email-derived set with the user's scope and
  short-circuits to `[]`/empty-response on empty intersection;
  (3) the reporting endpoint never queries claims outside the
  resolved code set.
- Window-preset resolution sanity-checked manually:
  - now = 2026-05-06T18:00:00Z, qtd → from 2026-04-01T00:00:00Z
  - now = 2026-05-06T18:00:00Z, past_quarter → 2026-01-01..2026-03-31
  - now = 2026-01-15T18:00:00Z, past_quarter → 2025-10-01..2025-12-31
  - now = 2026-05-06T18:00:00Z, past_month → 2026-04-01..2026-04-30
  - now = 2026-05-06T18:00:00Z, ytd → from 2026-01-01T00:00:00Z

**Sample claim spot-check (request from brief 535-line "Report"):**
Not exercised in headless — repair-cost spot-check requires
hitting the live D1, which the agent doesn't do. Operator
follow-up: open a claim known to have an approved Quote with
amount $X and a Receipt with amount $Y, run `/manage/api/reporting`
with `location=<that location_code>&window=ytd`, confirm
`totals.repair_cost === X + Y`.
