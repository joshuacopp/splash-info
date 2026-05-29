# Brief 142: signup-worker + apps/web BOGO parity with production legacy

**Status:** Completed (2026-05-29)
**Started:** 2026-05-29
**Completed:** 2026-05-29
**Blocks:** Customer-facing cutover
**Dependencies:** none

## Read first
- BUILD_STATE.md
- CLAUDE.md
- legacy/signup_worker_with_BOGO.js (reference implementation — the production worker has this version live)
- legacy/signup_worker_pre_BOGO.js (baseline if a diff is useful)
- apps/signup-worker/src/ (entire tree)
- apps/web/app/admin/pricing/ (entire tree)
- packages/db-supabase/src/pricing.ts
- packages/types/src/pricing.ts
- packages/types/src/signups.ts

## Context

BOGO ("Buy One Get One") is a schedule modifier the production legacy
worker now supports: customer pays today's price (any pricing mode),
month 2 is free, recurring billing starts month 3. BOGO is **orthogonal
to pricing modes** — a package can be in `flash5` AND `bogo`
simultaneously, with `today_price = $5` and `recurring_start_date =
today + 2 months`. BOGO never touches the `pricing` column; mode writes
never touch the `bogo` column.

Live state (already done, do NOT re-do):

- Three Supabase migrations have been applied: `pricing_simple.bogo
  boolean NOT NULL DEFAULT false`, the `pricing_simple_resolved` view
  now exposes `bogo`, and `maxpass_signups` gained `is_bogo boolean NOT
  NULL DEFAULT false` + `recurring_start_date date NULL`.
- The legacy worker (`legacy/signup_worker_with_BOGO.js`) has the full
  BOGO end-to-end implementation — admin UI badge + toggle button +
  modal, `setBogo` writer, BOGO-aware terms text (both family + standard
  variants), 3-step callout on the signup form, hidden `is_bogo` +
  `recurring_start_date` fields on submit, persistence in the
  `maxpass_signups` insert. Production has been smoke-tested against
  Rutland (BOGO on full price) and Binghamton (non-BOGO on `flash5`).
- Power Automate has been updated: schema includes the two new columns,
  the confirmation email branches on `is_bogo` (BOGO renders a yellow
  3-step block, non-BOGO keeps the two-card pricing block), and all
  three BOGO email dates derive from `recurring_start_date` for
  consistency with the signed `terms_text`.

This brief brings the monorepo (apps/signup-worker + apps/web +
packages) to behavior parity with the legacy worker, ahead of cutover.
The TS worker is on workers.dev only — no production routes get touched
here. The signup-worker constraint that load-bearing customer URLs
(`/signup/{loc}`, `/q/{loc}`, `/join/{loc}`) must not change applies —
BOGO is additive within the existing URL contract.

## Scope

1. **Types**
   - `packages/types/src/pricing.ts`: add `bogo?: boolean` to
     `PricingSimpleRow` AND `PricingSimpleResolvedRow`. Mark optional
     so unaware callers still typecheck; the column defaults to false
     in Supabase, so rows always carry a value.
   - `packages/types/src/signups.ts`: add
     `is_bogo?: boolean | null` and
     `recurring_start_date?: string | null` to `MaxpassSignupRow`. The
     `MaxpassSignupInsert` `Omit` derivation picks them up
     automatically.

2. **`packages/db-supabase/src/pricing.ts`**
   - Extend `RESOLVED_COLS` to include `bogo`: change to
     `"location_pretty,location_code,pkg,pretty_pkg,today,ongoing,sort,bogo"`.
     This is read by `fetchPricingResolved`,
     `fetchPricingResolvedOne`, and `fetchPricingResolvedByLocation` —
     all three need the wider shape.
   - Extend `listLocationPkgs` SELECT to include `bogo` (currently
     `"location_code,location_pretty,pkg,pricing,special,site_email,am_email,rm_email,updated_at"`).
   - Add `setBogo(client, { locationCode, onPkgs })` writer. Mirror
     the legacy `setBogo` from `legacy/signup_worker_with_BOGO.js`:
     two PATCHes against `pricing_simple`. Pass 1 — clear `bogo` on
     every row at the location (`location_code=eq.{loc}`). Pass 2 —
     set `bogo=true` on the chosen subset
     (`location_code=eq.{loc}&pkg=in.(...)`), skipped when
     `onPkgs.length === 0`. Stamp `updated_at` on both. NEVER touch
     the `pricing` column. Return `boolean`; callers handle cache
     invalidation themselves (matches the `setPricingMode` convention
     documented in the file).

