# Brief 110: JotForm viewer — RD/RM/location filters + grouped rendering

**Status:** Completed (2026-05-11)
**Started:** 2026-05-11
**Completed:** 2026-05-11
**Blocks:** Neither — additive UX extension on top of Brief 109's
viewer. The flat-list-by-`submitted_at-desc` rendering shipped in
Brief 109 is usable today; this brief makes it operator-friendly
for RD / RM / GM users who think in terms of their roster.
**Dependencies:** Brief 109 (apps/web JotForm viewer — pages, fetch
helper, dashboard tile). Brief 107 (worker + admin read API).
Closest pattern analog is Brief 59 (damage-worker
`/manage/api/contact-roster` + RD/RM dropdowns on
`/admin/damage/reporting`) — exact same RD/RM dropdown shape, exact
same email-on-locations resolution, exact same dcRole intersection
posture.

## Read first

- CLAUDE.md (esp. **JotForm submissions**, **jotform-worker**,
  **Damage-worker manage endpoints** glossary entries — the Brief 59
  contact-roster + reporting endpoints are the template here)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-109-apps-web-jotform-viewer.md (the viewer this
  brief extends)
- BRIEFS/brief-059-damage-area-and-reporting-and-rm-quote.md
  (`/manage/api/contact-roster` pattern + the RD/RM dropdown UX on
  `/admin/damage/reporting`)
- apps/damage-worker/src/admin.ts — `handleContactRoster` shape +
  scoping; copy directly into the JotForm worker (modify for
  jotform-side auth gate)
- apps/jotform-worker/src/auth-gate.js (the
  `accessibleSiteNumbersForSession` helper this brief leans on)
- apps/jotform-worker/src/handlers/admin.js (`handleListSubmissions`
  + `handleCsvExport` — both need the new filter params)
