# Brief 30: Sysadmin UX overhaul - two-mode hub + filterable audit log

**Status:** Completed (2026-05-05)
**Started:** 2026-05-05
**Completed:** 2026-05-05
**Blocks:** Sysadmin page is now an 8-card flat list (Briefs 7 + 24
+ 26 + 27). Operator wants this re-organized into a two-mode hub
(Manage Users / Manage Tables) and the page-banner blurb about
sysadmin_audit_log replaced with the actual log surfaced inline,
filterable by actor / action / table / user / location.
**Dependencies:** Brief 7 (sysadmin page shell + ActionForm pattern),
Brief 18 (UserPicker for filtering by user), Brief 24/26/27 (the
table-management cards being grouped).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-007-sysadmin-ui.md (Outcome - the original 5-card
  layout + PageBanner copy that this brief rewrites)
- BRIEFS/brief-024-sysadmin-add-location.md
- BRIEFS/brief-026-sysadmin-update-package.md
- BRIEFS/brief-027-sysadmin-update-location.md
- apps/web/app/admin/sysadmin/page.tsx (8 cards + PageBanner; the
  layout this brief restructures)
- apps/web/app/admin/sysadmin/actions.ts
- apps/web/app/admin/sysadmin/_lib/worker-fetch.ts
- apps/web/app/admin/sysadmin/_components/UserPicker.tsx (reuse for
  the audit log's user filter)
- apps/sysadmin-worker/src/index.ts (existing handler dispatch +
  audit log writes - this brief adds a read endpoint)
- packages/db-supabase/src/audit.ts (SysadminAuditEntry shape +
  logSysadminAudit; the row shape this brief reads back)

## Context

The sysadmin page has grown organically: Brief 7 landed 5 user-mgmt
cards, Briefs 24/26/27 added 3 table-mgmt cards. The flat 8-card
list works but no longer maps to a clean mental model - users are
either editing PEOPLE (auth.users / user_permissions /
user_tool_access) or editing TABLES (pricing_simple / locations).
Operator wants those two concerns visually separated.

The page banner currently says:
> "Super-admin user management. Each operation posts directly to
> sysadmin-worker; every successful mutation writes a row to
> `sysadmin_audit_log`."

That last sentence is meta-commentary about the implementation; the
actual audit log content has never been surfaced in the UI. Operator
wants the explanatory text cut and the log itself rendered (and
filterable) on the page.

Audit log row shape (from `packages/db-supabase/src/audit.ts` +
inferred `id` + `created_at` Postgres-side defaults):

```
sysadmin_audit_log
  id           bigint / uuid (PK; whatever Supabase set up)
  created_at   timestamptz
  actor_id     uuid (auth.users.id)         nullable for system entries
  actor_email  text                         "system" placeholder when null actor
  action       text                         e.g. "grant_tool", "create_user",
                                            "set_role_super_admin", "clear_role",
                                            "reset_password", "create_location",
                                            "update_package", "update_location",
                                            "*_noop" suffixes for idempotent ops
  target_type  text                         "user_permissions" | "user_tool_access"
                                            | "auth.users" | "pricing_simple"
                                            | "locations"
  target_id    text                         user_id (UUID) | composite "code/pkg"
                                            | location_code | location id
  before       jsonb                        nullable
  after        jsonb                        nullable
  notes        text                         nullable
```

## Scope

### Part A - Worker side: new GET endpoint for the audit log

A.1 Add **GET `/sysadmin/api/audit-log`** to
`apps/sysadmin-worker/src/index.ts`:

  - super_admin gate (top-level fetch).
  - No isOriginAllowed gate on GET (browsers omit Origin on
    same-origin GETs; per Brief 11b convention).
  - Query string filters (all optional, AND-combined):
    - `actor` - substring match (ilike) on `actor_email`
    - `action` - exact match on `action` (the worker's allowed list
      below; reject unknown values with 400 to keep the URL space
      tight)
    - `table` - exact match on `target_type` (allowed list below)
    - `user_id` - exact match on `target_id` when `target_type` is
      `user_permissions`, `user_tool_access`, or `auth.users`. Worker
      should add a constraint that combines:
      `target_type=in.(user_permissions,user_tool_access,auth.users)`
      AND `target_id=eq.{user_id}`. (PostgREST supports `and()` /
      `or()` composition; mirror the Brief 18 sanitization.)
    - `location_code` - matches when `target_type=in.(pricing_simple,
      locations)` AND
      (`target_id=eq.{location_code}` OR `target_id=ilike.{code}/%`)
      - the second arm catches Brief 26's composite IDs like
      `binghamton/bath` where the location_code is the prefix.
    - `since` - ISO-8601 timestamp; `created_at>=since` lower bound.
      Optional; if omitted, no lower bound.
    - `until` - ISO-8601 timestamp; `created_at<=until` upper bound.
    - `limit` - positive integer, default 50, max 200.
    - `offset` - non-negative integer, default 0, for pagination.
  - Allowed `action` values (validate against this list):
    `create_user`, `set_role_super_admin`, `set_role_location_admin`,
    `clear_role`, `grant_tool`, `grant_tool_noop`, `revoke_tool`,
    `revoke_tool_noop`, `reset_password`, `create_location`,
    `update_package`, `update_location`. New action strings
    introduced by future briefs should be added to this list when
    those briefs land; flag any unknown action string seen in the
    DB during testing (might mean a forgotten action or a typo).
  - Allowed `target_type` values: `user_permissions`,
    `user_tool_access`, `auth.users`, `pricing_simple`, `locations`.
  - Sanitize all string filters per the existing search pattern
    (drop `,`, `(`, `)`, `*`, `%`, `_` for fields used in `ilike` /
    `or()`; UUID + ISO-8601 fields can be regex-validated and
    rejected on shape mismatch).
  - Order: `created_at.desc` (newest first).
  - Response shape:
    ```ts
    interface AuditLogResponse {
      rows: AuditLogRow[];
      total_estimate: number | null;  // pulled from PostgREST's
                                       // Content-Range header when
                                       // Prefer: count=estimated is
                                       // sent; nullable on miss.
      next_offset: number | null;     // offset + rows.length, or
                                       // null when fewer rows
                                       // returned than `limit`.
    }
    interface AuditLogRow {
      id: string | number;
      created_at: string;             // ISO-8601 UTC
      actor_id: string | null;
      actor_email: string;
      action: string;
      target_type: string;
      target_id: string | null;
      before: unknown;
      after: unknown;
      notes: string | null;
    }
    ```
  - Return `{ rows: [], total_estimate: null, next_offset: null }`
    on no matches; never 404.

A.2 Helper in `packages/db-supabase` is optional. Inline raw fetch
mirrors Brief 26/27. If a typed helper feels worth it, add
`searchAuditLog(client, filters) -> AuditLogRow[]`. Don't over-
abstract.

A.3 No audit-log entry for the audit-log read itself. Reading the log
is a read-only super_admin observation; logging reads would create
a feedback loop and add noise.

### Part B - apps/web: layout restructure

B.1 New PageBanner copy (`apps/web/app/admin/sysadmin/page.tsx`):

  - Eyebrow: "Internal Tools" (unchanged)
  - Title: "System Admin" (unchanged)
  - Subtitle: replace the current paragraph with:
    > "Manage users and tables, with full activity history below."
  - Drop the `<code>sysadmin_audit_log</code>` reference, the
    "posts directly to sysadmin-worker" sentence, and the meta-
    commentary entirely.

B.2 Mode picker - two large buttons at the top of the operations
section. Selected mode determines which set of cards renders:

  - **Manage Users** (default selected on first load):
    - Create user
    - Set role
    - Grant tool
    - Revoke tool
    - Reset password
  - **Manage Tables**:
    - Add location (Brief 24)
    - Update package (Brief 26)
    - Update location (Brief 27)

  Implementation options (pick one; simpler is better):

  - **Option A (preferred):** URL search-param-driven. Page reads
    `searchParams.mode` (default "users"). Mode picker is two
    `<Link>` elements that set `?mode=users` / `?mode=tables`.
    Selected mode gets a visual treatment (active background,
    aria-current). No client state. No JS. Plays nicely with
    server-rendered Next.js + `router.refresh()` already used by
    ActionForm.
  - **Option B:** small client component holding mode in `useState`.
    Forms re-render on mode swap; ActionForm `router.refresh()`
    survives because the parent is server-rendered. Slightly more
    React; no URL state.

  Brief recommends Option A. Clean URL, deep-linkable, no extra JS.

B.3 Active-mode treatment:
  - Active button: filled splash-blue background, white text.
  - Inactive button: white background, splash-navy text, gray-light
    border.
  - Buttons are full-width on mobile, side-by-side on >=640px.
  - Each button shows a small count of operations under the title:
    "Manage Users (5 operations)" / "Manage Tables (3 operations)".
    Static counts; not data-driven.

B.4 Refactor `page.tsx`:
  - Extract the 8 existing card render functions into named exports
    in two new files for cleanliness (optional but tidy):
    - `apps/web/app/admin/sysadmin/_sections/UserOperations.tsx`
    - `apps/web/app/admin/sysadmin/_sections/TableOperations.tsx`
  - `page.tsx` becomes: PageBanner + ModePicker + (active section)
    + AuditLogPanel.

### Part C - apps/web: AuditLogPanel

C.1 Always-visible section below the operations. Title: "Activity
log". Initially renders the 50 most recent rows, no filters
applied.

C.2 Filter row above the table (form, GET-style, no server action):

  - **Actor** - text input (substring match on actor_email).
  - **Action** - select with the allowed values from A.1's list
    plus "(any)".
  - **Table** - select with allowed `target_type` values plus
    "(any)".
  - **User** - UserPicker (reused from Brief 18). Selecting a user
    sets the `user_id` filter (the picker's existing hidden input
    contract works as-is). "Clear" link restores no-user.
  - **Location** - text input (substring on location_code,
    lowercase + alphanumeric/underscore).
  - **Apply filters** button - submits the form, which re-renders
    the panel with the new filters in the URL (search params).
  - **Reset** link - clears all filter params.

C.3 Filter implementation:
  - Filters live in URL search params: `?audit_actor=`,
    `?audit_action=`, `?audit_table=`, `?audit_user_id=`,
    `?audit_location_code=`.
  - The page is a server component. It reads these searchParams,
    passes them into a `searchAuditLog(filters)` call (server-side
    via service binding to sysadmin-worker), and renders the rows.
  - The mode-picker's `?mode=` param is independent from audit
    filters; both can coexist in the URL.

C.4 Rendering each audit row - compact table:
  - Columns (in order): When | Actor | Action | Target | Diff
  - **When**: relative time ("3m ago", "2 days ago") with absolute
    timestamp on hover. Use a small client island for the relative-
    time formatter (or render server-side using a single shared
    helper that just emits ISO-8601 + a humanized fallback).
  - **Actor**: `actor_email`. If "system", italicize.
  - **Action**: e.g. `grant_tool`. Mono font. `*_noop` actions get a
    smaller pill badge "(no-op)" appended.
  - **Target**: `target_type/target_id`. E.g.
    `user_permissions/<uuid>` or `pricing_simple/binghamton/bath`.
    User UUIDs are long; render the first 8 chars + "..." with a
    title attr containing the full id.
  - **Diff**: small `<details>` summary "View" - on open, renders
    `before` and `after` as `<pre>`-formatted JSON side-by-side
    (or stacked on mobile). For inserts (before is null) show only
    "after"; for deletes (after is null) show only "before".

C.5 Pagination:
  - Bottom of the table: "Showing 1-50 of ~XYZ" + "Load more" link
    bumping `?audit_offset=50` (or 100, etc.).
  - For v1, no smart cursor pagination - just offset.
  - "Load more" is a plain `<Link>` with the bumped offset; the
    server-rendered page replaces the rendered set. Alternatively
    use the App Router's built-in scroll preservation. Don't build
    infinite-scroll; this is observation tooling, not a feed.

C.6 Empty state: if `rows.length === 0`, show a small italic
"No audit entries match these filters."

C.7 Error state: if the worker call throws or returns non-2xx,
render a small alert "Could not load audit log: <error>." Don't
crash the rest of the page.

### Part D - Updates

D.1 BRIEFS/INDEX.md: Brief 30 row added.

D.2 BUILD_STATE.md: Last updated, Findings entry covering the
restructure + the new audit-log endpoint + URL search-param
mode/filter convention.

D.3 CLAUDE.md: extend the sysadmin glossary entry to mention the
two-mode hub + audit-log surface; note the URL conventions
(`?mode=`, `?audit_*=`).

## Out of scope

- Adding columns to `sysadmin_audit_log` (the schema is
  read-only here).
- CSV / JSON export of filtered audit log results (could be a
  follow-up; small worker endpoint that streams rows under the
  same filter shape).
- Real-time updates (websocket / polling). Page is "load + refresh
  button"; reload to see new entries.
- Date-range UI controls (`since`/`until` are exposed in the worker
  endpoint but the UI doesn't render pickers in v1; URL-edit power
  users can still set them).
- Diffing the JSON before/after with a structural diff renderer.
  v1 just shows the two blobs side-by-side; jsondiff library is a
  follow-up.
- Audit log retention policy / archival.
- Logging audit-log reads themselves.
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- New worker handler at GET /sysadmin/api/audit-log with super_admin
  gate, allowed-action and allowed-target-type validation, ilike-
  sanitization, ISO-8601 since/until validation, default limit=50
  max=200, offset pagination, ordered desc by created_at
- Page banner subtitle replaced ("Manage users and tables, with full
  activity history below.")
- Two-mode hub: Manage Users (5 ops) / Manage Tables (3 ops); URL
  search-param-driven (Option A); active mode visually distinct
- Audit-log panel always rendered at the bottom; filter row with
  actor / action / table / user (UserPicker) / location-code; URL
  search-param-driven filters; "Load more" offset pagination
- Compact audit-row table: When / Actor / Action / Target / Diff
  (Diff is a per-row `<details>` with before/after JSON)
- Empty + error states wired
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Whether `sysadmin_audit_log` schema matched the inferred shape
  (especially: id type bigint vs uuid, created_at default, any
  unexpected columns)
- Whether the search-param mode (Option A) felt right or whether
  Option B (client state) ended up cleaner during implementation
- Bundle-size delta on /admin/sysadmin (audit panel + JSON diff
  rendering will likely add weight)
- Any audit-log action strings observed in the live data that
  AREN'T in the allowed list (typos, retired actions, future
  features that wrote rows already)
- Whether the relative-time formatter ended up server-rendered or
  client-island
- Validation results

## Outcome

### Files modified

- `apps/sysadmin-worker/src/index.ts` — header comment lists the new
  endpoint; `OWNED_GET_PATHS` extended; top-level fetch dispatch routes
  the new path; new `handleSearchAuditLog` (allow-list validation,
  ilike-sanitization, UUID + ISO-8601 + lowercase-code regexes,
  `Prefer: count=estimated` for total_estimate, default limit 50 / max
  200, offset pagination, `created_at.desc` order, response shape per
  spec). The user_id filter pins target_type via two top-level
  AND-combined params; the location_code filter pins target_type and
  uses an inner `or=()` clause to match `target_id` eq or `code/%`.
- `apps/web/app/admin/sysadmin/page.tsx` — full rewrite. Reads
  `searchParams.mode` (default "users"); renders `<PageBanner>`,
  `<ModePicker>`, the active section, then `<AuditLogPanel>`. PageBanner
  subtitle replaced with "Manage users and tables, with full activity
  history below." (the previous meta-commentary about
  `sysadmin_audit_log` dropped). The flat 8-card list is gone — cards
  now live in the `_sections/` files.
