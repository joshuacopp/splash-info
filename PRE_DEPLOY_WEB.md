# PRE_DEPLOY — apps/web

Next.js 14+/App Router admin UI deployed via `@opennextjs/cloudflare`
to Cloudflare Workers. Hosts the entire admin surface (login, change
password, dashboard, pricing, damage, performance, sysadmin) plus the
root redirect and logout route. Customer-facing pages
(`/signup/{location}`, `/q/{location}`, `/join/{location}`,
`/claims/{site}`) live in their owning workers and are NOT served by
apps/web (Brief 50 + Brief 23 ownership decisions; CLAUDE.md
constraint #1).

Worker name: `splash-web`. Currently deployed only to its
`*.workers.dev` URL and `staging.splashcarwashes.info/*`.

Sister docs: [PRE_DEPLOY_DASHBOARD.md](PRE_DEPLOY_DASHBOARD.md),
[PRE_DEPLOY_SIGNUP.md](PRE_DEPLOY_SIGNUP.md),
[PRE_DEPLOY_PERFORMANCE.md](PRE_DEPLOY_PERFORMANCE.md),
[PRE_DEPLOY_SYSADMIN.md](PRE_DEPLOY_SYSADMIN.md),
[PRE_DEPLOY_DAMAGE.md](PRE_DEPLOY_DAMAGE.md).

---

## 1. Overview

apps/web is the Next.js admin UI. It is the single rendering surface
for every authenticated splashcarwashes.info admin page and the
auth-aware root redirect. It deploys via OpenNext-on-Cloudflare-Workers
(`.open-next/worker.js` is the entry; the `[assets]` binding serves
the static CSS/JS/public bundle). All five sister workers expose
JSON APIs that apps/web SSR-fetches via service bindings; apps/web
owns no JSON API of its own.

Routes hosted by apps/web:

| URL | Status |
|---|---|
| `/` | Brief 50 — auth-aware redirect to `/admin/dashboard` (cookie present) or `/login` (absent) |
| `/login` | Brief 1 — login page + form |
| `/change-password` | Brief 1 — change-password page + form |
| `/admin/dashboard` | Brief 4 — 4-tile card grid |
| `/admin/pricing` + `/admin/pricing/[location]` | pricing editor |
| `/admin/damage` + `/admin/damage/[id]` | damage manager (Briefs 5a/5b/5c/5d) |
| `/admin/performance` | performance tracker (Brief 6) |
| `/admin/sysadmin` | sysadmin two-mode hub + audit log (Briefs 7/30/34) |
| `/logout` | Brief 2 — server route handler; clears cookies + 302 to `/login` |

Routes NOT hosted by apps/web (per CLAUDE.md constraint #1, Brief 50,
Brief 23):

- `/signup/{location}`, `/q/{location}`, `/join/{location}` — owned by
  signup-worker (`splash-signup-next`, renames to `splash-signup` at
  cutover)
- `/claims/{site}`, `/claims/{site}/thanks`, `/claims-api/*`,
  `/manage/api/*` — owned by damage-worker (`splash-damage`)
- `/api/login`, `/api/logout`, `/api/forced-reset`, `/api/me` — owned
  by dashboard-worker (`splash-dashboard`)
- `/admin/api/*` (pricing JSON) — owned by signup-worker
- `/sysadmin/api/*` — owned by sysadmin-worker (`splash-sysadmin`)
- `/pertrack/*` — owned by performance-worker (`splash-performance`)

Cloudflare's most-specific-match-wins routing keeps these on their
worker even when apps/web is bound to a catch-all (staging today,
production at cutover).

## 2. Deploy mechanism

apps/web is the only deployable in this monorepo that does not deploy
via `wrangler deploy`. CF Workers Builds is wired to the GitHub repo
`joshuacopp/splash-info`; pushes to `main` trigger an automatic deploy.

| Setting | Value |
|---|---|
| Git repo | `joshuacopp/splash-info` (CF dashboard → Workers & Pages → splash-web → Settings → Build → Git repository) |
| Production branch | `main` |
| Watch paths | `apps/web/**`, `packages/**` |
| Build command | `pnpm install` |
| Deploy command | `pnpm --filter @splash/web exec opennextjs-cloudflare build && pnpm --filter @splash/web exec opennextjs-cloudflare deploy` |
| Non-prod branches | Build deploy previews per CF defaults |

Watch paths matter: a push that only touches `apps/<worker>/**` or
top-level docs (this file included) will not trigger a redeploy. If
you need to force a build without a substantive code change, push a
trivial edit to any file under `apps/web/**` or `packages/**`.

There is **no manual `wrangler deploy` step** for apps/web. Operator
pushes; CF builds. Local `pnpm --filter @splash/web build` is for
verification only — it produces no deployable artifact uploaded to CF.

## 3. Build-time configuration

### 3.1 NEXT_SERVER_ACTIONS_ENCRYPTION_KEY

This is the single most important build-time environment variable on
apps/web. Read [apps/web/.env.example](apps/web/.env.example) for the
full rationale; the short version:

- **Set as a CF Workers Builds build-time env var, NOT a runtime
  secret.** CF dashboard → Workers & Pages → splash-web → Settings →
  Build → Environment variables. Setting it via
  `wrangler secret put` has no effect — Next reads it during
  `next build`, which has already finished by the time the worker
  starts.
- **Without it, Next regenerates a fresh encryption key every
  build.** Fresh key → fresh server-action ID hashes → every open
  browser tab's previously-loaded action IDs get rejected on next
  submit, white-paging the operator with an `UnrecognizedActionError`
  client-side exception. Brief 31 documented this after the
  2026-05-05 grant-tool incident.
- **Do not rotate without coordination.** Rotating mid-business-hours
  invalidates every action ID on every open admin tab and produces
  the same white-page incident the variable exists to prevent. Plan
  rotations during a maintenance window when no operator is
  mid-session. If you must rotate, communicate first.
- **Defense in depth:**
  [apps/web/app/admin/error.tsx](apps/web/app/admin/error.tsx) is a
  segment-level error boundary that catches `UnrecognizedActionError`
  by message-substring (`"Server Action"` + `"was not found on the
  server"`) and renders a "Reload" CTA instead of a generic crash.
  Other errors fall through to a "Try again" CTA via `reset()`. The
  boundary is intentionally placed at `/admin/*` because every
  server-action write surface lives under that segment; do not move
  it deeper.
- **How to generate.** Once, ever — store the result in the team
  password manager:
  ```powershell
  $b = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [Convert]::ToBase64String($b)
  ```
  Or via openssl on bash:
  ```bash
  openssl rand -base64 32
  ```

### 3.2 NEXT_PUBLIC_*_WORKER_URL (dev-only; do NOT set in production)

Documented in [apps/web/.env.example](apps/web/.env.example) and
consumed by [apps/web/next.config.mjs](apps/web/next.config.mjs)'s
rewrite map. The five vars
(`NEXT_PUBLIC_DASHBOARD_WORKER_URL`,
`NEXT_PUBLIC_SIGNUP_WORKER_URL`,
`NEXT_PUBLIC_PERFORMANCE_WORKER_URL`,
`NEXT_PUBLIC_SYSADMIN_WORKER_URL`,
`NEXT_PUBLIC_DAMAGE_WORKER_URL`) only matter for `next dev` when
testing apps/web against live workers.dev URLs. When unset, the
rewrites collapse to an empty array and Next routes natively against
same-origin paths. **Production same-origin sets none of these.**
Setting them in CF Workers Builds is a misconfiguration — apps/web
would then proxy through to the workers.dev URLs at the edge, which
double-bills latency and bypasses the service bindings configured in
section 4.

## 4. Runtime configuration (service bindings)

### 4.1 The seven [[services]] entries in apps/web/wrangler.toml

[apps/web/wrangler.toml](apps/web/wrangler.toml) declares:

| Binding | Service (worker name) | Used by |
|---|---|---|
| `DASHBOARD_WORKER` | `splash-dashboard` | `apps/web/app/_lib/me.ts` (`getMe()`), login form, change-password form, logout route |
| `SIGNUP_WORKER` | `splash-signup-next` (renames to `splash-signup` at cutover) | `apps/web/app/admin/pricing/_lib/worker-fetch.ts` |
| `PERFORMANCE_WORKER` | `splash-performance` | `apps/web/app/admin/performance/_lib/worker-fetch.ts` |
| `SYSADMIN_WORKER` | `splash-sysadmin` | `apps/web/app/admin/sysadmin/_lib/worker-fetch.ts` |
| `DAMAGE_WORKER` | `splash-damage` | `apps/web/app/admin/damage/_lib/worker-fetch.ts` |
| `WORKORDERS_WORKER` | `splash-workorders` | `apps/web/app/workorders/_lib/worker-fetch.ts` |
| `FLEET_INQUIRY_WORKER` | `splash-fleet-inquiry` | `apps/web/app/admin/fleet/_lib/worker-fetch.ts` (Brief 83) |

`/admin/fleet*` is admin-gated (super_admin or dc_role admin/super_admin
only) and depends on `splash-fleet-inquiry` being deployed AND having
`SUPABASE_SERVICE_KEY` bound — see PRE_DEPLOY_FLEET.md section 4.6.

### 4.2 Why service bindings, not URL fetches

Brief 17 surfaced a Cloudflare same-zone Worker-to-Worker fetch quirk
during Brief 16's staging tests: URL fetches from one Worker to
another on the same zone loop through the edge inefficiently and 522
after ~19 s. Service bindings route the subrequest internally and pass
Cookie/headers cleanly.

apps/web's `_lib/worker-fetch.ts` helpers (one per admin sub-tree:
pricing, damage, performance, sysadmin, plus `app/_lib/me.ts` for
dashboard) implement a binding-first / URL-fallback pattern:

