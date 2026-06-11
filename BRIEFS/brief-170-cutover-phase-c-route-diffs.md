# Brief 170: Cutover Phase C — stage apex route diffs (inert/commented)

**Status:** Completed (2026-06-11)
**Drafted:** 2026-06-10

**Why:** Cutover Phase C is the last and only live-traffic flip — signup-worker
(see `CUTOVER_RUNBOOK.md` Phase C + `CUTOVER_READINESS.md` Batch C).
`info-signup-worker` serves `/signup/*` `/q/*` `/join/*` `/api/submit-signup`
in production **right now**; these are load-bearing customer/admin bookmark
URLs that MUST NOT break. Same posture as Briefs 168/169: stage the apex route
diffs **commented/inert** so the flip is a reviewed "uncomment + push" at the
window.

**CRITICAL SAFETY POSTURE — identical to Brief 168.** Add apex route lines
**commented out**, inside the worker's existing active `routes` array, marked
`# === CUTOVER PHASE C —`. Commented lines deploy nothing. `deploy = git push`
here, so an active apex route added now would move live customer signup traffic
off `info-signup-worker` on the next push of any change. **Do not add active
apex routes. Do not rename the worker. Do not commit, push, or deploy.**

**Locked decision (RUNBOOK):** keep the worker name `splash-signup-next` — bind
apex routes to it, NO rename. apps/web's `SIGNUP_WORKER` service binding already
targets `splash-signup-next`, so **no apps/web change** is part of cutover.

**Dependencies:** Brief 168 (the pattern), `CUTOVER_RUNBOOK.md` (Phase C +
Appendix Batch C), `CUTOVER_READINESS.md` (Batch C + §2.4 split `/api/`
namespace + §2.6 rename/binding note).

## Read first

- `CUTOVER_RUNBOOK.md` — Phase C + "Appendix — exact apex routes per worker"
  (Batch C list is authoritative) + the ROLLBACK CARD (signup = reclaim to
  `info-signup-worker`).
- `CUTOVER_READINESS.md` — Batch C row + §2.4 (`/api/` is split: signup owns
  exact `/api/submit-signup`, dashboard owns the other `/api/*` — keep exact
  paths, never wildcard `/api/*`).
- BRIEFS/brief-168-cutover-phase-a-route-diffs.md — the exact pattern to mirror.
- `apps/signup-worker/wrangler.toml` — CURRENT active `routes` array is the
  authoritative path source.

## Key constraints (do not violate)

1. **One `routes` key.** Add apex twins INSIDE the existing active `routes`
   array, commented. No second `routes` block. Remove/supersede any stale
   separate `# routes = [...]` reference block.
2. **Keep every active staging line as-is** (staging stays the test surface).
3. **Mirror the live array** — one commented apex twin per active staging path.
4. **No rename.** Leave `name = "splash-signup-next"` exactly as is. (Renaming
   would break apps/web's `SIGNUP_WORKER` service binding — and is explicitly
   NOT the chosen strategy.)
5. **`/api/submit-signup` is an EXACT path, never a wildcard.** A `/api/*`
   wildcard would swallow dashboard's `/api/login|logout|forced-reset|me`.
   Mirror the exact staging line.
6. **`/signup/*`, `/q/*`, `/join/*` are load-bearing customer URLs.** Keep each
   path EXACTLY as the staging line carries it. Commented = inert; do not
   activate.

## Scope

Append a commented apex-twin block inside `apps/signup-worker/wrangler.toml`'s
active `routes` array, using the grep-able marker:

```toml
routes = [
  { pattern = "staging.splashcarwashes.info/signup/*", zone_name = "splashcarwashes.info" },
  # === CUTOVER PHASE C — uncomment the line(s) below + push at the flip window ===
  # { pattern = "splashcarwashes.info/signup/*", zone_name = "splashcarwashes.info" }
]
```

### Apex twins to stage (commented) — verify against the live array

- **`apps/signup-worker/wrangler.toml`** — `/signup/*`, `/q/*`, `/join/*`,
  `/api/submit-signup` (exact), `/admin/api/*` (+ any extra path the live
  staging array carries — mirror them all).

## Out of scope (operator-only; do NOT attempt in this brief)

- Activating routes (uncommenting) / pushing / deploying — operator, at window.
- **Parity verification** of `splash-signup-next` vs production
  (`info-signup-worker`) on workers.dev/staging — operator, Phase C1.
- **Pre-cutover SQL guard**
  (`UPDATE pricing_simple SET pricing='special', special=0.01 WHERE
  pricing='penny';`) — operator, at the window.
- Worker rename / apps/web binding change — NOT happening (locked).
- Don't touch `info-signup-worker`.

## Validation (Definition of Done)

- `apps/signup-worker/wrangler.toml` has the commented apex twin block inside
  its single active `routes` array, marked `CUTOVER PHASE C`, one twin per
  active staging path.
- Every pre-existing active staging line unchanged; one `routes` key.
- `name = "splash-signup-next"` unchanged. No wildcard `/api/*`.
- Config parses: `pnpm --filter @splash/signup-worker exec wrangler deploy
  --dry-run --outdir=.tmp-cutover` succeeds (dry-run does not deploy).