- `BRIEFS/INDEX.md` — Brief 30 row marked Completed (2026-05-05).
- `BRIEFS/QUEUE.md` — Brief 30 line moved to the completed-tombstone
  block.
- `CLAUDE.md` — sysadmin glossary entry extended to describe the
  two-mode hub, the new audit-log surface, and the URL search-param
  conventions.
- `BUILD_STATE.md` — Last updated bumped, new Findings entry, sysadmin
  row in pages-built table updated to reflect the new structure +
  bundle size, prioritized-list row 30 added.

### Files created

- `apps/web/app/admin/sysadmin/_components/OperationCard.tsx` —
  shared `<details>` card primitive + `FieldLabel` + `inputClass`/
  `submitClass` tokens, extracted from the old page.tsx so both
  section files can re-import without duplication.
- `apps/web/app/admin/sysadmin/_components/ModePicker.tsx` —
  server-component picker (Option A). Two `<Link>` buttons; active
  mode gets filled splash-blue + `aria-current="page"`. Hrefs preserve
  every existing search param except `mode` itself, so audit-log
  filters survive a mode swap. Subtitles "5 operations" / "3
  operations" per the brief.
- `apps/web/app/admin/sysadmin/_sections/UserOperations.tsx` —
  server component rendering the 5 user-mgmt cards (Create user / Set
  role / Grant tool / Revoke tool / Reset password). Lifted verbatim
  from the old page.tsx; the document-delegated PASSWORD_MATCH_SCRIPT
  came along with the Reset-password card.
