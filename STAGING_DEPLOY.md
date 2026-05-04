# STAGING_DEPLOY — staging.splashcarwashes.info

End-to-end testing rehearsal of the full apps/web + 5-worker stack on a
single subdomain. Purpose: exercise login + admin tools + customer
flows under real same-origin cookies, real CSRF gates, real CF routing
— without touching production routes.

Operator decision (Brief 16): **same Supabase, same R2, same D1 as
production.** No staging-isolation infrastructure. Use identifiable
test data and clean up at your discretion.

Production routes stay commented in every worker's `wrangler.toml`.
Staging is purely additive: new `routes = [...]` blocks targeting
`staging.splashcarwashes.info` coexist with the (still-commented)
production blocks. `workers_dev = true` is preserved so the
`*.workers.dev` URLs remain a development fallback.

---

## Required CF state (operator action — NOT code)

These are operator action items in the Cloudflare dashboard. The brief
does not write CF dashboard config; verify these before running the
deploy sequence below.

a. **DNS for `staging.splashcarwashes.info`** exists in the
   `splashcarwashes.info` zone. Either a CNAME pointing at
   `splashcarwashes.info` or a proxied A record on the same target IPs.
   The record MUST be proxied (orange cloud) so Cloudflare Workers can
   bind routes to it.

b. **SSL/TLS coverage for the subdomain.** Cloudflare's universal SSL
   certificate covers `*.splashcarwashes.info` automatically when the
   subdomain is proxied — no separate cert action required. If the
   zone is on Advanced Certificate Manager, confirm the cert hostnames
   include the wildcard or `staging.splashcarwashes.info` explicitly.

c. **Workers + Pages → splash-* workers → Triggers → Routes** lists
   each `staging.splashcarwashes.info/...` pattern after the deploys.
   If the route table is empty for a worker after deploy, the
   `wrangler.toml` `routes = [...]` block didn't take — re-run the
   deploy with `--verbose` and check stderr for permission or DNS
   prerequisites.

---

## Per-worker secrets check

Staging uses the same Supabase / R2 / D1 backends as production, so
**no separate staging secrets** are required — each worker carries the
same secret set whether served at `*.workers.dev` or
`staging.splashcarwashes.info`. Confirm the secret inventory is intact
before deploying.

```powershell
pnpm --filter @splash/dashboard-worker   exec wrangler secret list
pnpm --filter @splash/signup-worker      exec wrangler secret list
pnpm --filter @splash/performance-worker exec wrangler secret list
pnpm --filter @splash/sysadmin-worker    exec wrangler secret list
pnpm --filter @splash/damage-worker      exec wrangler secret list
```

Expected output per worker:

| Worker | Required secret names |
|---|---|
| `splash-dashboard`   | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` |
| `splash-signup-next` | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` |
| `splash-performance` | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` |
| `splash-sysadmin`    | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` |
| `splash-damage`      | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `POWER_AUTOMATE_URL`, `INCIDENTS_WEBHOOK_URL`, `AP_WEBHOOK_URL` |

Notes:
- `SUPABASE_URL` MAY be set as a plain `[vars]` entry rather than a
  secret — same effect at runtime.
- Damage-worker's `POWER_AUTOMATE_URL` / `INCIDENTS_WEBHOOK_URL` /
  `AP_WEBHOOK_URL` are fail-soft per `apps/damage-worker/wrangler.toml`
  comments: when unbound the worker writes to R2 + D1 but skips the
  webhook fan-out. Acceptable for staging if the operator wants to
  exercise claim flows without firing real Power Automate / Incidents /
  AP notifications. Verify before the smoke test.
- **Critical:** the env-var name is `SUPABASE_SERVICE_KEY`, NOT
  `SUPABASE_SERVICE_ROLE_KEY` (legacy). A binding under the legacy name
  results in 401s on every authenticated read. See
  `BUILD_STATE.md → Load-bearing constraints`.

apps/web requires Supabase env vars only if a server-rendered page
queries Supabase directly. Today apps/web's admin pages all proxy
through workers (signup-worker for pricing, damage-worker for claims,
etc.); the `SUPABASE_*` bindings noted in `apps/web/wrangler.toml` are
forward-compatibility only. No staging blocker.

---

## Deploy sequence

