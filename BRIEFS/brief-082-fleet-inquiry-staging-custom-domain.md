# Brief 82: Fleet Inquiry Worker — bind staging custom domain `fleet.staging.splashcarwashes.info`

**Status:** Completed (2026-05-09)
**Drafted:** 2026-05-09
**Blocks:** After Brief 81 landed and `splash-fleet-inquiry` deployed
to workers.dev, the operator's smoke-test surface is the
`splash-fleet-inquiry.joshua-copp.workers.dev` URL — fine for sanity
checks but not aligned with the rest of the monorepo's staging
posture. This brief binds the worker to a proper staging custom
domain at `fleet.staging.splashcarwashes.info` (mirroring
production's `fleet.splashcarwashes.info` subdomain pattern), so
operator + future apps/web admin viewer (Brief 83) can talk to
fleet on a stable, branded URL during the legacy-vs-monorepo
parallel period.

The legacy `broad-shape-38b8` worker remains untouched. Production
custom-domain `fleet.splashcarwashes.info` is unchanged. Only a
NEW staging-tier route lands on `splash-fleet-inquiry`.

**Dependencies:**
- Brief 81 (the lift-and-shift that created the worker this brief
  configures).
- Brief 16 (the staging subdomain pattern this brief follows —
  workorders-worker carved out `staging.splashcarwashes.info/workorders/api/*`;
  fleet uses a subdomain instead of a path for the reasons in
  Context below).

## Read first

- CLAUDE.md (constraints #6 — production state preservation, and
  the "Working with workers" / wrangler routes posture).
- BUILD_STATE.md.
- BRIEFS/INDEX.md.
- BRIEFS/brief-081-fleet-inquiry-worker-lift-and-shift.md (the
  net-new directory this brief modifies).
- apps/fleet-inquiry-worker/wrangler.toml (the file gaining the
  routes block).
- apps/workorders-worker/wrangler.toml (reference — workorders'
  staging route is path-based; this brief uses subdomain).
- PRE_DEPLOY_FLEET.md (gains a new section for the staging route
  + Turnstile hostname requirement).

## Context

### Why subdomain not path-based for staging

workorders-worker stages on `staging.splashcarwashes.info/workorders/api/*`
because its endpoints are namespaced under `/workorders/api/` already,
which avoids collision with apps/web's own `staging.splashcarwashes.info`
routes (`/api/login`, `/api/me`, etc.). Fleet's source code (lifted
verbatim in Brief 81) exposes endpoints at `/api/find-locations`,
`/api/fleet-packages`, `/api/fleet-submit` — bare `/api/*` paths
that WOULD collide with apps/web's auth endpoints if fleet were
bound to a path on the same hostname.

Two options were considered:
1. Refactor fleet's API paths to `/fleet/api/*` so the worker can
   bind to `staging.splashcarwashes.info/fleet/api/*` AND
   `staging.splashcarwashes.info/fleet*` — requires touching the
   verbatim-lifted JS, which Brief 81 explicitly said this initial
   integration brief shouldn't do.
2. Bind a subdomain `fleet.staging.splashcarwashes.info` —
   mirrors production's subdomain pattern, requires zero code
   changes to the worker, and isolates fleet's URL space from
   apps/web's. This brief picks option 2.

The "refactor to path-based namespacing" option is a legitimate
future brief (it'd also be a clean prerequisite for the eventual
TS conversion brief), but it's deferred. Today's choice is
operationally cheaper.

### What the route binding does

Cloudflare custom_domain routes work by adding the worker as the
authoritative handler for the named hostname inside the CF zone.
Setting `routes = [{ pattern = "fleet.staging.splashcarwashes.info", custom_domain = true }]`
in wrangler.toml causes `wrangler deploy` (or CF Builds) to:
1. Provision the DNS record `fleet.staging.splashcarwashes.info`
   pointing to the CF Workers infrastructure (auto-handled when
   the parent zone `splashcarwashes.info` is on CF — which it is).
2. Bind the worker as the request handler for that hostname.
3. Auto-issue a TLS cert via CF's universal SSL.

No external DNS edit needed. The hostname comes online within a
minute or two of deploy. Apps/web staging remains on
`staging.splashcarwashes.info` (its own routes), unaffected.