- `apps/web/app/admin/sysadmin/_sections/TableOperations.tsx` —
  server component rendering the 3 table-mgmt cards wrapping the
  existing client islands (`AddLocationCard` / `UpdatePackageCard` /
  `UpdateLocationCard`). Card titles + descriptions verbatim from the
  old page.tsx.
- `apps/web/app/admin/sysadmin/_sections/AuditLogPanel.tsx` —
  server component. Reads `audit_*` searchParams; calls
  `sysadminGetJson<AuditLogResponse>` against the new endpoint.
  Filter row above the table is a GET-method `<form>` posting back to
  `/admin/sysadmin` (preserves the active mode via a hidden input;
  resets `audit_offset` to 0 on every submit). Fields: actor text
  input, action select (allow-list + "(any)"), table select (allow-list
  + "(any)"), `<UserPicker name="audit_user_id">` (reuses Brief 18's
  client island), location_code text input with `pattern="[a-z0-9_]*"`,
  Apply + Reset. Below: compact 5-column table (When / Actor / Action
  / Target / Diff) with offset pagination ("Showing N–M of ~XYZ" +
  "Load more" link). Empty state, error state, and per-row Diff
  `<details>` (before/after JSON in `<pre>` blocks; inserts show only
  after, deletes show only before; `notes` rendered as italic small
  text). Relative-time formatter is server-rendered (single helper
  emitting "3m ago" / "2 days ago"; absolute ISO on title attr).

