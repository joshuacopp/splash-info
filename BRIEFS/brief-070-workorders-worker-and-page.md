# Brief 70: Work Orders page + new workorders-worker (MaintainX integration, read-only)

**Status:** Completed (2026-05-07)
**Started:** 2026-05-07
**Completed:** 2026-05-07
**Blocks:** Operator visibility into MaintainX work orders relevant
to the GMs / RMs / admins logged into Splash tooling. Today the only
MaintainX-aware surface is the single "MaintainX WO" link on the
damage detail page (Brief 42 / 43); operators have to log into
MaintainX directly to see open work for their location(s).
**Dependencies:**
- Brief 42 (`MAINTAINX_API_KEY` already provisioned in CF — same value
  is reused; operator binds it to the new `splash-workorders` worker
  alongside the existing `splash-damage` binding via `wrangler secret
  put`).
- Brief 62 (`getMaintainXLocationId` helper in
  `packages/db-supabase/src/locations.ts` — this brief adds a sibling
  helper that resolves a SET of location_codes → maintainx_ids in one
  pass).
- Brief 61 (`damage_claim_user_roles` + `damage_claim_user_locations`
  tables — the gating source of truth for this brief; consumed via
  `Session.dcRole` + `Session.dcLocations` exactly like damage-worker
  does).
- Brief 17 (apps/web service bindings pattern — apps/web SSR-fetches
  the new worker via a `WORKORDERS_WORKER` service binding rather than
  URL fetch, to avoid the same-zone 522 gotcha).
