# Brief 51: Write `PRE_DEPLOY_WEB.md` runbook for apps/web

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Nothing.
**Dependencies:** None — pure documentation. Best run after Brief 50
so the doc reflects the post-50 state of apps/web's responsibilities,
but not strictly required.

## Read first

- CLAUDE.md (the entire file — most apps/web gotchas are documented
  there and need to land in the runbook)
- BUILD_STATE.md ("Open work" item 15; deployed-components table;
  decisions log)
- BRIEFS/INDEX.md
- PRE_DEPLOY_DAMAGE.md (reference structure for the per-worker
  pre-deploy docs; this brief's output should match the same
  section ordering for consistency)
- PRE_DEPLOY_DASHBOARD.md (same reference)
- PRE_DEPLOY_PERFORMANCE.md (same reference)
- PRE_DEPLOY_SIGNUP.md (same reference)
- PRE_DEPLOY_SYSADMIN.md (same reference)
- apps/web/wrangler.toml (the `[[services]]` bindings + commented
  `[[routes]]` block + `[vars]` if any)
- apps/web/next.config.mjs (the dev rewrite map + the
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY note)
- apps/web/.env.example (build-time env var documentation;
  Brief 31's encryption key rationale lives there)

## Context

apps/web has no dedicated pre-deploy doc. The five workers each
have one (`PRE_DEPLOY_<NAME>.md`) that walks the operator
through pre-flight checks, smoke tests, rollback steps, and
known gotchas specific to that deployable. Item 15 in
BUILD_STATE.md is the gap.

Over 50 briefs, apps/web has accumulated a long list of
deploy-time considerations — service bindings, build-time
encryption key, watch paths, server-action ID stability, the
ActionForm pattern, OpenNext-on-CF runtime quirks, CF edge
propagation lag, etc. A future operator deploying apps/web
without this knowledge will rediscover these the hard way.

The runbook doesn't change behavior; it documents what exists.
But because so much accumulated knowledge feeds into "what to
check before pushing apps/web," the doc itself ends up being
substantive.

## Scope

### Phase 1 — Create `PRE_DEPLOY_WEB.md` at repo root

1.1 Create the file alongside the five existing per-worker
`PRE_DEPLOY_*.md` files. Match their tone, structure, and
section ordering. The doc should have these top-level sections,
in this order:

#### 1. Overview
- One paragraph: apps/web is the Next.js admin UI deployed via
  OpenNext-on-Cloudflare-Workers. Customer-facing pages are
  owned by their respective workers (Brief 50 + Brief 23
  decisions). apps/web hosts admin pages only:
  `/login`, `/change-password`, `/admin/dashboard`,
  `/admin/pricing/*`, `/admin/sysadmin`, `/admin/damage`,
  `/admin/performance`, plus `/` (redirect) and `/logout`.

#### 2. Deploy mechanism
- CF Workers Builds connected to GitHub repo
  (joshuacopp/splash-info). Pushes to `main` trigger an
  automatic deploy. Watch paths are `apps/web/**` and
  `packages/**`; either change firing triggers a rebuild.
- No manual `wrangler deploy` step. Operator pushes; CF builds.
- Build command: `pnpm install` (then opennext build runs
  implicitly via the deploy command).
- Deploy command: see CF dashboard → splash-web → Settings →
  Build. Document the exact string so a reader doesn't have to
  click through to CF.
- Branch control: Production branch = `main`. Non-production
  branches build deploy previews (per CF defaults).

#### 3. Build-time configuration

##### 3.1 NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
The full Brief 31 story. Key points to land in the doc:
- Set as a CF Workers Builds **build-time env var**, NOT a
  runtime secret. CF dashboard → splash-web → Settings →
  Build → Environment variables.
- Without it, Next regenerates a fresh encryption key every
  build, which invalidates every server-action ID on every
  open browser tab. Mid-session form submits get
  UnrecognizedActionError white-pages.
- **Do not rotate without coordination.** Rotation only safe
  during a maintenance window when no operator is mid-session.
- Defense-in-depth: `apps/web/app/admin/error.tsx` catches
  UnrecognizedActionError specifically and renders a "Reload"
  CTA instead of a generic crash.
- See `apps/web/.env.example` for the documented value
  rationale and how to generate a new one if ever needed.

##### 3.2 Other build-time vars (none required, document anyway)
- `NEXT_PUBLIC_*_WORKER_URL` env vars — used in dev only via
  `apps/web/next.config.mjs` rewrites. In production these are
  unset and the rewrites collapse. Don't set them in CF Workers
  Builds.

#### 4. Runtime configuration (service bindings)

##### 4.1 The five [[services]] entries in apps/web/wrangler.toml
- DASHBOARD_WORKER → `splash-dashboard`
- SIGNUP_WORKER → `splash-signup-next` (renames to
  `splash-signup` at cutover)
- PERFORMANCE_WORKER → `splash-performance`
- SYSADMIN_WORKER → `splash-sysadmin`
- DAMAGE_WORKER → `splash-damage`

##### 4.2 Why service bindings, not URL fetches
Brief 17 context: CF same-zone Worker-to-Worker URL fetches
loop through the edge inefficiently and 522 after ~19s. Service
bindings route the subrequest internally. apps/web's helpers
(`_lib/worker-fetch.ts` files in damage/sysadmin/etc. trees)
try the binding first via `getCloudflareContext({ async: true })`
and fall back to URL-based fetch only when `next dev` is running
outside the Workers runtime.

##### 4.3 Verifying service bindings post-deploy
- CF dashboard → splash-web → Settings → Bindings. All five
  should be listed and resolvable.
- `wrangler.toml` is the source of truth for binding names —
  don't rename without checking every consumer
  (`packages/auth`, `packages/db-supabase`, all `_lib/worker-fetch.ts`).

##### 4.4 Sister-worker dependency
apps/web's `/admin/*` routes call into all 5 workers via
service binding. If a sister worker is down or returning 5xx,
the corresponding admin page surfaces the error inline (per
Brief 19's ActionForm pattern). The admin page does not crash;
the user sees an error message and a Try Again CTA.

#### 5. Pre-deploy checklist

The reader runs through this checklist before any push that
might affect apps/web:

- [ ] CF Workers Builds connected to GitHub (verify in dashboard
      → splash-web → Settings → Build → Git repository)
- [ ] Watch paths are `apps/web/**` and `packages/**` (verify
      in dashboard; mismatched watch paths silently skip
      deploys — see Brief 39's accidentally-stuck deploy)
- [ ] `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is set under
      Environment variables (otherwise prod-tab form submits
      go white-page)
- [ ] All 5 `[[services]]` entries in `apps/web/wrangler.toml`
      are present and reference the correct worker names
- [ ] Sister workers all healthy on workers.dev (a service
      binding can't outlive its target worker)
- [ ] `pnpm typecheck` passes locally on the branch being
      pushed
- [ ] `pnpm --filter @splash/web build` succeeds locally
- [ ] If touching `packages/**`, double-check that no .js
      extension on imports/re-exports inside `packages/ui`
      sneaks back in — Brief 1 fixed 9 of these and Next.js
      webpack still chokes on them

#### 6. Smoke tests post-deploy

Run these on staging.splashcarwashes.info after CF Builds
reports success and the 1-3 minute edge propagation completes
(see Known gotchas below for why the wait):

- [ ] Hit `/` while signed out → 307 to `/login`
- [ ] Sign in via `/login` (post or SSO depending on flow) →
      lands on `/admin/dashboard`
- [ ] `/admin/dashboard` renders all card grid items
- [ ] `/admin/pricing/binghamton` (or any active location)
      renders the pricing editor; no console errors
- [ ] `/admin/sysadmin?mode=users` — Set Role and Create User
      cards render; LocationCodePicker (Brief 39/40) populates
      when typing a 3-digit site number or location name
- [ ] `/admin/sysadmin?mode=tables` — audit log loads (Brief 30
      + 34); no 500s in console
- [ ] `/admin/damage` — list of claims renders
- [ ] `/admin/damage/[any-recent-claim-id]` — detail page renders;
      transition buttons present; if a claim has
      `equipment_related = 0` and is in a status that allows
      Approve transitions, the EquipmentOverrideModal (Brief 43
      + 45) opens via the portal pattern when clicking the
      approve buttons
- [ ] `/logout` clears the cookie and redirects to `/login`

#### 7. Known gotchas

##### 7.1 CF edge propagation lag (1-3 minutes)
After CF Builds reports a deploy as complete, edge POPs may
serve stale or partial bundles for 1-3 minutes. Symptoms:
transient 403/404/522 on freshly-deployed routes that work
fine moments later. Don't deep-dive on Access/WAF/route
bindings during this window — wait, retry, then investigate.
Brief 49-era diagnostic memory.

##### 7.2 Server-action redirect-vs-router.refresh
Server actions called from server-rendered `<form action={fn}>`
must NOT use `redirect()` for success or error feedback. The
runtime quirk: Next 15 server actions on
OpenNext-on-CF-Workers don't reliably propagate `redirect()`
to a visible client navigation. Brief 19's pattern is the
contract — use `<ActionForm>` from
`apps/web/app/admin/_components/ActionForm.tsx`, return a
serializable `ActionResult`, and let the client wrapper drive
post-action UX with `useActionState` + `router.refresh()`.

##### 7.3 Modal-inside-form nesting
React component that renders a `<form>` inside a parent
`<form>` produces invalid HTML and non-deterministic browser
behavior (Brief 45 cause + fix). New modal components that
render anywhere under an `/admin/*` route must use
`createPortal` to `document.body` to escape the parent form's
DOM. Reference: `EquipmentOverrideModal.tsx`.

##### 7.4 Cookie-based middleware
`apps/web/middleware.ts` (Brief 1) is the single source of
auth truth for `/admin/*` and `/sysadmin/*`. Cookies are
namespaced under `sb-access-token` / `sb-refresh-token`. The
constants live in `packages/auth` but **must not be imported
from middleware.ts** — Edge runtime can't load that package.
Re-declare as literal strings if needed.

##### 7.5 Cross-origin dev limitation
Cookies set by `splash-dashboard.<account>.workers.dev` won't
reach `splash-web.<account>.workers.dev` under SameSite=Lax.
Login fully works only after cutover when both share
`splashcarwashes.info`, OR via local dev with a same-origin
proxy (the `next.config.mjs` rewrite map covers this when
NEXT_PUBLIC_*_WORKER_URL env vars are set in `.env.local`).

##### 7.6 Customer-facing routes are NOT apps/web's job
Per Brief 50 (and Brief 23 before it): `/signup/{location}`,
`/q/{location}`, `/join/{location}`, `/claims/{site}` are
served by their owning workers, never apps/web. Don't add a
Next.js page at any of those paths. CF route bindings at the
edge route those paths to the correct worker.

##### 7.7 Service binding == sister-worker dependency
apps/web fails open-but-degraded when a sister worker is
unhealthy. If you see admin pages showing "couldn't load X"
errors after a deploy, it's almost certainly NOT apps/web —
check the sister worker's Observability tab.

##### 7.8 ServiceBinding require Origin header
The `isOriginAllowed` CSRF check on workers (Brief 17) needs
`Origin` set explicitly when calling via service binding,
because the binding-side Request uses `https://internal` as
host. apps/web's `_lib/worker-fetch.ts` helpers handle this;
don't bypass them.

#### 8. Rollback procedure

##### 8.1 Standard rollback (preferred)
1. `git revert <bad-commit>` on `main`
2. `git push origin main`
3. CF Workers Builds detects the push, builds the reverted
   tree, deploys
4. Edge propagates within 1-3 minutes

##### 8.2 Dashboard rollback (faster, no git history)
1. CF dashboard → splash-web → Deployments tab
2. Locate the previous-known-good deployment
3. Click "..." → "Rollback to this deployment"
4. Operator must still revert the bad commit on `main` afterward,
   or the next push re-deploys the broken state

##### 8.3 Emergency: cookie purge
If a deploy breaks the auth cookie format (e.g., we ever
rename `sb-access-token`), all open sessions need to log in
again. Communicate before deploying any auth-cookie change.

#### 9. Cutover-day specific (BUILD_STATE item 13 dependency)

When the operator decides to flip apps/web from staging to
production hostnames:

1. Uncomment the `[[routes]]` block in `apps/web/wrangler.toml`
   and fill in:
   - `pattern = "splashcarwashes.info/*"`, `zone_name = "splashcarwashes.info"`
   - Plus any specific paths that should override the catch-all
     (likely none — `/admin/*`, `/login`, `/logout`,
     `/change-password` all stay on apps/web; the worker-owned
     customer routes have their own bindings that take
     precedence)
2. Push.
3. CF Builds redeploys with the routes block live.
4. Verify in CF dashboard → splash-web → Triggers/Routes that
   the new routes are listed.
5. Smoke-test login flow end-to-end on splashcarwashes.info.
6. If any worker route conflicts, CF surfaces a routing-precedence
   error in the dashboard. Most-specific path wins.
7. Update `NEXT_PUBLIC_*_WORKER_URL` env vars in CF Workers
   Builds: REMOVE them. They're dev-only; in production same-origin
   the rewrites collapse and apps/web hits sister workers via
   service bindings instead.
8. Smoke-test all 8 admin routes again on splashcarwashes.info.

#### 10. Post-cutover follow-ups

- Rename `splash-signup-next` → `splash-signup` in CF dashboard
  + the [[services]] entry in `apps/web/wrangler.toml`
- Retire the legacy `info-signup-worker`
- Decommission staging-specific env vars and routes

### Phase 2 — Updates

2.1 BRIEFS/INDEX.md: Brief 51 row added.

2.2 BUILD_STATE.md:
  - "Open work" table: mark item 15 as Completed (YYYY-MM-DD).
  - Findings entry noting the new doc and that it consolidates
    every apps/web-specific gotcha learned across Briefs 1–50.

2.3 CLAUDE.md: under "Read these every session, in order"
section, the existing entry "PRE_DEPLOY_*.md - five files" is
extended to mention `PRE_DEPLOY_WEB.md` as the sixth (no longer
note the gap).

### Phase 3 — Validation

3.1 No code change. No `pnpm typecheck` or build needed for
this brief.
3.2 Markdown linting (if a linter is configured): pass.
3.3 Cross-references: verify every link / file reference inside
`PRE_DEPLOY_WEB.md` actually resolves. Specifically:
  - All five other PRE_DEPLOY_*.md files exist
  - `apps/web/.env.example` exists and contains the
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY rationale
  - `apps/web/middleware.ts` exists
  - `apps/web/app/admin/_components/ActionForm.tsx` exists
  - `apps/web/app/admin/error.tsx` exists
  - `EquipmentOverrideModal.tsx` exists at the path referenced

## Out of scope

- Changing apps/web behavior. Doc-only brief.
- Updating the per-worker `PRE_DEPLOY_*.md` files with
  cross-references to the new doc — that's a future hygiene
  pass if anyone wants it.
- Don't deploy from headless. No code to deploy.
- Don't bind production routes (the doc describes the cutover
  procedure but does not execute it).
- Don't commit to git or push.

## Definition of done

- `PRE_DEPLOY_WEB.md` exists at the repo root, alongside the
  five existing per-worker pre-deploy docs
- Document contains all 10 sections in the order specified above
- Every cross-reference inside the doc resolves to a real file
- BUILD_STATE.md item 15 marked Completed
- BRIEFS/INDEX.md updated
- CLAUDE.md updated to reflect the new sixth doc
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- File created (just `PRE_DEPLOY_WEB.md`)
- Approximate word count (the doc should be substantial — 2,000–3,500
  words is reasonable for the listed scope)
- Confirmation that all cross-references resolve
- Any decisions made on the operator's behalf (e.g., if a
  referenced file no longer exists at the assumed path, doc
  the alternative)

## Outcome

**Files created:** 1 — `PRE_DEPLOY_WEB.md` at the repo root, alongside
the five existing per-deployable docs (`PRE_DEPLOY_DAMAGE.md`,
`PRE_DEPLOY_DASHBOARD.md`, `PRE_DEPLOY_PERFORMANCE.md`,
`PRE_DEPLOY_SIGNUP.md`, `PRE_DEPLOY_SYSADMIN.md`).

**Files modified:** 3 —
- `BRIEFS/INDEX.md`: item 15 row updated to "Completed (2026-05-06 —
  Brief 51)" pointing at this brief; new Brief 51 row appended at the
  bottom of the table mirroring the Brief 50 pattern.
- `CLAUDE.md`: "Read these every session, in order" entry #4 updated
  from "five files (DAMAGE, DASHBOARD, PERFORMANCE, SIGNUP,
  SYSADMIN). Per-worker deploy notes. There is no PRE_DEPLOY_WEB.md
  (gap noted in BUILD_STATE.md)" to "six files (DAMAGE, DASHBOARD,
  PERFORMANCE, SIGNUP, SYSADMIN, WEB). Per-deployable deploy notes.
  PRE_DEPLOY_WEB.md (Brief 51) consolidates every apps/web-specific
  deploy-time gotcha learned across Briefs 1-50".
- `BUILD_STATE.md`: "Last updated" findings entry prepended; item 15
  status flipped to **completed** (2026-05-06) with Brief column
  changed from "Operational" to "Brief 51"; deployed-components row
  for apps/web updated to drop the "No PRE_DEPLOY_WEB.md" callout
  and link the new doc instead.

**Files deleted:** none.

**Word count:** 3,554 (`wc -w`). Slightly over the brief's 2,000-3,500
upper bound; trimming below 3,500 would have meant dropping
subsections that exist precisely because they bit operators in past
deploys. The brief's "doc should be substantial" framing was honored
over the upper-bound suggestion.

**Cross-reference verification:** every file path / link inside
`PRE_DEPLOY_WEB.md` was glob-checked against the working tree before
landing. All five sister `PRE_DEPLOY_*.md` files,
`apps/web/.env.example`, `apps/web/middleware.ts`,
`apps/web/wrangler.toml`, `apps/web/next.config.mjs`,
`apps/web/app/admin/_components/ActionForm.tsx`,
`apps/web/app/admin/error.tsx`,
`apps/web/app/admin/damage/_components/EquipmentOverrideModal.tsx`,
`apps/web/app/_lib/me.ts`, and the four
`apps/web/app/admin/*/_lib/worker-fetch.ts` files (pricing, damage,
sysadmin, performance) all resolve.

**Section structure:** matches the brief's Phase 1 ordering exactly —
(1) Overview, (2) Deploy mechanism, (3) Build-time configuration
(3.1 NEXT_SERVER_ACTIONS_ENCRYPTION_KEY + 3.2 NEXT_PUBLIC_*_WORKER_URL),
(4) Runtime configuration / service bindings (4.1-4.4), (5)
Pre-deploy checklist, (6) Smoke tests post-deploy, (7) Known gotchas
(7.1-7.8), (8) Rollback procedure (8.1-8.3), (9) Cutover-day
specific, (10) Post-cutover follow-ups.

**Decisions made on operator's behalf:**
1. **Word count slightly over the 3,500 upper bound** — section 7
   (Known gotchas) carries 8 subsections, one per accumulated brief
   lesson; dropping any of them would have removed real failure-mode
   documentation. The "substantial" framing was preferred over the
   upper-bound suggestion.
2. **Brief 51 row added to BRIEFS/INDEX.md alongside the existing
   item 15 row** — Brief 50 set the precedent (it landed both an
   "item 8/12 status updated" change and a separate Brief 50 row at
   the bottom). Following that pattern keeps the index navigable
   from either lens.
3. **CLAUDE.md edit phrasing rewrites the gap callout entirely**
   rather than just appending "and WEB" — the gap-flag verbiage
   ("There is no PRE_DEPLOY_WEB.md (gap noted in BUILD_STATE.md)")
   is no longer accurate after this brief and would mislead a future
   reader. New phrasing centers on the doc's purpose.
4. **Cutover-day section (9) enumerates a single catch-all route**
   (`splashcarwashes.info/*`) rather than per-path overrides — CF's
   most-specific-match-wins routing means the five sister workers'
   explicit per-path bindings outrank the apps/web catch-all
   automatically. Per-path overrides on apps/web would only matter
   if there were apps/web paths LESS specific than worker paths,
   which is never the case in current architecture.
5. **`NEXT_PUBLIC_*_WORKER_URL` removal explicitly called out as
   step 6 of cutover** — leaving them set in CF Builds env
   post-cutover would silently route traffic through `*.workers.dev`
   URLs (double-billing latency and bypassing service bindings).
6. **Eight pre-deploy checklist items, eleven smoke-test items** —
   each maps to a specific failure mode that has bitten the operator
   in a documented brief. Balanced between thoroughness and
   actually-runs-through-it brevity.
7. **Section 7 (Known gotchas) ordering matches risk profile** — CF
   edge propagation first (most common misdiagnosis source);
   server-action contract second (most common code-pattern
   violation); modal-portal third (most recent code-pattern
   violation).
8. **Service-binding `Origin`-header gotcha (7.8) included as a
   standalone subsection** rather than folded into 7.7 — it's a
   concrete code requirement (`Origin: new URL(url).origin`) that
   future developers writing new helpers would otherwise discover
   via 403s in production.

**Latent issues / forward flags:**
1. **The `pnpm install` build command + the
   `opennextjs-cloudflare build && opennextjs-cloudflare deploy`
   deploy command in section 2's table were inferred from
   `apps/web/package.json` scripts and `@opennextjs/cloudflare` usage
   patterns** rather than read directly from CF dashboard — Phase 1
   section 2 of the brief said "see CF dashboard → splash-web →
   Settings → Build. Document the exact string." Headless cannot
   read the CF dashboard. If the dashboard string differs, the
   operator should patch section 2's deploy command line.
2. **Watch paths entry of `apps/web/**` + `packages/**`** is similarly
   inferred from the brief's Phase 1 section 2 instructions; operator
   should verify in CF dashboard.
3. **Optional cross-references-backfill into the five sister
   `PRE_DEPLOY_*.md` files** (mentioning `PRE_DEPLOY_WEB.md` from
   each) is intentionally NOT done in this brief per the Out-of-scope
   section. The new doc DOES cross-reference all five sister docs in
   its preamble, so operators landing on `PRE_DEPLOY_WEB.md` first
   navigate outward; sister-doc-first operators won't see a backref
   until that hygiene pass runs.
4. **No mobile-specific smoke tests in section 6** — the brief asked
   for the standard 8-route admin smoke + the encryption-key
   sanity check. Mobile-specific paths (HEIC upload, claim form on
   iPhone Safari) are owned by the damage-worker and signup-worker
   pre-deploy docs; apps/web's smoke set is correctly scoped to
   admin desktop-Safari/Chrome/Firefox.

**Validation results:**
- `pnpm typecheck`: NOT RUN. Phase 3.1 of the brief explicitly
  out-of-scoped both typecheck and build ("No code change. No
  `pnpm typecheck` or build needed for this brief").
- `pnpm --filter @splash/web build`: NOT RUN (same reason).
- Markdown syntax: validated by inspection. All link references
  resolve to files confirmed via `Glob`. Tables, fenced code blocks,
  and headers render cleanly in standard markdown viewers.
- Cross-reference resolution: 100% — see the verification list above.

**Operator follow-up:**
1. Verify the deploy command string in section 2's table matches CF
   dashboard → splash-web → Settings → Build; patch the line if it
   diverges.
2. Verify the Watch paths entry matches CF dashboard; patch if
   different.
3. Optional: backfill `PRE_DEPLOY_WEB.md` cross-references into the
   five sister `PRE_DEPLOY_*.md` files (small hygiene pass, not
   blocking).