### Decisions made on operator's behalf

1. **Option A (URL search-param-driven mode picker)** chosen per the
   brief's recommendation — clean URL, deep-linkable, no extra JS,
   plays nicely with the existing server-rendered + `router.refresh()`
   pattern.
2. **Relative-time formatter is server-rendered**, not a client island.
   Sufficient for v1 because the page only updates on refresh; client
   hydration would add weight (a `RelativeTime.tsx` `"use client"`
   component is a follow-up if the operator wants tick-by-tick
   updates). The absolute ISO timestamp lives on the title attr for
   hover.
3. **`AuditLogPanel` always renders for both modes** — the brief's
   diagram shows the panel at page bottom regardless of mode;
   operators commonly want to verify a write they just made via the
   mutation UI without flipping modes.
4. **Filter changes always reset `audit_offset` to 0** via a hidden
   `<input type="hidden" name="audit_offset" value="0">` in the
   filter form — pagination only makes sense relative to the current
   filter set; preserving it across filter changes leads to confusing
   empty pages.
5. **Reset link clears every `audit_*` param but keeps `mode`** —
   operators expect to reset the log without losing their current
   mode context.
6. **`UserPicker` reused as-is for the user filter** — passes
   `name="audit_user_id"` instead of `name="user_id"`; on initial
   render with `audit_user_id` already in the URL, the picker is
   given `defaultValue` + a placeholder
   `defaultLabel="(filtering — clear to change)"` because we can't
   roundtrip the email server-side without a second worker call.
   Operators clear + retype to change.
