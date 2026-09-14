# Brief 57: "Fill Form Again?" navigates back to `/signup/{location}` instead of resetting in place

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Customer UX after a successful signup. Today the
"Fill Form Again?" button on the success overlay clears the
form fields in-place and re-focuses the phone input — meaning
the customer stays on `/signup/{location}/{pkg}` (same package).
Operator wants the button to send them back to the package
picker at `/signup/{location}` so the next signup can pick a
different package (e.g., the family member upgrading from
Single to Family).
**Dependencies:** None.

## Read first

- CLAUDE.md (constraint #1 — `/signup/{location}` is a
  load-bearing customer URL; navigating TO it is fine, just
  don't change ITS shape)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- apps/signup-worker/src/render/form.ts (the only file changing;
  click handler at L293-L301)

## Context

`renderSignupForm` builds the success overlay's "Fill Form
Again?" button and wires this click handler (L293-L301):

```js
document.getElementById('fillAgainBtn').addEventListener('click', function(){
  closeOverlay(overlay);
  phoneInput.value = '';
  emailInput.value = '';
  agree.checked = false;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Complete Sign Up';
  phoneInput.focus();
});
```

The reset-in-place behavior assumes the next signup is for the
same package. Operationally, multiple-signup sessions are usually
multi-vehicle households where each vehicle picks its own package
— so the right landing is the package picker, not the same
package's form.

## Scope

### Phase 1 — Replace the click handler with a navigation

1.1 In `apps/signup-worker/src/render/form.ts`, locate the click
handler at L293-L301. Replace the body with a redirect to the
package picker:

```js
document.getElementById('fillAgainBtn').addEventListener('click', function(){
  // Brief 57 (2026-05-06): redirect to the package picker so the
  // next signup can pick a different package. Previously this
  // reset the form in-place which assumed the next signup was
  // for the same package — operationally, "fill again" usually
  // means a different vehicle in the same household.
  window.location.href = '/signup/${escHtml(locationCode)}';
});
```

  - `${escHtml(locationCode)}` is interpolated server-side at
    render time. The surrounding template-string scope already
    has `locationCode` available — it's used elsewhere in the
    same render function (form `action`, hidden inputs, etc.).
    Confirm the variable name matches the existing code (it may
    be `location` or `slug` rather than `locationCode`; use
    whatever the surrounding render uses).
  - `escHtml` is the standard helper imported in form.ts; safe
    against any pathological location_code (in practice they're
    `^[a-z0-9_]+$` per LOCATION_CODE_RE, but defense-in-depth
    keeps the JSX-style escape consistent with the rest of the
    file).
  - DO use `window.location.href = ...` (full navigation), NOT
    `history.pushState` or similar. The customer just submitted
    a form; we want a fresh page load with no stale state.

1.2 Remove the now-dead variable references inside the old
handler — `phoneInput.value = ''`, `emailInput.value = ''`,
`agree.checked = false`, `submitBtn.disabled = true`,
`submitBtn.textContent = 'Complete Sign Up'`,
`phoneInput.focus()`. The redirect makes them irrelevant.

1.3 Don't touch the rest of the success overlay (the checkmark,
the heading, the green "MaxPass Success!" line). Customer should
still see the success card briefly before clicking Fill Form
Again — auto-redirecting on success would skip the "did it
work?" feedback the customer needs.

### Phase 2 — Validation

