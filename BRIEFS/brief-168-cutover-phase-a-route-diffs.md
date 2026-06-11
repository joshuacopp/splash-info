# Brief 168: Cutover Phase A — stage apex route diffs (inert/commented)

**Status:** Completed (2026-06-11)
**Drafted:** 2026-06-10

**Why:** Production cutover Phase A flips apps/web + dashboard + sysadmin +
damage + performance to the apex host `splashcarwashes.info` (see
`CUTOVER_RUNBOOK.md` Phase A + `CUTOVER_READINESS.md` Batch A). This brief
**stages the exact route diffs** in each worker's `wrangler.toml` so the
operator's cutover action is a trivial, reviewed "uncomment + push" during a
low-traffic window — NOT a from-scratch edit under time pressure.

**CRITICAL SAFETY POSTURE — the staged routes must be INERT.** This brief
adds the apex route lines **commented out**, inside each worker's existing
active `routes` array, marked with a `# CUTOVER PHASE A —` banner. Commented
lines deploy nothing. This means:
- The edits can sit in the working tree (or even get committed/pushed) WITHOUT
  triggering a premature cutover — nothing routes to the apex until the
  operator uncomments at the window.
- `deploy = git push` in this repo, so an ACTIVE apex route added now would
  flip production on the next push of ANY change. That is the failure mode this
  brief explicitly avoids. **Do not add active apex routes. Do not change
  `MAINTAINX_MODE`. Do not commit, push, or deploy.**

