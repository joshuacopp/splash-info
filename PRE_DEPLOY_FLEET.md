# PRE_DEPLOY — fleet-inquiry-worker

Worker name (monorepo): `splash-fleet-inquiry`
Legacy worker (still serves production): `broad-shape-38b8`

---

## 1. Overview

`fleet-inquiry-worker` surfaces a public multi-step form for prospective
fleet customers, computes the nearest five Splash locations (Google
Maps Geocoding when configured, alphabetical fallback otherwise), and
writes submissions to the Supabase `fleet_submissions` table. Pricing
data is sourced from `pricing_simple` / `pricing_simple_resolved`.
Turnstile gates the public submit endpoint when `TURNSTILE_SECRET_KEY`
is bound (silent skip when not).

**Endpoints**

| Path | Method | Purpose |
|---|---|---|
| `/` and `/fleet` | GET | Renders the inline HTML form (~1250 LOC template literal in `src/index.js`) |
| `/api/find-locations` | POST | Body `{ address?, lat?, lng? }` — returns nearest five locations |
| `/api/fleet-packages` | POST | Body `{ location_code }` — returns wash packages for that location |
| `/api/fleet-submit` | POST | Full form payload — validates Turnstile + writes `fleet_submissions` row |

**Two parallel deployments during transition**

- **Legacy** (`broad-shape-38b8`) — auto-named CF default, custom domain
  `fleet.splashcarwashes.info`. Continues to serve all real customer
  traffic. Owned by whatever CF Builds / deploy path provisioned it
  before the monorepo. NOT touched by Brief 81.
- **Monorepo** (`splash-fleet-inquiry`) — Brief 81's lift-and-shift.
  Lives at `apps/fleet-inquiry-worker/` with `src/index.js` carried
  over verbatim (no TS conversion, no Supabase helper migration, no
  render extraction). Deploys to workers.dev only — production routes
  block is commented out in `wrangler.toml`. Used for smoke testing
  and future feature development.

**Cutover** — flipping `fleet.splashcarwashes.info` from legacy to
monorepo — is explicitly **out of scope** for any Claude Code brief
unless the operator asks. See section 6 for the operator runbook.

---

## 2. Required secrets (`wrangler secret put`)

```powershell
pnpm --filter @splash/fleet-inquiry-worker exec wrangler secret put SUPABASE_ANON_KEY
pnpm --filter @splash/fleet-inquiry-worker exec wrangler secret put TURNSTILE_SECRET_KEY
pnpm --filter @splash/fleet-inquiry-worker exec wrangler secret put GOOGLE_MAPS_API_KEY
```

| Name | Type | Required? | Purpose |
|---|---|---|---|
| `SUPABASE_ANON_KEY` | secret | yes | Read-only PostgREST access to `pricing_simple` / `pricing_simple_resolved` / `locations` and INSERT to `fleet_submissions`. Mirrors the legacy worker's posture. |
| `TURNSTILE_SECRET_KEY` | secret | optional in code, **bind in any prod-equivalent env** | Verifies Cloudflare Turnstile tokens on `POST /api/fleet-submit`. When unbound the worker silently skips verification — fine for workers.dev smoke tests, NOT fine for the real fleet form. |
| `GOOGLE_MAPS_API_KEY` | secret | optional in code | Geocodes user-provided addresses for nearest-five sorting. When unbound the worker falls back to alphabetical sort. **See section 3 for billing implications.** |

### Plain vars (already in `wrangler.toml [vars]`)

| Name | Value | Notes |
|---|---|---|
| `SUPABASE_URL` | `https://rewokyofschtvqgxrxwl.supabase.co` | Public; checked into the repo. Same Supabase project as the rest of the monorepo. |
| `TURNSTILE_SITE_KEY` | `0x4AAAAAADBV7fdfR67Jt-ab` | Public site key for the client-side Turnstile widget. Distinct from the secret key bound above. |

### CLAUDE.md constraint #3 — anon vs. service key

The legacy worker reads `SUPABASE_ANON_KEY` (not the service key). The
monorepo lift-and-shift mirrors that posture intentionally. CLAUDE.md
constraint #3 standardizes the rest of the monorepo on
`SUPABASE_SERVICE_KEY` (note: NOT `SUPABASE_SERVICE_ROLE_KEY`); fleet
is a documented exception until a future brief converts the inline
PostgREST fetches to `@splash/db-supabase` helpers and flips the
binding.

**Do not bind `SUPABASE_SERVICE_KEY` or `SUPABASE_SERVICE_ROLE_KEY` on
this worker today** — the source code only reads `SUPABASE_ANON_KEY`,
so binding either name is dormant noise that risks confusing a future
reader.

---

## 3. Google Maps API key — billing surface

**Fleet is the only monorepo worker with paid third-party API usage.**
Calls go to `https://maps.googleapis.com/maps/api/geocode/json` and
are billed per-request beyond Google's free tier (~$5 per 1000 calls
at current pricing; check the Google Cloud console for the live rate).
A 7-day cache TTL on geocode results materially lowers volume — the
cache key is `geocode:<normalized-address>` in CF's
`caches.default`.

