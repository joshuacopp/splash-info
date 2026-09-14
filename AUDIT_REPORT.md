# apps/web vs legacy info-signup-worker — pre-cutover audit

**Generated:** 2026-05-03
**Scope:** read-only audit. No files modified, no deploys, no commits.
**Trigger:** discovery during cutover prep that `CUTOVER_PLAN.md` declared "build phase complete" without auditing apps/web's coverage of the legacy URL surface.

**Bottom line up front:** apps/web is **not ready** to replace `legacy/signupworker.js` for production traffic. Of 8 page files in `apps/web/app/`, **5 are Step-4 placeholder text and 3 are real implementations.** Critical missing pieces include the entire login flow (no `/admin/login` equivalent in apps/web), the public customer signup pages (placeholder only), the public claim form, the damage manager UI, the sysadmin UI, the admin landing page, and the performance tracker UI. The cutover plan's worker-only readiness is real but doesn't reflect end-user readiness.

---

## 1. URL inventory — apps/web/app/

Walked `apps/web/app/` recursively. 8 page files total + 1 layout. **No `route.ts` files. No `middleware.ts`.**

| URL pattern | File | Status | What it does | Backend calls |
|---|---|---|---|---|
| `/` | [`apps/web/app/page.tsx`](apps/web/app/page.tsx) | **PLACEHOLDER** | Returns "Step 4 scaffold. Real pages port in Step 7." | none |
| `/admin/dashboard` | [`apps/web/app/admin/dashboard/page.tsx`](apps/web/app/admin/dashboard/page.tsx) | **PLACEHOLDER** | "Step 4 placeholder. Port from renderDashboard (legacy/dashboard.js) in Step 7." | none |
| `/admin/damage` | [`apps/web/app/admin/damage/page.tsx`](apps/web/app/admin/damage/page.tsx) | **PLACEHOLDER** | "Step 4 placeholder. Port from /manage/* HTML (legacy/damagemanager.js) in Step 7." | none |
| `/admin/performance` | [`apps/web/app/admin/performance/page.tsx`](apps/web/app/admin/performance/page.tsx) | **PLACEHOLDER** | "Step 4 placeholder. Port from legacy ui.js (referenced by performancetracker.js) in Step 7." | none |
| `/admin/pricing` | [`apps/web/app/admin/pricing/page.tsx`](apps/web/app/admin/pricing/page.tsx) | **REAL** | Server component — fetches accessible locations, renders picker, redirects to single-location grid when only one. | `GET /admin/api/locations` (signup-worker) |
| `/admin/pricing/[location]` | [`apps/web/app/admin/pricing/[location]/page.tsx`](apps/web/app/admin/pricing/[location]/page.tsx) + [`grid.tsx`](apps/web/app/admin/pricing/[location]/grid.tsx) | **REAL** | Read-only package list + 6-button row (Quick Flip / Full / Same / Flash5 / Flash2 / Special) + `PackagePickerModal` for the 5 modal-required modes. | `GET /admin/api/locations/{loc}`<br>`POST /admin/api/locations/{loc}/set-mode`<br>`POST /admin/api/locations/{loc}/flip`<br>(all signup-worker) |
| `/change-password` | [`apps/web/app/change-password/page.tsx`](apps/web/app/change-password/page.tsx) + [`form.tsx`](apps/web/app/change-password/form.tsx) | **REAL** | Client form for forced-reset / voluntary password change. Reads `?required=true&next=/admin` query params. | `POST /api/forced-reset` (dashboard-worker) |
| `/signup/[location]` | [`apps/web/app/signup/[location]/page.tsx`](apps/web/app/signup/[location]/page.tsx) | **PLACEHOLDER** | "Step 4 placeholder. Port from renderPicker (legacy/signupworker.js) in Step 7." Returns the location name in a heading. | none |

**Helper module:** [`apps/web/app/admin/pricing/_lib/worker-fetch.ts`](apps/web/app/admin/pricing/_lib/worker-fetch.ts) — `workerGetJson<T>(path)` constructs an absolute URL from the request's `host` header, forwards cookies via `next/headers`, returns `null` on 401/403.

**Layout:** [`apps/web/app/layout.tsx`](apps/web/app/layout.tsx) — minimal: white logo image + `<main>{children}</main>`. No nav, no auth wrapper. Step-4 placeholder; comment says "Replaced with proper @splash/ui components in Step 5/7."