**Dependencies:** `CUTOVER_RUNBOOK.md` (Phase A procedure + Appendix "exact
apex routes per worker"), `CUTOVER_READINESS.md` (routing model + couplings).

## Read first

- `CUTOVER_RUNBOOK.md` — Phase 0 + Phase A + the "Appendix — exact apex routes
  per worker" (Batch A list is authoritative).
- `CUTOVER_READINESS.md` — §1 routing model, §2 couplings (esp. `/api/me`
  gap, the single-`routes`-key rule).
- The five target `wrangler.toml` files (their CURRENT active `routes` arrays
  are the authoritative path source — mirror each staging path to an apex twin):
  - `apps/web/wrangler.toml`
  - `apps/dashboard-worker/wrangler.toml`
  - `apps/sysadmin-worker/wrangler.toml`
  - `apps/damage-worker/wrangler.toml`
  - `apps/performance-worker/wrangler.toml`

## Key constraints (do not violate)

1. **One `routes` key per TOML.** Each file already has a single active
   `routes = [...]` array carrying the `staging.splashcarwashes.info/...`
   lines. Add the apex twins **inside that same array, commented**. Do NOT
   introduce a second `routes` block (TOML duplicate-key error) and do NOT
   uncomment / re-home any pre-existing separate `# routes = [...]` reference
   block — instead, delete or supersede that stale commented block so the
   single source of truth is the active array with the commented apex twins.
2. **Keep every existing active staging line exactly as-is.** Staging must keep
   working post-cutover (it's the test surface). You are ADDING commented apex
   lines, not replacing staging lines.
3. **Mirror the live array, don't invent paths.** For every active
   `staging.splashcarwashes.info/<path>` line, add a commented
   `splashcarwashes.info/<path>` twin with the same `zone_name`. The
   per-worker target sets below are for verification against the actual array.
4. **`MAINTAINX_MODE` stays `"test"`.** Do not change the value. Add a
   `# CUTOVER PHASE A: change to "production" at flip` comment beside it so the
   operator sees it at the window. Changing the value now would page real
   MaintainX assignees on the next damage deploy.

## Scope

For each of the five files, inside the existing active `routes` array, append a
commented block of apex twins. Use this exact marker so the operator can grep
`CUTOVER PHASE A` to find every line to activate:

```toml
routes = [
  { pattern = "staging.splashcarwashes.info/sysadmin/api/*", zone_name = "splashcarwashes.info" },
  # === CUTOVER PHASE A — uncomment the line(s) below + push at the flip window ===
  # { pattern = "splashcarwashes.info/sysadmin/api/*", zone_name = "splashcarwashes.info" }
]
```

### Per-worker apex twins to stage (commented)

Verify each against the file's CURRENT active array; add a commented apex twin
for each path the array actually carries.

- **`apps/web/wrangler.toml`** — apex catch-all
  `splashcarwashes.info/*` (twin of `staging.splashcarwashes.info/*`).
- **`apps/dashboard-worker/wrangler.toml`** — `/api/login`, `/api/logout`,
  `/api/forced-reset`, **and `/api/me`**. `/api/me` is the known gap
  (`CUTOVER_READINESS` §2.2) — if the active staging array already carries a
  `staging.../api/me` line, add its apex twin; if it does NOT carry `/api/me`,
  add the apex `splashcarwashes.info/api/me` line **commented** anyway (with a
  `# (gap fix — Header /api/me, READINESS §2.2)` note) so it's staged for the
  flip. Do NOT add a wildcard `/api/*` — keep each as an exact-path route
  (`READINESS` §2.4: the `/api/` namespace is split with signup).
- **`apps/sysadmin-worker/wrangler.toml`** — `/sysadmin/api/*`.
- **`apps/damage-worker/wrangler.toml`** — `/manage/api/*`, `/claims-api/*`,
  `/claims/*` (all three commented twins) + the `MAINTAINX_MODE` comment note
  per constraint #4. (`/claims/*` is a load-bearing public customer URL — keep
  the path exactly as the staging line has it.)
- **`apps/performance-worker/wrangler.toml`** — `/pertrack/*`.

## Out of scope (operator-only; do NOT attempt in this brief)

- **Activating the routes** (uncommenting) — operator does this at the window.
- **Changing `MAINTAINX_MODE` value** — operator flips at the window.
- **A2: removing the stale `/`, `/login`, `/logout` UI route bindings on
  `splash-dashboard`** — that's a CF-dashboard action, not a repo edit.
- **Secret verification** (`wrangler secret list`) — operator, Phase 0.
- **Commit / push / deploy** — operator, per-batch, at the window.
- Batch B / Batch C route staging — separate briefs.
- Don't touch `info-signup-worker` / `broad-shape-38b8`.

## Validation (Definition of Done)

- Each of the five `wrangler.toml` files has the commented apex twin block
  inside its single active `routes` array, marked `CUTOVER PHASE A`.
- Every pre-existing active staging route line is unchanged.
- No file has two `routes` keys; any stale separate `# routes = [...]`
  reference block is removed/superseded.
- `MAINTAINX_MODE` value is still `"test"`; the cutover comment is present.
- Config still parses for the four non-web workers:
  `pnpm --filter @splash/<worker> exec wrangler deploy --dry-run --outdir=.tmp-cutover`
  succeeds for dashboard / sysadmin / damage / performance (dry-run does NOT
  deploy; commented routes are inert). For `apps/web` (OpenNext build), a
  dry-run isn't applicable — instead confirm the TOML parses (no duplicate
  keys; the file still reads as valid TOML).
- **No commit, no push, no deploy.** Leave the edits as reviewable working-tree
  changes.
- `git diff --stat` shows exactly the five `wrangler.toml` files touched.
- Brief Outcome section filled in (files touched, the exact commented lines
  added per file, dry-run results).
- `BUILD_STATE.md`: one Findings entry noting "Phase A apex routes staged
  (commented/inert) in 5 wrangler.toml files; activation = operator uncomment +
  push at the cutover window." Do NOT mark cutover done.

## Report

- The exact commented apex line(s) added to each of the five files.
- Confirmation each staging line is untouched and each file has one `routes` key.
- Confirmation `MAINTAINX_MODE` value unchanged (`"test"`) + note added.
- Dry-run parse results for the four workers; TOML-validity note for web.
- Confirm no commit/push/deploy occurred.

## Outcome

**Files touched (5):**
- `apps/web/wrangler.toml`
- `apps/dashboard-worker/wrangler.toml`
- `apps/sysadmin-worker/wrangler.toml`
- `apps/damage-worker/wrangler.toml`
- `apps/performance-worker/wrangler.toml`

