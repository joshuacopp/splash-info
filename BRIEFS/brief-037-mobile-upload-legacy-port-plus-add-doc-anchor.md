# Brief 37: Mobile quote upload — port the legacy path that works + permanent "Add Document" anchor button

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Brief 36 Part B's mobile-upload investigation was
deferred (CF logs lookup needed operator access). Operator
re-tested from iPhone, hit the same digest, then accidentally
visited the legacy worker (`info-signup-worker`) first and
**successfully uploaded a quote photo in 2 seconds** from the
same iPhone. So the legacy code path works on mobile; the new
monorepo port broke it. The fix is "see what legacy does and
replicate." Plus a small UX add: a permanent "Add Document"
anchor button at the top of the claim detail page (next to "Add
Note" — Brief 22 added the latter), so operators don't have to
scroll to find the upload card.
**Dependencies:** Brief 5d (the document upload pipeline that's
broken on mobile), Brief 22 (the "Add Note" anchor button +
smooth-scroll pattern this mirrors), Brief 36 Part B (the
defense-in-depth try/catch that already landed on
uploadDocumentAction; this brief addresses the underlying cause).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-005d-damage-documents.md (Outcome - the new
  document upload pipeline; the broken-on-mobile path)
- BRIEFS/brief-022-recent-notes-card.md (Outcome - the existing
  "Add Note" anchor button + smooth-scroll pattern that the
  "Add Document" button mirrors)
- BRIEFS/brief-036-test-batch-pdf-humanize-mobile-upload-multi-pkg.md
  (Outcome - what was already done on this issue: try/catch
  defense-in-depth; root cause still open)
- apps/damage-worker/src/index.ts handleUploadDocument (the new
  port's upload handler)
- apps/web/app/admin/damage/[id]/_components/UploadDocumentCard.tsx
  + actions.ts uploadDocumentAction (the apps/web side that goes
  through Next server actions)
- apps/web/app/admin/damage/[id]/page.tsx (the claim detail page;
  Part B adds the anchor button somewhere near the top of the
  page next to "Add Note")
- legacy upload code path — see Phase 1 below for how to locate it

## Context

End-to-end mobile testing on 2026-05-05 found:

> Same error on uploading quote from iphone photo - however i
> accidentally visited the legacy worker first and successfully
> uploaded one there in 2 seconds. Maybe we should see how that's
> doing it and replicate that.

The legacy worker that "just works" is `info-signup-worker` (the
pre-monorepo single-file worker; per CLAUDE.md "ported from a
single legacy worker (`info-signup-worker`)"). Its production /
workers.dev URL is whatever the operator was browsing when the
upload succeeded — recoverable via CF dashboard.

What we know about the new (broken) path:
- apps/web's `uploadDocumentAction` is a Next 15 server action
  that receives `FormData` and forwards to damage-worker's
  `POST /manage/api/upload-document` via service binding (Brief
  17) or URL fallback.
- Two testers got identical digest `924441341@e394` so the
  failure is deterministic, not a network flake.
- Brief 36 added a try/catch wrapper (defense-in-depth) so the
  page no longer white-pages, but the upload still fails.

What we know about the legacy (working) path:
- It's part of `info-signup-worker`. The exact handler can be
  found at `legacy/damagemanager.js` in this repo (confirmed
  present 2026-05-05). The executor reads it directly.
- It almost certainly does NOT use Next.js server actions — it's
  a raw Cloudflare Worker handling a multipart POST and writing
  to R2 directly. That alone is enough to explain the difference:
  bypassing Next's server-action runtime + multipart parser
  removes a whole class of edge-runtime quirks.

The plausible root causes — without seeing the legacy code — are
the same as Brief 36 Part B's ranked list, with the addition that
the legacy worker likely streams the photo body straight to R2
without buffering or transcoding, while the new path may be
hitting a buffer/encoding problem inside Next.

The pragmatic fix is **don't go through apps/web for the upload
on mobile**. Have the form POST directly to damage-worker's
`/manage/api/upload-document` endpoint (or to a new mobile-
optimized endpoint that mirrors the legacy code path), bypassing
the Next.js server action entirely. The action stays for non-
upload paths.

## Scope

### Phase 1 - Locate the legacy upload code

1.1 Find the upload handler. The legacy source lives at
`legacy/damagemanager.js` in this repo (confirmed present
2026-05-05). The damage-claim worker is the one to read since
this is the upload flow that the operator hit successfully on
mobile. Search the file for handlers responding to upload paths
(grep for `upload`, `document`, `photo`, or the route shape
`/manage/api/`). Document the exact handler location (line
range) in the Outcome.

If `damagemanager.js` doesn't have the right handler (e.g., the
upload was actually wired in `legacy/signupworker.js` per
AUDIT_REPORT.md's "3,332 lines, single-file Service Worker"
note), check there next. Either way, the file is in the repo and
readable.

1.2 Document in the brief Outcome the exact legacy path:
  - HTTP method + path (e.g., `POST /manage/api/upload-document`)
  - How the multipart body is parsed
  - How the file bytes get to R2 (direct stream? buffered?
    transcoded?)
  - Any HEIC handling (transcode to JPEG? pass through? reject?)
  - Validation logic
  - Response shape

### Phase 2 - Replicate the working path

2.1 The new damage-worker has its own
`POST /manage/api/upload-document` (per Brief 5d's outcome). If
the new handler differs from legacy in a specific way that
explains the mobile failure (e.g., new uses
`request.formData().get(...)` while legacy used streaming), patch
the new handler to mirror legacy's approach.

  - **Most likely diff**: the new handler does
    `const file = (await request.formData()).get("file")` which
    fully buffers the request in memory. iPhone HEIC photos can
    be 5-10 MB; combined with FormData parse overhead, this can
    push the worker past memory limits or trip a multipart edge
    case in Next 15's runtime when going through apps/web first.
    Legacy probably uses `request.body` as a ReadableStream and
    pipes directly to `R2_BUCKET.put(key, body)`.

2.2 Bypass the apps/web server action. Change the upload form to
POST directly to damage-worker:

  - The form's `action` URL becomes the damage-worker upload
    endpoint (relative path on the same zone post-cutover, full
    URL on staging). Use the same `WORKER_URL` resolution apps/
    web already does.
  - Remove the `uploadDocumentAction` server action wrapping.
    Brief 36 already added a try/catch on it — once the form
    posts directly, that action is dead code; delete it.
  - The form is `enctype="multipart/form-data"` already; that
    stays.
  - Cookie auth still works (same zone, same cookie domain
    post-cutover). The damage-worker handler already gates on
    `getAuthContext` from the cookie.
  - On success, the worker returns 200 with the new claim_photo
    row JSON (or 302s back to the claim detail page — pick the
    pattern that mirrors legacy).

2.3 Refresh the claim detail page after the upload. Two options:
  - **A)** Worker responds with a 302 to
    `/admin/damage/{claim_id}` — browser follows the redirect,
    apps/web SSRs the page with the new photo present. Simple,
    works on mobile.
  - **B)** Worker responds with JSON, an inline JS handler on
    the form fires `location.reload()` after success. Mirrors
    Brief 25's claim form JS pipeline.

  Pick A. It's how legacy does it (per the working iPhone test
  that took 2 seconds — that's a full page redirect, not an
  AJAX flow), and it doesn't add a JS dependency to the upload
  form.