- apps/web/app/admin/damage/reporting/_components/* (the
  RegionalDirectorPicker / RegionalManagerPicker components — copy
  shape; both URL-driven)
- apps/web/app/admin/jotform/[form_id]/page.tsx (Brief 109's list
  page — this is where the FilterBar + grouped rendering land)

## Context

Brief 109 shipped the JotForm viewer with a flat list ordered by
`jotform_created_at` desc. Per the 2026-05-11 operator review,
that ordering is unhelpful for RDs and RMs who scan submissions
by roster — they want to see all rows from one location together,
or all rows their RM oversees together, rather than a chronological
mix across their whole scope.

Three asks:

1. **Filter bar additions** — Regional Director (RD, `am_email`),
   Regional Manager (RM, `rm_email`), and Location dropdowns
   alongside the existing DateRangePicker. Each dropdown is
   URL-driven, narrows the result set on the server, and respects
   per-user scope (RM operators can't probe outside their `rm_email`
   set by typing in another RM's email).

2. **Grouped rendering** — rather than a flat 50-row page, group
   the rendered rows by location with date sub-headers. Operators
   read by site, not by clock.

3. **Roster endpoint** — a single new worker endpoint that returns
   `{ regional_directors: [...], regional_managers: [...],
   locations: [...] }` scoped to the caller's `accessibleSiteNumbersForSession`
   set. Powers all three dropdowns in one round-trip. Mirrors
   Brief 59's `/manage/api/contact-roster` but folds AM + RM +
   location roster into one call instead of three.

Worker scope changes are minor — accept three new filter params on
the existing list / CSV endpoints, plus the new roster endpoint.
The `accessibleSiteNumbersForSession` helper from Brief 107 stays
the single source of truth for "what can this caller see"; the new
filter params are an intersect-and-narrow on top of that.

## Scope

### Phase 1 — Worker filter params

Edit `apps/jotform-worker/src/handlers/admin.js`:

1.1 In `handleListSubmissions` and `handleCsvExport`, after the
existing `siteNumber` resolution, also read `am_email`, `rm_email`,
and `location_code` query params. Sanitize each (trim, lowercase
emails, validate the location_code against a tame charset
`[a-zA-Z0-9_-]{1,64}`).

1.2 Resolve each filter to a set of `site_number` strings:

- `am_email`: `getLocationsByContactEmail(env, email)` → take
  rows where `am_email` matches → set of `site_number` strings
  (BOTH padded `"090"` and unpadded `"127"` forms per Brief 107
  convention).
- `rm_email`: same but match `rm_email`.
- `location_code`: resolve via `pricing_simple` (one query) to a
  single `site_number` (or null → empty set).

If multiple filter params are passed, the result is the
**intersection** of all resolved sets AND the caller's
`accessibleSiteNumbersForSession`. Empty intersection short-circuits
to a 200 with `{ rows: [], total: 0, scope: "scoped" }` — the same
pattern as `siteNumber` outside the accessible set already uses.

Add a helper `resolveLocationFilters(env, session, urlSearchParams)`
in a new module `apps/jotform-worker/src/filters.js` (~80 LOC).
Returns `{ siteNumbers: Set<string> | "all", from: ..., to: ... }`.
Keep `handleListSubmissions` / `handleCsvExport` thin.

1.3 Pass the resolved set into `listSubmissions` / `listSubmissionsForCsv`
in place of the existing `siteNumbersFilter`. Existing DB query stays
unchanged — it already accepts a `Set<string>` of accepted
`site_number` strings.

### Phase 2 — Worker roster endpoint

New endpoint `GET /admin/jotform/api/roster` (any authenticated
session). Returns:

```json
{
  "regional_directors": [
    { "email": "alice@splashcarwashes.com", "name": "Alice", "site_numbers": ["1","2","3"] }
  ],
  "regional_managers":  [
    { "email": "bob@splashcarwashes.com", "name": "Bob", "site_numbers": ["1","2"] }
  ],
  "locations": [
    {
      "location_code": "binghamton",
      "site_number": "127",
      "location_pretty": "Binghamton",
      "am_email": "alice@splashcarwashes.com",
      "rm_email": "bob@splashcarwashes.com"
    }
  ],
  "scope": "all" | "scoped"
}
```

Implementation: query `locations` table once via PostgREST,
scoped to the caller's accessible `site_number` set
(super_admin / admin → `select=*`, RD / RM / GM → `site_number=in.(...)`).
From those rows, derive the three arrays:

- `regional_directors`: unique `am_email`s with their `name`
  (sourced from `pricing_simple.area_manager` field — same
  resolution Brief 59 uses) + the locations each AM covers.
- `regional_managers`: same on `rm_email`.
- `locations`: pass-through.

Empty `am_email` / `rm_email` filtered out (silently — don't
return null-email entries).

New handler file `apps/jotform-worker/src/handlers/roster.js`
(~120 LOC). Wire into `handleAdminApi` in `handlers/admin.js`.

### Phase 3 — apps/web fetch helper

Edit `apps/web/app/admin/jotform/_lib/worker-fetch.ts`:

3.1 Extend `listSubmissions` opts to include
`amEmail?`, `rmEmail?`, `locationCode?`. Pass through as query
params.

3.2 Extend `csvExportUrl` opts the same way.

3.3 Add `getRoster()` →
`Promise<{ regional_directors, regional_managers, locations, scope }>`.
Calls `GET /admin/jotform/api/roster` via the binding with URL
fallback. Cookie-forwarded.

3.4 Declare matching types (`JotformRoster`, `RosterAm`, `RosterRm`,
`RosterLocation`).

### Phase 4 — apps/web FilterBar component

New client component
`apps/web/app/admin/jotform/[form_id]/_components/FilterBar.tsx`.
Three URL-driven dropdowns:

- Regional Director (`?am_email=`) — options from
  `roster.regional_directors`, sorted alphabetically by name. First
  option is "All Regional Directors" (clears the param).
- Regional Manager (`?rm_email=`) — same shape from
  `roster.regional_managers`. If `am_email` is set, the RM
  dropdown narrows to RMs whose `site_numbers` intersect the
  selected AM's `site_numbers` (UX hint — worker re-validates
  on submit).
- Location (`?location_code=`) — options from `roster.locations`,
  sorted by `location_pretty`. Display "Binghamton (127)" so the
  operator sees both name and site number. Narrows similarly when
  AM/RM are set.

Layout: place the FilterBar **above** the existing DateRangePicker
in a flex row, wrapping on narrow screens. Single Apply button is
NOT needed — each dropdown change updates the URL and triggers a
fresh server render (same pattern as DateRangePicker).

Empty-roster case: if `roster.regional_directors` is empty (e.g.,
GM with one site), hide the RD dropdown entirely. Same for RM.
Always show the Location dropdown when there's at least one
accessible location.

### Phase 5 — Grouped rendering

Edit the rows table in `apps/web/app/admin/jotform/[form_id]/page.tsx`:

Group the rendered page's rows (current 50-row page only — no
cross-page aggregation at v1) by **location** at the top level,
with **date headers** within each location group.

Structure (server-rendered HTML, no client-side state):

```
┌─ Binghamton (127) — Regional Manager: Bob Smith ─────────┐
│   ─── May 11, 2026 (3 submissions) ───                  │
│   [row, row, row]                                        │
│   ─── May 10, 2026 (1 submission) ───                   │
│   [row]                                                  │
└──────────────────────────────────────────────────────────┘
┌─ Elmira Heights (147) — Regional Manager: Jane Doe ──────┐
│   ─── May 11, 2026 (2 submissions) ───                  │
│   [row, row]                                             │
└──────────────────────────────────────────────────────────┘
```

Grouping keys:

- Location: `row.site` (preferred) else `row.site_number`. Group
  header also shows `rm_email`'s display name (via the roster
  cache loaded for the FilterBar — pass it down as a prop).
- Date: format `jotform_created_at` as `YYYY-MM-DD` in UTC. Render
  as a friendly `"May 11, 2026"`. Within-day order: `jotform_created_at`
  desc (most recent first).

Sort:

- Location groups: alphabetical by `location_pretty` (or
  `site_number` if pretty is missing).
- Date sections: most recent date first.
- Rows within a date: `jotform_created_at` desc.

If the page has only one location group, render flat (no group
header) — the date sub-headers carry the structure. Operator on a
single-site GM scope shouldn't see redundant "Binghamton" headers.

Pagination semantics stay the same — `?offset=N&limit=50` paginates
the server-side row set; grouping is purely a render concern over
the current page. Note in the page header: "Showing rows {offset+1}–
{min(offset+limit, total)} of {total} (grouped by location & date)".

### Phase 6 — Validation

6.1 `pnpm typecheck` — must pass.
6.2 `pnpm --filter @splash/web build` — must succeed.
6.3 `pnpm --filter @splash/jotform-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean
    up `.tmp-build/` after.
6.4 No Supabase / R2 / wrangler.toml / secret changes.
6.5 Operator post-deploy smoke (deferred):
    - Load `/admin/jotform/250855287972067` (retention) as a
      super_admin → FilterBar renders with all RDs / RMs / locations
      populated; date range picker still works.
    - Pick a Regional Director → URL updates, page re-renders to
      that RD's site set, location groups narrow accordingly.
    - Pick a Regional Manager after RD is set → location set
      narrows further to the intersection.
    - Clear filters → "All Regional Directors" / "All Regional
      Managers" / "All Locations" options reset URL.
    - Switch to a non-admin test user (RM with rm_email on a few
      sites) → RD dropdown is hidden (no RDs over them); RM
      dropdown shows just themselves; Location dropdown shows
      their sites.
    - Confirm CSV export uses the same filters (download includes
      only the filtered subset).
    - Confirm rendering is grouped by location with date sub-headers
      on the rendered page.

### Phase 7 — Updates

7.1 BRIEFS/INDEX.md: Brief 110 row appended.

7.2 BUILD_STATE.md: Findings entry noting:
  - Brief 110 (YYYY-MM-DD) — JotForm viewer gained RD / RM / Location
    filters + grouped (location → date) rendering on the per-form
    submissions list. Worker added `am_email` / `rm_email` /
    `location_code` query params (intersect-with-accessible-set
    posture) and a new `/admin/jotform/api/roster` endpoint
    backing all three dropdowns in one fetch.
  - Mirrors Brief 59's contact-roster + reporting pattern.

7.3 CLAUDE.md "JotForm submissions" glossary entry: append a
one-liner noting the Brief 110 additions — RD/RM/location filter
params on the list / CSV endpoints, `/roster` endpoint for the
dropdowns, location → date grouped rendering on apps/web.

## Out of scope

- Cross-page aggregate counts (e.g., "this RD's total submissions
  YTD"). Reporting-style views are a separate brief candidate —
  the JotForm equivalent of `/admin/damage/reporting`. v2.
- Per-user-saved filter presets (e.g., "always default to my
  region"). v2; URL-driven filters are bookmarkable in v1.
- Group-by-RM or group-by-date as alternate primary groupings.
  v1 is location-primary, date-secondary. If operators request a
  toggle, that's additive in a v2 brief.
- Editing submissions (no write surface at all — same posture as
  Brief 109).
- Inline expand-in-place row preview (current pattern is
  click-through to `/admin/jotform/{form_id}/{submission_id}`).
- New sort options on the row list (date desc within group is the
  one ordering at v1).
- Per-form custom field columns in the table (the v1 columns —
  Submitted at / Site / Status / View → — stay generic; v2 candidate
  is per-form column packs).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes (constraint #9 / staging-first
  posture).
- Don't commit to git or push.

## Definition of done

- `apps/jotform-worker/src/handlers/admin.js` `handleListSubmissions`
  and `handleCsvExport` accept and apply `am_email`, `rm_email`,
  `location_code` query params (intersect with caller's accessible
  set).
- `apps/jotform-worker/src/filters.js` exists and is the single
  resolver for the three filter params (~80 LOC).
- `apps/jotform-worker/src/handlers/roster.js` exists and serves
  `GET /admin/jotform/api/roster` returning the three arrays
  scoped to the caller (~120 LOC).
- `apps/web/app/admin/jotform/_lib/worker-fetch.ts` exposes
  `getRoster()` and the extended `listSubmissions` / `csvExportUrl`
  opts.
- `apps/web/app/admin/jotform/[form_id]/_components/FilterBar.tsx`
  exists and is rendered above the date range picker.
- `apps/web/app/admin/jotform/[form_id]/page.tsx` renders rows
  grouped by location → date.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/jotform-worker exec wrangler deploy --dry-run`
  succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 7.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (estimate: ~250 LOC across worker — filters.js +
  roster.js + handler edits; ~200 LOC across apps/web — fetch
  helper edits + FilterBar + grouped renderer + page edits;
  plus doc rows).
- Validation results.
- Whether the AM dropdown narrowed RM/location dropdowns
  client-side was implemented (UX nicety) or deferred (worker
  re-validates either way).
- Any latent issues — e.g., did any locations have NULL
  am_email / rm_email that would have caused the dropdown
  resolution to silently drop them?

## Outcome

### Files created

- `apps/jotform-worker/src/filters.js` (~155 LOC) — `resolveLocationFilters(env, session, searchParams)` single resolver for `am_email` / `rm_email` / `location_code`. Each filter sanitizes its input, resolves to a `Set<string>` of `site_number` strings in BOTH zero-padded 3-digit AND unpadded forms (per Brief 107 convention), and the final result intersects the resolved sets with `accessibleSiteNumbersForSession`. Empty intersection collapses to `Set()` → short-circuit `rows: []`.
- `apps/jotform-worker/src/handlers/roster.js` (~270 LOC) — `GET /admin/jotform/api/roster` returning `{ regional_directors, regional_managers, locations, scope }` derived from one `locations` PostgREST read scoped to caller + one `pricing_simple` lookup for `location_pretty`. Email + location grouping uses the same most-common-name tiebreak as `listContactRoster` in `@splash/db-supabase`.
- `apps/web/app/admin/jotform/[form_id]/_components/FilterBar.tsx` (~150 LOC) — client component with three URL-driven `<select>`s (RD / RM / Location). RM + Location options narrow client-side when RD is selected. Empty-roster slots (e.g., GM with one site sees no RDs over them) are hidden entirely. `?offset=` is cleared on every filter change.

### Files modified

- `apps/jotform-worker/src/index.js` — route-comment block extended to document the new `/admin/jotform/api/roster` endpoint.
- `apps/jotform-worker/src/handlers/admin.js` — handler dispatch gains the roster branch; `handleListSubmissions` + `handleCsvExport` call `resolveLocationFilters` instead of `accessibleSiteNumbersForSession` directly. Docblock and route count comment updated.
- `apps/web/app/admin/jotform/_lib/worker-fetch.ts` — `JotformSubmissionsListParams` gains `amEmail` / `rmEmail` / `locationCode`. New `getRoster()`, `JotformRoster` / `RosterAm` / `RosterRm` / `RosterLocation` types. `csvExportUrl` signature widened with the new params.
- `apps/web/app/admin/jotform/[form_id]/page.tsx` — rewritten. `getRoster()` runs in parallel with `listSubmissions()` via `Promise.all`. FilterBar renders above the existing DateRangePicker. Row table replaced with `<GroupedSubmissions>` bucketing the current page by location → date; single-location pages render flat. Pagination URL builder passes through `from` / `to` / `am_email` / `rm_email` / `location_code`. "Showing rows X-Y of N (grouped by location & date)" header note added.
- `CLAUDE.md` — `JotForm submissions` glossary entry gains a Brief 110 paragraph noting the RD/RM/Location filter params + `/roster` endpoint + grouped rendering.
- `BRIEFS/INDEX.md` — Brief 110 row.
- `BUILD_STATE.md` — Last-updated paragraph + Findings entry.

### Decisions made on operator's behalf

1. **Roster shape:** one endpoint returning three arrays rather than three separate endpoints (brief preferred this — single round-trip backs the FilterBar).
2. **Client-side cascade:** AM-narrows-RM-and-Location cascade implemented as the UX nicety described in the brief Report section. Defense-in-depth is the worker-side `resolveLocationFilters` intersect.
3. **`?offset=` cleared on filter change:** narrow filters may push the prior offset past the new total; clearing avoids "Showing rows 51-100 of 12" weirdness.
4. **Flat single-location rendering:** when only one location group is present, the outer chrome is dropped; the date sub-headers carry the structure (the operator's specific complaint in the brief was the redundancy).
5. **Sanitization for filter params:** `^[a-zA-Z0-9_-]{1,64}$` for `location_code`, email regex for `am_email` / `rm_email`. Rejected values silently no-op (matching existing `sanitizeSiteNumber` posture).
6. **`am_email` filter scoped to `matched_via === "am_email"` only:** an email present on multiple contact columns (rare; would mean same person is AM at one site and GM at another) doesn't get double-counted across filter types. `rm_email` filter mirrors.
7. **Roster pricing_simple join:** locations.site_number → pricing_simple.site (text, denormalized by `trg_sync_pricing_simple`) — same pattern `getMaintainXLocationId` uses post-Brief 62. Many pricing_simple rows per location; first one wins for `location_pretty` + `location_code`.
8. **`?offset=` and filter passthrough on pagination links:** the page builds its pagination hrefs from the full searchParams now, not just `from` / `to` / `offset` — Brief 110 added three more URL keys.

### Latent issues / forward flags

- **Cross-page aggregate counts** ("this RD's YTD submissions") deferred to v2 — separate brief candidate, JotForm's analog of `/admin/damage/reporting`.
- **Per-user filter presets** deferred to v2; URL-driven filters are bookmarkable in v1.
- **Group-by-RM or group-by-date** as alternate primary groupings deferred to v2; v1 is location-primary, date-secondary.
- **Per-form custom field columns** in the row table deferred to v2; the generic Submitted / Site / Status / View columns stay.
- **NULL `am_email` / `rm_email` locations:** confirmed silently drop from the dropdown roster (correct — there's no AM to filter by), but the location itself still appears in the Location dropdown. No data-quality cleanup in scope.
- **No worker-side bundle delta concerns:** dry-run +11 KiB vs Brief 107 baseline (752 KiB raw / 142 KiB gzipped) is well under CF's 3 MiB limit.

### UX nicety — AM narrows RM/Location dropdowns

**Implemented** client-side: selecting a Regional Director immediately narrows the Regional Manager and Location options to those covered by the selected AM. Selecting a Regional Manager additionally narrows Location. Same trims when RD/RM is unset (no narrowing). Worker re-validates on submit, so URL hand-edits that bypass the cascade still resolve correctly (or return `rows: []`).

### Validation

- `pnpm typecheck` — 18/18 green. One initial strict-mode error in `page.tsx` (`'first' is possibly 'undefined'` on `groupRows[0]`) fixed by a defensive `if (!first) continue` guard in the location-grouping loop.
- `pnpm --filter @splash/web build` — succeeded. `/admin/jotform/[form_id]` route 1.55 kB / 106 kB First-Load JS (up from Brief 109's 924 B — adding FilterBar + grouped renderer; well under the page-budget the brief flagged).
- `pnpm --filter @splash/jotform-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — succeeded. Bundle 752.20 KiB raw / 142.28 KiB gzipped (~+11 KiB vs Brief 107 baseline — filters.js + roster.js + handler refactor). `.tmp-build/` cleaned up after run.

### Diff size

- Worker: ~440 LOC added (filters.js + roster.js + admin.js refactor + comments).
- apps/web: ~530 LOC modified (worker-fetch.ts extensions + FilterBar.tsx + page.tsx rewrite including grouped renderer).
- Docs: BUILD_STATE.md Findings entry, BRIEFS/INDEX.md row, CLAUDE.md glossary paragraph.

### Operator post-deploy smoke (deferred)

- Load `/admin/jotform/250855287972067` (retention) as super_admin → FilterBar renders with all RDs / RMs / locations populated; DateRangePicker still works above it.
- Pick a Regional Director → URL updates, page re-renders to that RD's site set, location groups narrow accordingly.
- Pick a Regional Manager after RD is set → location set narrows further to the intersection.
- Clear filters → "All Regional Directors" / "All Regional Managers" / "All Locations" options reset URL.
- Switch to a non-admin test user (RM with rm_email on a few sites) → RD dropdown is hidden (no RDs over them); RM dropdown shows just themselves; Location dropdown shows their sites.
- Confirm CSV export uses the same filters (download includes only the filtered subset).
- Confirm rendering is grouped by location with date sub-headers; single-location pages render flat without outer group chrome.