`git status --short` for tracked files shows exactly these five (plus the
pre-existing `M BRIEFS/QUEUE.md` and `?? BRIEFS/brief-168-...md` that belong
to the brief-orchestration layer, not this brief's scope).

**Exact commented apex line(s) added per file** (each banner reads
`# === CUTOVER PHASE A — uncomment the line(s) below + push at the flip window ===`):

- `apps/web/wrangler.toml`
  - `# { pattern = "splashcarwashes.info/*", zone_name = "splashcarwashes.info" }`
- `apps/dashboard-worker/wrangler.toml`
  - `# { pattern = "splashcarwashes.info/api/login",        zone_name = "splashcarwashes.info" },`
  - `# { pattern = "splashcarwashes.info/api/logout",       zone_name = "splashcarwashes.info" },`
  - `# { pattern = "splashcarwashes.info/api/forced-reset", zone_name = "splashcarwashes.info" },`
  - `# { pattern = "splashcarwashes.info/api/me",           zone_name = "splashcarwashes.info" }   # (gap fix — Header /api/me, READINESS §2.2)`
- `apps/sysadmin-worker/wrangler.toml`
  - `# { pattern = "splashcarwashes.info/sysadmin/api/*", zone_name = "splashcarwashes.info" }`
- `apps/damage-worker/wrangler.toml`
  - `# { pattern = "splashcarwashes.info/manage/api/*", zone_name = "splashcarwashes.info" },`
  - `# { pattern = "splashcarwashes.info/claims-api/*", zone_name = "splashcarwashes.info" },`
  - `# { pattern = "splashcarwashes.info/claims/*",     zone_name = "splashcarwashes.info" }`
- `apps/performance-worker/wrangler.toml`
  - `# { pattern = "splashcarwashes.info/pertrack/*", zone_name = "splashcarwashes.info" }`

**Staging-line preservation.** Every pre-existing
`staging.splashcarwashes.info/...` line keeps its exact pattern + zone_name
value. Only structural adjustment: a trailing comma was added on the
previously-last entry of each array where needed so the syntax stays valid
when the operator uncomments the apex twins at the flip window (matches the
brief's `## Scope` exemplar verbatim). The semantic content of every staging
line — pattern + zone_name — is unchanged.

**Stale separate `# routes = [...]` reference blocks** were superseded /
removed in `apps/web`, `apps/dashboard-worker`, `apps/sysadmin-worker`,
`apps/damage-worker`, `apps/performance-worker` per constraint #1 (the
commented apex twins are now the single source of truth inside the active
array; the prior orphan blocks would have drifted from the staging arrays
on every future routes change).

**One `routes` key per TOML.** Confirmed via `grep -c '^routes = \['` and
the successful wrangler dry-runs below (a duplicate `routes` would error
TOML parsing). No file has two active `routes` keys.

**`MAINTAINX_MODE`.** Value unchanged: still `"test"` in
`apps/damage-worker/wrangler.toml`. Added inline comment:
`MAINTAINX_MODE = "test"  # CUTOVER PHASE A: change to "production" at flip`.
The dry-run binding listing confirms `env.MAINTAINX_MODE ("test")`.

**Validation results.**
- `pnpm --filter @splash/dashboard-worker exec wrangler deploy --dry-run --outdir=.tmp-cutover` → success; bundle 714.29 KiB raw / 135.35 KiB gzip; no bindings (expected — dashboard-worker has only `[observability.logs]` + `workers_dev=true`).
- `pnpm --filter @splash/sysadmin-worker exec wrangler deploy --dry-run --outdir=.tmp-cutover` → success; bundle 763.39 KiB raw / 143.66 KiB gzip.
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir=.tmp-cutover` → success; bundle 1864.16 KiB raw / 424.60 KiB gzip; bindings surface include `env.MAINTAINX_MODE ("test")` + `env.MAINTAINX_BASE_URL` + `env.APPS_WEB_BASE_URL ("https://splashcarwashes.info")` + `env.INCIDENTS_EMAIL` + D1 + R2 + Images.
- `pnpm --filter @splash/performance-worker exec wrangler deploy --dry-run --outdir=.tmp-cutover` → success; bundle 718.04 KiB raw / 136.28 KiB gzip.
- `apps/web` — OpenNext build dry-run isn't applicable here (apps/web's wrangler config points at the post-build `.open-next/worker.js`). Instead validated TOML parses via `pnpm --filter @splash/web exec wrangler types`, which emits the runtime types AFTER successfully loading + parsing the wrangler config — output included the full `Cloudflare.Env` shape with all 10 service bindings (DASHBOARD_WORKER through PROMO_WORKER), confirming no duplicate keys and no TOML syntax error.

`.tmp-cutover` artifact directories + the auto-emitted
`apps/web/worker-configuration.d.ts` were cleaned up post-validation.

**Decisions made on operator's behalf.**
1. **Trailing-comma additions on previously-terminal staging lines** were
   classified as structural (not a "modify the active staging line"
   semantic change), matching the brief's `## Scope` exemplar which itself
   shows the staging line with a trailing comma alongside the inert
   commented apex twin. Operator's uncomment-and-push action stays
   trivially atomic — no comma rework required during the cutover window.
2. **`/api/me` apex twin staged unconditionally** in dashboard-worker.
   The active staging array carries `staging.../api/me` (added in Brief
   11a), so the apex twin mirrors the live array per constraint #3 AND
   closes the known production-block gap from CUTOVER_READINESS §2.2 in a
   single line. Inline comment `# (gap fix — Header /api/me, READINESS §2.2)`
   left next to it so the operator sees the linkage at the flip.
3. **Removed (not just left in place)** the stale separate
   `# routes = [...]` reference blocks in all five files per constraint
   #1. Keeping them would have created a perpetual ambiguity for future
   readers about which commented routes are authoritative; the apex twins
   inside the active array are now the only commented production-route
   reference in each file.
4. **Damage-worker apex twin for `/claims-api/*`** uses the same collapsed
   wildcard the active staging array already uses (covers both
   `/submit-claim` and `/photo/*`), NOT the two separate prod patterns
   from the prior stale `# routes = [...]` block. Per constraint #3
   ("mirror the live array"), the array's actual content drives the twins;
   per CF most-specific-match-wins semantics, this is equivalent to the
   two-line prod pattern at routing time.
5. **`/claims/*` apex twin path preserved exactly** as the staging line
   (`splashcarwashes.info/claims/*`) per CLAUDE.md constraint #1
   (load-bearing customer URL); added a NOTE in the rationale comment
   above the routes array so the brief author's intent is visible.

**Latent issues found.** None during the staging pass. Forward flags for
the cutover window itself (out of scope but worth carrying into Phase A
execution):
- The catch-all `splashcarwashes.info/*` on apps/web will inherit traffic
  for ANY apex path not bound to a sibling worker (per CF most-specific-
  match-wins). When Batch C activates signup-worker's `/signup/*` `/q/*`
  `/join/*` etc., those will outrank the catch-all automatically.
- The CF-dashboard action to remove the stale `/`, `/login`, `/logout`
  UI route bindings on `splash-dashboard` (CUTOVER_RUNBOOK §A2) stays a
  manual step at the window — not stageable via wrangler.toml.

**Compliance with brief's "do not" list.**
- No active apex routes added (every apex line is commented inside an
  inert position; uncomment is the operator's flip action).
- `MAINTAINX_MODE` value untouched (`"test"`); only an inline comment
  was added.
- No commit, no push, no deploy — working-tree changes only.

**Diff stat:**
```
 apps/damage-worker/wrangler.toml      |  23 +++++++++++++----------
 apps/dashboard-worker/wrangler.toml   |  24 ++++++++++++++----------
 apps/performance-worker/wrangler.toml |  17 +++++++++--------
 apps/sysadmin-worker/wrangler.toml    |  17 +++++++++--------
 apps/web/wrangler.toml                |  19 +++++++++----------
```
(Five files, exactly the brief's target set.)
