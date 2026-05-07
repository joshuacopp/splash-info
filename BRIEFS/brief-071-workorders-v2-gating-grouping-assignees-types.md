# Brief 71: Work Orders v2 — email-on-locations gating, drop pricing_simple from read path, expandable rows, assignee/team name sync, Reactive/Preventive tabs

**Status:** Completed (2026-05-07)
**Started:** 2026-05-07
**Completed:** 2026-05-07
**Blocks:** Operator review of Brief 70's first deploy surfaced six
issues (one architectural, four product, one styling). This brief
fixes them all in one batch.
**Dependencies:**
- Brief 70 (the workorders-worker scaffold + apps/web `/workorders`
  page this brief patches; everything Brief 70 created stays — this
  brief replaces specific helpers and rewrites specific render paths)
- Brief 65 (the daily cron pattern this brief copies for the
  MaintainX user-sync handler — `{ fetch, scheduled }` default
  export, `[triggers] crons = ["..."]` in wrangler.toml,
  `[observability.logs]` block from Brief 63 covers scheduled
  invocations automatically)
- Brief 67 (the `useState<Set<string>>` expand-toggle pattern in
  `ByLocationTableClient.tsx` — this brief's expandable rows mirror
  it)
- Brief 27 (sysadmin Update Location editor — the sole supported
  way to set / change `locations.am_email` / `rm_email` /
  `site_email`, the fields this brief gates on)

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-070-workorders-worker-and-page.md (the brief this
  patches — every "Brief 70 said X" reference here points to that
  file's Scope or Outcome)
- BRIEFS/brief-065-daily-open-claims-summary-cron.md (the cron
  pattern this brief mirrors for the MaintainX user/team sync)
- BRIEFS/brief-067-reporting-cost-column-drilldown-avg-days.md
  (the `useState<Set<string>>` expand-toggle pattern in
  `apps/web/app/admin/damage/reporting/_components/ByLocationTableClient.tsx`
  — this brief's row-expansion mirrors it directly)
- BRIEFS/brief-027-sysadmin-update-location.md (the editor
  feeding `locations.am_email` / `rm_email` / `site_email`)
- apps/workorders-worker/src/index.ts (the handler this brief
  rewrites — entire scope-resolution chain replaced)
- apps/workorders-worker/src/maintainx.ts (the upstream client this
  brief extends — adds `expand=categories` URL param; sample
  response confirms `type` is on the WO body without an expand)
- apps/workorders-worker/wrangler.toml (the worker config this brief
  extends with `[triggers] crons = [...]` for the daily user/team
  sync)
- apps/web/app/workorders/page.tsx (the page this brief modifies —
  swaps single-list rendering for tabbed split, adds expandable rows)
- apps/web/app/workorders/_components/StatusPill.tsx (the pill
  renderer with the IN_PROGRESS rendering bug)
- apps/web/app/workorders/_components/PriorityPill.tsx (referenced
  for visual consistency)
- apps/web/app/workorders/_lib/worker-fetch.ts (the response shape
  helper this brief extends)
- packages/db-supabase/src/locations.ts (the helpers this brief
  rewrites — `getMaintainXIdsForLocationCodes` and
  `getLocationCodesByMaintainXIds` are deleted; new
  `getLocationsByContactEmail` added; existing
  `getMaintainXLocationId` from Brief 62 is unchanged)
- packages/db-supabase/src/index.ts (re-exports — drop the obsolete
  helper exports, add the new one + new MaintainX-user/team helpers)

## Context

Brief 70 shipped six issues that surfaced on first operator review
of `/workorders` against staging:

1. **Architectural — `pricing_simple` is the wrong join axis for
   the read path.** The bulk reverse helper
   `getLocationCodesByMaintainXIds` chains `locations.maintainx_id
   → locations.site_number → pricing_simple.site → location_code`,
   then renders the group header from `pricing_simple.location_pretty`.
   Two failures combined to break it for West Haven (and operator
   suspects other sites too):
   - **Zero-padding bug:** `pricing_simple.site` is text padded
     to 3 digits ("074"); `locations.site_number` is integer 74.
     The reverse helper builds `pricing_simple?site=in.(74)`, which
     PostgreSQL compares as the literal text `'74' = '074'` →
     false. The forward helper from Brief 62 works by accident
     because Postgres coerces `'074'` → 74 on the integer-column
     side, but the reverse direction has no such auto-coercion.
   - **Architectural mismatch:** even if zero-padding were fixed,
     `pricing_simple` is the customer-signup pricing surface — not
     every Splash site that gets MaintainX work orders has signup
     pricing rows (West Haven actually does, but data hygiene gaps
     are a recurring source of bugs and this design pulls them
     onto the read path). The `locations` table is the canonical
     mapping (`maintainx_id`, `site_number`, `location` address,
     `am_email`/`rm_email`/`site_email` contacts). It has every
     piece of data the page actually needs.

2. **Permission model — operator wants pure email-on-locations,
   no role override.** Brief 70 uses dc_role (super_admin/admin
   global, gm/rm scoped to dc_locations). Operator's 2026-05-07
   review: "people with admin or super admin in damage will see
   all, but don't need to see all — only need to see what they're
   linked to in locations." The original Brief 70 framing
   ("permission gated based on locations table area_manager,
   regional_manager, site_email") was correct; the dc_role pivot
   was wrong.

3. **Display — group rendering is broken.** Because issue 1 makes
   every WO fall into `unmatchedWorkOrders[]`, the page renders a
   flat "Unmapped MaintainX locations" table with no per-location
   grouping. Operator: "they're not grouped in any way."

4. **Display — rows can't expand.** Brief 70 truncates description
   to 500 chars in the row; full description, created date, and
   age (days since createdAt) aren't surfaced. Operator wants
   click-to-expand per row.

5. **Data — assignee names aren't on the page.** MaintainX's
   `assignees` array is `[{ id, type }]` only (no name field).
   Brief 70 rendered `wo.assignees.map(a => a.name)`, which is
   always empty because `name` doesn't exist on the assignee
   object — even with `expand=assignees`. Plus the operator wants
   to bucket by Reactive vs Preventive (issue 6) which depends on
   identifying users by role, so a user-name lookup is load-
   bearing for both surfaces. Operator's preferred shape: a
   daily cron syncing MaintainX users + teams into Supabase
   tables; the worker joins on read.

6. **Product — Reactive vs Preventive should be split.** The WO
   list mixes the two; operators want to focus on Reactive day-to-
   day and check Preventive separately. MaintainX's `type` field
   distinguishes them (`"REACTIVE"` vs `"PREVENTIVE"` per the
   sample; other values like `"CYCLE_COUNT"` exist per the API
   docs — see Decisions). The MaintainX `/workorders` endpoint
   does NOT support filtering by `type`, so the worker over-
   fetches and buckets in code.

7. **Styling — IN_PROGRESS rows render without a pill.** Operator
   screenshot shows OPEN rows with a blue pill, ON_HOLD with a
   gray pill, but IN_PROGRESS as plain text "In Progress" with no
   background. Likely a `StatusPill.tsx` lookup bug.

This brief addresses all seven in one batch. The architectural fix
(issue 1) collapses two helpers into one, removes the
`pricing_simple` round-trip from the read path, and makes the
page resilient to data-quality gaps in `pricing_simple`. The
permission swap (issue 2) drops the `Session.dcRole` check and
filters purely by email match against `locations`. Grouping
(issue 3) uses MaintainX's own `expand=location.name` data as the
group header — Splash-side data is needed only for the email
filter. Expandable rows (issue 4) borrow Brief 67's
`useState<Set<string>>` pattern. Assignee/team names (issue 5) get
two new Supabase tables synced by a daily cron. Reactive/Preventive
(issue 6) buckets post-fetch by `wo.type`. Status pill (issue 7) is
a one-line render fix.

## Scope

### Phase 1 — New Supabase helper: email → locations rows

1.1 In `packages/db-supabase/src/locations.ts`, add:

```ts
export interface UserAccessibleLocation {
  /** Canonical site key — integer in the locations table. */
  site_number: number;
  /** Postal address — used as a fallback display label
   *  when MaintainX doesn't return location.name. */
  location_address: string | null;
  /** MaintainX location ID; NULL when the location row exists
   *  but isn't yet mapped to MaintainX. */
  maintainx_id: number | null;
  /** Which contact field matched the user's email. Useful for
   *  future audit / debug surfaces; not consumed in v1. */
  matched_via: "am_email" | "rm_email" | "site_email";
}

/**
 * Resolve the set of locations a user has access to, gated by their
 * email being present on `am_email`, `rm_email`, or `site_email`.
 *
 * Single PostgREST GET against `locations` only — no pricing_simple
 * round-trip. The `or=(...)` filter does case-insensitive match;
 * comparison is done lowercase on both sides.
 *
 * Empty input → []. No throw.
 */
export async function getLocationsByContactEmail(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  email: string
): Promise<UserAccessibleLocation[]>
```

  - PostgREST query:
    ```
    GET /rest/v1/locations
        ?or=(am_email.eq.<email>,rm_email.eq.<email>,site_email.eq.<email>)
        &select=site_number,location,maintainx_id,am_email,rm_email,site_email
        &limit=200
    ```
  - Lowercase the input email before forming the filter; the
    `locations` rows store emails as written (mixed case in
    practice). Use `ilike` instead of `eq` if mixed-case rows
    show up in spot checks; `eq` works fine in current data per
    the West Haven sample (`am_email` `"jfrank@splashcarwashes.com"`
    is already lowercase).
  - For each row, determine `matched_via` by checking which of
    the three columns equals the input email; if multiple match
    (rare — would mean one person is GM and AM at the same site),
    pick the first hit in the priority order am_email → rm_email
    → site_email (operator can change this later if it surfaces).
  - Fail-soft: any throw → return `[]`.

1.2 Export from `packages/db-supabase/src/index.ts`.

### Phase 2 — Delete obsolete helpers + their re-exports

2.1 In `packages/db-supabase/src/locations.ts`, **DELETE**:
  - `getMaintainXIdsForLocationCodes`
  - `getLocationCodesByMaintainXIds`
  - `MaintainXLocationInfo` interface (no other consumers)

2.2 In `packages/db-supabase/src/index.ts`, drop the matching
re-exports.

2.3 Confirm `getMaintainXLocationId` (Brief 42 / 62 — the FORWARD
single-lookup used by damage-worker's WO-create path) is **NOT**
deleted. Its consumer is `apps/damage-worker/src/index.ts` and it
works correctly (forward direction has Postgres' implicit
coercion). Search for any other consumer of the deleted helpers
in `apps/` and `packages/` — there should be zero
(`getMaintainXIdsForLocationCodes` and
`getLocationCodesByMaintainXIds` were Brief 70 additions consumed
only by `workorders-worker/src/index.ts`).

### Phase 3 — workorders-worker: rewrite resolution chain + handler

3.1 In `apps/workorders-worker/src/index.ts`:

  - Delete the local `workOrderScopeForSession` helper (the dc_role
    mirror of damage-worker's `damageScopeForSession`).
  - Delete the `DamageScope`-style three-state union and the global
    branch that bypassed the location filter.
  - The handler `getWorkOrdersList` (or whatever Brief 70 named it)
    becomes:

    ```ts
    async function getWorkOrdersList(env: Env, session: Session): Promise<Response> {
      const email = session.email?.trim().toLowerCase();
      if (!email) return jsonError(401, "no session email");

      // Phase 1: resolve user's accessible locations (email match).
      const accessible = await getLocationsByContactEmail(env, email);
      const mappedMxIds = accessible
        .map((l) => l.maintainx_id)
        .filter((n): n is number => n != null);

      if (mappedMxIds.length === 0) {
        // User has zero locations OR all their locations are missing
        // maintainx_id. Return an empty-but-structured response with
        // a hint flag so the page can surface a helpful empty state.
        return json({
          reactive: { groups: [] },
          preventive: { groups: [] },
          fetchedAt: new Date().toISOString(),
          truncated: false,
          accessibleLocationCount: accessible.length,
          mappedLocationCount: 0,
          email
        });
      }

      // Phase 2: fetch MaintainX work orders for those location IDs.
      const result = await fetchMaintainXWorkOrders({
        apiKey: env.MAINTAINX_API_KEY,
        baseUrl: env.MAINTAINX_BASE_URL,
        maintainxLocationIds: mappedMxIds,
        signal: AbortSignal.timeout(8000)
      });
      if (!result.ok) return jsonError(result.status === 0 ? 504 : 502, result.error ?? "MaintainX upstream error");

      // Phase 3: resolve assignee + team names from Supabase cache.
      const userIds = collectAssigneeIdsByType(result.workOrders, "USER");
      const teamIds = collectAssigneeIdsByType(result.workOrders, "TEAM");
      const [users, teams] = await Promise.all([
        userIds.length ? getMaintainXUsersByIds(env, userIds) : Promise.resolve(new Map()),
        teamIds.length ? getMaintainXTeamsByIds(env, teamIds) : Promise.resolve(new Map())
      ]);

      // Phase 4: bucket Reactive vs Preventive, then group by location.
      const buckets = bucketByType(result.workOrders);
      const reactive = groupByLocation(buckets.reactive, users, teams);
      const preventive = groupByLocation(buckets.preventive, users, teams);

      return json({
        reactive: { groups: reactive },
        preventive: { groups: preventive },
        fetchedAt: new Date().toISOString(),
        truncated: result.truncated,
        accessibleLocationCount: accessible.length,
        mappedLocationCount: mappedMxIds.length,
        email
      });
    }
    ```

  - Remove the `unmatchedWorkOrders` array entirely from the
    response shape. Once the worker filters the upstream MX call
    by `locations=<csv of mappedMxIds>`, MaintainX cannot return a
    WO whose locationId isn't in the user's set. There is no
    legitimate "unmapped" bucket for non-admin views.

  - Remove the `scope` field from the response shape (no more
    `global` vs `scoped` distinction — every user is scoped to
    their email-derived location set).

3.2 Helper functions (module-local in `index.ts`):

  - `bucketByType(workOrders): { reactive: WorkOrder[], preventive: WorkOrder[] }`
    - `wo.type === "PREVENTIVE"` → preventive bucket.
    - Everything else (REACTIVE, CYCLE_COUNT, null, anything
      unknown) → reactive bucket.
    - Comment block in the code calls out that the canonical
      filter is `type === "PREVENTIVE"`; if MaintainX adds new
      preventive-flavored types (e.g., `"PREVENTIVE_DAILY"`)
      they'd need to be added here. Consider widening to
      `type?.startsWith("PREVENT")` if the executor confirms
      MaintainX has multiple preventive subtypes.
  - `groupByLocation(workOrders, users, teams): GroupEntry[]`
    - Bucket by `wo.locationId`.
    - Group header (`location_pretty` in the response shape) =
      `wo.location?.name` (from MX `expand=location`) if
      non-null, else "(unknown location)".
    - Sort within group by priority (HIGH=0, MEDIUM=1, LOW=2,
      NONE=3) then `updatedAt` desc.
    - Sort groups alphabetically by header.
    - For each WO, decorate the assignee list with
      `name`/`email` (when found in users/teams Map) or fall
      back to `User #${id}` / `Team #${id}` for missing entries.
  - `collectAssigneeIdsByType(workOrders, type): number[]`
    - Distinct IDs only.

3.3 In `apps/workorders-worker/src/maintainx.ts`:

  - Add `expand=location` (already in Brief 70) ✓
  - Add `expand=assignees` (already in Brief 70) ✓
  - Add `expand=categories` (NEW — surfaces `wo.categories[]`
    so the page can show category badges later if operators ask)
  - The MaintainX `type` field is on the WO body without an
    `expand` (per the sample payload the user pasted), so no
    URL change needed for type bucketing.
  - Drop `expand=thumbnail` if it's currently there but unused
    (the page doesn't render thumbnails today; can re-add later).

### Phase 4 — Schema: maintainx_users + maintainx_teams Supabase tables

4.1 Run via Supabase SQL editor (operator):

```sql
CREATE TABLE IF NOT EXISTS maintainx_users (
  id              INTEGER PRIMARY KEY,
  first_name      TEXT,
  last_name       TEXT,
  full_name       TEXT,
  email           TEXT,
  phone_number    TEXT,
  auth_type       TEXT,
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS maintainx_teams (
  id              INTEGER PRIMARY KEY,
  name            TEXT,
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Read access via the existing service-role key (no RLS by
-- default). If RLS is on for the schema, add a service-role-only
-- read policy:
-- ALTER TABLE maintainx_users ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY service_role_read ON maintainx_users FOR ALL TO service_role USING (true);
-- (mirror for maintainx_teams)
```

`full_name` is denormalized for read-side join speed
(`first_name + " " + last_name` precomputed; null-safe — render
empty string when both halves are null). The cron handler
(Phase 5) is the only writer; the read handler (Phase 3) is the
only reader.

4.2 The brief explicitly does NOT modify the existing 67-row
`locations` table or `pricing_simple` — those stay as-is.

### Phase 5 — Daily cron: MaintainX users + teams sync

5.1 In `apps/workorders-worker/wrangler.toml`, append:

```toml
# Brief 71 — daily MaintainX user/team sync. 11:30 UTC = 6:30 AM
# ET. Runs BEFORE the damage-worker daily summary cron at 13:00
# UTC so any new MaintainX users created overnight propagate to
# Supabase before they could appear as assignees in that day's
# damage-summary email.
[triggers]
crons = ["30 11 * * *"]
```

5.2 In `apps/workorders-worker/src/index.ts`:

  - Convert the default export from `{ fetch }` to
    `{ fetch, scheduled }` (mirrors damage-worker post-Brief 65).
  - Add a `scheduled` handler that calls
    `runMaintainXUserTeamSync(env)` and logs the result.

5.3 New module `apps/workorders-worker/src/sync.ts`:

```ts
export interface SyncResult {
  users: { fetched: number; upserted: number; failed: number };
  teams: { fetched: number; upserted: number; failed: number };
  startedAt: string;
  finishedAt: string;
  errors: string[];
}

/**
 * Fetch all MaintainX users + teams via the paginated /v1/users
 * and /v1/teams endpoints; upsert into Supabase. Fail-soft on
 * partial failures — return aggregate counts + errors[].
 */
export async function runMaintainXUserTeamSync(env: Env): Promise<SyncResult>
```

  - Iterate both endpoints with cursor pagination
    (`?cursor=<nextCursor>` per MaintainX API; sample shape from
    Brief 70's user reference + the operator's sample message).
  - Limit per page: 200 (MaintainX max).
  - Upsert into Supabase via PostgREST `POST` with
    `Prefer: resolution=merge-duplicates` and the `id` PK as the
    conflict target.
  - 30 second total timeout per phase (users, teams) via
    `AbortController`. Partial result is acceptable — log errors
    and continue.
  - `runMaintainXUserTeamSync` is also exported so a manual
    on-demand smoke endpoint can call it (Phase 5.5).

5.4 Sync logic for each user row:

```ts
// MaintainX user payload (per operator sample):
//   { id, firstName, lastName, email, phoneNumber, authType }
// → maintainx_users row:
const fullName = [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || null;
const upsertBody = {
  id: u.id,
  first_name: u.firstName ?? null,
  last_name: u.lastName ?? null,
  full_name: fullName,
  email: u.email ?? null,
  phone_number: u.phoneNumber ?? null,
  auth_type: u.authType ?? null,
  last_synced_at: new Date().toISOString()
};
```

5.5 Manual-trigger endpoint (so the operator can force a sync
without waiting 24h):

```
POST /workorders/api/sync-maintainx-users
```

  - Auth: same email-on-locations gate as
    `GET /workorders/api/list`, PLUS gated to a top-level
    `if (!isAdminEmail(session.email)) return 403`. Define
    `isAdminEmail` as a hardcoded set of operator emails (Josh,
    Noah, Alexandro, Jacob, rwilliams — pulled from CLAUDE.md
    "operator preferences" list). If that gate is too rigid,
    fall back to checking `session.dcRole === "super_admin"`
    only (read this off `Session.dcRole` even though we're not
    using it for the page itself — it's still populated and
    valid as a one-off admin fence here).
  - Returns `SyncResult` JSON with the same shape as the
    scheduled handler logs.

### Phase 6 — Read-side helpers for user/team name lookup

6.1 In `packages/db-supabase/`, add a new module
`packages/db-supabase/src/maintainx-users.ts`:

```ts
export interface MaintainXUserRow {
  id: number;
  full_name: string | null;
  email: string | null;
}
export interface MaintainXTeamRow {
  id: number;
  name: string | null;
}

/**
 * Bulk lookup MaintainX users by ID. Returns a Map for O(1) join
 * in the WO list handler. Missing IDs simply don't appear.
 */
export async function getMaintainXUsersByIds(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  ids: number[]
): Promise<Map<number, MaintainXUserRow>>;

export async function getMaintainXTeamsByIds(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  ids: number[]
): Promise<Map<number, MaintainXTeamRow>>;
```

  - PostgREST query for users:
    `?id=in.(<csv>)&select=id,full_name,email&limit=500`
  - PostgREST query for teams:
    `?id=in.(<csv>)&select=id,name&limit=500`
  - Empty input → empty Map. No throw.

6.2 Export both from `packages/db-supabase/src/index.ts`.

6.3 Upsert helpers (used by the cron sync) — colocate in
`maintainx-users.ts`:

```ts
export async function upsertMaintainXUsers(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  rows: Array<MaintainXUserRow & {
    first_name: string | null;
    last_name: string | null;
    phone_number: string | null;
    auth_type: string | null;
    last_synced_at: string;
  }>
): Promise<{ upserted: number; errors: string[] }>;

export async function upsertMaintainXTeams(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  rows: Array<MaintainXTeamRow & { last_synced_at: string }>
): Promise<{ upserted: number; errors: string[] }>;
```

  - PostgREST upsert: `POST /rest/v1/maintainx_users` with header
    `Prefer: resolution=merge-duplicates,return=minimal`,
    `?on_conflict=id`. Body is the array.
  - Batch size: 500 rows per POST. Iterate.

### Phase 7 — apps/web page rewrite

7.1 Update the response-shape type in
`apps/web/app/workorders/_lib/worker-fetch.ts` to mirror Phase
3.1's new shape (`reactive: { groups: [...] }`,
`preventive: { groups: [...] }`, no more `scope` field, no more
`unmatchedWorkOrders`).

7.2 Convert `apps/web/app/workorders/page.tsx` to a server
component that fetches the new shape and passes BOTH buckets
to a single new client component
`apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`.

7.3 New client component
`apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`:

  - `"use client"` directive.
  - Props: `{ reactive: GroupEntry[], preventive: GroupEntry[],
    fetchedAt: string, accessibleLocationCount: number,
    mappedLocationCount: number, truncated: boolean }`.
  - `useState<"reactive" | "preventive">("reactive")` — tab state.
  - `useState<Set<string>>(() => new Set())` — expanded WO IDs
    (mirrors Brief 67's pattern). Key is `wo.id.toString()`.
    Tab change does NOT clear the expanded set — operator can
    flip tabs and keep expansions; the keys are unique across
    both buckets so there's no collision risk.
  - Renders:
    - Pill-tab nav at top: "Reactive (N)" / "Preventive (N)"
      with the active tab's count populated.
    - Active tab's groups rendered as before (sections grouped
      by location, table inside each section).
    - Each row is now click-to-expand: clicking the row toggles
      the WO ID in the expanded set; expansion renders a
      sub-row beneath with full description, created date
      (formatted `YYYY-MM-DD`), age in days
      (`Math.floor((now - createdAt) / 86400000)`), assignee
      list with names, and the categories array as small
      badges.
    - Visual affordance for collapsed vs expanded — a chevron
      icon on the left edge that rotates 90° on expand
      (Tailwind `rotate-90 transition-transform`).
    - Empty-state fallback: if both buckets are empty AND
      `mappedLocationCount === 0`, render a helpful copy
      indicating either no email match OR no maintainx_id
      mapped to the user's locations:
      ```
      "No work orders to show.
       Possible reasons:
       1. Your email isn't on `am_email`, `rm_email`, or
          `site_email` for any location — ask a super_admin
          to update via the sysadmin Update Location editor.
       2. Your locations aren't yet mapped to MaintainX
          (locations.maintainx_id is null) — same fix path."
      ```
    - "Truncated" banner if `truncated === true` (operator hits
      the 200-WO ceiling — log into MaintainX for the full
      list).
    - "As of {fetchedAt}" timestamp in muted small text in the
      header area (existing copy from Brief 70).

7.4 Update `apps/web/app/workorders/_components/StatusPill.tsx`
to render the IN_PROGRESS pill with an amber background:

```tsx
const STATUS_CLASSES = {
  OPEN:        "bg-blue-100 text-blue-800",
  IN_PROGRESS: "bg-amber-100 text-amber-800",
  ON_HOLD:     "bg-gray-100 text-gray-800"
} as const;

const STATUS_LABELS = {
  OPEN:        "Open",
  IN_PROGRESS: "In Progress",
  ON_HOLD:     "On Hold"
} as const;
```

  - The Brief 70 bug: likely STATUS_CLASSES was keyed on the
    humanized label `"In Progress"` rather than the API value
    `IN_PROGRESS`. Fix is to key consistently on the upstream
    enum value.

7.5 Drop the "Unmapped MaintainX locations" section + table
entirely from the page — that data path no longer exists.

### Phase 8 — wrangler.toml + observability

8.1 Confirm the `[observability.logs]` block is still present in
`apps/workorders-worker/wrangler.toml` (Brief 70 added it). The
new `[triggers]` block doesn't replace observability — both
coexist.

8.2 The cron's invocations show up in Workers Logs with
`eventType: scheduled` (vs `fetch` for the read endpoint),
matching the Brief 65 pattern called out in CLAUDE.md.

### Phase 9 — CLAUDE.md updates

9.1 Glossary entry for "Work Orders" — overwrite Brief 70's
entry to reflect:
  - Permission domain: email-on-locations match (am_email /
    rm_email / site_email), NOT dc_role. Note explicitly that
    super_admin and admin do NOT have a global override.
  - Reactive / Preventive split via `wo.type === "PREVENTIVE"`.
  - Daily MaintainX user/team sync at 11:30 UTC; on-demand
    sync endpoint at `POST /workorders/api/sync-maintainx-users`.

9.2 In the "Working with workers" section under
workorders-worker, update the dependency note:
  - `MAINTAINX_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
    `SUPABASE_SERVICE_KEY` (4 secrets — `SUPABASE_URL` is also
    a secret, mirroring damage-worker).
  - New `[triggers] crons = ["30 11 * * *"]` cron handler for
    daily user/team sync.

9.3 New entry under "Critical constraints":
  - **`maintainx_users` and `maintainx_teams` Supabase tables
    are read-only from worker code except for the daily
    sync handler.** Manual SQL edits to these tables get
    overwritten on the next sync. To change a user's
    metadata, change it in MaintainX itself; the next
    sync (within 24h) propagates.

### Phase 10 — BUILD_STATE.md + INDEX.md + QUEUE.md

10.1 BUILD_STATE.md:
  - Bump "Last updated" to today's date.
  - New row in "Open work — prioritized" for Brief 71.
  - New "Findings & decisions log" entry covering all seven
    issues + resolutions.
  - Note the Brief 70 → Brief 71 architecture pivot
    (dc_role → email-on-locations).

10.2 INDEX.md: append Brief 71 row.

10.3 QUEUE.md: append the brief filename so the orchestrator
picks it up.

### Phase 11 — Validation

11.1 `pnpm typecheck` — must pass for all 14 packages.

11.2 `pnpm --filter @splash/web build` — must succeed; bundle
delta on `/workorders` route documented in Outcome.

11.3 `pnpm --filter @splash/workorders-worker exec wrangler
deploy --dry-run --outdir=.tmp-build-wo` — must succeed; cron
trigger appears in the dry-run binding table (or warn if it
doesn't — wrangler's dry-run output for triggers varies by
version).

11.4 No D1 schema change (workorders-worker has no D1
binding). Two new Supabase tables — operator runs the SQL
manually before/after deploy; they're additive (no impact
on existing reads).

11.5 Live smoke-test checklist for operator (post-deploy):
  - (a) Navigate to `/workorders` while logged in as a user
    with email matching at least one `am_email`/`rm_email`/
    `site_email`. Confirm the Reactive tab populates with
    grouped results.
  - (b) Click a row — confirm expansion shows description,
    created date, age in days.
  - (c) Click the Preventive tab — confirm Avery Frank's
    creates show up here (and only here).
  - (d) Confirm assignees render with names, not just IDs.
  - (e) Click an "Open in MaintainX" row link — confirm it
    lands on the right WO in MaintainX.
  - (f) Trigger the manual sync endpoint via curl + a
    super_admin cookie; confirm the response has nonzero
    `users.upserted` and `teams.upserted` counts. (First
    run pulls the entire MaintainX user/team set; subsequent
    runs are no-op upserts.)
  - (g) After the sync completes, reload `/workorders` and
    confirm assignee names appear (they may have shown as
    `User #N` on first load before the sync ran).

## Configuration

No new env vars or secrets. The four bound on
`splash-workorders` (SUPABASE_URL, SUPABASE_ANON_KEY,
SUPABASE_SERVICE_KEY, MAINTAINX_API_KEY) cover everything this
brief adds.

Operator step BEFORE deploy: run the Phase 4.1 SQL in Supabase to
create the two new tables. No data backfill needed — the first
cron run (or manual `POST /workorders/api/sync-maintainx-users`)
populates them.

Operator step AFTER deploy: trigger the manual sync endpoint once
to populate the tables immediately rather than waiting for the
11:30 UTC cron. Curl with a super_admin session cookie:

```powershell
$cookie = "sb-access-token=<from DevTools>"
$url    = "https://splash-workorders.<acct>.workers.dev/workorders/api/sync-maintainx-users"
Invoke-WebRequest -Uri $url -Method POST -Headers @{ Cookie = $cookie }
```

## Out of scope

- Backfilling MaintainX work-order history (closed/done WOs).
  v1 stays read-only on currently-active statuses.
- Editing or commenting on work orders from Splash UI.
  MaintainX itself is the canonical edit surface.
- Surfacing thumbnails. Brief 70 added `expand=thumbnail`; this
  brief drops it. Re-add later if operators ask.
- Surfacing categories beyond the expanded-row badge area.
  Filtering by category is a future enhancement.
- Adding a `display_name` column to `locations` for cleaner
  group headers. Use MaintainX's `expand=location.name` for
  v2; revisit if operators dislike MaintainX's naming.
- Per-user sync opt-out (paused account etc.) — not needed.
- Pagination of the WO list beyond MaintainX's 200-cap. Same
  posture as Brief 70 — surface a `truncated` flag and let
  operators follow the link to MaintainX for the full list.
- Email-on-locations gate also being applied retroactively to
  damage tooling. Damage tooling stays on dc_role. This brief
  scopes only the workorders surface.
- Don't deploy from headless. Operator pushes; CF Builds
  auto-deploys workorders-worker (Brief 70 wired this) and
  apps/web.
- Don't bind production routes. The cutover routes block in
  workorders-worker stays commented.
- Don't commit to git or push.

## Definition of done

- `getLocationsByContactEmail` exists in
  `packages/db-supabase/src/locations.ts`; exported from
  `packages/db-supabase/src/index.ts`
- `getMaintainXIdsForLocationCodes` and
  `getLocationCodesByMaintainXIds` are deleted, including their
  re-exports
- `getMaintainXLocationId` (Brief 42 / 62 forward helper) is
  unchanged and still exported
- `packages/db-supabase/src/maintainx-users.ts` exists with
  `getMaintainXUsersByIds`, `getMaintainXTeamsByIds`,
  `upsertMaintainXUsers`, `upsertMaintainXTeams`
- `apps/workorders-worker/src/sync.ts` exists with
  `runMaintainXUserTeamSync`
- `apps/workorders-worker/src/index.ts` default export is
  `{ fetch, scheduled }`; scheduled handler calls
  `runMaintainXUserTeamSync`; manual sync endpoint
  `POST /workorders/api/sync-maintainx-users` exists with
  super_admin gate
- `apps/workorders-worker/wrangler.toml` has
  `[triggers] crons = ["30 11 * * *"]`
- `apps/workorders-worker/src/maintainx.ts` adds
  `expand=categories`; drops `expand=thumbnail`
- The `getWorkOrdersList` handler in
  `apps/workorders-worker/src/index.ts` uses pure email-on-
  locations gating, no dc_role; response shape has `reactive`
  / `preventive` keyed buckets and no `unmatchedWorkOrders`
- The Supabase SQL for `maintainx_users` + `maintainx_teams`
  is documented in the Outcome section so the operator can
  run it (or has been run by the operator, with confirmation)
- `apps/web/app/workorders/_lib/worker-fetch.ts` types match
  the new response shape
- `apps/web/app/workorders/page.tsx` passes both buckets to
  the new `WorkOrdersTabsClient`
- `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`
  exists with tab + expand state
- `apps/web/app/workorders/_components/StatusPill.tsx` keys on
  enum values; IN_PROGRESS renders with amber pill
- The "Unmapped MaintainX locations" section is removed from
  the page
- pnpm typecheck passes for all 14 packages
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/workorders-worker exec wrangler deploy
  --dry-run succeeds (cron trigger present in the binding
  output where applicable)
- BRIEFS/INDEX.md, BRIEFS/QUEUE.md, BUILD_STATE.md, CLAUDE.md
  updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Files created (~3-4: WorkOrdersTabsClient.tsx, sync.ts,
  maintainx-users.ts, possibly index.ts re-export edit)
- Files modified (~10: locations.ts, page.tsx,
  worker-fetch.ts, StatusPill.tsx, index.ts (worker), wrangler.toml,
  maintainx.ts, db-supabase/index.ts, CLAUDE.md, BUILD_STATE.md)
- Files deleted: zero (the obsolete helpers are deleted as
  exports / function bodies, not as whole files)
- Bundle deltas:
  - workorders-worker (uncompressed + gzip)
  - apps/web `/workorders` route (kB First Load JS) — expect
    a small increase from converting page to a client wrapper +
    the expand state machinery
- Empirical confirmation:
  - The Brief 70 zero-padding diagnosis (West Haven case) is
    sidestepped, not patched — the new path doesn't query
    `pricing_simple` at all. Confirm via spot-check log of
    `getLocationsByContactEmail` returning the West Haven row
    for `jfrank@splashcarwashes.com`.
  - The `wo.type` field's actual values in production —
    document any unexpected values (other than REACTIVE /
    PREVENTIVE / CYCLE_COUNT) so the bucketing rule can be
    reviewed.
- Validation results
- Decisions made on the operator's behalf
- Latent issues / forward flags
- Operator action items: SQL run, manual sync endpoint hit
  post-deploy

## Outcome

### Files created (3)

- `packages/db-supabase/src/maintainx-users.ts` — Supabase read +
  upsert helpers for the new `maintainx_users` and `maintainx_teams`
  cache tables. Exports: `getMaintainXUsersByIds`,
  `getMaintainXTeamsByIds`, `upsertMaintainXUsers`,
  `upsertMaintainXTeams`, plus row + upsert-row interfaces.
- `apps/workorders-worker/src/sync.ts` — `runMaintainXUserTeamSync(env)`.
  Cursor-paginated GET against MaintainX `/v1/users` and `/v1/teams`,
  30s per-phase timeout, batch-upsert into Supabase via
  `Prefer: resolution=merge-duplicates`, fail-soft per page; returns
  a `SyncResult` with `users` / `teams` phase stats + `errors[]`.
- `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx` —
  `"use client"` component. `useState<TabKey>` for Reactive vs
  Preventive tab + `useState<Set<string>>` for expanded WO IDs
  (mirrors Brief 67's `ByLocationTableClient` pattern). Renders
  pill-tab nav with bucket counts, per-location group sections,
  click-to-expand rows with a description / created / age /
  assignees / categories drawer. Owns the no-access + per-bucket
  empty states inline.

### Files modified (10)

- `packages/db-supabase/src/locations.ts` — added
  `getLocationsByContactEmail(env, email)` and the
  `UserAccessibleLocation` interface (single PostgREST GET against
  `locations` with `or=(am_email.eq.,rm_email.eq.,site_email.eq.)`,
  fail-soft, returns `[]` on any throw / non-2xx). Deleted Brief 70's
  `getMaintainXIdsForLocationCodes` + `getLocationCodesByMaintainXIds`
  + `MaintainXLocationInfo` interface + the supporting
  `LOCATION_CODE_RE` / `escapeForInClause` module-locals (~210 lines
  total). `getMaintainXLocationId` (Brief 42 / 62 forward helper used
  by damage-worker) untouched.
- `packages/db-supabase/src/index.ts` — added
  `export * from "./maintainx-users.js"`. The deleted helpers were
  re-exported via `export * from "./locations.js"`, so their removal
  propagates automatically with no further edits here.
- `apps/workorders-worker/src/index.ts` — full rewrite. Default
  export switched from `{ fetch }` to `{ fetch, scheduled }`.
  Removed `workOrderScopeForSession` dc_role helper, `WorkOrderScope`
  union, and the global vs scoped branching. Removed
  `unmatchedWorkOrders` / `missingMaintainxIds` / `scope` from the
  response shape. Added `bucketByType` (PREVENTIVE → preventive,
  everything else → reactive), `collectAssigneeIdsByType`,
  `groupByLocation` helpers. Assignee projection now emits
  `{ id, type, name, email }` joined through the Supabase cache
  Maps. New `POST /workorders/api/sync-maintainx-users` endpoint
  super_admin-gated via hardcoded email allow-list +
  `session.dcRole === "super_admin"` fallback. Scheduled handler
  uses `ctx.waitUntil` to run `runMaintainXUserTeamSync` and logs
  the result.
- `apps/workorders-worker/src/maintainx.ts` — `RawWorkOrder` gains
  `type?: string | null` (with docblock noting the Brief 71 bucket
  rule) and `assignees[].type` field. `expand=categories` added;
  `expand=thumbnail` removed; `thumbnail` / `thumbnailUrl` fields
  removed from `RawWorkOrder`.
- `apps/workorders-worker/wrangler.toml` — header docblock updated
  to call out the email-on-locations gate; new
  `[triggers] crons = ["30 11 * * *"]` block (11:30 UTC, fires
  before damage-worker's 13:00 UTC summary cron). Brief 63
  `[observability.logs]` block preserved.
- `apps/web/app/workorders/_lib/worker-fetch.ts` — response-shape
  types regenerated to match the new server shape. Removed
  `WorkOrdersGroup.location_code`, `UnmatchedWorkOrder`,
  `WorkOrdersListResponse.scope`, `missingMaintainxIds`,
  `unmatchedWorkOrders`. Added `WorkOrderItem.type`,
  `WorkOrderItem.locationId`, `WorkOrdersBucket`,
  `WorkOrdersListResponse.{reactive, preventive,
  accessibleLocationCount, mappedLocationCount, email}`.
- `apps/web/app/workorders/page.tsx` — rewritten as a thin shell.
  Fetches via `fetchWorkOrdersList`, hands both buckets to
  `WorkOrdersTabsClient`. Removed `MissingMappingWarning`,
  `UnmatchedSection`, `GroupSection`, `WorkOrderRow`, and the inline
  `formatRelativeTime` helper (moved to the client component).
  No-access copy reframed as "you aren't signed in" because dc_role
  is no longer load-bearing.
- `apps/web/app/workorders/_components/StatusPill.tsx` — lookup keys
  on `(status ?? "").trim().toUpperCase()` to defend against case-
  variant MaintainX inputs. `IN_PROGRESS` rendered with
  `bg-amber-100 text-amber-900` for sharper visual distinction.
  Header docblock extended.
- `CLAUDE.md` — new constraint #8 covering the
  `maintainx_users` / `maintainx_teams` read-only-from-worker-code-
  except-sync rule. Workorders-worker endpoints entry rewritten to
  reflect email-on-locations gate, new `POST /sync-maintainx-users`
  endpoint, `{ fetch, scheduled }` shape, Reactive/Preventive
  bucketing rule, and group-header preference. Glossary "Work
  Orders" entry rewritten end-to-end.
- `BUILD_STATE.md` — Last-updated bumped, Brief 71 row appended to
  the prioritized work list, comprehensive Findings entry added.

### Files deleted (1)

- `apps/web/app/workorders/_components/EmptyState.tsx` — Brief 70
  component, no longer imported. `WorkOrdersTabsClient` owns its
  own no-access / no-bucket empty states inline.

### Operator action items

1. **Run the Phase 4.1 SQL in Supabase** before deploy (additive; no
   impact on existing reads):

   ```sql
   CREATE TABLE IF NOT EXISTS maintainx_users (
     id              INTEGER PRIMARY KEY,
     first_name      TEXT,
     last_name       TEXT,
     full_name       TEXT,
     email           TEXT,
     phone_number    TEXT,
     auth_type       TEXT,
     last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   );

   CREATE TABLE IF NOT EXISTS maintainx_teams (
     id              INTEGER PRIMARY KEY,
     name            TEXT,
     last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   ```

   If RLS is enabled on the schema, also add a service-role-only
   read policy on each table.

2. **Hit the manual sync endpoint immediately after deploy** to
   populate the tables rather than waiting for the 11:30 UTC cron:

   ```powershell
   $cookie = "sb-access-token=<from DevTools>"
   $url    = "https://splash-workorders.<acct>.workers.dev/workorders/api/sync-maintainx-users"
   Invoke-WebRequest -Uri $url -Method POST -Headers @{ Cookie = $cookie }
   ```

3. **Live smoke-test checklist** (post-deploy):
   - Navigate to `/workorders` while signed in as a user with email
     matching at least one `am_email` / `rm_email` / `site_email`.
     Confirm the Reactive tab populates with grouped + sorted
     results.
   - Click a row — confirm the expansion drawer shows description,
     created date, age in days, assignee names, and category badges.
   - Click the Preventive tab — confirm Avery Frank's WOs (the
     operator's preventive-bucket reference set) appear here and
     only here.
   - Confirm assignee names render as actual names (not `User #N`)
     after step 2 has run.
   - Click an "Open ↗" row link — confirm it lands on the right WO
     in MaintainX.
   - Reload the page — confirm `As of …` timestamp updates.

### Decisions made on operator's behalf

1. **Manual sync endpoint gate** = hardcoded email allow-list AND a
   `session.dcRole === "super_admin"` fallback (per the brief's
   recommendation). Both must individually permit the request, but
   either passing is sufficient — the email list is the
   tighter-but-fragile signal, dcRole is the looser-but-stable one.
2. **Group header preference** = MaintainX's `expand=location.name`
   first, then Splash-side `locations.location` (postal address) as
   the fallback, then `"(unknown location)"`. Postal-address
   fallback is a small extension beyond the brief's spec; defends
   against MX returning `location: { id, name: null }`.
3. **Header upgrade pass within `groupByLocation`** — if a later WO
   in the same MX-location bucket carries a non-null MX-side name
   while the bucket header was set to the postal-address fallback,
   upgrade the header. Defends against the first-WO-of-the-bucket
   having a null name.
4. **`bucketByType` strict-equality filter** — `wo.type ===
   "PREVENTIVE"` exclusively. Comment block calls out the upgrade
   path (`type?.startsWith("PREVENT")`) if MaintainX adds new
   preventive subtypes.
5. **`getLocationsByContactEmail` uses `eq` not `ilike`** — current
   data in `locations` stores lowercase emails per the West Haven
   spot check; the helper's docblock documents the switch path if
   mixed-case rows appear later.
6. **`matched_via` priority** = `am_email` → `rm_email` →
   `site_email` (per the brief).
7. **Sync endpoint pagination** — 100-page protective cap (= 20k
   upper bound at 200/page) to defend against infinite loops if
   MaintainX returns an unexpected envelope.
8. **`Prefer: resolution=merge-duplicates,return=minimal`** on
   upserts — empty response body for faster + smaller logs.
9. **`assignees[].type` read directly off the WO body** without an
   `expand` parameter (matches the operator's MX sample).
10. **`expanded` set persists across tab flips** — keys are
    `String(wo.id)` and unique across both buckets.
11. **`StatusPill` lookup is now case-insensitive** — defense-in-
    depth against MX returning case-variant statuses; addresses the
    Brief 70 IN_PROGRESS rendering issue at the input-normalization
    layer rather than only at the keys.
12. **No-access copy points at sysadmin Update Location editor** as
    the canonical fix path for both "missing email" and "missing
    maintainx_id" failures (per the brief).
13. **`ExpandedRow` shows description-or-placeholder** rather than
    omitting the field when null.
14. **Categories rendered as small badges in the drawer**, not as a
    table column — keeps the row scannable.
15. **`isSyncTriggerAllowed` reads `session.dcRole`** even though
    the rest of the read path doesn't — the field is still
    populated and valid, and this is a one-off admin fence per the
    brief's recommendation.
16. **Old `EmptyState.tsx` deleted** — Brief 70 component, no
    consumer post-rewrite. CLAUDE.md guidance: "If you are certain
    that something is unused, you can delete it completely."
17. **Scheduled handler uses `ctx.waitUntil`** so the sync completes
    even if the cron-event loop returns early; matches damage-
    worker post-Brief 65.
18. **Sync runs synchronously inside the request** — the 30s
    `PHASE_TIMEOUT_MS` per phase + 100-page protective cap keep
    total wall-clock under CF Workers' 30s default request timeout
    even with two phases (users + teams).

### Latent issues / forward flags

- **Tables must exist before the read endpoint is useful.** The
  read path silently renders `User #N` / `Team #N` for every
  assignee until the operator runs the SQL + first sync. Empty
  tables don't break anything; they just mean the join produces
  zero hits.
- **MaintainX cursor pagination empirically untested in headless.**
  The sync helper handles `nextCursor` and the URL-based
  `nextPageUrl` envelope, but the actual MX response shape isn't
  formally locked in repo yet. If MX returns an unexpected envelope
  the sync stops on page 0 and surfaces a clear
  `"users page 0 returned ${status}: ${body}"` error in the
  `SyncResult.errors[]` array (visible in CF Workers Logs).
- **`assignees[].email`** in the WO list response is a defense-in-
  depth bonus — the page renders names today, but a future row-
  action surface (e.g. "email this assignee") could consume it
  directly without another sync round.
- **`UserAccessibleLocation.matched_via`** is unused by v1 rendering
  but persisted in the wire shape for an audit/debug surface later.
- **No `accessibleLocationCount` < `mappedLocationCount` empty
  state.** A user with N accessible locations but zero
  maintainx_id mappings sees the same "no work orders to show"
  copy as a user with zero accessible locations — distinguished
  in the copy text ("possible reasons: 1, 2") so the operator can
  self-diagnose.
- **`getMaintainXLocationId` forward helper is unchanged** and
  still consumed by damage-worker's WO-create path. The deletion
  was strictly the BULK helpers.
- **`bucketByType` rule is in code, not config** — adding new
  MaintainX types requires a code change. Comment block flags the
  upgrade path.
- **`StatusPill` defaults to ON_HOLD styling on unknown statuses.**
  If MX adds a new active status the new value renders with gray
  pill + raw label until the helper is extended.
- **`isSyncTriggerAllowed` falls back to `session.dcRole`** — that
  field is still populated and valid even though the rest of the
  read path no longer consumes it; treating it as a one-off admin
  fence here matches the brief's recommendation.

### Validation results

- `pnpm typecheck` — **14/14 packages green** (initial run flagged a
  `ScheduledEvent` vs `ScheduledController` type mismatch in the
  `scheduled` handler signature; corrected in one line —
  `_event: ScheduledEvent` → `_controller: ScheduledController` —
  per `ExportedHandlerScheduledHandler` definition. Re-run: 14/14
  green in 6.2s, 9 cached + 5 ran fresh.).
- `pnpm --filter @splash/web build` — **succeeded** in 4.1s. Next
  15.5.15 emitted 16 routes; `/workorders` route bundles to **3.1
  kB / 105 kB First Load JS** (vs Brief 70's 131 B / 102 kB — the
  `WorkOrdersTabsClient` client island is the new client weight).
- `pnpm --filter @splash/workorders-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build-wo` — **succeeded**. Bundle:
  **729.89 KiB uncompressed / 138.84 KiB gzip** (vs Brief 70's
  724.79 KiB / 137.59 KiB — net **+5.10 KiB / +1.25 KiB gzip** for
  the sync.ts module + maintainx-users helpers + new bucket/group
  logic). Wrangler dry-run output for triggers varies by version
  (per the brief's caveat); the `[triggers]` block parses cleanly
  but isn't echoed in the bindings table.
- **No D1 schema change** (workorders-worker has no D1 binding).
- **Two new Supabase tables** — operator runs the SQL manually
  before/after deploy; they're additive (no impact on existing
  reads).

### Empirical observations / forward telemetry

- Brief 70's zero-padding diagnosis (West Haven case) is sidestepped,
  not patched — the new path doesn't query `pricing_simple` at all.
  Operator can confirm via spot-check by signing in as a user with
  `jfrank@splashcarwashes.com` on `am_email` and verifying West
  Haven appears in the Reactive tab grouping.
- The `wo.type` field's actual value distribution across MaintainX
  responses is undocumented in headless — operator should note any
  unexpected values (other than REACTIVE / PREVENTIVE / CYCLE_COUNT)
  during the first staging review so the bucketing rule can be
  reviewed if MaintainX has subtypes the brief didn't anticipate.
