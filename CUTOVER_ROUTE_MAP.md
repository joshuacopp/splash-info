# CUTOVER_ROUTE_MAP.md — authoritative production route map + corrected cutover

**Date:** 2026-06-11
**Supersedes the routing assumptions in `CUTOVER_READINESS.md` and
`CUTOVER_RUNBOOK.md`**, which were wrong on two counts: (1) they treated
`info-signup-worker` as a signup-only `/signup/*` carve, and (2) they assumed
the legacy signup route would survive apps/web's catch-all. Both false — see §0.
Read this first; treat the readiness/runbook as historical context only.

---

## 0. Why this exists (the 2026-06-11 incident)

Phase A was flipped (apps/web `splashcarwashes.info/*` catch-all + dashboard /
sysadmin / damage / performance carves + `MAINTAINX_MODE=production`). **Customer
signup (`splashcarwashes.info/signup/{loc}`) immediately 404'd** — served by
apps/web (which has no signup route). Rolled back by deleting apps/web's `/*`
in the CF UI, re-commenting the apex routes in the repo, and pushing.

**Root cause — Cloudflare route specificity:** an **exact-hostname** route
out-ranks a **wildcard-hostname** (`*host`) route, *regardless of path*. The
legacy signup route is `*splashcarwashes.info/signup/*` (wildcard host) on
`info-signup-worker`. apps/web's `splashcarwashes.info/*` (exact host) out-ranked
it and swallowed `/signup/*`. The runbook assumed a more-specific path always
wins; it does not when the more-specific route has a wildcard hostname.

Second discovery: **the apex is served by FIVE legacy workers, not one.**

---

## 1. Cloudflare route-matching rule (the lever this whole thing turns on)

CF picks the most specific matching route, evaluated in this order:

1. **Exact hostname beats wildcard hostname** (`*host/...`) — FIRST, before path
   is even considered.
2. Among routes of equal host-specificity, the **longer / more-specific path**
   wins (`/signup/*` beats `/*`).

Consequences:
- A NEW **exact-host** route out-ranks any LEGACY **wildcard-host** route on the
  same path. (This is the tool we use to flip cleanly.)
- An exact-host `/*` catch-all out-ranks EVERY wildcard-host route → it swallows
  them. (This is the trap that broke signup.)