**Of the 8 pages: 3 real, 5 placeholder.**

---

## 2. URL inventory — legacy `info-signup-worker`

Source: [`legacy/signupworker.js`](legacy/signupworker.js) (3,332 lines, single-file Service Worker). Dispatch logic at lines 22-83 + `handleAdminRoutes` at lines 87-209.

### Top-level dispatcher

| Method | URL pattern | Description | File:line |
|---|---|---|---|
| ANY | `/admin/clear-cache` | Manually invalidates the `caches.default` entry for `pricing_simple_resolved` view. Returns plain text "✅ Cache cleared". | `signupworker.js:28-35` |
| ANY | `/admin/*` | Delegates to `handleAdminRoutes` (see below). | `signupworker.js:38` |
| POST | `/api/submit-signup` | Customer signup submission — fraud detection (hardcoded deny / suspicious_phones / count escalation) + `maxpass_signups` insert. Returns one of four JSON modal shapes. | `signupworker.js:41-43` (handler at 213-457) |
| GET | `/signup/{location}`<br>`/q/{location}`<br>`/join/{location}` | Package picker — reads `pricing_simple_resolved` cache, sorts by `sort`, renders `renderPicker` HTML. The `q` and `join` prefixes are aliases. | `signupworker.js:46-65` |
| GET | `/signup/{location}/{pkg}`<br>`/q/{location}/{pkg}`<br>`/join/{location}/{pkg}` | Signup form — reads cached package row, renders `renderSignupForm` HTML with phone / email / terms-checkbox + the four-modal client JS. | `signupworker.js:67-80` |
| ANY | other | 404. | `signupworker.js:82` |

### Admin sub-router (`handleAdminRoutes`)

| Method | URL pattern | Description | File:line |
|---|---|---|---|
| GET | `/admin/login` | Renders the pricing admin login form HTML. | `signupworker.js:91-93` |
| POST | `/admin/login` | Validates email/password against Supabase, sets `sb-access-token` + `sb-refresh-token` cookies, 302s to `/admin`. | `signupworker.js:94-96` |
| ANY | `/admin/logout` | Clears the auth cookies, 302s to `/admin`. | `signupworker.js:99-109` |
| GET | `/admin/change-password` | Renders the password-change form. | `signupworker.js:120-122` |
| POST | `/admin/change-password` | Updates Supabase password via Admin API, clears `must_change_password`. | `signupworker.js:123-125` |
| GET | `/admin` (no slug) | Redirects: 0 locations → 403 "no locations" page; 1 location → `/admin/{code}`; >1 → `/admin/{email-prefix}`. | `signupworker.js:144-156` |
| GET | `/admin/{email-prefix}` | "Personal" page — renders pricing UI for ALL locations the user has access to. | `signupworker.js:158-164` |
| POST | `/admin/{email-prefix}` | Bulk update across the user's permitted locations (`handleBulkUpdate`). | `signupworker.js:165-167` |
| GET | `/admin/{location_code}` | Per-location pricing UI — renders the bubble-background card grid with the 6-button row + package-picker modal client JS. | `signupworker.js:176-179` |
| POST | `/admin/{location_code}` | Mode-change form submit — `action=full|same|flash5|flash2|special|flip`, `pkg_list[]`, `special_price`. | `signupworker.js:181-206` |

**Total legacy URL surface: 3 public-customer routes (×3 prefix aliases for the 2 signup paths = 7 distinct customer URLs) + 1 customer API + ~9 admin routes = ~17 distinct production URLs.**

---

## 3. Gap analysis — legacy serves, apps/web doesn't