### Two operator options for the key

**Option A — reuse the legacy worker's existing key.**
Simplest. Cuts setup time. Contaminates Google's per-key quota
across both workers during transition (legacy vs monorepo traffic
indistinguishable in the dashboard).

**Option B — provision a new restricted key for `splash-fleet-inquiry`
in the Google Cloud console (recommended).**
Cleaner separation. Lets you A/B verify the monorepo worker without
quota crosstalk. Standard restriction posture: HTTP referrer for
public-tier keys, but the worker server-side calls don't have a
browser referrer — use API restrictions (Geocoding API only) instead.
IP restriction is impractical because CF Workers don't have a
stable egress IP; rely on API-restriction + per-key quota cap as
defense in depth.

### Operator action items

- Decide A or B. Default to B unless the cutover is imminent (within
  ~1 week) and the additional key is admin overhead the operator
  doesn't want.
- Document the Google Cloud project that owns the key (which org
  account, which billing account it's under).
- Document who has access to rotate (operator + at least one
  super_admin backup).
- Bookmark the quota dashboard URL so spend can be monitored ahead
  of any cutover or marketing-driven traffic spike.
- If choosing Option B, set a low daily-request cap on the new key
  (e.g., 5000 requests/day) until traffic patterns are observed.

---

## 4. Smoke test (workers.dev URL after first deploy)

After `pnpm --filter @splash/fleet-inquiry-worker deploy`:

```powershell
$WORKER = "https://splash-fleet-inquiry.<ACCOUNT>.workers.dev"
```

```bash
# 1. Form renders.
curl -i "$WORKER/fleet"
# → 200 text/html; ~1250-line inline HTML form

# 2. Find locations (no address, no coords) → 400.
curl -i -X POST "$WORKER/api/find-locations" \
  -H "Content-Type: application/json" \
  --data '{}'
# → 400 { error: "Please enter a valid address or zip code." }

# 3. Find locations with a known address.
curl -i -X POST "$WORKER/api/find-locations" \
  -H "Content-Type: application/json" \
  --data '{"address":"Binghamton, NY"}'
# → 200 { locations: [...] } — five nearest, geocoded if GOOGLE_MAPS_API_KEY
#   bound, alphabetical otherwise.

# 4. Fleet packages for a known location_code.
curl -i -X POST "$WORKER/api/fleet-packages" \
  -H "Content-Type: application/json" \
  --data '{"location_code":"binghamton"}'
# → 200 { packages: [...] } — pricing rows from pricing_simple_resolved

# 5. Submit (full payload). Use a Turnstile token from a manual browser
#    interaction with the workers.dev /fleet form, OR temporarily unbind
#    TURNSTILE_SECRET_KEY for this smoke test ONLY.
curl -i -X POST "$WORKER/api/fleet-submit" \
  -H "Content-Type: application/json" \
  --data '{ ...full fleet form payload... }'
# → 200 { success: true, submission_id }
# Confirm a row appeared in Supabase fleet_submissions.
```

**Manual visual checks**

- [ ] `/fleet` renders identically to `https://fleet.splashcarwashes.info`
      (same brand bar, same form fields, same step progression).
- [ ] Geocode-driven nearest-five returns sensibly ordered locations
      (e.g., a Syracuse-area address surfaces Syracuse-region locations
      first).
- [ ] When `GOOGLE_MAPS_API_KEY` is unbound, the worker still
      responds (alphabetical fallback) and surfaces a friendly
      message rather than 500-ing.
- [ ] When `TURNSTILE_SECRET_KEY` is bound, a `/api/fleet-submit`
      POST without a valid Turnstile token returns 4xx.
- [ ] Workers Logs in CF dashboard show invocations with
      `eventType: fetch` (Brief 63's `[observability.logs]` block
      is in `wrangler.toml`).

---

## 5. First-deploy steps (operator runbook)

1. Bind the three secrets (section 2) on `splash-fleet-inquiry` via
   `wrangler secret put`.
2. Add `splash-fleet-inquiry` to CF Builds GitHub-connect for the
   splash-info repo (Cloudflare dashboard → Workers & Pages →
   `splash-fleet-inquiry` → Settings → Builds → connect to GitHub →
   pick the repo + branch). Push-to-GH then triggers the first deploy.
   Alternatively, run `pnpm --filter @splash/fleet-inquiry-worker
   deploy` from the local repo (one-shot, doesn't require CF Builds
   wiring).
3. Verify the deploy in Workers Logs (CF dashboard → Workers &
   Pages → `splash-fleet-inquiry` → Logs).
4. Hit the workers.dev URL in a browser; confirm the form renders.
5. Run the four-step smoke test (section 4).
6. If smoke tests pass, `splash-fleet-inquiry` is ready for the
   cutover conversation (section 6) — but cutover does NOT happen
   automatically.

**Do NOT** run `wrangler deploy` if any secret on the worker was set
via the Cloudflare dashboard UI (CLAUDE.md constraint #4). Today all
secrets are CLI-set, so this is dormant — but reactivates if anyone
configures secrets via the dashboard.

---

## 6. Cutover (deferred — operator-driven)

**Out of scope for Brief 81 and any future Claude Code brief unless
the operator explicitly asks.** This section is a runbook for the
operator to execute manually when ready.

The cutover is: flip the `fleet.splashcarwashes.info` custom-domain
route from `broad-shape-38b8` to `splash-fleet-inquiry`. DNS does
NOT change (custom-domain routes work via CF zone ownership, not
external DNS).

### Preconditions

- All smoke tests in section 4 pass on `splash-fleet-inquiry`.
- Section 3's Google Maps key decision is settled and the chosen key
  is bound to the new worker.
- A maintenance window exists (or the operator is comfortable with a
  brief blip — the route flip is near-instantaneous in CF).

### Steps

1. **Bind the route on `splash-fleet-inquiry`.** Cloudflare dashboard
   → Workers & Pages → `splash-fleet-inquiry` → Settings → Domains &
   Routes → Add Custom Domain → `fleet.splashcarwashes.info`. CF will
   fail the bind if the domain is still owned by `broad-shape-38b8`
   — you'll need to do step 2 first.
2. **Unbind the route on `broad-shape-38b8`.** Same path under the
   legacy worker. Remove the custom domain.
3. **Verify.** Hit `https://fleet.splashcarwashes.info` in a fresh
   browser session (no caching) — should now serve from
   `splash-fleet-inquiry`. Workers Logs on the new worker should
   show invocations with the production hostname.
4. **Retire the legacy worker (after a soak period).** When you're
   confident the new worker is serving correctly (suggested soak: 1
   week of steady-state traffic + at least one real fleet
   submission verified end-to-end), delete `broad-shape-38b8` from
   the CF dashboard. Optional — leaving it dormant doesn't cost
   anything.

### Order matters

If step 1 errors out with "domain already owned", the dashboard is
preventing a duplicate bind. Do step 2 first, then step 1. There
will be a brief window (seconds) where neither worker owns the
domain — requests during that window get a CF "no route configured"
error. Operate in a quiet hour if this matters.

---

## 7. Rollback

**During workers.dev parallel testing (pre-cutover)**: no rollback
needed. The legacy worker continues to serve production. If
`splash-fleet-inquiry` misbehaves on workers.dev, fix and re-deploy
— production is unaffected.

**Post-cutover**: re-bind `fleet.splashcarwashes.info` to
`broad-shape-38b8` from the CF dashboard. Reverse of section 6
steps 1 & 2. Same brief race-window applies.

---

## 8. Deferred follow-ups (NOT this brief's scope; future brief candidates)

These are NOT actions the operator runs at deploy time. Tracking
here so they don't get lost.

- **Convert `src/index.js` to TypeScript.** ~1900 LOC, single file.
  Reasonable to do alongside the next material feature ask.
- **Replace inline Supabase fetches with `@splash/db-supabase`
  helpers.** Brings fleet under the same query layer as every other
  worker. Likely couples to the anon→service key migration below.
- **Migrate from `SUPABASE_ANON_KEY` to `SUPABASE_SERVICE_KEY` per
  CLAUDE.md constraint #3.** Aligns with the rest of the monorepo.
  Requires a code review of every PostgREST call to confirm RLS
  bypass is appropriate.
- **Extract the inline ~1250-line HTML form into
  `src/render/fleet-form.ts`** (matching signup-worker's pattern).
  Improves maintainability of the form; precondition for any
  apps/web admin surface that wants to render the same HTML.
- **Admin viewer for `fleet_submissions` in apps/web** (analogous to
  Brief 56's signup admin viewer at `/admin/signups`). Operator hasn't
  asked yet, but is the obvious next operational lift once submission
  volume picks up.
- **Cache invalidation alignment with signup-worker.** Fleet uses
  CF's `caches.default`; signup-worker uses an in-worker `Map`
  cache. Brief 28's open `pricing_simple_resolved` cache-buster
  work (referenced by Briefs 24/26/27) should consider whether
  fleet's CF cache also needs invalidation on pricing-mode flips
  — today fleet reads pricing on a 5-minute cache TTL, so changes
  surface eventually.
- **`broad-shape-38b8` retirement.** Once `splash-fleet-inquiry` has
  served production for a stable period, delete the legacy worker
  to reduce surface area. Optional — keeping it dormant has no cost.

---

## 9. References

- Brief 81 (lift-and-shift): `BRIEFS/brief-081-fleet-inquiry-worker-lift-and-shift.md`
- Source repo (origin of `src/index.js`):
  `C:\Users\Coppsrv\Documents\Projects\fleet-inquiry-worker`
- Supabase tables touched: `pricing_simple`, `pricing_simple_resolved`,
  `locations`, `fleet_submissions`
- Sibling PRE_DEPLOY docs (same shape, different workers):
  PRE_DEPLOY_DAMAGE.md, PRE_DEPLOY_DASHBOARD.md,
  PRE_DEPLOY_PERFORMANCE.md, PRE_DEPLOY_SIGNUP.md,
  PRE_DEPLOY_SYSADMIN.md, PRE_DEPLOY_WEB.md
