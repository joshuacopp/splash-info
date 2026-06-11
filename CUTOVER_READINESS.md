# CUTOVER_READINESS.md — production cutover gap-analysis

**Date:** 2026-06-08
**Supersedes the analysis in `CUTOVER_PLAN.md`** (dated 2026-05-03, covers
only the original 5 workers). The monorepo is now **10 workers + apps/web**.
This document is the go/no-go readiness pass; the step-by-step procedure
lives in the companion runbook (next deliverable). The Claude Code brief that
stages the `wrangler.toml` route diffs is the third deliverable.

> Scope posture (operator-confirmed 2026-06-08): **direct route flip** (no
> parallel/shadow). Sequence: **(A) apps/web + its same-zone worker carves →
> (B) the remaining non-production workers (fleet included — its legacy
> `broad-shape-38b8` was never really used) → (C) signup-worker verified
> against the monorepo, then flipped last** (it's the only worker fronting
> live legacy traffic via `info-signup-worker`).

---

## 1. How routing works in this zone (the mental model)

Production is a single zone, `splashcarwashes.info`. There is **no DNS work**
— the zone is already on Cloudflare. Cutover is purely **Worker route
bindings** (+ a few secrets + one rename).

- **apps/web (`splash-web`) is the catch-all**: `splashcarwashes.info/*`.
- **Each worker carves specific paths** that, by CF's
  most-specific-match-wins rule, outrank the apps/web catch-all. apps/web
  only ever serves paths NOT carved by a worker.
- This exact model already runs on `staging.splashcarwashes.info` today, so
  production is the same bindings on the apex host.

**Consequence for sequencing:** you cannot bind apps/web's catch-all in
isolation and have a working site. If the catch-all is live but a worker's
carve is not, every browser call to that worker's path (e.g. `/manage/api/*`,
`/api/login`) falls through to apps/web and 404s. **apps/web and the worker
carves it depends on must be bound in the same window.** That's what "web
first" actually means here: web + Batch A workers together.

---

## 2. Critical couplings (read before sequencing anything)

1. **Same-origin auth.** Login POSTs to dashboard-worker `/api/login`; the
   `sb-access-token` cookie is set for the origin that answers. It only
   reaches apps/web when both are on `splashcarwashes.info`. → **apps/web +
   dashboard-worker must flip together.**
2. **`/api/me` is missing from dashboard-worker's production route block.**
   The commented prod `routes` in `apps/dashboard-worker/wrangler.toml` lists
   `/api/login`, `/api/logout`, `/api/forced-reset` — but **not** `/api/me`,
   which the global Header calls to render the user/role row (Brief 11a).
   Staging has it; production block must add it or the Header identity row
   breaks. **Gap — fix in the route block.**
3. **Stale dashboard UI bindings.** Per CLAUDE.md constraint #6,
   `splash-dashboard` is bound to `/`, `/login`, `/logout` in the CF
   dashboard UI today (they 404). Those must be **removed** at cutover so
   apps/web's catch-all can serve `/`, `/login`, `/logout`. This is a CF-UI
   action, not a wrangler.toml edit.
4. **The `/api/` namespace is split.** dashboard-worker owns exact
   `/api/login|logout|forced-reset|me`; signup-worker owns exact
   `/api/submit-signup`. **Neither may carve `/api/*`** — a wildcard would
   swallow the other's endpoint. Keep both as exact-path routes.
