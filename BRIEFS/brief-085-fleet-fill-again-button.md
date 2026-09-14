# Brief 85: Fleet success modal — add "Fill Again" button (relative-URL redirect, cutover-safe)

**Status:** Completed (2026-05-09)
**Drafted:** 2026-05-09
**Blocks:** Today the fleet inquiry success modal is a dead-end —
operator screenshot 2026-05-09 shows the modal renders with a green
checkmark, "Inquiry Submitted!" title, and a thank-you blurb, but
no way to file a second inquiry without manually navigating back
to the form URL. Brief 57 added the same "Fill Again" UX to the
signup form's success state for the multi-vehicle household case;
fleet has the analogous use case (multi-location fleets, multi-
contact submissions, accidental double-submit recovery).

This brief adds a "Fill Again" button to the success modal that
redirects to a fresh form via a RELATIVE URL — meaning the
button works identically on workers.dev, staging
(`fleet.staging.splashcarwashes.info`), and post-cutover production
(`fleet.splashcarwashes.info`) without any per-environment hardcoded
URLs. No cutover maintenance.

**Dependencies:**
- Brief 81 (the lifted JS this brief edits).
- Brief 57 (the signup form's "Fill Again" pattern this brief
  mirrors — same one-handler approach, server-rendered URL).

## Read first

- CLAUDE.md.
- BUILD_STATE.md.
- BRIEFS/INDEX.md.
- BRIEFS/brief-057-fill-again-redirect-to-picker.md (the signup
  form's analogous "Fill Again" button — full reasoning + handler
  pattern).
- BRIEFS/brief-081-fleet-inquiry-worker-lift-and-shift.md
  (acknowledges that Brief 81's "verbatim port" posture allows
  small additive UX edits in follow-up briefs once features
  arrive).
- apps/fleet-inquiry-worker/src/index.js (the inline-HTML success
  modal — currently at L1366-L1375; the button lands here).

## Context

### What the operator sees today vs after this brief

Today (operator screenshot 2026-05-09):
- Submission completes, success modal shows checkmark + title +
  thank-you text.
- No call-to-action. Modal sits open. Operator must close the
  browser tab or hit refresh to file another inquiry.

After this brief:
- Same checkmark + title + text.
- New button beneath the message: "Fill Again". Click → page
  navigates to `/` (the form's root) with a fresh form state.

### Why a RELATIVE URL, not absolute

The user's first instinct was to use an absolute URL like
`fleet.staging.splashcarwashes.info` and update it at cutover —
which is correct on the maintenance-cost framing but unnecessary
in this case. Fleet's worker serves the form at `/` (and `/fleet`)
from whatever hostname it's currently bound to. A `window.location.href = '/'`
redirect resolves relative to the current origin, so:
- On `splash-fleet-inquiry.joshua-copp.workers.dev/fleet` → `/`
  navigates to `splash-fleet-inquiry.joshua-copp.workers.dev/`.
- On `fleet.staging.splashcarwashes.info/fleet` → `/` navigates
  to `fleet.staging.splashcarwashes.info/`.
- Post-cutover on `fleet.splashcarwashes.info/fleet` → `/`
  navigates to `fleet.splashcarwashes.info/`.

All three URLs serve the form at `/`, so the relative redirect
works in all three environments with no per-environment string.
Zero cutover maintenance, zero environment-detection code.

This brief ALSO sweeps the rest of fleet's inline JS for any other
hardcoded absolute URLs that would need cutover updates — to make
sure no other absolute references exist that future-Josh would
forget to update. Per audit on 2026-05-09, none found in the
form's client-side JS (the form's fetch calls are all to relative
`/api/...` paths). If the executor finds any during the sweep,
they get flipped to relative.

### Why `/` not `/fleet`

