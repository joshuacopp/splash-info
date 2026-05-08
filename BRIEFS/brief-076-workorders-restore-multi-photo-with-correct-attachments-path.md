# Brief 76: Work Orders New Request — restore multi-photo with the corrected `/attachments/` (plural) path

**Status:** Completed (2026-05-08)
**Started:** 2026-05-08
**Completed:** 2026-05-08
**Blocks:** Brief 75 retired Brief 74's multi-photo upload path
based on a wrong diagnosis. Empirical 2026-05-08: the actual
MaintainX URL for additional files on a work request is
`/v1/workrequests/{id}/attachments/{filename}` — **plural** —
not the singular `/attachment/` we inferred from the doc heading
text. With the corrected path, multi-photo upload works. This
brief restores the multi-photo capability.
**Dependencies:**
- Brief 74 (the original multi-photo design — form + worker
  handler + helper signature this brief restores).
- Brief 75 (the single-photo retreat this brief reverses; phone-
  required from Brief 75 is preserved).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-074-workorders-new-request-tab-and-priority-pill-fixes.md
  (the original multi-photo design)
- BRIEFS/brief-075-workorders-new-request-single-photo-and-required-phone.md
  (the single-photo retreat; this brief reverses the photo
  changes, keeps the phone-required change)
- apps/workorders-worker/src/maintainx.ts
  (`uploadMaintainXWorkRequestFile` — change the URL path that's
  built when `endpoint === "attachment"`: `/attachment/` →
  `/attachments/`)
- apps/workorders-worker/src/index.ts (the
  `POST /workorders/api/request` handler — restore the photos-2-
  through-5 attachment loop after the thumbnail call)
- apps/web/app/workorders/_components/NewRequestForm.tsx (the
  form — restore the `multiple` attribute on the file input,
  update the helper text)

## Context

Brief 74 shipped a five-photo upload path: photo 0 → `/thumbnail/`,
photos 1–4 → `/attachment/` (singular). On first operator submit
(2026-05-08, request id 11692116), MaintainX returned `404 Cannot
PUT /v1/workrequests/11692116/attachment/download__2_.jpg` for
every attachment call. The thumbnail succeeded; the request was
created with one photo visible.

Brief 75 retired the multi-photo path on the assumption that work
REQUESTS only support a thumbnail (additional files only available
once a request is approved into a work order).

That assumption was wrong. Operator's 2026-05-08 follow-up
investigation surfaced the MaintainX docs' actual attachment URL:

```
PUT https://api.getmaintainx.com/v1/workrequests/{id}/attachments/{filename}
                                                    ^^^^^^^^^^^^^
```

Plural. The doc heading reads "Update work request attachment"
(singular noun in English), but the URL path is plural. Brief 74's
URL builder used the singular form per the heading-derived
assumption. One-letter typo in the path produced a 404 routing
error that masqueraded as a missing endpoint.

**Evidence the endpoint exists and works:**
- The MaintainX UI's request-edit panel renders a "Files" section
  with multiple attached files and an "Attach files" button —
  proves multi-attachment is a first-class feature on work
  requests, not a work-order-only thing.
- The MaintainX API doc explicitly lists "Update work request
  attachment" with the URL pattern
  `/v1/workrequests/{id}/attachments/{filename}` (plural).
- A sibling DELETE endpoint exists at the same plural path
  ("Remove work request attachment" in the docs).

**This brief retires Brief 75's single-photo retreat.** The
phone-required change from Brief 75 is preserved (operator wants
phone required; that decision still stands).

**On filename sanitization:** the original error path showed
`download__2_.jpg` from a source file presumably named
`download (2).jpg`. Brief 74's sanitization replaces `(`, ` `, and
`)` each with `_` independently, producing the awkward double
underscore. Underscores are valid in URL paths so this isn't the
cause of the 404, but while we're touching the helper, collapse
runs of consecutive underscores to a single `_` for cleaner
filenames. Cosmetic, not load-bearing.

