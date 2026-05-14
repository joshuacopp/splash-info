# CLAUDE.md - splash-info monorepo

This file is auto-loaded by Claude Code at the start of every session in
this directory. Read it first. It mirrors the operator's project rules,
constraints, and conventions.

The single source of truth for project state is `BUILD_STATE.md`. Read
that next, then the brief you've been asked to execute (under `BRIEFS/`).

---

## What this project is

Splash Car Wash's MaxPass internal tooling monorepo. Nine Cloudflare
Workers (apps/) — five ported from a single legacy worker
(`info-signup-worker`), the workorders-worker (Brief 70), the
fleet-inquiry-worker lift-and-shift (Brief 81 — workers.dev only until
operator-driven cutover), the forms-worker (Briefs 89–100), and the
jotform-worker (Brief 107) — plus a Next.js apps/web that consumes
their JSON APIs. Seven shared packages (packages/) provide auth, http,
database, types, UI, storage, and config. Build orchestration via
Turbo (`turbo.json`) and pnpm workspaces (`pnpm-workspace.yaml`).

```
apps/
  apps/dashboard-worker      SSO entry: /api/login, /api/logout, /api/forced-reset
  apps/signup-worker         Customer signup + Signup Admin JSON API
                             (pricing + per-location recent signups viewer;
                             worker name on Cloudflare: splash-signup-next,
                             renames to splash-signup at cutover)
  apps/performance-worker    Performance tracker API at /pertrack/*
  apps/sysadmin-worker       User management JSON API at /sysadmin/api/*
  apps/damage-worker         Damage claims API + R2 photos + D1 records +
                             Power Automate webhooks + Check Request PDF gen
                             + MaintainX WO create path (Brief 42 / 43)
  apps/workorders-worker     Work Orders read API at /workorders/api/*
                             (MaintainX integration; sibling of damage-worker
                             — Brief 70)
  apps/fleet-inquiry-worker  Public fleet-inquiry form (live at
                             fleet.splashcarwashes.info via the legacy
                             `broad-shape-38b8` worker; this monorepo copy
                             is `splash-fleet-inquiry` on workers.dev only,
                             pending operator-driven cutover) — Supabase +
                             Google Maps Geocoding + Turnstile. Brief 81.
  apps/jotform-worker        JotForm Enterprise submission ingest + admin
                             read API. Worker name on Cloudflare:
                             `splash-jotform`. Webhook receiver +
                             super_admin-only backfill endpoint; reads
                             scoped by RM/RD/GM email-on-locations match.
                             Brief 107.
  apps/web                   Next.js (App Router), deploys via OpenNext to
                             Cloudflare Workers. Consumer of the workers'
                             JSON APIs.

packages/
  auth, config, db-d1, db-supabase, http, storage-r2, types, ui
```

---

## Read these every session, in order

1. `BUILD_STATE.md` - current project state, prioritized work list, known
   production state, conventions, decisions log. Single source of truth.
2. `AUDIT_REPORT.md` - apps/web gap analysis from 2026-05-03.
3. `CUTOVER_PLAN.md` - declared "build phase complete" but was incomplete
   (apps/web was not audited before declaration). Read for context, not
   as authoritative on current state.
4. `PRE_DEPLOY_*.md` - seven files (DAMAGE, DASHBOARD, FLEET,
   PERFORMANCE, SIGNUP, SYSADMIN, WEB). Per-deployable deploy notes.
   PRE_DEPLOY_WEB.md (Brief 51) consolidates every apps/web-specific
   deploy-time gotcha learned across Briefs 1-50. PRE_DEPLOY_FLEET.md
   (Brief 81) covers the workers.dev-only monorepo copy of
   `fleet-inquiry-worker` and the operator-driven cutover from the
   legacy `broad-shape-38b8` worker.
5. The brief in `BRIEFS/` you've been asked to execute.

If any of these are missing, stop and report it instead of guessing.

---

## Critical constraints (non-negotiable)

1. **Load-bearing customer URLs.** `/signup/{location}`, `/q/{location}`,
   `/join/{location}` URLs MUST NEVER change. They are saved on hundreds
   of customer/admin device home screens as per-location bookmarks.
   Renaming them silently breaks the bookmark UX until devices are
   re-bookmarked manually. Any task that proposes touching these URLs
   must be rejected without explicit operator override.
   Customer-facing routes (`/signup/{location}`, `/q/{location}`,
   `/join/{location}`, `/claims/{site}`) are served by their owning
   workers (signup-worker for signup/q/join, damage-worker for claims),
   NOT by apps/web. apps/web is admin-only post-Brief-50.

2. **`pkg$` column name is intentional.** The `pricing_simple` table has
   a column literally named `pkg$` (with the `$`). This requires Postgres
   double-quoting (`"pkg$"`) and shows up in code as bracket notation
   (`row["pkg$"]`). DO NOT rename the column. DO NOT "normalize" the
   bracket access to dot notation. Renaming would cascade to PostgREST
   clients, the resolved view, Power Automate, and Supabase RLS policies.

3. **`SUPABASE_SERVICE_KEY` (not `_SERVICE_ROLE_KEY`).** Legacy used
   `SUPABASE_SERVICE_ROLE_KEY`. The monorepo standardized on
   `SUPABASE_SERVICE_KEY` across all five workers. Code reads
   `SUPABASE_SERVICE_KEY` from env. If a binding is set under the legacy
   name in Cloudflare, the worker 401s on every authenticated read.

4. **Never use `wrangler deploy` if secrets were set via UI.** Per
   project memory, `wrangler deploy` can overwrite UI-configured
   secrets. Currently all secrets are set via CLI (`wrangler secret put`),
   so this is dormant, but reactivates if anyone configures secrets via
   the Cloudflare dashboard.

5. **`manually_flagged` rows in `suspicious_phones` are immutable from
   worker code.** Auto-detection (`createOrUpdateSuspicious`,
   `updateUsageCount`) skips writes when the row has
   `manually_flagged = true`. Admin-curated deny entries
   (e.g., `'0000000000'`) stay untouched.

6. **Production state diverges from repo state.** `splash-dashboard` is
   bound to `splashcarwashes.info/`, `/login`, `/logout` in Cloudflare's
   UI but `apps/dashboard-worker/wrangler.toml` has routes commented.
   The bindings in CF return 404 today because the new code only handles
   `/api/*` paths. Don't "fix" this divergence without explicit
   instruction - both states are intentional snapshots of an in-progress
   migration. The repo reflects intent; CF reflects history.

7. **Never rotate `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` without
   coordination.** This key (Brief 31) is a build-time env var on
   apps/web's CF Workers Builds config that stabilizes server-action
   IDs across deploys. Rotating it invalidates every action ID on every
   open browser tab — operators mid-session get an `UnrecognizedActionError`
   white-page on next form submit (the `/admin/error.tsx` boundary
   softens this to a "Reload" CTA, but it's still a UX disruption).
   If rotation is truly needed, plan it during a maintenance window
   when no operators are mid-session.

8. **`maintainx_users` and `maintainx_teams` Supabase tables are
   read-only from worker code except for the daily sync handler.**
   Brief 71 introduced these as a denormalized cache populated by
   workorders-worker's scheduled handler (11:30 UTC daily, plus the
   on-demand `POST /workorders/api/sync-maintainx-users` super_admin
   endpoint). Manual SQL edits to these tables get overwritten on
   the next sync. To change a user's metadata, change it in
   MaintainX itself; the next sync (within 24h) propagates.

9. **The legacy `broad-shape-38b8` worker and the
   `fleet.splashcarwashes.info` route are off-limits to Claude Code
   edits.** Brief 81 lifted-and-shifted the fleet-inquiry-worker source
   into `apps/fleet-inquiry-worker/` as a parallel monorepo copy
   (`splash-fleet-inquiry`, workers.dev only). The legacy
   `broad-shape-38b8` worker continues to serve all real fleet customer
   traffic at `fleet.splashcarwashes.info`. Do NOT delete, rename, or
   modify `broad-shape-38b8`. Do NOT bind `fleet.splashcarwashes.info`
   as a route on `splash-fleet-inquiry`. The cutover (route flip from
   legacy to monorepo) is operator-driven and explicitly out of scope
   for any Claude Code brief unless the operator asks. Same posture as
   constraint #6 but specific to fleet — the production deployment
   (legacy worker bound to the custom domain) and the repo's intent
   (monorepo worker on workers.dev only) are both intentional snapshots
   of an in-progress migration.

10. **The `forms` / `form_versions` / `form_assets` / `form_submissions` /
    `form_submission_files` tables are owned by `splash-forms` worker
    (Briefs 89–98).** Manual SQL edits to these tables are allowed only
    via the operator's Supabase SQL editor (no migration framework in
    this repo). Direct edits to `form_versions.schema` (the published
    schema JSONB) outside of the Brief 95 admin builder will diverge the
    live form from what the builder shows; if you need to hand-edit a
    schema, do it via the builder's draft-then-publish flow instead.
    Past submissions reference `form_versions.id` directly, so editing
    a published schema row also rewrites history for existing submissions —
    don't.

---

## Operator preferences

- Step-by-step for any "show me how to" / "teach me how to" / "guide me
  to" task. Don't dump the whole process at once. The operator will ask
  questions at each step.
- Prefer Claude Code-style autonomous implementation for multi-file
  changes rather than fragmented chat instructions. If a task calls for
  many file edits, do them yourself rather than walking the operator
  through copy-paste.
- Working environment: Windows, VS Code with PowerShell terminal.
  Commands should use PowerShell syntax (no bash-isms unless using `bash`
  explicitly).
- VS Code's integrated terminal mangles paste into
  `Read-Host -AsSecureString` prompts. Don't use that pattern for
  credential capture; use plain Read-Host or wrangler's own prompts.
- Don't repeatedly ask the operator to redact output that contains
  credentials/PII. Either ask for output in a form that doesn't include
  it, or extract the safe portion programmatically.
- Don't make time-of-day assumptions. The operator's calendar is not
  your concern.
- The operator's name is Josh. Other super_admins on this project: Noah,
  Alexandro, Jacob, rwilliams. Area managers / primary admin users:
  Bill Trabulsy, Jay Frank, Mike Grubka.

---

## How to behave on tasks

When given a new task:

1. Read `BUILD_STATE.md` and any other docs the task references
   (typically a brief in `BRIEFS/`).
2. Identify whether the task is implementation, planning, or
   investigation. They have different tempos:
   - **Implementation**: act. Make the changes. Test if applicable.
     Update `BUILD_STATE.md` when done.
   - **Planning**: lay out options, surface tradeoffs, ask before
     committing.
   - **Investigation**: read-only. Report what you find. Don't fix.
3. If you're going to make file changes, briefly state what you intend
   to do before doing it (1-3 sentences). The operator can stop you if
   it's off-target.
4. If the task is unclear or has ambiguity that could lead you down the
   wrong path, ASK before guessing. Specifically:
   - When operator says "fix X" but doesn't specify how - ask if
     there's a preferred approach.
   - When operator references a file or system you can't find - ask
     rather than assume.
   - When you need credentials or configuration values you don't have -
     ask for them explicitly; never guess.
5. After making changes, update `BUILD_STATE.md`:
   - "Last updated" date (use absolute YYYY-MM-DD format)
   - New entry in "Findings & decisions log" summarizing what changed
   - Update the prioritized work list status if a brief was completed
6. Report back what you did. Surface anything surprising, any latent
   issues you noticed, and any decisions you made on the operator's
   behalf.

---

## What NOT to do

- Don't deploy to Cloudflare without explicit instruction. `wrangler deploy`
  is a destructive command from the operator's perspective.
- Don't modify production state. The operator's CF dashboard is the
  authoritative production layer; the repo is intent. Don't bind routes,
  don't run `wrangler triggers deploy`, don't change worker names.
- Don't bypass smoke tests. New worker code that hasn't been smoke-tested
  on workers.dev is not ready to deploy.
- Don't run `pnpm clean` or `rm -rf node_modules` without explicit
  instruction. Reinstalls take time and can mask issues.
- Don't re-run `pnpm install` unless explicitly needed (e.g., after
  adding a dependency).
- Don't commit to git or push to remotes without explicit instruction.
- Don't write to `BUILD_STATE.md` without doing the work first. Status
  updates reflect completed work; never write "completed" before code
  changes land.
- Don't refer to past Claude conversations. Each session starts fresh
  from `BUILD_STATE.md` + the brief.

---

## Working with workers

- Worker code lives in `apps/<worker-name>/src/`. Wrangler config is
  `apps/<worker-name>/wrangler.toml`.