- Brief 63 (`[observability.logs]` block — the new worker's
  wrangler.toml MUST include it from day one so the dashboard "Logs →
  Enabled" toggle stays sticky).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-042-maintainx-workorder-on-equipment-related.md
  (MaintainX REST shape, assignee constants, `MAINTAINX_API_KEY`
  posture, `MAINTAINX_BASE_URL` var)
- BRIEFS/brief-062-getmaintainxlocationid-fix-join-key.md (the
  pricing_simple → site_number → locations.maintainx_id join chain
  that this brief's bulk helper reuses)
- BRIEFS/brief-017-service-bindings.md (apps/web service-binding
  pattern + dev URL fallback)
- BRIEFS/brief-059-damage-am-rm-filters-and-reporting-tab.md (the
  Reporting endpoint pattern this brief's worker mirrors — pure JSON,
  dc_role gated, scope-resolution helper, fail-soft external-API
  posture)
- BRIEFS/brief-061-sysadmin-set-dc-role-tool.md (the dc_role +
  dc_locations write surface — the read side this brief consumes
  works the same way)
- apps/damage-worker/src/index.ts:484-496 (`damageScopeForSession`,
  `DamageScope` — the exact shape this brief's worker copies; the
  helper itself is local to damage-worker today, so this brief
  duplicates it as `workOrderScopeForSession` rather than refactoring
  to a shared package — see Decisions section)
- apps/damage-worker/src/maintainx.ts (Brief 42's WO-create helper —
  this brief reads from the same MaintainX API but uses the GET
  `/workorders` endpoint, not POST; same auth header, same base URL,
  no shared code today other than the `MAINTAINX_BASE_URL` var
  convention)
- apps/damage-worker/wrangler.toml (the `[vars]` /
  `[observability.logs]` blocks the new worker's wrangler.toml
  mirrors)
- apps/web/wrangler.toml (`[[services]]` array — this brief appends
  one entry: `WORKORDERS_WORKER` → `splash-workorders`)
- apps/web/middleware.ts (the auth gate this brief extends — adds
  `/workorders` to the matcher + cookie-presence check)
- apps/web/app/admin/dashboard/page.tsx (the card grid this brief
  appends a sixth tile to)
- apps/web/app/admin/damage/_lib/worker-fetch.ts (the service-binding
  + URL-fallback pattern this brief mirrors for the new
  `workorders-worker-fetch.ts` helper)
- packages/db-supabase/src/locations.ts (`getMaintainXLocationId` — this
  brief adds a sibling `getMaintainXIdsForLocationCodes(env, codes[])`
  that takes a list and returns a Map<location_code, {maintainx_id,
  location_pretty, site}>; same two-step pricing_simple → site_number
  → locations join chain, deduplicated for an N-row IN-list)
- packages/types/src/session.ts (`Session` — `dcRole` +
  `dcLocations` are the gating source of truth)
- pnpm-workspace.yaml (workspace package list — new worker must be
  registered)
- turbo.json (build pipeline — verify the new worker's `typecheck` /
  `build` scripts are picked up automatically by the existing globs;
  if not, add them per the existing per-worker pattern)

## Context

The MaintainX integration today is write-only: when a customer
submits a claim with `equipment_related=1` (Brief 42) OR a GM
approves into one of two active-repair statuses with the equipment
override modal (Brief 43), damage-worker POSTs `/v1/workorders` to
create a work order, stores the returned ID on `claims.maintainx_workorder_id`,
and surfaces a single "MaintainX WO #N" link on the damage detail
page that opens the WO in MaintainX itself. There is no Splash-side
view of MaintainX work orders — operators must log into MaintainX
to see what's open.

This brief adds the read side: a new `splash-workorders` Cloudflare
Worker exposing `GET /workorders/api/list` (and any sibling endpoints
this brief introduces in Phase 3), and a new top-level apps/web page
at `/workorders` that surfaces open / in-progress / on-hold MaintainX
work orders relevant to the logged-in operator, grouped by location
and ordered by priority highest first within each group.

**Why a separate worker** (operator decision 2026-05-07): per the
existing 5-worker pattern (each domain owns one worker), MaintainX
deserves its own worker rather than living inside damage-worker. The
secret value is identical to the one already bound on splash-damage
(operator binds the same `MAINTAINX_API_KEY` to splash-workorders via
`wrangler secret put`); the workers are domain-isolated, not
secret-isolated. The damage-worker's WO-create path (Brief 42 / 43)
is unchanged by this brief.

**Why dc_role gating** (operator decision 2026-05-07): the user's
opening request mentioned "permission gated based on locations table
area_manager, regional_manager, site_email", but the operator's
explicit answer to this brief's planning question selected "Use
dc_role like damage claims" — i.e., consume `Session.dcRole` +
`Session.dcLocations` (Brief 61's authoritative permission domain
for damage tooling) rather than per-row email matches against
`pricing_simple.am_email` / `rm_email` / `site_email`. Trade-off:
operators who own a location's email contacts but were never granted
a `dc_role` (gm/rm/admin/super_admin) see an empty page. Mitigation:
sysadmin's "Set DC Role" tool (Brief 61) is the canonical write
surface for granting access; if an operator surfaces missing access
during smoke test, sysadmin grants `gm` or `rm` + the relevant
location_codes. Future brief could layer email-on-locations as a
secondary gate; out of scope here.

**Why a top-level `/workorders` route** (operator decision 2026-05-07):
the operator pushed back on `/admin/workorders` — "doesn't seem like
/admin is the right home for it." apps/web today has all admin tools
under `/admin/*` (gated by middleware) and customer-facing routes at
`/signup/*` / `/q/*` / `/join/*` / `/claims/*` (NOT gated). This
brief introduces a third top-level pattern: `/workorders` is admin-
gated (middleware extended) but lives outside the `/admin/*` tree.
The dashboard tile (added on `/admin/dashboard`) is the entry point
operators use; the URL itself is the operator-preferred shape.

**Status filter** (per user request): only OPEN, IN_PROGRESS, ON_HOLD
work orders. The other three MaintainX statuses (DONE, CANCELED,
SKIPPED) are excluded from this view. Operators who want to see
closed WOs follow the link out to MaintainX itself.

**Sort + group** (per user request): grouped by Splash `location_code`,
ordered by priority HIGH → MEDIUM → LOW → NONE within each group.
Server-side sort so the page renders deterministically without client
JS.

## Scope

### Phase 1 — New worker scaffold

1.1 Create `apps/workorders-worker/` directory with the standard
five-file shape:

```
apps/workorders-worker/
  package.json          # @splash/workorders-worker; mirrors damage-worker
  tsconfig.json         # extends ../../tsconfig.base.json (or whatever
                        # the existing pattern is — match damage-worker)
  wrangler.toml         # see Phase 2
  src/
    index.ts            # router, handlers, dc_role scoping
    maintainx.ts        # MaintainX GET /workorders client (read-only;
                        # NOT a duplicate of damage-worker/src/maintainx.ts
                        # which is POST-only)
```

1.2 `package.json` mirrors `apps/damage-worker/package.json` shape —
same scripts (`typecheck`, `build`, `dev`, `deploy`), same
dependencies that apply (`@splash/auth`, `@splash/http`,
`@splash/db-supabase`, `@splash/types`, `wrangler`, `typescript`).
Worker name: `@splash/workorders-worker`.

1.3 Register the new package in `pnpm-workspace.yaml` (if the
existing globs don't already pick it up — check; if `apps/*` is the
glob, no change needed). Run `pnpm install` to wire the workspace.

1.4 `turbo.json` — verify the new worker is picked up by the existing
`typecheck` / `build` task globs. If `apps/*` is implicit no change
needed; if explicit per-worker entries exist, append a row.

### Phase 2 — wrangler.toml for the new worker

2.1 `apps/workorders-worker/wrangler.toml`:

```toml
# Splash Work Orders Worker — read-only MaintainX integration.
#
# Surfaces open/in-progress/on-hold work orders to operators on
# /workorders (apps/web). dc_role gated (Brief 61): super_admin/admin
# global; gm/rm scoped to dc_locations.
#
# DEPLOY STRATEGY: workers.dev fallback only until apps/web cuts
# over. Staging route binds /workorders/api/* on staging.splashcarwashes.info
# so apps/web can call same-origin (per Brief 16 pattern).
#
# Production routes intentionally NOT bound (commented). Mirrors the
# pattern used by damage-worker / sysadmin-worker / etc.

name = "splash-workorders"
main = "src/index.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

workers_dev = true

# Step 7 cutover routes (uncomment when apps/web is ready):
# routes = [
#   { pattern = "splashcarwashes.info/workorders/api/*", zone_name = "splashcarwashes.info" }
# ]

# Staging routes (Brief 16 pattern).
routes = [
  { pattern = "staging.splashcarwashes.info/workorders/api/*", zone_name = "splashcarwashes.info" }
]

# Bindings:
# SUPABASE_URL          — string (set as [vars] entry below; same
#                         value as the other workers; required for the
#                         dc_role + maintainx_id resolution chain)
# SUPABASE_SERVICE_KEY  — secret (`wrangler secret put SUPABASE_SERVICE_KEY`
#                         with the same value used on damage-worker /
#                         sysadmin-worker)
# MAINTAINX_API_KEY     — secret (`wrangler secret put MAINTAINX_API_KEY`
#                         with the SAME value already bound on splash-damage;
#                         the API key is per-organization, not per-worker)

# Brief 42 / 70 — non-secret env vars consumed by the MaintainX read path.
#   MAINTAINX_BASE_URL — REST root (no trailing /workorders).
#   APPS_WEB_BASE_URL  — used for any apps/web cross-link rendering inside
#                        responses (e.g. "view in Splash" links if surfaced
#                        in a future iteration). Not consumed in this
#                        brief's v1 endpoint shape but populated for parity
#                        with damage-worker so future code can reuse.
[vars]
MAINTAINX_BASE_URL = "https://api.getmaintainx.com/v1"
APPS_WEB_BASE_URL  = "https://splashcarwashes.info"
SUPABASE_URL       = "<copy from apps/damage-worker/wrangler.toml>"

# Brief 63: keeps Workers Logs sticky across deploys.
[observability.logs]
enabled = true
invocation_logs = true
```

2.2 The worker's `Env` interface (declared in `src/index.ts`) lists:

```ts
interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  MAINTAINX_API_KEY?: string;       // optional — fail-soft when unbound
  MAINTAINX_BASE_URL: string;
  APPS_WEB_BASE_URL: string;
}
```

### Phase 3 — Worker endpoint(s)

3.1 Single endpoint for v1:

```
GET /workorders/api/list
```

  - Auth: same cookie-based session validation pattern as
    damage-worker. Reads `sb-access-token` cookie via
    `@splash/auth`'s session helper (find the exact import — likely
    `getSessionFromRequest` or similar; copy whatever damage-worker
    does at the top of `getClaimsList`). 401 on missing/invalid
    session.
  - dc_role gating: replicate `damageScopeForSession` from
    `apps/damage-worker/src/index.ts:484-496` as a local helper
    `workOrderScopeForSession(session)` returning the same three-state
    union (`global` | `scoped` | `denied`). 403 on `denied` (no
    dc_role).
  - For `scoped`: resolve the user's `dcLocations` (location_code[])
    → maintainx_id[] via the new `getMaintainXIdsForLocationCodes`
    helper (Phase 5). Drop locations whose maintainx_id is null
    (location row exists but no MaintainX site is mapped) — flag in
    the response so the page can surface a soft warning.
  - For `global`: skip the location-filter step and call MaintainX
    without the `locations` query param (returns ALL open WOs across
    the whole org). Then resolve every distinct `locationId` returned
    → location_code via a reverse lookup helper (Phase 5).
  - MaintainX request:
    - Method: `GET ${MAINTAINX_BASE_URL}/workorders`
    - Headers: `Authorization: Bearer ${MAINTAINX_API_KEY}`,
      `Accept: application/json`
    - Query params:
      - `statuses=OPEN` + `statuses=IN_PROGRESS` + `statuses=ON_HOLD`
        (three repeated `statuses` params per MaintainX spec)
      - `expand=assignees` + `expand=location` + `expand=thumbnail`
        (three repeated `expand` params — gives us assignee names,
        location info, and thumbnail URL inline so the page doesn't
        need follow-up calls)
      - `limit=200` (MaintainX max — matches the user request to "pull
        open, in progress, and on hold work orders")
      - `sort=-updatedAt` (most-recently-updated first inside the
        eventual priority sort — provides a reasonable secondary
        order)
      - `locations=<id1>&locations=<id2>...` for `scoped` users
        (omitted for `global`)
  - 8 second `AbortController` timeout (mirrors Brief 42 posture).
  - Fail modes:
    - `MAINTAINX_API_KEY` unbound → 503 with body
      `{ error: "MaintainX integration not configured" }`. Page
      surfaces as a friendly empty state.
    - MaintainX returns non-2xx → log status + body (capped 2 KB),
      respond 502 with body
      `{ error: "MaintainX upstream returned <status>" }`. Page
      surfaces as a friendly error state.
    - Network / timeout → 504 with body `{ error: "MaintainX timeout" }`.
    - Any thrown exception in the resolution chain → 500.
  - Pagination: NOT handled in v1. MaintainX returns `nextCursor` /
    `nextPageUrl` when the result exceeds `limit`. With the
    OPEN/IN_PROGRESS/ON_HOLD filter and `limit=200`, expected steady
    state is ≤200 WOs across the whole org. If the response includes
    a non-null `nextCursor`, log a warning AND surface a
    `truncated: true` flag in the response shape so the page renders a
    soft "Showing first 200 — log into MaintainX for the full list"
    banner. Add a follow-up brief to handle pagination if `truncated`
    actually fires in production.

3.2 Response shape (server already sorted + grouped):

```jsonc
{
  "scope": "global" | "scoped",          // matches the resolved DamageScope
  "missingMaintainxIds": ["columbus", ...], // location_codes the user
                                            // has dc_role access to but
                                            // whose locations.maintainx_id
                                            // is null. Empty array on global.
  "groups": [
    {
      "location_code": "binghamton",
      "location_pretty": "Binghamton",
      "maintainx_id": 3774771,
      "work_orders": [
        {
          "id": 148490,
          "sequentialId": 12345,
          "title": "Damage Claim - Binghamton - Wiper",
          "status": "OPEN" | "IN_PROGRESS" | "ON_HOLD",
          "priority": "HIGH" | "MEDIUM" | "LOW" | "NONE",
          "createdAt": "2026-05-06T14:22:00.000Z",
          "updatedAt": "2026-05-07T08:11:00.000Z",
          "dueDate": "2026-05-15T00:00:00.000Z" | null,
          "description": "Customer claim ..." | null,  // truncated to 500 chars
          "assignees": [
            { "id": 409112, "name": "Brett Sullivan" }  // expand=assignees
          ],
          "thumbnailUrl": "https://..." | null,
          "categories": ["Vehicle Damage"]
        }
      ]
    }
  ],
  "unmatchedWorkOrders": [   // only populated for `global` — WOs whose
                             // locationId didn't match any locations row.
                             // Empty array for `scoped`.
    {
      "id": ...,
      "title": ...,
      "maintainxLocationId": 1234,   // raw MX id we couldn't resolve
      "maintainxLocationName": "...",  // from expand=location
      ...same fields as above
    }
  ],
  "truncated": false,        // true if MaintainX returned nextCursor
  "fetchedAt": "2026-05-07T..."  // server timestamp for UI "as of" display
}
```

3.3 Server-side sort + group:

  - Bucket WOs by `locationId` (MaintainX's number).
  - For `scoped` users: every bucket whose `locationId` matches a
    user-accessible maintainx_id becomes a `groups[]` entry; everything
    else is dropped (the `locations=` query param should have already
    excluded these, but defense-in-depth on the response).
  - For `global` users: every bucket whose `locationId` resolves to a
    Splash location_code becomes a `groups[]` entry; unresolved
    `locationId`s land in `unmatchedWorkOrders[]` (so the page can
    surface them as a "no Splash location mapped" footer block —
    operator visibility into MaintainX-side data hygiene gaps).
  - Within each `groups[]` entry, sort `work_orders` by:
    1. priority (HIGH=0, MEDIUM=1, LOW=2, NONE=3)
    2. `updatedAt` desc (tie-breaker)
  - `groups[]` itself sorted alphabetically by `location_pretty`.

3.4 Description truncation: MaintainX descriptions can be long
(Brief 42's WO descriptions are 1-2 KB). Truncate to 500 chars +
"…" suffix for the list view. The link to MaintainX gives the full
description; the list is for scanning, not reading.

### Phase 4 — Module-local maintainx.ts in workorders-worker

4.1 Create `apps/workorders-worker/src/maintainx.ts`:

  - Single named export `fetchMaintainXWorkOrders(input): Promise<FetchResult>`.
  - Input:
    ```ts
    interface FetchInput {
      apiKey: string;
      baseUrl: string;
      maintainxLocationIds?: number[];  // omitted on global
      signal?: AbortSignal;
    }
    interface FetchResult {
      ok: boolean;
      workOrders: RawWorkOrder[];       // shape matches MaintainX response
      truncated: boolean;
      error: string | null;
      status: number;
    }
    ```
  - Build URL with `URLSearchParams` (handles repeated keys for
    `statuses=` / `expand=` / `locations=`).
  - Caller decides what to do with errors. Helper never throws.
  - `RawWorkOrder` is a minimal subset of the MaintainX response
    shape — enough to satisfy the response-shape mapping in Phase 3.2.
    Only fields actually used.

4.2 The handler in `index.ts` calls this helper, then transforms +
sorts + groups before returning JSON.

### Phase 5 — Supabase helper for bulk maintainx_id resolution

5.1 In `packages/db-supabase/src/locations.ts`, add a sibling helper
to `getMaintainXLocationId`:

```ts
export interface MaintainXLocationInfo {
  location_code: string;
  location_pretty: string | null;
  site_number: string | null;
  maintainx_id: number | null;
}

/**
 * Bulk resolve a list of Splash location_codes to MaintainX info.
 * Returns one entry per requested location_code (preserves caller's
 * input set). Entries with a null maintainx_id mean the locations row
 * exists but no MaintainX site is mapped — surface in the page as a
 * soft warning; don't error.
 *
 * Uses the same two-step join chain as getMaintainXLocationId (Brief
 * 62): pricing_simple.location_code → pricing_simple.site (text;
 * denormalized site_number) → locations.site_number → maintainx_id.
 * Bulk variant fires two PostgREST GETs total (one per table) using
 * IN-clauses, not 2N round-trips.
 */
export async function getMaintainXIdsForLocationCodes(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  locationCodes: string[]
): Promise<MaintainXLocationInfo[]>
```

  - Empty input → `[]`.
  - Step 1: `GET /rest/v1/pricing_simple?select=location_code,location_pretty,site&location_code=in.(<csv>)&limit=N`
    Dedupe by `location_code` server-side
    (`pricing_simple` has multiple rows per location, one per package;
    pick the first non-null `location_pretty` / `site` per code).
  - Step 2: `GET /rest/v1/locations?select=site_number,maintainx_id&site_number=in.(<csv>)&limit=N`
    where the IN-csv is the distinct `site` values from step 1.
  - Build the result: for each input `location_code`, find its
    `site` from step 1, then its `maintainx_id` from step 2. NULL
    cascade if either step misses the row.
  - Fail-soft: any throw → return entries with all-null fields for
    each input code. Caller treats null as "not mapped".

5.2 Add a sibling for the global path:

```ts
/**
 * Resolve a list of MaintainX locationIds back to Splash location_codes.
 * Used when the worker fetches ALL work orders globally and needs to
 * group them. Returns a Map keyed by maintainx_id for O(1) lookup.
 * Unmapped MaintainX IDs simply don't appear in the Map.
 */
export async function getLocationCodesByMaintainXIds(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  maintainxIds: number[]
): Promise<Map<number, MaintainXLocationInfo>>
```

  - Two-step join in reverse:
    `GET /rest/v1/locations?select=site_number,maintainx_id&maintainx_id=in.(<csv>)`
    then
    `GET /rest/v1/pricing_simple?select=location_code,location_pretty,site&site=in.(<csv>)`
    dedupe by location_code, build the Map.
  - Fail-soft: any throw → empty Map. Caller surfaces all WOs as
    `unmatchedWorkOrders`.

5.3 Export both helpers from `packages/db-supabase/src/index.ts`.

### Phase 6 — apps/web service binding + middleware

6.1 `apps/web/wrangler.toml` — append to the `[[services]]` array:

```toml
[[services]]
binding = "WORKORDERS_WORKER"
service = "splash-workorders"
```

6.2 `apps/web/cloudflare-env.d.ts` (or wherever the bindings are
declared — find via grep for existing `DAMAGE_WORKER` declaration) —
add `WORKORDERS_WORKER: Fetcher;` to the `CloudflareEnv` interface.

6.3 `apps/web/middleware.ts`:
  - Add `"workorders"` to `ADMIN_KNOWN_SUBPATHS` is NOT needed
    (that constant gates `/admin/{slug}` redirects, not the new
    top-level path).
  - Extend the `matcher` config:
    ```ts
    matcher: [
      "/admin/:path*",
      "/sysadmin/:path*",
      "/workorders/:path*",  // NEW
      "/change-password",
      "/login",
      "/logout"
    ]
    ```
  - The auth-gate logic at the bottom of `middleware()` already
    handles "any matched path that isn't /login, /change-password, or
    /logout" via the `if (!hasCookie) return redirectToLogin(request)`
    fallthrough. `/workorders/*` falls into that branch; no further
    code change needed.
  - Update the docblock at the top of the file to mention `/workorders/*`
    in the "auth gate" section list.

6.4 `apps/web/next.config.mjs` — if it has a `rewrites()` block
proxying `/manage/api/:path*` → damage-worker (per Brief 17),
add a sibling block for `/workorders/api/:path*` → workorders-worker
(consumed only by `next dev`; production routes through service
binding). Use the same `NEXT_PUBLIC_WORKORDERS_WORKER_URL` env var
pattern as the other workers.

### Phase 7 — apps/web fetch helper

7.1 Create `apps/web/app/workorders/_lib/worker-fetch.ts` mirroring
`apps/web/app/admin/damage/_lib/worker-fetch.ts` shape (service-binding
preferred, URL fallback for `next dev`):

```ts
export async function fetchWorkOrdersList(): Promise<WorkOrdersListResponse>
```

  - Try `getCloudflareContext({ async: true })` → use
    `env.WORKORDERS_WORKER.fetch(req)` with `https://internal/workorders/api/list`
    placeholder host.
  - Catch / fall back to URL fetch using
    `process.env.NEXT_PUBLIC_WORKORDERS_WORKER_URL` (dev) or
    request-host (same-origin prod).
  - Forward `Cookie` header from `cookies().toString()`.
  - Return parsed JSON; throw on non-2xx (caller renders error).

7.2 Co-locate the `WorkOrdersListResponse` TS type in the same file.
Mirrors the response shape from Phase 3.2.

### Phase 8 — apps/web page

8.1 Create `apps/web/app/workorders/page.tsx`:

  - Server component (default).
  - Force-dynamic so it never SSGs:
    ```ts
    export const dynamic = "force-dynamic";
    ```
  - Calls `fetchWorkOrdersList()`. On error, render an inline error
    state with retry hint.
  - Layout (centered, mirrors Brief 58's `mx-auto w-full max-w-[1100px]
    px-5 py-9` convention):
    ```
    <Header />   ← from app/_components/Header.tsx, already global
    <main>
      <h1>Work Orders</h1>
      <p class="muted">
        Open / In Progress / On Hold work orders across MaintainX,
        scoped to your assigned locations.
        <span class="ts">As of {fetchedAt}</span>
      </p>

      <!-- soft warning if missingMaintainxIds.length > 0 -->
      <div class="warning">
        N of your locations don't have a MaintainX ID mapped — work
        orders for those locations won't appear here. Talk to a
        super_admin to update locations.maintainx_id.
        <details>{list}</details>
      </div>

      <!-- main content -->
      {groups.length === 0 && <EmptyState />}
      {groups.map(group => (
        <section>
          <h2>{group.location_pretty}</h2>
          <table>
            <thead>
              <tr>
                <th>Priority</th>
                <th>Title</th>
                <th>Status</th>
                <th>Assignees</th>
                <th>Updated</th>
                <th>Open in MaintainX</th>
              </tr>
            </thead>
            <tbody>
              {group.work_orders.map(wo => (
                <tr>
                  <td><PriorityPill priority={wo.priority} /></td>
                  <td>
                    <div>{wo.title}</div>
                    <div class="muted small">#{wo.sequentialId}{description ? " · " + truncateOneLine(description, 120) : ""}</div>
                  </td>
                  <td><StatusPill status={wo.status} /></td>
                  <td>{wo.assignees.map(a => a.name).join(", ") || "—"}</td>
                  <td><relative-time>{wo.updatedAt}</relative-time></td>
                  <td>
                    <a href={`https://app.getmaintainx.com/workorders/${wo.id}`} target="_blank" rel="noreferrer">↗</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <!-- global only: unmatchedWorkOrders -->
      {scope === "global" && unmatchedWorkOrders.length > 0 && (
        <section class="muted">
          <h2>Unmapped locations</h2>
          <p>These work orders are in MaintainX but their locationId
             doesn't map to a Splash locations row. Map via the
             sysadmin Update Location editor.</p>
          {table with maintainxLocationName, work order info}
        </section>
      )}
    </main>
    ```

8.2 Components to create alongside the page:

  - `apps/web/app/workorders/_components/PriorityPill.tsx` — pure
    presentation, four states (HIGH = red, MEDIUM = amber, LOW =
    neutral, NONE = muted). Same pill styling as the existing
    `<AgePill>` from Brief 68/69 for visual consistency (rounded-full,
    px-2, py-0.5, text-xs, font-medium).
  - `apps/web/app/workorders/_components/StatusPill.tsx` — three
    states (OPEN = blue, IN_PROGRESS = amber, ON_HOLD = gray). Pill
    style.
  - `apps/web/app/workorders/_components/EmptyState.tsx` — copy:
    "No open work orders for your locations. Nice." with a soft icon
    and a footer hint linking to MaintainX directly for the full
    history.

8.3 Server-side render the timestamps using a simple
`<RelativeTime iso={...}>` helper (text only — "2 hours ago" /
"yesterday" / fallback to date for >7 days). No client island
required for v1.

### Phase 9 — Dashboard tile

9.1 In `apps/web/app/admin/dashboard/page.tsx`, append a sixth card to
the existing card grid:

```tsx
<DashboardCard
  href="/workorders"
  title="Work Orders"
  description="Open MaintainX work orders for your locations"
/>
```

  - Match whatever the existing card component / grid shape is — copy
    one of the existing entries verbatim (Damage / Sysadmin / Signup
    Admin / Performance / Pricing) and adjust the href + copy.
  - Card icon: pick whatever's available in the existing icon set;
    if there's a "wrench" or "tool" icon use that, else use a
    placeholder consistent with the others.

### Phase 10 — Permission gate UX on /workorders

10.1 If the worker returns 403 (`denied` scope — user has no
dc_role), render an inline gated message on the page:

```
"Work Orders access is gated on a damage-claim role.
 Ask a super_admin to grant you a DC role through the
 sysadmin Set DC Role tool."
```

Style consistent with the auth-failed copy on other pages. Don't
redirect — the operator landed here from a dashboard tile, so a
clear "you don't have access" message is friendlier than bouncing.

10.2 If the worker returns 503 (MAINTAINX_API_KEY unbound) — render
a developer-facing warning:

```
"MaintainX integration not configured on the workorders-worker.
 Operator: bind MAINTAINX_API_KEY via wrangler secret put."
```

This is internal-only copy; production should never see it once the
operator binds the secret post-deploy.

### Phase 11 — CLAUDE.md updates

11.1 Top of CLAUDE.md, the `apps/` block — add the sixth worker:

```
apps/workorders-worker  Work Orders read API at /workorders/api/*
                        (MaintainX integration; sibling of damage-worker)
```

11.2 "Working with apps/web" Real-pages list — add `/workorders`
(top-level, NOT under /admin/*).

11.3 New entry in "Working with workers" section:

```
- **`MAINTAINX_API_KEY` is bound on TWO workers** (damage-worker for
  the WO-create path, workorders-worker for the WO-read path). Same
  value; per-worker bindings. Future MaintainX surfaces should pick
  one of these two workers as the home rather than spawning a third.
```

11.4 Glossary — new entry:

```
- **Work Orders** - Brief 70's read-only MaintainX integration.
  Surfaces open / in-progress / on-hold work orders to operators on
  /workorders (top-level apps/web page, dc_role gated). Backed by
  GET /workorders/api/list on splash-workorders worker. Grouped by
  Splash location_code, ordered by priority desc within group. Each
  WO row links out to MaintainX itself; this view does not write or
  edit WOs (Brief 42 / 43 own the create path on damage-worker).
```

11.5 In the "Critical constraints" section, no changes needed —
`/workorders` is not a load-bearing customer URL and operators
discover it via the dashboard tile.

### Phase 12 — BUILD_STATE.md

12.1 Bump "Last updated" to today's date.

12.2 Add a row to the "Open work — prioritized" table for Brief 70.

12.3 New "Findings & decisions log" entry covering:
  - The new worker scaffold (sixth deployable)
  - The dual MAINTAINX_API_KEY binding decision
  - dc_role-gated rather than email-on-locations gating decision
    (with rationale: aligns with damage tooling's existing permission
    domain)
  - Top-level `/workorders` route decision (NOT under `/admin/*`)
  - Fail-soft posture for MaintainX upstream errors
  - The two new bulk Supabase helpers
    (`getMaintainXIdsForLocationCodes`,
    `getLocationCodesByMaintainXIds`)

### Phase 13 — Validation

13.1 `pnpm typecheck` — must pass for all 14 packages (13 existing
+ 1 new worker).

13.2 `pnpm --filter @splash/web build` — must succeed; new
`/workorders` route must appear in the route manifest.

13.3 `pnpm --filter @splash/workorders-worker exec wrangler deploy
--dry-run --outdir=.tmp-build-wo` — bundle must succeed; clean up
afterward. Capture bundle size for the Outcome.

13.4 `pnpm --filter @splash/damage-worker exec wrangler deploy
--dry-run --outdir=.tmp-build-d` — must still succeed (sanity check;
no damage-worker code changed but the workspace install touches
node_modules graph).

13.5 No D1 schema change. No new D1 tables. No Supabase schema
change.

13.6 Confirm the new worker's wrangler.toml `[observability.logs]`
block matches the Brief 63 pattern verbatim.

13.7 Confirm the apps/web service binding in `cloudflare-env.d.ts`
typechecks: `env.WORKORDERS_WORKER.fetch(req)` resolves to a valid
return type.

### Phase 14 — Updates

14.1 BRIEFS/INDEX.md — Brief 70 row added with summary + outcome.

14.2 BRIEFS/QUEUE.md — Brief 70 line moved to the completed-tombstone
block.

14.3 PRE_DEPLOY_*.md files — no updates needed for the existing five.
Optionally add a stub `PRE_DEPLOY_WORKORDERS.md` mirroring the
existing per-worker shape (smoke tests for `/workorders/api/list`
under various dc_role / scope combinations); brief leaves the choice
to executor judgment — if the existing pattern always pairs a worker
with a PRE_DEPLOY file, add the stub; if not, defer to a later brief.

## Configuration

New env vars / secrets:

- `splash-workorders` worker — operator must run AFTER deploy:
  ```powershell
  pnpm --filter @splash/workorders-worker exec wrangler secret put MAINTAINX_API_KEY
  pnpm --filter @splash/workorders-worker exec wrangler secret put SUPABASE_SERVICE_KEY
  ```
  - `MAINTAINX_API_KEY` — same value as the one already bound on
    `splash-damage`. Read it via `pnpm --filter @splash/damage-worker
    exec wrangler secret list` (returns key names only — operator
    needs the raw value from MaintainX dashboard or 1Password).
  - `SUPABASE_SERVICE_KEY` — same value used on every other worker.
  - `SUPABASE_URL` — non-secret, set as `[vars]` entry in
    wrangler.toml so it's diff-able. Operator copies the existing
    value from `apps/damage-worker/wrangler.toml`.

- `apps/web` worker — no new secrets. Service binding wires
  automatically via the `[[services]]` array.

## Out of scope

- Writing or editing MaintainX work orders (status changes,
  reassignment, comment posting). v1 is read-only; the link out to
  MaintainX is the canonical edit surface.
- Filtering by status / priority / assignee inside the page UI.
  Single combined view of open + in-progress + on-hold; users want
  the full list ordered by priority, not a filterable surface. v2
  could add filters if operators ask.
- Pagination beyond 200 results. If the org grows past steady-state
  200 open WOs, surface as a follow-up brief that adds cursor-based
  pagination + "load more" UX.
- MaintainX webhooks / push notifications. Pull-based read on every
  page load is sufficient for v1.
- Caching the MaintainX response. Every page load hits MaintainX
  fresh. If page load times suffer, layer in a 30s in-memory cache
  on the worker as a follow-up.
- Email-based gating (am_email / rm_email / site_email) — operator
  decision favored dc_role; flagged in Context for future
  consideration.
- Rendering work orders that don't have a Splash MaintainX mapping
  (i.e., MaintainX has WOs but no locations row maps the locationId).
  These surface as a footer block on the page for `global` users
  only; not interactive.
- Updating the existing damage-worker's MaintainX surface. Brief 42
  / 43 stay unchanged.
- Don't deploy from headless. Operator pushes to GH; CF Workers
  Builds picks up the new worker config (the operator may need to
  configure Builds for the new worker — flag in Outcome if so).
- Don't bind production routes (the cutover routes block in the new
  wrangler.toml stays commented).
- Don't commit to git or push.

## Definition of done

- `apps/workorders-worker/` directory exists with the standard
  five-file shape (package.json, tsconfig.json, wrangler.toml,
  src/index.ts, src/maintainx.ts)
- `apps/workorders-worker/wrangler.toml` includes the observability
  block, the `[vars]` block (MAINTAINX_BASE_URL, APPS_WEB_BASE_URL,
  SUPABASE_URL), and staging routes
- `GET /workorders/api/list` endpoint implemented with dc_role
  gating, MaintainX fetch, sort + group, and the Phase 3.2 response
  shape
- `apps/web/wrangler.toml` has the new `[[services]]` entry for
  `WORKORDERS_WORKER`
- `apps/web/cloudflare-env.d.ts` declares `WORKORDERS_WORKER` as
  `Fetcher`
- `apps/web/middleware.ts` matcher includes `/workorders/:path*`;
  docblock updated
- `apps/web/next.config.mjs` rewrites include the new
  `/workorders/api/:path*` proxy (if rewrites block exists)
- `apps/web/app/workorders/page.tsx` renders the grouped list with
  proper empty state, error state, and gated state
- `apps/web/app/workorders/_lib/worker-fetch.ts` exists; tries
  service binding first, falls back to URL fetch
- `apps/web/app/workorders/_components/{PriorityPill,StatusPill,EmptyState}.tsx`
  exist
- `apps/web/app/admin/dashboard/page.tsx` has a "Work Orders" card
  linking to `/workorders`
- `packages/db-supabase/src/locations.ts` exports
  `getMaintainXIdsForLocationCodes` + `getLocationCodesByMaintainXIds`
  (plus their result interfaces); both re-exported from
  `packages/db-supabase/src/index.ts`
- pnpm typecheck passes for all 14 packages
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/workorders-worker exec wrangler deploy
  --dry-run succeeds
- pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run
  still succeeds
- BRIEFS/INDEX.md, BRIEFS/QUEUE.md, BUILD_STATE.md, CLAUDE.md
  updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Files created (expected ~10-13: new worker scaffold + apps/web
  page + components + helpers)
- Files modified (expected ~5-7: wrangler.toml, middleware.ts,
  cloudflare-env.d.ts, dashboard page, db-supabase index, etc.)
- Bundle size for the new worker (uncompressed + gzip)
- Bundle size delta on apps/web (`/workorders` route specifically)
- Validation results
- Whether the workspace `pnpm install` picked up the new worker
  automatically or needed manual pnpm-workspace.yaml update
- Whether turbo.json needed any change (the existing globs vs
  per-worker entries question)
- Decisions made on the operator's behalf
- Latent issues or limitations surfaced during the work
- Operator action items (CF Workers Builds setup for the new
  worker, secret bindings, etc.)

## Outcome

### Files created (12)

- `apps/workorders-worker/package.json`
- `apps/workorders-worker/tsconfig.json`
- `apps/workorders-worker/wrangler.toml`
- `apps/workorders-worker/src/index.ts`
- `apps/workorders-worker/src/maintainx.ts`
- `apps/web/app/workorders/page.tsx`
- `apps/web/app/workorders/_lib/worker-fetch.ts`
- `apps/web/app/workorders/_components/PriorityPill.tsx`
- `apps/web/app/workorders/_components/StatusPill.tsx`
- `apps/web/app/workorders/_components/EmptyState.tsx`
- (also: the two new bulk Supabase helpers were added to an existing file
  rather than a new one — see Files modified)

### Files modified (8)

- `packages/db-supabase/src/locations.ts` — appended
  `MaintainXLocationInfo` interface, `getMaintainXIdsForLocationCodes`,
  `getLocationCodesByMaintainXIds`, plus a private `escapeForInClause`
  helper. Re-exported automatically via `export *` from the package's
  `index.ts`.
- `apps/web/wrangler.toml` — added `[[services]] binding = "WORKORDERS_WORKER" service = "splash-workorders"`.
- `apps/web/cloudflare-env.d.ts` — added `WORKORDERS_WORKER: Fetcher` to
  the `CloudflareEnv` declaration.
- `apps/web/middleware.ts` — extended docblock + matcher with
  `/workorders/:path*`; the existing `if (!hasCookie) return
  redirectToLogin(...)` fallthrough handles the auth gate (no new
  branch needed).
- `apps/web/next.config.mjs` — added `{ source: "/workorders/api/:path*",
  envVar: "NEXT_PUBLIC_WORKORDERS_WORKER_URL" }` to `REWRITE_TARGETS`.
- `apps/web/app/admin/dashboard/page.tsx` — added a fifth tile
  (`href: "/workorders"`, eyebrow "MaintainX", title "Work Orders")
  with a wrench-shaped icon.
- `CLAUDE.md` — intro now mentions six workers; added
  `apps/workorders-worker` to the apps/ block; added a new
  "MAINTAINX_API_KEY is bound on TWO workers" rule under "Working with
  workers"; updated the existing "MaintainX integration (Brief 42)"
  block from "damage-worker only" to "damage-worker AND
  workorders-worker"; added a new "Workorders-worker endpoints"
  bullet documenting `GET /workorders/api/list`, fail modes, and the
  two bulk helpers; added `/workorders` (top-level, NOT under /admin/*)
  to the apps/web Real-pages list; added a new "Work Orders" Glossary
  entry.
- `BUILD_STATE.md` — bumped "Last updated" narrative to lead with Brief
  70; added a Brief 70 row to the prioritized work-list table; added a
  Findings & decisions log entry summarizing the work.
- `BRIEFS/INDEX.md` — Brief 70 row appended.
- `BRIEFS/QUEUE.md` — Brief 70 line moved to the completed-tombstone
  block.

### Decisions made on the operator's behalf

1. **`SUPABASE_URL` documented as a wrangler secret rather than a
   `[vars]` literal.** None of the existing five workers carry it as a
   plaintext `[vars]` entry; the new worker matches that pattern. The
   brief said "copy from apps/damage-worker/wrangler.toml" but the
   value isn't there — operator binds it via `wrangler secret put`
   (or via the CF dashboard) at deploy time, like the other workers.
2. **`workOrderScopeForSession` duplicated, not extracted to a
   shared package.** The brief explicitly delegated this judgment
   call. The helper is six lines, the two workers are domain-isolated,
   and lifting to a package would couple them on a stable API surface
   for marginal gain. Lift to a package only when a third domain
   reuses the shape.
3. **Description truncation = 500 chars** with an ellipsis suffix only
   when over the cap, per the brief.
4. **Empty `dc_locations` for a gm/rm returns 200 with empty groups,
   not 403.** Operator can grant locations later without the page
   short-circuiting on a misleading "no access" message.
5. **Truncated handling = surface flag, not chase pagination.** v1
   doesn't follow MaintainX's nextCursor; the page banner tells
   operators to log into MaintainX directly for the full list when
   the expected ≤200 WO steady state is exceeded. Pagination flagged
   as a follow-up brief if `truncated` ever fires in production.
6. **PriorityPill / StatusPill copy:** "—" for NONE priority, "On
   Hold" / "In Progress" for the multi-word statuses; matches
   MaintainX's own labeling conventions.
7. **Unmapped MaintainX IDs surfaced for global users only.** Scoped
   users already pre-filter by `locations=` query param, so any drift
   would be a defense-in-depth catch (not user-actionable); only
   super_admin / admin's full-org view benefits from the data-hygiene
   visibility.
8. **No `PRE_DEPLOY_WORKORDERS.md` written.** Brief left the choice to
   executor judgment; the existing per-worker PRE_DEPLOY_*.md files
   are largely smoke-test runbooks tied to historical legacy parity
   (Brief 51's PRE_DEPLOY_WEB.md was the explicit ask). The worker's
   surface is a single GET endpoint; smoke testing reduces to
   "navigate to /workorders, verify the table renders for the
   operator's dc_role". A stub PRE_DEPLOY_WORKORDERS.md is a small
   follow-up if cutover-day discipline benefits from it.
9. **MaintainX list endpoint envelope tries multiple shapes** —
   `extractWorkOrders` looks at top-level array, `{ data: [...] }`,
   `{ workOrders: [...] }`, `{ results: [...] }`. The empirical probe
   is deferred to operator (headless cannot exercise live MaintainX);
   if MaintainX's response shape is one of those, the helper picks
   it up automatically; otherwise edit `extractWorkOrders`.
10. **Assignee name projection** tries `fullName`, then
    `firstName + lastName`, then falls back to `User #<id>`. Same
    rationale — assignee object shape isn't formally locked.

### Latent issues / forward flags

- **Operator must configure CF Workers Builds for the new worker**
  before the first auto-deploy from the GH push — `splash-workorders`
  doesn't exist in the CF dashboard yet; first-time setup is "create
  new Worker → connect to GitHub repo → set build dir to
  `apps/workorders-worker` → deploy".
- **Operator must bind 4 secrets on splash-workorders** post-create:
  `MAINTAINX_API_KEY` (same value as on splash-damage), `SUPABASE_URL`
  (same value as on splash-damage; non-secret but bound the same way
  the other workers do), `SUPABASE_ANON_KEY` (required by
  `authenticate()`'s `/auth/v1/user` round-trip), `SUPABASE_SERVICE_KEY`
  (same value as on splash-damage / splash-sysadmin).
- **MaintainX list/assignee response shape isn't formally locked** in
  this repo yet — see decisions 9/10 above.
- **No global-scope unmapped warning UX for scoped users** — by design;
  if a scoped user's dc_locations include a location whose maintainx_id
  is null, they see the soft warning, but unmatched MX WOs (locations
  not in their dc_locations at all) won't appear regardless.
- **Email-on-locations gating intentionally skipped** per operator's
  2026-05-07 decision — operators who own a location's contact emails
  but were never granted a `dc_role` see an empty page; sysadmin Set
  DC Role tool (Brief 61) is the canonical remediation. Future brief
  could layer email-on-locations as a secondary gate; out of scope
  here.
- **Cross-origin dev without `NEXT_PUBLIC_WORKORDERS_WORKER_URL` set**
  is unsupported — the page's relative-URL fetch would 404 against
  apps/web with no rewrite to fall through to. Pre-existing limitation
  inherited from the per-worker rewrites pattern.

### Validation results

- `pnpm typecheck` — 14/14 packages green (8.5s; cache hit on 8, fresh
  build on 6 after the workspace pickup of the new package). One fix
  needed mid-run: `noUncheckedIndexedAccess` flagged
  `PRIORITY_ORDER[p]` returning `number | undefined`; resolved by
  introducing a `PRIORITY_NONE_RANK = 3` constant and using it as the
  default in `priorityRank`.
- `pnpm --filter @splash/web build` — compiled in 6.1s, all 13 routes
  generated. New `/workorders` route appears in the manifest at
  **131 B / 102 kB First Load JS** (server-rendered, no client islands).
- `pnpm --filter @splash/workorders-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build-wo` — bundle **724.79 KiB
  uncompressed / 137.59 KiB gzip**. Comfortably within CF's 3 MiB
  compressed free-tier ceiling. `.tmp-build-wo` cleaned up.
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build-d` — still succeeds at **1720.07 KiB / 389.39 KiB
  gzip** (no damage-worker code changed; sanity check). `.tmp-build-d`
  cleaned up.
- `pnpm install` picked up the new package automatically — no
  `pnpm-workspace.yaml` change needed (the existing `apps/*` glob
  covers it). Same for `turbo.json` (existing task globs apply).

### Operator action items

1. **Create the `splash-workorders` Worker on CF** (Workers Builds
   wired to the GitHub repo). After repo wiring, push to deploy.
2. **Bind 4 secrets on splash-workorders:**
   ```powershell
   pnpm --filter @splash/workorders-worker exec wrangler secret put MAINTAINX_API_KEY
   pnpm --filter @splash/workorders-worker exec wrangler secret put SUPABASE_URL
   pnpm --filter @splash/workorders-worker exec wrangler secret put SUPABASE_ANON_KEY
   pnpm --filter @splash/workorders-worker exec wrangler secret put SUPABASE_SERVICE_KEY
   ```
   Use the same values as already configured on splash-damage /
   splash-sysadmin.
3. **Smoke test post-deploy:** navigate to
   `https://splash-web.<account>.workers.dev/workorders` (or
   `https://staging.splashcarwashes.info/workorders` after the staging
   route binds) cookie-authed and confirm the page renders for various
   dc_roles:
   - super_admin → global view (no location filter sent to MX),
     groups by location, possibly with `unmatchedWorkOrders` footer
     for any MX location IDs that don't map to a Splash row.
   - gm/rm with mapped locations → scoped view; one group per
     location with at least one MaintainX-bound location.
   - gm/rm with no MaintainX-mapped locations → empty page with the
     `missingMaintainxIds` warning banner.
   - User without a dc_role → "Work Orders access is gated on a
     damage-claim role" copy.
4. **When ready for cutover**, uncomment the production routes block
   in `apps/workorders-worker/wrangler.toml` and bind
   `splashcarwashes.info/workorders/api/*` alongside the existing
   per-worker bindings.

### Bundle sizes

- workorders-worker (new): 724.79 KiB raw / 137.59 KiB gzip.
- apps/web: `/workorders` route 131 B / 102 kB First Load JS
  (server-rendered, no client islands).
- damage-worker: 1720.07 KiB / 389.39 KiB gzip (unchanged from
  pre-Brief-70 baseline; no damage-worker code modified).