### Why this is "production-grade staging"

`fleet.staging.splashcarwashes.info` will be CF-provisioned with a
proper TLS cert, branded host, and Workers Logs streaming — same
infrastructure the legacy `fleet.splashcarwashes.info` enjoys, just
on the staging subtree. This is the surface Brief 83's apps/web
admin viewer will hit when calling `splash-fleet-inquiry` (via
service binding in production-mode, via this URL in dev or
local-cross-origin scenarios).

### Turnstile hostname allow-list

The Turnstile widget rendered on the form needs
`fleet.staging.splashcarwashes.info` added to the site key's
allowed hostnames (CF dashboard → Turnstile → widget → Hostname
management). Without it, the widget POSTs to `challenges.cloudflare.com`
will 400 — the same failure the operator already hit on the
workers.dev URL during Brief 81 smoke-testing, fixed there by
adding the workers.dev hostname to the widget's allow list.
The same fix applies here for the staging hostname.

This brief does NOT auto-update the Turnstile allow-list (it's a
CF dashboard action, not a wrangler config file). PRE_DEPLOY_FLEET.md
gains a new step calling this out so the operator sees the
requirement before the first staging request fires.

## Scope

### Phase 1 — Add staging route to wrangler.toml

**File:** `apps/fleet-inquiry-worker/wrangler.toml`

Add a `routes = [...]` block (uncomment if it exists commented-
out from Brief 81, or insert fresh). The block:

```toml
# Brief 82 (2026-05-09): staging custom domain. Mirrors production's
# subdomain pattern (legacy worker `broad-shape-38b8` is bound to
# `fleet.splashcarwashes.info`; this monorepo worker stages on the
# `staging` subdomain of the same zone). Production route stays
# unbound until cutover — see CLAUDE.md constraint #6.
routes = [
  { pattern = "fleet.staging.splashcarwashes.info", custom_domain = true }
]
```

Place it near the existing `[vars]` block (anywhere in the file
that groups logically). Keep `workers_dev = true` — both the
custom-domain staging URL AND the workers.dev URL will resolve
to the same worker, which is fine for now.