| Legacy URL | apps/web equivalent | Gap |
|---|---|---|
| `GET /admin/login` | **NONE** | **Critical gap.** apps/web has no login page anywhere in the URL inventory. Users currently log in only via `/admin/login` (legacy) or via dashboard-worker's `POST /api/login` (which has no GET form to submit). After cutover, if legacy is removed, there is no entry point to obtain an `sb-access-token` cookie via apps/web. |
| `POST /admin/login` | **dashboard-worker `POST /api/login`** | URL change. Legacy posted to `/admin/login`; new flow posts to `/api/login` on dashboard-worker. The form HTML doesn't exist anywhere in apps/web yet — needs `app/login/page.tsx`. |
| `GET /admin/logout` | **NONE** in apps/web (dashboard-worker has `POST /api/logout`) | Method + URL change. Legacy was a GET that cleared cookies and redirected. New is a POST. No apps/web "Sign Out" button exists anywhere. |
| `GET /admin/change-password` | **`/change-password`** | URL drift. Legacy was at `/admin/change-password`; apps/web at `/change-password`. Functionally equivalent — apps/web's posts to dashboard-worker's `POST /api/forced-reset` which runs `userCompleteForcedReset`. **Either redirect `/admin/change-password` → `/change-password` at the route layer, or rename apps/web's path to match legacy. Picking either is fine; not picking is the bug.** |
| `POST /admin/change-password` | **dashboard-worker `POST /api/forced-reset`** | URL change. Same-as-above resolution required. |
| `GET /admin` (no slug) | **NONE** | Legacy redirects based on user's locations. apps/web has `/admin/dashboard` (placeholder) and `/admin/pricing` — no router decision at bare `/admin`. Either map `/admin` → `/admin/dashboard` (when that page is real) or to `/admin/pricing` (current real page). |
| `GET /admin/{email-prefix}` | **NONE** | "Personal page" showing all locations a user manages. apps/web's `/admin/pricing` already covers the location-picker case (when >1 location). The email-prefix URL is a nicety from legacy that may not be worth porting — but if anyone has bookmarked their personal page, redirecting `/admin/{email-prefix}` → `/admin/pricing` would preserve those bookmarks. |
| `GET /admin/{location_code}` | **`/admin/pricing/{location}`** | URL drift. Legacy: `/admin/binghamton`. New: `/admin/pricing/binghamton`. **Same flag as `/admin/change-password` — pick a side.** Note: legacy uses the bare location_code as the URL slug; the new path adds `/pricing/` between `/admin` and the slug. Anyone bookmarked at `/admin/binghamton` will 404 post-cutover unless `/admin/{not-a-known-page}` redirects. |
| `POST /admin/{location_code}` | **signup-worker `POST /admin/api/locations/{loc}/set-mode`**<br>**`POST /admin/api/locations/{loc}/flip`** | Architecture change (form-POST → JSON API). The new endpoints exist and work; only the URL surface diverged. Already-bookmarked legacy form POSTs from third-party tooling (if any) would 404 — verify no external systems POST to `/admin/{loc}` directly. |
| `ANY /admin/clear-cache` | **NONE** | Manual cache-bust endpoint. Legacy used it for emergency cache invalidation. New cache (signup-worker) auto-invalidates on every admin write via `invalidatePricingCache`, so the manual endpoint is mostly redundant — but no equivalent exists if you ever want to nuke the cache without making a write. **Low-priority gap.** |
| `POST /admin/{email-prefix}` | **signup-worker `POST /admin/api/bulk-set-mode`** | The bulk endpoint exists on signup-worker. The bulk operation is super_admin-only in the new code; legacy's "personal page" bulk submitted across the user's own locations regardless of role. **Behavior change worth flagging** — legacy permitted location_admins to bulk-update their own locations; new bulk requires super_admin. |
| `GET /signup/{location}` | **`/signup/[location]`** placeholder + signup-worker's inline render | apps/web's page is a Step 4 stub; signup-worker still owns the real rendering via `signature/inline.ts` → `render/picker.ts`. **See section 7.** |
| `GET /signup/{location}/{pkg}` | **NO apps/web page** + signup-worker's inline render | No `[pkg]` route in apps/web. signup-worker owns this entirely. |
| `GET /q/{...}`, `/join/{...}` | **NONE** | Aliases of `/signup/*`. signup-worker preserves them via `SIGNUP_PREFIXES = ["/signup", "/q", "/join"]`. apps/web has only `/signup/[location]`. |
| `POST /api/submit-signup` | **signup-worker** | Worker-owned post-cutover. No apps/web change needed (form posts directly to the worker). |

### URLs apps/web serves that legacy doesn't

Checked. **apps/web exposes 3 URL patterns legacy doesn't:**

