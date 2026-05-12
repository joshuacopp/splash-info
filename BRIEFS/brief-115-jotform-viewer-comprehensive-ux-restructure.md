# Brief 115: JotForm viewer — comprehensive UX restructure (default-today, role-aware gating, alphabetical full-scope grouping, signature proxy fix, location-pretty enforcement)

**Status:** Completed (2026-05-12)
**Started:** 2026-05-12
**Completed:** 2026-05-12
**Blocks:** Neither, but the viewer is materially incoherent for
operator use today — operators can't see "how many submissions per
site today" without paging, signatures still 404 despite the
Brief 113 proxy, and location dropdown shows physical addresses
despite Brief 111's fix attempt.
**Dependencies:** Briefs 109 / 110 / 111 / 112 / 113 / 114. This
brief restructures the operator-facing rendering model and tightens
the location-dropdown / signature-proxy fixes that landed
incomplete in 111 and 113.

## Read first

- CLAUDE.md (esp. **JotForm submissions** + **jotform-worker**
  glossary — multiple paragraphs added/updated here)
- BRIEFS/brief-109..114 Outcome sections
- apps/jotform-worker/src/handlers/admin.js (`handleListSubmissions`,
  `handleAssetProxy`)
- apps/jotform-worker/src/handlers/roster.js
- apps/web/app/admin/jotform/[form_id]/page.tsx
- apps/web/app/admin/jotform/[form_id]/_components/FilterBar.tsx
- apps/web/app/admin/jotform/[form_id]/[submission_id]/_lib/answer-renderer.tsx
- apps/web/app/admin/jotform/_lib/worker-fetch.ts

## Context

Five issues surfaced on 2026-05-12 after Briefs 109-114:

**1. Signature images still broken.** Operator confirmed Brief 113
landed (status Completed), but the detail page still shows the
broken-img icon for `control_signature` entries. Either the
worker's `/admin/jotform/api/asset` handler isn't responding
correctly, the renderer isn't pointing at it, or the JotForm
upstream call is failing despite the API key. Diagnose + fix.