2.1 `pnpm typecheck` — must pass for all 13 packages. (form.ts
is a renderer that returns a string; no type changes expected.)
2.2 `pnpm --filter @splash/signup-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed; clean
   up `.tmp-build` afterward.
2.3 No new endpoints. No schema changes. No new env vars.

### Phase 3 — Updates

3.1 BRIEFS/INDEX.md: Brief 57 row appended.

3.2 BUILD_STATE.md: Findings entry noting:
  - "Fill Form Again?" button on the signup success overlay now
    navigates back to the package picker `/signup/{location}`
    instead of resetting the form in-place
  - Reasoning: multi-signup sessions are usually multi-vehicle
    households picking different packages
  - Operator follow-up: complete a test signup on any location
    (Brief 32's claim form is unrelated; this is the
    `/signup/{loc}/{pkg}` form), click "Fill Form Again?", and
    confirm the browser navigates to `/signup/{loc}` showing
    the package picker

3.3 No CLAUDE.md change needed — this is a small UX tweak,
not a behavior contract worth documenting at the project level.

## Out of scope

- Auto-redirecting on success (skipping the user click). The
  success-card pause is the customer's confirmation that the
  signup landed.
- Adding a "Sign Up Another Vehicle" affordance distinct from
  "Fill Form Again?" — single button is fine; the rename can
  happen if operator wants different copy later.
- Touching the customer-facing claim form (different worker,
  different file, different flow).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- "Fill Form Again?" button click navigates the browser to
  `/signup/{locationCode}` (the package picker)
- Old in-place reset code (clearing phone/email/agree, disabling
  submit, focusing phone) is removed
- Server-side template interpolates the locationCode safely via
  `escHtml`
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/signup-worker exec wrangler deploy
  --dry-run bundle succeeds (clean up after)
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely 5-10 lines net: handler body replaced)
- Validation results
- Confirmation that `locationCode` (or whatever the surrounding
  variable is named) was already in scope at the click-handler
  template position

## Outcome

**Files modified (1):**
- `apps/signup-worker/src/render/form.ts` — replaced the body of the
  `fillAgainBtn` click handler at L293-L301 with a single full
  navigation: `window.location.href = '/signup/${escHtml(locationCode)}';`
  plus a 6-line comment block (Brief 57 + 2026-05-06 prefix +
  rationale on why this is full navigation rather than in-place
  reset). Removed the prior six lines that cleared `phoneInput.value`,
  `emailInput.value`, `agree.checked`, disabled `submitBtn`, reset
  the submit-button label to `'Complete Sign Up'`, and re-focused
  `phoneInput`. Also removed the prior `closeOverlay(overlay);` call
  — full navigation discards the entire page including the overlay
  element. Net diff is ~0 lines added (6 lines removed, 6 lines of
  comment added, 1 line of redirect added — roughly identical line
  count post-edit).

**Files created:** none.

**Files deleted:** none.

**Variable name confirmation:** The brief flagged that the
surrounding render scope might use `location`, `slug`, or
`locationCode` for the location-code variable. Confirmed
`locationCode` by reading L72 of form.ts:
`<input type="hidden" name="location" value="${escHtml(locationCode)}"/>`.
The function destructures `{ locationCode, packageCode, row, termsText }`
from `SignupFormRenderArgs` at L31-L35. `escHtml` is already
imported at L16: `import { cap, escHtml } from "./escape.js";`.

**How the interpolation works:** `renderSignupForm` returns a single
JS template literal. Inside that outer template, `${escHtml(locationCode)}`
gets evaluated server-side at render time and replaced with the
escaped location code (e.g., `binghamton`). The bundled output (which
is the worker source, not the per-request response) preserves the
template-literal expression. At request time, the worker calls
`renderSignupForm({ locationCode: 'binghamton', ... })` and emits an
HTML page containing `window.location.href = '/signup/binghamton';`
literally — the JS that ships to the customer browser is already
fully resolved.

**Decisions made on operator's behalf:**
1. **Variable name** — confirmed `locationCode` (not `location` or
   `slug`); used as specified in the brief's example snippet.
2. **Comment block** — kept the brief's exact wording so future
   readers have the load-bearing context (operationally, "fill
   again" means a different vehicle in the same household, so
   redirecting to the picker is the right behavior).
3. **Removed `closeOverlay(overlay);`** — full navigation tears
   down the entire page including the overlay element, so the
   explicit close call is redundant. Brief Phase 1.2 enumerated
   the dead variable references but not the closeOverlay call;
   keeping it would be a no-op that survives ~10ms before
   navigation discards the page. Removed for cleanliness; the
   navigation itself is the visible effect.
4. **No QUEUE.md instruction in brief, but did update QUEUE.md**
   per the established pattern (commented out brief-057 line with
   `(completed 2026-05-06)` suffix, matching the 17 prior completed
   entries above it). The brief's Phase 3 list mentioned only
   BRIEFS/INDEX.md and BUILD_STATE.md; skipping QUEUE.md would have
   left the orchestrator queue inconsistent with how prior briefs
   were filed.

**Latent issues / forward flags:**
- (a) **No headless smoke test possible** — operator must complete a
  test signup on a known-allowed phone (super_admin or operator-
  curated test phone) at any active `/signup/{loc}/{pkg}` URL,
  wait for the success card, click "Fill Form Again?", and verify
  the browser navigates to `/signup/{loc}` showing the package
  picker (rather than resetting in-place at `/signup/{loc}/{pkg}`).
- (b) **Bundle delta** — Total Upload **771.08 KiB / gzip 148.83 KiB**
  (Brief 56 baseline 770.91 / 148.69 → +0.17 KiB / +0.14 KiB gzip;
  expected delta from the comment block + new template-literal
  expression).
- (c) **`/signup/{location}` is a load-bearing customer URL** per
  CLAUDE.md constraint #1; this brief navigates TO it, not changes
  ITS shape, so the constraint is respected. The picker handler
  already exists; no picker-side changes were needed.
- (d) **Pre-existing JS state on the success overlay** — under
  unusual network conditions the success card might briefly
  remain visible while the new picker page loads. Acceptable;
  the new page wipes everything on load.

**Validation:**
- `pnpm typecheck` — **13/13 successful** (1.589s; 12 cache hits +
  fresh `@splash/signup-worker` rebuild — only modified package).
- `pnpm --filter @splash/signup-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build` — **succeeded**. Total Upload
  **771.08 KiB / gzip 148.83 KiB**. Single binding
  `env.SIGNATURE_MODE` (Environment Variable, value `"inline"`)
  resolved cleanly. Confirmed bundled output at
  `.tmp-build/index.js:22184` reads
  `window.location.href = '/signup/${escHtml(locationCode)}';` —
  the outer template literal preserves the `${...}` expression
  for runtime interpolation when `renderSignupForm` is invoked
  per request. `.tmp-build/` cleaned up afterward.

**Diff size:** 5 lines net (6 lines of imperative reset removed,
1 line of redirect added, 6 lines of comment context added, 1
line of `closeOverlay` removed — roughly even). Single-file change.

**Standard updates also applied:**
- `BRIEFS/INDEX.md` — Brief 57 row appended to the prioritized
  work-list table.
- `BRIEFS/QUEUE.md` — Brief 57 entry commented out with
  `(completed 2026-05-06)` suffix per the established pattern.
- `BUILD_STATE.md` — line-3 stamp prepended with Brief 57's
  one-line summary; new Findings & decisions log entry inserted
  at the top of the table.

**Operator follow-up:** after `splash-signup-next` redeploys (CF
Workers Builds on push to `main`), navigate to any active
`/signup/{loc}/{pkg}` URL (e.g.,
`https://splash-signup-next.<account>.workers.dev/signup/binghamton/single`
or, post-cutover, `https://splashcarwashes.info/signup/binghamton/single`),
submit a test signup using a known-allowed phone, wait for the
success card, click "Fill Form Again?", and confirm the browser
navigates to `/signup/binghamton` showing the package picker
(vs. resetting in-place at `/signup/binghamton/single`).