- All seven workers are deployed to `*.workers.dev` only. Production
  routes are commented in every wrangler.toml. Don't uncomment without
  explicit instruction. (Caveat: `splash-fleet-inquiry` from Brief 81
  is workers.dev only because the legacy `broad-shape-38b8` worker
  still owns the production custom domain `fleet.splashcarwashes.info`
  — see constraint #9.)
- **Staging hostnames.** Most workers carve a path on
  `staging.splashcarwashes.info/<feature>/api/*` (Brief 16 pattern —
  e.g., workorders-worker uses `/workorders/api/*`). Brief 82 (2026-05-09)
  bound `splash-fleet-inquiry` to a subdomain instead —
  `fleet.staging.splashcarwashes.info` — mirroring production's
  `fleet.splashcarwashes.info` subdomain pattern. The subdomain was
  chosen over a path-carve because fleet's verbatim-lifted JS exposes
  bare `/api/*` paths that would collide with apps/web staging's
  `/api/login` / `/api/me`. Other workers continue to use
  `staging.splashcarwashes.info/<feature>/api/*`.
- **fleet-inquiry-worker is the only monorepo worker with paid
  third-party API usage.** Google Maps Geocoding
  (`maps.googleapis.com/maps/api/geocode/json`) is billed per request
  beyond the free tier (~$5/1000 calls). 7-day cache TTL on geocode
  results materially lowers volume. See PRE_DEPLOY_FLEET.md section 3
  for the per-key restriction recommendation and quota dashboard
  pointers. Other workers' external HTTP — Supabase, Power Automate,
  MaintainX — is either flat-fee subscription or free.
- Secrets are bound via `wrangler secret put`, scoped per worker. The
  command must be invoked inside the worker's directory or via
  `pnpm --filter @splash/<worker> exec wrangler secret put NAME`.
  `wrangler --filter` does NOT exist — that's a pnpm flag, not a
  wrangler flag. Verify with `pnpm --filter @splash/<worker> exec
  wrangler secret list`.
- Bundle size: workers compress well; current sizes are 700-1600 KiB
  uncompressed / 130-360 KiB compressed. Cloudflare's compressed limit
  is 3 MiB free / 10 MiB paid. Plenty of headroom.
- Smoke tests for each worker are in `PRE_DEPLOY_<NAME>.md`. Some tests
  reference legacy patterns (e.g., damage-worker tests #1-2 expect HTML
  pages, but the new architecture is API-only). Don't blindly run all
  PRE_DEPLOY tests; check whether each applies.
- **Workers Logs (Brief 63).** Every worker's `wrangler.toml` MUST include
  an `[observability.logs] enabled = true / invocation_logs = true` block
  so the CF dashboard's "Logs → Enabled" toggle stays sticky across
  push-triggered deploys. Without it, CF Builds re-provisions the worker
  on every deploy and the dashboard toggle reverts to off. New workers
  should copy the block verbatim from any existing one.
- **Scheduled handlers (Brief 65).** damage-worker's default export is
  `{ fetch, scheduled }`; the scheduled handler runs the daily
  open-claims summary cron (`[triggers] crons = ["0 13 * * *"]` =
  13:00 UTC = 8 AM ET; see `runDailySummaryCron` in
  `apps/damage-worker/src/index.ts`). Future cron additions to other
  workers should follow the same pattern: extend the default export to
  `{ fetch, scheduled }`, add a `[triggers] crons = [...]` block to
  wrangler.toml. The Workers Logs `[observability.logs]` block from
  Brief 63 covers scheduled invocations automatically — they show up
  with `eventType: scheduled` (vs `fetch`).
- **Damage-worker manage endpoints** (post-Brief 59):
  `GET /manage/api/claims` (now with `regional_director_email`,
  `regional_manager_email`, `submitted_from`, `submitted_to` query
  params), `GET /manage/api/claim/{id}`, the write surfaces under
  `/manage/api/claim/{id}/{note,transition,document,document/{docId}/{delete,edit}}`,
  the check-request preview, plus the two Brief 59 read endpoints:
  `GET /manage/api/contact-roster?role=regional_director|regional_manager`
  (returns `{email,name,location_codes}[]`, dc_role-scoped) and
  `GET /manage/api/reporting?location=&regional_director_email=&regional_manager_email=&window=current_month|past_month|qtd|past_quarter|ytd`
  (returns aggregate KPIs, by-location pivot, and damage-type
  breakdowns; cost = sum of approved-quote + receipt amounts —
  `claim_photos.amount` for `Quote`/`Receipt` rows on Approved-family
  claims).
  Brief 101 (2026-05-11) wired the optional `CLAIM_UPDATE_WEBHOOK_URL`
  secret into the note + transition handlers — fail-soft per-event
  notifications to the location's rm_email / site_email keyed by the
  destination status (see glossary entry). Future notification
  surfaces on damage-worker should reuse
  `apps/damage-worker/src/notifications.ts` rather than spawning a
  new module per feature.
- **`MAINTAINX_API_KEY` is bound on TWO workers** (Brief 70):
  damage-worker for the WO-create path (Brief 42 / 43), and
  workorders-worker for the WO-read path (`GET /workorders/api/list`).
  Same value on both; per-worker bindings. Future MaintainX surfaces
  should pick one of these two workers as the home rather than
  spawning a third.
- **MaintainX integration (Brief 42).** `MAINTAINX_API_KEY` is a
  `wrangler secret` bound on **damage-worker AND workorders-worker** —
  bearer token for `https://api.getmaintainx.com/v1/workorders`. Three
  companion non-secret `[vars]` entries live in `apps/damage-worker/wrangler.toml`:
  `MAINTAINX_MODE` (`"test"` default — routes WOs only to Josh; flip to
  `"production"` at cutover), `MAINTAINX_BASE_URL`, and
  `APPS_WEB_BASE_URL` (used to build the admin link inside each WO
  description). The hook fires inside `handleClaimSubmission` only when
  `equipment_related === 1`; failure is fail-soft (activity-log entry
  with `[maintainx]` prefix on the existing `note` activity_type, claim
  still proceeds). Assignee IDs are encoded as module-level const arrays
  in `apps/damage-worker/src/maintainx.ts` so they're grep-able when
  someone leaves the company: Brett Sullivan (409112,
  bsullivan@splashcarwashes.com), Scott Butler (426577,
  scott.butler@splashcarwashes.com), Josh Copp (443948,
  josh.copp@splashcarwashes.com). The `claims.maintainx_workorder_id`
  D1 column doubles as the dedupe key for Brief 43's GM-side modal —
  `updateMaintainXWorkOrderId` UPDATEs only when the column is NULL,
  so a re-trigger lands at most one WO per claim. MaintainX assignee
  objects require `type: "USER"` alongside the user ID. Omitting it
  returns 400 with `assignees.0.type` fieldPath (Brief 46). The
  `getMaintainXLocationId` helper (in `@splash/db-supabase/locations`)
  resolves `pricing_simple.location_code → pricing_simple.site`
  (denormalized site_number text — e.g., "147" — populated by
  `trg_sync_pricing_simple` from `locations.site_number::text`), then
  joins `locations.site_number=eq.<that value>` to read `maintainx_id`.
  The join key is `locations.site_number`, NOT `locations.site`
  (which is the location name like "Oswego"). Brief 62 fixed an
  earlier version that joined on `locations.site` and silently
  returned null for every slug — same bug class Brief 49 fixed for
  `getLocationContactInfo`.
- **Workorders-worker endpoints** (Brief 70 / Brief 71 / Brief 74):
  `GET /workorders/api/list`, (Brief 71) `POST /workorders/api/sync-maintainx-users`,
  (Brief 74) `POST /workorders/api/request`.
  Permission domain (Brief 71): pure email-on-locations match against
  `locations.am_email` / `rm_email` / `site_email` — super_admin and
  admin do NOT have a global override. The Brief 70 dc_role gate and
  the Brief 70 bulk helpers (`getMaintainXIdsForLocationCodes` /
  `getLocationCodesByMaintainXIds`, `MaintainXLocationInfo`) were
  deleted in Brief 71; the read path now reads directly from
  `locations` via `getLocationsByContactEmail`. Upstream MaintainX
  read call has an 8s `AbortController` timeout. Fail modes:
  `MAINTAINX_API_KEY` unbound → 503 (page surfaces "integration not
  configured"), MaintainX non-2xx → 502, network/abort → 504. The
  default export is `{ fetch, scheduled }`; the scheduled handler
  (`[triggers] crons = ["30 11 * * *"]` — 11:30 UTC, fires before
  the damage-worker daily summary at 13:00 UTC) runs the daily
  MaintainX user/team sync into Supabase tables `maintainx_users` /
  `maintainx_teams`. The `POST /sync-maintainx-users` endpoint runs
  the same sync on demand, gated to a hardcoded super-admin email
  allow-list with a `session.dcRole === "super_admin"` fallback.
  The list response shape buckets work orders by `wo.type ===
  "PREVENTIVE"` (Reactive vs Preventive tabs in apps/web) and groups
  each bucket by MaintainX `locationId`; group headers prefer MX's
  `expand=location.name` and fall back to `locations.location`
  (postal address). `getMaintainXLocationId` (Brief 42 / 62 forward
  helper used by damage-worker's WO-create path) is unchanged.
  Brief 74 adds `POST /workorders/api/request` — multipart/form-data
  endpoint that creates a MaintainX work request via
  `POST /v1/workrequests` then per-photo (max 5)
  `PUT /v1/workrequests/{id}/{thumbnail|attachment}/{filename}`. First
  photo lands as the WO thumbnail; photos 2–5 as attachments. Photo
  upload failures are non-fatal — the request exists in MaintainX
  either way; partial failures surface to the operator via a
  `request_warn=N-of-M-photos-failed` query param on the success
  redirect. Email-on-locations gate (same as the read path) +
  `isOriginAllowed` CSRF gate. Per-upload AbortController timeout 15s;
  request-create timeout 15s; total endpoint upper bound ~90s. The
  worker 303-redirects back to apps/web's `/workorders?tab=new&request_ok=N`
  on success or `/workorders?tab=new&request_error=<msg>` on failure
  (URL params drive a banner in `WorkOrdersTabsClient`). Plain HTML
  form bypasses Next 15 server actions per the Brief 37 / 38 pattern.
  `creatorContactInfo` = operator's session email; requester name +
  phone get appended to description as a structured footer.
  Description footer block: `Requested by: {name}\nPhone: {phone or
  "—"}\nSubmitted via: Splash /workorders`. The Location dropdown has
  no default — operators must explicitly pick to avoid accidental
  cross-site submissions. Location options are sourced from the
  read-path response's new `accessibleLocations` field (filtered to
  `maintainx_id !== null`), so apps/web doesn't need a second fetch.
  Requester Name defaults to empty; operator types the actual
  submitter on every request. Brief 103 (2026-05-11) dropped the
  auto-pre-fill from `maintainx_users.full_name` because shared
  per-location accounts (e.g., `binghamtonwash@splashcarwashes.com`
  → full_name 'Binghamton Wash') were silently degrading attribution.
  `currentUser.full_name` (sourced via `getMaintainXUserByEmail` in
  `@splash/db-supabase`) still ships on the `/workorders/api/list`
  response shape — harmless, ignored by the form now; v2 cleanup
  candidate if no future surface picks it up.

---

## Working with apps/web

- Next.js 14+, App Router (`app/` directory).
- Real pages: `/login`, `/change-password`, `/admin/dashboard`,
  `/admin/pricing`, `/admin/pricing/[location]`, `/admin/signups`
  (Brief 56), `/admin/signups/[location]` (Brief 56), `/admin/sysadmin`,
  `/admin/damage`, `/admin/damage/[id]`,
  `/admin/damage/reporting` (Brief 59),
  `/admin/fleet` (Brief 83), `/admin/fleet/[id]` (Brief 83),
  `/workorders` (Brief 70 — top-level, NOT under /admin/*),
  `/forms` (Brief 99 — top-level credentialed-user index, NOT under
  /admin/*; pairs with `/forms/{slug}` public render on splash-forms
  worker),
  `/logout` (route handler).
- Placeholder pages: `/admin/performance`.
- Redirect-only pages: `/` (Brief 50: redirects to `/login` or
  `/admin/dashboard` based on cookie presence).
- Missing routes: `/sysadmin/*` top-level (sysadmin lives under
  `/admin/sysadmin/*`), `/claims/{site}` (damage-worker owns - see
  decisions 8/9 in BUILD_STATE.md).
- Auth: Brief 1 added cookie-based middleware
  (`apps/web/middleware.ts`) that gates `/admin/*`, `/sysadmin/*`, and
  `/change-password?required=true` on the presence of `sb-access-token`
  cookie. Login flow POSTs to dashboard-worker `/api/login`.
- Brief 2 extended middleware with 308 redirects: `/admin/login` ->
  `/login`, `/admin/change-password` -> `/change-password`,
  `/admin/logout` -> `/logout`, plus `/admin/{slug}` ->
  `/admin/pricing/{slug}` for any single-segment slug not in the
  known-subpaths allow-list.
- **MANDATORY: any new top-level `/admin/{subpath}` route MUST be
  added to `ADMIN_KNOWN_SUBPATHS` in `apps/web/middleware.ts` in the
  same brief that creates it.** The single-segment legacy redirect
  rule (`/admin/{slug}` → `/admin/pricing/{slug}`) is a catch-all
  for legacy per-location bookmarks — any new top-level admin route
  not on the allow-list gets silently rewritten to a pricing URL
  that 404s against the signup-worker. This bug class has bitten
  three briefs so far (Brief 109 `/admin/jotform`, Brief 118
  `/admin/forms/submissions` — multi-segment so it slipped through,
  but the index page lived at `/admin/forms` which IS on the list,
  Brief 121 `/admin/approvals`). Every brief that introduces a new
  `apps/web/app/admin/{subpath}/page.tsx` (or a directory containing
  one) MUST list "add `{subpath}` to `ADMIN_KNOWN_SUBPATHS` in
  `apps/web/middleware.ts`" in its Scope and its Definition of Done.
  Multi-segment paths (`/admin/{a}/{b}`) bypass the redirect rule
  automatically, but the first segment still needs allow-listing if
  it's a new top-level directory — otherwise `/admin/{a}` itself
  would redirect.
- Worker URL helper: `apps/web/app/_lib/worker-urls.ts` centralizes how
  apps/web calls workers. Same-origin in production (apps/web + workers
  share splashcarwashes.info post-cutover); falls back to env vars in
  dev. Uses `NEXT_PUBLIC_*_WORKER_URL` pattern.
- Pricing helper: `apps/web/app/admin/pricing/_lib/worker-fetch.ts`
  prefers `NEXT_PUBLIC_SIGNUP_WORKER_URL` when set (dev cross-origin),
  falls back to host-based URL construction (production same-origin).
- Cross-origin cookies in dev are a known limitation. Cookies set by
  `splash-dashboard.<account>.workers.dev` won't reach
  `splash-web.<account>.workers.dev` under SameSite=Lax. Login fully
  works only after cutover when both share splashcarwashes.info, OR via
  local dev with a same-origin proxy.
- Shared UI components live in `packages/ui`. There was a latent bug
  where 9 files used `.js` extensions in TypeScript imports (worked
  under tsc Bundler resolution, broke Next.js webpack builds). Fixed in
  Brief 1. Don't reintroduce `.js` extensions on imports/re-exports
  inside `packages/ui`.
- Global Header at `apps/web/app/_components/Header.tsx` renders on
  every page from the root layout. White-script logo on dark
  splash-navy bar. Uses `usePathname()` to gate admin controls
  (Dashboard + Sign Out buttons + email/role badge with a small
  "Change password" text link beneath the badge) on `/admin/*`,
  `/sysadmin/*`, and `/workorders/*`. Brief 77 (2026-05-08): added
  `/workorders` to the gate (Brief 70 introduced it as a top-level
  route outside `/admin/*` and the gate hadn't been updated), and
  demoted "Change Password" from a third button to a small text
  link under the role badge — the third button was crushing the
  logo at iPhone widths and "change password" is a low-frequency
  action (~once per 90 days or after a forced reset) that doesn't
  need primary-button affordance.
- **Server-action ID stability** (Brief 31). apps/web depends on a
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` build-time env var (set in CF
  Workers Builds → splash-web → Settings → Build → Environment
  variables, NOT via `wrangler secret put`). Without it, Next
  regenerates a fresh encryption key on every `next build`, which
  invalidates all open-tab action IDs and white-pages mid-session
  submits with `UnrecognizedActionError`. See `apps/web/.env.example`
  for the rationale and generation commands. Defense in depth:
  `apps/web/app/admin/error.tsx` is a segment-level error boundary
  that catches `UnrecognizedActionError` (message contains "Server
  Action … was not found on the server") and renders a "Reload" CTA;
  all other errors get a generic "Try again" CTA via `reset()`. The
  boundary covers every `/admin/*` route — every server-action write
  surface — in one shot. Don't move it to `/admin/sysadmin/error.tsx`
  or similar; the boundary is intentionally placed at the segment
  that bounds every action-driven page.
- Damage detail (`/admin/damage/[id]`) renders every valid-from-status
  transition; rows whose `allowedRoles` don't include the caller's
  `session.dcRole` show with a disabled (greyed) button + an inline
  hint ("Requires admin or higher", or "Pending final approval" for the
  "Submit for Payment" transition specifically). Worker re-validates
  dc_role on POST as defense in depth — UI gating is a UX hint, not
  access control. **Brief 66 (2026-05-07)** widened RM access on the
  pre-quote-approval revert paths: from `Approved — Pending Quotes`
  RMs can now Send back to GM Review, Send back to RM Review, or
  Close — Denied; from `Pending RM Quote Approval` RMs can also Send
  back to GM Review or Send back to RM Review (deny was already
  RM-allowed). Admin-only revert paths now begin at
  `Approved — In House — Parts Ordered` (work-in-progress) and the
  finance-touched `Submitted for Payment` / `Check Issued` /
  `Check Request Submitted` chain. The `Pending RM Quote Approval →
  Approved — Pending Quotes` path also stays admin-only — it moves
  the claim FORWARD again, not backward.

### Server actions: useActionState + router.refresh() pattern (Brief 19)

Server actions invoked from a server-rendered `<form action={fn}>` MUST
return a serializable `ActionResult` and let a client wrapper drive the
post-action UX. Do NOT use `redirect()` from server actions for success
or error feedback.

Why: Next 15 server actions running in the OpenNext-on-Cloudflare-Workers
runtime don't reliably propagate `redirect()` responses as a visible
client-side navigation. Brief 18 surfaced this in staging — actions ran
to completion and the DB updated, but the browser sat on the pre-action
URL until manual reload. Pricing admin works because it uses direct
client `fetch()` + `setState`; damage and sysadmin (server-action
redirect-based) didn't.

The pattern:

1. **Action signature**: `(prevState: ActionResult | null, formData: FormData) => Promise<ActionResult>`
   where `ActionResult = { ok: true; message?: string } | { ok: false; error: string }`.
   The `prevState` parameter satisfies React 19's `useActionState` contract
   and can be ignored by the action body.

2. **Action body**: do the work, then `return { ok: true, message: "..." }`
   or `return { ok: false, error: "..." }`. Keep the `revalidatePath` call
   on success (it invalidates Next's route cache so the subsequent
   `router.refresh()` sees the post-mutation state).

3. **Form wrapper**: use the shared `<ActionForm>` at
   `apps/web/app/admin/_components/ActionForm.tsx` (a `"use client"`
   island). It dispatches the action via `useActionState`, renders the
   result inline (`role="status"` for success, `role="alert"` for errors)
   under the form, and calls `router.refresh()` on a fresh ok result.
   Pass `resetOnSuccess={false}` to preserve uncontrolled inputs after a
   successful submission (default: clear them by remounting via the React
   `key` trick).

4. **Don't read `?action_error=` / `?action_success=` searchParams in the
   page** — `<ActionForm>` handles result display now. Drop those branches.

The damage detail page (`apps/web/app/admin/damage/[id]/page.tsx`) and
sysadmin page (`apps/web/app/admin/sysadmin/page.tsx`) are reference
implementations. Future write-action briefs should follow this pattern,
not the redirect+searchParam pattern.

If a form contains an inline `<script>` that wires DOM event listeners
on the form's inputs (e.g., the password-match script on
`/admin/sysadmin`), use event delegation on `document` instead of
binding to element references at parse time — the references go stale
after `<ActionForm>` remounts the form on success.

### Service bindings (Brief 17)

When apps/web SSR-fetches another worker, prefer the service binding
over a URL-based fetch. apps/web's `wrangler.toml` declares 7
`[[services]]` entries (`DASHBOARD_WORKER`, `SIGNUP_WORKER`,
`PERFORMANCE_WORKER`, `SYSADMIN_WORKER`, `DAMAGE_WORKER`,
`WORKORDERS_WORKER`, `FLEET_INQUIRY_WORKER`). Each helper
under `apps/web/app/**/_lib/worker-fetch.ts` (and `_lib/me.ts`) tries
the binding first via `getCloudflareContext({ async: true })` and falls
back to a URL-based fetch when `getCloudflareContext()` throws or the
binding is undefined (i.e., `next dev` outside the Workers runtime).

Why: this is a CF same-zone limitation, not an apps/web choice.
URL-based Worker-to-Worker fetches on the same zone loop through the
edge inefficiently and 522 after ~19s. Service bindings route the
subrequest internally and pass Cookie/headers cleanly. The dev fallback
keeps localhost dev working (Next.js dev server runs outside the CF
Workers runtime, so bindings aren't available).

When adding a new server-side worker call:

1. If the binding exists in apps/web/wrangler.toml, use it via
   `getCloudflareContext({ async: true })`. Build a Request with
   `https://internal` as the placeholder host (service bindings ignore
   the host; only the path matters).
2. Forward the user's Cookie via `cookies().toString()`.
3. For POST helpers, set `Origin` explicitly so the worker's
   `isOriginAllowed` CSRF gate passes (Origin from `new URL(url).origin`
   works under both binding and URL paths).
4. Wrap the binding call in `try/catch` and fall back to a URL-based
   fetch in the catch branch. The catch branch covers `next dev` (where
   `getCloudflareContext()` throws) AND any future runtime where the
   binding is unbound.
5. Type declarations for the bindings live in
   `apps/web/cloudflare-env.d.ts` (declaration-merged into the global
   `CloudflareEnv` interface).

The dev fallback uses `NEXT_PUBLIC_<WORKER>_WORKER_URL` env vars when
set (cross-origin dev), falling back to the request host (same-origin
via `next.config.mjs` rewrites). Photo URLs and check-request preview
URLs (consumed by the browser, not the apps/web Worker) stay
URL-based — service bindings don't apply to those.

---

## Working with shared packages

- `packages/auth` - cookie helpers (`ACCESS_TOKEN_COOKIE`,
  `REFRESH_TOKEN_COOKIE` constants), session validation. Not safe to
  import in Next.js Edge runtime - duplicate the constants there if
  needed.
- `packages/db-supabase` - service-role-key Supabase client factory
  (`createServiceClient`), helpers for `user_permissions`,
  `suspicious_phones` immutability, customer-URL slug resolution
  (`getActiveLocationByCode` against pricing_simple — Brief 33), etc.
- `packages/db-d1` - D1 helpers for damage-worker. Brief 33 retired the
  D1 `locations` table; this package now scopes to claim-related tables
  only (claims, claim_photos, claim_activity_log).
- `packages/http` - `jsonError`, `isOriginAllowed` (CSRF retrofit
  helper).
- `packages/storage-r2` - R2 helpers for damage-worker. Also exports
  `ASSETS` (logo URLs) used by apps/web.
- `packages/ui` - shared React components (`ModalShell`, etc.).
  Tailwind tokens.
- `packages/types` - shared TypeScript types including
  `PricingSimpleRowWithRawPrices` with the `"pkg$"` field.
- `packages/config` - shared Tailwind config (`tailwind.base.cjs`).

---

## Glossary

- **jotform-worker** (Brief 107) - JotForm Enterprise submission ingest
  + admin read API. The ninth worker in the monorepo (JS not TS;
  mirrors fleet-inquiry-worker shape per Brief 81). Worker name on
  Cloudflare: `splash-jotform`. Path-carved on
  `splashcarwashes.info/jotform/*` (webhook) +
  `splashcarwashes.info/admin/jotform/api/*` (admin reads). Workers.dev
  only at Brief 107; production routes operator-driven. Ingests four
  JotForm forms registered in Supabase `jotform_forms` table (rewash
  `250165655616055`, salt-log `243523811897060`, retention
  `250855287972067`, time-card-edit `250193775451056`); ~50K rows
  lifetime stored in `jotform_submissions` with common filterable
  fields (`site_number` / `site` / `site_email` / `jotform_created_at`
  / `jotform_status`) promoted to columns and the rest in JSONB
  `answers`. Sync mechanism: webhook + one-time backfill. Webhook auth
  is URL-path token via `JOTFORM_WEBHOOK_TOKEN` secret (constant-time
  compare; JotForm Enterprise UI doesn't expose a signing secret per
  operator screenshot — URL secrecy is the entire auth posture). The
  webhook handler re-fetches the rich submission payload via JotForm
  API (`fetchSubmissionById`) because JotForm's webhook payload is
  flat URL-encoded; the API call has a 15s `AbortSignal.timeout`.
  Status code policy is 2xx for accepted / 5xx for retry — unknown
  form_id returns 200 to halt JotForm retries, transient upstream
  failure returns 500 to invite a retry. Submissions are upserted via
  PostgREST `?on_conflict=id` + `Prefer: resolution=merge-duplicates`
  so backfill + webhook are both idempotent. Backfill endpoint
  (`POST /admin/jotform/api/{form_id}/backfill?after_id=`) is
  super_admin-only and paginates one 1000-row JotForm API page per
  call; the operator drives the loop externally with the returned
  `last_id` until `has_more: false`. Admin read API at
  `/admin/jotform/api/*`: `GET /forms` is admin-tier (super_admin /
  admin / dcRole-admin / dcRole-super_admin) and returns enabled forms
  + COUNT-via-`Content-Range` per form; `GET /{form_id}/submissions`
  + `GET /{form_id}/submissions/{id}` + `GET /{form_id}/submissions.csv`
  accept any authenticated session and apply per-site scope via
  `accessibleSiteNumbersForSession`. super_admin / admin sees all;
  RM / RD / GM scopes by email-on-locations match against
  `locations.am_email` / `rm_email` / `site_email` via
  `getLocationsByContactEmail`. Each integer `site_number` is
  converted to BOTH zero-padded 3-digit AND unpadded string forms
  because the JotForm `typeA` widget returns site numbers as strings
  sometimes padded ("090" for Milford) and sometimes not ("127" for
  Elmira Heights). Detail endpoint anti-leak: out-of-scope row
  returns 404, not 403. CSV uses the Brief 96 schema-union pattern
  — header is the union of every `answers` key across the date range
  as `answers__{key}__answer` columns; 10000-row safety cap, 416 on
  overflow. Service binding `JOTFORM_WORKER` from apps/web. Bindings
  required: `SUPABASE_URL` + `JOTFORM_BASE_URL` (vars);
  `SUPABASE_SERVICE_KEY` + `SUPABASE_ANON_KEY` + `JOTFORM_API_KEY` +
  `JOTFORM_WEBHOOK_TOKEN` (secrets). See PRE_DEPLOY_JOTFORM.md for
  the per-form backfill loop sample + JotForm webhook URL pattern.
  Brief 109 (2026-05-11): apps/web's `/admin/jotform/*` is the
  credentialed viewer for this admin API surface — index page
  (`/admin/jotform`, admin-tier gated card grid + dashboard tile),
  per-form submissions list (`/admin/jotform/{form_id}` —
  DateRangePicker + CsvExportButton + Prev/Next pagination + meta-only
  columns; any-session gate, worker scopes via
  `accessibleSiteNumbersForSession`), and per-submission detail
  (`/admin/jotform/{form_id}/{submission_id}` — metadata grid +
  generic alphabetical-key `<dl>` over `row.answers` with type-aware
  renderer that prefers `prettyFormat` → `answer.text/value` → JSON
  pre-block + bottom-of-page Raw JSON debug `<details>`). Dashboard
  tile is the first to be visibility-gated (admin-tier only) via a
  new optional `Tile.visibleTo` field on `AdminDashboardPage`;
  RM/RD/GM users still navigate per-form URLs by direct link and the
  worker scopes their rows automatically. Adding a new JotForm form
  via SQL INSERT + backfill requires zero apps/web code changes —
  the renderer is generic over `row.answers` keys. Form-specific
  field ordering is a v2 candidate.
  Brief 110 (2026-05-11): the per-form viewer gained RD / RM /
  Location filter dropdowns (URL-driven; backed by a new
  `GET /admin/jotform/api/roster` endpoint that returns
  `{ regional_directors, regional_managers, locations, scope }` in
  one round-trip, scoped to the caller's
  `accessibleSiteNumbersForSession`) plus location → date grouped
  rendering of the current page's rows. The list and CSV endpoints
  accept three additional query params `am_email` / `rm_email` /
  `location_code` resolved via a new `src/filters.js` helper
  (`resolveLocationFilters`) — each filter resolves to a
  `Set<string>` of `site_number` strings (both padded and unpadded
  per the Brief 107 widget convention), and the result is the
  intersection of all provided filter sets AND the caller's
  accessible scope. Empty intersection short-circuits to `rows: []`
  (same as out-of-scope `site_number`). The `am_email` filter uses
  `UserAccessibleLocation.matched_via === "am_email"` to scope to
  only the AM-matched rows (mirror for `rm_email`); `location_code`
  resolves through `pricing_simple.site` → site_number. apps/web's
  `FilterBar` (`apps/web/app/admin/jotform/[form_id]/_components/`)
  narrows RM + Location options client-side when RD is selected
  (UX hint; worker re-validates either way). Grouped rendering
  buckets the current 50-row page by location → date; single-
  location pages render flat (no outer chrome — the date sub-
  headers carry the structure). Adding a new JotForm form still
  requires zero apps/web code changes — the renderer + filters are
  generic over the existing common-field columns.
  Brief 111 (2026-05-11): the per-form viewer gained a per-form
  column registry (`apps/web/app/admin/jotform/[form_id]/_lib/form-
  columns.tsx` — `FORM_COLUMN_CONFIG: Record<string, FormColumn[]>`
  keyed by `form_id`, `DEFAULT_COLUMNS` fallback for unregistered
  forms, three reusable column builders: `submittedColumn` /
  `siteColumn` / `answerColumn(key, label)`), EST-formatted
  `Submitted (EST)` column via new `apps/web/app/admin/jotform/_lib/
  format-est.ts` (uses `Intl.DateTimeFormat` + IANA `America/New_York`
  for auto-DST handling), Status column dropped (every onboarded form
  emits `"ACTIVE"` only). Adding a 5th / 6th JotForm form still needs
  zero apps/web code unless non-generic columns are wanted (the
  default `Submitted | Site` kicks in automatically). Numeric-answer
  column labels in the registry are placeholder pending operator's
  Supabase sample-row inspection — grep `REWASH_REASON_KEY` +
  `"Answer (key "` to find the label sites. The Location dropdown
  (FilterBar) + group-header label gained a defensive client-side
  `location_pretty` → `location_code` fallback when the worker's
  roster returns a postal-address-shaped value (contains comma OR
  starts with a digit); the roster worker's `row.location` fallback
  is untouched at this brief per Phase 5.3.
  Brief 112 (2026-05-12): per-form viewer content polish. Time-card-
  edit gains three per-form columns in the registry (`answerColumn`
  builders for keys 4 "Employee Name" / 5 "Reason For Edit" / 28
  "Manager Making Edits"; punch-in/out timestamp keys stay
  detail-page-only). Detail page renderer
  (`apps/web/app/admin/jotform/[form_id]/[submission_id]/page.tsx`)
  rewritten — replaced the Brief 109 alphabetical-key generic loop
  with a type-dispatched renderer in
  `_lib/answer-renderer.tsx` (`hasContent` / `orderKey` /
  `renderAnswerValue`). Dispatches on `answers[KEY].type`:
  `control_signature` → inline `<img>` from the JotForm CDN URL;
  `control_fileupload` → wrapping-link thumbnail grid;
  `control_fullname` / `control_datetime` / `control_phone` /
  `control_checkbox` → prefer `prettyFormat` (falls through to bare
  `answer` rendering when missing); default → bare `answer` string
  for textbox / textarea / radio / dropdown / email / number /
  widget. Sorts by `answers[KEY].order` (JotForm builder display
  order, not alphabetical key) and skips entries with empty
  `answer` + empty `prettyFormat` entirely — eliminates the
  em-dash spam for forms with many optional fields (time-card-edit
  PTO Day 2-5). Detail page metadata block timestamps now use
  `formatEst()` matching the list page.
  Brief 113 (2026-05-12): per-form viewer "Submitted (EST)" list
  column flipped to render the absolute EST timestamp as the primary
  cell value (e.g., "May 12, 2026, 7:25 AM EDT"); relative time
  ("5 hr ago") moves to the `title` attr for hover-on-desktop. Brief
  112's executor had left relative as the visible surface, which made
  the column header label misleading. Signature + fileupload
  renderers in `_lib/answer-renderer.tsx` retargeted from raw JotForm
  CDN URLs at a new worker-side asset proxy
  `GET /admin/jotform/api/asset?url=<encoded>` — JotForm's CDN
  rejects un-keyed hot-links, so the inline signature `<img>` was
  loading 401 from apps/web. The proxy gate is
  `authenticateForAdminApi` (any authenticated session — same posture
  as the per-form list/detail endpoints; asset URLs are opaque and
  can only be obtained by reading a row the caller already has
  access to), with anti-SSRF guardrails: target URL host must equal
  `new URL(JOTFORM_BASE_URL).host`, path must start with `/uploads/`,
  pre-existing query params on the target are dropped before the
  worker attaches `JOTFORM_API_KEY` as the `apikey` query param.
  `redirect: "manual"` + 3xx rejection blocks any future
  cross-host bounce. Streams the upstream body back with
  `Cache-Control: private, max-age=300` + `X-Content-Type-Options:
  nosniff`. 503 when `JOTFORM_API_KEY`/`JOTFORM_BASE_URL` unbound;
  400 on bad input; 502 on upstream error; 404 when upstream 404s;
  10s `AbortSignal.timeout`. apps/web `assetProxyUrl(jotformUrl)`
  helper in `_lib/worker-fetch.ts` builds the same-origin proxy URL
  for renderer use.
  Brief 114 (2026-05-12): `parseJotformDate` in
  `apps/jotform-worker/src/normalize.js` now treats JotForm's
  `"YYYY-MM-DD HH:MM:SS"` input as `America/New_York` wall-clock and
  emits a true UTC ISO 8601 string (DST-aware via
  `Intl.DateTimeFormat` `shortOffset` token). Replaces the Brief 107
  behaviour that stamped EDT/EST wall-clocks as `Z` (UTC), producing
  4-hr / 5-hr offsets on the apps/web `formatEst()` display layer.
  Brief 111 had picked the display-only "option (a)" path based on a
  sample row whose `+00:00` suffix was the bug's PRIOR output, not
  JotForm input; Brief 114 corrected the storage side at ingest.
  Display layer (`formatEst()`) is unchanged. DST-ambiguous-hour
  edge case (2-3 AM on spring-forward/fall-back Sundays) accepted
  as a 1-hour drift on those rare rows per the helper docblock.
  Existing rows fixed via operator re-running each form's backfill
  endpoint post-deploy (`POST /admin/jotform/api/{form_id}/backfill`
  paginated by `offset`); upsert is idempotent
  (`on_conflict=id` + `Prefer: resolution=merge-duplicates`).
  Brief 115 (2026-05-12): JotForm viewer comprehensively
  restructured. (1) Worker `handleListSubmissions` dispatches on two
  new query flags: `?count_only=1` returns
  `{ total_rows, from, to, scope }` only (single COUNT via
  `Prefer: count=exact`); `?group=location` returns
  `{ groups: [{site, site_number, rm_email, rm_name, count, rows}],
  total_rows, cap_reached, from, to, scope }` with rows
  alphabetically grouped by site (case-insensitive),
  `GROUPING_SAFETY_CAP = 2000` rows ceiling, oldest-dropped-first on
  overflow. RM info pre-resolved via a new `fetchRmRosterMap(env)`
  helper that joins `locations.site_number` →
  `regional_manager`/`rm_email`. Legacy paginated shape preserved for
  back-compat but apps/web no longer uses it. `db.js`'s
  `listSubmissions` gained an `exactCount` flag toggling
  `Prefer: count=estimated` ↔ `count=exact`. (2) Worker
  `parseDateRange` default flipped from "last 30 days UTC" to "today
  EST" (DST-aware via new `todayInEastern()` + `easternWallClockToUtcMs()`
  helpers mirroring Brief 114's `Intl.shortOffset` probe pattern).
  (3) Asset proxy (`handleAssetProxy`) widened to fix Brief 113's
  leftover signature-broken bug: host allow-list = JOTFORM_BASE_URL
  host OR `www.jotform.com` (Enterprise sometimes serves widget
  assets against the public host); path-prefix allow-list = `/uploads/`
  + `/widget-uploads/` + `/server.php`; auth posture sends `APIKEY`
  HTTP header in addition to `?apikey=` query param (documented
  JotForm asset auth pattern). New `fetchJotformAssetFollowingRedirects()`
  helper manually follows up to 3 redirects, validating each hop
  stays on the allow-listed host set (Brief 113's `redirect: "manual"`
  + 3xx-reject was dropping legitimate JotForm CDN bounces).
  Pre-existing query params on the target are now augmented rather
  than dropped. (4) Roster handler
  (`apps/jotform-worker/src/handlers/roster.js`) `location_pretty`
  resolution chain is now `pricing_simple.location_pretty` →
  `pricing_simple.location_code` → `Site {site_number}` placeholder
  — NEVER falls back to `locations.location` (postal address).
  Closes the bug class Brief 111 patched with a client-side
  address-shape heuristic in FilterBar; that heuristic is removed.

- **JotForm submissions** (Brief 107) - The four onboarded JotForm
  forms (rewash, salt-log, retention, time-card-edit) all share a
  common subset of answer field names that the worker promotes to
  `jotform_submissions` columns: `name === "typeA"` → `site_number`
  (widget; returns string sometimes padded "090" / sometimes
  unpadded "127" — both forms accepted in the permission gate),
  `name === "site"` → `site` (textbox), `name === "siteEmail"` |
  `name === "siteEmail56"` → `site_email` (retention has both —
  email-typed `control_email` preferred when present, fall back to
  text). Noise types stripped at ingest before storing the JSONB
  `answers` payload: `control_head`, `control_pagebreak`,
  `control_button`, `control_text` — these are form-definition
  metadata (headings, page breaks, button labels, text blocks)
  carrying no `answer` property. Retention's full payload drops from
  ~20 KB raw to ~3-5 KB stripped. Onboarding a new form (#5 / #6 per
  operator-confirmed cap): `INSERT INTO jotform_forms` + run a
  backfill + configure the webhook in JotForm's Integrations panel.
  No code change required.
  Brief 113 (2026-05-12): apps/web's per-submission detail page
  loads signature + fileupload assets via a same-origin worker proxy
  `GET /admin/jotform/api/asset?url=<encoded>` (auth same as the
  per-form list/detail endpoints; host-validated against
  `JOTFORM_BASE_URL` + path-prefix-validated against `/uploads/`;
  attaches `JOTFORM_API_KEY` as `apikey` query param; streams body
  back with `Cache-Control: private, max-age=300`). JotForm's CDN
  rejects un-keyed hot-links — `<img src=jotform.com>` returned 401
  cross-origin from apps/web. See the jotform-worker glossary entry
  for the full request/response shape + SSRF guardrails.
  Brief 115 (2026-05-12): JotForm viewer (`/admin/jotform/[form_id]`)
  comprehensively restructured. Default date range is now today EST
  (was last 30 days). Render model is full-scope alphabetical
  grouped — every row in scope renders in one page load (no row
  pagination), grouped by site case-insensitive, with accurate per-
  site counts in headers; 2000-row safety cap with amber banner on
  overflow. Role-aware count-only gate: admin/super_admin with no
  filter ALWAYS sees a count-only tile (regardless of date range);
  RM/RD/GM with today-only sees grouped view immediately; RM/RD/GM
  with date range beyond today + no filter sees count-only with
  "Narrow date range or apply a filter" copy. Brief 110's per-page
  grouping (counts were lies — a 4-rewash site showed "2
  submissions" when the other 2 were on later pages) and Brief 110's
  per-day date sub-headers both retired — a "today only" default
  + accurate full-scope counts make sub-bucketing unnecessary.
  Location dropdown now uses `pricing_simple.location_pretty` →
  `pricing_simple.location_code` → `Site {site_number}` per the
  Brief 115 roster handler fix; Brief 111's client-side
  address-shape heuristic in FilterBar.tsx is removed (dead code
  post-Brief-115). Asset proxy fix lands here too — see the
  jotform-worker glossary entry for the host/path/header widening.

- **forms-worker** (Brief 89) - Public form-render surface + admin
  builder API for the form-builder feature. The eighth worker in the
  monorepo. Path-carved on `splashcarwashes.info/forms/*` (planning
  Decision 2 — chosen over subdomain for cookie + CSV simplicity;
  fleet's subdomain choice in Brief 82 was specific to its
  verbatim-lifted `/api/*` collisions). Worker name on Cloudflare:
  `splash-forms`. Bindings: `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`
  (writes to forms tables — service key required); `TURNSTILE_SITE_KEY`
  + `TURNSTILE_SECRET_KEY` (public-audience forms only);
  `FORMS_SUBMISSION_WEBHOOK_URL` (PA notification, fail-soft when
  unbound); `FORMS_FILES` R2 bucket (`splash-forms-files` — owns both
  `form-assets/` and `form-submission-files/` namespaces). Service
  binding `FORMS_WORKER` from apps/web. Brief 97 wires the daily
  cleanup cron (orphan R2 objects, 11:00 UTC — picked to not collide
  with damage 13:00 / workorders 11:30). The `[observability.logs]`
  block from Brief 63 is included from day one. Brief 89 lands the
  scaffolding (schema + worker skeleton + `@splash/forms-schema`
  package + service binding + `resolveLookup` stub); user-visible
  endpoints land in Brief 90+.
  Brief 90 wired the public render path (`GET /forms/{slug}`).
  Per-field-type renderers live under
  `apps/forms-worker/src/render/fields/` (one module per type, 16
  total) with a discriminator `switch` in `render/fields/index.ts`.
  Adding a 17th field type means: (1) new interface in
  `packages/forms-schema/src/types.ts` extending `FieldBase` and
  added to the `Field` discriminated union; (2) new Zod schema in
  `packages/forms-schema/src/validators/field-config.ts` added to
  `fieldSchema`'s discriminated union; (3) new render module in
  `apps/forms-worker/src/render/fields/`; (4) new dispatch case in
  `render/fields/index.ts` (TypeScript catches forgotten branches);
  (5) corresponding builder-side renderer + inspector in
  `apps/web/app/admin/forms/[id]/_field-types/` (Brief 95). Audience
  gating at render time per planning Decision 8: `public` skips auth
  and renders Turnstile (verification deferred to submit time),
  `internal` does a render-time cookie-presence check on
  `sb-access-token` and 302s to `/login?next=...` on miss (full
  session validation deferred to submit time per Decision 8b),
  `link-only` treats the slug as the gate. The render path reads
  `forms` + `form_versions` per request via direct PostgREST `fetch()`
  with `SUPABASE_SERVICE_KEY` (matches the Brief 71
  `maintainx-users.ts` helper pattern — no `@supabase/supabase-js`
  client in worker code); `formSchemaSchema.safeParse` is the
  runtime boundary check that prevents a hand-edited
  `form_versions.schema` JSONB from breaking the render path. No
  edge caching at v1 — every render reads fresh so re-publishing a
  form takes effect immediately. Test-form fixtures at
  `supabase/forms-test-data.sql` (one form per audience) — operator
  runs after `forms-tables.sql` and before smoke testing.
  Brief 92 wired file + signature uploads. Out-of-band upload pattern
  per planning Decision 1's X-shape: client uploads each file/signature
  immediately on change/stroke (POST `/forms/api/upload/{slug}` or
  `/forms/api/signature/{slug}`); the worker writes to R2 at
  `form-submission-files/{form_id}/{pending_submission_id}/{field_key}/{filename}`
  and returns `{r2_key, mime, size_bytes, original_filename}` (file)
  or `{r2_key, format, size_bytes}` (signature). The renderer's hidden
  input carries the r2_key forward; at submit time the form body
  contains only references, not the file bytes. Submit handler HEADs
  every reference against R2 to confirm existence + authoritative
  size/mime, enforces per-submission ceilings (HARD_LIMITS in
  `apps/forms-worker/src/limits.ts`: 25 MB per file, 100 MB per
  submission, 20 files per submission, 1 MB per signature), enriches
  the payload before validation, then inserts `form_submission_files`
  rows after the canonical `form_submissions` row lands (best-effort —
  failure leaves R2 objects without DB rows for Brief 97's orphan
  cleanup to sweep). MIME sniffing via `file-type@^19.6.0` (~12 KB,
  MIT) — first ~4 KB of every upload is read; client `Content-Type`
  is ignored. The `pending_submission_id` (from Brief 90's renderer
  hidden input) becomes `form_submissions.id` on submit, lining up
  R2 paths with the submission row's id automatically.
  `signature_pad@4.2.0` (~12 KB, MIT) is vendored as a checked-in
  static asset (`apps/forms-worker/static/signature-pad.min.js`,
  SHA-256 `49050fd4c2a4c66eff11a54f2552af743bb0681cde745760667c61e9c690b3e0`)
  and bundled into the worker via wrangler `[[rules]] type = "Text"
  globs = ["**/static/*.js"]` — the `**/` prefix is required (a bare
  `static/*.js` glob does NOT match against the worker's source
  resolution and the default ESM rule wins). NOT loaded from CDN per
  CLAUDE.md supply-chain posture. The companion client-side wiring
  (`forms-public.js`) is bundled the same way; both serve from
  `/forms/api/static/{filename}` with `public, max-age=86400`. Admin
  serve route at `/forms/admin/api/files/{r2_key}` is super_admin /
  admin only (`@splash/auth authenticate()`, mirrors Brief 83's fleet
  admin gate); inline-displays images and force-downloads everything
  else. Daily cron in Brief 97 cleans orphaned R2 objects (>24h, no
  matching `form_submissions.id`).
  Brief 93 wired the lookup mechanism. `resolveLookup()` in
  `@splash/db-supabase/lookup.ts` is the single source of truth for
  resolution; both `POST /forms/api/lookup/{slug}` (render-time
  client-driven, used by `forms-public.js` to populate dependent
  fields when the key field changes) and the submit handler's
  re-resolve loop (canonical server-side per planning Decision 5a.ii)
  call it. The two-hop join — `pricing_simple → locations` via
  `pricing_simple.location_code → pricing_simple.site →
  locations.site_number` — is hidden inside the helper; callers
  specify `sourceTable: 'locations'` and `keyColumn:
  'pricing_simple.location_code'` and the helper does the rest. The
  Brief 62 fix (the `getMaintainXLocationId` join-key correction)
  applies here too: `locations.site_number` is the right join column,
  NOT `locations.site` (which is the location name). Server
  re-resolves at submit even when the client supplied a value —
  defense against tampering AND handles mid-fill data drift. Drift
  is logged with `[forms.lookup] drift detected at submit` for
  auditability. Three render shapes per Decision 5a:
  `prefill_hidden` → `<input type="hidden">` (no UI, value
  round-trips silently); `prefill_visible` → disabled `<input
  type="text">` populated visibly when the key changes;
  `display_only` → styled `<div>` callout, no input, no payload
  entry (submit drops the key). `nullBehavior === "block_submit"`
  + required + null fresh value returns 422
  `{error: "lookup_failed", fields: {...}}` and rejects the
  submission. Caching: none — sub-10ms point reads on indexed columns.
  Brief 94 wired the admin API. Endpoint inventory at
  `/forms/admin/api/*`: `GET /forms` (list w/ status + search),
  `POST /forms` (create), `GET /forms/{id}` (detail incl. draft schema
  + version history), `PATCH /forms/{id}/draft` (save draft, Zod-
  validated against `formSchemaSchema`), `POST /forms/{id}/publish`,
  `POST /forms/{id}/unpublish` (→ archived), `POST /forms/{id}/republish`
  (→ published from archived), `POST /forms/{id}/assets` (upload in-form
  display image; multipart, JPEG/PNG/GIF/WebP only, 10 MB cap),
  `DELETE /forms/{id}/assets/{assetId}`, `GET /lookup-sources` (returns
  Brief 89's LOOKUP_SOURCES registry). Auth gate (in
  `apps/forms-worker/src/admin/auth.ts`): `session.role ===
  "super_admin"` OR `session.dcRole === "admin"|"super_admin"` — same
  posture as fleet (Brief 83). Per-location scoping deferred to v2
  (planning Decision 7). Service-key-unbound returns 503 uniformly;
  CSRF defense via `isOriginAllowed` on every POST/PATCH/DELETE.
  Lifecycle (B-classic, planning Decision 1): draft (mutable) →
  published (immutable, current_version_id pinned) → archived (no
  public render, submissions retained). **Publish creates a new
  immutable version row AND spawns a fresh editable draft (clone of
  just-published)** — operator can immediately start editing v(N+1)
  without losing v(N) as the public-facing version. Atomicity: 3-call
  create + 4-call publish are sequential PostgREST writes (no
  transaction wrapper); rely on Brief 89's DEFERRABLE FKs from forms
  → form_versions. Partial-failure recovery is via SQL only — flagged
  on the next admin GET (orphan form with NULL draft_version_id, or
  dangling current_version_id pointing at a non-draft with no new
  draft spawned). No Delete endpoint — destructive ops via SQL only
  (planning Decision 7); CASCADE FKs on form_versions / form_assets /
  form_submissions / form_submission_files mean a `DELETE FROM forms
  WHERE id = ...` is safe. The `apps/web/app/admin/forms/_lib/worker-
  fetch.ts` helper centralizes all SSR calls into `splash-forms` via
  the `FORMS_WORKER` service binding with URL fallback for `next dev`
  (Brief 17 pattern). `@splash/forms-schema` was added as an apps/web
  dep here (workspace ref) so future builder UI in Brief 95 has the
  full type contract.
  Brief 95 wired the admin builder UI on apps/web. Pages:
  `/admin/forms` (list), `/admin/forms/new` (create), and
  `/admin/forms/[id]` (3-column builder — palette / canvas / inspector).
  State via `useReducer` in
  `apps/web/app/admin/forms/[id]/_builder/reducer.ts` (9 actions:
  add_field, remove_field, duplicate_field, reorder_field,
  update_field_config, update_form_meta, select_field, clear_selection,
  mark_clean). Drag-to-reorder via `@dnd-kit/core` +
  `@dnd-kit/sortable`. Field IDs and key suffixes via `nanoid(8)` /
  `nanoid(6)`. Per-field-type folder structure under
  `apps/web/app/admin/forms/[id]/_field-types/{type}/{Renderer.tsx,
  Inspector.tsx, index.ts}` — adding a 17th type means: (1) new folder
  under `_field-types`, (2) re-export + entry in `FIELD_TYPE_REGISTRY`
  in `_field-types/index.ts`, (3) interface in
  `@splash/forms-schema/src/types.ts`, (4) Zod schema in
  `validators/field-config.ts`, (5) Zod payload schema in
  `validators/payload.ts`, (6) public renderer in
  `apps/forms-worker/src/render/fields/` (Brief 90 dispatcher).
  TypeScript catches forgotten registry branches via
  `defaultConfigFor(type)` throwing on unknown. Save Draft + Publish
  are server actions (`apps/web/app/admin/forms/[id]/actions.ts`) that
  wrap the SSR `worker-fetch.ts` helpers because BuilderClient is a
  client component and can't import `next/headers` directly.
  KeyEditor enforces the snake_case regex `^[a-z][a-z0-9_]*$` by
  sanitizing on every keystroke (lowercase + strip non-alphanumeric +
  drop leading non-letters). Beforeunload warning when dirty.
  FormsAdminTabs at `apps/web/app/admin/forms/_components/` mirrors
  SignupAdminTabs (Brief 56). NoAccessCard sibling component covers
  signin + forbidden states. Same admin gate as fleet (Brief 83):
  `session.role === "super_admin"` OR `session.dcRole === "admin"` OR
  `session.dcRole === "super_admin"` — gates page, worker re-validates
  on PATCH/POST. Form-meta editing in the right-panel inspector is
  client-only at v1; only `schema.fields` is persisted by the
  PATCH /draft endpoint Brief 94 exposed. Title/audience/webhook
  toggles in the inspector and TopBar title input are visible but
  non-persistent until a future brief widens the admin endpoint. New
  apps/web deps introduced here: `@dnd-kit/core@^6.1.0`,
  `@dnd-kit/sortable@^8.0.0`, `nanoid@^5.0.0`. Bundle: route-specific
  chunk 25.8 kB / First-Load 131 kB on `/admin/forms/[id]` —
  comfortably under the 150 kB target.
  Brief 96 wired the submissions admin surface. Three apps/web pages —
  `/admin/forms/[id]/submissions` (DateRangePicker + status filter +
  submitter-kind filter + CSV export button — meta-only columns:
  Submitted at / Status / Submitter / Splash Notes preview / Version /
  View →), `/admin/forms/[id]/submissions/[subId]` (ActionForm with
  Status dropdown + Splash Notes textarea + Save submitting both via
  the Brief 19 pattern; payload renders against the submission's
  specific version's schema; metadata grid below), and
  `/admin/forms/[id]/versions` (audit-trail table — Version / Status
  pill / Published at / Published by / Field count / Submission count;
  no diff renderer at v1 per planning Decision 7). Worker endpoints
  under `/forms/admin/api/forms/{id}/submissions{,.csv,/{subId}}` and
  `/versions`; CSRF defense on PATCH via `isOriginAllowed`; 403/404
  scoping via `(form_id, submission_id)` tuple — admin can't update a
  submission belonging to a different form by guessing the UUID. CSV
  export is **schema-union across all versions in the date range** —
  header is the union of every field key ever used (display-only
  `heading` / `image` skipped), rows have empty cells where a key
  doesn't exist on a given submission's version. Same-origin URL
  works because forms is path-carved (Brief 89 / Decision 2) — no
  Brief 88-style proxy route needed. Status enum (`new` /
  `in_progress` / `closed`) + splash_notes mirror fleet Brief 87
  (last-write-wins; the `status_updated_{at,by}` /
  `splash_notes_updated_{at,by}` columns from the Brief 89 schema get
  stamped automatically on each PATCH). Past submissions render
  against THEIR version's schema, NOT the form's current — versioning
  protects historical data. PayloadRenderer dispatches per field type:
  text/email/phone/etc render plain; multi-line strings render in a
  `<pre>` block; dropdown/multi map values to labels; lookup gets a
  `(resolved from <key field label>)` annotation; file/signature
  entries thumbnail-display image MIME inline (via
  `/forms/admin/api/files/{r2_key}` Brief 92 serve route) and link
  for non-image MIME; "Other payload entries" appendix renders any
  payload key not present in the version's schema (defense against
  schema drift / hand-edited JSONB). PostgREST list embed is
  `version:form_versions!inner(version_number)` (one-to-many FK
  embeds as a single nested object, not array — confirmed against
  the actual response shape).
  Brief 97 wired the submission webhook + daily R2 cleanup cron.
  Webhook secret: `FORMS_SUBMISSION_WEBHOOK_URL` (worker-level,
  optional, fail-soft when unbound — same posture as damage-worker's
  `CUSTOMER_CLAIM_WEBHOOK_URL` per Brief 32 / 48). Per-form opt-out
  via `forms.notify_webhook = false`. Files-by-URL in payload (NOT
  base64 — planning Decision 6): each file/signature entry carries
  `download_url` pointing at `/forms/admin/api/files/{r2_key}`
  (Brief 92 admin-gated serve route). PA fetches via the URL when
  needed. 15s `AbortController` timeout; non-2xx logs `[forms.webhook]
  non-2xx response: <status>`; thrown errors log `[forms.webhook]
  fire failed (fail-soft)`. Fired via `ctx.waitUntil` after
  submission insert succeeds (does NOT block the response). Skipped
  on idempotent re-submits — only `inserted.wasNew === true` fires
  the hook (so a network retry never delivers duplicate PA
  notifications). Worker default export now `{ fetch, scheduled }`;
  the scheduled handler runs `runDailyCleanup` at 11:00 UTC
  (`[triggers] crons = ["0 11 * * *"]` in
  `apps/forms-worker/wrangler.toml`), picked to NOT collide with
  damage-worker's daily summary at 13:00 UTC (Brief 65) or
  workorders-worker's MaintainX sync at 11:30 UTC (Brief 71). Two
  passes: orphan submission files
  (`form-submission-files/{form_id}/{pending_submission_id}/...`,
  >24h, no matching `form_submissions.id`) and orphan form assets
  (`form-assets/...`, >1h grace, no matching `form_assets.r2_key`
  row). Hard pagination caps (50 pages × 1000 = 50K submission
  files; 20 pages × 1000 = 20K assets) prevent runaway in
  pathological cases — surviving orphans get swept on the next
  day's run. Logs `[forms.cleanup] complete` with
  `submissionFilesDeleted` / `assetsDeleted` /
  `submissionPagesScanned` / `assetPagesScanned` / `errorCount` on
  every run. Workers Logs's `[observability.logs]` block from
  Brief 89 covers scheduled invocations automatically (eventType:
  scheduled in CF dashboard). The `inferAdminBase` helper inside
  `submit/webhook.ts` rewrites `*.workers.dev` request origins to
  `https://splashcarwashes.info` so the `splash_admin_url` link in
  the PA payload always points at production apps/web (operators
  click these from email — staging/workers.dev URLs would 404 for
  recipients). Staging hostname (`staging.splashcarwashes.info`)
  passes through unchanged.
  Brief 99 added `GET /forms/api/visible-to-me` — credentialed-user
  discovery endpoint backing the apps/web `/forms` index page. Any
  valid session can call it; v1 returns `status='published' AND
  audience='internal'` rows only. Endpoint name is intentionally
  semantic ("visible to me") so a future per-role / per-location
  visibility model is an additive filter inside the handler with no
  contract change. Pairs with the apps/web `/forms` top-level page
  (server-rendered cards grid, alphabetical by title) gated by
  middleware on `sb-access-token` cookie presence; per-form audience
  re-checks happen at click-through on the worker render path
  (Brief 90).
  Brief 100 added `?audience=public|internal|link-only|all` to the
  list endpoint (worker-side validation enforces the allow-list; bad
  values return 400 `bad_audience`). The `/admin/forms` page exposes
  it as a third dropdown alongside Status and Search. Each published
  row also gets a "Copy link" button (`CopyLinkButton` client island)
  that copies the public form URL to clipboard using
  `navigator.clipboard.writeText` with a `window.prompt()` fallback
  for locked-down browsers. Unpublished rows show an em-dash — only
  published forms have a working `/forms/{slug}` URL.
  Brief 118 (2026-05-13) added a credentialed-admin submissions index
  on apps/web at `/admin/forms/submissions` (admin-tier gated; mirrors
  the Brief 109 JotForm index card grid) — card-per-form with status
  pill + running submission count, drill-through to Brief 96's per-form
  `/admin/forms/[id]/submissions` viewer. Drafts filtered out (no
  public URL → no submissions). No new worker endpoint — reuses
  Brief 94's `GET /forms/admin/api/forms` (the existing list response
  already carries `submissionCount`). The dashboard Submissions-group
  "Forms" tile retargeted to this page (was pointing at `/forms` —
  Brief 99's fill-out index, which other Submissions-group tiles
  didn't match in intent); tile `visibleTo` tightened to admin-tier
  to match the underlying worker contract. Forms-worker post-submit
  confirmation page (`apps/forms-worker/src/submit/success.ts`) gained
  three CTAs in place of the lone "Fill out another" link: primary
  "Back to Forms" (→ `/forms`), secondary "Dashboard" (→
  `/admin/dashboard`, rendered ONLY for `audience: "internal"` forms
  since non-authed visitors on public / link-only would just bounce
  to `/login`), tertiary "Fill Out Another" (→ `/forms/{slug}`,
  unchanged behavior). Splash-navy header bar with white-script logo
  was already on the success page; only the action area changed.
  Brief 119 (2026-05-13) flipped the per-form submissions viewer
  (`/admin/forms/[id]/submissions`) to a wide-column table by default
  — every schema-union field across versions in the date range gets
  its own column, so operators see all answers inline instead of
  clicking through to `[subId]` per row. Compact view (Brief 96's
  prior narrow meta-only renderer) is preserved as the fallback via
  `?view=compact` URL param + `localStorage["forms.submissions.view"]`
  persistence (URL param wins when explicit; localStorage is the
  default for subsequent visits). Worker change: `GET /forms/admin/api/forms/{id}/submissions`
  accepts `?include=payload` — when set, each row carries the full
  `payload` JSONB, `form_version_id`, and a `version: { id,
  version_number, schema }` embed (the existing `form_versions!inner`
  FK join widened from `(version_number)` to `(id,version_number,schema)`;
  no extra round-trip). Default shape is back-compat. apps/web new
  components under `_components/`: `AnswerCell.tsx` (per-field-type
  cell renderer; long text truncates to 80 chars with hover-tooltip,
  file/signature thumbnails inline via `/forms/admin/api/files/{r2_key}`
  read from the payload's own `r2_key` references — Brief 92 enriches
  the submit payload with `r2_key`/`mime`/`size_bytes`/`original_filename`,
  so no separate `form_submission_files` join is needed for the table
  view), `ViewToggle.tsx` (client island writing to localStorage +
  `router.push(?view=...)`); new `_lib/schema-union.ts` computes the
  column union ("most recent version's fields in schema order, then
  older-version-only fields alphabetical"). Display-only `heading` /
  `image` skipped. Detail page (`[subId]/page.tsx`) and
  `PayloadRenderer` untouched — focused-review surface stays full-
  fidelity. Sticky meta columns (Submitted / Status / Submitter /
  Splash Notes / Version) + sticky first column + sticky header in
  the wide table; cells outside a row's own version schema render a
  muted `—` with `title="Not part of v{N} schema"`.
  Brief 122 (2026-05-13) added localStorage autosave + resume banner
  to the public form-render path (`forms-public.js`). Autosave is
  debounced 500 ms on every `input`/`change` bubbled to the form
  root; values persist to `localStorage["forms.draft.{slug}"]` with
  `{values, pendingSubmissionId, savedAt}`. On page load, a <30-day
  draft renders an amber banner above the first field with Resume /
  Discard buttons; stale drafts (>30 days) get cleared silently.
  Resume restores values AND the saved `pending_submission_id` so
  prior OOB-uploaded files / signatures in R2 stay linked to the
  form. File / signature `<canvas>` / `<input type=file>` visible
  state is NOT restored (only the hidden `_r2` companion is), so
  operators see a blank canvas / file picker next to a restored
  r2_key. The Brief 92 `wireSignature` / `wireFile` upload handlers
  read `pending_submission_id` lazily inside the upload closure via
  a `currentPendingId(formEl)` helper, so a resume that rewrites the
  hidden input flows through to new uploads transparently. Clear-on-
  submit is via a `submit` event listener that calls `clearDraft`
  optimistically before the browser navigates (option B from the
  brief). Trade-off: a rare 422 validation_failed loses the draft;
  user can hit Back to recover DOM state from bfcache. Per-browser-
  per-device (no server-side draft table); staging.splashcarwashes.info
  and splashcarwashes.info don't share localStorage, which is the
  intended isolation. Future executors shouldn't accidentally break
  the contract: the autosave watches every named input via event
  bubbling on the form root, so adding a new field type doesn't
  require touching the autosave path (as long as the renderer uses
  a real form input with a `name`). New field types that don't fit
  the standard `<input>` / `<select>` / `<textarea>` mold need
  their own persistence story (signature + file are the prior art).
  Brief 120 (2026-05-13) added an optional `workflow` block to
  `form_versions.schema` — per-form approval flows. Schema shape:
  `{default_stage, stages: [{id, label, approver_source, transitions:
  [{to, label, requires?}]}]}`. Three `ApproverSource` types ship:
  `site_role` (reads `am_email`/`rm_email`/`site_email` from
  `pricing_simple` via Brief 101's `getLocationContactInfo`, keyed
  off the form's Location field's payload value — the location_code
  slug); `static_emails` (form-builder allow-list); `payload_field`
  (reads approver email from a form field at submission time). Three
  new `form_submissions` columns added by operator SQL:
  `workflow_stage text` (current stage id; null when version has no
  workflow), `workflow_history jsonb default '[]'` (append-only
  audit array, one entry per transition), `current_approver_emails
  text[] default '{}'` (denormalized email list for Brief 121's
  "pending for me" GIN-indexed dashboard query). The submit handler
  seeds both `workflow_stage = workflow.default_stage` and pre-
  resolves `current_approver_emails` for the default stage on
  insert. Worker endpoint `POST /forms/admin/api/forms/{id}/
  submissions/{subId}/transition` accepts `{to, note?, typed_name?,
  signature_r2_key?}`; auth = any session, per-stage authority is
  gated against `current_approver_emails` (super_admin / admin tier
  bypass as escape hatch). Per-transition `requires` block (note /
  typed_name / signature booleans) enforced server-side; missing
  required fields return 400 `missing_required` with `missing[]`.
  Builder UI: `Inspector` renders a `WorkflowEditor` below the form-
  meta panel when no field is selected — Enable/Disable toggle,
  default-stage dropdown, per-stage card with id/label inputs,
  `ApproverSourceEditor` (radio + type-specific sub-form), per-
  transition row, move-up/down + remove. Submission detail page:
  `WorkflowSection` renders current stage + per-transition buttons
  (disabled with title-attr hint when caller is not an approver) +
  inline `requires` modal (Brief 19 `<ActionForm>` pattern) +
  vertical history timeline (mirrors damage activity log).
  Workflows are versioned with the form — a submission against v2
  follows v2's workflow forever, even if v3 changes the stages.
  Signature canvas wiring on the admin transition modal punted to
  Brief 121; v1 accepts an existing `signature_r2_key` text input.
  Notification webhook fire on transition deferred to Brief 121.
  Department-approver source + conditional transitions deferred to
  v2 per the brief's out-of-scope section. Strict publish-time Zod
  validator (`formSchemaSchema.superRefine`) enforces no-duplicate-
  stage-ids, `default_stage` references a real stage, every
  `transition.to` references a real stage, and `payload_field
  .field_key` references a real form field; draft variant relaxes
  these so the operator can save a mid-build workflow. Future
  executors adding a new approver source: (1) extend `ApproverSource`
  union in `packages/forms-schema/src/types.ts`; (2) extend the
  discriminator in `validators/field-config.ts` (both strict +
  draft); (3) add a case to `resolveApproverEmails` in
  `apps/forms-worker/src/workflow-resolution.ts`; (4) add a radio +
  sub-form in `apps/web/app/admin/forms/[id]/_builder/
  WorkflowEditor.tsx`'s `ApproverSourceEditor`.
  Brief 123 (2026-05-13) shipped a builder UX overhaul on top of
  Brief 120's editor: stage rows now key off a stable `_uiKey`
  (nanoid) so the Stage ID / Display Label / Transition Label inputs
  retain focus across keystrokes (Brief 120's keying-on-`stage.id`
  unmounted the row on every rename keystroke); new
  `workflow_rename_stage` reducer action does the atomic cascade from
  `stage.id` rename into `default_stage` + every `transition.to` in
  the workflow; the Stage ID input sanitizes snake_case per the
  Brief 95 `KeyEditor` pattern and refuses to commit a rename that
  collides with another existing stage's id; new transitions default
  to `"Move to {dest.label}"` (dropped Brief 120's `"Advance"`
  literal); `workflow_enable` seeds three stages by default —
  `approval` (default; `site_role: rm_email`; Approve → approved +
  Decline → denied transitions) plus terminal `approved` + `denied`
  stages — instead of a single confused self-loop stub. Terminal
  stages render with a slate `TERMINAL` pill, muted background,
  suppressed ApproverSource picker (replaced with a "Make approval
  step" CTA), and a disabled "+ Add transition" button; the default
  stage gets a `START` pill. Destination dropdowns disable the
  current stage as an `<option disabled>` with a `"(current — cannot
  self-transition)"` suffix; existing self-transitions surface a
  red-bordered `<select>` + inline hint. A new
  `WorkflowMermaidPreview` client island below the stages list
  renders a live `flowchart LR` of the workflow graph (lazy-loaded
  via `next/dynamic({ ssr: false })` so Mermaid's ~250 KB bundle
  code-splits to a separate chunk that only ships to operators
  opening `/admin/forms/[id]`; 300 ms debounce on re-renders;
  default-stage gets a `START · ` node-label prefix; terminal nodes
  get a muted slate fill via `classDef terminal`). Strict
  publish-time `formSchemaSchema.superRefine` extended with new Zod
  issues for orphaned approval stages (approver set, no transitions
  — and the mirror: transitions exist but no approver), unreachable
  terminals (BFS from `default_stage`), and self-transitions. The
  draft validator stays relaxed so operators can save mid-build.
  `WorkflowStage.approver_source` is now optional (`?:`) at both the
  TypeScript and Zod layers — terminal stages omit it cleanly; the
  worker (`submit/index.ts` default-stage seed; `admin/submissions.ts`
  `handleTransition` current + destination guards) skips
  `resolveApproverEmails` when missing and stamps
  `current_approver_emails = []`. New `mermaid@^11.4` workspace dep
  on `@splash/web`. New `stripBuilderArtifacts(workflow)` helper in
  `_builder/reducer.ts` defensively drops `_uiKey` from the schema
  before `saveDraftAction` sends to the worker (Zod's default
  `.strip()` would handle it anyway, but the call site documents
  intent).
  Brief 121 (2026-05-13) added the Pending Approvals dashboard surface
  + daily digest cron on top of Brief 120's `current_approver_emails`
  denormalization. New worker endpoint
  `GET /forms/admin/api/pending-approvals` (any-session auth; `?all=1`
  admin-tier widens scope to every pending approval in the org) —
  returns `{items, total, scope, caller_email, limit_hit}` with each
  item carrying `submission_id`/`form_id`/`form_title`/
  `workflow_stage`/`stage_label` (resolved server-side from the row's
  version schema)/`current_approver_emails`/`submitter_email`/
  `submitter_kind`/`submitted_at`/`location_code`/`review_path`. 500-
  row safety cap; uses PostgREST `cs.{email}` against the GIN-indexed
  `current_approver_emails` column for fast "pending for me" lookup.
  New apps/web `/admin/approvals` page (any authenticated session;
  worker query naturally returns empty for non-approvers) groups
  items by form (forms with more items float; alphabetical
  tie-break), renders per-row Stage pill / submitter / submitted-at
  relative / Review → button linking to Brief 96's detail page;
  admin-tier "Mine / All Approvals" toggle for ops oversight. New
  "Pending Approvals" tile in the dashboard Operations group
  (`anySession`). Daily digest cron at 12:00 UTC: queries every
  `form_submissions` row with non-empty `current_approver_emails`,
  groups by approver email × form_id, fires one POST per recipient
  to optional `FORMS_APPROVAL_DIGEST_WEBHOOK_URL` with payload
  `{recipient_email, total_pending, by_form: [{form_id, form_title,
  count, oldest_submitted_at}], dashboard_url}`. Single PA flow for
  the entire forms feature — adding new workflows automatically
  participates, zero PA work per new form. Fail-soft per recipient
  (15s timeout, swallow non-2xx, `[forms.approval-digest]` log).
  When secret unbound the cron logs would-fire counts and skips
  the POST. Worker `scheduled` handler now dispatches on
  `event.cron` literal — `"0 12 * * *"` runs the digest, anything
  else (including Brief 97's `"0 11 * * *"` cleanup) falls through
  to the cleanup pass. `wrangler.toml` `[triggers] crons` widened
  from `["0 11 * * *"]` to `["0 11 * * *", "0 12 * * *"]` — slot
  inventory: 11:00 UTC cleanup → 11:30 UTC workorders MaintainX sync
  → 12:00 UTC forms approval digest → 13:00 UTC damage daily summary.
  Per-event notifications + "mark as viewed" / "snooze" + count
  badge on the dashboard tile all deferred to v2 per the brief's
  out-of-scope. PA flow build guide at `PA_FLOWS_BRIEF_121.md`
  mirrors the Brief 101/102/105 pattern.
  Brief 125 (2026-05-14) replaced the Brief 120/123 Inspector-panel
  workflow editor with a top-level Workflow tab on `/admin/forms/[id]`
  (Fields / Workflow / Settings, URL-driven via `?tab=`). The Workflow
  tab uses user-language vocabulary throughout — `steps` /
  `actions` / `outcomes` — and never surfaces schema words (`stage`,
  `transition`, `approver_source`, `payload_field`, `site_role`,
  `terminal`, `default_stage`). Step cards have drag-to-reorder via
  `@dnd-kit/sortable`; the new per-step "Who approves?" picker
  auto-detects email-shaped lookup fields, email-type fields, and
  location fields from the form's schema, and the "Specific person" /
  "Multiple people" options autosuggest from `auth_unified` via a new
  admin-tier `GET /forms/admin/api/users/search?q=` endpoint (email
  ilike substring; 20-row cap; future-extensible to `full_name` when
  `auth_unified` is widened to surface it). Each action sub-card has
  a "Required action" subsection (Signature / Note / Typed name)
  framed as requirements the form maker sets on the approver (NOT
  "Requires before submit"). Outcomes are a separate visual section
  (horizontal pill row; Add outcome / tint picker / remove-with-confirm
  inline panel); Approved + Denied are auto-seeded on workflow enable.
  The destination dropdown lists every Outcome first, then every other
  Step (`Outcome: {label}` / `Step N: {label}` prefixes); self-step
  disabled with hover hint. Schema additions are additive + optional:
  `WorkflowStage.kind?: "step" | "outcome"` (UI bucket hint —
  predicate-derived fallback for legacy stages), `WorkflowStage.tint?:
  "success"|"danger"|"warning"|"info"|"neutral"` (outcome pill color),
  and `FormWorkflow.notifications?: { notify_approver_on_assignment?,
  notify_submitter_on_outcome?, notify_approvers_on_outcome? }` with
  defaults true/true/false applied at READ time (via
  `getWorkflowNotifications` in `apps/forms-worker/src/notifications.ts`
  — keeps stored schemas minimal so we can evolve defaults without
  re-publishing every form). The Brief 123 `WorkflowMermaidPreview`
  was renamed to `WorkflowFlowPreview` with new entry / step /
  outcome node classes (`"Form submitted"` anchor → step rectangles →
  outcome circles tinted per the stage); lazy-load via
  `next/dynamic({ ssr: false })` preserved so the Mermaid bundle still
  code-splits. New optional secret
  `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` is the single PA flow for
  both per-step assignment ("you have a new item to review") AND
  per-outcome ("your submission was Approved/Denied") emails;
  discriminated by a top-level `type` field on the payload. Two fire
  points in the worker: (a) `submit/index.ts` fires assignment for
  every member of `current_approver_emails` after the default-stage
  seed when `notify_approver_on_assignment` is true (with submitter
  actor-exclusion); (b) `admin/submissions.ts handleTransition` fires
  assignment when transitioning INTO a non-outcome destination with
  approvers AND fires outcome when transitioning INTO an outcome with
  recipient list = submitter (when opt-in) + acted-on approvers from
  `workflow_history` (when opt-in). Both fires are fail-soft + 15s
  `AbortSignal.timeout` + `ctx.waitUntil`-ed; actor-exclusion (caller's
  own email) on assignment. When secret unbound, both fires log
  `[forms.notify.{assignment|outcome}] webhook unbound — skipping` and
  no-op. New helper module `apps/forms-worker/src/notifications.ts`
  exports `fireAssignmentNotification` / `fireOutcomeNotification` /
  `getWorkflowNotifications` / `workflowStageIsOutcome` /
  `buildReviewUrl` / `buildActorHistory` — canonical home for all
  forms notification helpers (the existing submission webhook can
  move here in a future cleanup). PA flow build guide at
  `PA_FLOWS_BRIEF_125.md` mirrors the Brief 121 pattern. Settings tab
  renders form-meta editors (title / description / audience /
  notify_webhook / Turnstile / success message) but persistence stays
  client-only (Brief 95 limitation — `PATCH /draft` accepts schema
  only) — a follow-up brief should widen the worker endpoint with a
  `meta` accept path. Files deleted at this brief:
  `apps/web/app/admin/forms/[id]/_builder/{WorkflowEditor,
  WorkflowMermaidPreview}.tsx` (replaced by the new `_workflow/`
  tree). Underlying Brief 120 schema (stages / transitions /
  approver_source / current_approver_emails) is preserved verbatim —
  submissions written under the Brief 120/123 UI continue to render
  and transition correctly with no re-publish needed (legacy stages
  without `kind` resolve to step/outcome via the predicate fallback).
  Conditional transitions + outcome drag-reorder + PDF-of-completed-
  form attach all flagged as v2 (PDF placeholder is a disabled
  checkbox on the Notifications panel).
  Brief 126 (2026-05-14) added the My Requests view as the companion
  to Brief 121's Pending Approvals (Approvals shows items waiting on
  YOU; My Requests shows items YOU submitted). New worker endpoint
  `GET /forms/admin/api/my-requests` in
  `apps/forms-worker/src/admin/my-requests.ts` — any-session auth via
  `authenticate()`; PostgREST query scoped by `submitter_email=eq.
  {caller_email_lowercase}` (Brief 120 normalizes the column at
  insert time, so case-insensitive matching works without ilike).
  Query params: `status=waiting|done|all` (default all) + `limit`
  (default 200, max 500) + `offset` (default 0). Returns
  `{items, total, scope, caller_email, limit_hit}` with each item
  carrying `submission_id` / `form_id` / `form_title` /
  `workflow_stage` / `stage_label` (resolved from the row's version
  schema) / `status_kind` ("waiting" when stage has approver_source,
  "outcome" when terminal) / `status_tint` (`info` for in-flight,
  else Brief 125 `stage.tint` if set, else label-keyword heuristic
  — `/\bapprov/` → success, `/\bden/` → danger, else neutral) /
  `current_approver_emails` (empty for outcomes) / `submitted_at` /
  `outcome_reached_at` (newest `workflow_history` entry whose `to`
  matches the current stage; null while waiting) / `detail_path`.
  Submissions without a workflow (`workflow_stage IS NULL`) are
  filtered at the SQL layer. New apps/web `/admin/my-requests` page
  (any-session — worker returns empty for callers with no
  submissions, so no defense-in-depth gate beyond signin) renders
  All / Waiting / Approved / Denied tabs (All + Waiting map to the
  worker `status` param; Approved + Denied request `status=done`
  and narrow client-side by `status_tint`), offset pagination
  (Prev / Next, page size 50), per-row Status pill + "Waiting on"
  approver sub-line for in-flight + "Reached" timestamp for
  outcomes (formatEst per Brief 113). Empty-state copy avoids
  schema vocabulary ("stage" / "outcome"). New "My Requests" tile
  in the dashboard Submissions group (`anySession`); new
  `"my-requests"` entry in `apps/web/middleware.ts`
  `ADMIN_KNOWN_SUBPATHS` per the CLAUDE.md mandatory rule. New
  `listMyRequestsAdmin({status?,limit?,offset?})` worker-fetch
  helper mirrors `listPendingApprovalsAdmin`. Cancel/withdraw,
  re-submit denied, and workflows-without-stages are all out of
  scope at v1 per the brief; the per-submission detail page Brief
  120 built already has the timeline + transition modal.
  Brief 127 (2026-05-14) added the outbound email queue infrastructure
  + workflow email-step stage type + migrated Brief 125's outcome
  notification webhook to queue-based fan-out. New shared
  `outbound_emails` Supabase table (see top-level glossary entry of
  the same name) is the single drain point for every monorepo email;
  one Power Automate flow polls + sends + confirms. New worker
  endpoints `POST /forms/internal/api/email-queue/{claim,confirm}`
  (`apps/forms-worker/src/email-queue/`) auth via shared-secret
  `X-Email-Queue-Token` (new optional secret `FORMS_EMAIL_QUEUE_TOKEN`);
  503 when unbound. Workflow schema gains `kind: "email"` stage
  variant with `recipients: ApproverSource[]` + `subject_template` +
  `body_template` + single auto-advance transition. Cascade helper
  `cascadeThroughEmailSteps` in
  `apps/forms-worker/src/workflow-email-step.ts` (~370 LOC) renders
  templates against payload + runtime context (form / submitter /
  outcome / payload.summary / `{field.key}`), resolves recipients via
  the existing `resolveApproverEmails`, enqueues one row per
  recipient, stamps a system-actor history entry, advances. Depth
  cap 10 (cycles caught by strict validator at publish). Runs at
  both submit time (default-stage cascade before insert so the row
  carries the post-cascade state) AND transition time (dest-stage
  cascade after the operator's transition action). Brief 125's
  `FORMS_OUTCOME_NOTIFICATION_WEBHOOK_URL` fire sites removed at both
  paths; `fireAssignmentNotification`/`fireOutcomeNotification`
  helpers in `apps/forms-worker/src/notifications.ts` become
  documented `@deprecated` no-op log lines (deletion candidate one
  cycle out). Brief 125's `notifications` block on the workflow
  schema stays for back-compat but is `@deprecated` and no longer
  drives side effects. Builder UI: "+ Add approval step" replaced
  with "+ Add step" choice popover (Approval / Email); new
  `EmailStepCard.tsx` (amber-toned, multi-recipient picker + Subject
  + Body + placeholder reference + "Then go to" select); new
  `QuickPatternsPopover.tsx` with four one-click templates that
  produce normal email-step schema entries ("Email submitter on
  outcome" / "Email approver when assigned" / "Email RM on
  submission" / "Email a specific person on submission");
  `NotificationsPanel.tsx` deleted. `WorkflowFlowPreview` adds an
  `:::emailstep` Mermaid node class (amber) with unlabeled edges
  (auto-advance). `kind` union widened to
  `"step" | "approval" | "email" | "outcome"`; legacy `"step"` rows
  continue to validate (predicate fallback treats as approval).
  `enqueueOutboundEmail` helper in
  `packages/db-supabase/src/outbound-emails.ts` is intentionally
  worker-agnostic — future damage / fleet / workorders / signup /
  jotform migrations are an `import` away. PA flow build guide at
  `PA_FLOWS_BRIEF_127.md`. Backwards compatibility: existing
  workflows continue to validate + transition normally; the
  `notifications` block's booleans persist in the schema (read-only
  back-compat) but no longer fire any webhook.
  Brief 129 (2026-05-14) added the completed-form PDF generator on
  splash-forms. New module under `apps/forms-worker/src/pdf/` (eight
  files: `generate.ts` public entry, `layout-utils.ts` shared
  cursor/font/wrap/measure/EST-formatter/R2-image helpers,
  `layout-header.ts` navy band + white-script logo from
  `assets/splash-logo-white.png` R2 + form title + submission id,
  `layout-metadata.ts` two-column grid, `layout-payload.ts`
  per-field-type renderer honoring `exclude_from_pdf`,
  `layout-workflow-history.ts` from→to per entry with actor /
  timestamp / note / typed_name / signature image,
  `layout-footer.ts` Splash brand line + Page N of M,
  `cascade-attach.ts` the generate-or-reuse worker hook). pdf-lib
  programmatic (Helvetica + Helvetica-Bold standard fonts only). PDF
  lives in the `FORMS_FILES` R2 bucket at
  `form-submission-pdfs/{form_id}/{submission_id}.pdf`. Generated
  once per submission, reused across multiple email steps in the
  same cascade — reuse semantics key on `R2.head().uploaded` vs the
  latest `workflow_history[*].at` timestamp (cumulative across
  cascade). When that timestamp moves (new transition / new email
  step entry), the PDF regenerates; otherwise the existing R2
  object is reused. Schema additions are additive + optional:
  `FieldBase.exclude_from_pdf?: boolean` inherited by every field
  type (Field Inspector's Advanced section exposes the checkbox),
  `WorkflowStage.attach_pdf?: boolean` on email-step stages
  (EmailStepCard exposes the checkbox). `cascadeThroughEmailSteps`
  gains optional `submissionMeta` + `priorWorkflowHistory` params;
  when set AND the email step has `attach_pdf: true`, fires the
  cascade-attach helper and pushes
  `{filename, r2_key, mime: "application/pdf", size_bytes, bucket:
  "FORMS_FILES"}` onto every recipient's
  `OutboundEmailPayload.attachments`. Brief 127's claim endpoint
  already base64-inlines R2 attachments on PA fetch — zero new
  claim-side code. Fail-soft: PDF generation / R2 write / timeout
  collapse to "enqueue without attachment" + log. 15s
  `AbortController` timeout on generation catches pathological
  cases (huge file fields with many image thumbnails). Brief 97's
  daily R2 cleanup at 11:00 UTC gains a third sweep —
  `form-submission-pdfs/{form_id}/{submission_id}.pdf` objects with
  no matching `form_submissions.id` row → delete (1h grace,
  20-page = 20K-PDF/run cap). PDFs for active submissions are
  NEVER deleted (referenced indefinitely by re-send / re-attach
  paths). Quick patterns: "Email submitter on outcome" seeds
  `attach_pdf: true`; "Email approver when assigned" seeds
  `attach_pdf: false`. Per-form branding override, watermarks,
  custom layout / field ordering, custom fonts, multi-language,
  PDF preview in builder, Download-PDF button on detail page,
  cross-worker PDF consolidation with damage-worker's claim
  summary PDF all flagged as v2/v3. The new shared
  `apps/web/app/admin/forms/[id]/_field-types/_shared/AdvancedSection.tsx`
  renders the per-field `exclude_from_pdf` checkbox in a collapsed
  `<details>` block; it's wired into the `FieldInspector` wrapper
  inside `Inspector.tsx` once rather than per-type — adding a 17th
  field type still inherits the flag automatically (deviation from
  the brief's "every Inspector imports it" wording; same operator-
  facing behavior with much less code surface). pdf-lib `^1.17.1`
  added as a direct forms-worker dep (same version damage-worker
  uses → bundle dedupe). Bundle impact: +870 KiB raw / +222 KiB
  gzip on the forms-worker compressed size.
  Brief 131 (2026-05-14) closed a chain of correctness + UX gaps
  surfaced by real-world testing of Brief 125/127's workflow + email
  infrastructure. **Picker correctness fix.** Brief 125's
  `ApproverPicker` (`apps/web/app/admin/forms/[id]/_workflow/`)
  saved `{type: "site_role", role: "rm_email"}` when the operator
  picked a lookup option whose `sourceColumn` was `rm_email` (or
  `am_email` / `site_email`). That forced the resolver to walk the
  schema for a `location` field or location-keyed lookup and resolve
  via `getLocationContactInfo` — which fails when the form has only
  a Site Number lookup, not a Location field, because
  `extractLocationCode` returns null. Brief 131 audits the picker's
  `onChange` handler: `lookup_role` picks now save as
  `{type: "payload_field", field_key: <lookup field's payload key>}`
  — the lookup has already resolved the email at submit time, so its
  payload value IS the email. `location_role` picks (auto-detected
  from a real `location` field) continue to save `site_role` because
  the resolver finds `location_code` and looks up the contact email
  via `getLocationContactInfo`. **Payload-key vs field-id
  clarification.** Empirical confirmation: payload keys are
  `field.key`, NOT `field.id`. Three sites in agreement: submit
  handler at `apps/forms-worker/src/submit/parse.ts:53` writes
  `payload[field.key] = value`; resolver at
  `apps/forms-worker/src/workflow-resolution.ts:98` reads
  `ctx.payload[f.key]`; pending-approvals at
  `apps/forms-worker/src/admin/pending-approvals.ts:203` reads
  `payload[f.key]`. Any future helper that needs to read a payload
  value MUST key on `field.key`, not `field.id`. **Terminal-stage
  auto-status.** Brief 96's `form_submissions.status` enum stays
  `new` / `in_progress` / `closed`, but the transition handler in
  `apps/forms-worker/src/admin/submissions.ts` now auto-flips the
  column to `closed` when the destination is a terminal outcome
  (`workflowStageIsOutcome(destStage)`) AND the current status is
  `new` or `in_progress` — so operators don't have to manually
  update Status after reaching an outcome. The audit columns
  `status_updated_at` / `status_updated_by = 'system@workflow'` get
  stamped server-side in the same PATCH. Admin-curated `closed`
  status isn't overridden. **Inline signature canvas.** Brief 120
  shipped a literal-text "paste an r2_key" input on the admin
  transition modal that was clearly a dev placeholder. Brief 131
  replaces it with a real `<canvas>`-backed signature pad at
  `apps/web/app/admin/forms/[id]/submissions/[subId]/_components/SignatureCanvas.tsx`
  that loads the vendored `signature_pad.min.js` (Brief 92) via
  `<Script src="/forms/api/static/signature-pad.min.js" strategy="afterInteractive">`.
  Same-origin in production via path-carving; cross-origin in dev
  (smoke deferred to staging per the brief). New worker endpoint
  `POST /forms/admin/api/transition-signatures/{submission_id}`
  (admin-tier gate) writes the PNG blob to R2 at
  `transition-signatures/{submissionId}/{nanoid}.png` and returns
  `{r2_key}`. The hidden `signature_r2_key` form input gets
  populated via React state; the existing transition action sends
  it through to Brief 120's `signature_r2_key` parameter unchanged.
  **All Approvals widening.** Brief 121's
  `GET /forms/admin/api/pending-approvals?all=1` dropped the
  `current_approver_emails != '{}'` filter so admin oversight can
  spot rows whose approver resolution failed. Each item carries a
  new `approver_resolution_status: "resolved" | "empty"` field;
  apps/web `/admin/approvals` renders a "⚠ No approver resolved"
  pill on empty rows. Rows whose current stage has no
  `approver_source` (terminal / email-step stages) are skipped —
  they shouldn't surface as pending approvals. **Workflow column
  on per-form submissions list.** Brief 119's wide-table viewer
  (`/admin/forms/[id]/submissions`) gained a "Workflow" column.
  `SubmissionListItem` on both the worker side
  (`apps/forms-worker/src/db/admin-submissions.ts`) and apps/web
  side gains `workflow_stage?: string | null` (returned on every
  list row regardless of `include=payload`). New
  `apps/web/app/admin/forms/[id]/submissions/_components/WorkflowOutcomeCell.tsx`
  renders three states: no workflow → muted em-dash; terminal
  outcome → tinted pill (Brief 125's `stage.tint` + keyword
  heuristic fallback); in-flight → info-tinted "stage label" pill.
  **Loading state.** New
  `apps/web/app/admin/forms/[id]/submissions/[subId]/loading.tsx`
  skeleton renders immediately on click (Next.js loading
  convention); SubmitButton (Brief 130) wired on the transition
  modal + Status & Splash Notes Save button with contextual
  `pendingText` derived from the action label
  ("Approving…" / "Denying…" / "Sending back…"). **Approvals
  nav.** `/admin/approvals` Review buttons append `?from=approvals`;
  the per-submission detail page reads `searchParams.from` and
  prepends a `← Back to Pending Approvals` link to the breadcrumb
  row. **Builder label polish.** EmailStepCard "Use placeholders
  like {field.label} or {field.key}" → "Use dynamic fields"; the
  step-label input gets dashed amber border + "Click to name this
  step…" placeholder + hover affordance. `ApproverPicker` gains a
  `mode: "approver" | "recipient"` prop that retitles the header
  ("Who approves this step?" → "Send email to" for email steps) +
  the empty-placeholder and missing-source warning copy.
  EmailStepCard passes `mode="recipient"` to its inner pickers.
  **Inline "+ Create new email step here."** New reducer action
  `workflow_add_email_step_from_action` + dispatch
  `onCreateAndRouteToEmailStep` + sentinel `<option>` `+ Create
  new email step here` in every ActionSubCard's "Then go to"
  dropdown. Picking it creates a fresh email step (label derived
  from the matching outcome — "Approved email" / "Denied email"),
  splices it immediately after the origin approval step, points
  the action's `to` at it, routes the new step's auto-advance
  transition to the keyword-matched outcome (success-tinted for
  approve-ish action labels; danger-tinted for deny-ish; first
  outcome otherwise). One-click vs the three-step manual sequence
  Brief 125/127 required (create email step downstream first → wire
  it → go back to wire upstream). **New Quick Pattern.**
  `email_submitter_on_approve_and_deny` — for each approval step,
  finds Approve and Deny actions (keyword-matched), creates two
  email steps (approval email with `attach_pdf: true` → Approved
  outcome; denial email with `attach_pdf: false` → Denied outcome),
  rewires both actions through them. **Defensive resolver log.**
  `apps/forms-worker/src/workflow-resolution.ts` `payload_field`
  branch now `console.warn`s `[forms.workflow.resolve]
  payload_field "{field_key}" resolved to empty / non-email value`
  when resolution fails, so a future picker misconfiguration is
  grep-able in worker logs. **Latent for follow-up.** The
  per-submission detail page (`/admin/forms/[id]/submissions/[subId]/page.tsx`)
  is admin-tier gated on apps/web, but Brief 120's transition
  handler accepts any approver — RM/GM approvers can hit the worker
  endpoint via curl but can't reach the apps/web page UI today.
  Widening the page gate is a follow-up brief.
  Brief 132 (2026-05-14) closed the seed-path / Quick-Pattern variants
  of the same picker-mis-mapping bug class Brief 131 Phase 2 partially
  fixed. `makeWorkflowSeed` in
  `apps/web/app/admin/forms/[id]/_builder/reducer.ts` now accepts the
  form's current `fields` and delegates to a new
  `pickSeedApproverSource` helper — priority order: first lookup
  `rm_email` → `payload_field`, any lookup `*_email` →
  `payload_field`, first email-type field → `payload_field`, Location
  field present → `site_role rm_email`, empty `static_emails` (operator
  picks before publishing). The `email_rm_on_submission` Quick Pattern's
  lookup branch was rewritten to emit `payload_field` keyed on the
  matched lookup field's `key` rather than `site_role`. New
  `ApproverPicker` `useEffect` auto-migrates legacy published
  `site_role` shapes to `payload_field` on first render when a matching
  `lookup_role` option exists; the next Save Draft persists the
  corrected schema (in-flight `current_approver_emails` rows on
  already-submitted forms stay untouched — resubmission against the
  fixed schema is the path forward). `sourceToAutoKey`'s legacy
  `site_role → lookup_role` round-trip fallback removed (auto-upgrade
  preempts it). Future readers extending this for a new lookup-shape
  `sourceColumn` registered in `LOOKUP_SOURCES`: add a case to
  `pickSeedApproverSource` first (the picker's `detectFromFields`
  already accepts any `*_email` suffix via the priority-2 branch, so
  picker UI doesn't need touching).
- **outbound_emails table** (Brief 127) - Shared queue of fully-rendered
  outbound emails. Single Power Automate flow polls every 5 minutes
  and drains the queue regardless of which worker enqueued the row.
  Table schema in `supabase/forms-tables.sql`; key columns are
  `source_worker` / `source_kind` / `source_id` / `recipient`
  (forming the dedup index — re-enqueueing the same logical email is
  a no-op via PostgREST `Prefer: resolution=ignore-duplicates`),
  `subject` / `body_html` / `body_text` (rendered by the caller —
  the queue does NO template substitution), `attachments` JSONB
  (each entry is `{filename, mime, size_bytes}` + either `r2_key` or
  `base64`; r2_key is preferred + inlined at claim time so queue
  rows stay small), `scheduled_for` (defaults `now()`), `claimed_at`
  + `claim_id` (lock state — 10-minute stale-claim window),
  `sent_at` (null until PA confirms send), `send_attempts` (drops
  out of eligible pool at >= 5), `last_error`. Indexes: unique dedup
  (`source_worker, source_kind, source_id, recipient`), partial
  pending (`scheduled_for WHERE sent_at IS NULL`), source-narrow
  (`source_worker, source_kind, created_at DESC`) for the Brief 128
  admin viewer. SQL function `claim_outbound_emails(p_claim_id,
  p_limit)` exposes the `FOR UPDATE SKIP LOCKED` pattern PostgREST
  can't surface at the table layer; clamps `p_limit` to
  `LEAST(p_limit, 200)`. Endpoints on `splash-forms`:
  `POST /forms/internal/api/email-queue/claim?limit=50` calls the
  RPC + inlines R2-backed attachments as base64 (per-attachment 5MB
  cap; overage drops with a log). `POST /forms/internal/api/email-
  queue/confirm` accepts `{claim_id, results: [{id, status,
  error?}]}` and stamps `sent_at` for `sent` results or releases the
  claim + increments `send_attempts` + records `last_error` for
  `failed`. Auth: shared-secret `X-Email-Queue-Token` (new optional
  secret `FORMS_EMAIL_QUEUE_TOKEN`, constant-time compared); 503
  when unbound. Who's allowed to write: any worker holding
  `SUPABASE_SERVICE_KEY` via the shared helper
  `enqueueOutboundEmail(env, payload)` in `@splash/db-supabase`. At
  Brief 127 the only writer is forms-worker (via
  `cascadeThroughEmailSteps` for `kind: "email"` workflow stages —
  `source_kind: "workflow-email-step"`, `source_id:
  "{submission_id}:{stage_id}"`); damage / fleet / workorders /
  signup / jotform per-purpose webhook fires are NOT migrated yet
  per operator scope and continue to work via their existing PA
  flows. Future migrations: import the helper, render the email,
  call it. PA flow build guide at `PA_FLOWS_BRIEF_127.md`.
  Brief 128 (2026-05-14) landed the admin viewer at
  `/admin/email-queue` (apps/web, admin-tier — `super_admin` OR
  `dcRole admin/super_admin`; tile in the Admin dashboard group).
  Four endpoints under `/forms/admin/api/email-queue/*` on
  splash-forms: `GET /list` (filter by status / source_worker /
  source_kind / from / to / limit / offset; default last 7 days,
  page size 100, max 500), `GET /{id}` (full row incl. body_html /
  body_text + per-attachment metadata `{filename, mime, size_bytes,
  has_r2_key, has_base64}` — admin viewer does NOT inline base64
  even when present, only the PA-facing claim endpoint does that),
  `POST /{id}/retry` (resets `claimed_at`, `claim_id`,
  `send_attempts=0`, `last_error=NULL` → row eligible for next PA
  poll), `POST /{id}/abandon` (stamps `send_attempts=99` +
  `last_error="Manually abandoned by {admin_email} at {now}"`; row
  stays for audit but never sends). Status taxonomy is derived in
  handler code from row state (the table has no `status` column):
  pending = `sent_at IS NULL AND claimed_at IS NULL AND
  send_attempts < 5`; claimed = `sent_at IS NULL AND claimed_at IS
  NOT NULL AND send_attempts < 5`; sent = `sent_at IS NOT NULL`;
  stuck = `sent_at IS NULL AND send_attempts >= 5`. Body_html on
  the detail page renders as ESCAPED preformatted text via React's
  auto-escape — `<pre>{html}</pre>` displays raw HTML markup as
  visible characters, never DOM-injected; no
  `dangerouslySetInnerHTML` on operator-authored payloads. Abandon
  button is disabled with hover hint for non-stuck rows + uses a
  client-island `<ConfirmSubmitButton>` running `window.confirm()`
  before the form dispatches. Per-row admin-action audit log (who
  retried / who abandoned) deferred to v2 — abandon stamps the
  admin email into `last_error` which is enough for single-admin
  operations; multi-admin contention would need a `claim_audit`
  JSONB column or separate audit table.
- **fleet-inquiry-worker** (Brief 81) - Public fleet-inquiry form +
  three JSON endpoints. The seventh worker in the monorepo and the
  most recent addition. Lift-and-shifted into `apps/fleet-inquiry-
  worker/` from an external single-file repo
  (`C:\Users\Coppsrv\Documents\Projects\fleet-inquiry-worker`); the
  ~1900-LOC `src/index.js` is carried VERBATIM (zero npm runtime
  deps, plain JS, inline ~1250-line HTML form — no TS conversion, no
  `@splash/db-supabase` helper migration, no render extraction in
  Brief 81; deferred to future briefs). Endpoints: `GET /` and
  `GET /fleet` render the form; `POST /api/find-locations` (body
  `{address?, lat?, lng?}`) returns nearest five locations sorted by
  Google Maps distance when `GOOGLE_MAPS_API_KEY` is bound, falling
  back to alphabetical otherwise; `POST /api/fleet-packages` (body
  `{location_code}`) returns the `pricing_simple_resolved` rows for
  that location; `POST /api/fleet-submit` validates Turnstile (when
  `TURNSTILE_SECRET_KEY` is bound) and INSERTs to Supabase
  `fleet_submissions`. Worker name on Cloudflare:
  `splash-fleet-inquiry`. **Production custom domain
  `fleet.splashcarwashes.info` is NOT bound on this worker** — the
  legacy `broad-shape-38b8` worker continues to own that route. The
  monorepo copy is parallel deploy on workers.dev only until the
  operator-driven cutover (constraint #9; PRE_DEPLOY_FLEET.md
  section 6). Bindings: non-secret `[vars]` `SUPABASE_URL` +
  `TURNSTILE_SITE_KEY`; secrets `SUPABASE_ANON_KEY` (NOT
  `SUPABASE_SERVICE_KEY` — the legacy worker reads anon, monorepo
  mirrors that posture; flip to service key is a deferred decision
  per CLAUDE.md constraint #3) + `TURNSTILE_SECRET_KEY` + optional
  `GOOGLE_MAPS_API_KEY`. Fleet is THE ONLY monorepo worker with paid
  third-party API usage — Google Maps Geocoding bills per request
  beyond Google's free tier (~$5/1000 calls). 7-day cache TTL on
  geocode results materially lowers volume; PRE_DEPLOY_FLEET.md
  section 3 recommends a separate restricted key for
  `splash-fleet-inquiry` to avoid quota crosstalk with the legacy
  worker during transition. `tsconfig.json` enables
  `allowJs: true / checkJs: false` so root `pnpm typecheck` passes
  without converting the JS to TS.
  Brief 83 added an admin-gated submissions viewer surface — see
  **Fleet inquiries admin** below for the endpoint inventory and
  apps/web page set. Brief 85 (2026-05-09): success modal includes a
  "Fill Again" button that redirects to `/` via relative URL — works
  on workers.dev / staging / production with no per-env hardcoding.
  The relative-URL convention is the right pattern for any client-side
  redirect in a public-form worker that has both staging and
  production hostnames.
- **Fleet inquiries admin** (Brief 83 / Brief 87 / Brief 105) -
  Cookie-gated viewer + editor for the `fleet_submissions` table.
  Endpoints on `splash-fleet-inquiry` (the worker's first
  authenticated routes — see fleet-inquiry-worker entry above for
  how the public form mode remains unchanged):
  `GET /admin/api/submissions?from=&to=&limit=`
  (JSON list, default last-30-days, max 200 rows),
  `GET /admin/api/submissions/{id}` (JSON detail; 404 on missing),
  (Brief 87 / widened in Brief 105)
  `PATCH /admin/api/submissions/{id}` (updates either or both
  `splash_notes` and `status`; body `{ splash_notes?: string,
  status?: 'new'|'reviewed'|'contacted'|'closed' }`; trims +
  caps notes at 10000 chars; status enum re-validated server-side;
  rejects unknown body keys with 400 as defense-in-depth;
  stamps the per-field audit columns `splash_notes_updated_{at,by}` /
  `status_updated_{at,by}` server-side; fires the optional
  `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL` after success for
  SharePoint sync — see glossary entry; same admin gate as the
  GETs),
  `GET /admin/api/submissions.csv?from=&to=` (RFC 4180 CSV with
  `Content-Disposition: attachment; filename="fleet-submissions-
  YYYY-MM-DD-to-YYYY-MM-DD.csv"`, no row cap besides a 10000 safety
  ceiling that returns 416 on overflow; CSV column inventory now
  includes `splash_notes` per Brief 87). Detail page
  (`/admin/fleet/[id]`) renders a "Status & Notes" section at the
  top (Brief 87 textarea + Brief 105 status dropdown) wired to that
  PATCH via the Brief 19 `<ActionForm>` pattern with a single Save
  button driving both fields in one round-trip; the values also
  display read-only in the key/value grid below. List page
  `StatusPill` colors the four enum values distinctly (blue / sudsy
  / amber / emerald). Status enum + pill color map live at
  `apps/web/app/admin/fleet/_lib/constants.ts` so worker validator,
  server-action defense-in-depth check, dropdown, and pill all key
  off the same allow-list. Auth: `@splash/auth`
  `authenticate()` + role check — allows
  `session.role === "super_admin"` OR `session.dcRole === "admin"` OR
  `session.dcRole === "super_admin"`. location_admin and gm/rm are
  rejected with 403. **Requires `SUPABASE_SERVICE_KEY` to be bound on
  `splash-fleet-inquiry`** — the public form continues to read via
  `SUPABASE_ANON_KEY`, but the admin reads use the service key for
  unfiltered visibility. When `SUPABASE_SERVICE_KEY` is unbound the
  admin endpoints return 503 (the public form mode is unaffected).
  Apps/web surfaces: `/admin/fleet` (list + date-range picker + CSV
  link), `/admin/fleet/[id]` (detail). Service binding
  `FLEET_INQUIRY_WORKER` in apps/web/wrangler.toml. Shared apps/web
  components introduced here for reuse (Brief 84 will reuse on
  `/admin/signups`): `apps/web/app/_components/DateRangePicker.tsx`
  (client component, URL-search-param-driven) and
  `apps/web/app/_components/CsvExportButton.tsx` (plain `<a download>`
  styled as a button — NOT a Next.js `<Link>` because we want the
  browser's native download flow from `Content-Disposition`, not a
  client-side route transition). Filtering is on
  `fleet_submissions.created_at` (Supabase row default `now()`), NOT
  the JS-written `submitted_at` field. Brief 88 (2026-05-09): the
  CSV "Export CSV" button on `/admin/fleet` links to an apps/web
  Route Handler at `apps/web/app/admin/fleet/export.csv/route.ts`,
  NOT directly to the fleet worker. The route handler proxies the
  request via the `FLEET_INQUIRY_WORKER` service binding internally
  and streams the upstream CSV body back with `Content-Type` +
  `Content-Disposition` preserved (so the browser still saves with
  the right filename). Reason: Brief 82 chose a subdomain pattern
  for fleet's staging route (`fleet.staging.splashcarwashes.info`),
  so a same-origin relative URL on the CSV button wouldn't reach the
  fleet worker — apps/web has no route at `/admin/api/submissions.csv`
  and Next renders 404 HTML the browser saves as `submissions.txt`.
  The proxy closes the gap with zero cookie-domain coordination,
  zero CORS work, and zero changes to the fleet worker. JSON list /
  detail / PATCH are unaffected — they're SSR'd from the apps/web
  Worker, browser never calls the fleet worker directly for them.
  Future workers using a subdomain pattern + needing a browser-direct
  download should follow the same proxy convention. Brief 106
  (2026-05-11): apps/web's list-row Submitted cell and detail-page
  caption now read `row.submitted_at` (matching the worker-side
  authoritative timestamp post-Brief-86); the always-blank "Created
  at" row was dropped from the detail key/value grid.
  `fleet_submissions.created_at` is unpopulated on every row — the
  worker writes `submitted_at` explicitly on insert. The Brief 86 +
  Brief 88 paragraphs above pre-date this correction; treat
  `submitted_at` as the single timestamp surface anywhere fleet
  submissions are rendered.
  Brief 108 (2026-05-11): the per-edit update-webhook payload's
  top-level `id` field is sourced from the PostgREST response row
  (`arr[0].id`), NOT the URL-path param. The column type switched
  from UUID to bigint identity after Brief 105 landed; PA's
  HTTP-trigger schema (correctly typed `integer`) started 400-ing
  on every dashboard PATCH because the worker was still shipping
  the URL-path string. Reading from `arr[0].id` keeps the wire
  type aligned with the underlying column type and guarantees
  top-level `id` agrees with `row.id` (which is also from the same
  PostgREST row). Latent reminder for future workers: when a
  Supabase column changes type, audit any worker code that passes
  URL-path params as that column's value in downstream payloads.
- **Work Orders** (Brief 70 / Brief 71) - Read-only MaintainX
  integration. Surfaces open / in-progress / on-hold work orders to
  operators on `/workorders` (top-level apps/web page, NOT under
  `/admin/*`). Permission domain (Brief 71): pure email-on-locations
  match against `locations.am_email` / `rm_email` / `site_email`.
  super_admin and admin do NOT have a global override; if they want
  global visibility they need their email on the relevant locations
  rows. Backed by `GET /workorders/api/list` on the
  `splash-workorders` worker (`apps/workorders-worker/`). The page
  splits work orders into Reactive vs Preventive tabs (canonical
  filter: `wo.type === "PREVENTIVE"` → Preventive; everything else
  including REACTIVE / CYCLE_COUNT / null → Reactive). Each tab is
  grouped by MaintainX location (header prefers MX's
  `expand=location.name`, falls back to Splash-side
  `locations.location` postal address); within each group rows are
  ordered by priority HIGH → MEDIUM → LOW → NONE then `updatedAt`
  desc. Rows are click-to-expand, surfacing full description, created
  date, age in days, assignees, and category badges. Each WO row
  links out to MaintainX itself (`app.getmaintainx.com/workorders/{id}`);
  this view does not write or edit WOs (Brief 42 / 43 own the create
  path on damage-worker). `MAINTAINX_API_KEY` is bound on BOTH
  workers (same value); per-worker bindings. Filter excludes DONE /
  CANCELED / SKIPPED — operators who want closed WOs follow the link
  out. Brief 71 adds a daily MaintainX user/team sync at 11:30 UTC
  populating `maintainx_users` and `maintainx_teams` Supabase tables;
  the read handler joins those caches to render assignee names. An
  on-demand sync trigger lives at
  `POST /workorders/api/sync-maintainx-users` (super_admin only).
  Pagination (Brief 72): single-location users get one MaintainX
  call (200-cap); multi-location users paginate cursor-by-cursor
  up to 1000 total WOs (5 pages × 200). Hard ceiling of 10 page
  iterations as defense-in-depth. Page renders a truncation
  banner when the 1000 cap is hit. The `pageCount` field on
  `GET /workorders/api/list`'s response surfaces the actual call
  count for observability.
  Brief 73: Preventive rows surface a due-date pill (red "Overdue
  Nd" / amber "Due today" / muted "Due MMM D" / em-dash null);
  Reactive rows do not (MaintainX auto-sets reactive dueDate to
  same-day, not operationally meaningful). Both tabs show muted
  age text "Nd" beneath the priority pill in the collapsed row.
  Brief 74: third tab "New Request" renders a form (no list)
  posting to `POST /workorders/api/request` (multipart/form-data,
  plain HTML form bypassing Next 15 server actions per Brief 37/38
  pattern); worker calls MaintainX `POST /v1/workrequests` then
  per-photo `PUT /v1/workrequests/{id}/{thumbnail|attachment}/
  {filename}`. Up to 5 photos: first → thumbnail, rest →
  attachments. Requester attribution: `creatorContactInfo` =
  operator's session email; requester name + phone appended to
  description footer. Location dropdown has no default — operator
  must explicitly pick. PriorityPill MEDIUM swapped from
  yellow-100 → `bg-gray-light text-splash-navy/80` so the tier
  doesn't read as plain text; age text under the priority pill
  gains matching `px-2` so it aligns under the pill's text, not
  its left edge.
  Brief 76 (correcting Brief 75): Work-request multi-photo upload
  was broken in Brief 74 due to a wrong URL path
  (`/v1/workrequests/{id}/attachment/{filename}` singular). The
  correct path is `/attachments/` (plural). Brief 76 restored
  multi-photo: form accepts up to 5 photos, first → thumbnail
  endpoint, remaining → attachments (plural) endpoint. Phone is
  required (Brief 75's other change retained). Worker emits
  `?request_ok={id}&photo_warn={N}-of-{M}-photos-failed` on partial
  upload failure (request creation itself succeeded); apps/web
  stacks an amber banner under the green success banner when both
  params are present. `uploadMaintainXWorkRequestFile`'s
  discriminator type stays `"thumbnail" | "attachment"` (singular,
  matching the doc heading); a small `REQUEST_FILE_URL_SEGMENT`
  lookup maps it to the plural URL segment internally.
  Brief 79: Preventative tab spelling preferred over "Preventive"
  on user-facing labels (internal state literals stay
  `"preventive"` to match MaintainX's `PREVENTIVE` enum).
  Worker-side filter drops Preventive WOs more than 90 days past
  `dueDate` — `PREVENTATIVE_MAX_OVERDUE_DAYS = 90` constant in
  `apps/workorders-worker/src/index.ts`. NULL / malformed dueDate
  preventives are kept.
  MaintainX UI URLs: work orders are at
  `app.getmaintainx.com/workorders/{id}`; work requests are at
  `app.getmaintainx.com/requests/{id}` (NO `work` prefix —
  segments aren't symmetric). REST API paths are also asymmetric
  (`/v1/workorders/{id}` for orders; `/v1/workrequests/{id}/...`
  plural for requests, with `/thumbnail/` singular but
  `/attachments/` plural underneath). Probe before inferring —
  Briefs 76, 80, 62, 86 all closed bugs caused by inferring a
  path / column / join key by analogy from a sibling resource
  (Brief 80 was the work-request UI URL caught on first
  post-deploy submit; Brief 86 was the same bug class on a
  Supabase column name — `fleet_submissions` has only
  `submitted_at`, not the conventional `created_at`, written
  by the worker on insert; `maxpass_signups` from Brief 56
  uses `submitted_at` too — Brief 84 grounded correctly on it).
  Tables don't universally have `created_at`; probe Supabase
  column schemas before inferring.
- **`age_days`** (Brief 68) - Server-computed days-since-submission
  field on the `/manage/api/claims` list response. Lives in the
  `listClaims` SELECT projection in `packages/db-d1/src/claims.ts` as
  `CAST((julianday('now') - julianday(submitted_at)) AS INTEGER) AS
  age_days` — NOT a stored column on the `claims` table. Future
  readers grep'ing the D1 schema won't find it. apps/web's
  `<AgePill>` consumes it on the damage list page (`/admin/damage`)
  with a four-tier color escalation (neutral / amber / orange / red
  at 0-3 / 4-7 / 8-14 / 15+ days) on Open claims; Closed claims
  render a static muted neutral pill.
- **Daily summary** - Brief 65's once-a-day digest of open damage
  claims emitted by damage-worker's `scheduled` handler at 13:00 UTC
  (8 AM ET). Recipients are every gm / rm / admin / super_admin in
  `auth_unified` (filtered server-side by `dc_role` and again in-code
  by the `SUMMARY_DC_ROLES` constant). gm / rm digests are scoped to
  their `dc_locations`; admin / super_admin digests are unrestricted
  and group hierarchically by Regional Director → Regional Manager →
  Location → claims (sorted by count desc within each level; oldest
  claim first within each location). Skip-on-empty: zero open claims
  for a recipient produces no email. Each digest is POSTed to the
  optional `DAILY_SUMMARY_WEBHOOK_URL` secret on damage-worker (15s
  timeout, fail-soft when unbound — same posture as
  `CUSTOMER_CLAIM_WEBHOOK_URL`); Power Automate fans out to email.
  Per-user opt-out is coarse today (remove dc_role, or edit
  `SUMMARY_DC_ROLES`); per-user opt-in flag deferred to v2.
- **Reporting** - Brief 59's corporate-style aggregate view of damage
  claims at `/admin/damage/reporting`. KPI tiles (Open / Closed /
  Approved / Denied / Repair Cost), per-location pivot table, and
  damage-type breakdowns for Approved + Denied. Backed by
  `GET /manage/api/reporting?location=&regional_director_email=&regional_manager_email=&window=`
  on damage-worker; window resolves server-side relative to "now"
  (5 presets: `current_month` / `past_month` / `qtd` (default) /
  `past_quarter` / `ytd`). Cost = sum of `claim_photos.amount` for
  `Quote` AND `Receipt` rows on Approved-family claims (claim_status
  `LIKE 'Approved —%'` OR `Closed — Paid` OR
  `Closed — Approved/No Response`). Limitation: claims with both a
  quote and a receipt double-count; v2 candidate is per-claim
  resolution preferring receipt over quote. dc_role scoping holds —
  RD/RM dropdowns and report data are intersected with the user's
  dcLocations. Tab nav (`<DamageTabs>`) sits above both
  `/admin/damage` and `/admin/damage/reporting`; the detail page
  `/admin/damage/[id]` is intentionally untabbed.
- **Regional Director / Regional Manager (label-vs-data divergence)** -
  UI labels added in Brief 59 for the AM/RM filters and the
  Reporting page. The org calls these roles "Regional Director" and
  "Regional Manager", but the underlying Supabase fields keep their
  legacy names: `pricing_simple.area_manager` / `am_email` is the
  Regional Director, `pricing_simple.regional_manager` / `rm_email`
  is the Regional Manager. Field names stay (sysadmin Update
  Location editor still shows "Area manager"); only the customer-
  facing UI labels change. Don't rename the fields — the trigger
  `trg_sync_pricing_simple` and PostgREST clients depend on them.
- **Signup admin** - Brief 56's umbrella term for the signup-worker
  admin surface. Two sub-views accessible via a tab nav at the top of
  every page (`apps/web/app/admin/_components/SignupAdminTabs.tsx`):
  (1) **Pricing** at `/admin/pricing` + `/admin/pricing/{loc}` — set
  per-location pricing modes. (2) **Signups** at `/admin/signups` +
  `/admin/signups/{loc}` — read-only viewer of recent customer
  submissions in `maxpass_signups` (default last-30-days, max 200 rows
  per view; arbitrary date-range filter via the shared
  `<DateRangePicker>`). Same auth gate as the existing per-location
  pricing endpoint via `GET /admin/api/locations/{loc}/signups`. Brief
  84 (2026-05-09) extended the endpoint to accept `from=YYYY-MM-DD&to=YYYY-MM-DD&limit=N`
  alongside the legacy Brief 56 `days=N` shape (1 / 7 / 30 — kept
  working for old bookmark URLs; resolution precedence is `from`+`to`
  → `days` → default last-30-days). Brief 84 also added the sibling
  `GET /admin/api/locations/{loc}/signups.csv?from=&to=` endpoint —
  worker-rendered CSV with `Content-Disposition: attachment;
  filename="signups-{loc}-{from}-to-{to}.csv"`, RFC 4180 quoting,
  same `adminGate` + `userCanAccessLocation` gate as the JSON list,
  10000-row safety cap (416 on overflow). The CSV export uses a
  `select=*` so it captures every user-facing column on
  `maxpass_signups` including `phone` (raw 10-digit), `terms_text`,
  `confirmation_token`, country/city/region. Filter column for both
  endpoints is `maxpass_signups.submitted_at` (NOT `created_at` like
  fleet — signups was always indexed on submitted_at). Brief 116
  (2026-05-13) split the `/admin/dashboard` entry point along the same
  `SignupAdminTabs` boundary: Pricing is its own tile under the Admin
  dashboard group, Signups is its own tile under the Submissions group
  (the prior unified "MaxPass Admin" tile linked only to `/admin/pricing`).
  URLs (`/admin/pricing/*` + `/admin/signups/*`) and the in-page
  `SignupAdminTabs` nav are unchanged — operators inside either page
  still flip between the two views via the tabs.
- **Admin dashboard** - Two-level drill-down navigation at
  `/admin/dashboard` (Brief 117, on top of Brief 116). Top page renders
  three group tiles (Submissions / Operations / Admin) sourced from
  the `GROUPS` array in `apps/web/app/admin/dashboard/_lib/tiles.tsx`;
  each group tile links to `/admin/dashboard/{groupId}` where the
  sub-tiles render. Brief 116's per-tile `visibleTo(session)`
  predicates remain the single source of truth: a group tile is
  visible iff at least one of its sub-tiles is visible to the caller,
  and the group landing page 404s (via `notFound()`) when the caller
  has zero accessible sub-tiles in that group (matches the hidden-tile
  state at the top level so direct-URL probes don't leak existence).
  Sub-tile pages reuse `<DashboardTile>` from Brief 116 verbatim, so
  visual identity is unchanged from the prior flat grid. Adding a new
  tile is a single-file change in `_lib/tiles.tsx`; adding a new
  GROUP requires a `GROUPS` entry plus a `GROUP_DESCRIPTIONS` row in
  both `page.tsx` and `[group]/page.tsx` (consider extracting
  `GROUP_DESCRIPTIONS` to `_lib/tiles.tsx` if a 4th group ever lands).
  Header "Dashboard" link points at `/admin/dashboard` (top level),
  not a sub-tile. Middleware (`apps/web/middleware.ts`)
  `ADMIN_KNOWN_SUBPATHS` already includes `dashboard`; the
  single-segment legacy `/admin/{slug} → /admin/pricing/{slug}`
  redirect rule bypasses any `/admin/dashboard/{anything}` path
  because it's multi-segment.
- **admin** - Pricing administration. Lives in signup-worker
  (`/admin/api/*`) + apps/web (`/admin/pricing/*`). Used by area
  managers and location admins to set per-location pricing modes.
- **sysadmin** - Database user/table management. Separate worker
  (sysadmin-worker, `/sysadmin/api/*`). Used by super_admins. Per
  recent operator decision, sysadmin also houses direct
  `pricing_simple` and `locations` table editing (bypasses SQL for
  non-pricing-API changes). Brief 24 landed Add Location — atomic
  bulk insert of N `pricing_simple` rows for a brand-new location via
  Supabase REST array POST; hardcodes `pricing = 'full'`. Brief 29
  extended Add Location to ALSO insert the corresponding `locations`
  row (so Brief 27's Update Location editor can find newly-created
  locations and the `trg_sync_pricing_simple` trigger has a row to
  fire on), accept a new `address` field that lands in both
  `locations.location` and `pricing_simple.address`, and made `site`
  required (parsed to `locations.site_number`). The locations row is
  inserted FIRST; on pricing_simple insert failure the worker issues
  a best-effort DELETE rollback of the locations row and flags the
  audit log for manual cleanup if the rollback also fails. Brief 26
  landed Update Package — search-then-edit one `pricing_simple` row by
  composite PK (`location_code`, `pkg`) via PATCH
  `/sysadmin/api/pricing-simple/package`. Editable fields are
  pricing-only: `pkg$`, `single`, `flash2`, `flash5`, `sort`, `pricing`
  mode, `pkg` (rename), and `location_pretty`. The denormalized columns
  (`am_email`, `rm_email`, `site_email`, `area_manager`,
  `regional_manager`, `address`, `site`) are explicitly rejected with
  400 because they're synced FROM `locations` INTO `pricing_simple` by
  the `trg_sync_pricing_simple` trigger — direct edits here would be
  silently reverted on the next locations-side update. Brief 27 landed
  Update Location — search-then-edit one `locations` row (selected by
  `id` or `site_number`) via PATCH `/sysadmin/api/locations`. This is
  the ONLY supported way to change the denormalized
  `area_manager`/`regional_manager`/`am_email`/`rm_email`/`site_email`
  fields anywhere in the system, because the `trg_sync_pricing_simple`
  trigger reverts direct pricing_simple edits and the
  `trg_sync_user_permissions` trigger then propagates email-driven
  permission grants/revocations into `user_permissions`. Editable
  fields on the locations editor: `site`, `location` (postal address),
  `area_manager`, `regional_manager`, `am_email`, `rm_email`,
  `site_email`, `hrt_email` (no cascade), `rm_group` (no cascade);
  read-only: `id`, `site_number`, `mla_location`, `created_at`,
  `updated_at`. A manual cache-clear button is also planned
  (signup-worker caches `pricing_simple_resolved` for 5 minutes;
  cross-worker invalidation isn't wired yet, so newly added or edited
  rows take up to 5 minutes to surface on the customer signup form —
  this gap is now flagged in three brief outcomes; Brief 28 will close
  it). Brief 30 reorganized the sysadmin page into a two-mode hub:
  `?mode=users` (default) renders 5 user-management cards (Create user,
  Set role, Grant tool, Revoke tool, Reset password); `?mode=tables`
  renders 3 table-management cards (Add location, Update package,
  Update location). Both modes also render an inline filterable
  Activity log panel below the operations, backed by a new
  `GET /sysadmin/api/audit-log` endpoint. Filter params live in URL
  search params: `audit_actor` (substring on actor_email),
  `audit_action` (allow-list), `audit_table` (target_type allow-list),
  `audit_user_id` (UUID; pins target_type to user-related rows),
  `audit_location_code` (pins target_type to pricing_simple/locations
  and matches `target_id` eq or `code/%` to catch composite IDs from
  Brief 26), and `audit_offset` (offset pagination, default limit 50,
  max 200). The log fetch surfaces `total_estimate` from PostgREST's
  `Content-Range` header (sent via `Prefer: count=estimated`). No
  audit row is written for audit-log reads themselves — observation
  is read-only. Brief 61 added a sixth Manage Users card — **Set DC
  Role** — that writes the damage-claim permission domain
  (`damage_claim_user_roles` + `damage_claim_user_locations`) via
  `POST /sysadmin/api/users/{userId}/dc-role`. dc_role and
  user_permissions.role are independent permission domains and must
  be set separately: a user can be `location_admin` for Oswego in
  user_permissions AND `gm` for Oswego in dc_role; both are needed.
  For `super_admin` / `admin` dc_role, the worker skips the
  dc_locations write (those roles bypass scoping); switching a user
  from gm/rm to super_admin/admin or null always wipes existing
  dc_locations rows to prevent stale-data leakage on downgrade.
  Audit-log allow-lists now include the `set_dc_role` action and the
  `damage_claim_user_roles` target_type; the log's `audit_user_id`
  filter pins target_type to user-related rows including
  `damage_claim_user_roles`.
  Schema note (Brief 64): `damage_claim_user_roles` is
  `(user_id, dc_role)` and `damage_claim_user_locations` is
  `(user_id, location_code)`. Email lives on `auth.users` and is
  joined by the `auth_unified` view at read time — sysadmin writes
  to either table do NOT include `email`. That denormalization
  pattern is `user_permissions`-specific; future helpers touching
  the dc_role / dc_locations tables must not model their writes
  after `setRole`'s payload shape.
- **inline mode** - signup-worker's default `SIGNATURE_MODE`. Renders
  the form HTML and POSTs straight to `maxpass_signups`.
- **jotform mode** - signup-worker's alternative `SIGNATURE_MODE`. 302
  redirects to a JotForm with prefilled fields. Currently dormant -
  Family Plan form IDs are placeholders.
- **location_pretty** - Display name of a location (e.g., "Binghamton"
  vs. location_code "binghamton"). Resolved before Power Automate
  POSTs in the new damage-worker. Post-Brief-33 the resolution path is
  Supabase `pricing_simple` (single source of truth for valid customer
  URLs) via `@splash/db-supabase` `getActiveLocationByCode`. The legacy
  D1 `locations` table was retired with that brief — the dual-store
  drift gotcha that bit the operator on 2026-05-05 (batavia_veterans
  underscore-vs-hyphen split) is no longer reachable.
- **dc_role** - User's effective role for damage claims access scoping.
  super_admin sees all claims; gm/rm sees only their dcLocations.
- **claim summary PDF** - Customer-facing PDF auto-generated on every
  successful submission of the public claim form (Brief 32). pdf-lib
  programmatic layout (no AcroForm template); stored in R2 at
  `claims/<claimId>/summary.pdf`; served via the public route
  `GET /claims-api/summary/<claimId>` (no auth gate — same posture as
  the existing photo serve). Two delivery channels: (a) "Download a
  copy (PDF)" link in the post-submit outcome card, (b) optional
  `CUSTOMER_CLAIM_WEBHOOK_URL` POST so Power Automate can email the
  customer. Both fail-soft: PDF generation failure does NOT fail the
  submission; webhook failure does NOT fail the PDF. The brand logo
  embedded in the navy header band loads from R2 at
  `assets/splash-logo-white.png` (operator must upload), with an
  HTTPS fallback to `ASSETS.logoWhite` when the R2 key is missing.
  Email is now required at submission time (HTML5 + worker-side
  regex `^[^@\s]+@[^@\s]+\.[^@\s]+$`); the D1 `customer_email`
  column stays nullable for back-compat with pre-Brief-32 rows.
- **CUSTOMER_CLAIM_WEBHOOK_URL** - Optional damage-worker secret
  (Brief 32) fired after a customer-submitted claim — Power Automate
  receives a JSON payload with `claim_id`, `customer_email`,
  `summary_pdf_url`, (for PDFs ≤ 3 MB raw) `summary_pdf_base64`, and
  `site_email` (Brief 48; the location's per-site contact address from
  Supabase `locations`, used by PA as the Reply-To header so customer
  replies land in the per-location inbox; null when the location has
  no site_email set, in which case PA falls back to the From mailbox
  for replies). Fail-soft: when unbound, the customer-email path
  silently skips — the PDF still generates and the post-submit outcome
  card surfaces the "Download a copy" link. The `site_email` lookup is
  also fail-soft: any throw from the `getLocationContactInfo` helper
  collapses to null and the webhook still fires.
- **CLAIM_UPDATE_WEBHOOK_URL** - Optional damage-worker secret
  (Brief 101) fired per-event on the manage-page write surface. Two
  intercept points: (a) every successful note add via
  `POST /manage/api/claim/{id}/note` — recipients are the location's
  `rm_email` AND `site_email`; (b) every successful status change via
  `POST /manage/api/claim/{id}/transition` whose destination status is
  in `STATUS_NOTIFIES_NEXT` (`Pending GM Review` /
  `No Responsibility — Pending Review` / `Approved — Pending Quotes`
  → `site_email`; `Pending RM Review` / `Pending RM Quote Approval`
  → `rm_email`; every other destination is no-notify). The map is
  keyed by `to` status (not transition pair), so Brief 66 RM-revert
  paths fire too — bounce-backs ARE the field-side event. Actor
  exclusion: the actor's own email is stripped from the recipient
  list server-side (case-insensitive); the `recipients` array PA
  loops over may be empty (PA no-ops cleanly). Payload includes
  `change_type` (`"note"`/`"status"`), `claim_id`, `customer_name`,
  `location_code`/`pretty`, `admin_url`, `actor: {email, dc_role}`,
  optional `from_status`/`to_status`/`note_text`, plus a `candidates`
  audit object with both addresses pre-exclusion. Helper module is
  `apps/damage-worker/src/notifications.ts` (sibling to
  `transitions.ts` — the two policy tables live together). Same
  fail-soft + `ctx.waitUntil`-style fire-and-forget posture as
  Brief 32 / 65. Future notification surfaces should reuse this
  module rather than spawning a new one per feature.
- **INTERNAL_NEW_CLAIM_WEBHOOK_URL** - Optional damage-worker secret
  (Brief 102) fired after every successful customer claim submission,
  parallel to `CUSTOMER_CLAIM_WEBHOOK_URL` in the same Brief 32
  post-submit block (after the customer-webhook fire, inside the same
  PDF try/catch). Recipients are the location's `rm_email` +
  `site_email` + `am_email` (resolved via `getLocationContactInfo` —
  widened by Brief 102 to return all three from one `pricing_simple`
  query) plus the operator-configured `INCIDENTS_EMAIL` `[vars]` entry.
  No actor exclusion (the customer submitter is not a location
  contact). Payload reuses Brief 32's `pdfBytes` + `summaryPdfUrl` —
  no duplicate PDF generation — and ships the same ~3 MB raw
  `CUSTOMER_WEBHOOK_BASE64_MAX_BYTES` base64 ceiling. Also includes a
  `photos[]` array of `/claims-api/photo/{r2_key}` URLs (every active
  `claim_photos` row for the freshly-inserted claim — at submit time
  these are `Damage` photos only; the query is unfiltered so future
  expansions are no-effort) with `{url, mime, original_filename,
  photo_type, uploaded_at}`. `uploaded_at` is the claim's
  `submitted_at` because D1 doesn't carry a per-photo timestamp. The
  `admin_url` field points at apps/web via `APPS_WEB_BASE_URL` (same
  pattern as Brief 101). Fail-soft: when unbound, the internal-
  notification path silently skips and the customer-email + PDF paths
  continue to work. Helper module is the same
  `apps/damage-worker/src/notifications.ts` Brief 101 introduced
  (`fireInternalNewClaimWebhook`, `resolveInternalRecipients`,
  `ClaimPhotoForWebhook`, `InternalNewClaimPayload`). The
  `fireInternalNewClaimNotification` private function in `index.ts`
  composes the payload and lives next to `fireCustomerClaimWebhook`.
  Brief 104 (2026-05-11) fixed the photo URL build inside
  `fireInternalNewClaimNotification`: strip the leading `claims/`
  from `r2_key` and URL-encode path segments before assembling the
  `/claims-api/photo/{suffix}` URL. Mirrors the existing
  `damagePhotoUrl` helper in apps/web
  (`apps/web/app/admin/damage/_lib/worker-fetch.ts`). The Brief 102
  build was `${baseOrigin}/claims-api/photo/${r2_key}` verbatim,
  which double-prefixed because `serveClaimPhoto`
  (packages/storage-r2) prepends another `claims/` before the R2
  `.get()`. Future readers modifying any `/claims-api/photo/...`
  URL-build site should follow the strip-and-encode pattern.
- **INCIDENTS_EMAIL** - Non-secret damage-worker `[vars]` entry
  (Brief 102) added to the `INTERNAL_NEW_CLAIM_WEBHOOK_URL`
  `recipients[]` array on every customer claim submission. Same value
  across all locations; lives in `apps/damage-worker/wrangler.toml`
  (placeholder `incidents@splashcarwashes.com` — operator confirms or
  amends before push; edits are diff-able and don't require secret
  rotation because the value isn't sensitive). Blank / unset → drops
  out of the recipient list; the three location addresses still
  receive. Splitting incidents into per-RM-group inboxes is a v2
  candidate (out of scope for Brief 102).
- **FLEET_SUBMISSION_UPDATE_WEBHOOK_URL** - Optional
  fleet-inquiry-worker secret (Brief 105) fired per-edit when an
  operator updates a `fleet_submissions` row from the dashboard via
  `PATCH /admin/api/submissions/{id}`. Single intercept point; both
  status changes and splash_notes edits ride the same fire (combined
  edits → one POST, not two). Payload: `{id, change_type:
  'status'|'notes'|'both', changed_fields: string[], actor:{email},
  row: <full updated fleet_submissions row>}`. Power Automate uses
  this to upsert SharePoint by submission id in near-realtime so
  Supabase stays authoritative for both fields. Same fail-soft +
  fire-and-forget posture as Brief 32 / 101 / 102: 15s `AbortSignal`
  timeout, non-2xx + throws logged as `[fleet-submission-update]` and
  swallowed, dashboard PATCH succeeds regardless. Helper
  `fireFleetSubmissionUpdateWebhook` co-located at the bottom of
  `apps/fleet-inquiry-worker/src/admin.js` (worker is verbatim-lifted
  JS per Brief 81; separate `notifications.js` module deferred until
  a second notification surface needs the same helper). When unbound
  the dashboard PATCH still succeeds and SharePoint just lags until
  the next successful fire (or a one-time operator backfill). The
  existing 30-min PA new-submission ingest flow is untouched —
  Brief 105 adds a parallel update channel keyed on dashboard edits
  only. Status enum is the four-value
  `new | reviewed | contacted | closed` worker-side allow-list.
  Per-edit audit columns `status_updated_{at,by}` /
  `splash_notes_updated_{at,by}` on `fleet_submissions` are stamped
  server-side per-field on each PATCH; last-write-wins, no full
  audit log (v2 candidate).
- **maxpass_signups** - Customer signup table. 18 columns including
  `confirmation_token` (UUID), `terms_text` (exact string customer
  saw), country/city/region from `request.cf`.
- **sysadmin_audit_log** - Append-only audit trail for sysadmin
  operations (grant_tool, create_user, set_role, etc.).
- **suspicious_phones** - Fraud-detection table. `manually_flagged`
  column determines whether worker code can mutate the row.
- **phone_usage_log** - Per-attempt log of every signup submission,
  including outcome (allowed / blocked / warned / monitored).

---

## Brief workflow (how this project is run)

The project is orchestrated via the `BRIEFS/` directory. Cowork (the
planner) drafts briefs; you (Claude Code in VS) execute them; outcomes
land back in the brief files plus BUILD_STATE.md.

When invoked by the orchestrator daemon (or the operator manually), you
will receive a prompt pointing at a specific brief file. The standard
flow:

1. Read `CLAUDE.md` (this file), `BUILD_STATE.md`, and the brief.
2. Execute the Scope. Make the file edits described.
3. Run validation per the brief's Definition of Done - typically
   `pnpm typecheck` and the relevant `pnpm --filter <pkg> build`. Do
   not skip these.
4. Fill in the brief's `## Outcome` section with: files created, files
   modified, decisions made on the operator's behalf, latent issues
   found, validation results.
5. Update `BUILD_STATE.md` per its Conventions section: bump
   "Last updated", add a Findings entry, update the prioritized work
   list status.
6. Update the brief's `Status:` field to `Completed (YYYY-MM-DD)`.
7. Exit. Don't continue to the next brief; the orchestrator handles
   queuing.

If anything blocks completion, mark the brief's Status as `Failed`
with a brief explanation in the Outcome section, then exit non-zero so
the orchestrator halts.

When in doubt: ask the operator before guessing. The cost of a
clarification question is small; the cost of building the wrong thing
is large. In headless mode (where you can't ask), prefer marking the
brief Failed with a precise question over picking a path that might be
wrong.
