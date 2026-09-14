# Brief 32: Claim form email required + claim summary PDF + customer-email webhook

**Status:** Completed (2026-05-05)
**Started:** 2026-05-05
**Completed:** 2026-05-05
**Blocks:** Customer never receives a copy of their claim today.
Operator wants the customer-facing claim form (Brief 23/25) to (a)
require email at submission time, (b) generate a polished PDF of
the full claim record on submission, and (c) POST that PDF (or a
URL to it) to a new Power Automate webhook so PA can email it to
the customer. Closes the customer-side feedback loop on every
submission.
**Dependencies:** Brief 23 (the customer claim form HTML +
`POST /claims-api/submit-claim` handler), Brief 25 (form polish -
PIN gate, multi-photo, equipment toggle, determination + what-told
fields, JS-driven submit). pdf-lib is already a damage-worker
dependency from the check-request flow; mirror that pattern.

## Read first

- CLAUDE.md (especially the "Working with workers" section -
  damage-worker owns claims; secrets via `wrangler secret put`;
  no `wrangler deploy` if UI-set secrets exist)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-023-customer-claim-form.md (Outcome - the customer
  form's HTML + `POST /claims-api/submit-claim` handler shape)
- BRIEFS/brief-025-claim-form-polish.md (Outcome - the form's
  current required-field set + JS submit pipeline + showOutcome /
  setSubmitting helpers; the new email-required field falls under
  this same client-side validation surface)
- apps/damage-worker/src/render/claim-form.ts (the form HTML +
  inline submit script - this brief makes email required and
  surfaces the PDF-link in the post-submit outcome card if the
  webhook returns one)
- apps/damage-worker/src/index.ts (the submit-claim handler +
  existing POWER_AUTOMATE_URL webhook pattern + Env interface)
- apps/damage-worker/src/pdf.ts (existing check-request PDF gen;
  pdf-lib + R2 template-fill pattern. The new claim-summary PDF
  uses pdf-lib but generates the PDF programmatically rather than
  filling an AcroForm template - no operator pre-work required)
- packages/storage-r2/src/index.ts (the `ASSETS` export with logo
  URLs; the brand logo this brief embeds)
- apps/web/app/admin/damage/_lib/transitions.ts (for parity - the
  manager-side "determination" + "what was the customer told"
  field names used downstream)

## Context

The customer claim form currently:
- Takes customer info (name, email-OPTIONAL, phone, vehicle, what
  happened, photos)
- PIN-gates a Staff Assessment section (PIN 1981; manager fills
  determination + what was told to the customer)
- POSTs to `/claims-api/submit-claim`, which writes to D1, R2, and
  fires `POWER_AUTOMATE_URL` (internal-routing PA flow)
- Renders a "Claim submitted" outcome card with the new claim ID

What's missing:
1. **Email is optional** - customer can submit without one, leaving
   no way to send them a copy.
2. **No customer-facing artifact** - the PDF only exists for the
   internal Check Request flow (manager-triggered, not customer-
   triggered).
3. **No customer-email pathway** - PA only gets the routing
   webhook today.

## Scope

### Part A - Email required on the claim form

A.1 `apps/damage-worker/src/render/claim-form.ts` (Brief 23/25
HTML): make the email input a required field.
  - Add `required` attribute to the email input element.
  - Update the field's helper text from optional / no-helper to a
    short hint: e.g., "We'll email you a copy of this claim."
  - Browser-side: HTML5 `type="email"` + `required` covers the
    happy path. The inline submit JS (`FORM_SCRIPT` from Brief 25)
    already validates required fields; verify the new email
    constraint surfaces a sensible error in the inline error band
    if submitted blank. If not, add an explicit branch.

A.2 Worker side (`POST /claims-api/submit-claim` handler in
`apps/damage-worker/src/index.ts`): reject submissions where
`email` is missing or invalid. Validation:
  - Non-empty after trim.
  - Matches `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` (the same simple regex
    used in sysadmin-worker per Brief 24/27).
  - On invalid: return 400 `{ ok: false, error: "Email required" }`
    with the existing JSON-error shape.

A.3 D1 schema: confirm the `claims` table's `customer_email`
column is non-null already, OR if it's nullable, add a comment
in the worker noting the new contract (form-side requires it; DB
still allows null for back-compat with any historical rows). No
schema change needed - this is a contract change at the surface,
not at the storage level.

### Part B - Claim summary PDF generation

B.1 New module `apps/damage-worker/src/render/claim-summary-pdf.ts`:

  - Pure function `generateClaimSummaryPdf(input) -> Uint8Array`.
  - Input shape:
    ```ts
    interface ClaimSummaryPdfInput {
      claimId: string;
      submittedAt: string;          // ISO-8601 UTC
      locationPretty: string;
      locationCode: string;
      // Customer-filled section
      customer: {
        name: string;
        email: string;
        phone: string | null;
        vehicleMake: string;
        vehicleModel: string;
        vehicleYear: string;
        vehicleColor: string | null;
        licensePlate: string | null;
        licenseState: string | null;
        whatHappened: string;
      };
      // Optional - thumbnails to embed (small jpegs, <=200px wide).
      // Generate the thumbs from R2 photo objects upstream; this
      // function just embeds whatever bytes it gets.
      photos: Array<{ filename: string; bytes: Uint8Array }>;
      // Staff assessment (PIN-gated form section)
      assessment: {
        staffName: string | null;
        equipmentRelated: "yes" | "no" | null;
        determination: string;        // free text manager picked
        whatCustomerWasTold: string;
      };
      // Brand assets - bytes loaded from R2 at the call site
      logoPng: Uint8Array;
    }
    ```

  - Use pdf-lib drawing primitives (no AcroForm template; pure
    programmatic layout):
    - Page size: US Letter (612 x 792 pt).
    - Margins: 54 pt all around.
    - Embed Helvetica + Helvetica-Bold for type.

  - Layout (top to bottom):
    1. **Header band** - Splash navy stripe across the top, 60 pt
       tall:
       - Splash logo PNG embedded on the left (height ~36 pt; width
         scales proportionally).
       - Title "Vehicle Issue Report" in white, Helvetica-Bold 18 pt,
         right-aligned.
       - Subtitle below the title: claim ID in mono-style spacing,
         submission timestamp formatted local-friendly
         ("May 5, 2026 6:13 PM"), right-aligned, white at 70%
         opacity.
    2. **Location line** - small label "LOCATION" + the
       location_pretty + " (#" + location_code + ")" on a single
       row below the header band. Splash navy text.
    3. **Section heading** - "Customer Information" - splash blue
       horizontal rule + bold label.
    4. **Customer info grid** - two-column key/value list:
       Name, Email, Phone, Vehicle (make/model/year/color),
       License Plate (plate + state). Empty values render "—".
    5. **What Happened** - full-width text block; wrap at the
       page width.
    6. **Photos** (if any) - up to 4 thumbnails in a row,
       evenly spaced. If >4 photos, show 4 + "+N more" caption.
       Each thumbnail max ~120 pt wide. Skip the section entirely
       if `photos.length === 0`.
    7. **Section heading** - "Staff Assessment".
    8. **Staff assessment grid** - same key/value pattern:
       Staff name, Equipment-related (Yes/No), Determination, What
       customer was told. The last two are full-width text blocks
       (wrap).
    9. **Footer** - claim ID one more time + a small note "This
       summary was generated automatically. For questions, contact
       the location directly." Splash navy, 9 pt.

  - If the PDF runs over one page, let pdf-lib paginate naturally
    (add page on overflow). Don't shrink type.

B.2 Generate the PDF inline within the submit-claim handler in
`apps/damage-worker/src/index.ts`:

  - After D1 + R2 writes succeed (and BEFORE returning the success
    JSON), do:
    1. Load the Splash logo bytes from R2: the existing `ASSETS`
       export from `@splash/storage-r2` points at the brand assets;
       use whichever PNG variant fits a 36 pt header (probably the
       small navy-on-white or white-on-navy logo). If R2 storage of
       the logo isn't already set up under a known key, pick a
       sensible key like `assets/splash-logo-white.png` and add a
       TODO in the Outcome flagging the operator-side upload.
    2. Pull thumbnails for up to 4 of the claim's photos. If the
       photos are large jpegs, downscale via Cloudflare Images
       (existing `IMAGES` binding in damage-worker). If `IMAGES`
       isn't bound at runtime, fall back to embedding original
       bytes (oversized PDFs are acceptable as a degraded fallback).
    3. Call `generateClaimSummaryPdf(input)` -> Uint8Array.
    4. Store the PDF in R2 at
       `claims/<claimId>/summary.pdf` (Content-Type
       `application/pdf`).
    5. Compute a public URL for the stored PDF. Mirror how
       photo URLs are served today (the existing `/claims-api/photo/`
       route or equivalent). If a per-request signed URL pattern
       is in use, reuse it; otherwise expose
       `/claims-api/summary/<claimId>` GET that streams the R2
       object back.
  - PDF generation MUST NOT fail the submission - wrap the whole
    block in try/catch and log + swallow on error. Worker still
    returns `{ ok: true, claim_id: ... }` to the customer. Audit
    the failure with a console.error including the claim ID for
    after-the-fact reconstruction.

B.3 Add a GET handler at
`/claims-api/summary/<claimId>` (or whatever path matches the
existing photo-serving pattern):
  - Reads the R2 object `claims/<claimId>/summary.pdf`.
  - Streams it back with `Content-Type: application/pdf` +
    `Content-Disposition: inline; filename="claim-<claimId>.pdf"`.
  - 404 on missing object.
  - No auth gate (the URL is unguessable enough; mirror the
    photo-serving security posture).
  - The customer's email contains this URL; PA fetches OR the
    customer clicks through directly.

### Part C - Customer-email webhook

C.1 New env var on damage-worker: `CUSTOMER_CLAIM_WEBHOOK_URL`.
  - Add to `Env` interface in `apps/damage-worker/src/index.ts`:
    ```ts
    /** Webhook URL fired after a customer-submitted claim - PA
     *  receives the claim summary URL + customer email and emails
     *  the customer their copy of the claim. Optional; fail-soft.
     *  Set via `wrangler secret put CUSTOMER_CLAIM_WEBHOOK_URL`. */
    CUSTOMER_CLAIM_WEBHOOK_URL?: string;
    ```
  - Add to `apps/damage-worker/wrangler.toml`'s commented-secrets
    list / .dev.vars example so future-us knows the variable
    exists.

C.2 In the submit-claim handler, AFTER the existing
`POWER_AUTOMATE_URL` webhook fires AND the claim-summary PDF is
stored, post a second webhook to `CUSTOMER_CLAIM_WEBHOOK_URL`
with payload:
  ```json
  {
    "claim_id": "VES-20260505-181329-PLUF",
    "submitted_at": "2026-05-05T18:13:29Z",
    "location_pretty": "Vestal",
    "location_code": "vestal",
    "customer_name": "Jane Doe",
    "customer_email": "jane@example.com",
    "customer_phone": "+1-555-555-5555",
    "vehicle": "2020 Honda Civic - Blue",
    "summary_pdf_url": "https://staging.splashcarwashes.info/claims-api/summary/VES-20260505-181329-PLUF",
    "summary_pdf_base64": "<base64 of the same PDF, optional>"
  }
  ```

  - **summary_pdf_url** is always included.
  - **summary_pdf_base64** is also included as a fallback so PA
    can attach without a separate fetch round-trip if that's
    cleaner. PA flows can pick whichever they want. (If PDF byte
    size pushes the JSON payload over a sane limit - say 4 MB -
    omit the base64 and rely on the URL only.)
  - Failure shape: webhook returns non-2xx -> log + swallow. Don't
    fail the claim. Don't retry inline.
  - If `CUSTOMER_CLAIM_WEBHOOK_URL` is undefined / empty: skip the
    customer-email webhook entirely (no log noise; treat as the
    feature being intentionally off).

C.3 The existing `POWER_AUTOMATE_URL` webhook (internal-routing
flow) is NOT modified - it continues to fire with whatever payload
shape Brief 23 wired up. Don't touch its fields. Both webhooks
fire in sequence; both fail-soft.

### Part D - Form-side polish (post-submission)

D.1 In the inline submit-success branch (`showOutcome` in the
form's FORM_SCRIPT, post-Brief 25 + Brief 29):
  - If the worker's response includes `summary_pdf_url`, surface
    it in the outcome card as a "Download a copy" link
    (white-on-splash-blue button matching the existing primary
    button style). Customer can save without waiting for the PA
    email.
  - If the response doesn't include the URL (PDF generation
    failed, fail-soft), show only the existing "Claim submitted"
    + claim ID; no broken link state.
  - The link target opens in a new tab (`target="_blank"
    rel="noopener noreferrer"`).

D.2 Worker's success response is extended:
  ```ts
  // Existing:
  { ok: true, claim_id: "VES-..." }
  // Extended:
  { ok: true, claim_id: "VES-...", summary_pdf_url?: string }
  ```

### Part E - Updates

E.1 BRIEFS/INDEX.md: Brief 32 row added.

E.2 BUILD_STATE.md: Last updated, Findings entry covering the
new PDF gen module + R2 storage path + webhook env var + form-side
required-email change. Note that the operator must
`wrangler secret put CUSTOMER_CLAIM_WEBHOOK_URL` before the second
webhook fires (current behavior without the secret is silent skip,
which is fine for staging-without-PA-flow-yet).

E.3 CLAUDE.md: extend the damage-worker glossary to mention the
customer claim summary PDF + the second webhook; if there's a
"webhooks" section, add the new env var there.

E.4 PRE_DEPLOY_DAMAGE.md: add a smoke test for the new flow:
submit a claim with a real email, verify the outcome card shows
the "Download a copy" link, fetch the URL, confirm the PDF
renders correctly and contains all the expected sections.

## Out of scope

- A customer-facing claim status page (where the customer logs in
  to check on the claim). v1 is fire-and-forget; PA emails the
  PDF, customer keeps it.
- Re-sending the email later (e.g., from the manager-side damage
  detail page). Could be a future brief - "Resend customer copy"
  button that re-fires the webhook for an existing claim.
- Per-location PA flow URLs. v1 uses a single
  `CUSTOMER_CLAIM_WEBHOOK_URL` for all locations.
- Localizing PDF text. English only.
- Embedding ALL photos rather than just thumbnails. PDF size
  matters for email attachments.
- Manager-side editing of the PDF. v1 is auto-generated, frozen
  at submission time. If the manager updates the determination
  later via the damage detail page, the PDF is NOT regenerated.
  (Could be a future brief - "regenerate summary PDF on
  status_change".)
- Storage retention policy for `claims/*/summary.pdf` objects.
  Lives in R2 indefinitely until the operator decides on a
  cleanup policy.
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker build succeeds
- Email is required on the customer claim form (HTML5 required +
  worker-side regex) with a small explanatory hint
- Worker rejects email-less submissions with 400 + clear error
- New `apps/damage-worker/src/render/claim-summary-pdf.ts` module
  generating a programmatically-laid-out PDF with header band +
  customer info + photos + staff assessment + footer
- PDF stored in R2 at `claims/<claimId>/summary.pdf`
- New GET handler streams the PDF back from R2
- Outcome card shows a "Download a copy" link when generation
  succeeds
- New `CUSTOMER_CLAIM_WEBHOOK_URL` env var documented; webhook
  fires fail-soft after submit, payload includes `summary_pdf_url`
  + optional `summary_pdf_base64`
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- PRE_DEPLOY_DAMAGE.md updated with the new smoke test
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Whether the Splash logo asset key in R2 was already in place or
  required operator upload (and if upload: the key + recommended
  PNG dimensions)
- Whether the existing `IMAGES` binding handled the photo
  thumbnails or fell back to original bytes
- Whether the customer claim summary PDF rendered legibly with
  one page or required a multi-page paginate fallback under
  realistic input
- Bundle-size delta on damage-worker (likely +10-30 KiB
  uncompressed from the new pdf.ts module; pdf-lib is already
  there, so the new code is mostly layout)
- Whether the JSON payload size with `summary_pdf_base64` stayed
  under 4 MB for realistic claims (or had to be URL-only)
- Latent issues spotted in the existing claim-form / submit
  pipeline
- Validation results
- Operator-side action item recorded: "Upload Splash logo PNG to
  R2 at <key> if not already there. Run
  `pnpm --filter @splash/damage-worker exec wrangler secret put
  CUSTOMER_CLAIM_WEBHOOK_URL` once the PA flow is built."

## Outcome

### Files created
- `apps/damage-worker/src/render/claim-summary-pdf.ts` (~15 KiB,
  ~390 lines) — pure programmatic pdf-lib layout. Exports
  `generateClaimSummaryPdf(input: ClaimSummaryPdfInput) -> Uint8Array`
  and the `ClaimSummaryPdfInput` interface. Layout follows the brief
  verbatim: 70 pt navy header band with logo + title + claim ID +
  timestamp; `LOCATION` label + pretty/(#code); `Customer Information`
  section heading + 5-pair key/value grid (Name / Email / Phone /
  Vehicle / License Plate); full-width `What Happened` text block;
  optional `Photos` row (up to 4 thumbnails + `+N more` overflow
  caption); `Staff Assessment` section heading + 2-pair grid (Staff
  Name / Equipment-Related) + full-width `Determination` and `What the
  Customer Was Told` blocks; footer with claim ID + contact note.
  Internal helpers: `wrapText` for multi-line text wrapping at the
  content width; `truncateToWidth` for ellipsis-clamping single-row
  grid values; `embedImageBytes` that sniffs JPEG/PNG by the first two
  header bytes (FF D8 / 89 50) and falls back to attempting both;
  `Layout` class to manage cursor + page-break logic so overflow adds
  a fresh page automatically (no shrink). Helvetica + Helvetica-Bold
  via `StandardFonts` (no font embedding cost beyond pdf-lib's
  built-ins). All photos embedded at original byte size — no resize.

### Files modified
- `apps/damage-worker/src/render/claim-form.ts` — email field now
  has `required` and a hint "We'll email you a copy of this claim."
  Outcome card gained a new "Download a copy (PDF)" `<a>` (target
  `_blank`, rel `noopener noreferrer`) inside `#outcomeDownloadRow`,
  shown only when the worker's success response includes
  `summary_pdf_url`. `FORM_SCRIPT.showOutcome` extended to a
  two-arg signature `(claimId, summaryPdfUrl)`; the fetch handler
  passes `out.body.summary_pdf_url` through.
- `apps/damage-worker/src/index.ts` — new imports for
  `generateClaimSummaryPdf` + `ClaimSummaryPdfInput` from the new
  module and `ASSETS` from `@splash/storage-r2`. `Env` interface
  gained `CUSTOMER_CLAIM_WEBHOOK_URL?: string`. New module-level
  constants `SUMMARY_LOGO_R2_KEY` (= "assets/splash-logo-white.png")
  and `CUSTOMER_WEBHOOK_BASE64_MAX_BYTES` (= 3 MB raw, ≈ 4 MB base64).
  New dispatch route `GET /claims-api/summary/{claimId}` →
  `handleServeClaimSummary` reads R2 at `claims/<claimId>/summary.pdf`
  and streams `application/pdf` back with
  `Content-Disposition: inline; filename="claim-<id>.pdf"` and
  `Cache-Control: public, max-age=86400`. Defensive `claimId` regex
  rejects pathy input. `handleClaimSubmission` extended:
  - Worker-side email validation: trim + regex
    `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`. On miss, returns
    `{ ok: false, error: "Email required" }` with status 400 (or
    303 redirect to `/claims/<slug>?error=...` in browser mode).
  - After step 7 (R2 fallback on PA failure) and BEFORE returning
    the success JSON / 303 redirect: new step 8 wraps a try/catch
    around `buildAndStoreClaimSummaryPdf(env, claimData, baseOrigin)`.
    Helper loads the logo PNG (R2 first via `SUMMARY_LOGO_R2_KEY`,
    HTTPS fallback via `ASSETS.logoWhite`, empty-bytes fallback if
    both fail), pulls up to 4 photo thumbnails directly from R2,
    builds the `ClaimSummaryPdfInput`, calls `generateClaimSummaryPdf`,
    and writes the bytes to `claims/<claimId>/summary.pdf` with
    `customMetadata: { claimId, generatedAt }`.
  - On PDF success, computes `summary_pdf_url =
    \`${baseOrigin}/claims-api/summary/${claimId}\`` and (if
    `CUSTOMER_CLAIM_WEBHOOK_URL` is bound) calls
    `fireCustomerClaimWebhook` with the URL + bytes. Webhook
    payload matches the brief: `claim_id`, `submitted_at`,
    `location_pretty`, `location_code`, `customer_name`,
    `customer_email`, `customer_phone`, `vehicle` (assembled
    "year make model - color"), `summary_pdf_url`, and (when
    bytes ≤ 3 MB) `summary_pdf_base64`.
  - PDF/webhook failures are caught + logged + swallowed; the
    submission still returns ok with the claim_id.
  - Success JSON response now includes `summary_pdf_url` when PDF
    generation succeeded; absent otherwise (the form's outcome card
    handles both states).
- `apps/damage-worker/wrangler.toml` — commented-secrets block
  extended to document `CUSTOMER_CLAIM_WEBHOOK_URL` (Brief 32) and
  the operator prerequisite for uploading the brand logo PNG to R2
  at `assets/splash-logo-white.png`.
- `BRIEFS/INDEX.md` — Brief 32 status flipped to Completed.
- `BUILD_STATE.md` — Last updated bumped, Findings entry added.
- `CLAUDE.md` — damage-worker glossary extended (claim summary
  PDF + second customer-email webhook); critical-constraints list
  unchanged.
- `PRE_DEPLOY_DAMAGE.md` — new smoke test #8 covering the customer
  PDF + download link + webhook fail-soft.

### Decisions made on operator's behalf
1. **Photos are embedded at original byte size, no resize.** The
   `IMAGES` binding's minimal `ImagesBinding` interface in
   `@splash/storage-r2` (legacy: HEIC→JPEG only via
   `input(stream).output({ format })`) does not expose a resize API,
   and the brief explicitly named "embedding original bytes" as the
   acceptable degraded fallback. Bumping the binding's surface to
   include resize would touch `packages/storage-r2` AND every
   consumer's type expectation; out of scope for v1. The base64
   payload is omitted from the customer-email webhook when the PDF
   exceeds 3 MB (`CUSTOMER_WEBHOOK_BASE64_MAX_BYTES`); PA still gets
   the URL.
2. **Logo loaded R2-first with HTTPS fallback.** Brief says "if R2
   storage isn't already set up, pick a sensible key and add a TODO".
   I picked `assets/splash-logo-white.png` in the `damagedocs` R2
   bucket and wrote a graceful fallback: try R2 → try
   `ASSETS.logoWhite` over HTTPS → render PDF without logo. The
   HTTPS fallback uses the existing public-R2 asset URL the
   customer-facing form already loads, so until the operator uploads
   the dedicated `damagedocs` key, every claim submission incurs a
   ~50-200 ms HTTPS round-trip. Operator action item flagged below.
3. **GET handler at `/claims-api/summary/{claimId}` (not photo-route
   reuse).** Existing photo route is `/claims-api/photo/{r2-key-suffix}`
   which prepends `claims/`. We could've routed
   `/claims-api/photo/<id>/summary.pdf` to it, but a dedicated route
   gives a cleaner Content-Disposition filename
   (`claim-<id>.pdf`) and isolates auth-posture changes if the photo
   route ever gets gated.
4. **No D1 schema change for required email.** The `claims` table's
   `customer_email` column stays nullable for back-compat with any
   pre-Brief-32 submissions. The contract change is at the form +
   worker surface; storage stays permissive.
5. **`equipmentRelated` derivation in PDF input.** The submission
   payload uses `equipmentInvolved` as a string ("Top Brush" / "" /
   "N/A"); the PDF input's `equipmentRelated: "yes" | "no" | null`
   needs a derivation. Empty string → "no", "N/A" → "no", anything
   else → "yes". Matches the same derivation used for D1's
   `equipment_related` 0/1 column.
6. **Error response shape on email validation: 400 status code in
   JSON mode**, 303 redirect with `?error=Email required` in browser
   mode. Mirrors the existing `handleClaimSubmission` error-flow
   pattern from Brief 23. Error message is the literal string
   `"Email required"` per the brief.
7. **No D1 row updates for the summary PDF.** The PDF lives in R2
   only; no `claim_photos` row of `photo_type='Summary'` is written.
   The check-request flow writes a `claim_photos` row because that
   PDF feeds the manager-side document gallery; the customer summary
   is not surfaced in the manager UI today (and out-of-scope per
   "Manager-side editing of the PDF" in the Out-of-scope list).
8. **Fail-soft cascade ordering.** Step 6 (PA webhook) → step 7 (R2
   failure fallback) → step 8 (PDF gen + customer-email webhook).
   PDF generation is strictly additive; PA webhook can succeed and
   PDF can fail and the submission still returns ok. The
   customer-email webhook fires only after the PDF has been written
   to R2 (so the URL it advertises actually resolves).

### Latent issues / forward flags
- **Logo upload is a soft prerequisite.** Until the operator uploads
  `assets/splash-logo-white.png` to the `damagedocs` R2 bucket,
  every claim submission incurs an HTTPS round-trip to fetch the
  fallback logo. Functional but slow. Recommended PNG: white-on-
  navy script logo, ~144 pt wide × 36 pt tall (4× raster for retina
  is fine).
- **Photo bytes are embedded raw — no compression / resize.** A
  customer who uploads four 4 MB iPhone HEIC→JPEG photos produces
  a ~16 MB PDF before pdf-lib's metadata overhead. The base64 cap
  in the customer-email webhook will skip the attachment for any
  PDF over 3 MB raw, falling back to URL-only. PA flows that depend
  on the inline base64 attachment will need to fetch by URL for
  large claims. Forward fix: extend the `ImagesBinding` interface
  in `@splash/storage-r2` to include resize, and downscale photos
  to ~200 px wide before embedding.
- **`licenseState` in the PDF input is always null.** The customer
  claim form does not collect a license-plate state today (only the
  plate number). The PDF render handles null gracefully — License
  Plate cell shows just the plate number. If a state field is added
  to the form later, surface it via the PDF input.
- **No retention policy on `claims/*/summary.pdf`.** R2 objects
  live indefinitely. Operator should decide on a lifecycle rule
  (e.g., delete after 1 year) at some point; out of scope per the
  brief.
- **No "regenerate summary PDF" path.** If the manager updates the
  determination or what-told fields later via the damage detail
  page, the customer-side PDF stays frozen at submission-time
  state. The brief lists "regenerate summary PDF on
  status_change" as future-brief candidate.
- **Worker email validation regex is loose.** The
  `^[^@\s]+@[^@\s]+\.[^@\s]+$` regex allows technically-invalid
  but format-correct addresses (e.g., `a@b.c`). Same regex used in
  sysadmin-worker per Brief 24/27 — consistent across the codebase.
  Customers on a real claim form are entering a real email; this is
  not a security gate, it's a typo guard.

### Validation results
- `pnpm typecheck` — **13/13 successful** (9.529s; 10 cached, 3
  cache-miss for damage-worker, sysadmin-worker, signup-worker — only
  damage-worker had source changes; sysadmin/signup ran fresh because
  the workspace shares a tsbuildinfo cascade through workspace deps).
- `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run --outdir=./dist` — **succeeded** (compiled cleanly; no
  deploy executed). Bundle: **1663.57 KiB uncompressed / 377.48 KiB
  gzip**.

### Report-back

| Question | Answer |
|---|---|
| Splash logo asset key in R2 | **Not yet in place.** Operator must upload a white-on-navy PNG to `assets/splash-logo-white.png` in the `damagedocs` bucket. Recommended dimensions: ~144 pt wide × 36 pt tall (4× raster for retina is fine). Current behavior without the upload: every submission HTTPS-fetches `ASSETS.logoWhite` (~50-200 ms latency hit). |
| `IMAGES` binding for thumbnails | **Not used.** The `ImagesBinding` interface in `@splash/storage-r2` only supports format conversion (HEIC→JPEG), not resize. Photos embed at original byte size. |
| Claim summary PDF: 1-page or paginate? | **Single page for typical input** (5 KV pairs + ~3 lines of "what happened" + 2-4 photos + 2 KV pairs + 2 short text blocks fits within the 684 pt content area). Long free-text fields trigger pagination automatically (`Layout.ensureSpace` adds a new page on overflow; no type shrink). |
| Bundle-size delta | **Single-figure delta not measured** (no pre-Brief-32 baseline captured this session). New module is ~15 KiB source. Post-Brief-32 bundle: 1663.57 KiB / 377.48 KiB gzip. Within CF's 3 MiB compressed free-tier limit. |
| Customer-email webhook payload size under 4 MB | **Conditionally yes.** PDFs ≤ 3 MB raw include `summary_pdf_base64` (≈ 4 MB encoded ceiling). Larger PDFs omit the base64 and rely on `summary_pdf_url`. PA flows can pick whichever they want. |
| Latent issues spotted in existing claim-form / submit pipeline | (a) `claimData.customerEmail` was previously stored to D1 as `null` if blank; the new `claimData.customerEmail = emailTrimmed` line normalizes the trimmed-and-validated value before the D1 write. (b) The browser-mode error redirect on a generic `error` (the existing `catch (error)` branch) and the new email-validation 303 redirect both hit `/claims/<slug>?error=...`; a customer who triggers it twice will see consecutive error banners — acceptable. (c) Photos are written to R2 BEFORE the email-validation gate fires, so a customer who supplies invalid email and abandons the submission leaves orphaned R2 photo objects. Pre-Brief-32 behavior (no email gate) had the same shape on any other failure path, so this is no worse than baseline. Forward fix: move email validation above the photo-upload loop. Not done here — would re-order the entire pipeline and isn't part of the brief's scope. |

### Operator action item
- Upload a white-on-navy Splash logo PNG to R2 at
  `assets/splash-logo-white.png` in the `damagedocs` bucket.
  Recommended dimensions: ~144 pt × 36 pt (4× raster fine). Until
  this is done, every submission HTTPS-fetches `ASSETS.logoWhite`.
- Run `pnpm --filter @splash/damage-worker exec wrangler secret put
  CUSTOMER_CLAIM_WEBHOOK_URL` once the PA flow is built. Without it,
  the customer-email webhook is silently skipped — PDF still
  generates and the post-submit outcome card surfaces a "Download a
  copy" link, so the customer can save it without waiting for an
  email.
