# Brief 81: Fleet Inquiry Worker — lift-and-shift into the monorepo (zero-impact, workers.dev only)

**Status:** Completed (2026-05-09)
**Drafted:** 2026-05-09
**Blocks:** The fleet-inquiry-worker today lives outside the monorepo
(`C:\Users\Coppsrv\Documents\Projects\fleet-inquiry-worker`), is
deployed to `fleet.splashcarwashes.info` under the auto-named
Cloudflare worker `broad-shape-38b8`, and ships with zero npm runtime
deps. This brief ports the source ONE-TO-ONE into
`apps/fleet-inquiry-worker/` as net-new code so it benefits from the
monorepo's CF Builds pipeline, observability config, and shared
deploy runbook posture, WITHOUT touching the production worker, the
production custom-domain route, or any existing monorepo code.

The lift-and-shift is the first of an N-brief integration. Future
briefs (whenever fleet gains a feature ask) will incrementally
convert to TypeScript, replace inline Supabase fetches with
`@splash/db-supabase` helpers, extract the inline HTML form into
`src/render/fleet-form.ts` matching signup-worker's pattern, and
flip secret reads from anon to service key. THIS brief does
none of that — the goal is to land a working monorepo copy that
deploys to workers.dev under a new name and behaves identically
to today's production worker.

**Dependencies:**
- None on existing briefs (fully additive directory).
- New external dependency tracked in PRE_DEPLOY_FLEET.md (drafted
  in this brief): a Google Cloud Maps Geocoding API key — the only
  paid third-party API surface in the monorepo.

## Read first

- CLAUDE.md (constraint #6 — production state diverges from repo
  state; this brief preserves that property)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- `C:\Users\Coppsrv\Documents\Projects\fleet-inquiry-worker\src\index.js`
  (the source being ported, plain JS, ~1900 LOC, single file)
- `C:\Users\Coppsrv\Documents\Projects\fleet-inquiry-worker\wrangler.jsonc`
  (the source wrangler config to translate to .toml)
- `C:\Users\Coppsrv\Documents\Projects\fleet-inquiry-worker\package.json`
  (single-package manifest; only devDependencies)
- apps/workorders-worker/wrangler.toml (the most recent worker — copy
  its `[observability.logs]` block, workers.dev posture, and overall
  shape verbatim)
- apps/workorders-worker/package.json (template for the monorepo
  workspace package.json)

## Context

### What this brief IS

A clean, additive port. After this brief lands:
- A new directory `apps/fleet-inquiry-worker/` exists with `wrangler.toml`,
  `package.json`, `src/index.js` (verbatim copy from external repo),
  `tsconfig.json` (allowJs to satisfy root typecheck without converting),
  `vitest.config.js` (carried over from external repo), and
  `test/index.spec.js` (also carried — boilerplate today).
- A new monorepo workspace package `@splash/fleet-inquiry-worker`
  is auto-included by the existing `pnpm-workspace.yaml` glob
  `apps/*`.
- The new worker deploys to workers.dev under a NEW name
  `splash-fleet-inquiry` (NOT the legacy `broad-shape-38b8`).
- Production `fleet.splashcarwashes.info` continues to serve from
  `broad-shape-38b8` exactly as today. The monorepo copy is a
  parallel deploy on workers.dev only, used for smoke testing and
  future development.
- A new `PRE_DEPLOY_FLEET.md` runbook lands at the repo root,
  matching the shape of the five existing PRE_DEPLOY docs.
- CLAUDE.md gains a "fleet-inquiry-worker" mention in the worker
  inventory at the top, plus a one-line note that fleet-inquiry is
  the only worker in the monorepo with paid third-party API usage
  (Google Maps Geocoding).
- BUILD_STATE.md gains a Findings entry summarizing the lift-and-
  shift, listing what was deferred (TS rewrite, Supabase helper
  refactor, render extraction, anon→service key migration), and
  pointing at the cutover (route flip + old-worker retirement) as
  an operator-driven follow-up that does NOT happen in this brief
  or any subsequent Claude Code brief unless explicitly asked.

### What this brief IS NOT

Strict negative scope — the executor does NONE of these:

