# Brief 25: Customer claim form polish (PIN gate + multi-photo + submit UX + required fields)

**Status:** Completed (2026-05-05)
**Started:** 2026-05-05
**Completed:** 2026-05-05
**Blocks:** Customer-facing claim submission usability. Brief 23 ported
the form's HTML shell but missed several legacy features and modern UX
expectations the operator surfaced during testing.
**Dependencies:** Brief 23 (claim form HTML render) is the immediate
predecessor; Brief 5d (server-side photo handling) for context on
how multipart uploads are read.

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-023-customer-claim-form.md (Outcome - what shipped)
- apps/damage-worker/src/render/claim-form.ts (the rendered HTML
  template - this brief modifies it heavily)
- apps/damage-worker/src/index.ts handleClaimSubmission (around line
  975 - the POST handler that receives the form data)
- legacy/damagemanager.js - search for the original PIN gate
  implementation. PIN is `1981`. The legacy form had a two-step
  reveal: customer fills their portion, enters PIN, employee section
  becomes editable.
- packages/storage-r2/src/* (R2 photo upload helpers, for context on
  what multipart fields the worker expects)

## Context

Brief 23 ported the customer claim form HTML to damage-worker.
Operator testing surfaced 7 gaps:

1. **`vehicleYear` is optional** but should be required.
2. **PIN gate missing.** Legacy form required PIN `1981` to advance
   from the customer section into the employee assessment section.
   This is "are you an employee" obscurity gating - low-effort
   defense against a customer filling out the staff portion.
3. **Equipment section is wrong shape.** Currently a free-text or
   single dropdown. Should be a boolean toggle "Was the damage
   equipment related?" defaulting to No. When flipped to Yes, surface
   the "equipment involved" dropdown.
4. **"Managers only" emphasis missing** on the
   `customer_get_quotes` determination radio. Should render as a
   visible pill so customer-facing staff don't accidentally pick it.
5. **Photo upload is single-file per category.** Selecting a second
   photo overwrites the first because the file input replaces its
   FileList rather than appending. Four-corners and damage need
   multi-photo support; VIN and license plate stay single.
6. **Camera-vs-device choice is forced.** Current input has
   `capture` attribute (probably) which forces camera-first. Should
   let the browser present its native chooser (camera OR gallery).
7. **Submit success UX is broken.** Form submits, claim is inserted,
   but the form stays as-is with no feedback. Operator wants:
   inline outcome card showing claim ID + a "Dismiss" / "New claim"
   button that resets the form for the next customer.

This brief addresses all 7 plus tightens the multipart submit path
to match the new outcome flow.

## Scope

### Part A - Required fields + simple corrections

A.1 `apps/damage-worker/src/render/claim-form.ts`:
  - Add `required` to the `vehicleYear` input.
  - Verify all the existing required fields from Brief 23 are still
    in place: customerName, customerPhone, vehicleMake, vehicleModel,
    damageDescription, determination, submittedBy.

A.2 Style the "Managers only" hint on the `customer_get_quotes`
determination radio:
  - Render a small pill alongside the radio's label, e.g.
    `<span class="pill pill-warn">Managers only</span>`.
  - CSS: `background: var(--splash-warn, #f59e0b); color: white;
    border-radius: 9999px; padding: 2px 10px; font-size: 0.75rem;
    font-weight: 700; text-transform: uppercase; letter-spacing:
    0.05em; margin-left: 8px;`.
  - Match the brand palette already used in the form's inline CSS.

### Part B - Equipment-related toggle

B.1 Replace the current equipment input with a two-state toggle:
  - "Was the damage equipment related?" label
  - Yes / No radio pair (or a styled segmented control), default to
    No.
  - When Yes is selected: reveal a select dropdown for
    `equipmentInvolved` with the legacy equipment options (look up
    the legacy list - things like "Tire Shine Applicator", "Side
    Brushes", "Top Brush", etc. The legacy file has the canonical
    list).
  - When No is selected (or default): hide the dropdown; on submit,
    `equipmentInvolved` should be empty string or "N/A" (whatever
    handleClaimSubmission currently expects when no equipment
    involved).
  - Implement via inline `<script>` in the rendered HTML (the form
    is worker-rendered, no React). Add an event listener on the
    radio change that toggles a `[data-equipment-section]` block's
    visibility.

B.2 Confirm handleClaimSubmission (apps/damage-worker/src/index.ts
~line 1032-1100) reads `equipmentInvolved` correctly when the
field's empty/N/A. The existing column `equipment_related` is
0|1 derived from "is equipmentInvolved empty or N/A". Keep that
derivation; don't change the worker's contract.

### Part C - PIN gate for employee section

C.1 Two-step reveal pattern in the rendered form:
  - Top section: customer-facing fields (name, phone, email,
    address, vehicle, damage description). No PIN required to fill
    this out.
  - "Continue to employee section" button at the bottom of the
    customer section.
  - On click: prompt for PIN via a small inline modal or a fielded
    input. PIN is `1981` (legacy carry-over - hardcoded in the
    rendered JS, NOT a secret since it's customer-visible obfuscation
    only).
  - On correct PIN: hide the customer section's "Continue" button,
    reveal the employee section (preexistingDamage, staffNotes,
    determination, submittedBy, equipmentInvolved toggle, photo
    sections, customerTold, customerDemeanor).
  - On wrong PIN: show inline error "Incorrect PIN" and let them
    retry.
  - Customer section fields stay editable even after PIN entry (the
    employee may need to correct typos based on what the customer
    confirms).
  - Confirm via JS that the form `<button type="submit">` only fires
    the actual submit when both sections are filled. Until PIN is
    entered, the submit button is hidden along with the employee
    section.

C.2 Document in a code comment that PIN=1981 is hardcoded
obfuscation - if the legacy team ever wants real auth on the staff
section, that's a separate brief (would need a Supabase-backed
short-lived token or similar).

### Part D - Multi-photo upload + native chooser

D.1 Four-corners and damage photo sections become "add photo" lists:
  - Replace the existing `<input type="file" multiple>` with a
    custom multi-photo widget (still vanilla JS, inline in the form).
  - Initial state: a styled "Add photo" button + an empty list.
  - Click "Add photo": triggers a hidden `<input type="file"
    accept="image/*">` (NO `capture` attribute - browser-native
    chooser between camera and gallery).
  - On file select: append the file to the section's internal list,
    render a thumbnail (using URL.createObjectURL for preview), show
    a small "Remove" link below the thumbnail.
  - After the first photo is added, surface "Add another four-corners
    photo?" affordance below the thumbnails (a styled link/button).
  - On final form submit, all photos for the section are bundled into
    the multipart form under the same field name (`fourCornersPhotos`,
    `damagePhotos`). The worker already handles `formData.getAll(...)`
    so multi-file uploads land correctly without a worker change.

D.2 VIN and license plate sections stay single-file:
  - Same "Add photo" button pattern but only one allowed.
  - After a photo is added, the button becomes "Replace photo".
  - No "add another?" affordance.

D.3 Drop the `capture` attribute everywhere. The browser-native chooser
is enough.

D.4 Each section's photos get appended to the multipart submission
under the canonical field names handleClaimSubmission expects. Verify
the field names match: `fourCornersPhotos` (multiple),
`vinPhoto` (single), `damagePhotos` (multiple), `platePhoto` (single).
These are the names from `PHOTO_CATEGORIES` at
apps/damage-worker/src/index.ts:144-150.

### Part E - Submit outcome UX

E.1 Convert the form's submit to JS-driven so the page doesn't
navigate:
  - On submit, intercept with `form.addEventListener("submit", ...)`,
    `e.preventDefault()`, build a `FormData` from the form, POST it
    to `/claims-api/submit-claim` via `fetch`.
  - Show a "Submitting..." overlay or disabled state while waiting.
  - On 2xx response (parse JSON, expect `{ ok: true, claim_id: "..." }`):
    - Hide the form.
    - Render an outcome card: "Claim submitted successfully" + claim
      ID (monospace, prominent) + small text "Please give the
      customer a copy or photo of the claim ID for their records."
    - "Submit another claim" button that reloads the page (simplest
      reset path; everything goes back to defaults including the PIN
      gate).
  - On non-2xx:
    - Show an inline error banner above the form: "Submission failed.
      Please retry. <error message>".
    - Don't clear the form; let the staff member retry without
      re-typing.

E.2 Verify handleClaimSubmission's response shape:
  - Read apps/damage-worker/src/index.ts handleClaimSubmission. If
    it currently returns HTML on success (Brief 23 may have had it
    return a thanks page inline), change it to return JSON with the
    shape the form's JS expects: `{ ok: true, claim_id: string }`
    on success, `{ ok: false, error: string }` on failure.
  - If Brief 23 wired in an `Accept`-based or `redirect=`-based
    branching, the form's fetch can set `Accept: application/json`
    and rely on that branch.
  - Document the chosen path in the Outcome.

### Part F - Updates

F.1 BRIEFS/INDEX.md: add Brief 25 row marked Completed.

F.2 BUILD_STATE.md: bump Last updated, add Findings entry covering
the 7 fixes.

## Out of scope

- Replacing the inline `<script>` with a real client framework (React
  etc.) - the form stays as worker-rendered HTML+JS for simplicity
  and bundle size.
- Server-side compression/resize of uploaded photos beyond what
  uploadClaimPhoto already does.
- Real authentication for the employee section (PIN obfuscation is
  documented as the legacy approach).
- Per-photo metadata fields (notes per photo, dating, etc.).
- Drag-and-drop file upload.
- Offline submission queue for spotty in-store wifi.
- Multi-language (i18n) support.
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run
  succeeds
- vehicleYear is required
- "Managers only" pill renders next to the customer_get_quotes radio
- Equipment section is a yes/no toggle with conditional dropdown
- PIN gate (1981) reveals the employee section on correct entry
- Four-corners and damage sections support multi-photo (add another?
  flow); VIN and plate sections accept single
- File inputs do not force camera (no `capture` attribute);
  browser-native chooser
- Submit shows inline outcome card with claim ID + "Submit another
  claim" reset button
- handleClaimSubmission returns JSON the form's JS can parse
- BUILD_STATE.md and BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Whether the legacy PIN gate's exact UX shape was preserved or
  modified
- Whether handleClaimSubmission needed changes (JSON response,
  Accept-based branching) or worked as-is
- Bundle-size delta on damage-worker (the form's inline JS is the
  largest grower; expect ~5-10 KiB gzip increase)
- Any latent issues spotted in the worker's photo-upload handling
  (e.g., field-name mismatches, MIME validation, max-bytes
  enforcement)
- Validation results

## Outcome

**Files modified:**
- `apps/damage-worker/src/render/claim-form.ts` — substantial rewrite of
  `renderClaimForm`. Adds PIN-gated employee section, multi-photo widget
  with thumbnail previews + remove links, equipment yes/no segmented
  toggle that conditionally reveals the equipment dropdown + the
  malfunction checkbox, "Managers only" pill on the
  `customer_get_quotes` determination radio, JS-driven submit with
  inline outcome card and error banner, `vehicleYear` made required,
  `capture` attribute dropped on every file input. Inline JS lives in a
  module-level `FORM_SCRIPT` constant (string concatenation throughout
  so the outer TS template literal cannot interpolate `${...}` patterns
  by accident) interpolated once into the rendered HTML. Photo widget
  tracks per-category File arrays in a closure-scoped `photos` object;
  on submit, each file is `formData.append("<field>", file, file.name)`'d
  under the canonical worker field names (`fourCornersPhotos`,
  `vinPhoto`, `damagePhotos`, `platePhoto`) so the worker's existing
  `formData.getAll(field)` reads pick them up unchanged. PIN gate is a
  simple full-screen overlay (not `<dialog>`) for broad browser
  compatibility; PIN=1981 hardcoded with a code comment flagging it as
  customer-visible obfuscation. `EQUIPMENT_CHOICES` lost the explicit
  "N/A" entry — the toggle's "No" branch now sends an empty string for
  `equipmentInvolved`, which the worker's existing
  `equipmentRelated = (equipmentInvolved && !== "N/A") ? 1 : 0`
  derivation already maps to 0 (no contract change required).
  `DETERMINATION_CHOICES` gained a `managersOnly: boolean` flag driving
  the pill render. Added segmented-toggle, photo-thumb, photo-add-button,
  pin-overlay, submitting-overlay, outcome-card, and pill CSS to
  `SHARED_STYLES`.
- `apps/damage-worker/src/index.ts` — `handleClaimSubmission`'s JSON
  success branch now returns `{ ok: true, claim_id, ...legacy fields }`;
  failure branch returns `{ ok: false, error, success: false }` with
  status 500. The legacy `success` / `claimId` keys are mirrored
  alongside `ok` / `claim_id` for any programmatic caller still reading
  the older shape (no such caller in the monorepo today). Browser-mode
  redirect path (`Accept: text/html`) is unchanged from Brief 23.

**Files created:** none.

**Decisions made on operator's behalf:**
1. **`equipmentMalfunction` checkbox folded inside the equipment-yes
   block** rather than left as an always-visible top-level toggle. The
   "Was there an equipment malfunction?" question only makes sense when
   equipment was actually involved; if the toggle is No, `equipmentMalfunction`
   is forced to "false" via the hidden input's `value`. The worker's
   existing parse (`String === "true"`) is unchanged.
2. **`employeeName` is required only after PIN unlock**, not always. If
   `required` stayed on the input while the field was hidden,
   `form.checkValidity()` could fire on the customer-section "Continue"
   button click path even though no submit was happening. Setting
   `required = true` from JS on PIN unlock keeps validation aligned with
   visibility.
3. **PIN gate uses a custom overlay div, not `<dialog>`** — broader
   browser compat (older iOS Safari especially), and the styling is
   simpler. Cancel + Continue buttons + Enter-key submit. Wrong PIN
   shows an inline error and clears the input; no rate limiting (PIN is
   obfuscation, not auth).
4. **JSON success shape mirrors both `ok`/`claim_id` AND legacy
   `success`/`claimId`** rather than picking one. The form's JS reads
   `claim_id ?? claimId`. No behavioral cost; future cleanup can drop
   the legacy keys when the operator confirms no programmatic caller is
   parsing them.
5. **Photo widget uses one hidden `<input type="file">` per section**
   (rather than a single shared input that gets re-targeted) — simpler
   event wiring, no race between concurrent clicks. `accept="image/*"`
   only; `capture` dropped per brief; `multiple` dropped because the
   "add another" pattern is a deliberate one-at-a-time UX (per brief).
6. **`URL.createObjectURL` thumbnails are revoked on re-render** to
   avoid blob-URL leaks across many add/remove cycles. Hygiene; not
   load-bearing for short-lived form sessions.
7. **Submit-time validation order:** sync the equipment-toggle's
   conditional `required`, then `form.checkValidity()` (browser bubble
   for missing required fields), then JS-side photo-count validation
   (since photos aren't native form inputs anymore). Photo-missing
   errors render in the inline error banner above the form.
8. **"Submit another claim" reset path is `window.location.reload()`**
   per brief — simplest reset; everything (PIN gate, photos, all
   fields) goes back to defaults. No client-side reset to avoid bugs in
   half-cleared state.
9. **`form.action="/claims-api/submit-claim"` retained even though the
   submit is JS-driven** — graceful degradation if JS is disabled
   (extremely unlikely on a tablet in 2026 but cheap to keep). The
   worker's browser-mode redirect path covers that fallback.
10. **`novalidate` on `<form>`** — defers validation to the JS submit
    handler so HTML5 bubbles don't fire on the "Continue" button click
    path or while the employee section is hidden. `reportValidity()` is
    called explicitly inside `validateBeforeSubmit()`.
11. **Equipment "N/A" choice removed from the dropdown** — the toggle's
    No state is the canonical "no equipment involved" path. Keeping
    "N/A" alongside Yes would be redundant and confusing. The worker's
    `!== "N/A"` clause stays intact (defense in depth) but no longer
    has anything to match.

**Latent issues / forward flags:**
- (a) **Submit overlay is a full-viewport opaque-ish overlay**, not a
  spinner — kept simple. If submission stalls (slow upload, large
  photos), the operator sees only "Submitting claim, please wait...".
  Future polish: progress indicator showing photo upload percentage.
- (b) **No client-side photo size cap** — the worker delegates to the
  CF Workers 100 MB request body limit. A customer with a stack of
  HEIF originals could theoretically exceed that and get a CF error
  page. Pre-resize via canvas or HEIC→JPEG conversion is out of scope
  per brief.
- (c) **Photo widget remove link uses a stale-closure `idx`** — actually
  no, each iteration creates a new closure binding via the `forEach`
  callback's `idx` parameter, so removes work correctly even if the
  user removes from the middle of the list. Tested by tracing: array
  splice + full re-render avoids index-drift bugs.
- (d) **PIN=1981 is in the worker bundle** (visible in DevTools) and in
  the rendered HTML's `<script>`. Brief explicitly classified this as
  obfuscation, not auth. If a real auth flow lands later, a separate
  brief would replace this with a Supabase short-lived token gate.
- (e) **`form.checkValidity()` includes still-hidden fields** — if a
  required field is added inside a `hidden` section and the operator
  triggers submit before reaching that section, the bubble points at a
  hidden input. Mitigated by the linear PIN gate flow (employee section
  is the only conditionally-hidden block, and submit is hidden until
  PIN unlock). The conditional-required pattern on `equipmentInvolved`
  (toggled true only when equipment-yes is selected) handles the
  in-section conditional case.
- (f) **`form.reset()` on the success outcome is replaced with full
  page reload** — the JS state machine (photos object, thumbUrls,
  PIN-gate visibility, equipment toggle) doesn't have a single reset
  hook; reload is the simplest correct path.
- (g) **`URL.revokeObjectURL` on success path** — not currently called.
  The `window.location.reload()` on "Submit another claim" GCs the
  whole page anyway; a no-reload reset would need explicit revoke. Not
  load-bearing.
- (h) **Worker JSON failure does NOT include the partial state**
  (whether D1 succeeded, whether PA POSTed). The form's JS surfaces
  only `body.error`. If a future smoke test wants per-stage diagnostics
  for the customer-facing form, add an `?debug=1` opt-in branch — out
  of scope here.
- (i) **`equipmentInvolved` worker reads** match what the form sends
  ("Top Brush" / "Side Wraps" / etc. — exact strings from the
  EQUIPMENT_CHOICES tuple). No PII / format mismatch.
- (j) **`vehicleYear` `min="1900" max="2030"`** — same as the prior
  pre-Brief-25 input. The brief said "make required" without changing
  the bounds; keeping `2030` is fine for now (tablets won't hit it
  before a follow-up bumps it).
- (k) **CSRF posture unchanged** — `POST /claims-api/submit-claim`
  remains public, no `isOriginAllowed` (intentional per Brief 23). The
  JSON failure shape change doesn't widen the surface.

**Report responses:**
- **Legacy PIN-gate UX shape preserved or modified?** Modified — the
  legacy form had the PIN entry inline within the form flow; this port
  uses a separate modal overlay launched by an explicit "Continue"
  button. Functionally equivalent: PIN=1981 unlocks the staff section,
  wrong PIN shows an error, the customer section stays editable. The
  modal pattern is more discoverable on tablets.
- **Did `handleClaimSubmission` need changes?** Yes — JSON success
  shape adjusted to `{ ok: true, claim_id, ...legacy keys }`; failure
  shape to `{ ok: false, error, success: false }`. Browser-mode
  redirect path unchanged. The form's `Accept: application/json`
  header drives the JSON branch via the existing
  `acceptHeader.includes("text/html")` detection.
- **Bundle-size delta on damage-worker:** **1628.16 KiB → 1644.95 KiB**
  uncompressed (+16.79 KiB), **368.53 KiB → 372.70 KiB** gzip
  (+4.17 KiB). Within the brief's 5-10 KiB gzip estimate, comfortably
  under the CF Workers 3 MiB compressed free-tier limit. The growth is
  the inline `FORM_SCRIPT` (PIN gate + photo widget + equipment toggle
  + JS submit + outcome card) plus added CSS for the new visual
  components.
- **Latent issues spotted in worker's photo-upload handling:**
  - Field names match (`fourCornersPhotos`, `vinPhoto`,
    `damagePhotos`, `platePhoto`) — verified against
    `apps/damage-worker/src/index.ts:158-163` `PHOTO_CATEGORIES`.
  - `formData.getAll(field)` correctly handles multi-file uploads
    under the same key — already used in the worker's loop, no change
    needed.
  - No worker-side MIME validation on uploaded photos beyond
    `uploadClaimPhoto`'s internal handling — same as before.
  - No worker-side max-bytes enforcement; the CF Workers request limit
    (100 MB) is the hard ceiling. Per-photo cap would be a separate
    brief.

**Validation:**
- `pnpm typecheck` — **13/13 successful**, 1.906s (12 cached + 1 fresh
  — only `@splash/damage-worker` invalidated by the renderClaimForm
  rewrite + the index.ts JSON shape edit; all other packages cache-hit).
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run`
  — succeeded. Bundle 1644.95 KiB / 372.70 KiB gzip. Bindings: DB /
  R2_BUCKET / IMAGES.

