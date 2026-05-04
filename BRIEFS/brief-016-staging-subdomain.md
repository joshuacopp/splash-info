# Brief 16: Staging subdomain end-to-end testing (staging.splashcarwashes.info)

**Status:** Completed (2026-05-04)
**Started:** 2026-05-04
**Completed:** 2026-05-04
**Blocks:** Real end-to-end UI verification of every brief landed so far.
After Brief 16, the operator can click through the full system with real
auth, real cookies, real data, on a domain that mirrors production
behavior exactly. Replaces the localhost-dev rabbit hole.
**Dependencies:** Brief 1-7, 11, 11a, 11b — i.e., the full apps/web +
worker surface. Brief 11b's `isOriginAllowed` localhost carve-out becomes
moot in staging (same-origin), but stays harmless.

## Read first
- CLAUDE.md (especially "Critical constraints" and "What NOT to do" — this
  brief explicitly authorizes wrangler deploys + new route bindings, but
  ONLY for the staging subdomain; production routes stay commented)
- BUILD_STATE.md (especially "Known production state" — staging routes are
  ADDITIVE; production state is untouched)
- BRIEFS/INDEX.md
- CUTOVER_PLAN.md (the production cutover plan — this brief stages a
  rehearsal of it on staging.splashcarwashes.info)
- All 5 workers' wrangler.toml files:
  - apps/dashboard-worker/wrangler.toml
  - apps/signup-worker/wrangler.toml
  - apps/performance-worker/wrangler.toml
  - apps/sysadmin-worker/wrangler.toml
  - apps/damage-worker/wrangler.toml
  - apps/web/wrangler.toml
- All 5 PRE_DEPLOY_*.md files (DASHBOARD, SIGNUP, PERFORMANCE, SYSADMIN,
  DAMAGE) — for the secret/binding lists per worker

## Context

The localhost dev environment is a poor fit for end-to-end testing
because apps/web (localhost) and the 5 workers (workers.dev) are
different origins. Cookies don't cross under SameSite=Lax. CSRF gates
need carve-outs. Every test surfaces another layer of cross-origin
friction that has zero relevance to production.

Brief 16 binds apps/web and all 5 workers to a staging subdomain —
**staging.splashcarwashes.info** — so they all share an origin. Cookies
work natively, CSRF gates pass without carve-outs, the system behaves
exactly as it will in production, just at a different URL.

Operator decision (verified): **same Supabase, same R2, same D1 as
production.** The operator uses identifiable test data and cleans up at
their discretion. No staging-isolation work is in scope for this brief.

Production routes stay commented in every worker's wrangler.toml. They
get uncommented at full cutover (separate brief). Staging is purely
additive.

## Scope

