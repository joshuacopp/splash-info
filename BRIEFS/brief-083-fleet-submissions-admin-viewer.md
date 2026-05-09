# Brief 83: Fleet submissions admin viewer — `/admin/fleet` list + detail + CSV export with date-range filter

**Status:** Completed (2026-05-09)
**Drafted:** 2026-05-09
**Blocks:** With `splash-fleet-inquiry` deployed (Brief 81) and a
proper staging custom domain pending (Brief 82), the next gap is
admin visibility into incoming fleet inquiries. Today the operator's
only way to see fleet submissions is to query Supabase directly.
This brief adds an apps/web admin surface at `/admin/fleet` mirroring
Brief 56's signup admin viewer pattern: list page with date-range
filter + CSV export, click-through to per-row detail page. New
dashboard tile, new admin-gated worker endpoints, new service
binding. Shared `<DateRangePicker>` and CSV export pattern land here
and get reused on `/admin/signups` in Brief 84.

**Dependencies:**
- Brief 81 (the worker this brief extends).
- Brief 82 (recommended to land first so the staging URL is
  available — but not strictly required; service binding works
  regardless of route binding).
- Brief 56 (signups viewer pattern this brief mirrors and extends).
- Brief 70 (workorders-worker — reference for new-worker-with-
  apps/web-service-binding plumbing).
- Brief 17 (service-binding pattern apps/web uses for SSR-fetching
  workers).

## Read first

- CLAUDE.md (auth + service-binding patterns; admin route
  conventions).
- BUILD_STATE.md.
- BRIEFS/INDEX.md.
- BRIEFS/brief-056-signup-admin-rename-and-signups-viewer.md (the
  signup viewer this brief mirrors — list page, dashboard tile,
  middleware allow-list, worker endpoint shape).
- BRIEFS/brief-081-fleet-inquiry-worker-lift-and-shift.md (Brief
  81's "Out of scope" lists this exact feature as a future-brief
  candidate).
- apps/fleet-inquiry-worker/src/index.js (the verbatim-lifted JS
  that gains a router branch for `/admin/api/*`).