- Does NOT touch production worker `broad-shape-38b8`. Don't delete
  it, don't rename it, don't unbind its custom domain. It keeps
  serving traffic.
- Does NOT touch the route binding for `fleet.splashcarwashes.info`.
  That stays bound to the legacy worker.
- Does NOT modify any existing files under `apps/` or `packages/`
  except the three doc additions enumerated above (CLAUDE.md
  worker inventory, BUILD_STATE.md Findings entry, BRIEFS/INDEX.md
  row). NO code edits to existing workers, NO edits to apps/web,
  NO edits to shared packages.
- Does NOT convert the JS source to TypeScript. The single
  `src/index.js` file is copied verbatim. `tsconfig.json` enables
  `allowJs: true` and `checkJs: false` so the root `pnpm typecheck`
  passes without errors but doesn't try to lint the JS.
- Does NOT replace inline Supabase fetches with `@splash/db-supabase`
  helpers. The fleet code makes its own PostgREST calls today; that
  pattern is preserved.
- Does NOT extract the inline HTML form into a render module. The
  ~1250-line template-literal HTML stays in `src/index.js`.
- Does NOT migrate from `SUPABASE_ANON_KEY` to `SUPABASE_SERVICE_KEY`.
  The new worker reads the same anon key the legacy worker reads.
  CLAUDE.md constraint #3 is acknowledged as a deferred decision
  in BUILD_STATE.md's Findings entry.
- Does NOT bind production routes in the new wrangler.toml. The
  routes block is commented out entirely (workers.dev only) — same
  posture as workorders-worker pre-cutover.
- Does NOT trigger the cutover. The legacy worker stays live; the
  new worker exists only on workers.dev until a future brief or
  operator action flips DNS/routes.

### Why a new worker name (and not reuse `broad-shape-38b8`)

`broad-shape-38b8` is the auto-generated CF default; the monorepo
convention is `splash-<feature>` (`splash-signup-next`,
`splash-damage`, `splash-workorders`, etc.). Deploying to a fresh
name `splash-fleet-inquiry` means:
1. The legacy worker continues to own `fleet.splashcarwashes.info`
   without any race or accidental overwrite.
2. A clean smoke-test surface on workers.dev under the new name
   (e.g. `splash-fleet-inquiry.<account>.workers.dev/fleet`).
3. Cutover later is a one-step DNS/route flip — no rename
   required.

### Production safety preserved

The monorepo's CF Builds pipeline (per CLAUDE.md "Working with
workers" — push-to-GH redeploys all workers configured for it)
deploys `splash-fleet-inquiry` on its first push. CF Builds
configuration for `broad-shape-38b8` is NOT modified by this brief
— that worker presumably has its own (or no) CF Builds config and
is deployed by some other path. The monorepo's CF Builds knows
about whichever workers the operator has explicitly wired into the
splash-info GitHub-connect; adding `splash-fleet-inquiry` as a new
target is the operator's call and is a step in PRE_DEPLOY_FLEET.md,
not an action this brief takes.

### Google Maps API key — the new operator-coordination surface

Fleet uses Google Maps Geocoding (`maps.googleapis.com/maps/api/geocode/json`)
to compute nearest-five sorting. It's optional (graceful fallback
to alphabetical when unbound) but operationally important.
PRE_DEPLOY_FLEET.md needs to call this out as a separate deploy
step, distinct from Supabase/Turnstile binding. Recommendation
written into the runbook: provision a SEPARATE restricted key for
the new monorepo worker (Google's API console allows per-app keys
with HTTP referrer restrictions) so the legacy and monorepo
workers don't share a key during cutover. Old key keeps the
legacy worker alive; new key proves the monorepo worker works
end-to-end on workers.dev. Operator decides whether to actually
provision a new key or temporarily reuse the existing one — both
are documented options.

## Scope

### Phase 1 — Create `apps/fleet-inquiry-worker/` directory

1. Create directory `apps/fleet-inquiry-worker/`.