3. **`apps/signup-worker/src/pricing/cache.ts`**
   - Bump `CACHE_VERSION` from 1 to 2. The cached payload shape now
     carries `bogo` per row; the version bump forces stale Workers
     Cache entries to be re-fetched cleanly after deploy. No other
     changes — keys + SWR logic stay the same.

4. **`apps/signup-worker/src/signature/terms.ts`**
   - Extend `TermsContext` with `bogo: boolean` and `month3Str: string`
     (MM-DD-YYYY of `today + 2 months`). Keep `todayStr` /
     `nextBillingStr` as today's date / today + 1 month.
   - Add a new `yyyymmdd(dt: Date): string` helper that returns
     `YYYY-MM-DD` built from local `getFullYear/getMonth/getDate` — do
     NOT use `toISOString()`. The `Date` objects represent ET
     wall-clock; `.toISOString()` can shift the day across midnight
     for late-evening submissions and break the contract that
     `recurring_start_date` exactly equals the date in the signed
     terms.
   - `buildTermsText` gains four branches: BOGO + family, BOGO +
     standard, non-BOGO + family, non-BOGO + standard. The non-BOGO
     branches stay exactly as today (verbatim port — legal text). The
     BOGO branches replace the standard recurring sentence with:

         "This recurring program will charge ${priceTextToday} today
         (${todayStr}), your second month (${nextBillingStr}) is FREE,
         and then ${priceTextMonthly} beginning on ${month3Str} and
         every anniversary date of each month thereafter…"

     The rest of the body (cancellation, fleet exclusion, Promotional
     Pricing + Presale Offer appendix) is the SAME boilerplate as the
     non-BOGO variant — keep the appendix on BOGO too. The Family
     Plan BOGO branch keeps the per-vehicle clause. See
     `legacy/signup_worker_with_BOGO.js` `renderSignupForm` for the
     verbatim copy.

5. **`apps/signup-worker/src/signature/inline.ts`**
   - In `renderInlineSignupForm`, compute ET-local `today`/`next`/`month3`
     dates using `America/New_York` (same pattern as the legacy worker
     — see `legacy/signup_worker_with_BOGO.js` `renderSignupForm`
     opening lines). Today's implementation uses `new Date()` and lets
     UTC wall-clock leak through — fix this for both BOGO and
     non-BOGO so the dates always reflect ET.
   - Compute `isBogo = args.row.bogo === true`. When true, compute
     `month3Iso = yyyymmdd(month3)`; otherwise `month3Iso = ""`.
   - Pass `bogo: isBogo`, `month3Str: mmddyyyy(month3)` to
     `buildTermsText`.
   - Pass `isBogo`, `month3Str`, `month3Iso`, `todayStr`,
     `nextBillingStr`, `priceTextToday`, `priceTextMonthly` through
     to `renderSignupForm` (extend `SignupFormRenderArgs`).

6. **`apps/signup-worker/src/render/form.ts` + `render/css.ts`**
   - Extend `SignupFormRenderArgs` with the new fields (see step 5).
   - When `isBogo === true`, render a yellow BOGO callout between the
     `.package-info` block and the `<form>`:

         <div class="bogo-callout">
           <div class="bogo-banner">BOGO — Buy One, Get One Free</div>
           <ol class="bogo-steps">
             <li><strong>Today (${todayStr}):</strong> ${priceTextToday}</li>
             <li><strong>${nextBillingStr}:</strong> Second month <strong>FREE</strong></li>
             <li><strong>${month3Str}:</strong> Recurring billing begins at ${priceTextMonthly}</li>
           </ol>
         </div>

   - Add two hidden inputs to the form: `is_bogo` (value
     `"true"`/`"false"`) and `recurring_start_date` (value `month3Iso`
     or empty string when non-BOGO).
   - In the client `buildBody()` JS, include
     `is_bogo: form.is_bogo.value === 'true'` and
     `recurring_start_date: form.recurring_start_date.value || null`.
     They ride along in the warn/monitor re-submit paths automatically
     because all four paths reuse the same `body` object.
   - In `render/css.ts` (`FORM_CSS`), add the BOGO callout styles
     mirroring the legacy worker: gradient yellow background (`#fef3c7
     → #fde68a`), `#f1c61e` border, splash-navy text, banner heading +
     `<ol>` list. See the legacy worker for exact values; match its
     padding/margin/radius.

