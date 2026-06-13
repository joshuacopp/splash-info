# Brief 171: Check Request — bundle the approved quote into the PDF (with link fallback)

**Status:** Completed (2026-06-13)
**Drafted:** 2026-06-13

**Why:** When a damage claim's quote is approved, the worker generates a
Check Request PDF (AcroForm template fill) and emails it to Incidents
(on RM approve) and then AP (on submit-for-payment). Today that PDF
contains only the check-request form fields — **not the approved quote
itself.** AP has to go find the quote separately to cut the check.
Operator: "I need the check request to include the approved quote in the
PDF (as a separate page)" — with a link-to-the-quote fallback for cases
where bundling isn't possible.

**Decision already made by the operator (do not re-litigate):** bundle
the quote **into the check-request PDF as appended page(s)** as the
primary behavior. A view/download **link** in the webhook payload is the
**fallback** only (used when the quote can't be safely embedded — wrong
type, too large, or conversion fails). This is the "Bundle into the PDF"
option, with the size-cap + link-fallback explicitly included.

**Dependencies:** Brief 32 (claim summary PDF + pdf-lib in this worker),
Brief 146 (`uploads.ts` HEIC→JPEG conversion via the `IMAGES` binding —
reuse that pattern), Brief 104 (the `/claims-api/photo/...` URL build:
strip leading `claims/` + URL-encode segments).

## Read first

- BUILD_STATE.md
- CLAUDE.md — the **"claim summary PDF"** and **check-request** notes
  (the AcroForm template prereq `templates/check-request.pdf`, the
  `INCIDENTS_WEBHOOK_URL` / `AP_WEBHOOK_URL` fail-soft posture).
- `apps/damage-worker/src/pdf.ts` — **the file this brief changes.**
  `generateCheckRequestPdf` (AcroForm fill + flatten + save),
  `storeCheckRequestPdf` (generate → R2 → claim_photos insert),
  `sendCheckRequestEmail` (webhook payload — base64 PDF), and
  `runCheckRequestPdfStep` (orchestrator; two call sites: Incidents + AP).
- `apps/damage-worker/src/index.ts` — the transition handler that calls
  `runCheckRequestPdfStep` (grep `runCheckRequestPdfStep`), the
  approved-quote selection (grep `approved_quote_id` / `photo_type === "Quote"`,
  ~line 1631 and ~1820–1830), the check-request **preview** path (same
  `generateCheckRequestPdf` call), and `DOCUMENT_ALLOWED_MIME`
  (quotes can be `application/pdf` / `image/jpeg` / `image/png` /
  `image/heic` / `image/heif`, ≤ 10 MB).
- `apps/damage-worker/src/uploads.ts` — the existing `IMAGES` binding
  HEIC→JPEG conversion (reuse the exact `env.IMAGES.input(...).output(...)`
  pattern; do NOT invent a new one).
- `apps/damage-worker/src/notifications.ts` — `ClaimPhotoForWebhook` +
  the `/claims-api/photo/...` URL build (strip `claims/` prefix +
  URL-encode) used by `fireInternalNewClaimNotification` (Brief 104).
- `apps/damage-worker/wrangler.toml` — confirms the `[images] binding =
  "IMAGES"` and `R2_BUCKET` bindings are present.

## Architecture context

The approved quote is a `claim_photos` row (`photo_type = 'Quote'`)
already passed into `storeCheckRequestPdf` / `buildCheckRequestFields` as
the `quote: ClaimPhotoRow` argument. It carries `r2_key`, `content_type`,
`vendor`, `amount`, `pay_to_type`. The quote *file* lives in R2 at
`quote.r2_key`. Both Check Request call sites (Incidents on RM-approve,
AP on submit-for-payment) flow through `runCheckRequestPdfStep →
storeCheckRequestPdf → generateCheckRequestPdf`, so a change inside the
generate step benefits **both** recipients automatically.

pdf-lib is already a dependency. It can `copyPages` from another PDF and
`embedJpg` / `embedPng` images — but it **cannot embed HEIC/HEIF**. The
worker has the Cloudflare `IMAGES` binding (used in `uploads.ts` to
convert HEIC→JPEG); reuse it for HEIC quotes.

## Scope