1. Call `getCloudflareContext({ async: true })`.
2. If the binding exists, build a `new Request("https://internal" + path, ...)`
   and call `env.<BINDING>.fetch(req)`. The `https://internal` host
   is a placeholder — service bindings ignore the host; only the
   path matters.
3. Forward `cookies().toString()` so the worker's `authenticate()`
   helper can validate `sb-access-token` / `sb-refresh-token`.
4. For POST helpers, set `Origin` explicitly to
   `new URL(url).origin`. The worker's CSRF gate
   (`isOriginAllowed`) requires it, and the binding-side Request's
   `https://internal` host won't pass that check by itself.
5. Wrap the entire binding call in try/catch. The catch branch falls
   back to a URL-based fetch using `NEXT_PUBLIC_*_WORKER_URL` (dev
   cross-origin) or the request host (same-origin via
   `next.config.mjs` rewrites). The catch covers `next dev` (where
   `getCloudflareContext()` throws because the runtime isn't CF
   Workers) AND any future runtime where the binding is unbound.

Type declarations for the bindings live in
`apps/web/cloudflare-env.d.ts` and merge into the global
`CloudflareEnv` interface.

Photo URLs and check-request preview URLs that the BROWSER fetches
(not the apps/web Worker) stay URL-based — service bindings don't
apply to browser-issued requests.

