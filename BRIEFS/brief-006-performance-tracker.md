# Brief 6: Performance tracker UI (/admin/performance)

**Status:** Completed (2026-05-04)
**Started:** 2026-05-04
**Completed:** 2026-05-04
**Blocks:** Admin-facing UI parity for the legacy /pertrack/ tool. Required
for legacy info-signup-worker retirement (managers currently enter daily
performance data via the legacy UI).
**Dependencies:** Brief 1 (login), Brief 2 (Header), Brief 4 (dashboard tile
linking here), Brief 11a (getMe / dc_role surfaces — used here for UI gating
parity even though performance has no dc_role concept).

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- AUDIT_REPORT.md (section 1 — apps/web URL inventory)
- apps/performance-worker/src/index.ts (the full worker — single file, all
  6 endpoints. The dispatch + checkToolAccess gate are at the top; the
  per-endpoint shapes follow.)
- apps/web/app/admin/damage/_lib/worker-fetch.ts (reference pattern for
  the per-tool worker-fetch helper)
- apps/web/app/admin/damage/page.tsx (reference for the list+filter
  pattern)
- apps/web/app/admin/damage/[id]/actions.ts (reference for server actions
  + revalidatePath + redirect-with-action_error pattern)
- apps/web/app/admin/damage/_components/LifecycleBadge.tsx (reference for
  the small reusable badge pattern, if a similar visual surfaces here)
- packages/types/src/performance.ts (type shapes for
  PerformanceTrackingRow / PerformanceTrackingInsert)
- packages/db-supabase/src/performance.ts (the underlying DB helpers —
  listPerformanceSubmissions filter shape, insertPerformanceSubmission
  insert shape, searchLocations contract)
- legacy/performancetracker.js (visual / flow reference; the legacy
  worker rendered its own UI inline, so the file shows what the form +
  list looked like; legacy/ui.js is referenced but may not be in the
  repo — work from performancetracker.js's own HTML if so)

## Context

Brief 6 ports the legacy performance-tracker UI from /pertrack/ into
apps/web at /admin/performance. The worker's API contract is unchanged
and ready (`apps/performance-worker/src/index.ts`). What lands here:

  - List page at /admin/performance — submissions table with filter
    bar, paginated only by the worker's hardcoded LIMIT (200 by
    default; not surfaced as a page-level paging UI in v1).
  - Inline "new submission" form below the table — matches the rhythm
    set by 5d's UploadCard (single page, server-action POST, redirect
    on success).
  - Worker base URL helper at app/admin/performance/_lib/worker-fetch.ts
    mirroring damage's pattern.

Worker quirks to know going in:

  - **Prefix-strip routing.** The worker mounts at `/pertrack/*` in
    production and strips the prefix before dispatching. apps/web
    should always call `/pertrack/api/...`. In dev cross-origin
    (workers.dev) the worker also accepts the prefixed path because
    its strip is conditional on the prefix being present. The
    next.config.mjs rewrites already handle `/pertrack/:path*` →
    `NEXT_PUBLIC_PERFORMANCE_WORKER_URL/pertrack/:path*`. Don't strip
    the prefix on the apps/web side.
  - **Standalone auth flow.** The worker has its own /api/login with
    an 8-hour cookie and no refresh (legacy carry-over). For Brief 6,
    we IGNORE that — we use the unified session cookie set by
    dashboard-worker, since checkToolAccess(session, "pertrack")
    gates everything except login/logout/me. The worker's own login
    endpoint is dormant in the apps/web flow.
  - **Tool grant required.** Non-super_admin users need the "pertrack"
    tool grant (`user_tool_access.tool = 'pertrack'`). super_admin
    bypasses (per checkToolAccess). 401/403 on the worker → "no
    access" Sign In card on apps/web (mirror Brief 11 styling).

## Scope