7. **`apps/signup-worker/src/handlers/submit-signup.ts`**
   - Extend `SubmitBody` with `is_bogo?: boolean` and
     `recurring_start_date?: string | null`.
   - In the `insertRow` literal, add `is_bogo: body.is_bogo === true`
     and `recurring_start_date: body.recurring_start_date || null`.
     Defensive defaults so older clients (which won't post these
     fields) land as `false`/`null` and don't break the insert. No
     other handler logic changes.

8. **`apps/signup-worker/src/handlers/admin-pricing.ts`**
   - Add a new endpoint
     `POST /admin/api/locations/{loc}/set-bogo`. Mirror the
     `handleSetMode` shape: `isOriginAllowed` CSRF gate →
     `adminGate` → `userCanAccessLocation` → body parse → call the
     new `setBogo` helper → `invalidatePricingCache(locationCode)`
     → refetch `packages` + `resolved` for the response →
     `logPricingAudit({ action: "pricing_set_bogo", target_id: loc,
     after: { packages_on: onPkgs } })`. Body shape:
     `{ pkgList: string[] }` — packages to turn BOGO **on** (every
     other package at the location gets turned OFF; matches the legacy
     full-intent modal contract). Zero in the list is valid (means
     "turn BOGO off everywhere at this location").
   - Extend `logPricingAudit`'s `action` union to include
     `"pricing_set_bogo"`. Extend `PricingAuditAfter` (or add a new
     interface) so `packages_on: string[]` can be written.
   - Wire the new path into the worker's dispatch table (wherever
     `set-mode` / `flip` get dispatched in `dispatchAdminApi` — find
     the existing branch and add a sibling).
   - The existing `GET /admin/api/locations/{loc}` already returns
     `packages` (from `listLocationPkgs`) and `resolved` (from
     `fetchPricingResolvedByLocation`); both now carry `bogo`
     because of step 2. No change to the GET handler itself, but
     verify the response actually contains the field after the
     SELECT change lands.

9. **`apps/web/app/admin/pricing/[location]/`**
   - Extend the `PricingSimpleRow` / `PricingResolvedRow` interfaces
     in `page.tsx` with `bogo?: boolean`.
   - In the `PricingGrid` client component (`grid.tsx`), surface per-
     package BOGO state in the rendered card — add a yellow `BOGO`
     pill next to the existing mode pill when `bogo === true`. Use
     splash-navy text on `--yellow` background; match the legacy
     `.pkg-bogo` styling.
   - Add a "Toggle BOGO" button (full-width, yellow accent) under
     the existing 3×2 mode actions grid. NOT part of the mutually-
     exclusive mode group — independent on/off.
   - Clicking it opens a modal mirroring the legacy implementation:
     eyebrow "Toggle Promo", title "Buy One Get One", checkbox per
     package pre-checked from current state, zero-checked is valid.
     On confirm, POST to
     `/admin/api/locations/{loc}/set-bogo` with
     `{ pkgList: <checked> }`.
   - On success, refresh the grid from the response (same flow as
     the existing mode buttons). Status toast: `Updated <loc>
     BOGO.`
   - Reuse whichever modal primitive the existing Special-price
     modal uses (per `_components/` or `grid.tsx`), so the BOGO
     modal stays visually consistent with the rest of the page.

## Configuration

No new env vars or secrets. The Supabase columns already exist (see
Context). The cache key version is bumped inside the code, no manual
intervention needed.

## Out of scope