Run in this order. The order respects cross-worker dependencies (every
authenticated worker depends on the dashboard-worker's session cookie
contract, so the SSO entry deploys first; apps/web is the last consumer
of every worker's API surface, so it deploys last).

```powershell
pnpm deploy:dashboard
pnpm deploy:signup
pnpm deploy:performance
pnpm deploy:sysadmin
pnpm deploy:damage
pnpm deploy:web
```

**apps/web caveat:** `pnpm deploy:web` invokes
`@opennextjs/cloudflare`'s bundle assembly, which creates symlinks
during build. On Windows this requires either:
- **Windows Developer Mode enabled** (Settings → Privacy & security →
  For developers → Developer Mode = On), OR
- **Run from WSL** (`wsl pnpm deploy:web` from a WSL prompt with the
  repo mounted, or `cd` into the repo from inside WSL).

Without Dev Mode, the build fails with an `EPERM` symlink-permission
error before reaching `wrangler deploy`. The five worker deploys above
are unaffected — they don't symlink during build.

After each deploy, confirm the route table in CF (Workers + Pages →
worker → Triggers) lists the staging pattern. The first deploy of a
new route may take 30-60 seconds to propagate.

---

## Smoke-test checklist

Run these after `pnpm deploy:web` lands. All commands target
`https://staging.splashcarwashes.info/...`.

1. **Auth round-trip.** Visit `/login`. Sign in with a known
   super_admin account. Expect 302 to `/admin/dashboard`. Confirm
   `sb-access-token` cookie is set on `staging.splashcarwashes.info`
   (DevTools → Application → Cookies).
2. **Header user identity row.** On `/admin/dashboard` the global
   Header should show your email + role label ("Super Admin" /
   "Location Admin" / "Admin") — verifies dashboard-worker `/api/me`
   reaches apps/web same-origin (Brief 11a + 11b).
3. **Pricing tile.** Click Pricing → `/admin/pricing` should list
   locations. Click into one → `/admin/pricing/{loc}` should render
   the grid with `pkg$` data flowing through the resolved view.
4. **Damage manager — list.** Click Damage → `/admin/damage` should
   render the claim list (filters: search / location / status /
   lifecycle). Test each filter persists across submit.
5. **Damage manager — detail.** Click into a claim →
   `/admin/damage/[id]` should render the full detail page (summary
   card, transitions, photo gallery, activity timeline).
6. **Damage manager — write actions.** Add a note. Apply a transition
   that's valid for your dc_role. Upload a Quote or Receipt document
   (multipart form). Edit the document. Delete it (confirm banner →
   "Yes, delete"). Each action should redirect with `?action_success`
   or `?action_error` and the activity timeline should reflect the
   change.
7. **Performance tracker.** Click Performance → `/admin/performance`
   should render the list + filter bar. Submit a new performance row
   via the inline card; `revalidatePath` should cause the new row to
   appear in the table on the next render.
8. **Sysadmin — super_admin gate.** Click Sysadmin → `/admin/sysadmin`
   should render the five collapsed cards if you're super_admin (or a
   "no access" card if not). Run an idempotent op like "Grant tool"
   on yourself for a tool you already have — should redirect with
   `?action_success` and write a row to `sysadmin_audit_log` (verify
   in Supabase if needed).
9. **Customer signup.** Visit `/signup/{location}` for a known
   location code. The inline form (signature mode = "inline" per
   `apps/signup-worker/wrangler.toml`) should render. Optionally
   submit a test signup with identifiable test data ("Test User",
   `joshua.copp+staging-{N}@gmail.com`) and confirm the row lands in
   `maxpass_signups`.
10. **Customer claim form.** Visit `/claims/{site}` for a known site
    code. The form should render via damage-worker (per decision 9).
    Optionally submit a test claim with identifiable test data;
    confirm the row lands in D1 `claims` and the photo lands in R2
    under the expected key prefix.
11. **Sign Out.** Click Sign Out in the Header. Expect 302 to
    `/login`, `sb-access-token` cookie cleared (Max-Age=0). Hitting
    `/admin/dashboard` directly afterward should redirect to
    `/login?return=%2Fadmin%2Fdashboard`.
12. **Cross-tool gating spot-check.** As a non-super_admin user (a gm
    or rm), confirm:
    - `/admin/sysadmin` renders the "no access" card.
    - `/admin/damage` only lists claims at locations in your
      `dcLocations` scope.
    - Damage detail pages outside your scope return the 404
      "Claim not found, or outside your access scope" card.

---

## Rollback

To disable staging without touching production: comment out the
`routes = [...]` blocks in each worker's `wrangler.toml` and re-deploy.
The (still-commented) production routes are unaffected — they were
never bound, before or after this rollback. This rollback is safe and
trivial because staging routes are purely additive: removing them
returns the workers to their pre-Brief-16 posture, where they are only
reachable via `*.workers.dev` URLs. The legacy `info-signup-worker`
continues to own production traffic on `splashcarwashes.info` regardless.

```powershell
# After commenting routes blocks in each wrangler.toml:
pnpm deploy:dashboard
pnpm deploy:signup
pnpm deploy:performance
pnpm deploy:sysadmin
pnpm deploy:damage
pnpm deploy:web
```

CF removes the route bindings on the next deploy that omits them.
DNS for `staging.splashcarwashes.info` and the universal SSL coverage
remain (operator-side cleanup if desired; harmless to leave in place).