5. **Pricing admin depends on signup-worker.** apps/web's pricing admin makes
   **browser-side** `fetch()` calls to `/admin/api/*`, which is a
   **signup-worker** carve. So apps/web's pricing pages don't fully work
   until signup is flipped (Batch C). Acceptable — pricing admin can lag a
   few days behind the rest of admin; just know the pricing screens 404 their
   data calls until signup cuts over. (SSR reads use the service binding and
   are fine; it's the client `fetch` to `/admin/api/*` that needs the route.)
6. **Signup rename breaks the apps/web service binding.** If signup renames
   `splash-signup-next → splash-signup` at cutover, `apps/web/wrangler.toml`'s
   `[[services]] binding = "SIGNUP_WORKER" service = "splash-signup-next"`
   must change to `service = "splash-signup"` and apps/web must redeploy.
   **Decide the rename strategy before Batch C** (see §5).
7. **Build-time encryption key.** apps/web depends on
   `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (CF Workers Builds env var, Brief 31).
   It must be present at cutover and **must not be rotated** (constraint #7).
   Verify it's set on the production build config.
8. **Secrets-via-CLI invariant.** Constraint #4: never `wrangler deploy` if
   secrets were set via the CF UI. Today all secrets are CLI-set. Keep it
   that way through cutover; if anyone sets a secret in the dashboard UI, the
   next push-deploy can wipe it.

---

## 3. Per-worker readiness table

Routes are the apex twins to **add into** each worker's active `routes` array
(mirror every live `staging.splashcarwashes.info/<path>` to a
`splashcarwashes.info/<path>`; keep the staging lines — TOML allows only one
`routes` key). The live staging array is the authoritative path source; the
lists below are for verification. "Secrets" = the bindings
the operator must confirm are bound on the **production** worker (I can't see
the CF dashboard — treat every one as verify-before-flip). All workers already
carry the `[observability.logs]` block, so Logs stay sticky.

### Batch A — flips WITH apps/web (same-origin auth + admin shell)

| Worker | CF name | Production routes to bind | Secrets/bindings to verify | Notes |
|---|---|---|---|---|
| dashboard | `splash-dashboard` | `/api/login`, `/api/logout`, `/api/forced-reset`, **`/api/me` (add)** | SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY | Remove stale `/`,`/login`,`/logout` UI bindings (§2.3). Login won't work until this + web are both live. |
| sysadmin | `splash-sysadmin` | `/sysadmin/api/*` | SUPABASE_URL, SUPABASE_SERVICE_KEY | Powers `/admin/sysadmin`. |
| damage | `splash-damage` | `/claims-api/*`, `/claims/*`, `/manage/api/*` | SUPABASE keys, POWER_AUTOMATE_URL, INCIDENTS_WEBHOOK_URL, AP_WEBHOOK_URL, CUSTOMER_CLAIM_WEBHOOK_URL, CLAIM_UPDATE_WEBHOOK_URL, INTERNAL_NEW_CLAIM_WEBHOOK_URL, DAILY_SUMMARY_WEBHOOK_URL, MAINTAINX_API_KEY | **R2 prereqs:** `templates/check-request.pdf` + `assets/splash-logo-white.png` in `damagedocs`. **Flip `MAINTAINX_MODE` "test"→"production"** so WOs route to real assignees (constraint: this routes real MaintainX work orders — confirm intentional). `/claims/{site}` is load-bearing customer URL. |
| performance | `splash-performance` | `/pertrack/*` | SUPABASE keys | apps/web page is a placeholder; low stakes but harmless to flip with the batch. |

> Why these four are in Batch A: they own the auth + admin-shell paths the
> apps/web admin UI calls on first load. `/admin/damage`, `/admin/sysadmin`,
> login, and the Header all break without them. damage also owns the
> **load-bearing public `/claims/{site}`** customer URL, so its flip is
> customer-visible — smoke-test the claim form right after.

### Batch B — non-production workers (no live traffic; flip after A is green)

| Worker | CF name | Production routes to bind | Secrets/bindings to verify | Notes |
|---|---|---|---|---|
| workorders | `splash-workorders` | `/workorders/api/*` | MAINTAINX_API_KEY, SUPABASE keys | apps/web serves `/workorders`; worker serves `/workorders/api/*`. Daily MaintainX sync cron. |
| forms | `splash-forms` | `/forms/*` | SUPABASE keys, TURNSTILE_SITE_KEY/SECRET_KEY, FORMS_SUBMISSION_WEBHOOK_URL, FORMS_APPROVAL_DIGEST_WEBHOOK_URL, FORMS_EMAIL_QUEUE_TOKEN; R2 FORMS_FILES + PROMO_FILES | apps/web serves bare `/forms` (index) — the `/forms/*` carve does **not** capture bare `/forms` (no trailing slash), so they coexist. **This worker is the email-queue drain** — the PA flow's claim/confirm calls hit `/forms/internal/api/email-queue/*`; confirm the PA flow targets the production host post-flip. Crons at 11:00/12:00 UTC. |
| jotform | `splash-jotform` | `/jotform/*`, `/admin/jotform/api/*` | SUPABASE keys, JOTFORM_API_KEY, JOTFORM_WEBHOOK_TOKEN, JOTFORM_BASE_URL | **Reconfigure the JotForm webhook URL** to the production `/jotform/{token}` path after flip, or ingest stops. apps/web serves `/admin/jotform/*` pages; worker carve is `/admin/jotform/api/*` (more specific, coexists). |
| promo | `splash-promo` | `/promo/*` | SUPABASE keys; R2 PROMO_FILES; `APPS_WEB_BASE_URL` var | apps/web serves `/admin/promotions/*`; worker carve `/promo/api/*`. Announcement attachments rely on forms-worker's `PROMO_FILES` binding (already bound, Brief 165). Confirm `APPS_WEB_BASE_URL` points at the apex host. |
| fleet | `splash-fleet-inquiry` | `fleet.splashcarwashes.info/*` (subdomain, **not** a path carve) | SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, TURNSTILE keys, GOOGLE_MAPS_API_KEY, FLEET_SUBMISSION_UPDATE_WEBHOOK_URL | **Treated as non-production per operator** (legacy `broad-shape-38b8` never really used). Cutover = point `fleet.splashcarwashes.info` at `splash-fleet-inquiry` and stop using `broad-shape-38b8`. **Paid API:** Google Maps Geocoding bills per call — consider a key restricted to this worker (PRE_DEPLOY_FLEET §3). CLAUDE.md constraint #9 says don't touch `broad-shape-38b8`; that constraint is **operator-overridden here** since you're cutting fleet — note it in the runbook. Admin `/admin/fleet` works via service binding regardless of this flip. |

### Batch C — signup-worker (the only live-traffic flip; do last)

| Worker | CF name | Production routes to bind | Secrets/bindings to verify | Notes |
|---|---|---|---|---|
| signup | `splash-signup-next` → **rename `splash-signup`** | `/signup/*`, `/q/*`, `/join/*`, `/api/submit-signup`, `/admin/api/*` | SUPABASE keys; `SIGNATURE_MODE = "inline"` (keep) | **Load-bearing customer URLs** `/signup` `/q` `/join` — must never break; these are live on `info-signup-worker` today. Verify the monorepo worker against production behavior BEFORE flipping. On rename, update apps/web `SIGNUP_WORKER` service binding (§2.6) + the pre-cutover SQL guard (§4). Family-Plan JotForm IDs are dormant (mode is `inline`), so not a blocker. |

---

## 4. Cross-cutting prerequisites (one-time, before the relevant batch)

- **Pre-cutover SQL guard** (signup; harmless no-op today, run once at Batch C):
  ```sql
  UPDATE pricing_simple SET pricing = 'special', special = 0.01 WHERE pricing = 'penny';
  ```
- **damage R2 prereqs** must exist before Batch A: `templates/check-request.pdf`
  (AcroForm — PDF gen fails without it) and `assets/splash-logo-white.png`
  (summary-PDF header; falls back to HTTPS if absent, but slower). *(Note: the
  test-data wipe today left `templates/` intact; confirm `assets/` — it was
  empty, so the logo uses the HTTPS fallback unless you upload it.)*
- **JotForm webhook URL** (Batch B): re-point each form's webhook at the
  production `/jotform/{token}` path.
- **PA flows** that call worker endpoints by URL (email-queue drain → forms
  worker; the various damage/promo webhooks are worker→PA, those are fine):
  confirm the **email-queue claim/confirm** flow targets the production
  `splashcarwashes.info/forms/internal/api/email-queue/*` host after the forms
  flip.
- **MAINTAINX_MODE** flip to `"production"` (Batch A, damage) — confirm you
  want real assignees paged.
- **apps/web Supabase service key:** the wrangler comment lists
  `SUPABASE_SERVICE_KEY`, but Brief 158a noted apps/web has **no** service-key
  binding today (promo user-name resolution was stubbed for this reason).
  Not a blocker for cutover (apps/web uses service bindings to workers), but
  verify nothing added since then assumes it.

---

## 5. Decisions to lock before the runbook executes

1. **Signup rename strategy** (§2.6 / Batch C): rename
   `splash-signup-next → splash-signup` and update the apps/web service
   binding, **or** keep the `-next` name and bind production routes to it
   (leaving the old `splash-signup` script orphaned). Rename is cleaner
   long-term; keeping `-next` avoids the apps/web binding edit. **Pick one.**
2. **Batch A timing window:** apps/web + the 4 Batch-A workers flip close
   together (auth coupling). Confirm a low-traffic window for the brief
   period where login may be inconsistent mid-flip.
3. **`/claims/{site}` is customer-facing** and flips in Batch A — confirm
   that's acceptable in the same window as the admin shell, or split damage's
   public `/claims*` routes to Batch C alongside signup if you'd rather flip
   all customer URLs together.
4. **fleet** (§Batch B): confirm you're retiring `broad-shape-38b8` (overrides
   constraint #9) vs. leaving fleet on workers.dev and skipping its flip.

---

## 6. Go / no-go checklist (per batch)

Before flipping each batch:

- [ ] Every secret in the batch's table confirmed bound on the **production**
      worker (`wrangler secret list` per worker).
- [ ] Worker smoke-tested on workers.dev / staging (its `PRE_DEPLOY_<NAME>.md`).
- [ ] Routes edited (staging host → apex) and reviewed in the diff.
- [ ] Rollback understood: re-comment the route block (or, for signup/fleet,
      re-point the route at the legacy worker) and redeploy. Direct-flip
      rollback = put the route back on the legacy script.

After each batch:

- [ ] Browser smoke test on `splashcarwashes.info` for that batch's surfaces.
- [ ] No `522`/`404` on the carved paths; CF Logs clean.

---

## 7. What I could NOT verify from the repo (operator must confirm)

- Actual secret-binding state on each production worker (no CF dashboard
  access).
- Whether `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is set on the production build
  config.
- The current route bindings on `splash-dashboard` in the CF UI (the stale
  `/`,`/login`,`/logout` ones to remove).
- Whether `info-signup-worker` / `broad-shape-38b8` have any config the
  monorepo workers don't replicate (verify signup parity in Batch C).