- Don't run any SQL migrations. The columns exist in production already.
- Don't change the `pricing` column from any BOGO write path.
- Don't change `setPricingMode`. Mode writes must continue to ignore
  `bogo` (orthogonality goes both ways).
- Don't change customer-facing URL contracts — `/signup/{loc}`,
  `/q/{loc}`, `/join/{loc}` stay as-is.
- Don't add a `bogo` overlay to the customer-facing package picker
  (`/signup/{loc}` index). BOGO renders only on the per-package signup
  form (`/signup/{loc}/{pkg}`).
- Don't deploy to Cloudflare; don't bind production routes.
- Don't update Power Automate — already done out-of-band.
- Don't commit to git or push.

## Definition of done

- `pnpm typecheck` passes.
- `pnpm --filter @splash/signup-worker build` succeeds.
- `pnpm --filter @splash/web build` succeeds.
- Hitting `GET /admin/api/locations/{loc}` on the new worker returns
  rows with `bogo` field present on both `packages` and `resolved`
  arrays.
- `POST /admin/api/locations/{loc}/set-bogo` with `{pkgList:[<pkg>]}`
  flips `pricing_simple.bogo` to `true` on the chosen package and
  `false` on the rest at that location, leaves `pricing` untouched,
  and invalidates the per-location cache key.
- `GET /signup/{loc}/{pkg}` for a BOGO-on package renders the yellow
  3-step callout, the BOGO-aware terms text (with Promotional/Presale
  appendix preserved), and two hidden fields `is_bogo=true` +
  `recurring_start_date={YYYY-MM-DD}`.
- `GET /signup/{loc}/{pkg}` for a non-BOGO package renders identically
  to today (no behavior change), no yellow callout, `is_bogo` hidden
  field is `false`, `recurring_start_date` is empty.
- A submission against a BOGO package writes a `maxpass_signups` row
  with `is_bogo=true` and `recurring_start_date` matching the date the
  customer saw in terms.
- A submission against a non-BOGO package writes `is_bogo=false`,
  `recurring_start_date=null` (older clients posting no fields
  exercise the same defaults).
- Late-evening ET submissions produce a `recurring_start_date` whose
  calendar day matches the day shown in `terms_text` (no UTC shift).
- `/admin/pricing/{loc}` renders the BOGO pill for BOGO-on packages,
  the Toggle BOGO button works, the modal pre-checks from current
  state, and zero-checked apply correctly turns BOGO off across the
  location.