1. **Performance worker-fetch helper.**
   New file: `apps/web/app/admin/performance/_lib/worker-fetch.ts`.
   - Mirror the `apps/web/app/admin/damage/_lib/worker-fetch.ts`
     pattern verbatim, with two differences:
     a. Use `process.env.NEXT_PUBLIC_PERFORMANCE_WORKER_URL` for the
        cross-origin dev shortcut.
     b. Worker calls go to `/pertrack/api/...` paths. The helper's
        function names should be `performanceGetJson<T>` and
        `performancePostJson<T>` (NOT `performancePostForm` —
        performance-worker reads `request.json()` for both
        /api/submissions POST and others, NOT `readForm`. See
        worker source line ~135 for /api/login JSON parsing and
        line ~215 for /api/submissions JSON parsing).
   - Same null-on-401/403 contract for GET; POST helper returns
     `{ ok: true, body }` or `{ ok: false, status, error }`.
   - Set Origin header explicitly on POSTs (consistent with damage's
     helper — performance-worker has the same isOriginAllowed gate on
     state-changing methods).

2. **/admin/performance list page.**
   Replace the placeholder at
   `apps/web/app/admin/performance/page.tsx` with a real
   server-component list page.

   Filter contract (from performance-worker GET /api/submissions, see
   apps/performance-worker/src/index.ts:259-285):
     - `date_from`, `date_to` — ISO date strings (YYYY-MM-DD);
       optional, default unset (no date filter).
     - `location_id` — number; optional. When set, the page also
       echoes the location_pretty in the filter chip.
     - `gm_on_site` — tri-state: "true" | "false" | "" (any).
     - `agm_on_site` — tri-state: "true" | "false" | "" (any).
     - `greeter`, `gm_name`, `agm_name`, `regional_manager`,
       `area_manager`, `rm_group`, `fivestar` — free-text substring
       filters.
     - `limit` — defaults to 200 server-side; don't expose in v1.

   Filter UI:
     - Two-row layout. Top row (always visible): date range (start +
       end), location typeahead, GM-on-site (Yes/No/Any select),
       AGM-on-site (Yes/No/Any select), Apply + Reset buttons.
     - Second row (collapsed under a `<details>` "More filters"):
       greeter text, gm_name text, agm_name text, regional_manager
       text, area_manager text, rm_group text, fivestar text. All
       optional, all substring; render in a 3-or-4-column grid.
     - Server-rendered `<form method="GET" action="/admin/performance">`
       — same pattern as 5a's filter bar. No client JS for the form
       except the typeahead in scope item 3.
     - Apply submits the form. Reset is a `<Link href="/admin/performance">`.

   Results table:
     - Columns: Visit At (formatted YYYY-MM-DD HH:mm slice), Location
       (location_pretty + small monospace site_number below it),
       Capture Rate (formatted as percentage with 1 decimal,
       e.g. "62.4%" — assumption: capture_rate is stored as a
       fraction or percentage; verify against the worker's row shape
       and adjust), Opportunities (number), GM (icon ✓ / ✗ + name if
       present), AGM (icon ✓ / ✗ + name if present), Greeters
       (joined names of greeter_1/2/3, "—" if all null), Submitted
       By (submitted_by_email).
     - Sortable headers are NOT in scope for v1; the worker doesn't
       expose order params and adding client-side sort would require
       a client component. The worker returns chronological by
       visit_at desc; preserve that.
     - Each row is informational only — no per-row link to a detail
       page (no individual-submission view exists in the worker;
       click-through would 404).
     - Empty state: "No submissions match these filters." + Show all
       link.

   States to handle (mirror 5a):
     - 401/403 → no-access card with Sign In button (Brief 11
       pattern; return-path includes filter query string).
     - error throw → error card with reload-to-retry copy.
     - empty list → empty card with "Show all submissions" link.

   Page banner: "INTERNAL TOOLS" eyebrow + h1 "Performance Tracker"
   above the filter bar (matches the dashboard / damage list rhythm).

