# CLAUDE.md - splash-info monorepo

This file is auto-loaded by Claude Code at the start of every session in
this directory. Read it first. It mirrors the operator's project rules,
constraints, and conventions.

The single source of truth for project state is `BUILD_STATE.md`. Read
that next, then the brief you've been asked to execute (under `BRIEFS/`).

---

## What this project is

Splash Car Wash's MaxPass internal tooling monorepo. Five Cloudflare
Workers (apps/) ported from a single legacy worker (`info-signup-worker`)
plus a Next.js apps/web that consumes their JSON APIs. Seven shared
packages (packages/) provide auth, http, database, types, UI, storage,
and config. Build orchestration via Turbo (`turbo.json`) and pnpm
workspaces (`pnpm-workspace.yaml`).

```
apps/
  apps/dashboard-worker     SSO entry: /api/login, /api/logout, /api/forced-reset
  apps/signup-worker        Customer signup + admin pricing JSON API
                            (worker name on Cloudflare: splash-signup-next,
                            renames to splash-signup at cutover)
  apps/performance-worker   Performance tracker API at /pertrack/*
  apps/sysadmin-worker      User management JSON API at /sysadmin/api/*
  apps/damage-worker        Damage claims API + R2 photos + D1 records +
                            Power Automate webhooks + Check Request PDF gen
  apps/web                  Next.js (App Router), deploys via OpenNext to
                            Cloudflare Workers. Consumer of all five
                            workers' JSON APIs.

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
4. `PRE_DEPLOY_*.md` - five files (DAMAGE, DASHBOARD, PERFORMANCE,
   SIGNUP, SYSADMIN). Per-worker deploy notes. There is no
   PRE_DEPLOY_WEB.md (gap noted in BUILD_STATE.md).
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
- All five workers are deployed to `*.workers.dev` only. Production
  routes are commented in every wrangler.toml. Don't uncomment without
  explicit instruction.
- Secrets are bound via `wrangler secret put`, scoped per worker. Verify
  with `wrangler secret list` (filter by worker via `pnpm --filter`).
- Bundle size: workers compress well; current sizes are 700-1600 KiB
  uncompressed / 130-360 KiB compressed. Cloudflare's compressed limit
  is 3 MiB free / 10 MiB paid. Plenty of headroom.
- Smoke tests for each worker are in `PRE_DEPLOY_<NAME>.md`. Some tests
  reference legacy patterns (e.g., damage-worker tests #1-2 expect HTML
  pages, but the new architecture is API-only). Don't blindly run all
  PRE_DEPLOY tests; check whether each applies.

---

## Working with apps/web

- Next.js 14+, App Router (`app/` directory).
- Real pages: `/login`, `/change-password`, `/admin/dashboard`,
  `/admin/pricing`, `/admin/pricing/[location]`, `/admin/sysadmin`
  (placeholder), `/logout` (route handler).
- Placeholder pages: `/`, `/admin/damage`, `/admin/performance`,
  `/signup/[location]`.
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
  (Dashboard + Change Password + Sign Out) on `/admin/*` and
  `/sysadmin/*`.
- Damage detail (`/admin/damage/[id]`) renders every valid-from-status
  transition; rows whose `allowedRoles` don't include the caller's
  `session.dcRole` show with a disabled (greyed) button + an inline
  hint ("Requires admin or higher", or "Pending final approval" for the
  "Submit for Payment" transition specifically). Worker re-validates
  dc_role on POST as defense in depth — UI gating is a UX hint, not
  access control.

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
over a URL-based fetch. apps/web's `wrangler.toml` declares 5
`[[services]]` entries (`DASHBOARD_WORKER`, `SIGNUP_WORKER`,
`PERFORMANCE_WORKER`, `SYSADMIN_WORKER`, `DAMAGE_WORKER`). Each helper
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
  `suspicious_phones` immutability, etc.
- `packages/db-d1` - D1 helpers for damage-worker.
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

- **admin** - Pricing administration. Lives in signup-worker
  (`/admin/api/*`) + apps/web (`/admin/pricing/*`). Used by area
  managers and location admins to set per-location pricing modes.
- **sysadmin** - Database user/table management. Separate worker
  (sysadmin-worker, `/sysadmin/api/*`). Used by super_admins. Per
  recent operator decision, sysadmin also houses direct
  `pricing_simple` table editing (bypasses SQL for non-pricing-API
  changes). Brief 24 landed Add Location — atomic bulk insert of N
  `pricing_simple` rows for a brand-new location via Supabase REST
  array POST; hardcodes `pricing = 'full'`. Briefs 25 (Update
  Package) and 26 (Update Locations) are deferred but planned. A
  manual cache-clear button is also planned (signup-worker caches
  `pricing_simple_resolved` for 5 minutes; cross-worker invalidation
  isn't wired yet, so newly added locations take up to 5 minutes to
  surface on the customer signup form).
- **inline mode** - signup-worker's default `SIGNATURE_MODE`. Renders
  the form HTML and POSTs straight to `maxpass_signups`.
- **jotform mode** - signup-worker's alternative `SIGNATURE_MODE`. 302
  redirects to a JotForm with prefilled fields. Currently dormant -
  Family Plan form IDs are placeholders.
- **location_pretty** - Display name of a location (e.g., "Binghamton"
  vs. location_code "binghamton"). Resolved before Power Automate
  POSTs in the new damage-worker.
- **dc_role** - User's effective role for damage claims access scoping.
  super_admin sees all claims; gm/rm sees only their dcLocations.
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