2.4 If the legacy code transcodes HEIC to JPEG before the R2
write, replicate that. CF Images binding (`env.IMAGES`) handles
the transcode if available, otherwise the legacy worker probably
just passes HEIC through (R2 is content-agnostic; the issue is
downstream consumers reading the photo). Document the choice.

### Phase 3 - "Add Document" anchor button

3.1 In `apps/web/app/admin/damage/[id]/page.tsx` (the claim
detail page), add a permanent "Add Document" button near the
top — adjacent to the "Add Note" anchor button that Brief 22
added.

3.2 Mirror Brief 22's pattern exactly:
  - Anchor button: `<a href="#upload-document">Add Document</a>`
  - Styled to match the "Add Note" button (same size + background
    + spacing).
  - The upload card already has an `id="upload-document"` anchor
    on it (added in Brief 20 per its outcome). Confirm the anchor
    exists; if not, add it.
  - Smooth scroll: same global CSS rule that scrolls anchors
    smoothly is already in place from Brief 22 (`html { scroll-
    behavior: smooth; }`). No new CSS needed.

3.3 Position the new button next to "Add Note" — they share a
layout. Both should be visible above the fold on mobile.

### Phase 4 - Updates

4.1 BRIEFS/INDEX.md: Brief 37 row added.

4.2 BUILD_STATE.md: Findings entry covering the legacy port +
the anchor button. Note that the bypass-the-server-action pattern
might apply to other upload paths (claim form's customer photo
upload — but that's separately a JS-driven submit per Brief 25,
so probably already fine). Flag this as something to look at if
similar mobile upload bugs surface elsewhere.