- **No commit, no push, no deploy.** Working-tree changes only.
- `git diff --stat` shows exactly `apps/signup-worker/wrangler.toml` touched.
- Brief Outcome filled in.
- `BUILD_STATE.md`: one Findings entry — "Phase C apex routes staged
  (commented/inert) on signup-worker; activation = operator parity-check +
  SQL guard + uncomment + push at the window; rollback = reclaim routes to
  info-signup-worker."

## Report

- Exact commented apex line(s) added.
- Confirmation staging lines untouched, one `routes` key, name unchanged, no
  wildcard `/api/*`.
- Dry-run parse result.
- Confirm no commit/push/deploy.

## Outcome

**Files touched (1):**
- `apps/signup-worker/wrangler.toml`

`git diff --stat apps/signup-worker/wrangler.toml` → `1 file changed, 24
insertions(+), 12 deletions(-)`. The repo-wide `git diff --stat` shows 11
`wrangler.toml` diffs in the working tree — the 1 file above (Brief 170)
plus the 10 pre-existing uncommitted files from Briefs 168 (apps/web,
dashboard, sysadmin, damage, performance) and 169 (workorders, forms,
jotform, promo, fleet-inquiry). Together: exactly the 11 files staged
for cutover Phase A + B + C; no other source files touched outside
`BUILD_STATE.md` + this brief + the orchestration files
(`BRIEFS/DONE.md`, `BRIEFS/QUEUE.md`).

**Exact commented apex line(s) added** (banner reads
`# === CUTOVER PHASE C — uncomment the line(s) below + push at the flip window ===`):

- `apps/signup-worker/wrangler.toml`
  - `# { pattern = "splashcarwashes.info/signup/*",          zone_name = "splashcarwashes.info" },`
  - `# { pattern = "splashcarwashes.info/q/*",               zone_name = "splashcarwashes.info" },`
  - `# { pattern = "splashcarwashes.info/join/*",            zone_name = "splashcarwashes.info" },`
  - `# { pattern = "splashcarwashes.info/api/submit-signup", zone_name = "splashcarwashes.info" },`
  - `# { pattern = "splashcarwashes.info/admin/api/*",       zone_name = "splashcarwashes.info" }`

Five twins, one per active staging path the array carries — matching the
authoritative list in CUTOVER_RUNBOOK.md Appendix Batch C
(`/signup/*`, `/q/*`, `/join/*`, `/api/submit-signup`, `/admin/api/*`).

**Staging-line preservation.** Every pre-existing
`staging.splashcarwashes.info/...` line keeps its exact pattern +
zone_name value. Only structural adjustment: a trailing comma was added
on the previously-last staging entry (the `/join/*` line) so syntax
stays valid when the operator uncomments the apex twins at the flip
window — matches Briefs 168/169's pattern and this brief's `## Scope`
exemplar verbatim. The semantic content of every staging line is
unchanged.

**Stale separate `# routes = [...]` reference block REMOVED** (lines
30-43 in the pre-Brief-170 file). It carried `splashcarwashes.info/...`
production routes commented out as a Step-4-scaffold reference, but did
NOT include the `/admin/api/*` path the active staging array carries —
so it was already drifting from authoritative state. Per constraint #1,
the commented apex twins inside the active `routes` array are now the
single source of truth in this file.

**One `routes` key in the TOML.** Confirmed via the successful wrangler
dry-run below (a duplicate `routes` would error TOML parsing). The
header-comment block in the file (lines 1-21) still describes the old
"deploy strategy" rationale and references "production routes (preserved
below in COMMENTED form)" — that reference is now stale (the apex twins
are inside the active array, not as a separate block). Left unchanged
because (a) the rationale text is still operationally correct (worker
deploys to workers.dev only until cutover), (b) editing it would balloon
the diff scope beyond what's needed for cutover staging, and (c) the
new comment block above the routes array (lines 42-57) authoritatively
documents the current cutover posture for any future reader. A
docblock-cleanup brief can sweep stale header text later if desired.