- BUILD_STATE.md updated: bump "Last updated", add a Findings entry
  ("Brief 142: signup-worker + apps/web reached BOGO parity with
  legacy"), and add a glossary entry under "BOGO" if one doesn't
  already exist (canonical description of the schedule-modifier
  semantic + the orthogonality rule).

## Report

- Decisions made on the operator's behalf.
- Whether the BOGO callout markup was inserted into `render/form.ts`
  via template-string interpolation or by changing the renderer's
  signature; either is acceptable.
- Any spots where the legacy and TS implementations diverge
  intentionally (e.g., if the existing `terms.ts` boilerplate has
  whitespace/punctuation differences from the legacy text — note
  them, don't try to "fix" the boilerplate).
- Latent issues found while extending these files — particularly
  anything around the existing ET wall-clock handling in
  `inline.ts` (today's code uses `new Date()` directly, which can
  produce non-ET dates in the production Workers runtime).

## Outcome

**Files created.**
- `apps/web/app/admin/pricing/[location]/_components/BogoModal.tsx` — sibling
  to `PackagePickerModal.tsx`. Yellow-toned header (eyebrow "TOGGLE PROMO",
  title "Buy One Get One"), checkbox per package pre-checked from current
  `bogo` state, zero-checked allowed, fires `{ pkgList: <checked> }` to
  the new worker endpoint.

**Files modified.**
- `packages/types/src/pricing.ts` — added optional `bogo?: boolean` to
  `PricingSimpleRow` and `PricingSimpleResolvedRow`.
- `packages/types/src/signups.ts` — added optional
  `is_bogo?: boolean | null` and `recurring_start_date?: string | null` to
  `MaxpassSignupRow`. `MaxpassSignupInsert` picks them up automatically
  via the existing `Omit` derivation.
- `packages/db-supabase/src/pricing.ts` — extended `RESOLVED_COLS` and
  `listLocationPkgs` SELECT to include `bogo`. Added new `setBogo(client,
  { locationCode, onPkgs })` writer that PATCHes `pricing_simple` in two
  passes (clear-all then set-subset), never touches the `pricing` column.
- `apps/signup-worker/src/pricing/cache.ts` — bumped `CACHE_VERSION` from
  1 → 2. Forces stale Cache API entries to be re-fetched cleanly after
  deploy.
- `apps/signup-worker/src/signature/terms.ts` — extended `TermsContext`
  with `bogo: boolean` and `month3Str: string`. Added new `yyyymmdd(dt)`
  helper that builds `YYYY-MM-DD` from local `getFullYear/getMonth/getDate`
  (not `.toISOString()`) so late-evening ET submissions don't shift the
  day. `buildTermsText` rewritten to a 4-branch dispatch: non-BOGO+family,
  non-BOGO+standard, BOGO+family, BOGO+standard. The non-BOGO bodies are
  byte-for-byte verbatim ports; the two BOGO branches swap the FIRST
  sentence to "...charge $X plus tax today (date), your second month
  (date) is FREE, and then $Y plus tax beginning on month3..." and reuse
  the identical cancellation / fleet-exclusion / Promotional Pricing +
  Presale Offer appendix.
- `apps/signup-worker/src/signature/inline.ts` — added ET wall-clock
  computation mirroring the legacy worker (toLocaleString through
  `America/New_York`, then construct a local Date from the components).
  Previously this used `new Date()` directly which leaked UTC wall-clock
  on production Workers and could mis-date late-evening submissions even
  on non-BOGO. Computes `isBogo` / `month3Date` / `month3Str` / `month3Iso`
  and forwards them plus the pre-formatted `priceTextToday` / `priceTextMonthly`
  to the renderer.
- `apps/signup-worker/src/render/form.ts` — extended
  `SignupFormRenderArgs` with the six new BOGO-aware fields (`isBogo`,
  `todayStr`, `nextBillingStr`, `month3Str`, `month3Iso`, `priceTextToday`,
  `priceTextMonthly`). Renderer computes the yellow callout block as a
  template-string interpolation (empty string when non-BOGO) and inserts
  it between `.package-info` and the `<form>`. Added two hidden inputs
  inside the form: `is_bogo` (true/false) and `recurring_start_date`
  (month3Iso or empty). Extended the client `buildBody()` to ride those
  fields back to the submit handler; warn / monitor / success resubmit
  paths inherit the fields automatically (they all reuse the same body
  object).
- `apps/signup-worker/src/render/css.ts` — added `.bogo-callout`,
  `.bogo-banner`, `.bogo-steps` rules to `FORM_CSS`. Yellow gradient
  (`#fef3c7 → #fde68a`), `#f1c61e` border, splash-navy text; banner
  heading + `<ol>` list. Padding/margin/radius mirror the legacy worker.
- `apps/signup-worker/src/handlers/submit-signup.ts` — extended
  `SubmitBody` with optional `is_bogo?: boolean` and
  `recurring_start_date?: string | null`. Added the two columns to the
  `insertRow` literal with defensive defaults: `is_bogo: body.is_bogo
  === true` and `recurring_start_date: body.recurring_start_date || null`
  — older clients (and the warn/monitor flows that don't carry the
  fields) land as `false`/`null` and don't break the insert.
- `apps/signup-worker/src/handlers/admin-pricing.ts` — imported `setBogo`
  from `@splash/db-supabase`. Added a new
  `POST /admin/api/locations/{loc}/set-bogo` handler mirroring
  `handleSetMode`'s shape: `isOriginAllowed` → `adminGate` →
  `userCanAccessLocation` → body parse → `setBogo` →
  `invalidatePricingCache` → refetch packages + resolved → audit. Added
  a new `BogoAuditAfter` interface and widened `logPricingAudit`'s
  action union to include `"pricing_set_bogo"` and its `after` parameter
  to accept the new shape.
- `apps/signup-worker/src/index.ts` — wired `set-bogo` into the
  `dispatchAdminApi` table next to `set-mode` / `flip`. Updated the
  top-of-file route comment + the per-function path-layout comment.
- `apps/web/app/admin/pricing/[location]/page.tsx` — added optional
  `bogo?: boolean` to local `PricingSimpleRow` / `PricingResolvedRow`
  interfaces (they shadow the package types; kept consistent).
- `apps/web/app/admin/pricing/[location]/grid.tsx` — imported the new
  `BogoModal`. Added `bogoOpen` state, `applySetBogo` async handler,
  and `bogoPackages` derivation (per-package on-state from the current
  packages array). Mode column now renders both `<ModeBadge>` AND the
  new `<BogoBadge>` (yellow `#f1c61e` background, splash-navy text)
  inline when `p.bogo === true`. Added a new full-width "Toggle BOGO"
  button below the 3×2 mode grid (yellow accent, NOT in the mutually-
  exclusive mode group). On apply, `BogoModal` POSTs to the new worker
  endpoint, the response's `packages` + `resolved` arrays refresh the
  grid, success toast = `Updated {loc} BOGO.`.

**Decisions made on operator's behalf.**
1. BOGO callout markup added to `render/form.ts` via template-string
   interpolation (option a in the brief's Report section): renderer
   computes the block (empty string when non-BOGO) and the form-body
   template literal includes it unconditionally between `.package-info`
   and the `<form>`. Keeps the signature change minimal and the
   conditional block isolated to one place.
2. ET wall-clock fix applied to non-BOGO renders as well (not just
   BOGO). The original `new Date()` could shift late-evening dates in
   the `todayStr` and `nextBillingStr` already shown to non-BOGO
   customers; the brief flagged this as a latent issue and the fix is
   a one-liner that benefits both code paths.
3. `BogoModal` is a separate component file rather than a `kind` prop
   on `PackagePickerModal`. The header copy, color palette, the lack
   of a "select at least one" guard, and the pre-checked-from-current-
   state seeding all diverge enough that combining them would
   over-conditional the existing component. Sibling files compose
   better here.
4. `BogoBadge` is an inline component inside `grid.tsx` (not extracted
   to `_components/`) because it's a single 14-line presentational
   stub used only in this file. If a second consumer needs it, lift
   it then.
5. The `mode` column header in the read-only grid now contains two
   pills (mode + optional BOGO) rather than splitting into separate
   columns. BOGO is orthogonal to mode, but visually grouping them
   matches the legacy admin's compact card layout (`<span class="pkg-
   tags">`) and avoids widening the table.
6. The Toggle BOGO button's `disabled={busy}` matches the rest of the
   buttons so concurrent clicks don't double-fire (e.g., busy from an
   in-flight Quick Flip).
7. `setBogo` lives in `@splash/db-supabase` alongside `setPricingMode`
   so a future bulk-set-bogo brief (analogous to bulk-set-mode) can
   reuse it. Per-location cache invalidation stays in the worker
   handler — same convention as `setPricingMode`.
8. Audit logging shape: BOGO uses a separate `BogoAuditAfter` interface
   (`packages_on: string[]`) rather than re-using `PricingAuditAfter`
   which is keyed on `mode`. The two record types are queryable
   distinctly: `WHERE action = 'pricing_set_bogo'` returns rows whose
   `after->>'packages_on'` is the per-location intent at write time.

**Intentional legacy ⇄ TS divergences.**
- The legacy worker's BOGO callout banner uses literal `--` (which
  renders as two dashes in plain HTML); this brief uses the actual
  em-dash `—` to match the rest of the TS worker's render copy. Purely
  visual; the customer sees one nicer dash instead of two.
- The legacy worker's `setBogo` uses raw `fetch` + manual URL
  construction with PostgREST `or=(pkg.eq.X,pkg.eq.Y)` for pass 2.
  The TS port uses Supabase client's `.eq("location_code", loc).in("pkg",
  list)` which compiles to PostgREST `pkg=in.(X,Y)` — semantically
  identical, idiomatic for the codebase, no behavior difference.
- The legacy worker's cache invalidation deletes a single
  org-wide key (`https://internal-cache/pricing_simple_resolved`); the
  TS worker has per-location cache keys (Brief 56 redesign predates
  this brief) and `invalidatePricingCache(locationCode)` is the
  per-location equivalent — better than legacy on this axis.