## Scope

### Phase 1 — Worker helper: fix the URL path

1.1 In `apps/workorders-worker/src/maintainx.ts`:

  - Find the URL builder in `uploadMaintainXWorkRequestFile`. It
    currently constructs:
    ```ts
    `${baseUrl}/workrequests/${requestId}/${endpoint}/${encodeURIComponent(filename)}`
    ```
    where `endpoint` is `"thumbnail"` or `"attachment"`.
  - Change the mapping so `endpoint === "attachment"` produces
    `/attachments/` (plural) in the URL while still accepting the
    same input string. Either:
    - Add a small lookup `const ENDPOINT_PATHS = { thumbnail:
      "thumbnail", attachment: "attachments" } as const;` and
      use `ENDPOINT_PATHS[endpoint]` in the URL.
    - Or rename the discriminator's value to match the URL exactly
      (`endpoint: "thumbnail" | "attachments"`). Either is fine;
      the lookup approach keeps caller call sites unchanged.
  - Update the JSDoc / inline comment to reference the corrected
    plural path so future readers don't repeat the mistake.

1.2 Helper signature (the discriminator type) stays the same so
the worker handler doesn't need a type-update beyond the URL
behavior change.

### Phase 2 — Filename sanitization polish (optional cleanup)

2.1 In whichever helper sanitizes the upload filename in
`apps/workorders-worker/src/index.ts` (or wherever Brief 74 placed
it):

  - After replacing disallowed chars with `_`, collapse runs:
    `name.replace(/_+/g, "_")`. This turns `download__2_.jpg`
    into `download_2_.jpg`.
  - Trim trailing `_` immediately before the final `.ext` so
    `download_2_.jpg` becomes `download_2.jpg`. Keep this as
    a single regex step:
    ```ts
    sanitized = sanitized.replace(/_+(\.[^.]+)$/, "$1");
    ```
  - These are cosmetic. If they introduce any complexity, skip
    them — the path fix in Phase 1 is what unblocks multi-photo.

### Phase 3 — Worker handler: restore the multi-photo loop

3.1 In `apps/workorders-worker/src/index.ts`'s
`POST /workorders/api/request` handler:

  - Read all `photo` entries from the multipart formData via
    `formData.getAll("photo")`. Filter to `instanceof File`,
    cap at 5.
  - On >5 photos, 303 redirect with
    `?request_error=too_many_photos` (worker-side defense; the
    form's client-side `multiple` will let the browser send any
    number).
  - After `createMaintainXWorkRequest` succeeds:
    - Photo at index 0 → `uploadMaintainXWorkRequestFile` with
      `endpoint: "thumbnail"`.
    - Photos at indices 1..4 → `uploadMaintainXWorkRequestFile`
      with `endpoint: "attachment"`.
    - Each upload is independent; collect failures into a list.
  - Result handling:
    - All photos succeed → 303 redirect with
      `?request_ok={id}`.
    - Some photos fail → 303 redirect with
      `?request_ok={id}&photo_warn={N}-of-{M}-photos-failed`.
      The page reads this and renders an amber banner under the
      success banner.
    - Request creation itself failed → 303 redirect with
      `?request_error={reason}`.

3.2 Per-upload timeout: 15s via `AbortController` (same as
Brief 74). Total endpoint timeout aggregates: 15s for create + 15s
× 5 for uploads = 90s upper bound. Operators submitting from a
slow connection see the form spinner for that duration; acceptable
for a single user-driven submit.

3.3 Phone-required validation from Brief 75 stays in place —
empty `requester_phone` after trim → 303 redirect with
`?request_error=requester_phone_required` BEFORE the
`createMaintainXWorkRequest` call. Don't re-introduce the
description-footer "—" placeholder from Brief 74; phone is
required so the placeholder branch is dead code.

### Phase 4 — Form: restore multi-file input