2. Copy `src/index.js` from
   `C:\Users\Coppsrv\Documents\Projects\fleet-inquiry-worker\src\index.js`
   to `apps/fleet-inquiry-worker/src/index.js` VERBATIM. Do NOT
   modify the source. Use the `Read` tool to read the external file,
   then `Write` to land the same content at the monorepo path. The
   files should be byte-identical except for line-ending
   normalization if `Write` enforces LF.

3. Copy `test/index.spec.js` and `vitest.config.js` similarly,
   verbatim.

4. Create `apps/fleet-inquiry-worker/package.json` modeled on
   `apps/workorders-worker/package.json` but adapted:
   ```json
   {
     "name": "@splash/fleet-inquiry-worker",
     "version": "0.0.0",
     "private": true,
     "type": "module",
     "scripts": {
       "dev": "wrangler dev",
       "deploy": "wrangler deploy",
       "test": "vitest",
       "typecheck": "tsc --noEmit",
       "lint": "echo 'no lint yet'",
       "clean": "rm -rf dist .turbo .wrangler"
     },
     "dependencies": {},
     "devDependencies": {
       "@cloudflare/vitest-pool-workers": "^0.12.4",
       "@cloudflare/workers-types": "^4.20250101.0",
       "@splash/config": "workspace:*",
       "typescript": "^5.6.0",
       "vitest": "~3.2.0",
       "wrangler": "^4.86.0"
     }
   }
   ```
   Notes: zero runtime `dependencies` (matches the source's zero-
   dep posture); deliberately NOT importing `@splash/auth`,
   `@splash/db-supabase`, `@splash/http`, `@splash/types` —
   those are deferred to a future TS-rewrite brief. Vitest +
   wrangler versions match the external repo's existing pins so
   the carried-over test runs unchanged. `wrangler` bumped to
   `^4.86.0` to match the rest of the monorepo (the external
   repo's `^4.84.1` is close enough that this should be fine,
   but if the bump breaks `wrangler dev`, fall back to
   `^4.84.1` and note in Outcome).

