# Brief 169: Cutover Phase B — stage apex route diffs (inert/commented)

**Status:** Completed (2026-06-11)
**Drafted:** 2026-06-10

**Why:** Cutover Phase B flips the non-production workers — workorders, forms,
jotform, promo, fleet — to the apex host (see `CUTOVER_RUNBOOK.md` Phase B +
`CUTOVER_READINESS.md` Batch B). Same posture as Brief 168 (Phase A): stage the
apex route diffs **commented/inert** so the operator's flip is a reviewed
"uncomment + push" at the window, with zero premature-cutover risk.

**CRITICAL SAFETY POSTURE — identical to Brief 168.** Add apex route lines
**commented out**, inside each worker's existing active `routes` array, marked
`# === CUTOVER PHASE B —`. Commented lines deploy nothing. `deploy = git push`
here, so an active apex route added now would flip on the next push of any
change. **Do not add active apex routes. Do not change any `[vars]` values. Do
not commit, push, or deploy.**

**Dependencies:** Brief 168 (the Phase A pattern this mirrors),
`CUTOVER_RUNBOOK.md` (Phase B + Appendix), `CUTOVER_READINESS.md` (Batch B).

## Read first

- `CUTOVER_RUNBOOK.md` — Phase B + "Appendix — exact apex routes per worker"
  (Batch B list is authoritative) + the fleet note (constraint #9 override).
- `CUTOVER_READINESS.md` — Batch B table + §1 routing model.
- BRIEFS/brief-168-cutover-phase-a-route-diffs.md — the exact pattern to mirror.
- The five target `wrangler.toml` files (CURRENT active `routes` arrays are the
  authoritative path source):
  - `apps/workorders-worker/wrangler.toml`
  - `apps/forms-worker/wrangler.toml`
  - `apps/jotform-worker/wrangler.toml`
  - `apps/promo-worker/wrangler.toml`
  - `apps/fleet-inquiry-worker/wrangler.toml`

## Key constraints (do not violate)

1. **One `routes` key per TOML.** Add apex twins INSIDE the existing active
   `routes` array, commented. No second `routes` block. Remove/supersede any
   stale separate `# routes = [...]` reference block.
2. **Keep every existing active staging line exactly as-is** (staging stays the
   test surface).
3. **Mirror the live array** — one commented apex twin per active staging path,
   same `zone_name`.
4. **Do not change any `[vars]`.** In particular promo-worker's
   `APPS_WEB_BASE_URL`: if it is not already `https://splashcarwashes.info`,
   add a `# CUTOVER PHASE B: confirm = https://splashcarwashes.info at flip`
   comment beside it — do NOT edit the value. (Already-apex → just note it's
   confirmed.)
5. **fleet is a special case — read carefully.** CLAUDE.md constraint #9 says
   don't bind `fleet.splashcarwashes.info` on `splash-fleet-inquiry` and don't
   touch `broad-shape-38b8`. The cutover **operator-overrides** constraint #9
   (documented in `CUTOVER_RUNBOOK.md` Phase B + locked decision #4). For THIS
   brief that override is satisfied safely because the apex route is added
   **commented (inert)** — you are NOT actually binding it. So: stage the
   commented `fleet.splashcarwashes.info/*` twin, but **do NOT uncomment it, do
   NOT touch `broad-shape-38b8`, and do NOT remove fleet's route from the legacy
   worker** (that legacy-side removal is a CF-UI operator action at the window).

## Scope

For each file, append a commented apex-twin block inside the active `routes`
array, using the grep-able marker:

```toml
routes = [
  { pattern = "staging.splashcarwashes.info/workorders/api/*", zone_name = "splashcarwashes.info" },
  # === CUTOVER PHASE B — uncomment the line(s) below + push at the flip window ===
  # { pattern = "splashcarwashes.info/workorders/api/*", zone_name = "splashcarwashes.info" }
]
```

### Per-worker apex twins to stage (commented) — verify against each live array

- **`apps/workorders-worker/wrangler.toml`** — `/workorders/api/*`.
- **`apps/forms-worker/wrangler.toml`** — `/forms/*`. (Bare `/forms` index is
  served by apps/web's catch-all; `/forms/*` does not capture it — leave that
  coexistence intact.)
- **`apps/jotform-worker/wrangler.toml`** — `/jotform/*`, `/admin/jotform/api/*`.
- **`apps/promo-worker/wrangler.toml`** — `/promo/*` + the `APPS_WEB_BASE_URL`
  comment note per constraint #4.
- **`apps/fleet-inquiry-worker/wrangler.toml`** — **subdomain twin**
  `fleet.splashcarwashes.info/*` (twin of the Brief 82 staging subdomain
  `fleet.staging.splashcarwashes.info/*`). This is a subdomain route, NOT a
  path carve. Stage commented per constraint #5.

## Out of scope (operator-only; do NOT attempt in this brief)

- Activating routes (uncommenting) / pushing / deploying — operator, at window.
- Changing any `[vars]` value — operator.
- **JotForm webhook re-point** to `https://splashcarwashes.info/jotform/{token}`
  — operator, JotForm UI.
- **PA email-queue drain flow** host change to the production forms host —
  operator, Power Automate.
- **fleet:** removing the apex route from `broad-shape-38b8` (CF UI) and the
  Google-Maps-key restriction — operator.
- Don't touch `info-signup-worker` / `broad-shape-38b8`.

## Validation (Definition of Done)

- Each of the five `wrangler.toml` files has the commented apex twin block
  inside its single active `routes` array, marked `CUTOVER PHASE B`.
- Every pre-existing active staging line unchanged; one `routes` key per file.
- No `[vars]` value changed; promo `APPS_WEB_BASE_URL` note present if needed.
- fleet apex subdomain twin staged commented; `broad-shape-38b8` untouched.
- Config parses: `pnpm --filter @splash/<worker> exec wrangler deploy
  --dry-run --outdir=.tmp-cutover` succeeds for workorders / forms / jotform /
  promo / fleet (dry-run does not deploy; commented routes are inert).
- **No commit, no push, no deploy.** Working-tree changes only.
- `git diff --stat` shows exactly the five `wrangler.toml` files touched.
- Brief Outcome filled in.
- `BUILD_STATE.md`: one Findings entry — "Phase B apex routes staged
  (commented/inert) in 5 wrangler.toml files; activation = operator uncomment +
  push at the window (+ fleet legacy-route removal + JotForm/PA reconfig)."

## Report

- Exact commented apex line(s) added per file.
- Confirmation staging lines untouched, one `routes` key each, no `[vars]`
  changed, `broad-shape-38b8` untouched.
- Dry-run parse results for the five workers.
- Confirm no commit/push/deploy.

## Outcome

**Files touched (5):**
- `apps/workorders-worker/wrangler.toml`
- `apps/forms-worker/wrangler.toml`
- `apps/jotform-worker/wrangler.toml`
- `apps/promo-worker/wrangler.toml`
- `apps/fleet-inquiry-worker/wrangler.toml`

`git diff --stat` shows 10 wrangler.toml diffs in the working tree — the
5 above (Brief 169) plus the 5 Brief 168 ones (apps/web, dashboard,
sysadmin, damage, performance) that were pre-existing uncommitted from
the prior brief. Exactly the 10 files staged for cutover Phase A + B;
no other source files touched outside `BUILD_STATE.md` + this brief +
the orchestration files (`BRIEFS/DONE.md`, `BRIEFS/QUEUE.md`).

**Exact commented apex line(s) added per file** (each banner reads
`# === CUTOVER PHASE B — uncomment the line(s) below + push at the flip window ===`):

- `apps/workorders-worker/wrangler.toml`
  - `# { pattern = "splashcarwashes.info/workorders/api/*", zone_name = "splashcarwashes.info" }`
- `apps/forms-worker/wrangler.toml`
  - `# { pattern = "splashcarwashes.info/forms/*", zone_name = "splashcarwashes.info" }`
- `apps/jotform-worker/wrangler.toml`
  - `# { pattern = "splashcarwashes.info/jotform/*", zone_name = "splashcarwashes.info" },`
  - `# { pattern = "splashcarwashes.info/admin/jotform/api/*", zone_name = "splashcarwashes.info" }`
- `apps/promo-worker/wrangler.toml`
  - `# { pattern = "splashcarwashes.info/promo/*", zone_name = "splashcarwashes.info" }`
- `apps/fleet-inquiry-worker/wrangler.toml`
  - `# { pattern = "fleet.splashcarwashes.info", custom_domain = true }`
    (preceded by an explicit prerequisite comment that the operator must
    remove `fleet.splashcarwashes.info` from `broad-shape-38b8` in the
    CF dashboard FIRST — otherwise CF rejects the duplicate hostname
    binding at push time.)

**Staging-line preservation.** Every pre-existing
`staging.splashcarwashes.info/...` and `fleet.staging.splashcarwashes.info`
line keeps its exact pattern + zone_name / custom_domain value. The only
structural adjustment was a trailing comma on the previously-last entry
of each multi-line array, so syntax stays valid when the operator
uncomments the apex twins at the flip window (matches Brief 168's
pattern and this brief's `## Scope` exemplar verbatim). The semantic
content of every staging line is unchanged.

**Stale separate `# routes = [...]` reference blocks** were superseded /
removed in `apps/workorders-worker`, `apps/forms-worker`,
`apps/promo-worker`, and `apps/fleet-inquiry-worker` per constraint #1
(the commented apex twins inside the active array are now the single
source of truth in each file). `apps/jotform-worker/wrangler.toml` had
no stale reference block to remove — its `routes = [...]` array was
already the sole route declaration from Brief 107 land.

**One `routes` key per TOML.** Confirmed via the successful wrangler
dry-runs below (a duplicate `routes` would error TOML parsing). No file
has two active `routes` keys.

**No `[vars]` value changed.** promo-worker's `APPS_WEB_BASE_URL` was
already `https://splashcarwashes.info` (set at Brief 162) — per
constraint #4's "Already-apex → just note it's confirmed" guidance,
added inline `# CUTOVER PHASE B: confirmed = https://splashcarwashes.info at flip (already apex).`
comment beside it. The dry-run binding listing confirms
`env.APPS_WEB_BASE_URL ("https://splashcarwashes.info")` unchanged.

**`broad-shape-38b8` UNTOUCHED.** The legacy fleet worker was not
opened, edited, or referenced by the change set. Brief constraint #5
satisfied. The fleet apex twin's pre-removal requirement is documented
inline in the apex twin's comment block (multi-line note above the
inert line), so the operator sees it at the cutover window grep.

**Validation results.**
- `pnpm --filter @splash/workorders-worker exec wrangler deploy --dry-run --outdir=.tmp-cutover` → success; bundle 749.02 KiB raw / 142.66 KiB gzip; bindings surface include `env.MAINTAINX_BASE_URL` + `env.APPS_WEB_BASE_URL ("https://splashcarwashes.info")`.
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run --outdir=.tmp-cutover` → success; bundle 2024.58 KiB raw / 445.49 KiB gzip; bindings surface include `env.FORMS_FILES (splash-forms-files)` + `env.PROMO_FILES (splash-promo-files)` (the Brief 165 cross-worker binding) + `env.SUPABASE_URL` + `env.TURNSTILE_SITE_KEY`.
- `pnpm --filter @splash/jotform-worker exec wrangler deploy --dry-run --outdir=.tmp-cutover` → success; bundle 763.48 KiB raw / 144.65 KiB gzip; bindings surface include `env.SUPABASE_URL` + `env.JOTFORM_BASE_URL`.
- `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run --outdir=.tmp-cutover` → success; bundle 939.20 KiB raw / 177.89 KiB gzip; bindings surface include `env.PROMO_FILES (splash-promo-files)` + `env.SUPABASE_URL` + `env.APPS_WEB_BASE_URL ("https://splashcarwashes.info")`.
- `pnpm --filter @splash/fleet-inquiry-worker exec wrangler deploy --dry-run --outdir=.tmp-cutover` → success; bundle 787.07 KiB raw / 150.05 KiB gzip; bindings surface include `env.SUPABASE_URL` + `env.TURNSTILE_SITE_KEY`.
- `pnpm typecheck` → 21/21 tasks green (12.75s; promo-worker re-executed, others cached).

`.tmp-cutover` artifact directories cleaned up post-validation.

**Decisions made on operator's behalf.**
1. **Trailing-comma additions on previously-terminal staging lines**
   classified as structural (not a "modify the active staging line"
   semantic change), matching Brief 168's pattern and this brief's
   `## Scope` exemplar verbatim. Operator's uncomment-and-push action
   stays trivially atomic — no comma rework required during the
   cutover window.
2. **fleet apex twin uses `custom_domain = true`** (mirroring the
   active staging line's shape) rather than the `pattern = "fleet...info/*", zone_name = ...`
   form a literal reading of the brief's Scope text might suggest. Per
   constraint #3 ("mirror the live array"), the active fleet staging
   route uses `{ pattern = "fleet.staging.splashcarwashes.info", custom_domain = true }`,
   so the apex twin must mirror that exact TOML shape for the operator's
   flip to be a syntactic no-brainer. The descriptive `/*` in the brief
   ("subdomain twin `fleet.splashcarwashes.info/*`") is shorthand for
   "all paths on this subdomain" — which `custom_domain = true` already
   provides.
3. **Removed (not just left in place)** the stale separate
   `# routes = [...]` reference blocks in workorders / forms / promo /
   fleet per constraint #1. Keeping them would have created perpetual
   ambiguity for future readers about which commented routes are
   authoritative; the apex twins inside the active array are now the
   only commented production-route reference in each file. (jotform
   had no stale block to remove.)
4. **promo `APPS_WEB_BASE_URL` confirmation note** placed inline above
   the line rather than as a standalone block, matching the inline
   comment style the file already uses for that var. Value unchanged.
5. **fleet apex twin block comment explicitly calls out the
   `broad-shape-38b8` pre-removal step** — this is a load-bearing
   detail that, if missed at the cutover window, would cause an
   immediate push failure with a CF duplicate-hostname error. Putting
   the warning right next to the inert apex line gets it in front of
   whoever performs the uncomment.

**Latent issues found.** None during the staging pass. Forward flags
for the cutover window itself (out of scope but worth carrying into
Phase B execution):
- **JotForm webhook URL re-point.** The four onboarded JotForm forms
  (rewash / salt-log / retention / time-card-edit) need their webhook
  URLs flipped from `https://staging.splashcarwashes.info/jotform/{token}`
  to `https://splashcarwashes.info/jotform/{token}` in each form's
  Integrations panel. Stagable via wrangler.toml = no; manual operator
  step at the window.
- **PA email-queue drain flow.** The Power Automate flow that polls
  `/forms/internal/api/email-queue/{claim,confirm}` needs its host
  flipped from the staging forms host to the production forms host
  once the apex `/forms/*` route is bound. Until then PA keeps
  draining via staging.
- **fleet legacy-route removal from `broad-shape-38b8`** (CF dashboard)
  is the prerequisite gate for fleet's apex twin uncomment — flipping
  order matters. The legacy worker's route must be removed FIRST,
  then the monorepo worker's apex twin uncommented + pushed.
- **Google-Maps-key restriction tightening** (PRE_DEPLOY_FLEET.md §3 —
  separate restricted key for `splash-fleet-inquiry` to avoid quota
  crosstalk with the legacy worker during transition) is operator-driven
  and stays out of scope for any brief.

**Compliance with brief's "do not" list.**
- No active apex routes added (every apex line is commented inside an
  inert position; uncomment is the operator's flip action).
- No `[vars]` value changed; promo `APPS_WEB_BASE_URL` only got an
  inline confirmation comment per constraint #4.
- `broad-shape-38b8` untouched; CLAUDE.md constraint #9 not violated
  (the brief's stated operator-override of constraint #9 is satisfied
  safely because the apex route is added commented/inert — nothing
  binds until the operator uncomments at the window).
- No commit, no push, no deploy — working-tree changes only.

**Diff stat (Brief 169 portion):**
```
 apps/fleet-inquiry-worker/wrangler.toml |  24 +++++++++++++++++-------
 apps/forms-worker/wrangler.toml         |  16 ++++++++++------
 apps/jotform-worker/wrangler.toml       |  13 ++++++++++++-
 apps/promo-worker/wrangler.toml         |  13 ++++++++-----
 apps/workorders-worker/wrangler.toml    |  14 ++++++++------
```
(Five files, exactly the brief's target set.)
