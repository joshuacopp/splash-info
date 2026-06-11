# CUTOVER_STEPS.md — §5 concrete execution plan

**Date:** 2026-06-11
**Companion to `CUTOVER_ROUTE_MAP.md`** (read that first for the *why*; this is
the *how*). Turns §5 ("lowest-risk variant — make legacy routes exact-host,
flip apps/web's admin shell, migrate signup/claims later") into ordered steps
with verification checkpoints.

---

## 0. State verified on Cloudflare today (2026-06-11)

Confirmed by reading the live Workers Routes table + build history:

**Legacy routes already converted to exact-host (the §5 conversion is DONE):**

| Apex route (live) | Host | Worker | Customer traffic? | Status |
|---|---|---|---|---|
| `splashcarwashes.info/signup/*` | **E** | info-signup-worker | **YES — only live customer flow** | ✓ exact |
| `splashcarwashes.info/claims/*` | **E** | splash-vehicle-claims | no — never in production | ✓ exact |
| `splashcarwashes.info/claims-api/*` | **E** | splash-vehicle-claims | no — never in production | ✓ exact |

Because these are now **exact-host**, they out-rank apps/web's future
`splashcarwashes.info/*` (also exact-host) on path specificity → **they survive
the catch-all.** This is the entire point of §5. The one that actually matters
is **signup** — it's the sole route with real customer traffic, and it's the one
that 404'd during the incident.

**Admin-API carves — currently LIVE on the apex as "stray" routes** (they got
bound during the Phase-A flip and the rollback build that would have removed
them FAILED — see §0.1; repo has them commented, CF has them live):

| Apex route (live) | Host | Worker |
|---|---|---|
| `splashcarwashes.info/api/login` | E | splash-dashboard |
| `splashcarwashes.info/api/logout` | E | splash-dashboard |
| `splashcarwashes.info/api/forced-reset` | E | splash-dashboard |
| `splashcarwashes.info/api/me` | E | splash-dashboard |
| `splashcarwashes.info/sysadmin/api/*` | E | splash-sysadmin |

These are exact-host → they also survive the catch-all. For the forward plan we
*want* them live, so the "stray" state is serendipitous — but repo and CF
disagree (see Step 1).

**Other legacy apex routes still present:**

| Apex route | Host | Worker | Disposition |
|---|---|---|---|
| `splashcarwashes.info/api/*` | E | info-signup-worker | retire after dashboard+signup own all `/api/*` carves |
| `*splashcarwashes.info/admin*` | **W** | info-signup-worker | LOSES to `/*` — fine, apps/web owns `/admin` |
| `*splashcarwashes.info/manage*` | **W** | splash-vehicle-claims | LOSES to `/*` — **DECISION D1** |
| `splashcarwashes.info/pertrack` | E | performance-tracker | exact → survives `/*`; leave |
| `splashcarwashes.info/pertrack/*` | E | performance-tracker | exact → survives `/*`; leave |
| `*splashcarwashes.info/fixit*` | W | fixit-proxy | retire (unused) |
| `splashcarwashes.info/dev/*` | E | signup-worker-dev | retire (old dev worker) |

**apps/web:** NO apex catch-all live (rolled back). Repo: all Phase-A apex
routes commented; `MAINTAINX_MODE = "test"`.

### 0.1 The failed rollback builds (investigated 2026-06-11)

`splash-dashboard`, `splash-sysadmin`, `splash-jotform` all show "Latest build
failed" on commit `acad097` ("rollback phase A"). Root cause confirmed from the
build logs: the deploy step (`wrangler deploy`) failed with
`Unable to authenticate request [code: 10001]` — a **transient Cloudflare API
auth blip**, not a config error. Proof: `splash-jotform`'s wrangler.toml was
never touched in the rollback, yet it failed with the identical error on the
same commit; all three built cleanly and only failed at the CF-API deploy call.

**Fix:** click **Retry build** on each (Deployments → top failed build → Retry
build), or push any new commit. No repo change needed. Which way you retry
depends on Step 1's decision.

---

## 1. Pre-flight decisions (answer these before touching anything)

**D1 — `/manage*` old claims UI: retire or preserve?**
`*splashcarwashes.info/manage*` (legacy splash-vehicle-claims, the OLD claims
admin UI) is wildcard-host → it will 404 the instant apps/web `/*` goes live.
- If no live bookmarks point at `/manage` → let it die (do nothing; the catch-all
  swallows it).
- If operators still use it → either (a) convert it to exact-host
  `splashcarwashes.info/manage*` so it survives, or (b) confirm apps/web
  `/admin/damage` is an acceptable replacement first.
- **Action:** check for live `/manage` bookmarks/usage before flip.

**D2 — When to bring damage live on the apex? (LOW-STAKES — damage was never in
production.)**
`/claims/*` + `/claims-api/*` (legacy splash-vehicle-claims) and `/manage/api/*`
(monorepo splash-damage) have **no real customer traffic** — the damage/claims
feature was never rolled out to production. So there is no live customer dataset
to protect and **no customer-safety risk** in any damage route change. The repo
`splash-damage` worker is the full rewrite (customer claim form + admin API +
PDF + MaintainX); it just isn't bound to the apex yet.
- **Defer (true §5):** flip the admin shell now; wire damage later. `/admin/damage`
  stays non-functional on the apex in the interim. Fine — nobody depends on it.
- **Include damage now (also fine, low-risk):** bind `splash-damage`'s carves
  exact-host — `/manage/api/*` for the admin API, and optionally `/claims/*` +
  `/claims-api/*` to move the customer form onto the repo worker too (then retire
  legacy splash-vehicle-claims). The earlier "parity / shared backing store"
  worry does NOT apply here because there's no live legacy dataset to diverge
  from. Verify secrets + R2 prereqs (`templates/check-request.pdf`,
  `assets/splash-logo-white.png`) and a quick smoke test on staging, then flip.

**D3 — Reconcile the stray-carve divergence (drives how you retry §0.1):**
- **Forward (recommended):** keep dashboard `/api/*` + sysadmin `/sysadmin/api/*`
  carves live, un-comment them in the repo so repo matches CF, and do NOT retry
  the old rollback build (a successful rollback would *remove* the carves you
  want). Retry of jotform is still fine — jotform has no apex routes, retrying
  just redeploys its code clean.
- **Clean slate:** retry all three rollback builds → carves removed → apex back
  to pure pre-cutover (signup/claims on legacy, nothing else) → resume the flip
  later from zero.

The steps below assume **D3 = Forward**, **D1 = check-then-likely-retire**,
**D2 = your call** (both branches noted).

---

## 2. Step-by-step (forward path)

### Step 1 — Reconcile repo ↔ CF for the admin-API carves
Repo currently has these commented but CF has them live. Make repo match the
live state so the next deploy can't silently yank them.

- `apps/dashboard-worker/wrangler.toml` — UNCOMMENT the four apex lines:
  `/api/login`, `/api/logout`, `/api/forced-reset`, `/api/me`.
- `apps/sysadmin-worker/wrangler.toml` — UNCOMMENT `/sysadmin/api/*`.
- Leave apps/web `/*` commented, `MAINTAINX_MODE = "test"`, all other apex
  routes commented.
- **Do NOT** retry the dashboard/sysadmin rollback builds (that would remove the
  carves). You may retry **jotform** (no apex routes — safe redeploy).

Commit + push. Watch each build; if any hits the transient `code: 10001`, just
Retry build.

**CHECKPOINT 1 (admin-only, zero customer impact):**
- `curl -s -o /dev/null -w "%{http_code}" https://splashcarwashes.info/api/me`
  → expect a dashboard-worker response (401/200, NOT a 404 page).
- `https://splashcarwashes.info/sysadmin/api/...` → sysadmin-worker response.
- Customer flows untouched: `…/signup/{loc}` and `…/claims/{site}` still serve.

### Step 2 — Retire the dead wildcard workers' routes (safe pre-flip)
These are unused; removing their routes now shrinks the blast radius of the
catch-all.

- `fixit-proxy` → delete route `*splashcarwashes.info/fixit*` (CF UI, or remove
  from its wrangler if it's in-repo).
- `signup-worker-dev` → delete route `splashcarwashes.info/dev/*`.

**CHECKPOINT 2:** `…/fixit` and `…/dev/...` now 404 (expected — confirm nobody
screams; these are unused).

### Step 3 — Resolve D1 (`/manage*`)
- Confirm no live `/manage` bookmarks.
- If clear → no action (catch-all will retire it in Step 5).
- If still used → convert `*splashcarwashes.info/manage*` → exact-host
  `splashcarwashes.info/manage*` on splash-vehicle-claims so it survives `/*`.

### Step 4 — (Only if D2 = "include damage now") bring the damage admin carve live
**Prerequisite: parity verified** (splash-damage vs splash-vehicle-claims share
backing store; R2 `templates/check-request.pdf` + `assets/splash-logo-white.png`
uploaded; secrets bound).
- `apps/damage-worker/wrangler.toml` — uncomment ONLY `/manage/api/*` (leave
  customer `/claims/*` + `/claims-api/*` on legacy; they're already exact-host
  there).
- Decide `MAINTAINX_MODE` ("production" only when you're ready for real WO
  routing).
- Push; verify build.

**CHECKPOINT 4:** apps/web staging `/admin/damage` parity-matches; on the apex,
`/manage/api/*` returns splash-damage responses while `/claims/{site}` still
serves legacy.

### Step 5 — Flip apps/web `/*` LAST (the actual cutover)
With every admin API carve live and exact-host, and signup/claims exact-host on
legacy, nothing live is left for `/*` to swallow except the intended losers
(`/admin*` wildcard → apps/web takes over `/admin`; `/fixit*`, `/dev/*` already
gone; `/manage*` per D1).

- `apps/web/wrangler.toml` — uncomment `splashcarwashes.info/*`.
- Commit + push; watch the build (retry on transient `10001`).

**CHECKPOINT 5 — the critical customer-safety check (do immediately):**
1. **THE one that matters:** `https://splashcarwashes.info/signup/binghamton`
   → **signup form renders** (info-signup-worker, exact-host, survived the
   catch-all). Signup is the ONLY live customer flow — this is the check that
   caught the incident last time.
2. `https://splashcarwashes.info/claims/{a-site}` → claim form renders (legacy
   vehicle-claims, exact-host). Nice to confirm, but **no customer impact** if
   it doesn't (damage was never in production).
3. `https://splashcarwashes.info/admin/dashboard` → apps/web admin shell
   (login-gated).
4. `https://splashcarwashes.info/api/me` → dashboard-worker (still works under
   the catch-all because it's a more-specific exact path).
5. `…/sysadmin/api/...`, `…/pertrack/...` → respective workers.

If **#1 (signup)** fails → **instant rollback:** delete `splashcarwashes.info/*`
from splash-web in the CF UI (proven to restore signup in seconds during the
incident), then investigate.

### Step 6 — Post-flip cleanup
- Remove any stale apps/web-shadowed routes (none today — dashboard only owns
  `/api/*`, no `/`, `/login`, `/logout` UI routes to clear).
- Confirm the dashboard/sysadmin/jotform builds are all green (retry any
  lingering `10001` failures).

### Step 7 — Retire legacy apex routes (after a cooling-off window)
Keep the legacy workers DEPLOYED (they're your rollback), just delete their apex
**routes** once you've run on apps/web for a few days with no issues:
- info-signup-worker: `*…/admin*`, `…/api/*` (after dashboard+signup own every
  `/api/*` carve)
- performance-tracker: `…/pertrack`, `…/pertrack/*` (only after splash-performance
  is wired into apps/web — `/admin/performance` is a placeholder today, so this
  can wait indefinitely)
- fixit-proxy, signup-worker-dev: already done in Step 2

### Later (decoupled, parity-gated) — migrate signup + claims to monorepo
The whole point of §5 is that this is NOT under fire. As separate, individually
verifiable steps:
- signup → splash-signup-next: parity + secrets + the `penny → special` SQL guard,
  then swap the exact-host `…/signup/*` from info-signup-worker to
  splash-signup-next.
- claims → splash-damage: parity + R2 prereqs, then swap the exact-host
  `…/claims/*` + `…/claims-api/*` from splash-vehicle-claims to splash-damage.

---

## 3. One-line rollback (keep this visible during any flip)
**Delete `splashcarwashes.info/*` from splash-web in the Cloudflare UI.** That
single action drops the catch-all and the apex instantly reverts to the
exact-host legacy/carve routes. Verified live during the 2026-06-11 incident —
signup recovered within seconds.

---

## 4. Open items still owed (from CUTOVER_ROUTE_MAP §7)
- [ ] D1: confirm no live `/manage` bookmarks.
- [ ] D2: damage parity (splash-damage vs splash-vehicle-claims backing store)
      — gates whether `/admin/damage` works on apex day one.
- [ ] Retry/clear the failed dashboard/sysadmin/jotform builds per Step 1's
      decision.
- [ ] Parity-verify signup (splash-signup-next) before the deferred signup
      migration.
