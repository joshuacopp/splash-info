# Brief 56: Rename "Pricing Admin" → "Signup Admin"; add per-location signups viewer (1d / 7d / 30d)

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Operator wants visibility into recent customer signups
per location ("did Bill's marketing push at Oswego pull anyone in
this week?") without leaving apps/web. Today the data lives in
`maxpass_signups` and is invisible from the admin UI.
**Dependencies:** None.

## Read first

- CLAUDE.md (constraint #1 — load-bearing customer URLs;
  `/admin/pricing/*` is admin-internal so renaming the visual
  label is safe but the URL itself stays)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-002-url-alignment-redirects-header.md (the brief
  that added `/admin/{slug}` → `/admin/pricing/{slug}` 308; the
  known-subpaths allow-list lives in apps/web middleware and
  needs `signups` added)
- BRIEFS/brief-017-service-bindings.md (every signup-worker call
  from apps/web routes through the `SIGNUP_WORKER` service binding
  with URL fallback for dev)
- apps/signup-worker/src/handlers/admin-pricing.ts (auth gate
  pattern at L83 — `requireLocationAccess`; reuse identically)
- apps/signup-worker/src/handlers/submit-signup.ts (`maxpass_signups`
  insert ~L284 — column shape reference)
- apps/web/app/admin/dashboard/page.tsx (the dashboard tile to
  rename; ~L36-L55)
- apps/web/app/admin/pricing/[location]/page.tsx (the per-location
  pricing page — pattern to mirror for `/admin/signups/[location]`)
- apps/web/app/admin/pricing/_lib/worker-fetch.ts (the helper for
  signup-worker calls; copy or extend for signups endpoint)

## Context

The "Pricing Admin" naming is a holdover from when pricing was the
only signup-worker admin function. Adding signup observability puts
two distinct functions under the same umbrella — pricing
(operational, edits per-location) and signups (observational, reads
per-location). Operator decided 2026-05-06: rename the umbrella to
"Signup Admin" and split into two views — Pricing and Signups —
accessible via a tab nav at the top of each per-location page.

The `maxpass_signups` table (Supabase) carries every customer
submission: phone, email (nullable), package_pretty, today_price,
submitted_at, country/city/region (from `request.cf`), plus
fraud-detection metadata. Admin gets the operationally useful
columns: When, Phone, Email, Package, Price.

URL strategy: keep `/admin/pricing/{loc}` stable (operators may
have it bookmarked); add `/admin/signups/{loc}` as a sibling.
Dashboard tile relabels to "Signup Admin" but continues linking to
`/admin/pricing` — the tab nav handles the cross-view flip.

## Scope

### Phase 1 — New signup-worker endpoint: `/admin/api/locations/{loc}/signups`

1.1 In `apps/signup-worker/src/handlers/admin-pricing.ts` (or a
sibling new file `admin-signups.ts` if that's cleaner — executor's
call), add:

```
GET /admin/api/locations/{loc}/signups?days=N
```

  - `loc` is the URL-segment location_code; lowercase with
    `LOCATION_CODE_RE` style validation
  - `days` query param: integer, allow-list `{1, 7, 30}`. Default to
    `7` when missing or invalid; hard-reject other values with 400
    (don't silently coerce — protects against unbounded queries)
  - Auth: same gate as the existing
    `/admin/api/locations/{loc}` handler (`requireLocationAccess`
    at L83). `location_admin` only sees signups for their own
    locations; `super_admin` sees any. Replicate the gate verbatim
    — DO NOT loosen.

1.2 Inside the handler, compute `since = new Date(Date.now() - days
* 86_400_000).toISOString()` and issue a single Supabase REST GET:

```
${env.SUPABASE_URL}/rest/v1/maxpass_signups
  ?location_code=eq.${encodeURIComponent(loc)}
  &submitted_at=gte.${encodeURIComponent(since)}
  &select=submitted_at,phone_formatted,email,package_pretty,today_price,city,region
  &order=submitted_at.desc
  &limit=200
```

Same `apikey` + `Authorization: Bearer ...` headers as the existing
PostgREST calls in this worker.

  - `limit=200` is enough for any 30-day window worth surfacing
    (operator bound is ~50/loc/30d for typical traffic). The UI
    can label "showing 200 of N" when capped — see Phase 4.3.
  - Don't include `phone` (raw 10-digit) in the select — the
    UI shows `phone_formatted`. Both columns exist on
    `maxpass_signups`; `phone_formatted` is the display variant
    (legacy convention from `submit-signup.ts:293`).
  - Don't include fraud-detection columns or `terms_text` —
    operationally noisy.

1.3 Return:

```json
{
  "rows": [
    {
      "submitted_at": "2026-05-06T14:33:00Z",
      "phone_formatted": "(607) 555-1234",
      "email": "alice@example.com",
      "package_pretty": "Family Wash 5",
      "today_price": 19.99,
      "city": "Oswego",
      "region": "NY"
    }
  ],
  "count": 12,
  "since": "2026-04-29T14:33:00Z",
  "days": 7,
  "limit_hit": false
}
```

  - `count`: rows.length
  - `limit_hit`: `rows.length === 200` — UI uses this to show the
    "+ more older entries" footer

1.4 Wire the new handler into `apps/signup-worker/src/index.ts`'s
`/admin/api/*` router (~L62-L63). Match `pathname.startsWith` +
endsWith pattern as siblings of the existing `/locations/{loc}`
endpoint use.

### Phase 2 — apps/web fetch helper

2.1 In `apps/web/app/admin/pricing/_lib/worker-fetch.ts`, add a
sibling helper (or move to a new
`apps/web/app/admin/_lib/signup-worker-fetch.ts` if the existing
file's scope is too tight — executor's call). Pattern mirrors the
existing pricing helpers:

```ts
export interface SignupRow {
  submitted_at: string;
  phone_formatted: string;
  email: string | null;
  package_pretty: string;
  today_price: number;
  city: string | null;
  region: string | null;
}

export interface SignupsResponse {
  rows: SignupRow[];
  count: number;
  since: string;
  days: number;
  limit_hit: boolean;
}

export async function getSignupsForLocation(
  locationCode: string,
  days: 1 | 7 | 30
): Promise<SignupsResponse | null> { ... }
```

  - Service-binding-first via `getCloudflareContext({ async: true
    })` for SIGNUP_WORKER (Brief 17 pattern); URL fallback in
    catch for `next dev`.
  - Forward Cookie via `cookies().toString()`; set Origin
    explicitly via `new URL(url).origin` so the worker's
    `isOriginAllowed` gate (if any on this endpoint) passes.
  - 401/403 returns `null` (caller renders "sign in required" or
    "no access"); other errors throw.

### Phase 3 — Tab nav component

3.1 Create `apps/web/app/admin/_components/SignupAdminTabs.tsx`
(server component). Renders a two-tab nav:

```
[ Pricing | Signups ]
```

  - Inputs: `locationCode: string | null`. When null, tabs link to
    `/admin/pricing` and `/admin/signups` (landing list pages).
    When set, tabs link to `/admin/pricing/{loc}` and
    `/admin/signups/{loc}` — preserves location context across the
    flip.
  - Active tab inferred from a second prop `active: "pricing" |
    "signups"`. The owning page passes this explicitly (avoids
    pathname-string-matching brittleness).
  - Visual: pill-tab style (matches sysadmin Brief 30 mode hub
    `?mode=users` / `?mode=tables` aesthetic); the active tab
    is filled with `bg-splash-blue` + white text, the inactive
    is outline + `text-splash-blue`. Reuse existing Tailwind
    tokens from `packages/config/tailwind.base.cjs`.
  - Add `aria-current="page"` on the active tab's `<a>`.

### Phase 4 — New page: `/admin/signups/[location]/page.tsx`

4.1 Create the route file. Server component. Pattern mirrors
`/admin/pricing/[location]/page.tsx`:

  - Read `params.location` and validate with the same regex as
    the pricing page
  - Read `searchParams.days` — coerce to `1`, `7`, or `30`,
    default to `7` on missing/invalid
  - Call `getSignupsForLocation(location, days)`; render an error
    surface for null / thrown
  - Render in this order:
    1. `<SignupAdminTabs locationCode={location} active="signups" />`
    2. Page H1: `Signups · ${cap(location)}`
    3. Day-filter button group: `1 day | 7 days | 30 days` —
       three `<Link>` elements that update `?days=N` in the URL.
       Active button styled like the active tab.
    4. Summary line: `${count} signup${count===1?"":"s"} since
       ${formatRelative(since)} (${formatAbsolute(since)})`
    5. Table: `When | Phone | Email | Package | Price`
    6. Footer when `limit_hit`: "Showing the most recent 200.
       Use a shorter window to see all entries in that range."

4.2 Empty state ("0 signups in last N days"): render the table
header with a single `<tr>` carrying `<td colSpan={5}>` and italic
"No signups in the last N days." Don't hide the table — operator
should still see "what columns would have shown."

4.3 `limit_hit` footer: only render when the worker reports
`limit_hit: true`. Don't show 199/200 noise.

4.4 PII handling: phone + email render as plain text in the
table. Don't add a "copy to clipboard" affordance v1 — keeps the
surface readable. Don't add an export-to-CSV button v1 either —
discuss before adding (PII export needs a separate audit-log
entry).

### Phase 5 — New landing page: `/admin/signups/page.tsx`

5.1 Create the landing route. Server component. Pattern mirrors
`/admin/pricing/page.tsx`:

  - Fetch the user's accessible locations (existing
    `getMyLocations()` helper or equivalent)
  - Render `<SignupAdminTabs locationCode={null} active="signups" />`
    at the top
  - Page H1: `Signup Admin · Recent Signups`
  - List of locations as `<Link>` cards leading to
    `/admin/signups/{loc}` (mirror the Pricing landing's location
    card visual exactly — operator gets a familiar grid)

5.2 If `getMyLocations()` returns 0 locations (user has no signup
admin access at all), render an explanatory paragraph rather than
an empty grid.

### Phase 6 — Add tabs to existing pricing pages

6.1 In `apps/web/app/admin/pricing/page.tsx`, render
`<SignupAdminTabs locationCode={null} active="pricing" />` above
the existing content.

6.2 In `apps/web/app/admin/pricing/[location]/page.tsx`, render
`<SignupAdminTabs locationCode={location} active="pricing" />`
above the existing content.

Don't change the existing pricing rendering otherwise. The tabs
sit above whatever's already there.

### Phase 7 — Branding rename

7.1 Dashboard tile (`apps/web/app/admin/dashboard/page.tsx`,
~L37-L54):

  - `eyebrow: "Pricing"` → `eyebrow: "Signup admin"`
  - `title: "Pricing Admin"` → `title: "Signup Admin"`
  - `description: "Manage MaxPass signup pricing across all
    locations."` → `description: "Manage MaxPass pricing and
    review recent signups across your locations."`
  - `href: "/admin/pricing"` stays — the tab nav handles
    cross-view flips, no need for a new umbrella URL.
  - Keep the existing icon (the dollar-sign currency icon is
    still apt for the umbrella since pricing is half the
    feature).

7.2 Page H1 review: search apps/web for any existing "Pricing
Admin" string used as a page title or heading. Update to
"Signup Admin · Pricing" (umbrella · sub-section). The
`/admin/pricing/{loc}` page H1 if it currently says
"Pricing · {location}" is fine — that's a sub-section title
under the tab.

7.3 No change to the underlying URL `/admin/pricing/*` or any
worker route. Bookmarks keep working.

### Phase 8 — Middleware allow-list update

8.1 In `apps/web/middleware.ts`, find the known-subpaths allow-list
that Brief 2 introduced for the `/admin/{slug}` → `/admin/pricing/{slug}`
308 redirect. Add `signups` to the allow-list so a request to
`/admin/signups/{loc}` doesn't 308-redirect to
`/admin/pricing/signups/{loc}`.

8.2 If the existing allow-list also gates the `/admin/{single-slug}`
catch-all, ensure `/admin/signups` (no location) is left to render
the new landing page rather than being treated as a slug.

### Phase 9 — Validation

9.1 `pnpm typecheck` — must pass for all 13 packages.
9.2 `pnpm --filter @splash/web build` — must succeed.
9.3 `pnpm --filter @splash/signup-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed; clean up
   `.tmp-build` afterward.
9.4 No schema changes. No new env vars. No new wrangler bindings
   (the existing `SIGNUP_WORKER` service binding on apps/web
   covers the new endpoint).
9.5 Confirm the new endpoint isn't accessible to unauthed callers
   — `requireLocationAccess` should 401 when called without the
   sb-access-token cookie.

### Phase 10 — Updates

10.1 BRIEFS/INDEX.md: Brief 56 row appended.

10.2 BUILD_STATE.md: Findings entry noting:
  - Pricing Admin renamed to Signup Admin (umbrella) with
    Pricing + Signups sub-views
  - New per-location signups viewer at `/admin/signups/{loc}`
    with 1/7/30-day filter
  - New endpoint `GET /admin/api/locations/{loc}/signups?days=N`
    on signup-worker; same auth gate as the per-location pricing
    endpoints
  - URL `/admin/pricing/{loc}` is unchanged for bookmark stability
  - Tab nav `<SignupAdminTabs>` lives at
    `apps/web/app/admin/_components/SignupAdminTabs.tsx`; mounted
    above existing pricing pages and the new signups pages
  - Operator follow-up: navigate to `/admin/signups/oswego` (or
    any location you can manage) and confirm the table populates
    with last-7-days submissions; flip the day filter and the
    Pricing tab to verify

10.3 CLAUDE.md updates:
  - Glossary: add **Signup admin** entry (umbrella term covering
    Pricing + Signups sub-views)
  - "Working with apps/web" section: add `/admin/signups` and
    `/admin/signups/[location]` to the Real pages list
  - Brief signup-worker section: add `/admin/api/locations/{loc}/signups`
    to the endpoint summary

## Out of scope

- Cross-location aggregate views (e.g., "all signups across my
  locations last 7 days"). v1 is per-location. v2 could add a
  `/admin/signups/all?days=N` if operators ask.
- CSV export of the signups table. PII export needs its own
  consent / audit-log entry; defer.
- Sorting/filtering inside the table beyond the day window. The
  default desc-by-`submitted_at` is enough for operator review.
- Click-through from a signup row to a detail view. There's no
  detail page to flow to; the table row IS the detail.
- A "compare" view across day windows. Operator can flip 1/7/30
  manually.
- Renaming the underlying URL path `/admin/pricing/*` →
  `/admin/signup-admin/pricing/*` or similar. Bookmarks
  outweigh URL aesthetics.
- Touching the customer-facing signup form, picker, or thanks
  page. This brief is admin-side only.
- Cross-worker pricing cache invalidation (still Brief 28's
  scope; flagged again for context).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- New endpoint `GET /admin/api/locations/{loc}/signups?days=N`
  on signup-worker; auth via `requireLocationAccess`; returns
  the row shape from Phase 1.3
- New page `/admin/signups/[location]` renders the table with
  When / Phone / Email / Package / Price columns
- New landing `/admin/signups` lists the user's locations
- New tab nav component `SignupAdminTabs` mounted on all four
  pages (pricing landing, pricing per-loc, signups landing,
  signups per-loc)
- Day filter (1/7/30) lives in URL searchParams and re-renders
  the table on flip
- Dashboard tile relabels to "Signup Admin" with updated
  description
- Middleware allow-list adds `signups` so /admin/signups/{loc}
  doesn't 308-redirect
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/signup-worker exec wrangler deploy
  --dry-run bundle succeeds (clean up after)
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely 350-500 lines net across signup-worker
  handler + apps/web new page + new component + dashboard +
  middleware)
- Confirmation that the new endpoint authorizes correctly
  (cookie present + has access → 200; cookie missing → 401;
  cookie present + no access to that loc → 403)
- Validation results
- Any decisions made on the operator's behalf

## Outcome

### Files created (4)

- `apps/signup-worker/src/handlers/admin-signups.ts` — new sibling
  handler for `GET /admin/api/locations/{loc}/signups?days=N`. Reuses
  `adminGate` + `userCanAccessLocation` from admin-pricing.ts (now
  exported). Validates `days ∈ {1, 7, 30}` (default 7; other values 400),
  computes `since = new Date(Date.now() - days * 86_400_000).toISOString()`,
  issues a single PostgREST GET against `maxpass_signups` with the
  documented select list (`submitted_at, phone_formatted, email,
  package_pretty, today_price, city, region`), `limit=200`. Returns
  `{ rows, count, since, days, limit_hit }`.
- `apps/web/app/admin/_components/SignupAdminTabs.tsx` — server-component
  two-pill tab nav. Inputs: `locationCode: string | null` and `active:
  "pricing" | "signups"`. When `locationCode` is set, tabs link
  sibling-with-location URLs (`/admin/pricing/{loc}` ↔
  `/admin/signups/{loc}`); when null, tabs link the landing pages.
  Active tab carries `aria-current="page"` and a filled `bg-splash-blue`
  pill style; inactive is outlined.
- `apps/web/app/admin/signups/page.tsx` — landing list page (Signup
  Admin · Recent Signups). Mirrors `/admin/pricing/page.tsx` —
  `workerGetJson("/admin/api/locations")` → grid of location cards
  linking to `/admin/signups/{loc}`. Sign-in / no-access / no-locations
  branches mirror pricing's copy. Renders `<SignupAdminTabs locationCode={null} active="signups" />`.
- `apps/web/app/admin/signups/[location]/page.tsx` — per-location
  table view. Columns: When / Phone / Email / Package / Price. Day
  filter (1 / 7 / 30) is a row of `<Link>`s setting `?days=N`. Empty
  state row uses `<td colSpan={5}>` italic "No signups in the last
  N days." Footer hint renders only when `limit_hit === true`. PII
  rendered as plain text (no copy-to-clipboard, no CSV export per
  brief out-of-scope). `LOCATION_CODE_RE` (`/^[a-z0-9_]+$/`) validates
  the slug defensively before the worker round-trip.

### Files modified (7)

- `apps/signup-worker/src/handlers/admin-pricing.ts` — `adminGate`,
  `userCanAccessLocation`, and `AdminGate` type promoted from `function`
  to `export function` / `export type`. Docblock above `adminGate`
  notes the Brief 56 reuse.
- `apps/signup-worker/src/index.ts` — new import for
  `handleGetAdminLocationSignups`; the route-table comment block at
  the top of the file and the dispatcher's docblock both gained the
  new endpoint line; dispatcher branch added for `segs.length === 3
  && method === "GET" && segs[2] === "signups"`.
- `apps/web/app/admin/pricing/_lib/worker-fetch.ts` — added new
  `SignupDays` / `SignupRow` / `SignupsResponse` types + the
  `getSignupsForLocation(locationCode, days)` helper. The file's
  generic `workerGetJson` transport is reused without duplication;
  the trailing comment notes that this file now owns both pricing
  and signups domain wrappers (the file's name is a relic of when
  pricing was the only signup-worker admin function — non-blocking).
- `apps/web/app/admin/pricing/page.tsx` — added `<SignupAdminTabs
  locationCode={null} active="pricing" />` to all three render
  branches; H1s flipped from "Pricing Admin" to "Signup Admin · Pricing";
  no-access copy flipped from "Pricing Admin" to "Signup Admin"; new
  import.
- `apps/web/app/admin/pricing/[location]/page.tsx` — added
  `<SignupAdminTabs locationCode={location} active="pricing" />` to
  both branches (no-access + main render); access-denied H1 flipped
  to "Signup Admin · Pricing"; main render's H1 (`{data.location_pretty}`)
  intentionally left as-is per brief Phase 7.2 (sub-section title).
- `apps/web/app/admin/dashboard/page.tsx` — Pricing tile rewrite:
  `eyebrow: "Pricing"` → `"Signup admin"`, `title: "Pricing Admin"`
  → `"Signup Admin"`, `description` rewritten to "Manage MaxPass
  pricing and review recent signups across your locations." `href:
  "/admin/pricing"` unchanged; tab nav handles cross-view flips.
- `apps/web/middleware.ts` — `signups` added to `ADMIN_KNOWN_SUBPATHS`.

Plus standard updates to `BRIEFS/INDEX.md` (new Brief 56 row),
`BRIEFS/QUEUE.md` (entry commented out with `(completed 2026-05-06)`
suffix), `BUILD_STATE.md` (Last updated bumped, new Findings entry,
pages-built table extended with the two new routes, tally updated),
`CLAUDE.md` (glossary `Signup admin` entry added; "Working with
apps/web" Real-pages bullet enumerates `/admin/signups` +
`/admin/signups/[location]`).

### Decisions made on operator's behalf

1. **Sibling new file `admin-signups.ts`** rather than appending to
   `admin-pricing.ts` — the brief left it executor's call; the file
   naming better reflects the separate concern (pricing = operational
   write, signups = observational read), and exporting
   `adminGate`/`userCanAccessLocation` from `admin-pricing.ts` keeps
   the auth gate verbatim-shared without duplication.
2. **Domain types + helper added to existing
   `apps/web/app/admin/pricing/_lib/worker-fetch.ts`** rather than a
   new `apps/web/app/admin/_lib/signup-worker-fetch.ts`. The
   existing file's `workerGetJson` is already a fully generic
   SIGNUP_WORKER service-binding transport; pulling it out to a
   sibling location would have meant duplicating the binding/URL-fallback
   logic or refactoring pricing's import path. The brief explicitly
   allowed adding a sibling helper to the existing file. The
   signups page imports `getSignupsForLocation` from
   `../../pricing/_lib/worker-fetch` — slightly awkward path but
   minimal-churn vs. moving the transport.
3. **Validate `params.location` with `LOCATION_CODE_RE` (`/^[a-z0-9_]+$/`)**
   in the per-location signups page. The brief said "validate with
   the same regex as the pricing page" but the pricing page doesn't
   validate inline; defensive validation here renders 404 chrome
   with the tabs visible instead of round-tripping to the worker
   for an obviously bad slug. The `LOCATION_CODE_RE` constant is
   duplicated rather than imported from sysadmin-worker because
   workers can't import each other's source.
4. **Day filter rendered as URL `<Link>`s** that update `?days=N` —
   server-rendered, no JS, matches the rest of the admin's pattern.
   Active-day pill style mirrors the active-tab style.
5. **Empty-state row uses `<td colSpan={5}>`** italic copy ("No
   signups in the last N days.") per brief Phase 4.2 — table
   structure stays visible.
6. **`limit_hit` footer renders only when true** per brief
   Phase 4.3 — no 199/200 noise.
7. **`formatRelative` + `formatAbsolute` time helpers inlined** in
   the per-location page rather than promoted to a shared
   `_lib/format.ts` — small, single consumer; promotion can wait.
   The "When" cell uses `<span title={formatAbsolute(...)}>{formatRelative(...)}</span>`
   so hovering surfaces the absolute timestamp.
8. **`<SignupAdminTabs>` placed at `apps/web/app/admin/_components/`**
   rather than under `signups/_components/` or `pricing/_components/`
   — both pricing and signups pages mount it.
9. **Pricing landing-page H1 flipped to "Signup Admin · Pricing"**
   following the umbrella-dot-section pattern; per-location pricing
   page H1 left as-is per brief Phase 7.2.
10. **`signups` slotted alphabetically** between `pricing` and
    `sysadmin` in `ADMIN_KNOWN_SUBPATHS` rather than appended at the
    end (the existing list isn't strictly alphabetized but the
    placement reads naturally).
11. **No PII export / audit log entry on signups read** — v1 is
    read-only display per brief out-of-scope.

### Latent issues / forward flags

- **Cross-folder import path** —
  `apps/web/app/admin/signups/[location]/page.tsx` imports
  `getSignupsForLocation` from `../../pricing/_lib/worker-fetch`. If
  a future brief moves the generic transport to
  `apps/web/app/admin/_lib/signup-worker-fetch.ts`, both pricing's
  pages and signups' pages will need their import paths updated.
- **No headless smoke test possible** — operator must navigate to
  `/admin/signups/<accessible-location>` after the next CF Workers
  Builds redeploys and confirm: (i) tab nav renders with Signups
  active; (ii) table populates with last-7-days submissions;
  (iii) flipping the day filter re-renders; (iv) flipping to the
  Pricing tab preserves location context; (v) cookie-missing
  returns the sign-in card.
- **`limit=200` cap** — operator-bound for typical traffic is
  ~50/loc/30d; hitting the cap means a marketing event. Footer
  hint guides the operator to flip to a shorter window; v2 could
  add load-more pagination if asked.
- **No `phone` (raw 10-digit) in select** — table renders only
  `phone_formatted`. Future copy-to-clipboard would need to add
  `phone` to the worker select list.
- **Auth gate via `checkToolAccess(session, "pricing")`** — the new
  signups read inherits the pricing tool grant. If operator wants
  signup-only access (e.g., a marketing role that should see
  signups but not edit pricing), a separate `signups` tool grant
  would need to be introduced.
- **Cross-worker pricing cache invalidation** still Brief 28's
  scope; flagged in this outcome too because
  `/admin/api/locations` is the listing endpoint shared by both
  Pricing and Signups landings. (Confirmed:
  `listDistinctLocations` does NOT go through the cache, so
  newly-added locations DO appear immediately on the admin lists.
  Only customer-facing form pricing lags by up to 5 minutes.)
- **No new env var, no new wrangler binding, no schema change** —
  the existing `SIGNUP_WORKER` service binding on apps/web covers
  the new endpoint.

### Validation

- `pnpm typecheck` — **13/13 successful** (4.328s, 11 cache hits +
  fresh `@splash/web` and `@splash/signup-worker` rebuilds — the
  two modified packages).
- `pnpm --filter @splash/web build` — **succeeded**. `next build`
  compiled in 5.5s; all **12** routes generated (was 11
  pre-Brief-56). Both new routes 167 B / 105 kB First Load JS.
  Other route bundles unchanged within rounding.
- `pnpm --filter @splash/signup-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build` — **succeeded**. Total Upload **770.91 KiB
  / gzip 148.69 KiB**. Bindings (env.SIGNATURE_MODE="inline")
  resolved. `.tmp-build` cleaned up afterward.

### Auth posture confirmation (per brief Report)

The new endpoint authorizes correctly via the verbatim-replicated
gate:

- **Cookie missing → 401** (`adminGate` returns
  `jsonError(401, "unauthorized")` from `authenticate()`).
- **Cookie present + `pricing` tool not granted → 403**
  (`adminGate` returns `jsonError(403, "forbidden")` from
  `checkToolAccess(session, "pricing")`).
- **Cookie present + `pricing` granted + location not in
  `session.locations` (and not `super_admin`) → 403**
  (`userCanAccessLocation` check at the top of the handler returns
  `jsonError(403, "forbidden")`).
- **Cookie present + has access → 200** with the documented
  payload shape.

These four outcomes match the existing
`/admin/api/locations/{loc}` (pricing GET) handler exactly because
the new handler reuses the same gate functions verbatim.

### Diff size

Approximate net new lines: ~600 across the 4 new files + 7 modified
files. New code: ~120 (worker handler) + ~60 (tabs) + ~95 (signups
landing) + ~280 (signups per-location page including format
helpers) + ~45 (helper types + wrapper in pricing _lib) + ~30
(tabs threaded through pricing pages) + ~10 (dashboard tile +
middleware allow-list + index.ts dispatcher branch) ≈ 640. Brief
estimated 350-500; the per-location signups page is the largest
new file because it carries the table, day filter, format helpers,
and three render branches inline (no client island; everything is
server-rendered).