7. **`AuditLogResponse.next_offset` is computed server-side** as
   `rows.length < limit ? null : offset + rows.length` — simpler
   than computing it in the panel.
8. **No CSV export, no live updates, no JSON structural diff, no
   date-range UI controls, no audit-log retention policy** — all
   explicitly out-of-scope.
9. **No audit-log entry written for the audit-log read** — explicitly
   out-of-scope; reading the log is a super_admin observation.
10. **Allowed-action list hardcoded in both worker and apps/web filter
    UI**; future briefs that add a new audit `action` string need to
    update both. The worker rejects unknown action filter values with
    400 — useful early-warning if a typo or forgotten audit constant
    slips through.
11. **`OperationCard` extracted to `_components/`, not `_sections/`**,
    because both sections re-import it; section files are mode-
    specific containers, components are reusable primitives.
12. **No optional `searchAuditLog` helper in `packages/db-supabase`**
    per the brief's "don't over-abstract" guidance — Brief 26/27 also
    inline the Supabase REST fetches in the worker, and a single
    handler doesn't need its own typed helper yet.

### Latent issues / forward flags

1. **PostgREST allows duplicate top-level filter params, AND-combining
   them**, which is what we lean on when `user_id` is set (it adds
   `target_type=in.(user_permissions,user_tool_access,auth.users)`
   AND `target_id=eq.{uuid}` ON TOP of any explicit `table=...`
   filter). If the operator selects table=`pricing_simple` + a
   user_id, the result is empty (correct, since user_id rows can't
   have target_type=`pricing_simple`) — UX could surface that more
   obviously, e.g. as an inline "filter combo yields nothing" hint.
   v1 just shows the empty state.