4.1 In `apps/web/app/workorders/_components/NewRequestForm.tsx`:

  - Photo input — re-add the `multiple` attribute.
  - Helper text under the input — update to:
    ```
    "Photo(s) (optional, max 5). First photo becomes the thumbnail;
     additional photos attach to the request."
    ```
  - If Brief 75 added a defensive "max 1" client-side check, drop
    it. Re-add the "max 5" check Brief 74 had OR rely on the
    worker's server-side cap (Phase 3.1) for defense-in-depth and
    skip the client-side count.

4.2 Result-banner rendering:

  - On `?request_ok={id}` → green banner "Request #{id} created"
    with link to MaintainX. (Existing; unchanged.)
  - On `?photo_warn={N}-of-{M}-photos-failed` (combined with
    `request_ok`) → secondary amber banner: "{N} of {M} photos
    failed to upload. The request itself was created — re-add
    the missing photos in MaintainX." Stack underneath the green
    banner.
  - On `?request_error=...` → red banner with the error text.
    (Existing; unchanged.)

### Phase 5 — Documentation updates

5.1 CLAUDE.md — under the "Work Orders" glossary entry, **replace**
the Brief 75 note with:

```
- Brief 76 (correcting Brief 75): Work-request multi-photo upload
  was broken in Brief 74 due to a wrong URL path
  (`/v1/workrequests/{id}/attachment/{filename}` singular). The
  correct path is `/attachments/` (plural). Brief 76 restored
  multi-photo: form accepts up to 5 photos, first → thumbnail
  endpoint, remaining → attachments (plural) endpoint. Phone is
  required (Brief 75's other change retained).
```

  - The Brief 75 narrative ("attachment endpoint returns 404
    for every request") is no longer accurate — the brief acted
    on a wrong diagnosis. Don't keep the Brief 75 line in
    CLAUDE.md; replace with the corrected Brief 76 line.

5.2 BUILD_STATE.md:
  - Bump "Last updated".
  - New row in "Open work — prioritized" for Brief 76.
  - Findings entry: "Brief 75 retired Brief 74's multi-photo
    based on misread API doc (singular vs plural in URL path).
    Brief 76 corrected: `/attachments/` plural, multi-photo
    restored, phone-required preserved."

5.3 BRIEFS/INDEX.md — append Brief 76 row.

5.4 BRIEFS/QUEUE.md — append Brief 76 filename.

### Phase 6 — Validation

6.1 `pnpm typecheck` — must pass for all 14 packages.

6.2 `pnpm --filter @splash/web build` — must succeed.

6.3 `pnpm --filter @splash/workorders-worker exec wrangler deploy
--dry-run` — must succeed.

6.4 No D1 / Supabase schema change. No new env vars.

6.5 Live smoke test (operator post-deploy):
  - (a) Submit a New Request with phone empty — confirm 303
    redirect with `request_error=requester_phone_required`.
  - (b) Submit a New Request with phone filled and 1 photo —
    confirm green success banner, photo lands as thumbnail in
    MaintainX (no attachments).
  - (c) Submit a New Request with phone filled and 5 photos —
    confirm green success banner, first photo as thumbnail,
    photos 2–5 visible in the MaintainX request's "Files"
    section.
  - (d) (Optional intentional failure path) Submit with a single
    photo that's >25 MB or some other rejected upload class —
    confirm amber `photo_warn` banner stacks under the green
    success banner. The request itself was created OK; only the
    photo failed.

## Out of scope

- Investigating MaintainX rate limits on rapid-fire attachment
  uploads. v1 sends them sequentially, not concurrently, which
  paces them naturally. Defer optimization until operators
  surface real volume issues.
- DELETE endpoint integration (`Remove work request attachment`).
  Operators don't need to delete from the form post-submit;
  they go to MaintainX for that.
- Generic file-attachment beyond images. PDF / spreadsheet /
  video deferred to future brief if requested.
- Format validation on phone numbers. Same posture as Brief 75.
- Don't deploy from headless. Push triggers CF Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/workorders-worker/src/maintainx.ts` —
  `uploadMaintainXWorkRequestFile` builds the URL with
  `attachments` (plural) when `endpoint === "attachment"`;
  thumbnail path unchanged.
- Filename sanitization collapses consecutive underscores AND
  trims a trailing `_` immediately before the extension (Phase 2;
  optional polish — skip if it introduces complexity).
- `apps/workorders-worker/src/index.ts` — handler restores the
  attachment loop after thumbnail; ≤5 cap; per-photo failure
  collected into `photo_warn` query param on the success
  redirect; phone-required check retained.
- `apps/web/app/workorders/_components/NewRequestForm.tsx` —
  `multiple` attribute restored on the photo input; helper text
  updated; `photo_warn` banner stacks under success banner.
- pnpm typecheck passes
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/workorders-worker exec wrangler deploy
  --dry-run succeeds
- BRIEFS/INDEX.md, BRIEFS/QUEUE.md, BUILD_STATE.md, CLAUDE.md
  updated (Brief 75 note replaced rather than appended-to)
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Files modified (~3-4: maintainx.ts, index.ts (worker),
  NewRequestForm.tsx, plus CLAUDE.md + BUILD_STATE.md)
- Bundle delta on workorders-worker (small — net code
  reintroduced from Brief 75's removal, minus the redundant
  Brief 74 path)
- Bundle delta on apps/web `/workorders` route
- Validation results
- Empirical observations from the executor's smoke test if any
  was run live (e.g., confirming the plural path actually works,
  confirming the response shape `{ publicUrl, filename, fileKey }`
  matches the docs)
- Decisions made on the operator's behalf
- Latent issues / forward flags

## Outcome

### Files modified

- `apps/workorders-worker/src/maintainx.ts` —
  `uploadMaintainXWorkRequestFile` URL builder rewritten to use a small
  `REQUEST_FILE_URL_SEGMENT = { thumbnail: "thumbnail", attachment:
  "attachments" }` lookup. Discriminator type stays
  `"thumbnail" | "attachment"` (matches the doc heading) so the helper
  signature is unchanged; only the URL emits the plural segment. JSDoc
  on `UploadWorkRequestFileInput.endpoint` updated to call out the
  doc-vs-URL plural mismatch so future readers don't repeat the typo.

- `apps/workorders-worker/src/index.ts` —
  - `REQUEST_MAX_PHOTOS = 5` constant reintroduced.
  - Photo collection loop drops the Brief 75 single-photo "take first
    and warn" branch; instead returns
    `?request_error=too_many_photos` when more than 5 arrive.
  - Photo upload section restored to a per-photo loop: photo[0] →
    `endpoint: "thumbnail"`, photo[1..4] → `endpoint: "attachment"`.
    Each upload uses its own `AbortController` (15 s timeout). Failures
    increment `photosFailed`; non-fatal — the request exists in
    MaintainX either way.
  - Success redirect now emits `?request_ok={id}&photo_warn=
    {N}-of-{M}-photos-failed` when any uploads failed (renamed from
    Brief 75's `request_warn` to match the brief's spec; the previous
    `thumbnail_failed` value is no longer emitted by the worker).
  - `sanitizeFilename` gains two cosmetic improvements: collapses runs
    of underscores (`_+/g → _`) and trims trailing `_` immediately
    before the extension (`/_+(\.[^.]+)$/ → "$1"`). Net result:
    `download (2).jpg` → `download_2.jpg` (was `download__2_.jpg`).
  - Phone-required validation from Brief 75 retained; description
    footer continues to omit the `Phone: —` placeholder.
  - Block comment header updated to reflect the Brief 76 restoration.

- `apps/web/app/workorders/_components/NewRequestForm.tsx` —
  - Photo `<input>` regains `multiple`.
  - Helper text replaced with "Photo(s) (optional, max 5). First photo
    becomes the thumbnail; additional photos attach to the request."
  - `FieldRow` label changed from "Photo (optional)" to
    "Photo(s) (optional)".
  - Stale Brief 75 comment block (claiming the attachment endpoint
    returns 404) replaced with a Brief 76 comment explaining the
    plural URL fix.

- `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx` —
  - `RequestResultBanner.kind` extended from `"ok" | "error" | "warn"`
    to `"ok" | "ok-warn" | "error"`. The previous `"warn"` morphed the
    success banner into amber; the new `"ok-warn"` keeps the green
    success banner and stacks a secondary amber banner under it.
  - `readResultBannerFromUrl` reads `photo_warn` first, falling back
    to `request_warn` for back-compat with any in-flight tab on the
    Brief 75 shape.
  - `useEffect` URL-cleanup deletes both `photo_warn` and
    `request_warn` so a refresh doesn't resurrect a stale banner.
  - `RequestResultBannerView` rewritten to render the green banner
    first (always when `kind` ≠ `"error"`) followed by an optional
    amber `photo_warn` banner. New `photoWarnFriendly` helper
    translates `{N}-of-{M}-photos-failed` into "N of M photos failed
    to upload." and preserves the Brief 75 `thumbnail_failed` string
    for back-compat.

- `CLAUDE.md` — `/workorders` glossary block: Brief 75 narrative
  ("attachment endpoint returns 404 for every request — work
  requests appear to support thumbnail only") replaced with the
  Brief 76 description (per the brief's instruction to replace, not
  append). Includes the corrected URL path and the helper's
  discriminator-type note for future readers.

- `BRIEFS/INDEX.md` — Brief 75 row's Status column annotated as
  "superseded by Brief 76 on the photo-count change; phone-required
  portion retained"; new Brief 76 row appended.

- `BUILD_STATE.md` — "Last updated" line bumped with Brief 76 summary
  (prepended to the existing Brief 75 line); new row 76 added in
  "Open work — prioritized" (immediately after row 75 in numerical
  order); Brief 75 row's Status column annotated to flag supersession;
  new Findings & decisions log entry above Brief 75's entry with
  diagnosis, changes, decisions, and validation results.

- `BRIEFS/QUEUE.md` — already had `brief-076-...md` row from the
  orchestrator; no edit needed.

### Files created

None.

### Decisions made on the operator's behalf

- **Lookup vs rename of the discriminator value.** The brief offered
  two options for the URL fix: a `REQUEST_FILE_URL_SEGMENT` lookup
  (keeps caller call sites unchanged) OR rename the discriminator to
  `"attachments"` plural (URL-shape symmetry). Picked the lookup —
  preserves the helper signature so a future caller doesn't have to
  understand the doc-vs-URL drift; the JSDoc points at the plural URL
  for clarity. The brief explicitly stated "Either is fine."

- **Query-param rename `request_warn` → `photo_warn`.** The brief's
  3.1 spec says `?request_ok={id}&photo_warn={N}-of-{M}-photos-failed`.
  Brief 75 used `request_warn` for the same purpose. Renamed to match
  the brief; the apps/web side reads both for back-compat with any
  in-flight tab on the Brief 75 shape, so an operator who submitted a
  request mid-deploy doesn't lose their banner. Back-compat read can
  be retired after a 1-2 day grace.

- **Banner stacking model.** The brief's 4.2 says "secondary amber
  banner: 'N of M photos failed to upload. The request itself was
  created — re-add the missing photos in MaintainX.' Stack underneath
  the green banner." Implemented as a new `"ok-warn"` kind that
  renders BOTH banners; previous `"warn"` kind morphed the success
  banner amber instead of stacking. Kept `kind = "error"` rendering
  the red-only banner unchanged. The brief also said the existing
  green-banner shape is "Existing; unchanged" — preserved verbatim.

- **Per-photo upload remains sequential.** The brief's "Out of scope"
  list defers concurrent uploads. Sequential `await` paces requests
  naturally and keeps the worker simple; per-upload 15 s timeout
  caps the worst-case end-to-end at ~90 s for a 5-photo submit.

- **Filename sanitization polish accepted (Phase 2).** The two
  one-liners (`replace(/_+/g, "_")` and the trailing-underscore trim
  regex) added no measurable complexity, so kept them. They run in
  both the initial-build branch and the length-cap branch so the
  output stays clean at any input length.

### Latent issues / forward flags

- **Empirical confirmation deferred to operator.** The brief notes
  the plural path was confirmed by reading the MaintainX docs and
  observing the UI's "Files" section render multiple attached files
  on existing work requests. The executor did not run a live POST
  to verify the response shape `{ publicUrl, filename, fileKey }`
  matches the docs (handler treats all those fields as best-effort
  metadata anyway — `null` parses to `null` and the upload still
  reports `ok: true`). Operator's smoke test (Phase 6.5 of the
  brief) will confirm.

- **Brief 75's `request_warn` back-compat read.** Can be removed in a
  future cleanup brief once it's clear no in-flight tabs are still
  arriving with the old query param.

- **Brief 75's `thumbnail_failed` fallback in `photoWarnFriendly`.**
  Same — the worker no longer emits this string, but the apps/web
  branch handles it gracefully if it shows up. Can be deleted in a
  follow-up brief.

- **Bundle delta on `/workorders` route.** 5.39 kB / 107 kB First
  Load JS post-Brief-76. Brief 73's recorded baseline was 3.46 kB /
  105 kB; Brief 74 added the New Request form and likely pushed it
  closer to 5 kB. Net change from Brief 75 is negligible (~few
  hundred bytes for the banner-stacking branch + helper); below any
  reasonable concern threshold.

- **workorders-worker bundle.** 748.39 KiB / 142.48 KiB gzip
  (`wrangler deploy --dry-run`). Brief 72's recorded baseline was
  732.31 KiB / 139.37 KiB gzip — net +16 KiB / +3 KiB gzip across
  Briefs 73-76 combined. Well within the 3 MiB free / 10 MiB paid
  CF compressed limit.

- **No empirical observation of `download__2_.jpg` in production
  output.** The sanitization polish is preventative; the next time a
  filename like `download (2).jpg` lands, the URL will carry
  `download_2.jpg`. No regression risk for already-uploaded files.

- **Sequential-await uploads are not aborted on first failure.** A
  full 5-photo run continues attempting uploads even if photo 2 fails
  — by design (each upload is independent; a transient network blip
  on photo 2 shouldn't kill photos 3-5). The downside is per-photo
  15 s timeouts compound; operator submitting 5 photos with all 5
  upstream-503'ing waits ~75 s for the redirect. Out-of-scope for
  this brief; v2 candidate is a circuit-break after N consecutive
  failures.

### Validation results

- `pnpm typecheck` — **passed.** All 14 packages green. (Initial
  run flagged `noUncheckedIndexedAccess` warnings on `photoFiles[i]`;
  fixed with an `if (!file) continue` narrowing inside the loop.)

- `pnpm --filter @splash/web build` — **passed.** 13 routes built;
  `/workorders` route 5.39 kB / 107 kB First Load JS; middleware
  34.5 kB; no warnings.

- `pnpm --filter @splash/workorders-worker exec wrangler deploy
  --dry-run` — **passed.** Bundle 748.39 KiB / gzip 142.48 KiB; two
  declared `[vars]` bindings (`MAINTAINX_BASE_URL`,
  `APPS_WEB_BASE_URL`) listed; no errors.

- No D1 / Supabase schema change. No new env vars. No new bindings.

- Live smoke test (Phase 6.5) — **deferred to operator post-deploy.**
  The four scenarios in the brief (phone-empty rejection, 1-photo
  thumbnail, 5-photo full set, oversized photo amber-warn) are all
  reachable from the new code paths but require a live MaintainX
  endpoint to verify. Headless mode cannot run the smoke test.
