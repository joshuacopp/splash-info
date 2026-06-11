# CUTOVER_RUNBOOK.md — production cutover procedure

**Date:** 2026-06-08
**Reads with:** `CUTOVER_READINESS.md` (per-worker secret tables + the routing
model + couplings). This file is the ordered procedure.

## Locked decisions (operator-confirmed 2026-06-08)

1. **Keep the worker name `splash-signup-next`** — bind production routes to
   it; do NOT rename. apps/web's `SIGNUP_WORKER` service binding already
   points at `splash-signup-next`, so **no apps/web binding change**.
2. **Batch A** (apps/web + dashboard + sysadmin + damage + performance) flips
   **together in a low-traffic window**.
3. **`/claims/*` flips in Batch A** — not in production yet, no live claim
   traffic, so no need to defer it.
4. **Retire `broad-shape-38b8`** — fleet flips in Batch B (overrides the
   "don't touch broad-shape-38b8" posture in CLAUDE.md constraint #9; that
   constraint is explicitly operator-overridden for this cutover).

## Mechanics / ground rules

- **Deploy = git push.** CF Workers Builds deploys each worker on push. CLI-set
  secrets persist across Builds deploys; **do not** set secrets via the CF UI
  (constraint #4) or a later push can wipe them.
- **Current state: live on staging.** Each worker serves
  `staging.splashcarwashes.info/*` via its *active* `routes` array;
  `workers_dev` is a fallback URL. The apex `splashcarwashes.info` patterns are
  commented reference. **Cutover = merge the apex patterns INTO each active
  `routes` array** (keep the staging lines so staging keeps working). TOML
  allows only one `routes` key — do NOT add a second block.
- **Routes are unique per zone.** Binding an apex route to a monorepo worker
  removes it from whatever owned it before — that IS the flip.
- **Per-batch pushes.** The route-merge edits are committed/pushed **one batch
  at a time**, so each phase deploys independently. Don't push all routes in
  one commit.
- **No headless deploys from Claude.** Claude Code only stages the diffs; the
  operator reviews, commits, pushes.

---

## Phase 0 — Pre-flight (do before Batch A; no traffic impact)

**Secrets verification (all batches).** For each worker, confirm every secret
in its `CUTOVER_READINESS.md` §3 row is bound on the production worker:
```
pnpm --filter @splash/<worker> exec wrangler secret list
```
Anything missing → `wrangler secret put NAME` (CLI, not UI).

**Other pre-flight items:**
- [ ] **dashboard route fix:** the production `routes` block must include
      `/api/me` (currently omitted — Header identity row depends on it). The
      route-diff brief adds it.
- [ ] **Stale dashboard UI bindings:** in the CF dashboard, note the existing
      `/`, `/login`, `/logout` routes on `splash-dashboard` — these get
      **removed** during Batch A so apps/web's catch-all serves them.
- [ ] **apps/web build env:** confirm `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is
      set on the production CF Workers Builds config. **Do not rotate it**
      (constraint #7).
- [ ] **damage R2 prereqs:** `templates/check-request.pdf` present in
      `damagedocs` (PDF gen fails without it). `assets/splash-logo-white.png`
      optional (HTTPS fallback). *(Today's wipe left `templates/` intact;
      `assets/` was empty → logo uses the HTTPS fallback unless uploaded.)*
- [ ] **MAINTAINX_MODE decision:** Batch A will flip damage's
      `MAINTAINX_MODE` `"test"→"production"` so work orders route to real
      assignees (Brett/Scott). Confirm you want that live with the cutover.
- [ ] **Pre-cutover SQL guard** (run once before Batch C, harmless today):
      ```sql
      UPDATE pricing_simple SET pricing='special', special=0.01 WHERE pricing='penny';
      ```

---

## Phase A — apps/web + dashboard + sysadmin + damage + performance

Pick a low-traffic window (brief login inconsistency while routes settle).

**A1. Mirror each worker's active staging routes to apex twins** (keep the
staging lines; the live staging `routes` array is the authoritative path
source — for every `staging.splashcarwashes.info/<path>` add a
`splashcarwashes.info/<path>` to the same array). One batch commit covering
these five. Apex path sets (verify against each live staging array):
- `apps/web/wrangler.toml` → catch-all `splashcarwashes.info/*`.
- `apps/dashboard-worker/wrangler.toml` → `/api/login`, `/api/logout`,
  `/api/forced-reset`, **`/api/me`**.
- `apps/sysadmin-worker/wrangler.toml` → `/sysadmin/api/*`.
- `apps/damage-worker/wrangler.toml` → `/claims-api/*`, `/claims/*`,
  `/manage/api/*`; also flip `MAINTAINX_MODE = "production"`.
- `apps/performance-worker/wrangler.toml` → `/pertrack/*`.

**A2. Remove stale dashboard UI routes.** In the CF dashboard, delete the
`/`, `/login`, `/logout` route bindings on `splash-dashboard`.

**A3. Smoke test on `https://splashcarwashes.info`:**
- [ ] `/login` renders (apps/web), sign in succeeds, cookie sticks, redirect
      to `/admin/dashboard`. Header shows email/role (`/api/me` working).
- [ ] `/admin/sysadmin` loads + a read works (audit log panel).
- [ ] `/admin/damage` list loads; open a claim detail.
- [ ] `/claims/{a-real-location-slug}` renders the public claim form.
- [ ] Logout clears session.
- [ ] CF Logs clean; no 522/404 on the carved paths.

**A-rollback:** re-comment the five route blocks + restore the dashboard UI
routes; push. (Fast path: re-add the routes to the legacy owners via CF UI.)

> Note: pricing admin screens (`/admin/pricing/*`) will load but their
> browser-side data calls to `/admin/api/*` 404 until Batch C (signup). Expected.

---

## Phase B — workorders + forms + jotform + promo + fleet

After Batch A is green. These have no live traffic; flip individually or as
one commit.

**B1. Mirror each worker's active staging routes to apex twins (keep staging):**
- `workorders` → `/workorders/api/*`
- `forms` → `/forms/*`
- `jotform` → `/jotform/*`, `/admin/jotform/api/*`
- `promo` → `/promo/*`  (confirm `APPS_WEB_BASE_URL` = `https://splashcarwashes.info`)
- `fleet` → add the production subdomain route `fleet.splashcarwashes.info/*`
  bound to `splash-fleet-inquiry`, and **remove it from `broad-shape-38b8`**
  (CF dashboard). This is the retirement.

**B2. External reconfig:**
- [ ] **JotForm webhooks:** re-point each onboarded form's webhook to
      `https://splashcarwashes.info/jotform/{JOTFORM_WEBHOOK_TOKEN}` or ingest
      stops.
- [ ] **PA email-queue drain flow:** confirm the claim/confirm calls target
      `https://splashcarwashes.info/forms/internal/api/email-queue/*` (the
      forms host moved). This is the flow that delivers promo announcements +
      forms emails — verify it still drains after the forms flip.
- [ ] **fleet Google Maps key:** consider a key restricted to
      `splash-fleet-inquiry` (PRE_DEPLOY_FLEET §3) — it bills per geocode call.

**B3. Smoke test on apex:**
- [ ] `/workorders` loads, tabs render (worker `/workorders/api/list`).
- [ ] `/forms` index loads; open a published `/forms/{slug}` (worker render);
      submit a test internal form; confirm a row lands + the email queues +
      PA delivers.
- [ ] `/admin/jotform` loads; trigger a test JotForm submission → webhook
      ingests → row appears.
- [ ] `/admin/promotions` loads; send a test announcement → inbox renders with
      inline image (the Graph send flow from earlier) + attachment opens.
- [ ] `fleet.splashcarwashes.info` serves the monorepo form; submit a test
      inquiry → row in `fleet_submissions`; `/admin/fleet` shows it.

**B-rollback:** re-comment the worker's route block + push; for fleet, re-point
`fleet.splashcarwashes.info` back to `broad-shape-38b8` in the CF UI.

---

## Phase C — signup-worker (last; the only live-traffic flip)

`info-signup-worker` serves `/signup/*` `/q/*` `/join/*` `/api/submit-signup`
in production **right now**. These URLs are load-bearing (customer/admin
bookmarks). Direct flip — verify parity first, flip, watch.

**C1. Parity verification (before touching routes):** exercise the monorepo
`splash-signup-next` on workers.dev/staging against real behavior:
- [ ] `/signup/{loc}` renders correct packages + pricing for several
      locations (incl. a BOGO location and each pricing mode).
- [ ] A full signup submit writes `maxpass_signups` correctly (terms text,
      BOGO dates, confirmation token) and fires the PA confirmation email.
- [ ] Fraud-detection paths behave (suspicious_phones, phone_usage_log).
- [ ] `/q/{loc}` and `/join/{loc}` resolve.
- [ ] `SIGNATURE_MODE = "inline"` (Family-Plan JotForm IDs stay dormant).
- [ ] Confirm `splash-signup-next` secrets bound (SUPABASE keys).

**C2. Run the pre-cutover SQL guard** (Phase 0 list).

**C3. Flip.** In `apps/signup-worker/wrangler.toml`, add an apex twin of every
active staging route (CF shows ~6 routes on `splash-signup-next` — mirror them
all): `/signup/*`, `/q/*`, `/join/*`, `/api/submit-signup`, `/admin/api/*`
(+ any extra the live staging array carries). Keep staging. Push → CF Builds
binds the apex routes to `splash-signup-next`, removing them from
`info-signup-worker`. **No rename, no apps/web change** (binding already
targets `-next`).

**C4. Smoke test immediately on apex:**
- [ ] `/signup/{loc}` renders for several real locations (bookmarked URLs).
- [ ] One real submit end-to-end → `maxpass_signups` row + confirmation email.
- [ ] `/q/{loc}`, `/join/{loc}` work.
- [ ] **Pricing admin now fully works:** `/admin/pricing/*` data loads
      (`/admin/api/*` is now bound), set-mode + bulk work.
- [ ] CF Logs clean.

**C-rollback (fast):** in the CF dashboard, move `/signup/*` `/q/*` `/join/*`
`/api/submit-signup` back to `info-signup-worker`. (Durable: re-comment the
route block + push.) Keep `info-signup-worker` deployed and untouched until
you've watched production for a few days.

---

## Post-cutover

- [ ] Leave `info-signup-worker` and `broad-shape-38b8` deployed (unrouted) as
      rollback insurance for a cooling-off period; retire later.
- [ ] Confirm crons fire on the production workers (forms 11:00/12:00, damage
      13:00, workorders 11:30 UTC) — check Logs the next day.
- [ ] `legacy/` source cleanup stays deferred until you're confident.
- [ ] Update `BUILD_STATE.md` "Known production state" to reflect the flipped
      routes.

## Open confirmations before executing

- MAINTAINX_MODE → production: OK to page real assignees at Batch A?
- Any PA flow besides the email-queue drain that calls a worker **by URL**
  (vs. worker→PA webhooks, which are fine) and needs the apex host?

---

## Appendix — exact apex routes per worker (the mirror)

**Key finding (de-risks the whole thing):** the "+1 other route" you saw on
every worker in the CF dashboard is just the automatic `*.workers.dev` URL
(`workers_dev = true`), NOT a hidden UI-added route. `splash-web` is the only
worker without it (it has no `workers_dev`), which is why it showed no "+1".
**So there is no route drift — each worker's custom routes = its
`wrangler.toml` `routes` array, exactly.** The sets below are complete and
authoritative (derived from the live `routes` arrays in the repo).

**Mechanic:** ADD these apex lines into each worker's existing active `routes`
array; keep the `staging.` lines. Full example for `splash-sysadmin`:

```toml
routes = [
  { pattern = "staging.splashcarwashes.info/sysadmin/api/*", zone_name = "splashcarwashes.info" },
  { pattern = "splashcarwashes.info/sysadmin/api/*",         zone_name = "splashcarwashes.info" }
]
```

Apex patterns to add, per worker (`zone_name = "splashcarwashes.info"` on every
line):

**Batch A**
- `splash-web` — `splashcarwashes.info/*`  *(catch-all; no workers.dev today)*
- `splash-dashboard` — `/api/login`, `/api/logout`, `/api/forced-reset`, `/api/me`
- `splash-sysadmin` — `/sysadmin/api/*`
- `splash-damage` — `/manage/api/*`, `/claims-api/*`, `/claims/*`
- `splash-performance` — `/pertrack/*`

**Batch B**
- `splash-workorders` — `/workorders/api/*`
- `splash-forms` — `/forms/*`
- `splash-jotform` — `/jotform/*`, `/admin/jotform/api/*`
- `splash-promo` — `/promo/*`
- `splash-fleet-inquiry` — `fleet.splashcarwashes.info/*`  *(subdomain, not a path carve; remove this route from `broad-shape-38b8` in the CF UI)*

**Batch C**
- `splash-signup-next` — `/signup/*`, `/q/*`, `/join/*`, `/api/submit-signup`, `/admin/api/*`  *(these come off `info-signup-worker` when bound here)*

That's the entire surface — 11 workers, every custom route accounted for. The
only non-wrangler action is fleet (remove its apex route from
`broad-shape-38b8`) and signup (the routes move off `info-signup-worker`
automatically when CF Builds binds them to `splash-signup-next`).

---

## Appendix — ROLLBACK CARD (keep this open in a tab during cutover)

All rollback is done in **CF dashboard → Workers & Pages → [worker] →
Settings → Domains & Routes** (no rebuild needed unless noted). Routes are
unique per zone, so the rule of thumb is:

- **Workers with NO legacy counterpart (the 8 non-prod):** to undo, **delete
  the apex route** from the worker. The path reverts to "not on production"
  (staging keeps working). For API paths that leaves them unrouted → apps/web
  catch-all 404s them, which is the correct "rolled back" state.
- **Workers WITH a live legacy counterpart (signup, fleet):** do NOT just
  delete the apex route — **reclaim it to the legacy worker** (add the route
  back on the legacy worker; CF moves it off the monorepo worker
  automatically). This restores live traffic instantly.

| Worker | If you need to roll back… | CF-UI action | Result |
|---|---|---|---|
| splash-web | apps/web broken on apex | Delete `splashcarwashes.info/*` from `splash-web` | Site off apex; staging unaffected |
| splash-dashboard | login/cookies broken | Delete the 4 `/api/*` apex routes from `splash-dashboard` | Auth off apex (roll back WITH web) |
| splash-sysadmin | `/admin/sysadmin` data 404 | Delete `/sysadmin/api/*` apex route | Reverts to staging-only |
| splash-damage | `/admin/damage` or `/claims/*` broken | Delete `/manage/api/*`, `/claims-api/*`, `/claims/*` apex routes; flip `MAINTAINX_MODE` back to `"test"` + push if WOs misfired | Damage off apex |
| splash-performance | `/pertrack/*` broken | Delete `/pertrack/*` apex route | Off apex |
| splash-workorders | `/workorders` data broken | Delete `/workorders/api/*` apex route | Off apex |
| splash-forms | forms/email-queue broken | Delete `/forms/*` apex route; point the PA email-queue flow back at the staging host | Off apex |
| splash-jotform | ingest/admin broken | Delete `/jotform/*` + `/admin/jotform/api/*` apex routes; re-point JotForm webhooks to staging | Off apex |
| splash-promo | `/admin/promotions` data broken | Delete `/promo/*` apex route | Off apex |
| splash-fleet-inquiry | fleet form broken | **Reclaim** `fleet.splashcarwashes.info/*` to `broad-shape-38b8` | Legacy fleet restored instantly |
| splash-signup-next | **customer signup broken** | **Reclaim** `/signup/*`, `/q/*`, `/join/*`, `/api/submit-signup`, `/admin/api/*` to `info-signup-worker` | Live signup restored instantly |

**Golden rule:** keep `info-signup-worker` and `broad-shape-38b8` **deployed
and untouched** through the whole cutover + a cooling-off period. They are the
rollback. Don't delete them until you've watched production for several days.