All changes are in `apps/damage-worker/src/`. The whole quote-append step
is **best-effort / fail-soft**: any failure logs and falls back to the
link, and NEVER blocks the check-request PDF, the R2 write, the webhook,
or the status transition.

### Phase 1 — `pdf.ts`: append the quote to the generated PDF

1.1 Add constants near the top of `pdf.ts`:

```ts
// Quotes larger than this are NOT embedded into the check-request PDF
// (base64-in-webhook size guard). They fall back to a link instead.
const QUOTE_BUNDLE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB raw quote file
```

1.2 New exported helper `appendQuoteToPdf`:

```ts
/**
 * Best-effort: append the approved quote to `pdfDoc` as extra page(s).
 * Returns true if the quote was embedded, false if it must fall back to
 * a link (unsupported/oversized/conversion-failed/read-failed). NEVER throws.
 *
 *  - application/pdf      → copyPages + addPage for each quote page
 *  - image/jpeg           → embedJpg → one fitted page
 *  - image/png            → embedPng → one fitted page
 *  - image/heic|heif(+seq)→ convert to JPEG via env.IMAGES, then embedJpg
 *  - anything else / IMAGES unbound / decode error / size > cap → return false
 */
export async function appendQuoteToPdf(
  pdfDoc: PDFDocument,
  bucket: R2Bucket,
  images: ImagesBinding | undefined,   // env.IMAGES (optional)
  quote: ClaimPhotoRow
): Promise<boolean>
```

Implementation notes:
- Read the quote bytes from R2 with the **same key convention the rest of
  the worker uses to read `claim_photos` objects** — confirm against
  `serveClaimPhoto` / `storeCheckRequestPdf` (which stores
  `r2_key = claims/{claim_id}/{filename}`). Use `bucket.get(quote.r2_key)`
  directly if the stored key already includes the `claims/` prefix; do
  NOT double-prefix (Brief 104 footgun). If `bucket.get` returns null →
  return false.
- Size guard: if `obj.size > QUOTE_BUNDLE_MAX_BYTES` → return false (link
  fallback) without downloading the whole body if avoidable.
- Determine type from `quote.content_type`; if null/empty/generic, sniff
  with `file-type` (already a worker dep) from the first ~4 KB.
- **PDF branch:** `const q = await PDFDocument.load(bytes)` inside
  try/catch (encrypted/corrupt → return false); `const pages =
  await pdfDoc.copyPages(q, q.getPageIndices()); pages.forEach(p =>
  pdfDoc.addPage(p));`.