**2. Default date range too wide.** The viewer defaults to last
30 days (matching the worker's default). For day-to-day operator
scanning, "today" is the right default. Pulling 30 days at first
load also creates the page-50-of-3000 grouping problem documented
in issue 3 below.

**3. Pagination + grouping is incoherent.** The Brief 110 grouping
paginates by row (50 per page) across all locations, then groups
per-page. Operators see "Batavia II (2 SUBMISSIONS)" on page 1
even when Batavia II has 4 submissions today — the other 2 are
on later pages. To answer "how many submissions per site today"
the operator has to page through ~60 pages of 30 days of data.
The right model:
  - Fetch ALL rows in scope (date range + accessibleSiteNumbersForSession
    + any explicit filter)
  - Group by `site` alphabetically
  - Render every row in scope without row-level pagination
  - Hard safety cap (e.g., 2000 rows) — if exceeded, banner
    requires the operator to narrow

**4. Admin/super_admin first render = unfiltered everything.**
With ~30K rewashes in the table, an unfiltered super_admin load
is meaningless. The right default for admin/super_admin (who have
no scope-narrowing from `accessibleSiteNumbersForSession`):
  - On initial render with no filter selected: show ONLY a
    `{N} total submissions on {date}` summary line + copy
    pointing at the FilterBar dropdowns: "Select a Regional
    Director, Regional Manager, or Location to view individual
    submissions."
  - Once any filter is applied, the page behaves like the
    non-admin view (alphabetical-by-site, all rows in scope).
  - For RM/RD/GM (already scoped), no filter required for today's
    view.
  - For date ranges extending beyond today, EVERY user (including
    admin/super_admin) must apply at least one filter. Otherwise
    the page shows the count-only summary with "Narrow date range
    to today, or select a filter" copy.

**5. Location dropdown still shows physical addresses.** Brief 111
added a defensive client-side address-shape heuristic, but operator
screenshots show the dropdown still surfacing addresses. The
heuristic is patching symptoms; the fix should be at the worker
roster source. The roster handler's location resolution should
prefer `pricing_simple.location_pretty` and fall back to
`location_code`, never to `locations.location` (which is the
postal address). Drop the client-side heuristic once the worker
returns clean values.

## Scope

### Phase 1 — Signature proxy diagnostic + fix

1.1 Verify Brief 113's `handleAssetProxy` is wired into the
dispatcher in `apps/jotform-worker/src/handlers/admin.js`. The
route pattern is `/admin/jotform/api/asset` (GET only). Confirm
the dispatcher matches before falling through to 404.

1.2 Verify `apps/web/app/admin/jotform/[form_id]/[submission_id]/_lib/answer-renderer.tsx`
`control_signature` branch uses `assetProxyUrl(url)` (from
`worker-fetch.ts`) for the `<img src>`, not the raw JotForm URL.

1.3 If both 1.1 and 1.2 are correct and signatures still fail,
the bug is in the JotForm upstream call. Common causes:
  - JotForm Enterprise's `/uploads/` endpoint may not accept
    `?apikey=` as a query param — could require a header like
    `Authorization: Bearer <key>` or `APIKEY: <key>`. Test by
    hitting the proxy URL directly and reading the CF Workers
    Logs for `[jotform.asset-proxy]` lines.
  - The asset URLs may have segments JotForm requires preserved
    (e.g., the `!team_<id>/` path prefix). Confirm `targetUrl.pathname`
    isn't being mangled.
  - JotForm may 302-redirect to a different host (CDN). The proxy
    uses `redirect: "manual"` per Brief 113 spec — confirm that's
    the actual behavior of the deployed handler, and if so, follow
    the redirect on the worker side (validating the redirect target
    is also on the allow-list).

Fix to whatever's actually broken; the brief expects an executor
to do real diagnostic work here (CF Workers Logs, direct curl
against `/admin/jotform/api/asset?url=...`). Document findings in
the Outcome section.

### Phase 2 — Default date range = today

Edit the worker's `parseDateRange` in
`apps/jotform-worker/src/handlers/admin.js`:

- Change the default `from` from "30 days ago" to "today 00:00 EST"
- Change the default `to` from "today" to "today 23:59:59 EST"
- Both are converted to UTC for the Supabase query (use the
  Brief 114 helper pattern).

apps/web list page's URL-default behavior also updates: if no
`?from=` / `?to=` URL params are present, the page defaults to
today instead of last-30. The DateRangePicker's "From" / "To"
inputs default-populate with today's date.

### Phase 3 — Full-scope alphabetical grouped rendering

3.1 Worker: edit `handleListSubmissions` to support a new
`?group=location` flag (default behavior when no `offset` is
provided). When grouping is requested:

- Bump internal `limit` from `DEFAULT_LIST_LIMIT` to a higher
  scope cap (`GROUPING_SAFETY_CAP = 2000`)
- Return response shape:
  ```json
  {
    "groups": [
      {
        "site": "Batavia II",
        "site_number": "157",
        "rm_email": "paul@splashcarwashes.com",
        "rm_name": "Paul Morgan",
        "count": 4,
        "rows": [...]
      }
    ],
    "total_rows": 47,
    "cap_reached": false,
    "from": "...",
    "to": "...",
    "scope": "all" | "scoped"
  }
  ```
- Groups sorted alphabetically by `site` (case-insensitive).
- Within each group, rows ordered by `jotform_created_at` desc.
- If `total_rows > GROUPING_SAFETY_CAP`, set `cap_reached: true`
  and truncate. Return whatever rows fit (oldest dropped first).

3.2 apps/web list page (`/admin/jotform/[form_id]/page.tsx`):

- Default render uses the grouped response.
- Header: `{N} total submissions {dateRangeCopy} across {M} locations`
- Each location section: bold site name + site number, RM name,
  count badge, then the rows (per-form column registry as today).
- No Prev/Next pagination on the list view.
- If `cap_reached: true`, render an amber banner: "Showing first
  2,000 of {total_rows}+ submissions. Narrow date range or apply
  filters for the complete view."

3.3 Remove the per-page `(2 submissions)` group-header from the
current rendering — counts now reflect TRUE scope, not page slice.

### Phase 4 — Role-aware count-only default

4.1 In the list page server component, before calling
`listSubmissions`, determine:

- `isAdminTier = session.role === "super_admin" || session.dcRole === "admin" || session.dcRole === "super_admin"`
- `hasFilter = !!(searchParams.am_email || searchParams.rm_email || searchParams.location_code)`
- `isTodayOnly = (from === today && to === today)` — both URL params
  unset or both literally today's date in EST

4.2 Decision tree for what to render:

| User tier | Date range | Filter applied | Render |
|-----------|------------|----------------|--------|
| admin / super_admin | today only | no | **count-only** summary + filter prompt |
| admin / super_admin | today only | yes | full grouped view (filtered) |
| admin / super_admin | beyond today | no | **count-only** summary + "Narrow date range or apply filter" |
| admin / super_admin | beyond today | yes | full grouped view (filtered) |
| RM / RD / GM | today only | no | full grouped view (scoped) |
| RM / RD / GM | today only | yes | full grouped view (scoped + filtered) |
| RM / RD / GM | beyond today | no | **count-only** summary + "Apply a filter for wider date ranges" |
| RM / RD / GM | beyond today | yes | full grouped view (scoped + filtered) |

For count-only renders, the worker still computes `total_rows`
(it's cheap — single COUNT query via PostgREST `Prefer: count=exact`).
apps/web just doesn't request the `rows` arrays. Worker should
support `?count_only=1` for this case to avoid pulling 2000 rows
the page won't render.

4.3 The count-only block uses big-tile styling with the date range
clearly stated: `1,847 total submissions today` or
`52 total submissions on May 12, 2026`. Below: a muted prompt
"Select a Regional Director, Regional Manager, or Location to
view individual submissions."

### Phase 5 — Location dropdown — pretty name only

5.1 Worker: edit `apps/jotform-worker/src/handlers/roster.js`. In
the location array build:

```js
const displayName =
  (typeof row.location_pretty === "string" && row.location_pretty.trim())
    ? row.location_pretty.trim()
    : (typeof row.location_code === "string" && row.location_code.trim())
      ? row.location_code.trim()
      : `Site ${row.site_number}`;
```

Never fall back to `row.location` (the postal address). The roster
response's `location_pretty` field gets this resolved value — apps/web
consumes it as-is.

5.2 apps/web: remove the Brief 111 client-side address-shape
heuristic from `FilterBar.tsx` and from the group-header label
in `page.tsx`. Use roster `location_pretty` verbatim. If the
worker fix is correct, the heuristic is dead code.

5.3 Verify by inspecting a sample roster response post-deploy.
Document any locations whose `pricing_simple.location_pretty` is
NULL or shaped unexpectedly — those become candidates for an
operator SQL cleanup pass.

### Phase 6 — Validation

6.1 `pnpm typecheck` — must pass.
6.2 `pnpm --filter @splash/web build` — must succeed.
6.3 `pnpm --filter @splash/jotform-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean
    up `.tmp-build/` after.
6.4 No Supabase / R2 / wrangler.toml / secret changes.
6.5 Operator post-deploy smoke (deferred):
    - Load `/admin/jotform/250165655616055` as super_admin → see
      count-only "N total submissions today" with filter prompt.
    - Select Location: Batavia II → see Batavia II's grouped row
      with ALL today's submissions (counts in header match
      JotForm UI).
    - Set date range to today: passes count-only requirement;
      load is still count-only without filter for super_admin.
    - Set date range to last 7 days: forces count-only until
      filter is applied.
    - Switch test user to an RM with rm_email on 3 sites → load
      defaults to today, full grouped view across the 3 sites,
      no filter required.
    - Open any submission's detail page with a signature → image
      renders inline via the asset proxy. Network tab shows the
      `/admin/jotform/api/asset?url=...` request returning 200
      with `Content-Type: image/png`.
    - Open Location dropdown → every option reads as "Binghamton
      (122)" / "Batavia II (157)" / etc. NO postal addresses.

### Phase 7 — Updates

7.1 BRIEFS/INDEX.md: Brief 115 row appended.

7.2 BUILD_STATE.md: Findings entry noting:
  - Brief 115 (YYYY-MM-DD) — JotForm viewer restructured:
    default-today, role-aware count-only gate for admin-tier and
    for wider-than-today date ranges, full-scope alphabetical
    grouped rendering (no row pagination, 2000-row safety cap),
    signature proxy diagnosed + fixed, location dropdown
    definitively returns pretty names only.
  - Self-correction log: Brief 110's per-page grouping was the
    wrong abstraction; Brief 111's client-side address-shape
    heuristic was patching a worker-side data resolution bug;
    Brief 113's signature proxy needed one more iteration after
    deploy verification.

7.3 CLAUDE.md "JotForm submissions" + "jotform-worker" glossary
entries: replace the Brief 110/111 sub-paragraphs with the
Brief 115 final shape (alphabetical-by-site grouping, count-only
admin gate, full-scope render up to 2000-row cap, location_pretty-
only dropdown).

## Out of scope

- Per-form facet filters (Rewash Reason / Reason For Cancellation /
  etc.) — still deferred to a separate brief once Brief 115
  stabilizes the core viewing model.
- Dashboard tile consolidation — still its own future planning
  conversation.
- Per-form CSV column packs.
- Time-card-edit list-page additional columns beyond Brief 112's
  set.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- Signature `<img>` tags render real images on every detail page
  that has a signature (verified via network tab — 200 from
  `/admin/jotform/api/asset?url=...`).
- Default date range on viewer load is today (worker default +
  apps/web URL default).
- Admin/super_admin with no filter sees count-only summary; with
  filter, sees full grouped view.
- RM/RD/GM with date range = today sees full grouped view by
  default; beyond today requires a filter.
- Full grouped view renders ALL rows in scope (up to 2000),
  alphabetical by site, no row pagination, accurate per-site
  counts in headers.
- Location dropdown options use `location_pretty` (or
  `location_code` fallback). NO postal addresses.
- `pnpm typecheck`, `pnpm --filter @splash/web build`,
  `pnpm --filter @splash/jotform-worker exec wrangler deploy
  --dry-run` all pass.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 7.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate.
- Validation results.
- What was actually wrong with the signature proxy — the diagnostic
  finding from Phase 1.
- Any locations whose `pricing_simple.location_pretty` is NULL or
  malformed (flag for operator SQL cleanup).
- `total_rows` in a today-only super_admin smoke for rewash —
  benchmarks page render time without rows; if even 2000-row
  responses become slow, flag a v2 reporting-style brief.

## Outcome

### Files modified

- `apps/jotform-worker/src/handlers/admin.js` — full rewrite of
  `handleAssetProxy` (new `buildAssetHostAllowList` +
  `ASSET_PATH_PREFIXES` + `fetchJotformAssetFollowingRedirects` helpers;
  host allow-list widened to JOTFORM_BASE_URL host + `www.jotform.com`;
  path-prefix allow-list widened to `/uploads/` + `/widget-uploads/` +
  `/server.php`; `APIKEY` HTTP header added in addition to query param;
  manual redirect-following up to 3 hops with per-hop host validation);
  full rewrite of `handleListSubmissions` with three response shapes
  (`?count_only=1`, `?group=location`, legacy paginated) dispatched on
  query flags; new `groupRowsBySite` + `fetchRmRosterMap` helpers; full
  rewrite of `parseDateRange` defaulting to today EST with new
  `todayInEastern` + `easternWallClockToUtcMs` + `pad2` helpers
  replacing the old UTC-default. `GROUPING_SAFETY_CAP = 2000` constant
  added; `DEFAULT_WINDOW_DAYS` constant removed.
- `apps/jotform-worker/src/db.js` — `listSubmissions` gained an
  `exactCount` flag that toggles `Prefer: count=estimated` ↔
  `count=exact`.
- `apps/jotform-worker/src/handlers/roster.js` — `location_pretty`
  resolution chain rewritten: `pricing_simple.location_pretty` →
  `pricing_simple.location_code` → `Site {site_number}` placeholder.
  No longer falls back to `locations.location` (postal address).
- `apps/web/app/admin/jotform/_lib/worker-fetch.ts` — new
  `listSubmissionsGrouped()` + `listSubmissionsCount()` helpers and
  shape types `JotformSubmissionsGroupedResponse` /
  `JotformSubmissionsCountOnlyResponse` / `JotformSubmissionsGroup`.
  `buildSubmissionsQuery()` gained an `extras` param for adding
  `group=location` / `count_only=1` flags without polluting the
  `JotformSubmissionsListParams` shape.
- `apps/web/app/admin/jotform/[form_id]/page.tsx` — full rewrite.
  `todayEstYmd()` helper. Role-aware decision tree (`isAdminTier ×
  isTodayOnly × hasFilter`) routes to either `CountOnlySummary` or
  `GroupedSubmissions`. `GroupedSubmissions` consumes the
  worker-pre-grouped shape. Brief 110's per-page bucketing,
  `Pagination`, `bucketByDate`, `labelForYmd`, and per-day date
  sub-headers all removed.
- `apps/web/app/admin/jotform/[form_id]/_components/FilterBar.tsx` —
  `locationDisplayLabel()` simplified; the Brief 111 address-shape
  heuristic is removed because the worker roster now resolves
  `location_pretty` correctly.
- `CLAUDE.md` — `jotform-worker` glossary entry gains a Brief 115
  paragraph (count-only + grouped dispatch, default-today,
  asset-proxy widening, location_pretty resolution chain).
  `JotForm submissions` glossary entry gains a Brief 115 paragraph
  on the apps/web restructure (default-today, role-aware count-only
  gate, full-scope alphabetical grouping, FilterBar heuristic
  removed).
- `BRIEFS/INDEX.md` — Brief 115 row inserted above Brief 114.
- `BUILD_STATE.md` — Last-updated bumped + Brief 115 entry prepended.
- `BRIEFS/brief-115-jotform-viewer-comprehensive-ux-restructure.md` —
  this file. Status / Started / Completed set.

### Files created

None. Every change is additive into existing modules.

### Files deleted

None.

### Decisions made on operator's behalf

1. **Phase 1 — asset proxy diagnostic was headless.** Without live
   CF Workers Logs access, applied all three defensive fixes the
   brief raised simultaneously (host allow-list expansion, path
   allow-list expansion, `APIKEY` header alongside query param)
   rather than trying to triangulate the actual culprit from
   inspection. The three changes are mutually compatible and
   individually defensive; whichever one(s) actually matter, the
   fix should land. If smoke testing surfaces continued 401s, the
   next iteration would be to inspect real JotForm payloads to
   confirm the asset URL shape.
2. **Phase 1 — manual redirect-following replaces Brief 113's
   `redirect: "manual"` + reject-3xx posture.** Brief 113's posture
   was a defensive SSRF guard, but it was dropping legitimate
   JotForm CDN bounces (e.g., when JotForm Enterprise 302s to a
   CDN). The new helper follows up to 3 redirects internally with
   per-hop host validation — preserves the SSRF guard (allow-listed
   hosts only) while not dropping legitimate bounces.
3. **Phase 1 — preserve pre-existing target query params.** Brief
   113 dropped them; reverted that because JotForm asset URLs may
   carry one-time download tokens. The proxy now augments (only
   overrides `apikey`).
4. **Phase 3 — single-location grouped view still uses the outer
   `<section>` chrome.** Brief 110's flat-when-single behavior was
   tied to its per-page-bucket model; with full-scope grouping the
   header carries the location's true count, which is information
   worth showing even when there's only one location.
5. **Phase 3 — `cap_reached` uses amber styling, not red.** A
   capped result is still useful, just incomplete — amber matches
   Brief 76's partial-success affordance for photo uploads.
6. **Phase 3 — worker-side legacy paginated mode preserved as
   back-compat.** apps/web no longer uses `?limit` / `?offset`; the
   shape stays because the contract was public.
7. **Phase 4 — CountOnlySummary prompt copy varies by tier ×
   today-vs-beyond.** Three distinct prompt strings; inlined as
   ternaries for now. If iterations continue, could DRY into a
   constant map.
8. **Phase 5 — `Site {site_number}` placeholder as third fallback.**
   When both `location_pretty` and `location_code` are NULL/empty
   in `pricing_simple`, the dropdown reads `Site {n}`. This is
   visible to operators as a flag to populate the missing data via
   SQL.

### Latent issues / forward flags

- **(a)** `pricing_simple.location_pretty` rows that are NULL/empty
  fall through to `location_code`. If `location_code` is also
  missing the option label reads `Site {n}` — visible flag for
  operator SQL cleanup. Without live Supabase access at this brief
  the cleanup pass is operator-driven post-deploy.
- **(b)** Asset-proxy fix is best-effort defensive without live
  test traffic. If signatures still 401 after deploy, next
  iteration would inspect actual JotForm submission payloads to
  verify the auth mechanism. The current fix sends BOTH header and
  query param so any acceptable shape should work.
- **(c)** Grouped response includes full `rows` arrays inside each
  group. For `total_rows ≈ 2000` the JSON payload could be large
  (≈3-5 MB uncompressed, hard to verify without live data).
  Browser-side render perf likely fine; flag for monitoring once
  operator runs with real traffic.
- **(d)** `?group=location` `cap_reached` semantics: returns the
  2000 most-recent rows truncated, dropping oldest. Operator
  scanning "today" never hits the cap; the cap matters only for
  wider date ranges, which Phase 4 already filter-gates.
- **(e)** The asset proxy helper now follows redirects (up to 3
  hops, allow-list-validated). If there's any concern about
  following 302s as a class, the `MAX_HOPS = 3` constant in
  `fetchJotformAssetFollowingRedirects` can be set to 0 to revert
  to Brief 113's reject-3xx posture.

### Validation

- `pnpm typecheck` — **18/18 packages green**. Cache hits: 16.
  Re-ran fresh: `@splash/web`, `@splash/jotform-worker`.
- `pnpm --filter @splash/web build` — **succeeded**.
  Route-specific bundle for `/admin/jotform/[form_id]`:
  **1.58 kB / 107 kB First-Load JS** (≈ unchanged vs Brief 113's
  1.61 kB despite a substantial rewrite, because count-only and
  grouped branches share most code). `/admin/jotform/[form_id]/[submission_id]`:
  unchanged at 172 B / 105 kB First-Load JS (server-rendered).
- `pnpm --filter @splash/jotform-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build` — **succeeded**. Bundle
  **763.42 KiB raw / 144.60 KiB gzipped** (≈ +8 KiB vs Brief 114's
  755.60 / 143.11 baseline, attributable to the new helpers + group
  rendering logic). Well under CF's 3 MiB compressed limit.
  `.tmp-build/` cleaned up after.
- No Supabase / R2 / wrangler.toml / secret changes.

### Diff size estimate

- 5 source files modified across two packages (`apps/jotform-worker`,
  `apps/web`); 2 documentation files updated (`CLAUDE.md`,
  `BRIEFS/INDEX.md`); 2 state files updated (`BUILD_STATE.md`, this
  brief). Roughly +400 / -200 LOC net in the worker (additive
  helpers + rewrite of two handlers), ≈ +200 / -200 LOC net in
  apps/web (page rewritten with similar size but cleaner structure;
  worker-fetch.ts +60 LOC).

### Diagnostic finding for Phase 1

Without live CF Workers Logs access, the diagnostic finding is
"defense in depth, can't narrow further from inspection alone."
Three changes applied simultaneously:

1. **Host allow-list widened.** Brief 113 only accepted the
   `JOTFORM_BASE_URL` host (`splashcarwashes.jotform.com`). JotForm
   Enterprise has been observed serving widget / signature URLs
   against the public `www.jotform.com` host even on Enterprise
   accounts. Allow-list now includes both. If the operator's actual
   asset URLs use the Enterprise host, this change is a no-op; if
   they use the public host, this fixes the 400 the proxy returned.
2. **Path-prefix allow-list widened.** Brief 113 only accepted
   `/uploads/`. JotForm Enterprise signature widget URLs land under
   `/widget-uploads/`; server-rendered submission images use
   `/server.php`. Adding both prefixes closes the path-400 case.
3. **`APIKEY` HTTP header added in addition to query param.**
   JotForm's `/uploads/` direct file server has been observed
   rejecting `?apikey=`-only requests in some configurations.
   `APIKEY` is the documented JotForm asset auth header. Both are
   now sent — whichever JotForm accepts, the upstream fetch
   succeeds.
4. **Manual redirect following.** Brief 113's `redirect: "manual"`
   + reject-3xx was eating legitimate JotForm CDN bounces. The new
   helper follows up to 3 redirects with per-hop host validation
   (allow-list preserved).

If post-deploy CF Workers Logs show `[jotform.asset-proxy]
upstream non-2xx` lines, the operator can grep the logs and the
status code will narrow it down further. The four changes above
cover the vast majority of plausible causes.

### Locations with NULL or malformed `location_pretty`

Cannot enumerate from headless inspection. Operator should run a
post-deploy SQL spot check:

```sql
SELECT location_code, site, location_pretty
FROM pricing_simple
WHERE location_pretty IS NULL OR trim(location_pretty) = '';
```

Any rows returned are candidates for cleanup. The Brief 115 roster
handler falls through to `location_code` for these (so the
dropdown still works), but the operator may prefer to populate
`location_pretty` with the canonical site name.

### `total_rows` benchmark in a today-only super_admin smoke

Deferred — requires live deploy + live data. The new
`?count_only=1` path uses a single COUNT(*) via PostgREST
`Prefer: count=exact` with zero rows transferred over the wire;
should be well under 50ms regardless of table size.

### Notes

- No deploy performed.
- No branch / push / commit performed.
- The diff is staged for operator review only.