### 4.3 Verifying service bindings post-deploy

- CF dashboard → Workers & Pages → splash-web → Settings → Bindings.
  All five bindings should be listed with their target worker name
  resolved (no "service not found" warnings).
- `apps/web/wrangler.toml` is the source of truth for the binding
  names. Don't rename a binding without grepping every consumer:
  - `apps/web/app/_lib/me.ts`
  - `apps/web/app/admin/*/lib/worker-fetch.ts`
  - `apps/web/app/admin/pricing/_lib/worker-fetch.ts`
  - `apps/web/app/login/form.tsx` and `apps/web/app/change-password/form.tsx`
- A binding can't outlive its target worker. If a sister worker is
  renamed or deleted, the binding goes red and every admin page
  using that helper degrades to the URL-fallback path (or fails
  outright in production where no fallback URL is set).

### 4.4 Sister-worker dependency

apps/web's `/admin/*` routes are SSR-only — every page-level
data fetch hits a sister worker via service binding before the HTML
ships. If a sister worker is down or returning 5xx, the corresponding
admin page surfaces the error inline through Brief 19's
`<ActionForm>` pattern (or a route-level error banner for read paths).
The page does NOT crash; the operator sees a "Couldn't load X / Try
again" affordance.

This means an apps/web deploy that "looks broken" usually isn't —
check the sister worker's Observability tab first (section 7.7).