| URL | Notes |
|---|---|
| `/admin/dashboard` | Placeholder. Legacy didn't have an admin landing dashboard at `/admin/dashboard` — its `/admin` (no slug) redirected to a location. |
| `/admin/damage`, `/admin/performance` | Placeholders. Damage manager UI in legacy lives at `/manage/*` (damage-worker territory). Performance tracker in legacy lives at `/pertrack/*` (performance-worker territory). New URLs consolidate these under `/admin/*` per the new architecture pattern. **Not strictly a gap** — an architecture choice. But until `/admin/damage` and `/admin/performance` are real, customers / managers using `/manage` and `/pertrack` won't find their way over. |
| `/admin/pricing/[location]` | The new pricing URL path. Working. Legacy was at `/admin/{location}` (no `/pricing/` segment). |
| `/change-password` | Forced-reset path. Legacy was at `/admin/change-password`. |

---

## 4. Sysadmin UI state

**Confirmed: zero `/sysadmin/*` pages in apps/web.** No `app/sysadmin/` directory exists. Verified via `find apps/web/app -type d`.

**JSON endpoints provided by [`apps/sysadmin-worker/src/index.ts`](apps/sysadmin-worker/src/index.ts):**

| Method | Path | Handler | Body |
|---|---|---|---|
| POST | `/sysadmin/api/grant-tool` | `handleGrantTool` (line 120) | `{ user_id, tool }` |
| POST | `/sysadmin/api/revoke-tool` | `handleRevokeTool` (line 151) | `{ user_id, tool }` |
| POST | `/sysadmin/api/set-role` | `handleSetRole` (line 177) | `{ user_id, role, location_code? }` |
| POST | `/sysadmin/api/reset-password` | `handleResetPassword` (line 227) | `{ user_id, new_password }` |
| POST | `/sysadmin/api/create-user` | `handleCreateUser` (line 256) | `{ email, password, role?, tools? }` |

All 5 are super_admin-gated and CSRF-checked. **A future `app/sysadmin/page.tsx` would consume these. Today there is no UI for any of them — sysadmin operations require a direct `curl` against the worker's workers.dev URL by an authenticated super_admin.** Functional reality: Josh is the only super_admin, and Josh runs admin operations via SQL or direct curl. Acceptable for cutover; not for ongoing ops.

---

## 5. Claims UI state

### Manager interface (auth-gated)

`apps/web/app/admin/damage/page.tsx` — **PLACEHOLDER**. The legacy manager UI (`/manage/*` in `legacy/damagemanager.js` ~line 3262) renders:

- `/manage/` — claim list with filters (search, location, status, lifecycle)
- `/manage/claim/{id}` — claim detail page with photos, activity timeline, transition buttons
- `/manage/login`, `/manage/logout`, `/manage/change-password` — retired in the port (consolidated to dashboard-worker SSO)

damage-worker owns the JSON API for this UI:
- `GET /manage/api/claims` — list
- `GET /manage/api/claim/{id}` — detail
- `POST /manage/api/claim/{id}/note`, `/transition`, `/document`, `/document/{docId}/{delete|edit}`
- `GET /manage/api/claim/{id}/quote/{quoteId}/preview-check-request.pdf`

**The manager UI is unbuilt in apps/web.**

### Public customer claim form

**Confirmed: zero `/claims/*` pages in apps/web.** No `app/claims/` directory exists.

Legacy public claim form is rendered by **damage-worker, not apps/web** — at `GET /claims/{siteName}` (legacy/damagemanager.js:55-60, `renderDamageForm`).

What the legacy claim form renders (from `handleClaimSubmission` field extraction at `damagemanager.js:79-113`):

**Customer fields:**
- `customerName`, `customerPhone`, `customerEmail`, `mailingAddress`
- `licensePlate`, `vehicleMake`, `vehicleModel`, `vehicleYear`, `vehicleColor`
- `issueDescription`

**Employee assessment fields (filled in-store after the customer):**
- `employeeName`, `location`, `locationPretty`, `membershipNumber`
- `preExistingDamage`, `equipmentInvolved`, `equipmentMalfunction` (boolean), `determination`
- `customerTold`, `customerDemeanor`

**Photo categories (4 multipart inputs, multi-file each):**
- `fourCornersPhotos` (Vehicle Overview)
- `vinPhoto` (VIN)
- `damagePhotos` (Damage)
- `platePhoto` (License Plate)