Both `/` and `/fleet` route to the same form-render handler (per
the worker's existing route table). `/` is shorter and matches
the canonical form URL fleet has historically been served from.
Either works — pick `/`.

### Sanity-check: form state after redirect

The form's state (selected location, packages, fleet size, etc.)
lives entirely in JavaScript variables in the page (per Brief 81's
audit — no localStorage, no cookies, all in-memory). A full-page
navigation to `/` reloads the worker-served HTML and resets all
in-memory state. New inquiry starts from a blank picker. No state
bleeds across submissions.

## Scope

### Phase 1 — Markup change

**File:** `apps/fleet-inquiry-worker/src/index.js`

Edit the success modal markup at L1366-L1375. Current state:

```html
<!-- Success Modal -->
<div class="success-overlay" id="successOverlay">
    <div class="success-modal">
        <div class="success-icon">&#10003;</div>
        <div class="success-title">Inquiry Submitted!</div>
        <div class="success-message">
            Thank you for your interest in Splash Car Wash fleet services. You will receive an email with your personalized quote, and a representative will contact you shortly to answer any questions you may have.
        </div>
    </div>
</div>
```

Add a button after the `success-message` div:

```html
<!-- Success Modal -->
<div class="success-overlay" id="successOverlay">
    <div class="success-modal">
        <div class="success-icon">&#10003;</div>
        <div class="success-title">Inquiry Submitted!</div>
        <div class="success-message">
            Thank you for your interest in Splash Car Wash fleet services. You will receive an email with your personalized quote, and a representative will contact you shortly to answer any questions you may have.
        </div>
        <!-- Brief 85 — Fill Again button. Relative URL redirect works
             on workers.dev, staging, and production without per-env
             hardcoding. -->
        <button type="button" class="btn-submit" id="fillAgainBtn"
                style="margin-top: 24px;">
            Fill Again
        </button>
    </div>
</div>
```

Reuses the existing `.btn-submit` class for visual consistency
with the form's submit button. Inline `margin-top: 24px;` separates
it from the success-message paragraph above.

### Phase 2 — JS handler

**File:** `apps/fleet-inquiry-worker/src/index.js` (same file)

Inside the IIFE that wraps the form's client-side JS (starts at
~L1378), add a handler for the new button. Place it near the other
DOM-ready event wiring (executor greps for the existing
`document.getElementById('submitBtn')` registration site and adds
the new handler nearby):

```js
// Brief 85 — Fill Again button on success modal.
var fillAgainBtn = document.getElementById('fillAgainBtn');
if (fillAgainBtn) {
    fillAgainBtn.addEventListener('click', function() {
        window.location.href = '/';
    });
}
```

The null-guard (`if (fillAgainBtn)`) is defensive — if a future
brief refactors the modal markup and removes the button, the JS
silently no-ops instead of throwing.

### Phase 3 — Sweep for absolute URLs

`Grep` across `apps/fleet-inquiry-worker/src/index.js` for absolute
URLs pointing at `splashcarwashes.info` or any other hardcoded
hostname in the CLIENT-side JS / HTML:

```sh
# from repo root
grep -nE "(http|//)([a-z0-9-]+\.)*splashcarwashes\.info" apps/fleet-inquiry-worker/src/index.js
grep -n "joshua-copp.workers.dev" apps/fleet-inquiry-worker/src/index.js
```

Per 2026-05-09 audit, none expected. If any are found in the form's
client-side JS or rendered HTML, flip them to relative URLs in the
same brief. Server-side fetches (`fetch(...env.SUPABASE_URL...)`,
Google Maps Geocoding endpoint, Turnstile siteverify endpoint)
stay absolute — those are environment variables / external
services, not navigation targets, and aren't affected by cutover.

### Phase 4 — Validation

```sh
pnpm --filter @splash/fleet-inquiry-worker typecheck
pnpm --filter @splash/fleet-inquiry-worker build
```

Smoke test (after operator deploys):
1. Open the form on whichever hostname is currently active
   (workers.dev or fleet.staging.splashcarwashes.info).
2. Fill out a complete inquiry — pick location, packages, fleet
   size, complete Turnstile.