Commented-out production route block stays commented out (mirrors
workorders-worker's posture pre-cutover):

```toml
# Production custom domain — operator-driven cutover. Keeping
# commented until ready to flip from legacy `broad-shape-38b8`.
# routes = [
#   { pattern = "fleet.splashcarwashes.info", custom_domain = true }
# ]
```

### Phase 2 — Validation

```sh
pnpm --filter @splash/fleet-inquiry-worker typecheck
pnpm typecheck
```

Wrangler config doesn't go through tsc, so the only thing
validation catches is structural breakage in `tsconfig.json` /
`package.json`. Both should still pass.

### Phase 3 — Document the operator deploy steps

Update **PRE_DEPLOY_FLEET.md** (created in Brief 81). Append a new
section "Staging custom domain (Brief 82)" with:
1. Manual deploy command:
   ```sh
   pnpm --filter @splash/fleet-inquiry-worker exec wrangler deploy
   ```
   (Or push to GH if CF Builds is wired and the watch path
   includes `apps/fleet-inquiry-worker/wrangler.toml`.)
2. Required Turnstile hostname update — operator goes to CF dashboard
   → Turnstile → click on widget `0x4AAAAAADBV7fdfR67Jt-ab` →
   Settings → Hostname management → add
   `fleet.staging.splashcarwashes.info`. Save.
3. Verification:
   ```sh
   curl -I https://fleet.staging.splashcarwashes.info/fleet
   ```
   Expect 200 with `cf-ray` header. Browser open should render the
   form. DevTools Network tab should show Turnstile POSTs to
   `challenges.cloudflare.com` returning 200 (not 400).
4. Rollback (if needed): comment out the routes block, redeploy.
   The custom domain unbinds cleanly.

### Phase 4 — Documentation

1. **CLAUDE.md** — under the "Working with workers" / staging
   bullet, add a one-line note:
   > fleet-inquiry-worker uses a staging subdomain
   > (`fleet.staging.splashcarwashes.info`) rather than a
   > path-carved staging route, mirroring its production
   > subdomain (`fleet.splashcarwashes.info`). Other workers
   > still use `staging.splashcarwashes.info/<feature>/api/*`.

2. **BUILD_STATE.md** — bump "Last updated" to 2026-05-09 and
   add a Findings entry: "Fleet staging custom domain landed —
   `fleet.staging.splashcarwashes.info` bound on
   `splash-fleet-inquiry`. Subdomain pattern chosen over path-
   carve to avoid touching verbatim-lifted JS (Brief 81 posture).
   Operator must add hostname to Turnstile widget allow-list as
   a separate dashboard step."

3. **BRIEFS/INDEX.md** — append Brief 82 row.

4. **BRIEFS/QUEUE.md** — entry already appended.

## Definition of Done

- `apps/fleet-inquiry-worker/wrangler.toml` contains the active
  `routes = [{ pattern = "fleet.staging.splashcarwashes.info",
  custom_domain = true }]` block with a Brief 82 comment marker.
- Production routes block remains commented out.
- `pnpm typecheck` passes.
- `PRE_DEPLOY_FLEET.md` contains the new "Staging custom domain"
  section enumerated in Phase 3.
- CLAUDE.md gains the one-line subdomain-vs-path-carve note.
- BUILD_STATE.md "Last updated" bumped + Findings entry added.
- BRIEFS/INDEX.md row added.
- This brief's `Status:` flips to `Completed (YYYY-MM-DD)`.
- Strict negative scope verified: zero modifications to any
  existing file under `apps/` or `packages/` other than
  `apps/fleet-inquiry-worker/wrangler.toml`.

## Out of scope

- Refactoring fleet's URL paths from `/api/*` to `/fleet/api/*`
  (deferred to TS-conversion brief).
- Binding the production custom domain `fleet.splashcarwashes.info`
  on `splash-fleet-inquiry` (operator-driven cutover; not a
  Claude Code action).
- Updating the Turnstile widget hostname allow-list (CF dashboard
  action, called out in PRE_DEPLOY_FLEET.md as an operator
  follow-up).
- Provisioning a separate Google Maps API key for staging
  (operator-coordinated; PRE_DEPLOY_FLEET.md from Brief 81
  already covers).
- Running `wrangler deploy` (operator does first deploy).

## Outcome

**Files modified:**
- `apps/fleet-inquiry-worker/wrangler.toml` — added the active
  `routes = [{ pattern = "fleet.staging.splashcarwashes.info",
  custom_domain = true }]` block with a Brief-82 comment marker
  documenting the subdomain-vs-path-carve choice. The commented-out
  production routes block (legacy `broad-shape-38b8` keeps
  `fleet.splashcarwashes.info`) is preserved verbatim.
- `PRE_DEPLOY_FLEET.md` — new section 4.5 "Staging custom domain
  (Brief 82)" inserted between sections 4 (smoke test) and 5
  (first-deploy operator runbook). Covers deploy command, the
  Turnstile widget hostname allow-list update operator dashboard
  step, curl + browser verification, and rollback. Documents that
  the `workers_dev = true` URL continues to resolve to the same
  worker (both URLs valid for smoke testing).
- `CLAUDE.md` — new "Staging hostnames" bullet under
  `## Working with workers`, between the workers.dev-only bullet and
  the paid-third-party-API bullet, documenting fleet's subdomain
  pattern as a deliberate exception with the collision rationale and
  pointing back to the path-carve convention other workers follow.
- `BUILD_STATE.md` — Last-updated bump (Brief 81 → Brief 82 prefix
  on the line-3 summary; Brief 81's text retained as a tail) +
  Findings entry covering the work, decisions made, validation,
  operator follow-ups, and latent issues.
- `BRIEFS/INDEX.md` — Brief 82 row Status flipped from
  `Ready for Claude Code` to `Completed (2026-05-09)`.
- `BRIEFS/QUEUE.md` — Brief 82 line moved from the active queue to
  the completed-tombstone comment block (`# brief-082-…
  (completed 2026-05-09)`).
- `BRIEFS/brief-082-fleet-inquiry-staging-custom-domain.md` — this
  Status field flipped to `Completed (2026-05-09)`; this Outcome
  section filled in.

**Files created:** none.

**Strict negative scope verified:** zero modifications to any file
under `apps/` other than `apps/fleet-inquiry-worker/wrangler.toml`,
zero modifications to any file under `packages/`. (Confirmed by
read-back of the diff: `wrangler.toml` is the only file touched
under either tree.)

**Decisions made on the operator's behalf:**
1. **PRE_DEPLOY_FLEET.md section placement** — inserted as section
   4.5 (between smoke test and first-deploy steps) rather than
   appended to the end. Rationale: keeps the staging-deploy operator
   runbook adjacent to the wrangler.toml deploy command flow rather
   than after the cutover/rollback runbooks for the legacy worker,
   matching the document's existing top-down narrative.
2. **CLAUDE.md placement** — added a new bullet rather than amending
   the existing workers.dev-only bullet. Rationale: keeps each bullet
   focused on a single concern (existing bullet: production routes
   posture; new bullet: staging hostname posture).
3. **Wrangler.toml comment marker text** — kept the brief's
   prescribed comment text but expanded it inline with the
   subdomain-vs-path-carve rationale and an explicit reference to
   CLAUDE.md constraint #9 for production-route posture, so a future
   reader landing on the routes block via grep sees the rationale
   without needing to load the brief.
4. **Production routes block** — kept commented out as the brief
   prescribed, with no edits to the comment text. Mirrors
   workorders-worker's pre-cutover posture.
5. **`workers_dev = true` retained** — both the custom-domain
   staging URL and the workers.dev URL will resolve to the same
   worker. Brief explicitly approved this; no change needed beyond
   leaving the existing line in place.

**Validation:**
- `pnpm --filter @splash/fleet-inquiry-worker typecheck`: green
  (`tsc --noEmit` exit 0; no diagnostics).
- `pnpm typecheck` (root): 15/15 packages successful, 0 cached
  (Turbo cache invalidated by the wrangler.toml edit on the fleet
  package; chained downstream cache misses on web / damage / db-
  supabase / workorders / performance / signup / dashboard /
  sysadmin all completed cleanly). 6.469s total wall-clock.
- Build steps not applicable for this worker — `apps/fleet-inquiry
  -worker/package.json` has no `build` script (same posture as the
  other 4 worker packages per Brief 79's latent finding).
  Wrangler config doesn't go through tsc, so the only thing
  validation catches is structural breakage in `tsconfig.json` /
  `package.json`; both untouched by this brief, so the typecheck
  passes are the meaningful signal.

**Operator follow-ups before the staging URL is usable** (NOT this
brief's scope per its Out-of-scope list):
1. Deploy via `pnpm --filter @splash/fleet-inquiry-worker exec
   wrangler deploy` (or push to GH if CF Builds is wired with the
   watch path covering `apps/fleet-inquiry-worker/wrangler.toml`).
   Cloudflare auto-provisions the DNS record for
   `fleet.staging.splashcarwashes.info` and issues a TLS cert via
   Universal SSL within ~2 minutes.
2. Add `fleet.staging.splashcarwashes.info` to the Turnstile widget
   allow-list: CF dashboard → Turnstile → click on widget
   `0x4AAAAAADBV7fdfR67Jt-ab` → Settings → Hostname management →
   add the staging hostname → Save. Without this, `/api/fleet-
   submit` POSTs from the staging URL will 400 from the widget side
   — same failure pattern hit on the workers.dev URL during Brief
   81 smoke testing.
3. Verify per PRE_DEPLOY_FLEET.md section 4.5 step 3 (curl HEAD,
   browser open, DevTools Network tab confirms Turnstile POSTs to
   `challenges.cloudflare.com` returning 200 not 400).

**Latent issues found:** none. The two open follow-ups in
PRE_DEPLOY_FLEET.md section 8 (TS conversion of `src/index.js` and
replacing inline Supabase fetches with `@splash/db-supabase` helpers)
remain gating preconditions for the path-carve refactor option that
this brief declined; both are still tracked there.

**Forward note:** Brief 83's apps/web admin viewer for
`fleet_submissions` will hit `splash-fleet-inquiry` via service
binding in production-mode and via this staging URL in cross-origin
dev scenarios. The staging URL is now the stable, branded surface
that brief will target.