## 5. Pre-deploy checklist

Run through this before any push that might affect apps/web. Apps/web
auto-deploys on push to `main` once the watch paths fire, so this
checklist is the deploy gate.

- [ ] CF Workers Builds is connected to GitHub
      (`joshuacopp/splash-info`). Verify in CF dashboard → Workers
      & Pages → splash-web → Settings → Build → Git repository.
- [ ] Watch paths are `apps/web/**` and `packages/**`. Mismatched
      watch paths silently skip deploys; the symptom is a push that
      lands cleanly on GitHub but produces no new build in the CF
      Deployments tab.
- [ ] `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is set under Environment
      variables (Build settings, NOT runtime secrets). Verify the
      value matches the team password manager copy. Without it,
      every prod tab opened before the deploy white-pages on next
      form submit.
- [ ] All five `[[services]]` entries in
      [apps/web/wrangler.toml](apps/web/wrangler.toml) are present
      and reference the correct worker names. The `service`
      field must match the `name = "..."` in each sibling worker's
      wrangler.toml.
- [ ] Sister workers are all healthy on `*.workers.dev` (curl one
      smoke-test endpoint per worker — see each
      `PRE_DEPLOY_<NAME>.md`). A service binding can't outlive its
      target worker.
- [ ] `pnpm typecheck` passes on the branch being pushed (13/13
      green).
- [ ] `pnpm --filter @splash/web build` succeeds locally. This
      catches webpack-specific module resolution problems that
      `pnpm typecheck` (TypeScript-only) doesn't.
- [ ] If the change touches `packages/**`, double-check that no
      `.js` extension snuck back into imports/re-exports inside
      `packages/ui`. Brief 1 fixed nine of these; tsc Bundler
      resolution accepts them, Next.js webpack chokes, and the
      symptom is an opaque build error.
- [ ] If the change touches anything under `apps/web/app/admin/*`
      or any `_lib/worker-fetch.ts`, mentally verify Brief 19's
      contract still holds: server actions return a serializable
      `ActionResult`; redirects come from
      [apps/web/app/admin/_components/ActionForm.tsx](apps/web/app/admin/_components/ActionForm.tsx)
      via `router.refresh()`, not from `redirect()` inside the
      action body.

## 6. Smoke tests post-deploy

After CF Workers Builds reports the deploy as complete, wait 1-3
minutes for edge propagation (section 7.1) before running these.
Run on `staging.splashcarwashes.info` for staging deploys; on
`splashcarwashes.info` for cutover-and-after.

- [ ] `GET /` while signed out → 307 to `/login`.
- [ ] Sign in via `/login` (real test account) → lands on
      `/admin/dashboard`. Header shows the operator's email + role
      label, plus Dashboard / Change Password / Sign Out controls.
- [ ] `/admin/dashboard` renders all four card-grid tiles (Pricing,
      Damage, Performance, Sysadmin). No console errors.
- [ ] `/admin/pricing/binghamton` (or any active location) renders
      the pricing editor. No console errors. Edits save and reflect
      back without manual reload.
- [ ] `/admin/sysadmin?mode=users` — Set Role and Create User cards
      render. The `LocationCodePicker` (Briefs 39 + 40) populates
      when typing a 3-digit site number, location code, or
      `location_pretty` substring.
- [ ] `/admin/sysadmin?mode=tables` — audit log loads at the bottom
      of the page (Brief 30 + 34). Filter row works; "Load more"
      paginates; no 500s in the worker's Observability tab.
- [ ] `/admin/damage` — claim list renders. Filter form filters
      cleanly.
- [ ] `/admin/damage/[any-recent-claim-id]` — detail page renders.
      Transition buttons appear for valid-from-status transitions;
      out-of-role rows show greyed with "Requires <minRole> or
      higher". If the claim has `equipment_related = 0` and is in
      a status that allows Approve transitions, the
      [`EquipmentOverrideModal`](apps/web/app/admin/damage/_components/EquipmentOverrideModal.tsx)
      (Briefs 43 + 45) opens via the portal pattern when an
      Approve button is clicked.
- [ ] `/admin/performance` — list page renders, LocationPicker
      typeahead populates, new-submission card works.
- [ ] `/logout` — clicking Sign Out clears the cookie and redirects
      to `/login`.
- [ ] Open a deploy-vintage browser tab from before the deploy,
      submit any admin form. The submit must NOT white-page. If
      `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is set correctly, the
      submit lands cleanly. If something went wrong, the
      `/admin/error.tsx` boundary should catch it and render the
      Reload CTA. (Either result is a passing test; a generic
      browser white-page is a failure.)

## 7. Known gotchas

### 7.1 CF edge propagation lag (1-3 minutes)

After CF Workers Builds reports a deploy as complete, edge POPs may
serve stale or partial bundles for 1-3 minutes. Symptoms include
transient 403/404/522 on freshly-deployed routes that work fine
moments later, and a "deploy looks half-rolled-out" feeling where
some requests hit the new code and others hit the old.

Don't deep-dive on Access/WAF/route bindings during this window.
Wait three minutes, retry, then investigate. This bit operators
during Brief 49-era staging work.

### 7.2 Server-action redirect-vs-router.refresh

Server actions called from server-rendered `<form action={fn}>`
must NOT use `redirect()` for success or error feedback. The runtime
quirk: Next 15 server actions running on
OpenNext-on-Cloudflare-Workers don't reliably propagate `redirect()`
calls to a visible client-side navigation. Brief 18 surfaced this in
staging — actions ran to completion and the DB updated, but the
browser sat on the pre-action URL until manual reload.

Brief 19's pattern is the contract:

1. Action returns a serializable `ActionResult` —
   `{ ok: true; message?: string } | { ok: false; error: string }`.
2. Form is wrapped in
   [`<ActionForm>`](apps/web/app/admin/_components/ActionForm.tsx),
   a client island that dispatches via React 19's `useActionState`,
   renders the result inline (`role="status"` for ok,
   `role="alert"` for failure), and calls `router.refresh()` on a
   fresh ok result.
3. `revalidatePath` stays on the success path of the action so the
   subsequent `router.refresh()` sees the post-mutation state.

The damage detail page and sysadmin page are reference
implementations. Future write-action briefs follow this pattern;
the redirect-+-searchParam pattern is retired.

The lone exception is the document upload form on damage detail
(Brief 37) — that form posts directly to damage-worker as a
multipart `<form>` and bypasses Next server actions entirely
because iPhone Safari multipart through OpenNext was unreliable.
The `?upload_error=<msg>` searchParam pattern is intentionally
re-introduced for that one form only.

### 7.3 Modal-inside-form nesting

A modal component that renders a `<form>` inside a parent `<form>`
produces invalid HTML and non-deterministic browser behavior (Brief
45). Symptoms: form submissions silently no-op a fraction of the
time (operator confirmed ~4/5 silent failures pre-Brief-45 fix).

New modal components rendered anywhere under `/admin/*` must use
`createPortal(…, document.body)` to escape the parent form's DOM,
SSR-guarded via `typeof document !== "undefined"`. Reference:
[apps/web/app/admin/damage/_components/EquipmentOverrideModal.tsx](apps/web/app/admin/damage/_components/EquipmentOverrideModal.tsx).

### 7.4 Cookie-based middleware

[apps/web/middleware.ts](apps/web/middleware.ts) (Brief 1, extended
in Brief 2) is the single source of auth truth for `/admin/*` and
`/sysadmin/*` plus the legacy-URL 308 redirects. Cookies are
namespaced as `sb-access-token` / `sb-refresh-token`.

The constants live in `packages/auth`'s `index.ts`, but
**must NOT be imported from `middleware.ts`** — the Edge runtime
that Next runs middleware in can't load `packages/auth` (it's
server-only Node). The current middleware re-declares the cookie
name as a literal string; `apps/web/app/page.tsx`'s root redirect
takes the same posture for the same reason. Don't "DRY this up" by
adding an Edge-safe re-export — the duplication is intentional.

### 7.5 Cross-origin dev limitation

Cookies set by `splash-dashboard.<account>.workers.dev` won't reach
`splash-web.<account>.workers.dev` under SameSite=Lax. Login fully
works only:

1. After cutover, when both share `splashcarwashes.info`, OR
2. Via local dev with a same-origin proxy. The
   [`next.config.mjs`](apps/web/next.config.mjs) rewrite map covers
   this when `NEXT_PUBLIC_*_WORKER_URL` env vars are set in
   `.env.local`. With the rewrites in place the browser sees
   `localhost:3001` for everything and cookies persist.

This is why the workers.dev test URLs are useful for one-shot smoke
checks but not for a full UI session.

### 7.6 Customer-facing routes are NOT apps/web's job

Per Brief 50 (and Brief 23 before it), the customer-facing URLs
`/signup/{location}`, `/q/{location}`, `/join/{location}`,
`/claims/{site}` are served by their owning workers. CF route
bindings at the edge route those paths to the correct worker; CF's
most-specific-match-wins routing keeps them off apps/web even when
apps/web is bound to a catch-all. **Do not add a Next.js page at
any of those paths.** A Next.js placeholder there would either
silently shadow the worker (depending on route-precedence order)
or, more likely, get correctly outranked by the worker route and
serve dead code.

CLAUDE.md constraint #1 captures this; the load-bearing customer
URLs (saved on hundreds of admin/customer device home screens) are
non-negotiable.

### 7.7 Service binding == sister-worker dependency

apps/web fails open-but-degraded when a sister worker is unhealthy.
If you see admin pages showing "couldn't load X" errors after a
deploy, it's almost certainly NOT apps/web — check the sister
worker's Observability tab in CF dashboard before assuming the
apps/web deploy is at fault. The five sister workers and their
Observability link points are listed in each `PRE_DEPLOY_<NAME>.md`.

### 7.8 Service bindings require Origin header

The `isOriginAllowed` CSRF gate on every sister worker (CSRF
retrofit, Brief 17 era) requires the inbound `Origin` header to
match the worker's allowed list. When apps/web calls a sister
worker via service binding, the inbound Request uses
`https://internal` as host — NOT the apps/web origin. The
`_lib/worker-fetch.ts` POST helpers explicitly set
`Origin: new URL(url).origin` to make the CSRF gate pass.

Don't bypass the helpers. If you find yourself building a
hand-rolled `env.<BINDING>.fetch(...)` call in a new file, set
`Origin` explicitly or you'll get 403s from every POST.

## 8. Rollback procedure

### 8.1 Standard rollback (preferred)

```bash
# from any clean checkout of main:
git revert <bad-commit>
git push origin main
# CF Workers Builds detects the push, builds the reverted tree,
# deploys; edge propagates within 1-3 minutes (section 7.1).
```

This is the "canonical" rollback. The git history reflects the
revert, the next push lands on top of clean state, and the deploy
trail in CF dashboard tracks the rollback as a real build.

### 8.2 Dashboard rollback (faster, no git history)

When something is actively broken on production and a git revert is
either slow to build or carries unrelated changes:

1. CF dashboard → Workers & Pages → splash-web → Deployments tab.
2. Locate the previous-known-good deployment (the one before the
   bad one).
3. Click the "..." menu → **Rollback to this deployment**.

This serves the previous artifact immediately. **Important:** the
operator must still revert the bad commit on `main` afterward, OR
the next push that triggers a build will re-deploy the broken state
on top of the rollback. Treat dashboard rollback as a stopgap, not
the final fix.

### 8.3 Emergency: cookie purge

If a deploy ever breaks the auth cookie format (renames
`sb-access-token`, changes the cookie attributes, etc.), all open
sessions need to log in again. Communicate to operators BEFORE
deploying any auth-cookie change. There is no soft-migration path
for a cookie shape change short of running both shapes in parallel
on the read path for a window — out of scope for normal deploys.

## 9. Cutover-day specific (BUILD_STATE item 13)

When the operator decides to flip apps/web from
`staging.splashcarwashes.info` to production
`splashcarwashes.info`:

1. Uncomment the `[[routes]]` block in
   [apps/web/wrangler.toml](apps/web/wrangler.toml). Replace the
   staging catch-all with the production catch-all:
   ```toml
   routes = [
     { pattern = "splashcarwashes.info/*", zone_name = "splashcarwashes.info" }
   ]
   ```
   Do NOT enumerate per-path overrides — `/admin/*`, `/login`,
   `/logout`, `/change-password` all stay on apps/web; the
   worker-owned customer routes have their own bindings that take
   precedence by CF most-specific-match-wins.
2. Push to `main`. CF Workers Builds detects the push and redeploys
   with the routes block live.
3. Verify in CF dashboard → splash-web → Triggers / Routes that the
   new routes are listed and active.
4. Smoke-test login flow end-to-end on `splashcarwashes.info`
   (run section 6 against the production hostname).
5. If any worker-route conflicts surface, CF will display a
   routing-precedence error in the dashboard. Most-specific path
   wins. The five sister workers' route patterns
   (`/api/*`, `/signup/*`, `/q/*`, `/join/*`,
   `/api/submit-signup`, `/admin/api/*`, `/pertrack/*`,
   `/sysadmin/api/*`, `/manage/api/*`, `/claims-api/*`,
   `/claims/*`) all outrank the apps/web catch-all automatically.
6. Update `NEXT_PUBLIC_*_WORKER_URL` env vars in CF Workers Builds:
   **REMOVE them.** They're dev-only. In production same-origin the
   rewrites collapse and apps/web hits sister workers via service
   bindings instead. Leaving them set silently routes traffic
   through the workers.dev URLs at the edge (which double-bills
   latency and bypasses bindings).
7. Smoke-test all 8 admin routes and the root redirect again on
   `splashcarwashes.info`.
8. Communicate cutover-complete; expect operators with old tabs
   open from the staging hostname to need to re-login (different
   origin → different cookie).

## 10. Post-cutover follow-ups

- Rename `splash-signup-next` → `splash-signup` in the CF dashboard
  (Workers & Pages → splash-signup-next → Settings → Worker name)
  AND in apps/web's `[[services]]` entry for `SIGNUP_WORKER`. Push
  the wrangler.toml change; CF Builds redeploys apps/web to pick
  up the renamed binding target. Coordinate with signup-worker's
  cutover plan (only production-critical worker — see
  [PRE_DEPLOY_SIGNUP.md](PRE_DEPLOY_SIGNUP.md) and CUTOVER_PLAN.md).
- Retire the legacy `info-signup-worker` once `splash-signup` (or
  whatever it's renamed to) is bearing 100% of customer signup
  traffic and has been stable for an operator-defined burn-in
  window.
- Decommission staging-specific env vars and routes
  (`staging.splashcarwashes.info` route binding, any
  `NEXT_PUBLIC_*_WORKER_URL` values left in CF Builds env from
  earlier dev-against-workers.dev sessions).
- Backfill `PRE_DEPLOY_WEB.md` cross-references into the five sister
  `PRE_DEPLOY_*.md` files (mention this doc in each — small hygiene
  pass, not blocking). Tracked in this brief's Out-of-scope section.
- Once the sysadmin Activity log has accumulated a few weeks of
  real production traffic, pull a sample to validate that the
  Brief 30/34 audit-log filtering covers the queries operators
  actually run; tune the allow-list filters if anything's
  consistently missing.