- **Image branch:** add a Letter page (`pdfDoc.addPage([612, 792])`),
  draw a small header label (`"Approved Quote" + (quote.vendor ? " — " +
  quote.vendor : "")`) near the top margin, embed the image
  (`embedJpg`/`embedPng`), scale to fit within ~0.5in margins preserving
  aspect ratio, center it. (Match the existing claim-summary-pdf image
  layout helpers if they're reusable.)
- **HEIC/HEIF branch:** convert bytes→JPEG via the `uploads.ts` IMAGES
  pattern; on success embed as JPEG; on failure or unbound IMAGES →
  return false.
- Wrap the whole body in try/catch → log `[checkreq.quote] append failed
  (fallback to link): ...` and return false.

1.3 Wire it into `generateCheckRequestPdf`. Extend the signature to take
the quote + images binding and append **after the AcroForm fill but
BEFORE `form.flatten()` / `pdfDoc.save()`**:

```ts
export async function generateCheckRequestPdf(
  bucket: R2Bucket,
  fields: CheckRequestFields,
  quote: ClaimPhotoRow,            // NEW
  images: ImagesBinding | undefined // NEW
): Promise<{ pdfBytes: Uint8Array; quoteBundled: boolean }>   // shape change
```

- Return `quoteBundled` so the caller can decide whether to include the
  link in the webhook. (Update `storeCheckRequestPdf` to thread it out via
  `StoredCheckRequestPdf`.)
- Append the quote pages, THEN `form.flatten()` (flatten only the
  template's form fields — copied PDF pages have no fields, images are
  drawn content; flatten stays safe), THEN `save()`.

1.4 Thread `images` + `quote` + `quoteBundled` through `storeCheckRequestPdf`
and `runCheckRequestPdfStep` (both already receive `quote` and `bucket`;
add an `images: ImagesBinding | undefined` arg). Update the two call
sites in `index.ts` (real transition + preview) to pass `env.IMAGES`.

### Phase 2 — `pdf.ts`: link fallback in the webhook payload

2.1 In `sendCheckRequestEmail`, **ADD** (never rename/remove — PA's Parse
JSON depends on the existing names) two fields to the payload:

```ts
quoteUrl: <built from quote.r2_key like notifications.ts: strip leading
           "claims/", URL-encode each segment, prefix
           "https://splashcarwashes.info/claims-api/photo/">,
quoteBundled: boolean   // true when the quote is already inside pdfBase64
```

  - Always send `quoteUrl` (cheap, and it's the canonical reference).
  - PA can show the "View/Download Quote" link only when `quoteBundled`
    is false (operator wires that condition in the AP + Incidents email
    templates — note it in the Outcome for the operator to action).
  - `quoteUrl` is null/"" when the quote has no `r2_key`.

### Phase 3 — activity-log note

3.1 In `runCheckRequestPdfStep`, extend the existing note text to record
the outcome: append `" Quote bundled into PDF."` when `quoteBundled`,
else `" Quote too large/unsupported to bundle — link included."` So the
claim timeline shows which path fired.

## Out of scope (v2 / not now)

- Receipts (only the **approved quote** is bundled).
- Bundling multiple quotes (only the single approved quote).
- Re-rendering / back-filling Check Requests generated before this brief.
- Operator-tunable size cap UI (the constant is fine for v1).
- Any Power Automate flow edits — those are operator actions noted in the
  Outcome (add the conditional "View Quote" link to the AP + Incidents
  email templates, keyed on `quoteBundled === false`).

## Definition of Done

- `appendQuoteToPdf` implemented with all four type branches + the
  size-cap + fail-soft fallback; `generateCheckRequestPdf` /
  `storeCheckRequestPdf` / `runCheckRequestPdfStep` threaded with `quote`
  (already present) + `images` + `quoteBundled`; both `index.ts` call
  sites (real + preview) pass `env.IMAGES`.
- Webhook payload gains `quoteUrl` + `quoteBundled` (additive only;
  existing field names unchanged).
- `pnpm typecheck` passes.
- `pnpm --filter @splash/damage-worker build` passes.
- Code review confirms the append is fully fail-soft (no path throws out
  of `generateCheckRequestPdf` due to the quote) and `form.flatten()`
  still runs.
- Update `BUILD_STATE.md` (Last updated + Findings entry) and the
  CLAUDE.md check-request / claim-summary-PDF glossary note to mention
  the bundled-quote behavior + the `quoteUrl`/`quoteBundled` payload
  fields.
- Set this brief's Status to `Completed (YYYY-MM-DD)` and fill the Outcome
  section, including the **operator action item**: add the conditional
  "View/Download Quote" link to the AP + Incidents PA email templates
  (show only when `quoteBundled` is false), and confirm
  `templates/check-request.pdf` is uploaded to the `damagedocs` R2 bucket
  (still the prereq for ANY check-request PDF to generate).

## Outcome

### Files modified

- `apps/damage-worker/src/pdf.ts` — Phases 1-3. New
  `QUOTE_BUNDLE_MAX_BYTES = 5 * 1024 * 1024` constant. New exported
  helper `appendQuoteToPdf(pdfDoc, bucket, images, quote): Promise<boolean>`
  with all four type branches (`application/pdf`, `image/jpeg`,
  `image/png`, `image/heic|heif(+sequence)`); size-cap on
  `obj.size` before downloading; MIME sniff fallback via
  `file-type` when `quote.content_type` is empty or
  `application/octet-stream`; HEIC branch uses the
  `env.IMAGES.input(stream).output({format:"image/jpeg"})` pattern
  verbatim from `packages/storage-r2/src/index.ts:109`; fully
  fail-soft — every failure path logs `[checkreq.quote] append
  failed (fallback to link): ...` and returns false. Two private
  helpers `appendPdfQuotePages` + `appendImageQuotePage`. New
  private `buildQuoteUrl` helper mirroring `notifications.ts`'s
  Brief 104 strip-`claims/`-and-URL-encode-segments shape.
  `generateCheckRequestPdf` signature widened additively —
  `quote?: ClaimPhotoRow` + `images?: ImagesBinding` optional,
  return shape changed `Uint8Array` → `{ pdfBytes: Uint8Array,
  quoteBundled: boolean }`. Append fires AFTER the AcroForm fill
  but BEFORE `form.flatten()` / `save()`. `storeCheckRequestPdf`
  gained a required `images: ImagesBinding | undefined` arg and
  threads `quoteBundled` out via the extended `StoredCheckRequestPdf`
  shape. `runCheckRequestPdfStep` gained the same `images` arg.
  `sendCheckRequestEmail` now takes a `quoteBundled` arg and adds
  `quoteUrl` (always sent) + `quoteBundled` to the webhook
  payload (additive only — every legacy field name unchanged).
  Activity-log note appends `" Quote bundled into PDF."` /
  `" Quote too large/unsupported to bundle — link included."` on
  both success and email-failure code paths.

- `apps/damage-worker/src/index.ts` — three call-site updates.
  RM-approve transition site (around L1799) passes `images:
  env.IMAGES` to `runCheckRequestPdfStep`. Submit-for-payment
  transition site (around L1836) passes `images: env.IMAGES`.
  Preview path `handleCheckRequestPreview` calls
  `generateCheckRequestPdf(env.R2_BUCKET, fields, quote, env.IMAGES)`
  and destructures `pdfBytes` from the returned object — preview
  also bundles the approved quote so reviewers see exactly what
  AP / Incidents will receive.

- `BUILD_STATE.md` — bumped "Last updated" header to 2026-06-13;
  added a Findings & decisions log row covering Brief 171.

- `CLAUDE.md` — added a new **Check Request PDF** glossary entry
  immediately after the **claim summary PDF** entry, documenting
  the AcroForm template prereq, the two fire-points (RM Approve
  Quote → Incidents; Submit for Payment → AP) + preview path, and
  the Brief 171 bundled-quote behavior including the four type
  branches, the size guard, the fail-soft posture, and the
  `quoteUrl` + `quoteBundled` webhook payload fields.

### Files created

None. Brief 171 was a two-file diff (`pdf.ts` + `index.ts`) plus
the BUILD_STATE / CLAUDE.md / brief Outcome updates.

### Decisions made on the operator's behalf

1. Made `quote` + `images` OPTIONAL on `generateCheckRequestPdf`
   so the signature stays backwards-compatible. Required params
   would have forced every theoretical future preview / form-only
   caller to thread `env.IMAGES` even when they don't care about
   bundling. The intent (always bundle when available) is
   preserved by every CURRENT caller passing both.

2. Read raw bytes from R2 via `obj.arrayBuffer()` after the
   `obj.size > QUOTE_BUNDLE_MAX_BYTES` size guard rather than
   streaming. Keeps the helper synchronous-shaped and lets
   `embedJpg` / `embedPng` / `PDFDocument.load` work against a
   single `Uint8Array` slice. The 5 MB cap caps worst-case heap
   footprint at ~5 MB.

3. MIME sniff fallback when `quote.content_type` is `""` or
   `application/octet-stream`. Defensive against pre-Brief-92
   docs uploaded before the worker started enforcing MIME types,
   and against HEIC files where the platform sometimes serves an
   empty content-type.

4. Image-branch header label uses
   `pdf-lib`'s `StandardFonts.HelveticaBold` (no extra font
   bytes) at `rgb(0.04, 0.16, 0.34)` (splash-navy-ish, picked to
   match the claim-summary-PDF header band approximately) without
   importing from `claim-summary-pdf.ts` — keeps the two files
   decoupled.

5. `buildQuoteUrl` lives inside `pdf.ts` (NOT promoted to
   `@splash/storage-r2` or `notifications.ts`) because it's only
   used by one call site today; promote when a second consumer
   materializes.

6. Activity-log note suffix carries the bundle outcome on BOTH
   the success path AND the email-failure path so the timeline
   records what was attempted even when the webhook downstream
   failed.

7. `quoteUrl` is sent ALWAYS (not only when `quoteBundled ===
   false`) so the canonical reference is always in the payload —
   gives PA flexibility to surface it as a secondary download
   link if AP ever wants both. The brief's wording was "Always
   send `quoteUrl` (cheap, and it's the canonical reference)."

8. Wrapped the entire `appendQuoteToPdf` body in a top-level
   try/catch as belt-and-suspenders. Every internal branch
   already returns false on its own failures, but a thrown bug
   (e.g., the next `pdf-lib` version moving a deprecated symbol)
   would otherwise propagate up and crash
   `generateCheckRequestPdf`.

9. Preview path consumes `generated.pdfBytes` from a destructure
   rather than the legacy single-value shape — keeps the call
   site identical to the production transition paths so future
   copy-paste maintenance doesn't accidentally diverge them.

### Latent issues / forward flags

- Pre-Brief-171 Check Request PDFs are NOT back-filled —
  historical `claim_photos` rows of `photo_type = 'Check Request'`
  continue to point at form-only PDFs. Out of scope per the
  brief's `## Out of scope` section.

- Size cap `QUOTE_BUNDLE_MAX_BYTES = 5 MB` is a compile-time
  constant; operator-tunable UI deferred to v2 per scope.

- HEIC branch silently falls back to link when `env.IMAGES` is
  unbound. `apps/damage-worker/wrangler.toml` `[images] binding =
  "IMAGES"` is already present (verified at line 171-172), so
  this only surfaces if a future env removes the binding.

- Receipts intentionally NOT bundled (only the single approved
  quote). Bundling multiple quotes intentionally NOT supported
  (only the single one referenced by `claims.approved_quote_id`).

- The conditional "View/Download Quote" link in the AP +
  Incidents PA email templates is an operator action item
  recorded below — until that lands, oversized / unsupported
  quotes will still email with the form-only PDF and operators
  just lose the convenience link.

### Validation

- `pnpm typecheck` — **21/21 successful** (10.4s). All workspace
  packages green.

- `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run --outdir=.wrangler/dry-run` — **✓**. Bundle 1869.91
  KiB raw / 425.76 KiB gzip (+1.10 KiB raw / +1.16 KiB gzip vs
  Brief 168's 1864.16 / 424.60 baseline). Bindings surface
  confirms `env.IMAGES` (Images) still present alongside
  `env.R2_BUCKET (damagedocs)`, `env.DB (splash-damage-claims)`,
  `env.MAINTAINX_MODE ("test")`, `env.MAINTAINX_BASE_URL
  ("https://api.getmaintainx.com/v1")`, `env.APPS_WEB_BASE_URL
  ("https://splashcarwashes.info")`, and `env.INCIDENTS_EMAIL
  ("incidents@splashcarwashes.com")`. `.wrangler/dry-run`
  artifact directory NOT cleaned up — this is local-only working
  state, not under git.

- The damage-worker `package.json` exposes a `typecheck` script
  but no separate `build` script — `wrangler deploy --dry-run` is
  the canonical Workers bundle build, used here as the build
  step the brief's Definition of Done required.

- Code review confirms the append is fully fail-soft (no path
  throws out of `generateCheckRequestPdf` due to the quote step;
  the top-level try/catch in `appendQuoteToPdf` swallows any
  internal-branch throws and returns false) and `form.flatten()`
  still runs after the quote append regardless of bundle
  outcome.

### Operator action items

1. **Wire the conditional "View/Download Quote" link in BOTH the
   AP and Incidents Power Automate email templates.** The
   webhook payload now carries `quoteUrl` (always sent) +
   `quoteBundled: boolean`. Surface the "View/Download Quote"
   link ONLY when `quoteBundled === false` (PA expression:
   `equals(triggerBody()?['quoteBundled'], false)`). Link target
   is `triggerBody()?['quoteUrl']`. When `quoteBundled` is true
   the quote is already inside `pdfBase64`, so the link would be
   redundant.

2. **Confirm `templates/check-request.pdf` is uploaded to the
   `damagedocs` R2 bucket.** This is still the prereq for ANY
   check-request PDF to generate, including the appended-quote
   variant. When missing, `generateCheckRequestPdf` throws
   `Check request template not found in R2 at templates/check-
   request.pdf` and the worker's existing fail-soft activity-log
   path fires (status transition still commits).

3. **No CF deploy, no production-route binding, no git commit
   performed by this brief** (per CLAUDE.md). Working-tree
   changes only; operator pushes when ready.