**Location list source:** the URL itself encodes the location (`/claims/{siteName}`). The form derives a display name via `siteName.split(/[-_]/).map(...).join(" ")` (legacy/damagemanager.js:570-574) — no DB lookup, no dropdown. Each location has a bookmarked URL handed to staff at site setup. **The form has no location picker — it's URL-locked.**

POSTs to `damage-worker:/claims-api/submit-claim` — that endpoint exists and is fully ported. Photos to R2, JSON archive to R2, claim row to D1, Power Automate webhook for SharePoint sync.

**The public claim form is unbuilt in apps/web; damage-worker still serves it via `renderDamageForm`. Until that ports, customers filing damage claims hit damage-worker HTML, not apps/web.** Damage-worker is fine to keep doing this — `/claims/*` isn't on apps/web's documented route plan.

---

## 6. Auth / cookie integration in apps/web

### Cookie reads

Search for `cookie` / `sb-access-token` references across apps/web:

| File | Usage | Notes |
|---|---|---|
| `app/admin/pricing/_lib/worker-fetch.ts` | `cookies()` from `next/headers` → `cookieStore.toString()` → forwards as `Cookie:` header on the worker fetch | Server-side only (uses `next/headers`). The pages that consume this are the pricing pages. |
| `app/change-password/form.tsx` | `credentials: "same-origin"` on the fetch | Client-side. Browser attaches cookies automatically; no explicit read. |
| `app/admin/pricing/[location]/grid.tsx` | `credentials: "same-origin"` on every action POST | Same — browser-attached. |
| `app/admin/pricing/page.tsx` | `workerGetJson("/admin/api/locations")` — cookie forwarded via the helper | Indirect; same flow as the helper. |
| `app/admin/pricing/[location]/page.tsx` | `workerGetJson("/admin/api/locations/{loc}")` — same | Indirect. |
| `app/signup/[location]/page.tsx` | none (placeholder) | — |

### No middleware

`find apps/web -maxdepth 2 -name "middleware*"` returns nothing. **There is no centralized auth check in apps/web.** Every page that needs auth handles it ad-hoc:

- `app/admin/pricing/page.tsx` calls `workerGetJson` which forwards the cookie; the worker's `adminGate` does the auth check; the page renders a "no access" message when the helper returns `null` (401/403 from the worker).
- `app/admin/pricing/[location]/page.tsx` — same pattern.
- `app/change-password/page.tsx` doesn't auth-check at all (the form's POST to `/api/forced-reset` triggers the auth check on the worker side).
- `app/admin/dashboard`, `app/admin/damage`, `app/admin/performance` are placeholders that don't auth-check — they'd render to anyone who hits the URL today.

### Where login happens

**This is the critical gap:**

- apps/web has **no login page**. Search for `signin`, `login`, `signIn`: zero pages in `app/`.
- dashboard-worker exposes `POST /api/login` but it's an **API endpoint**, not a form-rendering page. There's no GET that returns a login form anywhere in apps/web or any of the new workers.
- Today, users acquire an `sb-access-token` cookie by hitting **legacy `/admin/login`** (in `legacy/signupworker.js:handleLogin`). After cutover (when legacy is unrouted), there is **no entry point to log in via apps/web**.

**Practical implication:** the cutover plan as written would leave authenticated users without a way to re-authenticate. Pre-existing cookies would work until they expire; new logins would fail.

Required: `apps/web/app/login/page.tsx` — a server component with a form that POSTs to `dashboard-worker:/api/login`, plus a redirect target. **This page does not exist.** It's the single most critical missing piece.

The dashboard-worker port comment in `apps/dashboard-worker/src/index.ts` already anticipates this:

> `/login` HTML page → apps/web's `/login`

But the page was never built.

---

## 7. Signup duplication analysis

### apps/web's `/signup/[location]/page.tsx`

[`apps/web/app/signup/[location]/page.tsx`](apps/web/app/signup/[location]/page.tsx) — 17 lines total. Contents:

```tsx
export default async function SignupLocationPage({ params }: PageProps) {
  const { location } = await params;
  return (
    <section style={{ padding: 24 }}>
      <h1>Signup — {location}</h1>
      <p>Step 4 placeholder. Port from renderPicker (legacy/signupworker.js) in Step 7.</p>
    </section>
  );
}
```

**This is a Step-4 placeholder.** No package fetch, no PricingCard rendering, no terms text generation, no fraud-detection wiring, no JotForm flip dispatch. Pure scaffolding — never advanced beyond the initial scaffold. Notably, `/signup/[location]/[package]` doesn't exist as a route at all in apps/web.