5. Create `apps/fleet-inquiry-worker/tsconfig.json`:
   ```json
   {
     "extends": "../../packages/config/tsconfig.base.json",
     "compilerOptions": {
       "allowJs": true,
       "checkJs": false,
       "noEmit": true,
       "types": ["@cloudflare/workers-types"]
     },
     "include": ["src/**/*"],
     "exclude": ["node_modules", "dist", ".wrangler"]
   }
   ```
   If `packages/config/tsconfig.base.json` does not exist, omit
   the `extends` and inline a minimal compiler-options block
   (target ES2022, module ESNext, moduleResolution Bundler,
   strict false). The intent is: pnpm typecheck at the root
   doesn't error on the JS file. Run `pnpm --filter
   @splash/fleet-inquiry-worker typecheck` to verify.

6. Create `apps/fleet-inquiry-worker/wrangler.toml`. Translate
   the source `wrangler.jsonc` faithfully BUT with these changes:
   - `name = "splash-fleet-inquiry"` (NOT `broad-shape-38b8`)
   - `routes = []` block COMMENTED OUT entirely. The legacy
     worker keeps `fleet.splashcarwashes.info`. Workers.dev
     fallback only.
   - Compatibility date matches source (`2026-04-22`) or bumps
     to match workorders-worker (`2026-05-01`) — pick the
     workorders-worker date for monorepo consistency unless
     it breaks something. Note the choice in Outcome.
   - `compatibility_flags = ["nodejs_compat"]` carried over.
   - `[vars]` block carries over `SUPABASE_URL` and
     `TURNSTILE_SITE_KEY` verbatim. These are public values.
   - `[observability.logs]` block from Brief 63 added verbatim
     (enabled = true, invocation_logs = true) — replaces the
     source's bare `"observability": { "enabled": true }`.
   - `[limits]` `cpu_ms = 30000` carried over.
   - `upload_source_maps = true` carried over.
   - Top-of-file docblock comment in the same style as
     workorders-worker's wrangler.toml: lists the bindings
     required (SUPABASE_URL, SUPABASE_ANON_KEY,
     TURNSTILE_SECRET_KEY, GOOGLE_MAPS_API_KEY), explains the
     workers.dev-only posture, references that
     `broad-shape-38b8` continues to own production
     `fleet.splashcarwashes.info`, and explicitly notes the
     anon-key-vs-service-key deferral.

7. Verify the workspace picks up the new package:
   ```sh
   pnpm install
   ```
   Should be a no-op for the rest of the monorepo (no
   `dependencies` entries reference shared workspaces from
   fleet-inquiry-worker yet). If `pnpm install` adds entries to
   the lockfile they should be confined to the new worker's
   tree.

### Phase 2 — Validation

Run the standard validation suite:
```sh
pnpm typecheck
pnpm --filter @splash/fleet-inquiry-worker typecheck
pnpm --filter @splash/fleet-inquiry-worker test
```
The first MUST pass without errors. The second is a fast inner
check. The third runs the (boilerplate) vitest suite carried
from the external repo — current state is a hello-world
snapshot; expect it to pass without modification.

NO `wrangler deploy` step in this brief. Operator runs the
first deploy manually after binding secrets per
PRE_DEPLOY_FLEET.md.

### Phase 3 — Add `PRE_DEPLOY_FLEET.md`

New file at the repo root (sibling of `PRE_DEPLOY_DAMAGE.md`,
`PRE_DEPLOY_DASHBOARD.md`, etc.). Mirrors the structure of
`PRE_DEPLOY_WEB.md` (Brief 51) since both have multiple secret
surfaces. Sections:

1. **Overview** — what fleet-inquiry-worker does, who its
   customers are, where the legacy production deployment lives
   (`broad-shape-38b8` on `fleet.splashcarwashes.info`), what
   the new monorepo worker is (`splash-fleet-inquiry` on
   workers.dev), and how the two relate (parallel during
   transition, cutover later).

2. **Secrets to bind on `splash-fleet-inquiry`** —
   `wrangler --filter` is NOT a thing per CLAUDE.md; use
   `pnpm --filter @splash/fleet-inquiry-worker exec wrangler
   secret put NAME`:
   - `SUPABASE_ANON_KEY` — same value as `broad-shape-38b8`
     today; read-only PostgREST access. Operator-coordinated
     decision: when to migrate to `SUPABASE_SERVICE_KEY` per
     CLAUDE.md constraint #3 (deferred).
   - `TURNSTILE_SECRET_KEY` — same as legacy. Optional in code
     (worker skips Turnstile verification if unbound); should
     bind in production-equivalent env.
   - `GOOGLE_MAPS_API_KEY` — see dedicated section below.
     Optional in code; alphabetical fallback when unbound.

3. **Google Maps API key — billing surface** — flag fleet as
   the only monorepo worker with paid third-party API usage.
   Calls go to `maps.googleapis.com/maps/api/geocode/json`,
   billed per-request (~$5/1000 calls beyond the free tier).
   Cache TTL of 7 days on geocode results materially lowers
   volume. Two operator options:
   - Reuse the legacy worker's existing key (simplest;
     contaminates quota across both workers during transition)
   - Provision a new restricted key in the Google Cloud console
     for `splash-fleet-inquiry` (cleaner separation; allows
     A/B verification without quota crosstalk; recommended)
   Document the Google Cloud project that owns the key, who
   has access to rotate, and where the quota dashboard lives.

4. **Smoke test** — a 4-step manual checklist exercising each
   endpoint on the workers.dev URL after the first deploy:
   GET `/fleet` (form renders), POST `/api/find-locations`
   (with and without an address), POST `/api/fleet-packages`
   (with a known location_code), POST `/api/fleet-submit`
   (full payload, expects to write to `fleet_submissions`).

5. **First-deploy steps** — manual sequence the operator runs
   when ready: bind secrets, push to GH (or `wrangler deploy`
   from the worker dir), check Workers Logs in CF dashboard
   for invocation, hit workers.dev URL, run the 4-step smoke
   test.

6. **Cutover (deferred)** — explicitly out of scope for this
   brief and any future Claude Code brief unless operator
   asks. The cutover is: bind `fleet.splashcarwashes.info` as
   a custom-domain route on `splash-fleet-inquiry` AND unbind
   it from `broad-shape-38b8` (or vice-versa, in whatever
   order CF allows without dropping traffic). DNS does not
   need to change (custom-domain routes work via CF zone
   ownership, not external DNS). Post-cutover, retire the
   legacy worker. Document this as a manual operator runbook;
   do NOT codify it as a brief that any executor would land
   without explicit operator signoff.

7. **Rollback** — if the new worker misbehaves on workers.dev,
   no rollback needed (legacy continues to serve production).
   If misbehavior surfaces post-cutover, re-bind the route to
   `broad-shape-38b8` from the CF dashboard.

### Phase 4 — Update documentation

1. **CLAUDE.md** — under "What this project is" / the worker
   inventory ASCII tree at the top:
   - Add a row to the `apps/` block:
     `apps/fleet-inquiry-worker  Public fleet-inquiry form (live at fleet.splashcarwashes.info; monorepo copy on workers.dev pending cutover) — Supabase + Google Maps Geocoding + Turnstile`
   - Update the count of workers in the prose ("Six Cloudflare
     Workers (apps/) — five ported …") to reflect the new
     count (now seven, but with a footnote that
     `splash-fleet-inquiry` is workers.dev-only until cutover).
   - Under "Read these every session, in order" section, add
     `PRE_DEPLOY_FLEET.md` to the list of PRE_DEPLOY files.
   - Under "Critical constraints", consider adding a constraint
     #9 explicitly stating that `broad-shape-38b8` and
     `fleet.splashcarwashes.info` are off-limits to Claude
     Code edits — same posture as constraint #6 but specific
     to fleet. (Optional; if it duplicates #6 too closely,
     just extend #6 with a sentence.)
   - Add a glossary entry for **fleet-inquiry-worker** mirroring
     existing glossary entries' depth (endpoints, data flow,
     external deps incl. Google Maps).
   - Add a one-liner under "Working with workers" noting fleet
     is the only paid-third-party surface.

2. **BUILD_STATE.md** — bump "Last updated" to 2026-05-09
   and add a Findings & decisions log entry titled
   "Fleet inquiry worker lift-and-shift (Brief 81)".
   Body lists what landed (new directory, new wrangler.toml,
   carry-over JS source, PRE_DEPLOY_FLEET.md), what was
   deferred (TS conversion, db-supabase helper migration,
   render extraction, anon→service key, cutover), and the
   open follow-ups (Google Maps key provisioning is operator-
   coordinated; cutover is operator-driven).

3. **BRIEFS/INDEX.md** — append Brief 81 row.

4. **BRIEFS/QUEUE.md** — entry already appended; this brief
   self-checks.

## Definition of Done

- `apps/fleet-inquiry-worker/` exists with these files:
  `wrangler.toml`, `package.json`, `tsconfig.json`,
  `src/index.js` (verbatim), `test/index.spec.js` (verbatim),
  `vitest.config.js` (verbatim).
- `pnpm install` at the repo root completes without errors;
  the new workspace is included.
- `pnpm typecheck` (root) passes without new errors.
- `pnpm --filter @splash/fleet-inquiry-worker typecheck`
  passes.
- `pnpm --filter @splash/fleet-inquiry-worker test` passes
  (boilerplate test from external repo).
- `apps/fleet-inquiry-worker/wrangler.toml` has `name =
  "splash-fleet-inquiry"`, `workers_dev = true`, NO production
  routes block (commented or absent), `[observability.logs]`
  block, `[vars]` for SUPABASE_URL + TURNSTILE_SITE_KEY,
  `[limits]` cpu_ms 30000.
- `PRE_DEPLOY_FLEET.md` exists at the repo root and covers
  all six sections enumerated in Phase 3.
- CLAUDE.md updated per Phase 4.1.
- BUILD_STATE.md "Last updated" bumped + Findings entry added.
- BRIEFS/INDEX.md row added.
- ZERO modifications to any other file under `apps/` or
  `packages/` (verify with `git diff --stat` — only new files
  under `apps/fleet-inquiry-worker/`, plus the four
  documentation file edits).
- This brief's `Status:` flips to `Completed (YYYY-MM-DD)`
  with the `## Outcome` section filled in.