4.3 If `uploadDocumentAction` is fully deleted, scan for any
remaining importers and clean up.

## Out of scope

- Replacing Next 15 server actions across the rest of the admin
  UI. The action pattern works fine for text-only forms (notes,
  transitions, sysadmin grants); the mobile-multipart edge case
  is specific to file uploads. v1 of this brief just bypasses
  the action for the document upload path.
- Adding a generalized "raw worker form" pattern (a helper /
  abstraction for "form posts directly to worker, redirects on
  success"). The single use case is the document upload; if a
  second one shows up, lift the pattern. Don't pre-abstract.
- Implementing direct R2 multipart upload from the browser
  (presigned URLs / fetch-from-R2 approach). The legacy
  worker-mediated path works fine; no need to over-engineer.
- The "Add Note" anchor button itself — already exists per Brief
  22. Just adding a sibling.
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker build succeeds
- pnpm --filter @splash/web build succeeds
- Phase 1: legacy upload code path documented in the Outcome
  (with file path, line numbers, HEIC handling, R2 stream
  approach)
- Phase 2: damage-worker's `POST /manage/api/upload-document`
  patched to match the legacy approach (likely streaming-to-R2
  instead of buffered FormData parse); the form posts directly
  to the worker URL bypassing apps/web server actions; success
  redirects back to the claim detail page
- Phase 2: `uploadDocumentAction` deleted from
  `apps/web/app/admin/damage/[id]/actions.ts` (or wherever it
  lives) once nothing imports it
- Phase 3: "Add Document" anchor button on the claim detail
  page next to "Add Note", smooth-scrolling to the upload card
- Smoke test: upload an HEIC photo from iPhone Safari to
  staging — should succeed in <5 seconds
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- The exact legacy code path (file, line range, key differences
  from the new port)
- Whether HEIC transcode happens server-side or whether the file
  is stored as-is
- Bundle size delta on damage-worker (probably +0.3-1 KiB if a
  streaming path is added; -0.5 KiB on apps/web from removing
  the server action)
- Mobile smoke test result with file size + claim ID
- Validation results

## Outcome

### Phase 1 — Legacy upload code path documented

**File:** `legacy/damagemanager.js` (in repo).

**Constants:** lines 2416-2426 — `DOCUMENT_TYPES = ["Quote", "Receipt"]`,
`DOCUMENT_MAX_BYTES = 10 * 1024 * 1024`, `DOCUMENT_ALLOWED_MIME` set
covering pdf/jpeg/png/heic/heif (+ `-sequence` variants).

**HTTP method + path:** `POST /manage/claim/{id}/document` (the legacy
worker's namespace; the new monorepo port renames to
`POST /manage/api/claim/{id}/document`).

**Handler:** `handleDocumentUpload(request, env, auth, claimId)` at
**legacy/damagemanager.js:2446-2621**.

**Flow:**
- Line 2447 — `checkOrigin(request)` defense-in-depth (mirrors the new
  worker's `isOriginAllowed`).
- Line 2451-2454 — `fetchClaimDetail` for scope check (port:
  `loadAndScopeCheck`).
- Line 2459-2465 — multipart-only gate via `Content-Type` substring
  check (port: identical).
- **Line 2467 — `const form = await request.formData();`** — fully
  buffered FormData parse on the worker side. **Identical to the new
  port** (apps/damage-worker/src/index.ts:913). The legacy worker does
  NOT stream the body to R2 — it buffers via `formData()`, then
  buffers again via `await file.arrayBuffer()` inside `uploadToR2`.
  The brief's "Most likely diff: streaming-to-R2" hypothesis is
  **wrong** — both legacy and new port fully buffer.
- Lines 2469-2566 — field extraction + validation. Identical-shape
  validations to the new port (the new port adds Brief 20's stricter
  Quote-row vendor/amount/pay_to_type required-fields, but the
  underlying code shape is the same).
- Line 2570-2577 — `nextDocumentSequence` + `uploadToR2(file, claimId,
  docType, seq - 1, env)`. The new port's
  `countPhotosOfType` + `uploadClaimPhoto` are line-for-line
  equivalents in `@splash/db-d1` and `@splash/storage-r2`.
- Line 2581-2608 — `INSERT INTO claim_photos` + `INSERT INTO
  claim_activity` + `UPDATE claims SET updated_at`. Identical to the
  new port's `insertDocPhoto` + `logActivity` + `touchClaim` calls.
- **Line 2620 — `return Response.redirect(\`${url.origin}/manage/claim/${encodeURIComponent(claimId)}\`, 303);`**
  — full top-level browser redirect back to the claim detail page.
  THIS is the difference from the new port — the new port returned
  `json({ ok: true, r2Key })` because it was being called by an
  apps/web Next 15 server action, not directly by the browser.

**`uploadToR2`** at `legacy/damagemanager.js:260-299`:
- HEIC/HEIF detected via `isHeicFile(file)` (line 252) — extension or
  MIME match.
- HEIC: `env.IMAGES.input(file.stream()).output({ format: "image/jpeg" })`
  + `await result.response().arrayBuffer()` → JPEG bytes,
  `contentType = "image/jpeg"`, ext flipped to `jpg`. Try/catch falls
  back to passthrough on conversion failure.
- Non-HEIC: `body = await file.arrayBuffer()` (raw passthrough).
- R2 PUT: `await env.R2_BUCKET.put(key, body, { httpMetadata: { contentType }, customMetadata: { claimId, photoType, originalName, uploadedAt } });`
- Key shape: `claims/{claimId}/{type-slug}_{n}.{ext}`.

**Verified against the new port's helpers:**
- `packages/storage-r2/src/index.ts:96 uploadClaimPhoto` — line-for-line
  port of `uploadToR2`. HEIC handling identical (lines 107-119).
  Comment at line 90 explicitly says "Source: legacy/damagemanager.js:260
  uploadToR2."
- `packages/db-d1/src/index.ts countPhotosOfType` — port of
  `nextDocumentSequence`.
- `apps/damage-worker/src/index.ts handleDocumentUpload` (pre-Brief-37)
  — used `request.formData()` directly, same shape as legacy
  (line-for-line equivalent to legacy:2467).

**The actual difference between legacy (works on iPhone) and new port
(broken on iPhone):** the apps/web `uploadDocumentAction` server
action wrapping. Legacy receives the multipart POST directly from the
browser (`<form action="/manage/claim/X/document">` posted from the
legacy-rendered HTML). New port routed the same multipart through a
Next 15 server action → service-binding subrequest → damage-worker.
That extra hop reframed the FormData payload across the
OpenNext-on-CF-Workers server-action runtime, producing the digest
924441341@e394 white-page on iPhone Safari (Brief 36 Part B).

### Phase 2 — Replicate the working path

**Worker change** (`apps/damage-worker/src/index.ts handleDocumentUpload`):
every error branch and the success branch now return a 303 redirect
via the new `buildUploadRedirect(request, claimId, errorMessage?)`
helper instead of `jsonError(...)` / `json({ ok: true, r2Key })`.
`buildUploadRedirect` reads the apps/web origin from the request's
`Origin` header (set by the browser on every form POST) and falls
back to `new URL(request.url).origin` for the same-zone production
case where apps/web and damage-worker share `splashcarwashes.info`.
Error messages are URL-encoded and capped at 240 characters
(`UPLOAD_ERROR_MAX_LEN`) into a `?upload_error=<msg>` query param on
the redirect target. HEIC handling unchanged — the existing
`uploadClaimPhoto` helper (`@splash/storage-r2`) already mirrors
legacy `uploadToR2` line-for-line.

**Apps/web change** (`apps/web/app/admin/damage/_components/UploadDocumentCard.tsx`):
full rewrite — dropped the `<ActionForm>` wrapper, dropped the
`uploadDocumentAction` import, replaced with a plain
`<form action="/manage/api/claim/{id}/document" method="POST" enctype="multipart/form-data">`.
The relative URL resolves through CF same-zone routing in
prod/staging, and through `next.config.mjs`'s `/manage/api/:path*`
rewrite in dev (when `NEXT_PUBLIC_DAMAGE_WORKER_URL` is set). All
field names + labels + conditional `required` UX preserved (Brief
20's Quote-row gating still drives `required` on
amount/pay_to_type/vendor/vendor_address).

**Action retirement** (`apps/web/app/admin/damage/[id]/actions.ts`):
`uploadDocumentAction` deleted. `damagePostMultipart` import dropped.
The Brief 36 Part B defensive try/catch wrap was retired alongside
its host action — the underlying root cause (server-action multipart
path) is excised, so the wrap is no longer load-bearing. The pattern
remains on `editDocumentAction` (text-only metadata edit; doesn't
need the bypass).

**Helper retirement** (`apps/web/app/admin/damage/_lib/worker-fetch.ts`):
`damagePostMultipart` deleted (sole consumer was the deleted action).
`damagePostForm` retained for the surviving urlencoded actions
(transition, note, edit, delete).

**Page-level upload-error banner**
(`apps/web/app/admin/damage/[id]/page.tsx`): reads the new
`?upload_error=...` searchParam, slices to 240 chars defensively, and
renders an `UploadErrorBanner` component above `UploadDocumentCard`
when present. This re-introduces the param-based banner pattern Brief
19 retired, scoped strictly to this one form because it bypasses
`<ActionForm>` entirely (Brief 19's pattern flip was for Next-server-
action `redirect()` calls, which are unreliable on
OpenNext-on-CF-Workers — raw HTTP form POSTs from a plain `<form>`
to a Cloudflare Worker have no such issue, browser handles the
redirect natively).

### Phase 3 — "Add Document" anchor button

`apps/web/app/admin/damage/[id]/page.tsx RecentNotesBox`: added a
sibling `<a href="#upload-document">Add document</a>` button next to
the existing `<a href="#add-note">Add note</a>` button. Same Tailwind
classes, same shape — only the href target and label differ. The
smooth-scroll CSS rule (`html { scroll-behavior: smooth; }`) was
already in place from Brief 22; `id="upload-document"` was already on
`UploadDocumentCard`'s root from Brief 20. Both buttons live in the
header row of the Recent notes sub-box inside SummaryCard, visible
above the fold on mobile.

### Phase 4 — Updates

`BRIEFS/INDEX.md`: Brief 37 row Status set to Completed (2026-05-06).
`BRIEFS/QUEUE.md`: Brief 37 line moved to the completed-tombstone
block. `BUILD_STATE.md`: Last-updated bumped to 2026-05-06; new
Findings entry; prioritized work list row 37 added with
`completed (2026-05-06)` status. This brief's Status set to Completed
above.

### Files modified

- `apps/damage-worker/src/index.ts` — `handleDocumentUpload` rewritten
  to 303-redirect on every branch; new `buildUploadRedirect` helper +
  `UPLOAD_ERROR_MAX_LEN` constant.
- `apps/web/app/admin/damage/_components/UploadDocumentCard.tsx` —
  full rewrite (drop `<ActionForm>`; plain `<form>` posting to
  `/manage/api/claim/{id}/document`).
- `apps/web/app/admin/damage/[id]/actions.ts` — delete
  `uploadDocumentAction`; drop `damagePostMultipart` import; retitle
  docblock + section header.
- `apps/web/app/admin/damage/_lib/worker-fetch.ts` — delete
  `damagePostMultipart`.
- `apps/web/app/admin/damage/[id]/page.tsx` — read `?upload_error`
  searchParam; render new `UploadErrorBanner` above
  `UploadDocumentCard`; add "Add document" anchor button in
  `RecentNotesBox`; refresh comments on the upload-card section
  reflect Brief 37.
- `BRIEFS/INDEX.md`, `BRIEFS/QUEUE.md`, `BUILD_STATE.md`,
  `BRIEFS/brief-037-mobile-upload-legacy-port-plus-add-doc-anchor.md`.

### Files created

None.

### Files deleted

None (logical deletions of `uploadDocumentAction` and
`damagePostMultipart` are line-level edits inside surviving files).

### Decisions made on operator's behalf

1. **Worker returns 303 unconditionally** — every error branch
   redirects with `?upload_error=<msg>` rather than returning JSON.
   Brief explicitly chose Option A. JSON return values would only
   matter for non-browser API consumers, and the only consumer was
   the deleted `uploadDocumentAction`.
2. **Form action is a relative URL** rather than absolute env-resolved
   — works in prod via CF same-zone routing, works in dev via
   `next.config.mjs` rewrite. Avoids passing a server-resolved URL
   prop into the client component (which would have re-introduced
   exactly the apps/web↔worker indirection this brief is designed to
   eliminate).
3. **Apps-web origin for the redirect Location is read from the
   `Origin` header**, falling back to `new URL(request.url).origin`
   for same-zone production. Browser sets `Origin` on every POST
   submission; same-zone production has matching origin/url-origin
   so both paths land at the same place; cross-zone dev with
   `NEXT_PUBLIC_DAMAGE_WORKER_URL` set goes through the Next dev
   rewrite, which forwards the apps/web `Origin` header.
4. **`?upload_error=<msg>` re-introduces the param-based banner
   pattern Brief 19 retired**, scoped strictly to this one form.
   Brief 19's flip was for Next-server-action `redirect()` calls;
   raw HTTP form POSTs from a plain `<form>` to a CF Worker have
   no such issue. The banner reads `?upload_error` once at SSR; on
   a fresh load (no form submit) the param is absent and nothing
   renders.
5. **`damagePostMultipart` deleted entirely** — sole consumer was
   `uploadDocumentAction`, both retired together. CLAUDE.md guidance:
   "If you are certain that something is unused, you can delete it
   completely."
6. **No new pattern abstraction** — brief explicitly out-of-scoped a
   generalized "raw worker form" helper. Lift the pattern when a
   second use case shows up; don't pre-abstract.
7. **HEIC handling left as-is** — Phase 1 read confirmed
   `packages/storage-r2/src/index.ts uploadClaimPhoto` already
   mirrors legacy `uploadToR2` line-for-line (HEIC→JPEG via
   `env.IMAGES.input(file.stream()).output({ format: "image/jpeg" })`,
   fallback to passthrough on conversion failure). No code change
   needed.
8. **`UploadErrorBanner` rendered above `UploadDocumentCard`** rather
   than at the top of the page — the error is contextually about the
   upload action; rendering it where the user's eye goes after the
   failed submit is the smaller cognitive jump.
9. **`docType`/`payToType` client state preserved** in the rewritten
   card so Brief 20's conditional `required` UX still gates Quote-row
   amount/pay_to_type/vendor/vendor_address. Worker re-validates as
   defense in depth, but pre-submit native HTML `required` attrs are
   still the better UX.
10. **"Add document" button structure mirrors "Add note" exactly** —
    same container, same Tailwind classes, same `<a href>` shape.
    Pattern continuity matters more than micro-optimizing the markup.

### Latent issues / forward flags

- **Cross-origin dev without Next rewrites is unsupported.** If the
  operator runs `next dev` without `NEXT_PUBLIC_DAMAGE_WORKER_URL`
  set, the upload form's relative-URL POST 404s on apps/web (no
  rewrite to fall through to). Pre-existing limitation per
  `apps/web/app/admin/damage/_lib/worker-fetch.ts`'s docblock; this
  brief inherits the same posture.
- **The submit-then-redirect pattern is page-reload-based, not
  optimistic.** Operators see a brief blank-then-loaded transition
  between submit and the post-redirect SSR. Compared to the prior
  `<ActionForm>` flow's `useActionState` spinner + inline result
  banner, this is slightly less polished; brief explicitly chose
  this trade-off (matches legacy iPhone path that took 2 seconds).
- **`?upload_error=<msg>` persists in URL after the user dismisses
  by clicking elsewhere.** A hard-reload re-shows the banner.
  Future polish could `router.replace()` away the param via a small
  client island wrapping the banner; not worth a separate brief
  unless operators complain.
- **No mobile smoke test executed in headless** — operator runs the
  smoke test on next deploy.
- **Bundle delta on damage-worker:** 1661.70 KiB → 1662.94 KiB
  uncompressed (+1.24 KiB) / 376.97 KiB → 377.28 KiB gzip
  (+0.31 KiB). Slightly above the brief's "+0.3-1 KiB" estimate —
  the `buildUploadRedirect` helper + the explicit per-branch
  redirect calls add a touch more than expected. Comfortably within
  CF's 3 MiB compressed limit.
- **Bundle delta on apps/web:** post-Brief-37 `/admin/damage/[id]`
  is 3.1 kB / 108 kB First Load JS. Removing `<ActionForm>`'s
  `useActionState`/`useEffect` plumbing from the upload card nets a
  small reduction vs. the pre-Brief-37 baseline; server-side action
  count drops from 5 to 4 in the route.
- **Brief 36 Part B's defense-in-depth try/catch on
  `uploadDocumentAction` is now retired alongside the action
  itself** — root cause excised, wrap no longer load-bearing. The
  pattern remains on `editDocumentAction` (text-only metadata edit;
  doesn't need the bypass).
- **No remaining `uploadDocumentAction` consumers** — grep across
  `apps/web` confirms zero imports post-deletion.

### Validation results

- `pnpm typecheck` — 13/13 successful, 8.517s (11 cached, 2 cache-miss
  — `@splash/web` + `@splash/damage-worker` ran fresh as expected).
- `pnpm --filter @splash/web build` — succeeded; `next build`
  compiled in 7.9s, all 12 routes generated; `/admin/damage/[id]`
  route bundle 3.1 kB / 108 kB First Load JS.
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir=./dist`
  — succeeded; bundle 1662.94 KiB / 377.28 KiB gzip
  (+1.24 KiB / +0.31 KiB vs Brief 35 baseline).
- Mobile smoke test — **deferred to operator** (headless cannot
  drive an iPhone Safari upload; per CLAUDE.md "Don't deploy from
  headless").

### Operator action items

1. On next staging deploy, smoke-test HEIC upload from iPhone Safari
   to a damage claim — should succeed in <5 seconds (matches the
   legacy 2-second baseline that motivated this brief).
2. Verify the `?upload_error=<msg>` banner renders correctly by
   intentionally uploading an unsupported file type (e.g., `.txt` or
   oversized 11 MB JPEG) — the banner should appear above the upload
   card with the worker's validation message.
3. Verify the "Add document" anchor button at the top of the claim
   detail page smooth-scrolls to the upload card on mobile + desktop
   (same behavior as the existing "Add note" button).