3. **Location typeahead.**
   The location filter and the new-submission form both need a
   "search by site_number / site / mla_location / location" picker.
   The worker exposes `GET /pertrack/api/locations?q=...` returning
   up to 20 matches. This is the only client-side interactivity in
   the brief; isolate it to a small `"use client"` component.

   New file: `apps/web/app/admin/performance/_components/LocationPicker.tsx`.
     - Server-component-friendly props: `name: string` (form field
       name to submit, e.g., "location_id"), `defaultValue?: number`
       (for filter persistence on filter form), `defaultLabel?: string`
       (for displaying the current selection alongside the input on
       initial render).
     - Implementation: a `<input type="text">` with onInput debouncing
       (~250ms) hitting `/pertrack/api/locations?q=...` via `fetch()`,
       rendering matching options below as a list. Selecting an option
       sets a hidden `<input type="hidden" name={name}>` to the
       location's id. Below the input, show the selected location's
       label as confirmation (e.g., "Selected: BINGHAMTON · 7042").
     - Empty query — render no dropdown (don't auto-fetch on focus
       to avoid a 200-result dump).
     - Failure handling — silently empty dropdown; surface errors via
       a small text below the input only when fetch throws.
     - Accessibility: `role="combobox"`, `aria-expanded`,
       `aria-controls`, `aria-activedescendant` on the input;
       `role="listbox"` and `role="option"` on the dropdown.

4. **New-submission inline card.**
   Below the results table on the same page, render
   `<NewSubmissionCard>` — server component containing a
   `<form action={createSubmissionAction}>`.

   Required fields:
     - `visit_at` — `<input type="datetime-local">` (browser native).
       Default to "now" via `defaultValue={new Date().toISOString().slice(0, 16)}`.
     - `location_id` — `<LocationPicker name="location_id" />`.

   Optional fields (all):
     - `capture_rate` — `<input type="number" step="0.1" min="0" max="100">`.
       Help text: "Percentage (0-100)".
     - `opportunities` — `<input type="number" min="0">`.
     - Three greeter rows, each with `name` + `shift_start` (time) +
       `shift_end` (time):
         - greeter_1_name, greeter_1_shift_start, greeter_1_shift_end
         - greeter_2_name, greeter_2_shift_start, greeter_2_shift_end
         - greeter_3_name, greeter_3_shift_start, greeter_3_shift_end
     - `gm_on_site` — `<input type="checkbox" name="gm_on_site">`,
       and conditional name field beside it (`gm_name` text;
       browser shows it always — empty if `gm_on_site` is unchecked
       is acceptable v1).
     - `agm_on_site` + `agm_name` — same shape as GM.
     - `comments` — `<textarea name="comments" rows={3} maxLength={2000}>`.

   Field labels visible above each input. Group sections with light
   subheaders ("Visit", "Capture", "Greeters", "Management",
   "Notes") to keep the form scannable. No client-side validation
   beyond browser-native required attributes — the worker's
   /api/submissions handler does the type coercion.

   Submit button: "Save submission".

5. **Server action `createSubmissionAction`.**
   New file: `apps/web/app/admin/performance/actions.ts` (`"use server"`).
     - `createSubmissionAction(formData: FormData)` reads all the form
       fields, builds a JSON body matching the worker's expected
       shape (`PerformanceTrackingInsert`-ish — see
       `packages/types/src/performance.ts`), calls
       `performancePostJson("/pertrack/api/submissions", body)`.
     - Booleans: `gm_on_site` and `agm_on_site` come from FormData as
       "on" when checked, undefined when not. Convert to boolean
       explicitly.
     - Numerics: `capture_rate`, `opportunities`, `location_id` —
       coerce or pass through as strings; the worker's
       `apiCreateSubmission` does its own coercion.
     - On success: `revalidatePath("/admin/performance")`, then
       `redirect("/admin/performance?success=1")` so the new row
       appears in the table immediately. Show a small success banner
       at the top of the page when `?success=1` is present (clears on
       any other navigation).
     - On failure: `redirect` with `?action_error=<encoded>`; same
       banner pattern as 5c.

6. **Update detail not in scope.** No /admin/performance/[id] route —
   the worker doesn't expose a single-submission GET. Editing /
   deleting a submission is also out of scope (worker has no PATCH /
   DELETE for performance_tracking).