### signup-worker's inline render path

The signup-worker has the **full implementation**:

- [`apps/signup-worker/src/render/picker.ts`](apps/signup-worker/src/render/picker.ts) — the `/signup/{loc}` package picker HTML (matches legacy's bubble-background card grid)
- [`apps/signup-worker/src/render/form.ts`](apps/signup-worker/src/render/form.ts) — the `/signup/{loc}/{pkg}` signup form with phone input, email input, terms checkbox, and the four-modal client JS (Deny/Warn/Monitor/Success)
- [`apps/signup-worker/src/signature/inline.ts`](apps/signup-worker/src/signature/inline.ts) — wires picker + form, generates terms text via `buildTermsText` from `signature/terms.ts`
- [`apps/signup-worker/src/signature/jotform.ts`](apps/signup-worker/src/signature/jotform.ts) — flippable dormant path (URL-builder; `SIGNATURE_MODE = "jotform"` flips signup to a 302 redirect)
- [`apps/signup-worker/src/handlers/submit-signup.ts`](apps/signup-worker/src/handlers/submit-signup.ts) — `POST /api/submit-signup` with the layered fraud-detection flow + `maxpass_signups` insert
- Cache: [`apps/signup-worker/src/pricing/cache.ts`](apps/signup-worker/src/pricing/cache.ts) (5min fresh / 24h SWR per location)

**Substantively complete.** Smoke-tested. Production-ready as the rendered HTML path; JotForm path build-time-validated only.

### Canonical post-cutover owner

**Per the architecture pattern stated in worker comments and migration plan:** apps/web should own all HTML rendering; workers own JSON APIs. By that rule, apps/web is the canonical owner of `/signup/{loc}` and `/signup/{loc}/{pkg}`.

**Per the actual code:** signup-worker is the only working implementation of these pages. apps/web's `/signup/[location]` is a 17-line placeholder; `/signup/[location]/[package]` doesn't exist.

**Practical recommendation (this is observation, not a directive — audit-only):** the signup-worker inline path is fine as the production owner indefinitely. The migration plan envisioned moving HTML to apps/web, but the inline path is feature-complete, well-tested, and works. Re-porting it to React server components is significant work for marginal architectural-purity gain. Worth a deliberate decision rather than treating it as an automatic must-do.

If apps/web does take over: it would need:
- `app/signup/[location]/page.tsx` (real implementation, server-fetches via `@splash/db-supabase fetchPricingResolvedByLocation`)
- `app/signup/[location]/[package]/page.tsx` (server component rendering the form with terms text)
- A client component for the form JS (modal kit, phone formatter, fraud-detection submit flow)
- Terms-text generation imported from `apps/signup-worker/src/signature/terms.ts` — currently worker-local; would need to move to `@splash/ui` or a new shared package
- Cache layer is moot — Next.js's own caching + the signup-worker's `/admin/api/*` invalidation hooks would replace the worker cache

---

## 8. Deployment targets

### apps/web wrangler.toml

[`apps/web/wrangler.toml`](apps/web/wrangler.toml):

```toml
name = "splash-web"
main = ".open-next/worker.js"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = ".open-next/assets"
binding = "ASSETS"

# Routes: intentionally unset for Step 4. Will be added in Step 7 when pages
# are populated and we're ready to cut over from the legacy workers.
# routes = [
#   { pattern = "splashcarwashes.info/admin/*", zone_name = "splashcarwashes.info" },
#   ...
# ]

# Bindings (Supabase env). Apps/web reads pricing/locations server-side.
# SUPABASE_URL          — string
# SUPABASE_ANON_KEY     — secret
# SUPABASE_SERVICE_KEY  — secret
```

**Worker name:** `splash-web`. **Routes:** none bound (commented out, plus the example list is incomplete — no `/login`, `/change-password`, `/signup/*` patterns drafted).

**No `workers_dev = true`.** Default behavior in wrangler 4 is `workers_dev = true` when `routes` is unset — so it deploys to `splash-web.<account>.workers.dev`. **No production routes exist anywhere.**

### apps/web open-next.config.ts

[`apps/web/open-next.config.ts`](apps/web/open-next.config.ts):

```ts
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
export default defineCloudflareConfig({});
```

Empty config. Default OpenNext-on-Workers behavior. **NOT Cloudflare Pages.** This is the OpenNext adapter that compiles a Next.js app into a Cloudflare Worker (with the `[assets]` static binding for CSS/JS/images). The build flow is:

```
next build              # produces .next/
opennextjs-cloudflare build   # produces .open-next/worker.js + .open-next/assets/
wrangler deploy         # uploads as a Worker, not a Pages project
```

There is **no Cloudflare Pages project** for apps/web. Everything is Workers.

### Bindings

Listed as comments only; **no actual `[vars]` block, no `wrangler secret put` automation, no env-var stub file**. Operator must `wrangler secret put SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` manually before first deploy. (Same as the workers, but explicitly flagged because there's no PRE_DEPLOY_WEB.md alongside the 5 worker docs.)

---

## 9. Remaining-work summary — prioritized

Synthesized from sections 1-8. Each item: **complexity** (S/M/L), **blocks** (customer-facing cutover / admin-facing cutover / both / neither), **builds on** (existing files).

| # | Item | Complexity | Blocks | Builds on |
|---|---|---|---|---|
| 1 | **Build `apps/web/app/login/page.tsx`** — server component renders login form, posts to `dashboard-worker:/api/login`. Without this, no apps/web entry point to obtain an auth cookie post-cutover. | S | **Both** customer-facing (forced-reset flow needs prior login) and admin-facing (every admin tool requires a session). | dashboard-worker `POST /api/login` (already real); `@splash/ui ModalShell` available; legacy/signupworker.js renderLoginPage as a UI reference. |
| 2 | **Resolve `/admin/change-password` ↔ `/change-password` URL drift** — either redirect legacy URL to apps/web URL via Next config or rename apps/web's path. | S | Admin-facing. Forced-reset flow breaks for users who land on the legacy URL. | `apps/web/app/change-password/`; pick one URL, drop the other. |
| 3 | **Resolve `/admin/{loc}` ↔ `/admin/pricing/{loc}` URL drift** — same fix shape: redirect or rename. | S | Admin-facing. Bookmarks break post-cutover. | `apps/web/app/admin/pricing/[location]/` real implementation already exists. |
| 4 | **Build `apps/web/app/admin/page.tsx`** (or move `/admin/dashboard` → `/admin`) — landing page with cards for Pricing / Damage / Performance / Sysadmin, similar to legacy/dashboard.js renderDashboard. Includes "Sign Out" link. | S | Admin-facing. Currently `/admin` 404s (no page). | `app/admin/dashboard/page.tsx` is the placeholder to extend; `legacy/dashboard.js:382-606` `renderDashboard` is the visual reference. |
| 5 | **Add a real damage manager UI at `/admin/damage`** — claim list page + claim detail page + transition / note / document forms. Largest individual port. | L | Admin-facing (manager workflow). | `apps/web/app/admin/damage/page.tsx` placeholder; damage-worker has all 8 JSON endpoints under `/manage/api/*` ready to consume; `legacy/damagemanager.js:3262-3380` for UI flow. |
| 6 | **Add a real performance tracker UI at `/admin/performance`** — submission list with filters + new-submission form. | M | Admin-facing. | `apps/web/app/admin/performance/page.tsx` placeholder; performance-worker has the 6 endpoints ready; `legacy/ui.js` (referenced by `performancetracker.js`) is the visual reference — note it's NOT in `legacy/` in this repo, just referenced. |
| 7 | **Add a sysadmin UI at `/admin/sysadmin/*`** — user list, user detail / edit, grant/revoke tool grants, set role, reset password, create user. Five JSON endpoints already exist. | M | Admin-facing. Without it, all sysadmin operations require direct curl against the worker URL. Acceptable as ongoing-ops cutover-skip if Josh is the only super_admin and uses curl/SQL. | `apps/sysadmin-worker/src/index.ts` 5 endpoints; nothing in apps/web today. |
| 8 | **Decision: signup customer flow ownership** — does `/signup/{loc}` and `/signup/{loc}/{pkg}` move to apps/web or stay on signup-worker? Either choice is defensible; the placeholder at `apps/web/app/signup/[location]/page.tsx` should be either fleshed out (apps/web owns) or deleted (worker owns). | S (decision) / M (if apps/web owns) | Customer-facing. Today both URLs go to the worker (apps/web has no production routes); after cutover whichever side is bound takes traffic. Mismatch causes hard-to-debug UI regressions. | `apps/signup-worker/src/render/{picker,form}.ts` is full impl; apps/web placeholder ignores it. |
| 9 | **Public claim form ownership** — same decision shape for `/claims/{site}`. damage-worker has the full inline render; apps/web has nothing. | S (decision) | Customer-facing (damage filing). | `legacy/damagemanager.js` `renderDamageForm`; damage-worker has `serveR2Photo`, `handleClaimSubmission` ready. |
| 10 | **Logout flow in apps/web** — every admin page should expose a Sign Out link/button. Today none of the pages render one. POST to `dashboard-worker:/api/logout`. | S | Admin-facing UX gap. Logged-in users can't log out via the UI. | dashboard-worker `POST /api/logout` exists. |
| 11 | **`apps/web/app/admin/pricing/page.tsx` currently dies on 401/403 with a static "no access" message** — but has no "Sign In" link from there. Once `/login` exists, link to it from the no-access state on every protected page. | S | Admin-facing. | App-wide pattern; trivial after #1 lands. |
| 12 | **Fill in `apps/web/app/page.tsx` (root `/`) — currently placeholder text** — typically a redirect to `/admin` (when authenticated) or `/login` (when not). | S | Admin-facing UX. After cutover, splashcarwashes.info root is owned by dashboard-worker, not apps/web (per dashboard-worker wrangler.toml). The `/` route on apps/web only matters if we route differently. **Verify route ownership before doing this work.** | dashboard-worker root behavior. |
| 13 | **Routes block in `apps/web/wrangler.toml`** — currently empty/commented. Once pages 1-12 land, draft the real routes block: `/login`, `/change-password`, `/admin/*`, possibly `/signup/*` (if #8 chooses apps/web). | S | Both. Cutover-time edit. | `apps/web/wrangler.toml`. |
| 14 | **Auth wrapper / middleware** — every page that needs auth currently does ad-hoc cookie forwarding. A `middleware.ts` or layout-level auth guard would centralize the redirect-to-login on missing/invalid session. Optional but increasingly painful as more pages land. | M | Neither (admin pages still work without it; just less clean). | `next/middleware`; `@splash/auth.authenticate`. |
| 15 | **PRE_DEPLOY_WEB.md** — alongside the 5 worker docs. Currently no doc covers apps/web deploy steps, required secrets, smoke checklist, route-binding plan. | S | Both. Cutover-prep gap. | Mirror structure of `PRE_DEPLOY_DASHBOARD.md`. |

### Summary by category

**Customer-facing cutover blockers:**
- #1 (login page — really critical because forced-reset depends on it)
- #8 (signup ownership decision)
- #9 (claim-form ownership decision)
- #12 (root `/` behavior verification)

**Admin-facing cutover blockers:**
- #1 (login)
- #2, #3 (URL drift redirects)
- #4 (admin landing)
- #10 (logout)
- #11 (sign-in links from auth-failed states)

**Admin-facing nice-to-have (functional via curl/SQL, but UI gaps):**
- #5 (damage manager UI)
- #6 (performance tracker UI)
- #7 (sysadmin UI)

**Operational gaps:**
- #13 (apps/web routes block)
- #14 (auth middleware)
- #15 (PRE_DEPLOY_WEB.md)

### Honest assessment

The CUTOVER_PLAN.md statement "**build phase complete**" is **accurate for the workers and shared packages, inaccurate for apps/web.** The apps/web build is at roughly Step-4-scaffolding completeness for 5 of 8 pages, and missing entirely for several other URLs the legacy production worker serves. Items 1, 2, 3, 4, and 10 from the table above are **the minimum** to get apps/web to a state where customer-cutover has an obvious "log in here" path and admin URLs don't break. Items 5-7 are the medium-term UI work that could land progressively post-cutover (with operators using curl in the gap).

The cutover-strategy conversation (separate from this audit) should explicitly decide:
- Will apps/web be production-bound at cutover, or do workers stay on legacy URLs and apps/web gets bound later?
- For #8 and #9, which side owns the customer-facing surface?
- Are admin tools allowed to stay curl-only (no UI) for some defined period after cutover?

Without those decisions made explicit, this audit's Section 9 is the work list.
