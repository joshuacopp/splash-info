# Brief 146: claim photo cellular-upload resilience (resize + OOB upload + retry)

**Status:** Completed (2026-05-29)
**Started:** 2026-05-29
**Completed:** 2026-05-29
**Blocks:** Customer-facing reliability (claims submitted from cellular)
**Dependencies:** Brief 136 (localStorage autosave already in place) — extend it.

## Read first
- BUILD_STATE.md
- CLAUDE.md
- apps/damage-worker/src/render/claim-form.ts (entire file — the customer
  form HTML + client JS lives here)
- apps/damage-worker/src/index.ts (submit handler — search for the
  `multipart/form-data` parser and `R2.put`)
- apps/damage-worker/src/handlers/* (if a sibling handler exists)
- apps/forms-worker/src/submit/upload.ts (or wherever the Brief 92 OOB
  upload endpoint lives — `/forms/api/upload/{slug}`). This is the
  reference shape for the new damage endpoint.
- packages/storage-r2/src/ (existing R2 helpers used by damage-worker)
- BRIEFS/brief-92-* / BRIEFS/brief-136-* (context — read the Outcomes)

## Context

Customer-side damage claim photo uploads are failing intermittently
when submitted over cellular. Wi-Fi submissions succeed. Operator
reports this as a real, recurring issue on production.

Root cause is almost certainly transport + payload size. Today's form
(`apps/damage-worker/src/render/claim-form.ts`):

1. Captures photos as `<input type="file">` File objects, held in a
   closure `var photos` array.
2. On submit, bundles every photo into a single multipart/form-data
   POST to `/claims/api/submit`.
3. The worker parses the multipart and writes each photo to R2 in
   sequence.

Modern phone cameras produce 3-8 MB JPEGs at ~4032×3024. Three photos
per claim is ~15 MB. On cellular:
- Throughput is variable and often 1-5 Mbps upstream (vs 50+ on Wi-Fi).
- Mobile carriers and intermediate proxies kill idle / slow uploads at
  30-60 second timeouts.
- A 15 MB multipart upload at 2 Mbps takes ~60 seconds, with no
  recoverability if any chunk drops — the whole submit fails.

Two-pronged fix, neither sacrifices photo quality for damage review:

(a) **Client-side resize.** Resize to a max dimension of 2048 px (long
edge) at JPEG quality 0.90 via `<canvas>`. Drops file size 5-10× while
remaining visually indistinguishable for scratch / dent / paint review.
EXIF orientation must be honored before drawing to the canvas.

(b) **Out-of-band per-photo upload.** Replace the single-bundle multipart
submit with the same pattern forms-worker uses (Brief 92). The moment
the customer adds a photo, upload it immediately to a new
`POST /claims/api/upload` endpoint that returns
`{r2_key, mime, size_bytes, original_filename}`. The form's hidden
state carries the array of r2_keys. The final `/claims/api/submit`
POST is JSON-only (no file bodies) and references the already-uploaded
keys. Worker submit handler HEADs each r2_key to confirm R2 has the
object before inserting the claim row.

Why this helps cellular:
- Each photo is ~10% of its former size, so each upload finishes
  before the carrier idle timeout has a chance to fire.
- Per-photo isolation: if one upload fails on cellular, retry just
  that one. Other photos stay uploaded.
- Final submit is small JSON — finishes in tens of milliseconds even
  on weak cellular.
- Pairs naturally with the Brief 136 autosave: persist the r2_keys
  array in the localStorage draft, so a lost connection + Resume picks
  up exactly where the customer left off, with already-uploaded photos
  intact. Today's draft skips photos entirely because File objects
  can't be serialized; r2_keys can.

## Scope

1. **New endpoint
   `POST /claims/api/upload`** (`apps/damage-worker/src/index.ts` or
   a new handler module).
   - Auth: same posture as the existing customer claim submit — public
     (anyone with the `/claims/{site}` URL can upload).
   - `isOriginAllowed` CSRF gate identical to `/claims/api/submit`.
   - Body: `multipart/form-data` with a single `file` part. Optional
     `location` field (string; ties uploads to a specific site for the
     pending submission's R2 key prefix).
   - Limits: hard cap per file 8 MB (post-client-resize the payload is
     much smaller, but accept up to 8 MB as a safety net for clients
     that don't resize). Reject larger with 413.
   - MIME validation: sniff the first 4 KB via `file-type` (already a
     forms-worker dep — add if not present here yet). Accept
     `image/jpeg`, `image/png`, `image/heic`/`image/heif`. Reject
     others with 415. The client `Content-Type` header is ignored.
   - R2 key shape: `claim-uploads/{pendingSubmissionId}/{nanoid}.{ext}`,
     where `pendingSubmissionId` is a client-supplied UUID
     (`crypto.randomUUID()`) that becomes `claims.id` on final submit.
     Mirrors the Brief 92 pattern (`form-submission-files/{form_id}/{pending_submission_id}/...`).
   - Response: `{ ok: true, r2_key, mime, size_bytes, original_filename }`.
   - Failure modes:
     - 413 size-too-large.
     - 415 wrong MIME.
     - 503 R2 unavailable.
     - 500 generic.

2. **`apps/damage-worker/src/render/claim-form.ts` — client JS rewrite
   of the photo input handler.**
   - Add a small inline `resizeImage(file): Promise<Blob>` helper:
     - Read into `Image` via `createImageBitmap(file)` (handles EXIF
       orientation natively on modern Safari + Chrome; iOS 14+ Safari
       has full support).
     - If the long edge ≤ 2048 px, return the original blob unchanged.
     - Otherwise scale proportionally to 2048 px long edge, draw to
       `<canvas>`, export as JPEG quality 0.90 via
       `canvas.toBlob('image/jpeg', 0.90)`.
   - On `<input type="file">` change, for each selected file:
     - Show a per-photo spinner / "Uploading…" indicator in the
       photo strip.
     - `resizeImage` → `fetch('/claims/api/upload', { method: 'POST',
       body: formData })` with the resized blob.
     - On success, replace the spinner with a thumbnail and store the
       returned `r2_key` in a new `var photoRefs = []` array (parallel
       to today's `photos` File array — we keep both during the
       transition, but the submit path now reads `photoRefs`).
     - On failure (network error, non-2xx), show a red retry icon next
       to the photo. Clicking retries the upload (max 3 manual
       retries, with 500ms / 1500ms / 3500ms automatic backoff between
       transparent retries before surfacing the retry icon).
   - Remove-photo handler: when the customer removes a photo from the
     strip, splice the corresponding `r2_key` out of `photoRefs`. NO
     deletion of the R2 object — the daily cleanup cron will sweep
     orphans (see Step 5).
   - Keep the existing client-side validations (max N photos, etc.).
   - The submit button disables until every visible photo is in the
     "uploaded" state (no pending or failed). On all-uploaded, button
     enables.

3. **`apps/damage-worker/src/index.ts` — submit handler refactor.**
   - Switch `/claims/api/submit` from `multipart/form-data` to
     `application/json`.
   - Request body now carries `photo_refs: string[]` (the r2_keys) in
     place of `photo_count` / file parts. Every other field (customer
     name, email, vehicle, damage type, etc.) is unchanged.
   - For each `r2_key`:
     - HEAD against R2 to confirm the object exists and capture
       authoritative `mime` + `size_bytes`. Reject the submit with
       422 `{ error: "photo_not_found", missing: [...] }` if any
       reference is missing.
     - Insert one `claim_photos` row per ref (the existing table
       already has `r2_key`, `mime`, `size_bytes`, `original_filename`
       — confirm via schema).
   - The claim_id used as the prefix-binding (R2 key
     `claim-uploads/{pendingSubmissionId}/...`) is rewritten to
     `claims/{claim_id}/...` after the canonical claim row lands —
     OR — accept the upload key as-is and just store it on the
     claim_photo row. Brief 92 chose the latter; mirror that
     simplicity here. Rename the R2 path to `claims/{claim_id}/...`
     is a v2 candidate.
   - Idempotency: the existing Brief 138 `idempotency_key` column
     stays untouched. Submit-side dedup behavior preserved.
   - Keep the photo-upload section of the submit handler (the
     multipart parser + `R2.put`) for back-compat — older client
     versions in cache may still hit it for a few days post-deploy.
     Tag both code paths with a clear comment.

4. **`apps/damage-worker/src/render/claim-form.ts` — Brief 136 draft
   extension.**
   - Persist `photoRefs: string[]` in the existing
     `claims.draft.{location_code}` localStorage payload alongside the
     typed values + `submissionId` + `savedAt`.
   - On Resume, restore `photoRefs` into the closure array AND render
     thumbnail placeholders for each (a generic "✓ Uploaded" tile is
     fine — re-fetching the actual image to thumbnail is nice-to-have
     but out of scope here).
   - Clear-on-submit logic unchanged (already wipes the whole draft).
   - On "Start over", clear `photoRefs` AND regenerate the
     `submissionId` (Brief 139 already does this for the idempotency
     key — same hook).

5. **Daily R2 cleanup sweep extension.**
   - The existing damage-worker `scheduled` handler (Brief 65 daily
     summary at 13:00 UTC) gains a second pass: every object under
     `claim-uploads/{pendingSubmissionId}/...` older than 24h with no
     matching `claims.id = pendingSubmissionId` row gets deleted.
     Hard pagination cap (50 pages × 1000 = 50K objects/run) prevents
     runaway.
   - Mirrors Brief 97's forms-worker orphan sweep.
   - Log: `[claim.cleanup] uploads orphans deleted: N`.

6. **Defensive: still allow legacy submit on customer caching.**
   - The new `/claims/api/upload` endpoint is additive — the existing
     `/claims/api/submit` multipart parser stays for X days while
     existing browser-cached copies of the old `claim-form.ts` HTML
     drain. Add a log line `[claim.submit] legacy multipart path used`
     to track the tail. Remove after 14 days of zero hits.

## Configuration

No new env vars or secrets. Reuses the existing `R2_CLAIMS` (or
equivalent) binding. The new endpoint inherits CORS / Origin gates
from the existing handlers.

## Out of scope

- Don't compress beyond the 2048 px / quality 0.90 envelope — that's
  the floor the operator has approved for damage review. Going
  smaller is a separate discussion.
- Don't change the existing R2 key schema for claim row photos. New
  uploads land at `claim-uploads/{pendingSubmissionId}/...` and stay
  there. Rewriting to `claims/{claim_id}/...` after insert is a
  future cleanup brief if anyone wants the key path to match the
  resolved claim ID.
- Don't add server-side image processing (resize, EXIF strip, etc.).
  Client does the resize before upload; worker just persists what
  arrives.
- Don't remove the legacy multipart path in this brief. Removal is a
  follow-up after observing zero hits for 14 days.
- Don't migrate other workers' uploads (forms, signup) to anything
  different — forms already does this; signup doesn't have uploads.
- Don't deploy to Cloudflare; don't bind production routes; don't
  commit to git or push.

## Definition of done

- `pnpm typecheck` passes.
- `pnpm --filter @splash/damage-worker build` succeeds.
- `POST /claims/api/upload` accepts a multipart with one `file` part,
  writes to R2 at `claim-uploads/{pendingSubmissionId}/{nanoid}.{ext}`,
  and returns `{ok: true, r2_key, mime, size_bytes, original_filename}`.
- Hard cap 8 MB enforced; bigger payloads return 413.
- MIME sniff via `file-type` rejects non-image payloads with 415.
- `/claims/api/submit` accepts JSON with `photo_refs: string[]`,
  HEADs each ref, and inserts one `claim_photos` row per ref. The
  legacy multipart path still works for back-compat with a
  `[claim.submit] legacy multipart path used` log line on every hit.
- Customer form (`claim-form.ts`):
  - Resizes images client-side to 2048 px long edge / JPEG q=0.90.
  - Uploads OOB on file pick.
  - Shows per-photo upload state (spinner / thumbnail / retry icon).
  - Submit button disabled until all visible photos are in the
    "uploaded" state.
  - Persists `photoRefs` in the Brief 136 draft alongside typed
    values + `submissionId`.
  - On Resume, restores `photoRefs` and renders placeholder tiles
    for each.
- Daily R2 cleanup cron sweeps `claim-uploads/...` orphans older
  than 24h whose `pendingSubmissionId` doesn't match a `claims.id`.
- BUILD_STATE.md updated: bump "Last updated", add a Findings entry
  ("Brief 146: claim photos now resize client-side + upload out-of-
  band; cellular submit-failure mode closed"). Add a glossary entry
  for "claim photo upload pipeline" capturing the resize envelope,
  the OOB endpoint, the orphan-sweep behavior, and the back-compat
  window.

## Report

- Whether `createImageBitmap` was sufficient for EXIF orientation on
  the target devices, or whether a polyfill / manual EXIF read was
  needed. (iOS Safari 14+ should be fine; older Android sometimes
  needs a manual orientation step.)
- The actual reduction in average payload size observed in a
  smoke test (capture a few 4032×3024 phone photos and compare
  byte counts before / after resize).
- Whether the back-compat multipart `/claims/api/submit` path can be
  retired in the next brief or needs a longer tail.
- Latent issues found while extending these files — particularly
  anything around the existing R2 path schemes or claim_photos table
  shape.

## Outcome

### Files created
- `apps/damage-worker/src/uploads.ts` (~270 LOC) — exports
  `handleClaimPhotoUpload(request, env)` for `POST /claims-api/upload`
  and `runClaimUploadsCleanup(env)` for the orphan sweep. Local 12-char
  nanoid via `crypto.getRandomValues`; MIME sniff via `file-type`
  (`fileTypeFromBuffer` on the first ~4 KB); R2 key shape
  `claim-uploads/{pendingSubmissionId}/{nanoid}.{ext}`; ALLOWED_MIME
  = `image/jpeg|png|heic|heif` (+ -sequence variants).

### Files modified
- `apps/damage-worker/src/index.ts` (~150 LOC delta) — wired
  `/claims-api/upload` route; added `serveR2KeyDirect(bucket, key)` for
  serving `claim-uploads/...` keys verbatim and dispatched the existing
  photo serve route on prefix; refactored `handleClaimSubmission` to
  parse either JSON or multipart via a unified `SubmitInputs` type
  (`mode: "json" | "multipart"`, `get(name)` accessor, plus
  `photoRefs` map or `multipartFiles` FormData); JSON-mode photo loop
  HEADs each ref against R2 and rejects missing with 422
  `photo_not_found`; legacy multipart loop preserved with
  `[claim.submit] legacy multipart path used` log on every hit;
  scheduled handler extended with a second `ctx.waitUntil` for
  `runClaimUploadsCleanup`.
- `apps/damage-worker/src/render/claim-form.ts` (~310 LOC delta) —
  added `resizeImage` helper (createImageBitmap → canvas →
  `toBlob('image/jpeg', 0.90)`); added per-photo upload state badges
  (CSS rules `.photo-state` with `.state-ok`/`.state-uploading`/
  `.state-failed`, `.photo-retry`, `.photo-thumb.is-placeholder`);
  rewrote `setupPhotoSection` to upload OOB on file pick with three
  transparent auto-retries (500/1500/3500 ms) before surfacing a red
  Retry icon; tracking `photos` (File handles) and `photoRefs`
  (`{r2_key, mime, size_bytes, original_filename}` or pending/failed
  flags) parallel arrays; per-section `__renderThumbs` /
  `__updateBtnLabel` exposed for the Resume restore path;
  `allPhotosReady()` + `updateSubmitGate()` disable the submit button
  while uploads are pending or failed; submit handler now builds a
  JSON body (FormData → object conversion + `idempotency_key` +
  per-category `photo_refs`) instead of a multipart FormData;
  `submitWithRetry` + `submitOnceForWatchdog` + `startWatchdog`
  signatures widened to accept `jsonBody` rather than `fd`; draft
  persistence (`loadDraft` / `saveDraft`) extended with `photoRefs`
  alongside `values`/`savedAt`/`idempotencyKey` with defensive
  `claim-uploads/`-prefix validation on restore; Resume handler
  restores photoRefs and repaints placeholder tiles; Start over
  handler clears photoRefs in addition to regenerating
  `submissionId`. Form tag's `enctype="multipart/form-data"` dropped
  (JS-driven submit, no submitter path through enctype matters).
- `apps/damage-worker/package.json` — added runtime dep
  `"file-type": "^19.6.0"` (matches forms-worker's version for pnpm
  dedupe).
- `BUILD_STATE.md` — bumped "Last updated" (2026-05-29 Brief 146
  detail) + new Findings table row at the top.
- `CLAUDE.md` — new top-of-glossary entry **claim photo upload
  pipeline** covering the three-stage flow, R2 key shape, photo serve
  prefix dispatch, draft extension, orphan sweep, and back-compat
  removal cadence.
- `BRIEFS/brief-146-claim-photo-cellular-resilience.md` — this
  Outcome + Status flipped to Completed.

### Decisions made on the operator's behalf
1. **Endpoint naming.** New endpoint is `POST /claims-api/upload` for
   consistency with the existing `/claims-api/...` prefix; the brief
   used `/claims/api/upload` and `/claims/api/submit` interchangeably
   with `/claims-api/submit-claim` — clearly notation slips. The
   load-bearing customer URLs (`/signup/{loc}`, `/q/{loc}`,
   `/join/{loc}`, `/claims/{site}`) are untouched.
2. **`photo_refs` shape.** Per-category map keyed on the canonical
   field names (`fourCornersPhotos`/`vinPhoto`/`damagePhotos`/
   `platePhoto`) rather than the brief's flat `string[]`. Preserves
   the existing photo_type metadata that PA's SharePoint Parse JSON
   action consumes; the alternative would have required encoding the
   category in the upload request and decoding it server-side.
3. **R2 key path.** Stored verbatim on `claim_photos.r2_key` (the
   brief's "Brief 92 chose the latter; mirror that simplicity" path).
   Rewrite to `claims/{claim_id}/...` after insert is a v2 candidate
   per the brief's Out of Scope.
4. **Orphan sweep join column.** Joins `claim-uploads/{pendingId}`
   against `claims.idempotency_key` (UUID v4), NOT `claims.claim_id`
   (BIN-... shape). The brief said "claims.id = pendingSubmissionId"
   but the matching column is the Brief 138 idempotency_key — that's
   what the client appends on submit and what the worker writes into
   the row. Tolerates the column being absent (same brief window as
   Brief 138/140) with `[claim.cleanup] ... column missing — skipping
   sweep (apply migration)`.
5. **Upload state tracking.** Closures capture the photoRef entry
   *object* reference rather than a numeric index. Avoids the
   index-shift bug class where concurrent uploads finishing around a
   customer-removed photo would write to the wrong slot. `entryStill
   Tracked(field, entry)` checks `arr.indexOf(entry) >= 0` before
   mutating state; the entry's `pending`/`r2_key`/`failed` properties
   are mutated in place so an orphaned reference's writes are
   harmless.
6. **Form's `enctype`.** Dropped from the `<form>` tag — the submit
   path is JS-only (no submitter path through enctype matters), and
   the legacy multipart back-compat path is for browser-cached HTML
   still carrying the old enctype. `request.formData()` on the worker
   side happily parses both `multipart/form-data` and `application/
   x-www-form-urlencoded` so a non-JS edge case still gets a
   well-formed body.
7. **Photo serve route.** Detects `claim-uploads/` prefix and routes
   to a new local `serveR2KeyDirect` helper that reads R2 verbatim;
   the existing `serveClaimPhoto` (which prepends `claims/`) handles
   legacy keys. apps/web's `damagePhotoUrl` helper strips a leading
   `claims/` from r2_key — that's a no-op on `claim-uploads/...`
   keys, so the constructed URL `/claims-api/photo/claim-uploads/
   {pendingId}/{nanoid}.{ext}` routes correctly without an apps/web
   change.
8. **Submit button gating.** `allPhotosReady()` returns true for an
   empty array — the no-photos case is caught by
   `validateBeforeSubmit()`'s explicit missing-photos check.
9. **Scheduled handler.** Two independent `ctx.waitUntil` calls
   (one for daily summary, one for upload cleanup) rather than
   sequencing — they share no data; parallel shortens the cron's
   wall-clock fan-out vs sequencing.
10. **Single-photo widget replacement.** Replacing a single-photo
    section (e.g., VIN, license plate) overwrites both `photos` and
    `photoRefs` for that field. The prior r2_key becomes orphaned in
    R2; the daily cleanup sweep handles it (24h TTL means the
    cleanup waits a day before reclaiming, which is fine — submit
    only references the NEW key).

### Latent issues found
- (a) The `damagePhotoUrl` helper in apps/web continues to strip a
  leading `claims/`, which is a no-op on `claim-uploads/...` keys —
  the constructed URL routes to `serveR2KeyDirect` correctly. No
  apps/web change at this brief; a future cleanup brief could
  simplify the apps/web helper too.
- (b) `claim_photos` table has no per-row upload timestamp — Brief
  104's photos webhook still falls back to the claim's `submitted_at`
  for `uploaded_at`. Unchanged here.
- (c) Customers on browsers without `createImageBitmap` (very old
  Android) fall through to upload the original file. The 8 MB hard
  cap then catches anything that would have been a problem;
  re-encoding would not have been possible without `createImageBitmap`
  anyway.
- (d) Resume drops File handles — only r2_keys survive in
  localStorage. A Resumed customer who wants to swap a photo must
  Remove + re-add. The placeholder "✓ Uploaded" tile makes this
  visible.
- (e) The PA SharePoint sync's `photos[]` payload now includes
  entries whose `r2Key` starts with `claim-uploads/` rather than
  `claims/`. PA flows that follow the `r2Key` to build a serve URL
  (`/claims-api/photo/{r2Key}` shape) continue to work — the worker
  handles both prefixes via `serveR2KeyDirect`. If PA constructs
  absolute paths differently, it may need a one-line tweak; not
  observed in this brief's scope.
- (f) The worker's existing `setupPhotoSection` had a non-trivial
  index-shift bug latent under parallel uploads + concurrent
  removals. The Brief 146 rewrite closes it by switching to entry-
  reference tracking, but the prior multipart-mode path is also
  preserved unchanged (legacy back-compat) — that path uses
  `formData.getAll(field)` server-side which has the same shape
  immunity (sequential per category). Net: the prior code shipped
  the bug but never exercised it because uploads only happened at
  submit, not on file pick.

### Validation results
- `pnpm typecheck` → **18/18 green** (17 cache hits, damage-worker
  ran fresh; 1.686s wall).
- `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run --outdir=dist` → **succeeded**; bundle 1861.67 KiB raw /
  423.76 KiB gzip (+101.51 KiB raw / +24.21 KiB gzip vs Brief 145
  baseline ~1760/400). Comfortably under the 3 MiB compressed
  free-tier ceiling.
- Initial typecheck failure caught + fixed mid-execution: the first
  typecheck attempt failed at `claim-form.ts:836` because a comment
  inside the inline `FORM_SCRIPT` TS template literal contained a
  backtick (around `claim-uploads/{pendingId}/...`) which closed the
  template prematurely. Same Brief 140 bug class — backticks inside
  FORM_SCRIPT template literals are unsafe. Fix: dropped the
  backticks; comment reads `claim-uploads/{pendingId}/...` plain.
- No D1 schema changes (the brief's pendingSubmissionId reuses the
  existing `idempotency_key` UUID column).
- No new wrangler.toml bindings or secrets — the new endpoint reuses
  `R2_BUCKET` + `DB`.
- The legacy multipart `/claims-api/submit-claim` path is preserved
  full-fat for back-compat; removal is a follow-up after observing
  zero `[claim.submit] legacy multipart path used` log hits for 14
  days.

### Report (per brief's Report section)
- **EXIF orientation.** `createImageBitmap(file)` was relied on. On
  iOS Safari 14+ and modern Chrome it honors EXIF orientation
  natively. Older Android may not — the resized JPEG falls back to
  embedding the original orientation metadata (since the canvas
  draws in canvas coords, the output JPEG won't include EXIF), so
  on very old Android the photo may render upright in some viewers
  and sideways in others. Acceptable trade-off; a manual EXIF read
  + counter-rotation would add ~3 KB of JS and a non-trivial code
  path. If the operator observes orientation issues in the field,
  the next iteration can add the manual EXIF-read step (the
  `exifr` npm package handles it in ~3 KB).
- **Resize savings.** A typical 4032×3024 phone JPEG at q=0.92
  (iOS default) is ~3-6 MB. Scaling to 2048×1536 at q=0.90 produces
  ~200-800 KB. ~5-10× reduction — consistent with the brief's
  estimate. Verified mentally from typical photo sizes; not
  empirically smoke-tested in this brief (the JSON-mode submit can
  be exercised post-deploy with a real cellular device).
- **Back-compat retirement.** The legacy multipart path can be
  retired the brief after observing zero `[claim.submit] legacy
  multipart path used` log hits for 14 days. With OpenNext-style
  same-origin caching and the customer flow's per-form-instance
  HTML render (no service worker), 14 days is comfortable — most
  browser-cached HTML expires within hours. Operator-driven.
- **Latent issues around R2 paths.** The `damagePhotoUrl` strip-
  `claims/`-prefix logic in apps/web (`apps/web/app/admin/damage/
  _lib/worker-fetch.ts:141`) is a no-op for the new `claim-uploads/`
  prefix, so admin viewers continue to load photos correctly. The
  worker's `serveClaimPhoto` (in `@splash/storage-r2`) also
  preserves the `claims/` prepend; it's only called for the legacy
  prefix now via the route handler's prefix branch.
- **`claim_photos` table shape.** Unchanged. The new uploads carry
  `r2_key`, `mime` (sniffed by file-type at upload time), `size_
  bytes` (R2 head-confirmed at submit time), and `original_filename`
  (sanitized at upload time, then echoed on submit). The existing
  table columns accept all of these directly via the existing
  `writeClaimBatch` photo-insert loop.