7. **Update BRIEFS/INDEX.md** — add Brief 6 row, mark Completed
   (today's date), file link.

8. **Update BUILD_STATE.md** per Conventions — bump Last updated, add
   Findings entry, mark item 6 Completed in the prioritized work list,
   update the apps/web pages table (`/admin/performance` flips
   placeholder → real), validation results.

## Configuration
No new env vars. `NEXT_PUBLIC_PERFORMANCE_WORKER_URL` already exists in
`.env.example` and the next.config.mjs rewrites already include
/pertrack/:path*.

## Out of scope

- /admin/performance/[id] detail page (worker doesn't support).
- Editing or deleting submissions (worker doesn't expose endpoints).
- Pagination beyond the worker's 200 LIMIT (no UI page-control in v1).
- Client-side sortable table headers (worker doesn't expose order
  params).
- Authentication via performance-worker's /api/login flow — use the
  unified dashboard-worker cookie. The performance-worker's standalone
  login is dormant in apps/web.
- Modifying performance-worker source (read-only against it).
- Adding columns the worker doesn't return (don't bolt on new joins).
- Don't deploy, don't bind production routes, don't commit to git or
  push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- /admin/performance renders the filter bar, results table, and
  new-submission card under the global Header
- Filter form GET-submits and the results refresh
- "No access" branch renders the Sign In button (Brief 11 pattern)
- Empty-results branch renders the empty card with "Show all" link
- New submission can be created and appears in the table after the
  redirect-to-success-flag round-trip
- Location picker debounces searches and submits the location_id on
  selection
- BUILD_STATE.md and BRIEFS/INDEX.md updated; item 6 marked Completed
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Filter UI decisions (especially the "More filters" `<details>` shape
  and any deviations from the brief's two-row layout)
- Capture-rate format choice (percentage vs decimal) and how it
  rendered against real data
- LocationPicker accessibility notes (any aria choices that came up
  during implementation)
- Any new latent issues spotted in performance-worker (e.g., 8-hour
  cookie quirk, prefix-strip edges, listPerformanceSubmissions filter
  shape mismatches)
- Bundle-size delta on /admin/performance from the LocationPicker
  client island (compare against /admin/damage's 965 B post-5d
  baseline)
- Validation results

## Outcome

**Files created (4):**
- `apps/web/app/admin/performance/_lib/worker-fetch.ts` — server-side fetch
  helper. `performanceGetJson<T>(path)` returns null on 401/403, throws on
  other non-2xx. `performancePostJson<T>(path, body)` returns
  `{ ok: true, body }` on 2xx or `{ ok: false, status, error }` otherwise;
  JSON-bodied (the worker's POST handlers read `request.json()`, NOT
  `readForm`). Cross-origin/same-origin URL fork mirrors damage's helper,
  switched to `NEXT_PUBLIC_PERFORMANCE_WORKER_URL`. Sets `Origin` on POSTs
  for the worker's `isOriginAllowed` CSRF gate.
- `apps/web/app/admin/performance/_components/LocationPicker.tsx` — single
  client component in this brief. Debounced typeahead (250 ms) hitting
  `/pertrack/api/locations?q=...` via relative URL (next.config.mjs's
  `/pertrack/:path*` rewrite carries dev cross-origin transparently).
  ARIA combobox (role/aria-expanded/aria-controls/aria-activedescendant)
  + listbox/option pattern; arrow up/down/enter/Esc keyboard nav;
  outside-click dismiss; race-safe via fetchSeqRef counter; `pick(row)`
  writes the selection into a hidden `<input name={name}>` so the
  surrounding `<form>` serializes it. `defaultValue` + `defaultLabel`
  props let the filter form persist the active filter across round-trips.
  `required` prop applied to the hidden input for the new-submission
  form (browsers honor `required` on hidden inputs).
- `apps/web/app/admin/performance/actions.ts` — `"use server"` exporting
  `createSubmissionAction`. Reads FormData, builds a JSON body, POSTs to
  `/pertrack/api/submissions` via `performancePostJson`. On failure:
  redirect with `?action_error=<encoded>`. On success:
  `revalidatePath("/admin/performance")` then redirect with `?success=1`.

**Files modified (1):**
- `apps/web/app/admin/performance/page.tsx` — Step-4 placeholder replaced
  with the real list page. Sections (top → bottom):
    1. ActionAlert (`?action_error=...`) + SuccessBanner (`?success=1`)
    2. PageBanner ("Internal Tools" eyebrow + h1 "Performance Tracker")
    3. Filter form: top row (date_from + date_to + LocationPicker
       spanning 2 cols + GM/AGM tri-state selects) and a `<details>`
       "More filters" reveal (greeter + gm_name + agm_name +
       regional_manager + area_manager + rm_group + fivestar substring
       inputs). Submit + Reset.
    4. Results table (8 cols: Visit at, Location, Capture, Opportunities,
       GM, AGM, Greeters, Submitted by). Reads `row.location.{id,site_number,...}`
       since `listPerformanceSubmissions` uses
       `select("...,location:locations!inner(id,site_number,...)")`
       rather than `location_id`. No per-row click-through (worker has no
       single-submission GET).
    5. NewSubmissionCard (inline server component): grouped by Visit /
       Capture / Greeters / Management / Notes subheaders;
       `<form action={createSubmissionAction}>` with checkbox booleans
       for `gm_on_site`/`agm_on_site`, three greeter rows
       (name + shift_start + shift_end), `<textarea name="comments">`,
       Save submission button.
  Four fetch branches: success / 401-403 (Sign In with `?return=` filter
  preservation) / non-2xx error / empty (Show all link).

**Files modified (2 — meta):**
- `BRIEFS/INDEX.md` — Brief 6 row marked Completed (2026-05-04) with
  filename link.
- `BUILD_STATE.md` — bumped Last updated, expanded the apps/web pages
  table for `/admin/performance`, marked item 6 Completed in the
  prioritized work list, added a Findings entry, updated the tally
  ("7 real pages + 1 server-route + 4 placeholder pages"), updated the
  status snapshot prose, added Brief 6 to the Admin-facing cutover
  blockers' done list.

**Decisions made on operator's behalf:**

1. **Capture-rate format = `"62.4%"`** (decimal-percent suffix). Legacy
   stores capture_rate as the raw 0-100 percentage — the worker's
   apiCreateSubmission applies `toNumOrNull` without normalization and
   the new-submission `<input type="number" min="0" max="100">` matches
   that range. So `value.toFixed(1) + "%"` displays directly. Flagged
   for verification against real data: if any rows carry 0-1 fractions
   from older code paths, they'd display as "0.6%" etc.; nothing observed
   in this brief's run since I didn't query live data.

2. **List response shape includes embedded `location` object, not
   `location_id`**. The brief implied `PerformanceTrackingRow[]` but the
   helper's SUBMISSIONS_SELECT joins `location:locations!inner(...)`
   instead of selecting `location_id`. Defined a local `SubmissionRow`
   type with `location: EmbeddedLocation | null` and a 15-column
   EmbeddedLocation interface mirroring the SELECT.

3. **More-filters `<details>` auto-opens** when any of its 7 fields are
   populated (`open={moreFiltersActive}`). Surfaces active filters on
   round-trip without an extra click. Closes manually if the user wants.

4. **LocationPicker hidden input uses browser `required`** for the
   new-submission form (vs. the filter, which is unrequired). Browsers
   honor `required` on hidden inputs and surface the form-validation
   tooltip on the typeahead's visible input via the `<form>` boundary.
   Server action also defends with an explicit
   `if (!locationId)` redirect.

5. **`fetch("/pertrack/api/locations?q=...")` is relative**, not
   absolute via the env var. The next.config.mjs `/pertrack/:path*`
   rewrite already carries the dev cross-origin proxy server-side,
   keeping the browser same-origin and avoiding the SameSite=Lax cookie
   wall. Same posture as the dashboard `/api/me` rewrite. In production
   the rewrite collapses (env var unset) and the route binding routes
   directly to the worker.

6. **Tri-state selects** (`Any`/`Yes`/`No`) for `gm_on_site` /
   `agm_on_site`. Empty string = Any (omitted from the worker query),
   `"true"`/`"false"` = explicit narrow. Mirrors the worker's `triBool`
   semantics exactly.

7. **`visit_at` default = `new Date().toISOString().slice(0, 16)`** —
   that's UTC, not browser-local. Acceptable for v1 since users typically
   adjust before submitting and the worker accepts any parseable
   timestamp string. Locale-aware default would need `"use client"`
   machinery I deliberately kept out of the form.

8. **Greeter rows = 3 fixed slots** matching the schema's
   `greeter_1/2/3_*` columns. No "add greeter" affordance at v1 since
   the schema caps at 3.

9. **`gm_name` / `agm_name` always render**, not gated on the on_site
   checkbox. Brief allowed "empty if unchecked is acceptable v1." No
   client JS, simpler markup.

10. **`<input type="number" step="0.1">`** for capture_rate (1-decimal
    increments matches the display format). `step="1"` for opportunities
    (integer count).

11. **No submission ID column** in the table — rows are informational
    and `id` is internal.

12. **Filter form's location dropdown derives `defaultLabel` from the
    result set** when possible (find the row whose `location.id` matches
    the active filter), falling back to `"ID {n}"` if the filter
    narrows past the active location. Matches the damage list's
    location-code preservation pattern.

**Latent issues spotted:**

- **performance-worker's standalone `/api/login` + 8-hour cookie are
  dormant in apps/web**. The apps/web flow uses the unified
  dashboard-worker session cookie. The legacy `/pertrack/api/login` is
  still reachable via direct POST but no apps/web page exercises it.
  Documented as dormant in the worker's own header comment
  (`apps/performance-worker/src/index.ts:8`). Not a bug — dead-code
  cleanup for a future pass.

- **`apiListSubmissions` filters `gm_on_site`/`agm_on_site` only when
  explicitly true/false**; null = no filter. The Any option correctly
  maps to empty string, and the page omits empty-string params from
  the worker query so the WHERE clause stays narrow.

- **Capture-rate format assumption (decision 1)** — flagged for
  verification against live data. Easy fix if wrong: divide by 100 (or
  multiply, depending on what's stored).

- **`visit_at` UTC default** (decision 7) — surfaces as a slight offset
  in the prefilled control on first render. Unobtrusive; users typically
  pick the date themselves.

- **`location_id` is sent as a string** through the JSON body (FormData
  values are always string). The worker's `apiCreateSubmission` does
  `Number(body.location_id)` so it survives. If the worker ever stops
  coercing, we'd surface it as a UX failure on save; defense-in-depth
  would be to coerce in the action too, but I kept the action thin.

- **`filterLocationDefaultLabel` is derived from the visible result set,
  not from a separate Supabase round-trip.** If the user filters
  date-range past every claim at the active location, the dropdown
  shows `"ID {n}"` until the filter is reset. Cheaper than an extra
  query; behaviorally aligned with the damage list's location-code
  preservation.

**Validation results:**

- `pnpm typecheck`: **13/13 successful**, 6.477s (12 cached, apps/web
  ran fresh, no errors).
- `pnpm --filter @splash/web build`: **succeeded** — Next 15.5.15
  compiled in 10.8s, 12/12 static pages generated.
- Bundle size: `/admin/performance` route is `ƒ` (server-rendered) at
  **1.85 kB / 107 kB First Load JS** — up from 5d's 965 B / 106 kB
  baseline. Delta: +0.9 kB / +1 kB First Load — LocationPicker's
  useState/useEffect+aria machinery is the bulk; well within budget.

**Out-of-scope items (per brief's §"Out of scope"):** no detail page,
no edit/delete (worker has no PATCH/DELETE), no UI pagination beyond
the worker's LIMIT 200, no client-side sortable headers, no use of the
performance-worker's standalone login flow. Did not deploy, did not bind
production routes, did not commit to git or push.