- `terms.ts` BOGO branches use the same "Promotional Pricing /
  Presale Offer" appendix as the non-BOGO branches verbatim — the
  brief specifies "the rest of the body is the SAME boilerplate on
  BOGO too". Legacy text uses the en-dash `–` (U+2013) which is
  preserved verbatim per "do not edit legal copy".

**Latent issues found.**
- The existing `inline.ts` BEFORE this brief used `new Date()`
  directly, producing UTC wall-clock dates in the Workers runtime
  (the operator confirmed via the brief's Report section that this
  was suspected). For evening submissions east of UTC the
  `todayStr` / `nextBillingStr` could be off by one day even on
  non-BOGO. Brief 142 fixes this for both code paths.
- The legacy worker filters `pricing_simple` via raw
  `or=(pkg.eq.X,pkg.eq.Y)` URL params and URL-encodes each name; the
  Supabase client's `.in(...)` does its own escaping. Neither code
  path handles a pkg name containing a comma (`,`), but no current
  package code uses one — flagging here as documentation for any
  future executor introducing one.
- The Cache API key version bump (v1 → v2) only invalidates entries
  on Workers instances that re-fetch after deploy; the prior v1
  entries become unreachable but get LRU-evicted naturally within
  ~24h. Operator does not need to manually purge.