**Worker name unchanged.** `name = "splash-signup-next"` exactly as it
was — no rename per locked decision in CUTOVER_RUNBOOK.md Phase C
("Keep the worker name `splash-signup-next` — bind production routes to
it; do NOT rename. apps/web's `SIGNUP_WORKER` service binding already
points at `splash-signup-next`, so no apps/web binding change."). The
dry-run binding listing confirms the worker continues to deploy as
`splash-signup-next`.

**No wildcard `/api/*`.** The apex twin for the signup-side `/api/`
path is `splashcarwashes.info/api/submit-signup` — an EXACT path —
mirroring the staging line. Per constraint #5 + CUTOVER_READINESS §2.4,
a `/api/*` wildcard here would swallow dashboard-worker's `/api/login`,
`/api/logout`, `/api/forced-reset`, `/api/me`.

**Validation results.**
- `pnpm --filter @splash/signup-worker exec wrangler deploy --dry-run --outdir=.tmp-cutover` → success; bundle 785.14 KiB raw / 151.82 KiB gzip; bindings surface lists `env.SIGNATURE_MODE ("inline")` (expected — signup-worker's only `[vars]` entry; secrets are bound via `wrangler secret put` and don't surface in dry-run binding listings). No TOML errors, no duplicate-`routes` errors.
- `.tmp-cutover` artifact directory cleaned up post-validation.

**Decisions made on operator's behalf.**
1. **Trailing-comma addition on the previously-terminal staging line**
   (`/join/*`) classified as structural (not a "modify the active
   staging line" semantic change), matching Briefs 168/169's pattern
   and this brief's `## Scope` exemplar verbatim. Operator's
   uncomment-and-push action stays trivially atomic — no comma rework
   required during the cutover window.
2. **`/admin/api/*` apex twin staged** per constraint #3 ("mirror the
   live array") + Scope's "any extra path the live staging array
   carries — mirror them all". The active staging array carries
   `staging.splashcarwashes.info/admin/api/*` (the signup-worker's
   admin pricing JSON API surface — `splash-signup-next` serves the
   per-location signup viewer + pricing-mode write surface that
   apps/web's `/admin/signups/{loc}` + `/admin/pricing/{loc}` consume),
   so the apex twin mirrors it. This also matches
   CUTOVER_RUNBOOK.md Appendix Batch C's authoritative list.
3. **Stale `# routes = [...]` reference block DELETED** (not just left
   in place) per constraint #1. Kept-in-place would have created
   perpetual ambiguity for future readers about which commented routes
   are authoritative; the inert apex twins inside the active array are
   now the only commented production-route reference in this file. The
   stale block also did NOT include the `/admin/api/*` path the active
   staging array carries — so it was drifting from authoritative state
   regardless.
4. **`/signup/*`, `/q/*`, `/join/*` apex twin paths preserved exactly**
   as the staging lines per CLAUDE.md constraint #1 (load-bearing
   customer URLs). Added an explicit NOTE in the new comment block
   above the array so the brief author's intent + the load-bearing-URL
   warning are visible adjacent to the inert apex lines.
5. **Trailing comma OMITTED on the last commented apex line**
   (`/admin/api/*`). When the operator uncomments all five twins at
   the flip window, the resulting array has the `/admin/api/*` line as
   the new terminal entry — no trailing comma needed (TOML accepts but
   doesn't require it). If only some twins are uncommented (partial
   activation, not the brief's intended use), TOML still parses
   because the remaining commented lines below an uncommented twin
   carry their own trailing commas. This matches Briefs 168/169's
   trailing-comma convention on the apex-twin blocks.

**Latent issues found.** None during the staging pass. Forward flags
for the cutover window itself (out of scope but worth carrying into
Phase C execution per CUTOVER_RUNBOOK.md):

- **Pre-cutover SQL guard.** `UPDATE pricing_simple SET pricing='special', special=0.01 WHERE pricing='penny';` (CUTOVER_RUNBOOK.md Phase 0 + Phase C Appendix). Harmless today — flips zero rows — but a future hand-edit to the pricing column outside the worker-supported `'full' | 'same' | 'flash2' | 'flash5' | 'special'` enum would otherwise surface here. Operator-driven, not stageable in wrangler.toml.
- **Parity verification of `splash-signup-next` vs production.** CUTOVER_RUNBOOK.md Phase C1 lists: `/signup/{loc}` renders correct packages + pricing for several locations; `/q/{loc}` and `/join/{loc}` resolve; a full signup submit writes `maxpass_signups` correctly (terms text matches package, confirmation token persists); `/admin/api/*` pricing-list endpoint works against `splashcarwashes.info` post-cutover; `splash-signup-next` secrets bound (SUPABASE keys). Operator-driven.
- **Rollback path.** CF dashboard action to move `/signup/*`, `/q/*`, `/join/*`, `/api/submit-signup`, `/admin/api/*` back to `info-signup-worker` (fast rollback), then re-comment the apex twins + push (durable rollback). `info-signup-worker` MUST stay deployed (unrouted) until at least 30 days post-cutover per CUTOVER_RUNBOOK.md §Phase Done.
- **No apps/web change required.** apps/web's `SIGNUP_WORKER` service binding already targets `splash-signup-next`, so the apex-route flip is transparent to apps/web's SSR helpers. Brief explicitly locked this.
- **`/admin/api/*` apex carve sits alongside apps/web's `splashcarwashes.info/*` catch-all** (staged commented in Brief 168). Per CF most-specific-match-wins, `/admin/api/*` will outrank the catch-all once both are activated — the signup-worker's pricing-list endpoint continues to own that path.

**Compliance with brief's "do not" list.**
- No active apex routes added (every apex line is commented inside an
  inert position; uncomment is the operator's flip action).
- Worker name untouched (`splash-signup-next`).
- No wildcard `/api/*` — exact `/api/submit-signup` only.
- `info-signup-worker` untouched.
- No commit, no push, no deploy — working-tree changes only.

**Diff stat:**
```
 apps/signup-worker/wrangler.toml | 36 ++++++++++++++++++++++++------------
 1 file changed, 24 insertions(+), 12 deletions(-)
```
(One file, exactly the brief's target.)