1. **Per-worker wrangler.toml updates.** For each of the 5 workers,
   add a `routes = [...]` block targeting `staging.splashcarwashes.info`.
   Production routes stay commented above. Add a comment line above the
   new staging routes block clarifying its purpose. Specific paths per
   worker (mirror the production pattern from each wrangler.toml's
   commented block):

   - **dashboard-worker** (`apps/dashboard-worker/wrangler.toml`):
     ```toml
     routes = [
       { pattern = "staging.splashcarwashes.info/api/login",        zone_name = "splashcarwashes.info" },
       { pattern = "staging.splashcarwashes.info/api/logout",       zone_name = "splashcarwashes.info" },
       { pattern = "staging.splashcarwashes.info/api/forced-reset", zone_name = "splashcarwashes.info" },
       { pattern = "staging.splashcarwashes.info/api/me",           zone_name = "splashcarwashes.info" }
     ]
     ```

   - **signup-worker** (`apps/signup-worker/wrangler.toml`):
     ```toml
     routes = [
       { pattern = "staging.splashcarwashes.info/admin/api/*",        zone_name = "splashcarwashes.info" },
       { pattern = "staging.splashcarwashes.info/api/submit-signup",  zone_name = "splashcarwashes.info" },
       { pattern = "staging.splashcarwashes.info/signup/*",           zone_name = "splashcarwashes.info" },
       { pattern = "staging.splashcarwashes.info/q/*",                zone_name = "splashcarwashes.info" },
       { pattern = "staging.splashcarwashes.info/join/*",             zone_name = "splashcarwashes.info" }
     ]
     ```
     Customer routes (/signup/*, /q/*, /join/*, /api/submit-signup) stay
     on signup-worker per decision 8. The load-bearing-URL warning
     comment (per CLAUDE.md critical constraints) stays in place above
     the production routes — staging URLs aren't load-bearing
     (no customer bookmarks).

   - **performance-worker** (`apps/performance-worker/wrangler.toml`):
     ```toml
     routes = [
       { pattern = "staging.splashcarwashes.info/pertrack/*", zone_name = "splashcarwashes.info" }
     ]
     ```

   - **sysadmin-worker** (`apps/sysadmin-worker/wrangler.toml`):
     ```toml
     routes = [
       { pattern = "staging.splashcarwashes.info/sysadmin/api/*", zone_name = "splashcarwashes.info" }
     ]
     ```

   - **damage-worker** (`apps/damage-worker/wrangler.toml`):
     ```toml
     routes = [
       { pattern = "staging.splashcarwashes.info/manage/api/*",  zone_name = "splashcarwashes.info" },
       { pattern = "staging.splashcarwashes.info/claims-api/*",  zone_name = "splashcarwashes.info" },
       { pattern = "staging.splashcarwashes.info/claims/*",      zone_name = "splashcarwashes.info" }
     ]
     ```
     `/claims/{site}` is the public customer claim form per decision 9
     (damage-worker owns customer rendering).

   For each worker: leave `workers_dev = true` so the workers.dev URL
   continues to work as a development fallback. The new staging route
   coexists.

2. **apps/web wrangler.toml.** Bind apps/web to a catch-all on
   staging.splashcarwashes.info. CF's most-specific-match-wins routing
   means the worker-specific patterns above outrank apps/web's catch-all
   automatically — apps/web only handles paths NOT bound to a worker.

   ```toml
   routes = [
     { pattern = "staging.splashcarwashes.info/*", zone_name = "splashcarwashes.info" }
   ]
   ```

   apps/web ALSO needs the existing `[assets]` binding to keep working
   on the new domain (no code change; the binding is per-deploy not
   per-route).

3. **Environment variables for staging.**
   In production same-origin, apps/web's NEXT_PUBLIC_*_WORKER_URL env
   vars are unset/empty — its server-side helpers fall back to the
   request host (`splashcarwashes.info`). For staging on
   `staging.splashcarwashes.info`, the same fallback works (request
   host = staging.splashcarwashes.info, all routes resolve through CF).
   So **no NEXT_PUBLIC_*_WORKER_URL changes are needed** for staging
   deploys. The dev `.env.local` keeps the workers.dev URLs for the
   localhost case; staging deploys use whatever's in
   `apps/web/wrangler.toml`'s `[vars]` block (empty by design).

   The dev rewrites in `apps/web/next.config.mjs` activate based on
   env vars being set; in staging they no-op (env vars unset) and
   apps/web routes natively against the staging subdomain.

4. **Pre-deploy doc.** Create `STAGING_DEPLOY.md` at the repo root.
   Mirror the structure of the per-worker `PRE_DEPLOY_*.md` files but
   covering the full staging stack. Sections:
     - **Required CF state** (operator action item, NOT code):
       a. DNS for `staging.splashcarwashes.info` exists in CF (CNAME
          to `splashcarwashes.info` or proxied A record — operator
          confirms in CF dashboard).
       b. SSL/TLS coverage for the subdomain (CF universal cert
          covers it automatically when proxied).
     - **Per-worker secrets check** — for each of the 5 workers, list
       the secrets that must be present (mostly SUPABASE_URL,
       SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY) and the verification
       command:
       ```powershell
       pnpm --filter @splash/dashboard-worker exec wrangler secret list
       ```
       Expected output for each worker: the same secret names that
       were set during the build phase.
     - **Deploy sequence** — exact order to run:
       1. `pnpm deploy:dashboard`
       2. `pnpm deploy:signup`
       3. `pnpm deploy:performance`
       4. `pnpm deploy:sysadmin`
       5. `pnpm deploy:damage`
       6. `pnpm deploy:web` (NOTE: apps/web requires Windows Developer
          Mode or WSL because OpenNext's bundle assembly creates
          symlinks. If you don't have Dev Mode on, run apps/web's
          deploy from WSL.)
     - **Smoke test checklist** — 10-15 steps walking the full system:
       login at staging.splashcarwashes.info/login, /admin/dashboard,
       click each tile, walk damage manager end-to-end, walk
       performance tracker, hit a sysadmin form (idempotent op like
       grant-tool to self), verify Sign Out clears the cookie.
     - **Rollback** — to disable staging without touching production:
       comment out the `routes = [...]` blocks in each worker's
       wrangler.toml and re-deploy. The production routes (still
       commented) are unaffected. Add a one-line comment about why
       this rollback is safe and trivial.

5. **BUILD_STATE.md updates.**
   - Bump Last updated.
   - Add Findings entry summarizing what shipped + the staging
     deploy expectation.
   - Add a new section "Staging" describing the staging subdomain,
     same-data posture (no DB isolation), and the rollback path.
   - Update the "Deployed components" table — add a "Staging routes"
     column so each worker's row reflects whether it's bound to
     staging.splashcarwashes.info or not (ALL FIVE WORKERS get
     "yes" after this brief; apps/web also "yes").

6. **BRIEFS/INDEX.md** — add Brief 16 row, mark Completed (today),
   file link.

## Configuration

No new env vars or secrets. No code changes outside `wrangler.toml`
files (5 worker tomls + apps/web toml) and the new `STAGING_DEPLOY.md`
+ updates to `BUILD_STATE.md` and `BRIEFS/INDEX.md`.

The localhost carve-out in `packages/http/src/index.ts` from earlier
today (`isLocalhostOrigin`) stays in place — it's a no-op in staging
since browser Origin from staging.splashcarwashes.info matches the
worker's expected origin natively.

## Out of scope

- Production route binding (separate brief — full cutover).
- Per-environment Supabase / R2 / D1 isolation (operator decision: use
  production-shared backends, identifiable test data).
- Per-environment secrets (no separate staging secrets — workers carry
  the same SUPABASE_* values whether served at workers.dev or
  staging.splashcarwashes.info).
- DNS provisioning (operator action item, listed in
  STAGING_DEPLOY.md but the brief doesn't write CF dashboard config).
- Running the actual deploys from headless mode. The brief produces
  the config + the docs; the operator runs `pnpm deploy:*` in their
  own shell to land each.
- Modifying any worker source code (the localhost carve-out from
  earlier is the only worker-side change in this whole staging
  workstream, and it's already shipped).
- apps/web wrangler.toml `[vars]` block changes (env vars stay unset
  for staging same-origin).
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (no source changes; should be a no-op pass)
- pnpm --filter @splash/web build succeeds (no source changes; same)
- All 5 worker wrangler.toml files contain a `routes = [...]` block
  for staging.splashcarwashes.info
- apps/web/wrangler.toml contains the catch-all route block for
  staging.splashcarwashes.info
- `STAGING_DEPLOY.md` exists at the repo root with all four sections
  (Required CF state, Per-worker secrets check, Deploy sequence,
  Rollback)
- BUILD_STATE.md updated with Last updated bump, Findings entry,
  Staging section, Deployed components table column
- BRIEFS/INDEX.md updated with Brief 16 row marked Completed
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Per-worker wrangler.toml decisions (especially anything where the
  staging routes diverge from the commented production routes — they
  shouldn't, but flag any reason they did)
- Whether all 5 PRE_DEPLOY_*.md docs were consistent on secret
  inventories or if there were drift items the staging doc had to
  reconcile
- Latent issues spotted while reading wrangler files (e.g.,
  workers_dev = true vs unset, name = "..." inconsistencies)
- Deploy-order rationale (why dashboard first, web last) and any
  cross-worker dependencies the order respects
- Anything that would prevent the operator from running the deploy
  sequence successfully

## Outcome

### Files modified

- `apps/dashboard-worker/wrangler.toml` — added staging `routes = [...]`
  block with 4 patterns (`/api/login`, `/api/logout`, `/api/forced-reset`,
  `/api/me`). Comment block above explains purpose + load-bearing-state
  awareness. `/api/me` included even though it's missing from the
  commented production routes block (Brief 11a added it; flagged for
  cutover task #13 reconciliation).
- `apps/signup-worker/wrangler.toml` — added staging routes block with
  5 patterns (`/admin/api/*`, `/api/submit-signup`, `/signup/*`, `/q/*`,
  `/join/*`). Load-bearing-URL warning above the (commented)
  production routes block preserved per CLAUDE.md critical constraints.
  Customer URLs aren't load-bearing on the staging subdomain (no
  customer bookmarks point there) — clarified in the comment.
- `apps/performance-worker/wrangler.toml` — added staging routes block
  with 1 pattern (`/pertrack/*`).
- `apps/sysadmin-worker/wrangler.toml` — added staging routes block
  with 1 pattern (`/sysadmin/api/*`).
- `apps/damage-worker/wrangler.toml` — added staging routes block with
  3 patterns (`/manage/api/*`, `/claims-api/*`, `/claims/*`).
  `/claims-api/*` is a collapsed wildcard vs. the two explicit
  production patterns; `/claims/*` is added per decision 9 (damage-worker
  owns the public claim form) and is missing from the (still-commented)
  production routes block — flagged for cutover task #13 reconciliation.
- `apps/web/wrangler.toml` — added staging catch-all
  (`staging.splashcarwashes.info/*`). Reordered to put the top-level
  `routes` key BEFORE the `[assets]` table header — TOML scoping rule
  meant the initial placement (after `[assets]`) caused wrangler to
  parse `routes` as a field of `[assets]` and emit a warning. Comment
  block notes the ordering invariant explicitly so future edits don't
  regress it.
- `BUILD_STATE.md` — bumped Last updated to "2026-05-04 — Brief 16
  completed"; added a "Staging routes bound" column to the Deployed
  components table populated for all 6 components; added a new "Staging"
  section after "Known production state" describing same-origin posture,
  same-data posture, the route layout, and the rollback path; added
  Brief 16 row to the prioritized work list; new Findings entry
  capturing the work and decisions.
- `BRIEFS/INDEX.md` — added Brief 16 row marked Completed.
- `BRIEFS/brief-016-staging-subdomain.md` — Status field flipped to
  Completed; this Outcome section filled in.

### Files created

- `STAGING_DEPLOY.md` at repo root — operator-facing deploy runbook
  with all four sections required by the brief (Required CF state /
  Per-worker secrets check / Deploy sequence / Smoke-test checklist +
  Rollback). Mirrors the structure of the per-worker `PRE_DEPLOY_*.md`
  files but covers the full staging stack.

### Decisions made on operator's behalf

1. **damage-worker `/claims-api/*` collapsed wildcard** in staging vs.
   the two explicit production patterns (`/claims-api/submit-claim`
   and `/claims-api/photo/*`). Reasoning: CF's most-specific-match-wins
   semantics mean a single wildcard is functionally equivalent — no
   other worker holds a more-specific pattern under `/claims-api/`
   that the wildcard would shadow. Operator can mirror this in the
   production routes block at cutover or keep the two-pattern split if
   they prefer the explicit form.
2. **damage-worker `/claims/*` included in staging.** Decision 9 (in
   `BRIEFS/INDEX.md`) made damage-worker the owner of the public
   customer claim form. The (still-commented) production routes block
   in `apps/damage-worker/wrangler.toml` doesn't reflect that — it
   only lists `/claims-api/*` + `/manage/api/*`. Added to staging so
   the smoke test can exercise the form end-to-end; flagged as a
   forward action for cutover task #13.
3. **dashboard-worker `/api/me` route added** to staging. Brief 11a
   shipped this endpoint but the (still-commented) production routes
   block was never updated. Including it on staging surfaces the
   discrepancy and lets the smoke test exercise the Header user-row
   feature. Same forward action.
4. **apps/web bound to a catch-all** (`staging.splashcarwashes.info/*`).
   Per the brief — relies on CF most-specific-match-wins to route
   per-worker patterns ahead of the catch-all.
5. **`workers_dev = true` preserved** across all 5 workers (already
   present, not modified). The staging routes coexist with the
   workers.dev URLs; both surfaces remain reachable so the operator
   can compare same-origin behavior on staging against
   cross-origin behavior on workers.dev when debugging.
6. **No `[vars]` changes** for apps/web staging deploys.
   `NEXT_PUBLIC_*_WORKER_URL` env vars stay unset; same-origin
   server-side helpers in apps/web fall back to the request host
   (`staging.splashcarwashes.info`) and CF routing handles the rest.
7. **Deploy order** (codified in STAGING_DEPLOY.md): dashboard-worker
   first (every authed worker depends on its session-cookie contract);
   apps/web last (consumer of every worker's API surface). Order
   doesn't strictly matter for the route-binding side effects (CF
   binds per-deploy independently), but the order matches the
   eventual production cutover so the rehearsal is faithful.
8. **STAGING_DEPLOY.md `routes`-block ordering note** added to
   `apps/web/wrangler.toml`'s comment so future edits don't regress
   the TOML scoping (top-level `routes` MUST appear before any
   `[table]` header).

### Latent issues / forward flags

- **`apps/dashboard-worker/wrangler.toml` commented production routes
  are out of date** — they list `/api/login`, `/api/logout`,
  `/api/forced-reset` but not `/api/me` (added Brief 11a). Cutover
  task #13 should reconcile.
- **`apps/damage-worker/wrangler.toml` commented production routes
  are out of date** — they list `/claims-api/submit-claim`,
  `/claims-api/photo/*`, `/manage/api/*` but not `/claims/*`. Per
  decision 9 the production block should include `/claims/*` (and
  may want to collapse the two `/claims-api/*` patterns into a single
  wildcard like staging). Cutover task #13.
- **`apps/web/wrangler.toml` commented production routes block is a
  placeholder** (`splashcarwashes.info/admin/*, ...`). Needs to be
  filled out with the real catch-all pattern at cutover (task #13).
- **`pnpm deploy:web` requires Windows Developer Mode or WSL** because
  `@opennextjs/cloudflare`'s bundle assembly creates symlinks during
  build — flagged in STAGING_DEPLOY.md so the operator can prep the
  environment before running. The five worker deploys are unaffected.
- **signup-worker name = `splash-signup-next`** — staging deploys use
  this distinct name so the legacy production worker (`splash-signup`)
  stays untouched. The full production cutover will need to either
  rename to `splash-signup` or point production routes at the
  `-next`-suffixed name; out of scope for staging.
- **First build attempt emitted a TOML warning** about `routes` being
  parsed inside the `[assets]` table — initial apps/web wrangler.toml
  placement was after the `[assets]` header, which TOML scopes into
  the table. Fix: moved `routes = [...]` to top-level above `[assets]`
  with an explanatory comment about the ordering invariant. Validated
  on second build — no warnings, all route bundles unchanged.

### Per-worker wrangler.toml decisions vs. commented production blocks

| Worker | Staging diverges from prod block? | If yes, how |
|---|---|---|
| dashboard-worker | yes | adds `/api/me` (Brief 11a; missing from prod block) |
| signup-worker | no | prod block already lists the same 4 patterns + `/admin/api/*` is implicit elsewhere |
| performance-worker | no | identical 1-pattern block |
| sysadmin-worker | no | identical 1-pattern block |
| damage-worker | yes | (a) `/claims-api/*` wildcard vs. two explicit prod patterns; (b) adds `/claims/*` per decision 9 (missing from prod block) |
| apps/web | n/a | prod block is a placeholder; staging is the first real route block |

### PRE_DEPLOY_*.md secret-inventory consistency

All 5 PRE_DEPLOY docs are consistent:
- All 5 workers require `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_KEY`.
- damage-worker additionally requires `POWER_AUTOMATE_URL`,
  `INCIDENTS_WEBHOOK_URL`, `AP_WEBHOOK_URL` (all fail-soft per
  `apps/damage-worker/wrangler.toml`'s header — staging can run
  without them firing if the operator prefers).

No drift between docs required reconciliation work in
STAGING_DEPLOY.md. Dashboard's PRE_DEPLOY notes that `SUPABASE_URL`
MAY be set as a `[vars]` entry rather than a secret — STAGING_DEPLOY.md
mirrors that.

### Latent issues spotted while reading wrangler files

- All 5 workers + apps/web carry `compatibility_date = "2026-05-01"` —
  consistent across the monorepo. No drift.
- `workers_dev = true` is set explicitly on dashboard-worker,
  signup-worker, performance-worker, sysadmin-worker, damage-worker.
  apps/web does NOT set it explicitly (defaults to true when no
  `routes` is set). Now that apps/web has a routes block, the default
  flips to `workers_dev = false` and the workers.dev URL stops
  working. **Decision:** left as-is — the brief says staging is for
  end-to-end testing on the new domain, and the workers.dev URL fork
  is not load-bearing for apps/web (the operator's localhost dev
  stays the alternative dev surface). If the operator wants to keep
  the apps/web workers.dev URL alive for parallel testing, they can
  add `workers_dev = true` as a one-line edit. Flagging in case the
  smoke-test checklist needs both surfaces.
- damage-worker carries `[[d1_databases]]` + `[[r2_buckets]]` +
  `[images]` blocks — verified intact and unchanged by the staging
  routes addition (added before those blocks at top level, so TOML
  scoping is clean).
- signup-worker carries `[vars] SIGNATURE_MODE = "inline"` — verified
  intact and unchanged.

### Anything that would prevent the operator from running the deploy sequence successfully

Nothing identified beyond the operator-side prerequisites listed in
STAGING_DEPLOY.md:
- DNS for `staging.splashcarwashes.info` exists in CF (proxied).
- SSL/TLS coverage (universal cert handles wildcards on proxied
  subdomains).
- Per-worker secrets list verified.
- Windows Developer Mode or WSL ready for `pnpm deploy:web`.

### Validation

- `pnpm typecheck`: 13/13 successful, **6.696s** (all 13 packages
  ran fresh — Turbo cache invalidated by the wrangler.toml changes
  for each worker, even though no source files changed; expected).
- `pnpm --filter @splash/web build`: succeeded — Next 15.5.15
  compiled in 4.4s (after the apps/web wrangler.toml ordering fix);
  12/12 static pages generated; **all route bundle sizes unchanged**
  from the Brief 11b snapshot (which is correct — no apps/web source
  files were edited):
  - `/` 131 B / 102 kB
  - `/admin/damage` 167 B / 105 kB
  - `/admin/damage/[id]` 965 B / 106 kB
  - `/admin/dashboard` 167 B / 105 kB
  - `/admin/performance` 1.85 kB / 107 kB
  - `/admin/pricing` 167 B / 105 kB
  - `/admin/pricing/[location]` 3.65 kB / 109 kB
  - `/admin/sysadmin` 161 B / 105 kB
  - `/change-password` 1.32 kB / 103 kB
  - `/login` 1.32 kB / 103 kB
  - `/logout` 131 B / 102 kB
  - `/signup/[location]` 131 B / 102 kB
  - Middleware 34.1 kB
- First build attempt emitted a TOML warning about the apps/web
  `routes` key being parsed as part of the `[assets]` table; second
  build (after the ordering fix) is clean.