- The signup-worker's typecheck succeeded; however, no per-worker
  `pnpm --filter @splash/signup-worker build` script exists — every
  app uses `wrangler deploy` for builds. Used
  `wrangler deploy --dry-run --outdir .wrangler/dry-run` instead
  (worker bundle = 784.04 KiB raw / 151.45 KiB gzipped, well under
  the 3 MiB compressed free-tier ceiling).
- `apps/web/app/admin/signups/[location]/page.tsx` was NOT touched —
  signups admin doesn't render `is_bogo` / `recurring_start_date`
  yet. A follow-up brief could add a small "BOGO" badge on signup
  rows where `is_bogo === true` so operators can spot promo signups
  in the per-location viewer. Out of scope here.

**Validation results.**
- `pnpm typecheck`: 18/18 successful (10.64s wall; 3 cache hits,
  15 ran fresh including types, db-supabase, signup-worker, web).
- `pnpm --filter @splash/signup-worker exec wrangler deploy --dry-run`:
  succeeds. Bundle: **784.04 KiB raw / 151.45 KiB gzipped**.
- `pnpm --filter @splash/web build`: succeeds. `/admin/pricing/[location]`
  route grew from ~3 kB → **4.09 kB / 111 kB First-Load JS** (the
  BogoModal client island + the grid wiring).

**Deferred to operator post-deploy smoke (not in scope here per the brief).**
1. Hit `GET /admin/api/locations/{loc}` against `splash-signup-next.workers.dev`,
   confirm both `packages[]` and `resolved[]` arrays include `bogo`
   boolean on every row.
2. Hit `POST /admin/api/locations/{loc}/set-bogo` with `{pkgList:
   ["unlimited_express"]}`, confirm `pricing_simple.bogo` flipped to
   true on that pkg and false on the rest at that location; `pricing`
   column untouched.
3. Visit `/signup/{loc}/{bogo-on-pkg}` on workers.dev — confirm
   yellow 3-step callout renders between pricing block and form,
   terms text contains the BOGO 3-step sentence, hidden fields
   `is_bogo=true` + `recurring_start_date=YYYY-MM-DD` present in
   the rendered HTML.
4. Submit against a BOGO package — confirm `maxpass_signups` row has
   `is_bogo=true` and `recurring_start_date` matching the date
   embedded in the signed `terms_text`.
5. Visit a non-BOGO package — confirm no callout, hidden field
   `is_bogo=false`, terms text identical to today.
6. Visit `/admin/pricing/{loc}` on apps/web staging — confirm BOGO
   pill appears next to mode for BOGO-on packages; Toggle BOGO
   button opens the modal pre-checked from current state; zero-
   checked apply turns BOGO off everywhere.