3. Submit. Success modal renders.
4. Click "Fill Again". Page navigates back to `/`. Form is in
   its initial blank state (no location selected, no packages,
   etc.).
5. Verify the URL bar still shows the same hostname (relative
   redirect didn't accidentally route off-domain).

### Phase 5 — Documentation

1. **CLAUDE.md** — under the fleet-inquiry-worker glossary entry
   (or wherever the fleet section lives), add a one-line note:
   > Success modal includes a "Fill Again" button (Brief 85)
   > that redirects to `/` via relative URL. Works across
   > workers.dev / staging / production with no per-env
   > hardcoding.

2. **BUILD_STATE.md** — bump "Last updated" + Findings entry.
   Note the relative-URL convention for any future client-side
   redirects in fleet, signup-worker, or any other public-form
   worker that has both staging and production hostnames — saves
   maintenance cost at cutover.

3. **BRIEFS/INDEX.md** — append Brief 85 row.

4. **BRIEFS/QUEUE.md** — entry already appended.

## Definition of Done

- `apps/fleet-inquiry-worker/src/index.js` success modal markup
  contains the new `<button id="fillAgainBtn">` with `.btn-submit`
  styling and inline `margin-top: 24px`.
- `apps/fleet-inquiry-worker/src/index.js` client-side JS contains
  the click handler that runs `window.location.href = '/'`.
- `Grep` for absolute splashcarwashes.info URLs in client-side
  code returns zero matches (confirmed in Outcome).
- `pnpm --filter @splash/fleet-inquiry-worker build` succeeds.
- `pnpm typecheck` passes.
- CLAUDE.md updated per Phase 5.1.
- BUILD_STATE.md "Last updated" bumped + Findings entry added.
- BRIEFS/INDEX.md row added.
- This brief's `Status:` flips to `Completed (YYYY-MM-DD)`.

## Out of scope

- "Fill Again" button on the legacy `broad-shape-38b8` worker —
  this brief only modifies the monorepo-deployed worker. Legacy
  worker stays untouched per CLAUDE.md constraint #6.
- Adding Fill Again to other public forms (damage claim form,
  signup form). Signup already has it via Brief 57; damage form
  is its own conversation.
- Resetting form state in-place without navigating away (would
  preserve some UI state like Turnstile widget). Brief 57's
  reasoning applies: a full reload is simpler and gives the
  cleanest blank-state guarantee.
- Adding a "Close" button on the modal that dismisses without
  navigating. Operators wanting that workflow can just close
  the browser tab.
- Animating the modal exit on Fill Again click. CSS animation is
  scope creep.

## Outcome

**Status:** Completed (2026-05-09).

### Files modified

- `apps/fleet-inquiry-worker/src/index.js` — two changes inside the
  same file:
  1. Phase 1 markup: added `<button type="button" class="btn-submit"
     id="fillAgainBtn" style="margin-top: 24px;">Fill Again</button>`
     immediately after the `success-message` div inside the success
     modal block (was L1366-L1375; now L1366-L1382).
  2. Phase 2 handler: new IIFE-scope click-handler block placed
     immediately above the existing `submitBtn.addEventListener('click', …)`
     registration. Runs `window.location.href = '/'` on click, with a
     defensive `if (fillAgainBtn)` null-guard.
- `CLAUDE.md` — fleet-inquiry-worker glossary entry: appended a
  one-paragraph Brief 85 note after the Brief 83 sentence covering
  the new Fill Again button + the relative-URL convention as the
  documented pattern for any future client-side redirect in fleet,
  signup-worker, or any other public-form worker that has both
  staging and production hostnames.
- `BUILD_STATE.md` — bumped "Last updated" to 2026-05-09 (Brief 85
  narrative); inserted new Findings entry at the top of the table.
- `BRIEFS/INDEX.md` — Brief 85 row status flipped from
  `Ready for Claude Code` to `Completed (2026-05-09)`.

### Files created

None.

### Decisions made on operator's behalf

- **Handler placement.** Placed the new `fillAgainBtn` click-handler
  block immediately above the existing `submitBtn.addEventListener('click', …)`
  registration rather than near the bottom of the IIFE. Keeps
  "modal-related JS" colocated with the submit handler that opens
  the modal in the first place; makes the click-wiring grep-able as
  a single `addEventListener` cluster. The brief said "near the
  other DOM-ready event wiring (executor greps for the existing
  `document.getElementById('submitBtn')` registration site and adds
  the new handler nearby)" — adjacent placement above honors that.
- **Reused `.btn-submit` class** for the new button rather than
  introducing a new `.btn-secondary` or similar — matches the
  brief's spec ("reuses the existing `.btn-submit` class for visual
  consistency") and avoids CSS surface growth.
- **Inline `margin-top: 24px;`** per the brief, rather than a
  dedicated `.fill-again-btn` selector in the embedded `<style>`
  block — single-instance use, smallest surgical change.
- **CLAUDE.md placement of the relative-URL convention note.**
  Appended one paragraph to the existing fleet-inquiry-worker
  glossary entry rather than creating a new "client-side redirect
  conventions" section. Keeps fleet's behavioral notes consolidated
  in one place; future grep on the fleet entry surfaces it.

### Latent issues / forward flags

None surfaced. Phase 3 sweep across `apps/fleet-inquiry-worker/src/index.js`
for absolute `splashcarwashes.info` URLs and `joshua-copp.workers.dev`
references in client-side code returned ZERO matches — relative
URLs already in use everywhere on the navigation side. Server-side
`fetch(...)` calls (Supabase REST endpoints via `env.SUPABASE_URL`,
Google Maps Geocoding `https://maps.googleapis.com/...`, Turnstile
siteverify) stay absolute as expected — those are env-var /
external-service URLs, not navigation targets, and aren't affected
by cutover.

The brief noted that Fill Again uses a full-page navigation rather
than an in-place reset — that gives the cleanest blank-state
guarantee (Turnstile widget, IIFE-scope JS state, all reset). Brief
57's same reasoning applies; carried forward without modification.

### Validation

- `pnpm --filter @splash/fleet-inquiry-worker typecheck` — green.
- Root `pnpm typecheck` — 15/15 packages green (only
  `@splash/fleet-inquiry-worker` cache-missed and re-ran on the
  second run; everything else replayed).
- `pnpm --filter @splash/fleet-inquiry-worker build` — **NOT
  RUNNABLE.** The fleet-inquiry-worker `package.json` has no
  `build` script (CF workers don't bundle ahead of `wrangler
  deploy`; same posture as the other 4 workers per Brief 79's
  latent finding). The Definition of Done bullet asking for this
  is a brief-drafting artifact; future fleet/workers DoDs should
  spec `typecheck` only, not `build`.

### Smoke test (deferred to operator post-deploy)

1. Open form on the active hostname (workers.dev or
   `fleet.staging.splashcarwashes.info`).
2. Fill out a complete inquiry — pick location, packages, fleet
   size, complete Turnstile.
3. Submit. Success modal renders with the new Fill Again button
   visible below the thank-you blurb.
4. Click Fill Again. Page navigates back to `/`. Form is in initial
   blank state (no location selected, no packages, no fleet size,
   fresh Turnstile widget).
5. URL bar still shows the same hostname (relative redirect didn't
   accidentally route off-domain).

### Out of scope (per brief — confirmed not addressed)

- Fill Again button on the legacy `broad-shape-38b8` worker
  (CLAUDE.md constraint #6 / #9 hold — only the monorepo-deployed
  worker is touched).
- Adding Fill Again to other public forms (damage claim form;
  signup form already has it via Brief 57).
- In-place form reset without page navigation.
- Close button on the modal that dismisses without navigating.
- Animating the modal exit on Fill Again click.