- Two exact-host routes → the more-specific path wins (so dashboard's exact
  `/api/login` correctly beats info-signup's exact `/api/*`).

---

## 2. Complete production apex route table (live today)

Ignoring all `staging.splashcarwashes.info/*` rows (those are the monorepo on
staging, not production). Host-type: **E** = exact host, **W** = wildcard host.

| Apex route | Worker (legacy) | Host | Replaced by | Disposition |
|---|---|---|---|---|
| `*splashcarwashes.info/admin*` | info-signup-worker | W | apps/web | retire route after apps/web owns `/admin` |
| `splashcarwashes.info/api/*` | info-signup-worker | E | dashboard (`/api/login\|logout\|forced-reset\|me`) + signup (`/api/submit-signup`) | retire after both carves live |
| `*splashcarwashes.info/signup/*` | info-signup-worker | **W** | splash-signup-next `/signup/*` | **CUSTOMER — broke under catch-all** |
| `*splashcarwashes.info/claims/*` | splash-vehicle-claims | **W** | splash-damage `/claims/*` | claims — NEVER in production (no live traffic) |
| `*splashcarwashes.info/claims-api/*` | splash-vehicle-claims | W | splash-damage `/claims-api/*` | claims photo/serve — never in production |
| `*splashcarwashes.info/manage*` | splash-vehicle-claims | W | splash-damage `/manage/api/*` + apps/web `/admin/damage` | verify no live `/manage` bookmarks |
| `splashcarwashes.info/pertrack` | performance-tracker | E | splash-performance | low stakes |
| `splashcarwashes.info/pertrack/*` | performance-tracker | E | splash-performance `/pertrack/*` | unique-route → MOVES on bind |
| `*splashcarwashes.info/fixit*` | fixit-proxy | W | — | **RETIRE** (old troubleshooting, unused) |
| `splashcarwashes.info/dev/*` | signup-worker-dev | E | — | **RETIRE** (old dev worker) |

**Legacy worker identities (operator-confirmed 2026-06-11):**
- `info-signup-worker` — the **old monolith**; split into apps/web (admin) +
  splash-dashboard (auth API) + splash-signup-next (signup).
- `splash-vehicle-claims` — **predecessor to the monorepo `splash-damage`**.
- `performance-tracker` — predecessor to `splash-performance`.
- `fixit-proxy` — old troubleshooting worker, **not in use** → retire.
- `signup-worker-dev` — old dev worker → retire.

**Current "dirty" leftovers from the failed Phase-A rollback** (these are
monorepo workers that got apex routes during the flip and whose rollback build
FAILED, so the routes persist — harmless but should be cleaned):
- `splash-dashboard` → `splashcarwashes.info/api/{login,logout,forced-reset,me}`
- `splash-sysadmin` → `splashcarwashes.info/sysadmin/api/*`

---

## 3. What breaks the instant apps/web's `/*` catch-all goes live

**Wildcard-host legacy routes — LOSE to apps/web `/*`, will 404 unless their
monorepo carve is live in the same flip:**
- `/signup/*` — **CUSTOMER (only live customer flow)** (info-signup-worker)
- `/claims/*` — claims, never in production / no live traffic (splash-vehicle-claims)
- `/claims-api/*` — claims, never in production (splash-vehicle-claims)
- `/admin*` (info-signup) — OK to lose; apps/web *should* own `/admin`
- `/manage*` (splash-vehicle-claims) — old UI; verify no bookmarks
- `/fixit*` — retiring anyway

**Exact-host legacy routes — survive the catch-all on their own** (more specific
than `/*`); the monorepo carve simply MOVES them when bound:
- `/api/*` (info-signup), `/pertrack*` (performance-tracker), `/dev/*` (retire)

**HARD CONSTRAINT:** **`/signup/*`** must keep an exact-host owner live **before
or with** apps/web's catch-all — it's the only route with real customer traffic.
(`/claims/*` is also wildcard→would-lose, but damage was NEVER in production, so
losing it carries no customer impact; protect it as hygiene, not as a gate.)
NOTE (2026-06-11): `/signup/*` + `/claims/*` + `/claims-api/*` are now already
exact-host on the LEGACY workers (operator converted them), so they survive the
catch-all without any monorepo migration — see CUTOVER_STEPS.md.

---

## 4. Corrected cutover — "carves first, catch-all last"

**Principle:** bind every monorepo worker's **exact-host** carve first; each
out-ranks the legacy wildcard-host route on its path, so the swap is clean and
individually verifiable. Bind apps/web's `/*` **last**, when nothing live is
left for it to swallow. Retire legacy routes afterward.

**Step 1 — carves (exact-host; verify each on the apex before moving on):**
- dashboard: `/api/login`, `/api/logout`, `/api/forced-reset`, `/api/me`
- sysadmin: `/sysadmin/api/*`
- damage: `/claims/*`, `/claims-api/*`, `/manage/api/*` — LOW-STAKES (damage was
  never in production; no live customer dataset). Verify R2 prereqs
  (`templates/check-request.pdf`) + `MAINTAINX_MODE` as hygiene, but no
  customer-safety gate and no real parity concern.
- performance: `/pertrack/*` (unique-route move off `performance-tracker`)
- signup: `/signup/*`, `/q/*`, `/join/*`, `/api/submit-signup`, `/admin/api/*`
  — **MOVES live customer signup off `info-signup-worker` → verify parity +
  secrets + run the `penny → special` SQL guard first**
- (Batch-B admin tooling — workorders / forms / jotform / promo — exact-host
  carves; do with Step 1 or after. jotform webhook + forms public render are
  the only semi-live ones.)

**Step 2 — catch-all LAST:**
- apps/web: `splashcarwashes.info/*`
- Remove any stale `splash-dashboard` `/`, `/login`, `/logout` UI routes.

**Step 3 — retire legacy (after a cooling-off; keep them deployed as rollback):**
- Delete the apex routes on `info-signup-worker`, `splash-vehicle-claims`,
  `performance-tracker`, `fixit-proxy`, `signup-worker-dev`.

**The real customer-risk surface is signup ONLY.** Signup is the only apex route
with real customer traffic. **Damage/claims was never in production** — moving it
to the monorepo (or letting legacy claims get swallowed) carries no live-customer
risk and no real parity concern. So the runbook's "signup only" framing was
correct; this map's earlier "damage + signup" claim was wrong. Verify secrets +
R2 prereqs before the damage carve as good hygiene, but it is NOT a customer-
safety gate the way signup is.

---

## 5. Lowest-risk variant (recommended if you don't want to migrate under fire)

The apps/web cutover does NOT require migrating signup/claims to the monorepo.
Instead, make the LEGACY routes **exact-host** so they survive the catch-all:

- On `info-signup-worker`: change `*splashcarwashes.info/signup/*` →
  `splashcarwashes.info/signup/*` (exact host).
- On `splash-vehicle-claims`: change `*splashcarwashes.info/claims/*` →
  `splashcarwashes.info/claims/*` and `*.../claims-api/*` → exact-host.

Now an exact-host `/signup/*` / `/claims/*` out-ranks apps/web's `/*`, so signup
and claims keep working **on the proven legacy workers** even after the catch-all
is live. Then flip apps/web + the admin carves (dashboard/sysadmin/performance),
and migrate signup → splash-signup-next and claims → splash-damage **later**, as
their own parity-verified steps. Trade-off: more total steps, but it decouples
the two risky customer-traffic migrations from the admin-shell cutover.

---

## 6. Immediate cleanup (state as of 2026-06-11)

- `splash-dashboard` + `splash-sysadmin` still carry Phase-A apex routes because
  the **rollback build FAILED** on `splash-dashboard`, `splash-sysadmin`, and
  `splash-jotform`. Harmless (no catch-all live), but: **investigate why those
  three builds failed**, then re-push the rollback (or delete the stray apex
  routes in the CF UI) to fully clean up.
- Production is otherwise back to pre-cutover: signup on `info-signup-worker`,
  claims on `splash-vehicle-claims`, no apex catch-all. Both customer flows work.

---

## 7. Open items

- [ ] Fix the failed rollback builds (dashboard / sysadmin / jotform); confirm
      the two stray apex carves clear.
- [ ] Decide Step-4 approach: full migration (§4) vs legacy-route exact-host fix
      (§5, recommended).
- [ ] Parity-verify `splash-damage` vs `splash-vehicle-claims` and
      `splash-signup-next` vs `info-signup-worker` before their carves move live.
- [ ] Confirm no live bookmarks to `/manage` (old claims UI) before retiring it.
- [ ] Retire `fixit-proxy` + `signup-worker-dev` routes (unused).