## Out of scope

- Converting `src/index.js` to TypeScript.
- Replacing inline Supabase fetches with `@splash/db-supabase`
  helpers.
- Extracting the inline HTML form into a render module.
- Migrating from `SUPABASE_ANON_KEY` to `SUPABASE_SERVICE_KEY`.
- Binding production routes on the new worker.
- Provisioning the Google Maps API key (operator-coordinated).
- Running `wrangler deploy` (operator does the first deploy
  after secret binding).
- Deleting / renaming / retiring the legacy
  `broad-shape-38b8` worker.
- Cutover (route flip from legacy worker to new worker).
- Adding admin surfaces in apps/web for `fleet_submissions`
  (analogous to Brief 56's signup admin viewer) — future
  brief candidate.
- Aligning fleet's caching strategy (Cloudflare `caches.default`)
  with signup-worker's in-worker Map cache (related to the
  open Brief 28 `pricing_simple_resolved` cache invalidation
  gap).
- Modifying CF Builds GitHub-connect configuration to include
  `splash-fleet-inquiry` (operator does this in CF dashboard
  when ready to ship).

## Outcome

**Date completed:** 2026-05-09

### Files created (new)

- `apps/fleet-inquiry-worker/src/index.js` — verbatim byte-equal copy of
  `C:\Users\Coppsrv\Documents\Projects\fleet-inquiry-worker\src\index.js`
  (~1900 LOC, 68,964 bytes). `diff -q` against the source confirms no
  differences.