2. **`audit_user_id` round-trip**: when filtered, the picker shows a
   stale "(filtering — clear to change)" instead of the email.
   Resolving it would need a second worker call
   (`/sysadmin/api/users?id=<uuid>`) which the worker doesn't
   currently support. Follow-up brief if the operator finds this
   confusing.
3. **`Content-Range` header** is read off the response and parsed
   for the trailing total. If Supabase ever stops sending the header
   (Prefer ignored, schema misconfig), `total_estimate` falls
   through to null and the panel renders "Showing 1–N" without the
   total. The Load-more link still works (next_offset is computed
   from rows.length, independent of the header).
4. **Schema verification deferred**. I trusted the brief's inferred
   shape for `sysadmin_audit_log` (id, created_at, actor_id,
   actor_email, action, target_type, target_id, before, after,
   notes). The audit handler reads `select=*` so any extra columns
   flow through harmlessly to the rendered diff. The rendered table
   only references the documented columns.
5. **`location_code` filter regex is `[a-z0-9_]+`** matching the
   worker's `LOCATION_CODE_RE`. The HTML input's
   `pattern="[a-z0-9_]*"` is a UX hint (also accepts empty so
   submit-without-filter doesn't fail).
6. **No worker-side rate limiting on audit-log GETs** — endpoint is
   super_admin-gated, so the operator headcount caps the abuse
   surface.
7. **No new audit-log action strings observed** beyond the allow-list
   during static review (couldn't query live data from headless
   mode); operators should flag any unknown action that surfaces a
   400 from the filter UI as either a typo or a forgotten future-
   feature constant.

### Validation results

- `pnpm typecheck` 13/13 successful, 4.956s (11 cached + 2 fresh —
  `@splash/sysadmin-worker` and `@splash/web` invalidated by source
  changes).
- `pnpm --filter @splash/web build` succeeded — Next 15.5.15
  compiled in 5.6s, 12/12 static pages generated, all type checks
  green.
- **Bundle deltas:** `/admin/sysadmin` 6.94 kB → **7.06 kB** / 112 kB
  → 112 kB First Load JS (+0.12 kB / 0 kB). Audit panel is server-
  rendered; the only client weight added is one extra `UserPicker`
  mount in the filter row + a couple of additional `<Link>`
  instances. All other route bundles unchanged from Brief 29
  snapshot.

### Report (per brief Q&A)

1. **`sysadmin_audit_log` schema match.** Not directly verified
   from headless mode (no DB query path). Inferred shape from the
   brief was treated as authoritative; the worker reads `select=*`
   so any extra columns pass through to the diff. The render code
   only references the documented columns (id, created_at,
   actor_email, action, target_type, target_id, before, after,
   notes). Smoke-test in production to confirm `id` type
   (bigint vs uuid) — both are stringified by the worker via the
   audit helper, so neither breaks the response shape.
2. **Search-param mode (Option A) felt right.** No client state, no
   JS. Plays cleanly with `router.refresh()` from `<ActionForm>`.
   Deep-linkable. Mode picker is two `<Link>`s preserving every
   non-mode param; audit filters survive mode swaps.
3. **Bundle-size delta on `/admin/sysadmin`:** **+0.12 kB / 0 kB
   First Load** (6.94 → 7.06 kB / 112 → 112 kB). Audit panel is
   server-rendered; only client-side additions are the filter row's
   UserPicker mount + the per-row `<details>` Diff (native HTML, no
   JS). Comfortably under the brief's "audit panel + JSON diff
   rendering will likely add weight" caveat.
4. **No unknown audit-log action strings observed** during static
   review; live data wasn't queried from headless mode. Operators
   should treat any 400 from the filter UI on a previously-valid
   action as a typo or a forgotten constant.
5. **Relative-time formatter ended up server-rendered.** A 22-line
   helper at the bottom of `AuditLogPanel.tsx` ("just now" / "Nm
   ago" / "Nh ago" / "N days ago" / "N month(s) ago" / "N year(s)
   ago") with the absolute ISO on the title attr. No client island.
6. **Validation:** `pnpm typecheck` 13/13 green; `pnpm --filter
   @splash/web build` green. Bundle delta within estimate.