- apps/web/app/admin/signups/* (the existing signups viewer —
  reference implementation for list + filter + per-location detail).
- apps/web/wrangler.toml (gains a new `[[services]]` entry for
  `FLEET_INQUIRY_WORKER`).
- apps/web/cloudflare-env.d.ts (gains a `FLEET_INQUIRY_WORKER`
  binding type).
- apps/web/middleware.ts (gains `fleet` to the admin-subpath
  allow-list).
- apps/web/app/admin/dashboard/page.tsx (gains a new tile).

## Context

### Architectural choice: where the admin surface lives

Two viable patterns:
1. Apps/web reads `fleet_submissions` directly from Supabase (via
   `@splash/db-supabase`), no worker involvement.
2. Apps/web SSR-fetches a new admin endpoint on the fleet worker
   (via service binding); the worker does the Supabase read.

This brief picks (2) because it mirrors Brief 56's signup viewer
exactly and keeps the worker's owning-the-fleet-data domain
intact (other workers' admin surfaces all read via their own
worker, e.g., signup-worker owns `/admin/api/locations/{loc}/signups`
for the signups viewer). It also gives us a clean home for the
CSV export logic (worker-rendered CSV with proper
Content-Disposition; apps/web just emits a `<a href>`).

### Auth — fleet's first authenticated endpoints

fleet-inquiry-worker today has zero auth — public form, public
APIs. This brief introduces the worker's first admin-gated
endpoints, which means wiring in `@splash/auth`'s cookie-based
admin gate (the same one signup-worker, sysadmin-worker, and
damage-worker use).

Strategy: the verbatim-lifted `src/index.js` stays largely intact;
a new `src/admin.js` module owns the `/admin/api/*` handlers; the
top-level fetch handler in `index.js` adds one early-router branch
that delegates to the admin module when the path starts with
`/admin/api/`. This keeps the diff to `index.js` minimal and
well-scoped: one new branch, two new dependency imports.

### Date-range filter — shape

The list endpoint accepts:
- `from` (YYYY-MM-DD, optional, default = 30 days ago in UTC)
- `to` (YYYY-MM-DD, optional, default = today in UTC, inclusive)
- `limit` (integer, optional, default 200, max 200)

Filtering is on `fleet_submissions.created_at` server-side via
PostgREST `gte` / `lte`. The UI date pickers default to last-30-days
on first paint; operator can widen or narrow.

CSV export uses the same date-range params with NO `limit` cap
(or a much higher 10000-row safety cap) since the export use case
is bulk extraction, not screen-fitting.

### Detail page

Click any row in the list → `/admin/fleet/{id}` renders that
submission's full payload in a readable grid: contact info,
fleet info (size, vehicle types), selected packages, location
preference, raw notes field, submission timestamp, IP/UA/source
metadata. Server-rendered, fetches via service binding to
`GET /admin/api/submissions/{id}`.

### Shared components introduced here, reused in Brief 84

Two new components land in `apps/web/app/_components/`:
- `<DateRangePicker>` — controlled component that emits a tuple
  via URL search params (`?from=YYYY-MM-DD&to=YYYY-MM-DD`).
  Server-component-friendly (renders on the server with current
  URL state; submitting refreshes the page with new params).
- `<CsvExportButton>` — styled `<a download>` that builds the
  CSV URL by copying the current page's filter params and
  appending `.csv`. No client state.

Brief 84 reuses both on `/admin/signups`.

## Scope

### Phase 1 — Worker admin endpoints

**File:** `apps/fleet-inquiry-worker/package.json`

Add runtime dependencies:
```json
"dependencies": {
  "@splash/auth": "workspace:*",
  "@splash/db-supabase": "workspace:*",
  "@splash/http": "workspace:*"
}
```
Run `pnpm install` to update the lockfile.

**File:** `apps/fleet-inquiry-worker/src/index.js`

Add ONE new router branch near the top of the fetch handler,
before the existing route table:

```js
import { handleAdminApi } from "./admin.js";

// ... existing fetch handler ...
async fetch(request, env, ctx) {
  const url = new URL(request.url);
  // Brief 83 — admin-gated submissions viewer endpoints.
  if (url.pathname.startsWith("/admin/api/")) {
    return handleAdminApi(request, env, ctx);
  }
  // ... existing code unchanged ...
}
```

The rest of `index.js` stays verbatim. Total new lines in
`index.js`: ~5 (one import, one if-branch).

**File:** `apps/fleet-inquiry-worker/src/admin.js` (NEW)

Implements:
- `authenticateAdmin(request, env)` — uses `@splash/auth`'s
  session helper to validate the `sb-access-token` cookie,
  returns the session, 401 on failure. Allows roles `admin`
  and `super_admin`.
- `GET /admin/api/submissions?from=&to=&limit=` — admin-gated.
  Returns JSON `{ rows: FleetSubmission[], total: number }`.
  Reads `fleet_submissions` via PostgREST with date-range filter
  on `created_at`. Default from = 30 days ago, default to = today
  (UTC, inclusive end-of-day). Default limit = 200, max 200.
- `GET /admin/api/submissions/{id}` — admin-gated. Returns
  `{ row: FleetSubmission }` or 404.
- `GET /admin/api/submissions.csv?from=&to=` — admin-gated.
  Returns `text/csv` with `Content-Disposition: attachment;
  filename="fleet-submissions-YYYY-MM-DD-to-YYYY-MM-DD.csv"`.
  Same date filter as the JSON endpoint but no row limit (10000
  safety cap with a 416 response if exceeded). Columns: every
  user-facing column on `fleet_submissions` — contact name,
  email, phone, company, fleet size, vehicle types, selected
  package(s), location_code, location_pretty, notes, created_at,
  ip, user_agent, source. Standard RFC 4180 quoting (escape
  `"` as `""`, wrap fields containing `,` `"` `\n` in quotes).

CSV rendering helper inline:
```js
function toCsv(rows, columns) {
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(c => escape(c.label)).join(",");
  const body = rows.map(r =>
    columns.map(c => escape(typeof c.get === "function" ? c.get(r) : r[c.key])).join(",")
  ).join("\n");
  return header + "\n" + body + "\n";
}
```

Origin allow-list (CSRF gate) — admin endpoints accept Origin
matching `splashcarwashes.info`, `staging.splashcarwashes.info`,
`localhost:3000`, and the apps/web service-binding internal host
(`https://internal`). Use `@splash/http`'s `isOriginAllowed`.

### Phase 2 — Apps/web service binding + types

**File:** `apps/web/wrangler.toml`

Add:
```toml
[[services]]
binding = "FLEET_INQUIRY_WORKER"
service = "splash-fleet-inquiry"
```

**File:** `apps/web/cloudflare-env.d.ts`

Add `FLEET_INQUIRY_WORKER: Fetcher;` to the `CloudflareEnv`
interface.

**File:** `apps/web/middleware.ts`

Extend the allow-list of admin sub-paths so
`/admin/fleet` and `/admin/fleet/{id}` don't get caught by the
catch-all `/admin/{slug}` → `/admin/pricing/{slug}` rewrite.
Add `"fleet"` to the known-subpaths set.

### Phase 3 — Shared components

**File:** `apps/web/app/_components/DateRangePicker.tsx` (NEW)

`"use client"` component with two `<input type="date">` fields
(`from`, `to`) and a "Apply" button that pushes the current values
to URL search params via `useRouter`. Default values come from
URL search params (`searchParams.from`, `searchParams.to`); empty
fields render today and 30-days-ago respectively as placeholders.
Tailwind styling matches existing form components.

**File:** `apps/web/app/_components/CsvExportButton.tsx` (NEW)

Server component that takes `csvUrl: string` and renders a
styled `<a href={csvUrl} download>Export CSV</a>` — the URL is
built by the parent (passes whatever filter params are active).

### Phase 4 — Apps/web pages

**File:** `apps/web/app/admin/fleet/_lib/worker-fetch.ts` (NEW)

Three helpers mirroring `apps/web/app/admin/signups/_lib/worker-fetch.ts`:
- `getFleetSubmissions({ from, to, limit })` → JSON list
- `getFleetSubmission(id)` → single row
- `getFleetCsvUrl({ from, to })` → returns the URL string
  (relative or worker-direct depending on env)

Each tries the service binding first (via
`getCloudflareContext({ async: true }).env.FLEET_INQUIRY_WORKER`),
falls back to a URL-based fetch in dev (`NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL`
env var). Pattern lifted verbatim from
`apps/web/app/admin/signups/_lib/worker-fetch.ts` — same try/catch
with same Origin/Cookie forwarding.

**File:** `apps/web/app/admin/fleet/page.tsx` (NEW)

Server component. Reads `searchParams.from`, `searchParams.to`.
Calls `getFleetSubmissions(...)`. Renders:
- Page header "Fleet Inquiries" with submission count + date
  range summary
- `<DateRangePicker>` above the table
- `<CsvExportButton csvUrl={...}>` next to the picker
- Table with columns: Submitted (date), Contact (name +
  company), Email, Phone, Fleet Size, Location, Status (always
  "New" for v1; future brief can add a status column to the
  table), and a "View" link to `/admin/fleet/{id}`.
- Footer note: "Showing up to 200 most recent rows. For full
  history use Export CSV."

Use the centered Tailwind section pattern from Brief 58 (e.g.,
`<section className="mx-auto w-full max-w-[1100px] px-5 py-9">`).

**File:** `apps/web/app/admin/fleet/[id]/page.tsx` (NEW)

Server component. Fetches single submission via
`getFleetSubmission(params.id)`. Renders a 2-column key/value
grid with all columns from `fleet_submissions`. "Back to list"
link at top. 404 page renders a friendly "Not found" state if
the worker returns 404 (use Next's `notFound()` helper).

### Phase 5 — Dashboard tile

**File:** `apps/web/app/admin/dashboard/page.tsx`

Add a new tile after the existing "Damage Claims" tile (or wherever
fits the visual rhythm of the grid). Title "Fleet Inquiries",
eyebrow "B2B leads", icon = lucide `Truck` SVG path inlined per
the existing convention (other tiles inline lucide path data
directly per Brief 78). Description: "View and export fleet
customer inquiries from `fleet.splashcarwashes.info`." Href:
`/admin/fleet`.

### Phase 6 — Validation

```sh
pnpm install                                    # picks up new deps
pnpm typecheck                                  # all packages
pnpm --filter @splash/fleet-inquiry-worker typecheck
pnpm --filter @splash/fleet-inquiry-worker build
pnpm --filter @splash/web typecheck
pnpm --filter @splash/web build
```

Smoke test (after operator deploys both fleet-inquiry-worker AND
apps/web):
1. Log into apps/web as admin or super_admin
2. Click "Fleet Inquiries" tile from dashboard
3. List should render with last 30 days of `fleet_submissions`
4. Adjust date range — list updates
5. Click "Export CSV" — browser downloads
   `fleet-submissions-YYYY-MM-DD-to-YYYY-MM-DD.csv` with all
   matching rows (no 200 cap)
6. Click any row's "View" — detail page renders all columns
7. Try as a non-admin user (e.g., gm, location_admin) — should
   404 or 403 from the worker (UI may show empty state or error
   banner depending on how page-level error handling lands)

### Phase 7 — Documentation

1. **CLAUDE.md** — under "Working with apps/web" / "Real pages"
   list, add `/admin/fleet`, `/admin/fleet/[id]`. Under the
   service-bindings list (Brief 17 section), update the count
   from 5 to 6 bindings and add `FLEET_INQUIRY_WORKER` to the
   list. Add a glossary entry for **Fleet inquiries admin** with
   endpoint inventory and access posture.

2. **PRE_DEPLOY_FLEET.md** — gain a new "Admin endpoints (Brief
   83)" section listing the three new endpoints, their auth
   gate, the service binding from apps/web, and the CSV export
   semantics.

3. **PRE_DEPLOY_WEB.md** — gain a one-line note that
   `/admin/fleet*` is admin-gated and depends on
   `FLEET_INQUIRY_WORKER` being deployed.

4. **BUILD_STATE.md** — bump "Last updated" + Findings entry
   summarizing the viewer landing, the new shared
   `<DateRangePicker>` and `<CsvExportButton>` components, and
   the fleet worker's first authenticated endpoints.

5. **BRIEFS/INDEX.md** — append Brief 83 row.

6. **BRIEFS/QUEUE.md** — entry already appended.

## Definition of Done

- `apps/fleet-inquiry-worker/src/admin.js` exists with three
  admin-gated endpoints (`GET /admin/api/submissions`, `GET
  /admin/api/submissions/{id}`, `GET /admin/api/submissions.csv`)
  using `@splash/auth` for the gate and `@splash/db-supabase` for
  Supabase reads.
- `apps/fleet-inquiry-worker/src/index.js` adds exactly one
  `/admin/api/*` router branch + the import for `./admin.js`.
- `apps/fleet-inquiry-worker/package.json` lists the three new
  workspace deps.
- `apps/web/wrangler.toml` declares the `FLEET_INQUIRY_WORKER`
  service binding.
- `apps/web/cloudflare-env.d.ts` declares the binding's type.
- `apps/web/middleware.ts` allow-list includes `"fleet"`.
- `apps/web/app/_components/DateRangePicker.tsx` and
  `apps/web/app/_components/CsvExportButton.tsx` exist as
  reusable components.
- `apps/web/app/admin/fleet/page.tsx` (list) and
  `apps/web/app/admin/fleet/[id]/page.tsx` (detail) render
  correctly and gate access via the service-binding cookie
  forwarding.
- `apps/web/app/admin/fleet/_lib/worker-fetch.ts` mirrors the
  signups helper pattern (binding-first, URL-fallback).
- `apps/web/app/admin/dashboard/page.tsx` gains the "Fleet
  Inquiries" tile.
- `pnpm typecheck` (root) passes.
- `pnpm --filter @splash/fleet-inquiry-worker build` succeeds.
- `pnpm --filter @splash/web build` succeeds.
- CLAUDE.md, PRE_DEPLOY_FLEET.md, PRE_DEPLOY_WEB.md,
  BUILD_STATE.md, BRIEFS/INDEX.md updated per Phase 7.
- This brief's `Status:` flips to `Completed (YYYY-MM-DD)` with
  the `## Outcome` section filled in.

## Out of scope

- Status workflow on submissions (e.g., "New → Contacted →
  Qualified → Closed") — current data model has no status column.
  Future brief if sales wants pipeline tracking.
- Editing or deleting submissions from the admin UI — read-only
  for v1.
- Email/Slack notifications when a submission lands — separate
  webhook brief; not blocked by this one.
- Pagination beyond the 200-row screen cap — operator uses CSV
  export instead.
- Per-location scoping (e.g., gm/rm only sees submissions for
  their dc_locations) — admin/super_admin only for v1; future
  brief if non-admin staff need access.
- Retrofitting `/admin/signups` with the same date-range +
  CSV export — that's Brief 84.
- TypeScript conversion of fleet-inquiry-worker — `src/admin.js`
  lands as JS to match the rest of the worker's existing style.
  Future TS-conversion brief migrates everything together.

## Outcome

### Files created
- `apps/fleet-inquiry-worker/src/admin.js` — admin module with three GET
  routes (`/admin/api/submissions`, `/admin/api/submissions/{id}`,
  `/admin/api/submissions.csv`), cookie-session auth gate via
  `@splash/auth` `authenticate()`, date-range parser
  (`from`/`to` YYYY-MM-DD UTC; default last-30-days; from-must-be-on-
  or-before-to validation), CSV renderer with RFC 4180 escaping, and
  `Content-Disposition: attachment; filename="fleet-submissions-{from}-to-{to}.csv"`
  on the CSV response.
- `apps/web/app/_components/DateRangePicker.tsx` — `"use client"`
  component with `<input type="date">` pair, Apply + Reset buttons,
  pushes selections to URL search params via `useRouter`.
- `apps/web/app/_components/CsvExportButton.tsx` — server component
  emitting a styled plain `<a download>` (NOT `next/link`).
- `apps/web/app/admin/fleet/_lib/worker-fetch.ts` — binding-first /
  URL-fallback helpers (`getFleetSubmissions`, `getFleetSubmission`,
  `getFleetCsvUrl`) modeled on `apps/web/app/admin/pricing/_lib/worker-fetch.ts`.
- `apps/web/app/admin/fleet/page.tsx` — list page with header, range
  picker, CSV export, and an 8-column table (Submitted / Contact /
  Email / Phone / Vehicles / Location / Status / View).
- `apps/web/app/admin/fleet/[id]/page.tsx` — detail page with a
  2-column key/value grid covering every `fleet_submissions` column;
  `notFound()` chrome on 404.

### Files modified
- `apps/fleet-inquiry-worker/src/index.js` — one new `import { handleAdminApi } from "./admin.js"` plus a single early-router branch (`if (url.pathname.startsWith("/admin/api/")) return handleAdminApi(...)`) before the existing path table. Public form routes untouched.
- `apps/fleet-inquiry-worker/package.json` — three new workspace runtime deps (`@splash/auth`, `@splash/db-supabase`, `@splash/http`).
- `apps/web/wrangler.toml` — new `[[services]]` entry `FLEET_INQUIRY_WORKER → splash-fleet-inquiry`.
- `apps/web/cloudflare-env.d.ts` — `FLEET_INQUIRY_WORKER: Fetcher` field added.
- `apps/web/middleware.ts` — `"fleet"` added to `ADMIN_KNOWN_SUBPATHS` so `/admin/fleet` doesn't get caught by the legacy `/admin/{slug} → /admin/pricing/{slug}` redirect.
- `apps/web/app/admin/dashboard/page.tsx` — new "Fleet Inquiries" tile with lucide `Truck` SVG path inlined per existing convention.
- `CLAUDE.md` — Real pages list adds `/admin/fleet` + `/admin/fleet/[id]`; service-bindings count 5 → 7 with FLEET_INQUIRY_WORKER added; new **Fleet inquiries admin** glossary entry; fleet-inquiry-worker glossary entry cross-references the new admin surface.
- `PRE_DEPLOY_FLEET.md` — section 2 secrets table extended to include `SUPABASE_SERVICE_KEY` (now required for admin endpoints); constraint #3 narrative updated to reflect the dual-key posture; new section 4.6 covering the three admin endpoints, auth posture, service binding from apps/web, browser-CSV-download cookie-domain considerations, and a smoke-test checklist; deferred-follow-ups list updated (the "Admin viewer for fleet_submissions" item is no longer pending — Brief 83 landed it).
- `PRE_DEPLOY_WEB.md` — section 4.1 binding count five → seven, FLEET_INQUIRY_WORKER and WORKORDERS_WORKER rows added (the latter was missing from the table), `/admin/fleet*` admin-gated dependency note added.
- `BUILD_STATE.md` — "Last updated" line bumped with Brief 83 chunk; new row at the top of the Findings & decisions log.
- `BRIEFS/INDEX.md` — Brief 83 row's Status flipped from "Ready for Claude Code" to "Completed (2026-05-09)" with auth-gate / SUPABASE_SERVICE_KEY notes appended.
- `BRIEFS/QUEUE.md` — `brief-083-...md` line moved into the completed-tombstone block.
- `BRIEFS/brief-083-fleet-submissions-admin-viewer.md` — Status flipped; this Outcome section filled in.

### Decisions made on operator's behalf
- **Auth gate interpretation.** The brief said "Allows roles `admin`
  and `super_admin`." The codebase's `user_permissions.role` only has
  `super_admin` and `location_admin` (no `admin` role). Interpreted
  the brief as: allow `session.role === "super_admin"` PLUS
  `session.dcRole === "admin"` PLUS `session.dcRole === "super_admin"`
  — the dc_role admin tier (Brett / Scott / Josh per Brief 42) gets
  read-only fleet visibility. `location_admin` and `gm`/`rm` are
  rejected with 403. Documented in CLAUDE.md, PRE_DEPLOY_FLEET.md
  section 4.6, and the BUILD_STATE.md findings entry.
- **Filter column = `created_at`.** The brief explicitly specified
  `fleet_submissions.created_at` for the date-range filter. The
  worker also writes `submitted_at` from JS (in
  `handleFleetSubmit`); `created_at` is the Supabase row default
  `now()`. Matched the brief's spec; called out the distinction in
  CLAUDE.md so future briefs don't accidentally swap.
- **`SUPABASE_SERVICE_KEY` is now a hard requirement on
  `splash-fleet-inquiry`.** `@splash/auth`'s `authenticate()` calls
  `createServiceClient(env)`, which reads `SUPABASE_SERVICE_KEY`. The
  public form routes continue on `SUPABASE_ANON_KEY` (mirrors
  `broad-shape-38b8` per CLAUDE.md constraint #3). When
  `SUPABASE_SERVICE_KEY` is unbound, the admin endpoints return 503
  with `{"error":"admin endpoints not configured (SUPABASE_SERVICE_KEY unbound)"}`
  and the public form is unaffected. PRE_DEPLOY_FLEET.md section 2 +
  4.6 document the binding requirement explicitly.
- **`admin.js` lands as JS, not TS** per the brief's "Out of scope"
  bullet. Typechecks via the worker's `allowJs: true / checkJs: false`
  tsconfig.
- **`CsvExportButton` is a plain `<a download>`, not `next/link`.**
  Initial draft used `<Link>` then realized Next's prefetch + client-
  router behavior conflicts with the browser's native download flow.
  CLAUDE.md glossary entry calls this out as an intentional choice.
- **`getFleetCsvUrl` returns a same-origin relative URL when
  `NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL` is unset.** Works post-
  cutover when apps/web + fleet share the `splashcarwashes.info`
  zone; requires the env var on staging today (apps/web on
  `staging.splashcarwashes.info`, fleet on
  `fleet.staging.splashcarwashes.info`). Documented in
  PRE_DEPLOY_FLEET.md section 4.6.
- **CSV safety cap = 10000 rows; 416 on overflow** per the brief's
  spec. `CSV_SAFETY_CAP` constant in `admin.js`.
- **CSV `packages_detail` column = `JSON.stringify(value)`.** The DB
  column is JSON (Supabase JSONB); a CSV column needs a string
  representation. Inlined the JSON; tabular tools that grok JSON
  cells (Excel + most spreadsheets via formula bar) can read it.

### Latent issues / forward flags
- (i) The browser-issued CSV download requires the `sb-access-token`
  cookie to be scoped to both apps/web's origin AND
  `splash-fleet-inquiry`'s origin. Today this works because
  dashboard-worker sets `Domain=splashcarwashes.info` (zone-scoped),
  which covers both `staging.splashcarwashes.info` and
  `fleet.staging.splashcarwashes.info`. If a future deploy moves
  `splash-fleet-inquiry` off the `splashcarwashes.info` zone, the
  CSV download will 401 even when the JSON list works (service-
  binding callers don't depend on cookie domain scope).
- (ii) **No per-location scoping** for v1. gm/rm can't see only
  their dcLocations' fleet leads — they get rejected entirely. The
  brief's "Out of scope" section lists this as deferred. The
  worker's `authenticateAdmin` is the central gate; adding per-
  location filtering would be a one-handler change that joins
  `fleet_submissions.location_code` against
  `session.dcLocations` (or `session.locations`).
- (iii) **No status workflow column today.** `fleet_submissions`
  has a `status` field but only `"new"` is observed; the table
  renders the field as a pill but no transition surface exists.
  Brief 83's "Out of scope" lists this as a future-brief candidate
  if sales wants pipeline tracking.
- (iv) **Detail-page 404 collapses with 401/403.**
  `fleetGetJson` returns null for any of those statuses; the
  detail page surfaces `notFound()` chrome which is the right
  outcome for "stale link" but slightly less informative than a
  dedicated "no access" card. The list page distinguishes these
  states. If this surfaces as operator confusion, split the helper
  to thread the status through.
- (v) **Fleet-worker email gate not applied** (it's a separate
  permission domain than fleet's admin gate). The Brief 71
  pattern of `getLocationsByContactEmail` doesn't apply here —
  fleet inquiries aren't tied to a per-location email roster, and
  the brief explicitly defers per-location scoping.

### Validation results
- `pnpm install` clean (no new packages downloaded — workspace deps).
- `pnpm typecheck` (root, all 15 packages): **green**, 9.0s.
- `pnpm --filter @splash/fleet-inquiry-worker typecheck`: **green**.
- `pnpm --filter @splash/web typecheck`: **green** (covered by root).
- `pnpm --filter @splash/web build`: **green**, Next.js 15.5.15
  compiled in 6.3s; all 14 routes generated; new `/admin/fleet`
  920 B / 106 kB First Load JS, new `/admin/fleet/[id]` 164 B /
  105 kB. No regressions on prior routes.
- `pnpm --filter @splash/fleet-inquiry-worker build`: **n/a** —
  workers don't have a `build` script (per Brief 79's latent
  finding); deploy-time bundling happens via `wrangler deploy`.
- `pnpm --filter @splash/fleet-inquiry-worker exec wrangler deploy --dry-run`:
  **green**, total upload 781.25 KiB / 148.71 KiB gzip — modest
  growth from the three new workspace deps' transitive footprint
  (~20 KiB compressed delta vs Brief 82). Well within Cloudflare's
  3 MiB compressed limit.

### Operator follow-ups before the admin viewer is usable

1. Bind `SUPABASE_SERVICE_KEY` on `splash-fleet-inquiry`:

   ```powershell
   pnpm --filter @splash/fleet-inquiry-worker exec wrangler secret put SUPABASE_SERVICE_KEY
   # Paste the same service-role key used by every other monorepo worker.
   ```

2. Deploy `splash-fleet-inquiry` (push-to-GH if CF Builds is wired,
   or `pnpm --filter @splash/fleet-inquiry-worker exec wrangler deploy`).

3. Deploy apps/web (push-to-GH).

4. (Optional, only if running on staging today) set
   `NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL` on apps/web's CF Workers
   Builds environment to
   `https://fleet.staging.splashcarwashes.info` — the CSV download
   uses that for the absolute URL when apps/web and fleet are on
   different subdomains. Skip post-cutover.

5. Smoke per PRE_DEPLOY_FLEET.md section 4.6:
   - Log in as super_admin, navigate to `/admin/fleet`, confirm last-30-days renders.
   - Adjust the date range; confirm list updates.
   - Click "Export CSV"; confirm download.
   - Click a row's "View"; confirm detail page renders.
   - Repeat as `location_admin`/`gm`; confirm 403 → "no access" card.