- `apps/fleet-inquiry-worker/test/index.spec.js` — verbatim copy of the
  source's hello-world boilerplate test (907 bytes). See "Latent issues"
  below.
- `apps/fleet-inquiry-worker/vitest.config.js` — copied verbatim, then
  amended ONE LINE: `configPath: "./wrangler.jsonc"` →
  `"./wrangler.toml"` because the new monorepo worker uses
  `wrangler.toml` (per the brief's Phase 1 step 6) and would otherwise
  load nothing. This is the only deviation from "verbatim". Documented
  here and in BUILD_STATE.md's Findings entry.
- `apps/fleet-inquiry-worker/package.json` — new file. Workspace name
  `@splash/fleet-inquiry-worker`, `type: "module"`, zero runtime
  `dependencies` (matches source), devDependencies match the brief's
  Phase 1 step 4 spec (`@cloudflare/vitest-pool-workers ^0.12.4`,
  `@cloudflare/workers-types ^4.20250101.0`, `@splash/config
  workspace:*`, `typescript ^5.6.0`, `vitest ~3.2.0`,
  `wrangler ^4.86.0`).
- `apps/fleet-inquiry-worker/tsconfig.json` — extends
  `../../packages/config/tsconfig.base.json` per the brief's Phase 1
  step 5; `allowJs: true / checkJs: false` so root `pnpm typecheck`
  passes without converting JS to TS.
- `apps/fleet-inquiry-worker/wrangler.toml` — new file translating the
  source's `wrangler.jsonc` per Phase 1 step 6: `name =
  "splash-fleet-inquiry"` (NOT `broad-shape-38b8`), production routes
  block COMMENTED OUT entirely (workers.dev fallback only),
  `compatibility_date = "2026-05-01"` (matches workorders-worker for
  monorepo consistency; one of the two acceptable choices in the brief
  spec), `compatibility_flags = ["nodejs_compat"]`, `[vars]`
  `SUPABASE_URL` + `TURNSTILE_SITE_KEY` carried over,
  `[limits] cpu_ms = 30000` carried over, `upload_source_maps = true`
  carried over, **`[observability.logs]` block from Brief 63 added
  verbatim** (replaces the source's bare `"observability": {"enabled":
  true}`). Top-of-file docblock enumerates all four required bindings
  + the workers.dev posture + the legacy worker reference + the
  anon-vs-service-key deferral note per Phase 1 step 6's spec.
- `PRE_DEPLOY_FLEET.md` (repo root) — new operator runbook covering
  all six sections enumerated in the brief's Phase 3, plus a section 7
  rollback section, a section 8 deferred-follow-ups list, and a
  section 9 references list. Mirrors the shape of PRE_DEPLOY_WEB.md
  (multiple secret surfaces).

### Files modified (existing)

- `CLAUDE.md` — four edits per Phase 4.1:
  1. Worker inventory tree extended from six → seven workers; the new
     `apps/fleet-inquiry-worker` row notes the workers.dev-only
     posture and external-deps inventory (Supabase + Google Maps
     Geocoding + Turnstile).
  2. "Read these every session" updated from six → seven PRE_DEPLOY
     files; PRE_DEPLOY_FLEET.md added to the list.
  3. New constraint #9: legacy `broad-shape-38b8` and
     `fleet.splashcarwashes.info` are off-limits to Claude Code edits
     (same posture as constraint #6 but specific to fleet).
  4. New "Working with workers" line flagging fleet as the only
     monorepo worker with paid third-party API usage.
  5. New glossary entry for **fleet-inquiry-worker** mirroring the
     depth of the workorders-worker entry (endpoint table, binding
     inventory, deferred-decision list).
- `BUILD_STATE.md` — bumped "Last updated" to 2026-05-09 with the
  Brief 81 summary block prepended; added a Findings entry as the new
  topmost row in the table at line 116.
- `BRIEFS/INDEX.md` — Brief 81 row's Status column flipped from
  "Ready for Claude Code" to "Completed (2026-05-09)".
- `BRIEFS/QUEUE.md` — `brief-081-...` line moved from active to
  commented-as-completed per the QUEUE convention.
- `pnpm-lock.yaml` — auto-updated by `pnpm install` to register the
  new workspace and its transitive deps (46 packages added —
  vitest-pool-workers + workerd + transitive deps).

### Files NOT modified (verified)

`git diff --stat` confirms zero modifications to any file under
`apps/` (other than the new `apps/fleet-inquiry-worker/` directory)
or `packages/`. No code edits to existing workers, no edits to
apps/web, no edits to shared packages — strict negative scope from
the brief honored.

### Decisions made on the operator's behalf

1. **Compatibility date `2026-05-01`** (matching workorders-worker)
   chosen over the source's `2026-04-22`. The brief explicitly listed
   this choice as "pick the workorders-worker date for monorepo
   consistency unless it breaks something." Confirmed nothing breaks
   (typecheck green; vitest test failure is a pre-existing latent
   issue unrelated to the compatibility date — see below).
2. **Wrangler version `^4.86.0`** kept as-spec (matching the rest of
   the monorepo). The source's `^4.84.1` was close enough that the
   brief allowed the bump; nothing observably broke.
3. **`vitest.config.js` `configPath` flipped** from `./wrangler.jsonc`
   (source) to `./wrangler.toml` (new). The brief said both that the
   file should be carried "verbatim" AND that the new worker uses
   `wrangler.toml` — these are mutually contradictory unless the
   vitest config is amended. This one-line deviation was the minimum
   needed to keep the test infrastructure pointing at the right
   config; documented here and in BUILD_STATE.md.
4. **Tsconfig extends a relative path** `../../packages/config/
   tsconfig.base.json` per the brief's Phase 1 step 5 spec, NOT
   `@splash/config/tsconfig.worker.json` (the pattern other workers
   use). The brief was explicit; followed it. Note that
   `@splash/config: "workspace:*"` is in devDependencies anyway, so a
   future brief that wants to switch to the workspace-resolved extend
   has zero migration cost.

### Latent issues found

1. **`test/index.spec.js` does not pass against the actual worker.**
   The carried-verbatim test expects `"Hello World!"` — leftover
   `wrangler init` boilerplate that was never updated when the actual
   worker code (which serves the inline fleet form HTML) was written.
   Verified the test FAILS identically in the source repo at
   `C:\Users\Coppsrv\Documents\Projects\fleet-inquiry-worker` with
   the same 2 snapshot mismatches. This is a pre-existing latent
   issue inherited from the source, NOT introduced by Brief 81. The
   brief's Definition of Done line "boilerplate test from external
   repo passes" was mistaken (the brief author appears to have
   assumed the test was a placeholder hello-world that was never
   exercised; it's actually exercised on `vitest run` and fails). This
   brief honored the verbatim-test-copy scope and surfaces the
   test-rewrite as a future-brief candidate. Do NOT mark this as a
   blocker for the lift-and-shift's actual goal: the JS source is
   intact, typecheck is green, the worker would deploy and behave
   identically to the legacy `broad-shape-38b8`.
2. **Transient `pnpm typecheck` failure on `@splash/web` immediately
   after `pnpm install`.** The first run reported lib.dom.d.ts and
   wrangler/cli.d.ts type errors that vanished on a subsequent run
   (cache behavior or unfinished dep resolution). Final state is
   green: `Tasks: 15 successful, 15 total / Cached: 15 cached, 15
   total / FULL TURBO`. Direct `pnpm --filter @splash/web typecheck`
   also green. Pre-existing lockfile (HEAD `pnpm-lock.yaml`) already
   had `typescript@5.9.3` and `wrangler@4.87.0` resolved — these
   versions are NOT introduced by Brief 81's package.json. The
   transient failure is most likely a turbo-or-pnpm race that doesn't
   reproduce on cached runs.

### Validation results

| Command | Result |
|---|---|
| `pnpm install` (root) | ✅ Added 46 packages; workspace count 17 → 18; no errors |
| `pnpm typecheck` (root, full turbo) | ✅ 15 successful, 15 total — full turbo cache hit on rerun |
| `pnpm --filter @splash/fleet-inquiry-worker typecheck` | ✅ Green (tsc --noEmit clean) |
| `pnpm --filter @splash/fleet-inquiry-worker exec vitest run` | ❌ **2 failed snapshots — pre-existing latent issue from source repo (see "Latent issues" #1 above), NOT introduced by Brief 81** |

`wrangler deploy` was NOT run (per CLAUDE.md and the brief's "What
this brief IS NOT" — out of scope; operator does the first deploy
after binding secrets per PRE_DEPLOY_FLEET.md).

### Operator follow-ups before first deploy

These are documented in PRE_DEPLOY_FLEET.md and NOT actions Brief 81
takes:

1. Decide Google Maps API key strategy. PRE_DEPLOY_FLEET.md section 3
   recommends Option B (separate restricted key for
   `splash-fleet-inquiry`) over Option A (reuse legacy worker's key).
2. Bind the three secrets:
   ```powershell
   pnpm --filter @splash/fleet-inquiry-worker exec wrangler secret put SUPABASE_ANON_KEY
   pnpm --filter @splash/fleet-inquiry-worker exec wrangler secret put TURNSTILE_SECRET_KEY
   pnpm --filter @splash/fleet-inquiry-worker exec wrangler secret put GOOGLE_MAPS_API_KEY
   ```
3. Add `splash-fleet-inquiry` to CF Builds GitHub-connect for the
   splash-info repo (Cloudflare dashboard).
4. Run the four-step smoke test in PRE_DEPLOY_FLEET.md section 4.
5. Cutover (route flip from `broad-shape-38b8` to
   `splash-fleet-inquiry`) is operator-driven and not codified as a
   brief — see PRE_DEPLOY_FLEET.md section 6 for the runbook.

### Future-brief candidates (NOT this brief)

Tracked here so they don't get lost; also captured in
PRE_DEPLOY_FLEET.md section 8:

- TS conversion of `apps/fleet-inquiry-worker/src/index.js`.
- Replace inline Supabase fetches with `@splash/db-supabase` helpers.
- Extract inline ~1250-line HTML form into `src/render/fleet-form.ts`
  matching signup-worker's pattern.
- Migrate `SUPABASE_ANON_KEY` → `SUPABASE_SERVICE_KEY` per CLAUDE.md
  constraint #3.
- Rewrite `test/index.spec.js` against actual worker behavior
  (replace the hello-world snapshot with real /fleet HTML
  smoke + endpoint integration tests).
- Admin viewer for `fleet_submissions` in apps/web (analogous to
  Brief 56's signup admin viewer).
- Cache-invalidation alignment with signup-worker (CF
  `caches.default` vs in-worker `Map` cache; relates to open Brief
  28).
- `broad-shape-38b8` retirement (post-cutover).
