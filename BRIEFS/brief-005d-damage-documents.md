# Brief 5d: Damage documents (Quote/Receipt upload + edit + delete) + photo lightbox

**Status:** Completed (2026-05-04)
**Started:** 2026-05-04
**Completed:** 2026-05-04
**Blocks:** Damage manager UI parity. After 5d lands, item 5 is fully
done.
**Dependencies:** Brief 5a (list + helpers), Brief 5b (detail page +
photo gallery), Brief 5c (write helpers), Brief 11a (getMe() for
canMutateDocument gating).

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-005a-damage-claim-list.md (Outcome — for the helper +
  list page context)
- BRIEFS/brief-005b-damage-claim-detail.md (Outcome — esp. the photo
  gallery layout, `damagePhotoUrl()`)
- BRIEFS/brief-005c-damage-write-actions.md (Outcome — esp. the
  server-action + redirect pattern, `damagePostForm()`,
  `damageCheckRequestUrl()`, the `ActionAlert` banner)
- BRIEFS/brief-011a-user-info-endpoint.md (Outcome — `getMe()` for
  dc_role + email-based mutation gating)
- apps/web/app/admin/damage/[id]/page.tsx
- apps/web/app/admin/damage/[id]/actions.ts
- apps/web/app/admin/damage/_lib/worker-fetch.ts
- apps/damage-worker/src/index.ts — sections relevant to 5d:
  * `POST /manage/api/claim/{id}/document` (~line 750ff): upload
    contract — content-type, expected fields (`document_type`, file
    field name, vendor/amount/notes/pay_to_type/vendor_address for
    Quote/Receipt rows), file size limits, R2 key generation,
    activity log entry shape ("Uploaded {type}: {filename}").
  * `POST /manage/api/claim/{id}/document/{docId}/delete` (~879ff):
    soft-delete contract — what fields it expects (typically nothing
    beyond the URL), what the activity log row says ("Deleted
    {type}: {filename}").
  * `POST /manage/api/claim/{id}/document/{docId}/edit` (~1191ff):
    metadata edit contract — which columns are editable, the activity
    log row, the canMutateDocument gate.
  * `canMutateDocument()` (~431) — admin/super_admin always; others
    only when `doc.uploaded_by` matches session email
    (case-insensitive).
- packages/types/src/claims.ts — `ClaimPhotoRow`, `ClaimPhotoType`,
  `PayToType`.
- legacy/damagemanager.js — for visual + flow reference, search for
  `renderQuoteRow`, `renderReceiptRow`, `renderDocUploadForm`,
  `renderPhotoGallery`, `renderLightbox` (or similar identifiers).
  The new UI doesn't need to mimic the legacy pixel-for-pixel but the
  field set + column ordering + edit-modal shape should match what
  staff are used to.

## Context

Brief 5d is the final of four sub-briefs porting the damage manager UI:

  5a — claim list (DONE)
  5b — claim detail read-only (DONE)
  5c — write actions: transitions + notes + check-request preview link
       (DONE)
  5d — documents (THIS BRIEF): Quote/Receipt upload + edit + delete,
       photo lightbox modal, per-quote check-request preview links

After 5d, the damage manager is at functional parity with the legacy
`/manage/*` pages. Anything beyond is polish or new features.

5d touches three surfaces, all on the detail page from 5b/5c:

  1. **Document upload** — a new form for staff to attach a Quote or
     Receipt PDF/image to an existing claim. Adds the file to R2, the
     metadata to claim_photos, and an activity row.

  2. **Document edit + delete** — per-row controls on existing
     Quote/Receipt tiles. Edit opens a small inline form (vendor,
     amount, notes, pay_to_type, vendor_address). Delete is soft (sets
     deleted_at). Both gated by canMutateDocument logic.

  3. **Photo lightbox** — click any image-typed thumbnail → modal opens
     with the full-size R2-served image. Esc closes; click-outside
     closes. Image-typed only (Quote/Receipt PDFs continue to open in a
     new tab via the existing `<a target="_blank">` from 5b — already
     works, no change needed).

  4. **Per-quote check-request preview** — inside each Quote tile,
     render a "Preview check request" link if the worker exposes a
     per-quote PDF endpoint. 5c added a single link in the
     approval-details box for the *approved* quote; this brief surfaces
     it on every Quote row regardless of approval status (the worker
     accepts any quoteId).

## Scope

1. **Multipart POST helper.** Extend
   `apps/web/app/admin/damage/_lib/worker-fetch.ts` with a
   `damagePostMultipart(path, formData)` function. Server-only.
   - Sets `Content-Type` automatically by NOT setting it (fetch
     populates the multipart boundary header from the FormData body).
   - Forwards Cookie + Origin headers same as `damagePostForm`.
   - Returns same shape as `damagePostForm`: `{ ok, body }` or
     `{ ok: false, status, error }`.
   - Existing `damagePostForm` (URL-encoded body) stays for transition
     and note actions. Don't replace.

2. **Document upload form.** Add an `<UploadCard>` server-component
   below the photo gallery on the detail page (between the gallery and
   the activity timeline). The card contains a `<form
   action={uploadDocumentAction} encType="multipart/form-data">` with:
   - `<input type="hidden" name="claim_id" value={claim.claim_id}>`
   - `<select name="document_type" required>` with options "Quote",
     "Receipt". (Vehicle Overview / VIN / Damage / License Plate are
     customer-submitted at claim creation; not user-uploadable here.
     Check Request is worker-generated, not user-uploadable.)
   - `<input type="file" name="file" required accept="image/*,application/pdf">`
   - Quote/Receipt-specific fields, all optional: `vendor`, `amount`
     (number, step="0.01"), `pay_to_type` (select with "customer" /
     "vendor" / "" empty), `vendor_address`, `notes` (textarea).
     Conditionally show these fields only when document_type !== ""
     and !== Vehicle/VIN/Damage/Plate (which aren't options anyway).
     Acceptable v1: render the conditional fields always — they're
     optional and the worker accepts them on either Quote or Receipt
     rows. (Hide-if-not-applicable can be a polish pass via small
     client component; not in scope here.)
   - Submit button "Upload document".
   - On submit: server action posts to
     `/manage/api/claim/{claim_id}/document` via
     `damagePostMultipart`. On success, `revalidatePath` and
     `redirect()` to the bare detail URL. On failure, `redirect` with
     `?action_error=`.

3. **Server action `uploadDocumentAction`.** Add to
   `apps/web/app/admin/damage/[id]/actions.ts` (the `"use server"`
   module from 5c). Signature:
   ```ts
   export async function uploadDocumentAction(formData: FormData): Promise<void>
   ```
   - Read claim_id from the form. Build the worker path.
   - Pass the FormData straight through to `damagePostMultipart` —
     the worker's `readForm` handles multipart natively, and the file
     field name + metadata field names are already set on the form.
   - Same error-redirect pattern as `transitionAction` from 5c.

4. **Document edit affordance.** For each Quote/Receipt photo tile in
   the photo gallery, render an "Edit" button when
   `canMutateDocument(session, photo)` is true. The button toggles an
   inline `<details>` element revealing an edit form. Use server-
   rendered `<details>` rather than a client modal — keeps the page
   server-only-rendered and the form is small enough that a sliding
   inline reveal is fine. Form contents:
   - `<input type="hidden" name="claim_id">`
   - `<input type="hidden" name="doc_id">`
   - Editable fields: `vendor`, `amount`, `pay_to_type`,
     `vendor_address`, `notes`. Pre-populated with existing values.
   - Submit button "Save changes".
   - Cancel — a `<a href="?">` close-the-details link, since
     `<details>` doesn't have a controllable close-from-form path
     without JS.
   - Server action `editDocumentAction(formData)` posts to
     `/manage/api/claim/{claim_id}/document/{doc_id}/edit` via
     `damagePostForm` (URL-encoded for non-file edits — file edits
     aren't in scope; a doc replacement would re-upload as a new
     row).

5. **Document delete affordance.** For each Quote/Receipt tile where
   `canMutateDocument` is true, render a small "Delete" button (same
   inline-with-the-tile placement as Edit). To avoid an accidental
   delete on a single click, wrap the delete in a confirm-then-submit
   pattern using a small `<form>` with a server action that
   double-checks via the URL: the button is `<button type="submit"
   formAction="?confirm_delete=&doc_id=N">`, which performs a redirect
   back to the page with `?confirm_delete_id=N`. The detail page reads
   that searchParam and renders a small confirmation banner above the
   gallery: "Delete {type} {filename}? [Yes, delete] [Cancel]".
   - Yes link is itself a `<form action={deleteDocumentAction}>` with
     hidden inputs for claim_id + doc_id + a CSRF-shaped one-time
     token (`confirm_token`) generated server-side from the URL
     param to prevent a casual reload from re-triggering the delete.
   - Acceptable simpler v1 if the token shape feels overengineered:
     skip the token, accept that reloading the confirm URL would
     re-execute the delete on click of "Yes" (still user-initiated,
     so safe enough). **Pick the simpler v1.** Add a code comment
     about the token if a stricter version surfaces later.
   - Server action `deleteDocumentAction(formData)` posts to
     `/manage/api/claim/{claim_id}/document/{doc_id}/delete` via
     `damagePostForm`.

6. **canMutateDocument gating in apps/web.**
   - The page already calls `getMe()` (from 11a) for transition
     gating. Reuse that session.
   - Implement the same logic as the worker's `canMutateDocument`:
     ```ts
     function canMutateDocument(session: Session | null, photo: ClaimPhotoRow): boolean {
       if (!session) return false;
       if (session.dcRole === "admin" || session.dcRole === "super_admin") return true;
       if (!photo.uploaded_by || !session.email) return false;
       return photo.uploaded_by.toLowerCase() === session.email.toLowerCase();
     }
     ```
   - Place this helper in
     `apps/web/app/admin/damage/_lib/permissions.ts` alongside any
     other client-side mirrors of worker gating. Strong sync-checklist
     comment pointing at `apps/damage-worker/src/index.ts:431` as the
     canonical source.
   - Edit + Delete buttons render only when this returns true. Worker
     re-validates as defense in depth; the UI gate just prevents
     dead-end button clicks.

7. **Photo lightbox.** New client component
   `apps/web/app/admin/damage/_components/PhotoLightbox.tsx` (`"use
   client"`). Renders a modal overlay with the full-size R2 image,
   dismiss-on-Esc, dismiss-on-outside-click. Use `useState` for
   open/closed, `useEffect` for keyboard listener.
   - Each image-typed thumbnail in the gallery becomes a `<button>`
     with an `onClick` that opens the lightbox with that photo's URL
     (via `damagePhotoUrl(photo.r2_key)`).
   - Image-typed photos only — Vehicle Overview / VIN / Damage /
     License Plate / image-typed Quote/Receipt. PDF-typed (Quote /
     Receipt with `content_type === "application/pdf"`, or any
     Check Request) keep the existing `<a target="_blank">` from 5b.
     Distinguish by `content_type?.startsWith("image/")` — fall back
     to extension matching on `filename` if content_type is missing.
   - The lightbox shows a single image at a time. No carousel
     navigation in 5d (could be a polish brief later if needed).
   - Add a small "Open original" link inside the lightbox that opens
     the same URL in a new tab (escape hatch for download).
   - The detail page, currently a fully server component, gains one
     small client island — the photo gallery's `<button>` wrappers
     and the lightbox itself. Keep the rest server-rendered.

8. **Per-quote check-request preview link.** Inside each Quote photo
   tile (after the existing vendor + amount caption), add a
   "Preview check request" `<a target="_blank">` to
   `damageCheckRequestUrl(claim.claim_id, photo.id)`. Show only on
   `photo_type === "Quote"`. The worker accepts any quote_id; staff
   may want to preview quotes that aren't yet approved.

9. **Update the detail page** (`app/admin/damage/[id]/page.tsx`) to
   wire in:
   - The `UploadCard` between gallery and timeline.
   - The lightbox button wrappers around image thumbnails.
   - The Edit + Delete affordances on each Quote/Receipt tile.
   - The confirm-delete banner above the gallery (when
     `?confirm_delete_id=N` is present).
   - The per-quote check-request links on Quote tiles.
   - Don't move existing 5b/5c sections; only add to them.

10. **Update BRIEFS/INDEX.md** — mark 5d Completed with file link,
    flip item 5's status to fully Completed (all four sub-briefs
    landed).

11. **Update BUILD_STATE.md** per Conventions — bump Last updated,
    add Findings entry, mark item 5 fully Completed in the prioritized
    work list, validation results (typecheck + apps/web build).

## Configuration

No new env vars.

## Out of scope

- Customer-side photo categories (Vehicle Overview / VIN / Damage /
  License Plate). Those are submitted at claim creation by customers,
  not by managers; not part of the manager UI surface.
- Photo replacement (uploading a new file in place of an existing
  photo). The legacy doesn't support it; the new worker doesn't
  either. If a doc is wrong, delete + re-upload.
- Document-level activity timeline (a per-doc audit trail). The claim's
  activity timeline already shows `document_added` rows for uploads,
  edits, and deletes. Sufficient for v1.
- Carousel navigation in the lightbox (next/prev between photos).
  Single-photo display only. Polish brief if needed.
- Drag-and-drop file upload UX. Keep `<input type="file">` for v1.
- Bulk operations (multi-select delete, multi-select export).
- Worker code changes. Read-only against damage-worker.
- Don't deploy, don't bind production routes, don't commit to git or
  push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- New helper `damagePostMultipart` exists in `_lib/worker-fetch.ts`
  alongside existing helpers
- New shared module `_lib/permissions.ts` exports `canMutateDocument`
- New client component `_components/PhotoLightbox.tsx` exists and
  is a properly-tagged `"use client"` boundary
- New server actions `uploadDocumentAction`, `editDocumentAction`,
  `deleteDocumentAction` added to existing `[id]/actions.ts`
- Detail page wires in upload card, edit/delete affordances per
  tile, confirm-delete banner, lightbox triggers, per-quote
  check-request links
- Edit + Delete buttons render only when `canMutateDocument` returns
  true for the current user
- BUILD_STATE.md and BRIEFS/INDEX.md updated; item 5 marked fully
  Completed
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Multipart upload approach (server-action FormData passthrough vs.
  manual reconstruction) and any sharp edges with the worker's
  `readForm` implementation
- Confirm-delete pattern decision (token vs. simpler v1, per scope
  item 5) and rationale
- Lightbox implementation details (Esc handling, click-outside,
  any aria-* attributes for accessibility)
- Whether `canMutateDocument` parity with the worker held up cleanly,
  or whether the worker's gate has any edges the UI mirror would miss
- Any new latent issues spotted in damage-worker
- Validation results (typecheck output, build output, any size
  regression on the detail page from the new client island)
- Bundle-size delta on `/admin/damage/[id]` from adding the lightbox
  client component (the route should grow from 171 B to whatever the
  new client chunk adds — flag if it's surprisingly large)

## Outcome

### Files created

- `apps/web/app/admin/damage/_lib/permissions.ts` — UI mirror of the
  worker's `canMutateDocument` gate (admin/super_admin always; otherwise
  case-insensitive `uploaded_by` === `session.email`). Strong sync-checklist
  comments pointing at `apps/damage-worker/src/index.ts:431` as the
  canonical source.
- `apps/web/app/admin/damage/_components/PhotoLightbox.tsx` — `"use client"`
  modal trigger + overlay. Renders a `<button>{children}</button>`
  thumbnail wrapper plus, when open, a fixed dialog with the full-size
  image, an "Open original" link, and a Close button. `useState` for
  open/closed, `useEffect` for the Esc keyboard listener (only registered
  while open), separate `useEffect` for body-scroll-lock during open.
  Click-outside on the backdrop closes; click on the inner stack
  preserves via `e.stopPropagation()`. Single instance per image —
  encapsulates its own state.

### Files modified

- `apps/web/app/admin/damage/_lib/worker-fetch.ts` — added
  `damagePostMultipart(path, formData)` next to `damagePostForm`. Same
  Cookie + Origin forwarding, but deliberately omits Content-Type so
  fetch (undici) sets the multipart boundary itself. Refactored the
  shared response-parser into a private `parseDamagePostResponse(resp)`
  used by both helpers.
- `apps/web/app/admin/damage/[id]/actions.ts` — added three server
  actions: `uploadDocumentAction` (multipart, forwards FormData verbatim
  including the File field), `editDocumentAction` (URL-encoded, reads
  `claim_id` + `doc_id` hidden inputs), `deleteDocumentAction` (same
  shape as edit). All three follow the existing 5c error-redirect /
  revalidatePath / redirect pattern. Header comment expanded to list all
  five actions.
- `apps/web/app/admin/damage/[id]/page.tsx` — wired in:
  - `?confirm_delete_id=N` searchParam parsing → `pendingDelete` photo
    lookup (filtered by `canMutateDocument`).
  - `<ConfirmDeleteBanner>` above the back link when `pendingDelete` is
    non-null.
  - `<PhotoLightbox>` wrapping image-typed thumbnails (gallery markup
    stays server-rendered; thumb visual passed in as `children`). PDF
    tiles keep `<a target="_blank">` from 5b.
  - `<DocumentMutateRow>` per Quote/Receipt tile when
    `canMutateDocument(session, photo)` returns true — Edit `<details>`
    + Delete `<Link>` to confirm URL.
  - `<DocumentEditForm>` inside the `<details>` reveal — `vendor`,
    `amount`, `pay_to_type` (Quote only), `vendor_address` (Quote only),
    `notes` pre-populated; Save submits to `editDocumentAction`, Cancel
    is a `<Link>` to the bare detail URL.
  - Per-Quote tile "Preview check request →" link via
    `damageCheckRequestUrl(claim.claim_id, photo.id)` (in addition to
    the approval-details box's link from 5c).
  - `<UploadDocumentCard>` between gallery and timeline — multipart
    `<form action={uploadDocumentAction}>` with `doc_type`/`file`/
    `vendor`/`amount`/`pay_to_type`/`vendor_address`/`notes` fields.
  - New `isImagePhoto(photo)` helper — content_type wins; falls back to
    extension matching against `IMAGE_EXTENSIONS` set.
  - Header comment block updated to reflect 5d sections + the new
    canMutateDocument gating note.
- `BUILD_STATE.md` — bumped Last updated, updated status snapshot,
  flipped item 5 to fully Completed, expanded the
  `/admin/damage/[id]` row in the apps/web pages table, added a
  Findings & decisions log entry summarizing 5d.
- `BRIEFS/INDEX.md` — flipped 5d to Completed and item 5 (top-level) to
  Completed (all four sub-briefs landed).

### Decisions made on operator's behalf

1. **Field name `doc_type`, NOT `document_type` per the brief.** The
   damage-worker reads `form.get("doc_type")` directly
   (`apps/damage-worker/src/index.ts:773`); the brief's `document_type`
   would silently 400 on every upload. Renamed; comment in
   `UploadDocumentCard` explains why. Treating this as a brief-text bug;
   flagged below.
2. **Confirm-delete = simpler v1** per brief §scope.5 (no anti-replay
   token). The Delete tile-button is a `<Link>` to
   `?confirm_delete_id=N#docs`; the page resolves that to a
   `pendingDelete` photo (filtered by `canMutateDocument` so stale URLs
   after a delete or scope change collapse to null) and renders a
   confirmation banner with `<form action={deleteDocumentAction}>`.
   Reloading the confirm URL re-renders the banner; only the
   "Yes, delete" button click submits — same UX safety as a typical
   confirm-then-action flow without the token machinery. Code comment
   in `actions.ts` explains the v1 vs strict tradeoff.
3. **Lightbox is one client component per image tile**, not a
   single context-shared modal. Each `<PhotoLightbox>` instance manages
   its own `open` state; only the open one registers the Esc + scroll-lock
   effects. Cleaner than threading shared state through context, and
   the gallery markup stays a server component — the thumbnail visual is
   passed in as `children` and rendered server-side.
4. **Edit affordance = native `<details>` element**, not a client
   modal. Server-only, no JS, browser-native disclosure widget. Cancel
   link is a `<Link>` to the bare detail URL — closes the `<details>`
   via navigation. Drawback: opening the form scrolls only on user
   click (no programmatic scroll-into-view), no fade animation;
   acceptable for v1.
5. **`isImagePhoto` extension fallback** — when `content_type` is
   null, falls back to `.{ext}` matching against
   `jpg/jpeg/png/gif/webp/heic/heif` rather than 5b's
   "treat null as image" heuristic. Customer-uploaded photos always
   carry a content_type set by the worker, but Quote/Receipt rows
   imported from older paths might not. Safer to render the type chip
   than show a broken `<img>`.
6. **Per-Quote check-request links unconditional on
   `photo_type === "Quote"`** (brief §scope.8). The worker requires
   `quote.amount && quote.pay_to_type` (and `vendor_address` when
   vendor) before generating the PDF; if those aren't set, clicking
   surfaces the worker's 400 JSON in the new tab. Acceptable for v1;
   an upgrade would gate the link client-side on the same fields the
   worker checks before generating.
7. **Activity rendering for delete/edit** — no change. The 5b
   `ActivityBody` already renders `document_added` rows verbatim from
   `notes`, and the worker's delete/edit handlers write
   `Deleted ...` / `Edited ...` prose into the same column. Legacy
   parity intentional — see `ActivityType` doc in
   `@splash/types/claims`.

### Multipart upload approach

Server-action FormData passthrough — `uploadDocumentAction(formData)` is
the canonical Next 15 server-action signature, and Next forwards the
raw multipart body (including File parts) into `formData` automatically.
The action then passes that FormData to `damagePostMultipart` which
constructs a server-to-worker fetch with `body: formData` and no
explicit Content-Type. Undici populates the boundary header on its own.
The worker's upload handler reads with `request.formData()` directly
(NOT via `@splash/http` `readForm`, which stringifies file values to
""), so the file lands intact.

Sharp edge with `readForm`: the only one is the implicit one — if a
future maintainer routes the upload through `damagePostForm` instead of
`damagePostMultipart`, `readForm` on the worker side preserves the
metadata fields but drops the file. The two helpers are clearly named
and documented; the failure mode is "file is missing" not "fields are
silently corrupt", which the worker validates and returns
`"No file selected."`.

### Confirm-delete pattern decision

Picked the simpler v1 (per brief §scope.5). Reasoning:

- The `<Link>` → confirm-banner → `<form>` flow is already two
  user-initiated steps; an anti-replay token doesn't add a meaningful
  guard against a single-user accidental double-submit.
- The `pendingDelete` lookup defensively re-validates via
  `canMutateDocument` and `photo_type ∈ {Quote, Receipt}`, so a stale
  confirm URL after a delete (the row's `deleted_at` is now non-null)
  collapses to `pendingDelete = null` and the banner doesn't render.
- Reloading the confirm URL re-shows the banner — the user has to
  re-click "Yes, delete" to actually submit. No automatic re-execution.

If a stricter pattern surfaces later (e.g., a one-shot HMAC token in
the URL keyed against `claim_id`+`doc_id`+`session.userId`+a server-side
nonce table), it would slot in cleanly: add the token to the Delete
`<Link>` query, validate in `deleteDocumentAction` against the nonce
table, and bump the comment in `actions.ts`. Tracked informally; not in
scope here.

### Lightbox implementation details

- **Esc handling:** `useEffect` with `if (!open) return` — the
  `keydown` listener is registered only while open. Multiple
  `<PhotoLightbox>` instances on the page are fine because only the
  open one has the listener; closed ones are inert. Cleanup
  un-registers on close + unmount.
- **Click-outside:** the outer overlay `<div onClick={close}>` closes
  on any click in the backdrop. The inner image-and-controls stack
  uses `<div onClick={(e) => e.stopPropagation()}>` so clicks on the
  image / "Open original" / "Close" don't bubble.
- **Body scroll lock:** second `useEffect` saves `document.body.style.overflow`,
  sets it to `"hidden"` while open, restores on close + unmount. Latent
  issue if a parent sets its own overflow style; not a problem in the
  current layout.
- **Aria:** `role="dialog"`, `aria-modal="true"`,
  `aria-label={alt}` on the overlay; the trigger button has
  `aria-label={"Open " + filename + " full size"}`. Focus trap is NOT
  implemented (a polish item — Tab from the close button currently
  escapes to the next focusable element behind the overlay). Esc and
  click-outside close, so the user can always dismiss without keyboard
  navigation.

### canMutateDocument parity with the worker

Holds up cleanly. The worker's `canMutateDocument`
(`apps/damage-worker/src/index.ts:431`) is six lines and reads:

```ts
function canMutateDocument(session: Session, doc: ClaimPhotoRow): boolean {
  if (session.dcRole === "admin" || session.dcRole === "super_admin") return true;
  if (!doc.uploaded_by || !session.email) return false;
  return doc.uploaded_by.toLowerCase() === session.email.toLowerCase();
}
```

The UI mirror in `_lib/permissions.ts` differs only in the leading
`if (!session) return false` defensive null check — necessary because
apps/web's `getMe()` can return `null` (worker calls always have a
non-null `Session` past the auth gate, by construction). Worker
re-validates on POST as defense in depth, so any drift surfaces as a
403 inline (via the `?action_error` banner) rather than a security gap.

Edges the UI mirror might miss: none observed. The worker's gate
doesn't read any other fields from `Session` (no tools array, no
locations check). If a future iteration adds a finer-grained scope
(e.g., gm/rm can mutate documents on claims at their own locations),
both sides would need updating in lock-step. The sync-checklist
comments at the top of `_lib/permissions.ts` make this explicit.

### Latent issues spotted

- **Brief-text bug:** §scope.2 specifies the document-type field name
  as `document_type`, but the worker reads `doc_type`
  (`apps/damage-worker/src/index.ts:773`). Implementation uses
  `doc_type` to match the worker; the brief should be corrected for the
  next iteration / in case 5d is referenced as a template.
- **Lightbox body-scroll lock** uses `document.body.style.overflow`
  directly. If a parent layout sets its own overflow style this will
  stomp it on close. None observed in the current layout, but the
  pattern is brittle as the design system grows.
- **`damagePhotoUrl` is called once per photo** in a `Promise.all` and
  `damageCheckRequestUrl` is called once per Quote in a separate
  `Promise.all`. For typical claims (single-digit photos) this is fine;
  if photos balloon the gallery becomes O(n) sequential awaits. Could
  be batched; not blocking.
- **Receipt rows in the edit form** correctly skip `pay_to_type` /
  `vendor_address` (worker only honors them on Quote rows per
  `apps/damage-worker/src/index.ts:1246`). Good parity, no action
  needed — flagging in case future receipts grow vendor-payment
  semantics.
- **Per-Quote check-request links** are unconditional on
  `photo_type === "Quote"` — clicking before the quote has
  `amount` + `pay_to_type` set returns the worker's 400 JSON in a new
  tab. Could be gated client-side; acceptable for v1.
- **Dev cross-origin Cookie limitation** persists per BUILD_STATE.md.
  Multipart upload + edit + delete all rely on the apps/web → worker
  Cookie forward, which works in same-origin prod (post-cutover) and
  in dev only when both share an origin. Per-environment, not a 5d
  bug.
- **`damage-worker` worker-side issue (read-only flag, not in scope):**
  the upload handler at `apps/damage-worker/src/index.ts:794` validates
  via `!DOCUMENT_ALLOWED_EXT.has(ext) && !DOCUMENT_ALLOWED_MIME.has(mime)`
  — a file with a recognized extension but a wholly-bogus MIME type
  passes. Likely intentional (browsers send `application/octet-stream`
  for some files); no action.

### Validation

- `pnpm typecheck` — **13/13 successful**, 3.741s (12 cached + apps/web
  ran fresh). One in-flight error during development:
  `IMAGE_EXTENSIONS.has(m[1])` failed under `noUncheckedIndexedAccess`
  strictness because regex-match `m` is `RegExpMatchArray | null` and
  `m[1]` is typed `string | undefined`. Fixed by extracting
  `const ext = m?.[1]; if (!ext) return false;` before the `.has(ext)`
  call.
- `pnpm --filter @splash/web build` — **succeeded**. Next 15.5.15
  compiled in 5.4s, 12/12 static pages generated. Route table:

  ```
  ┌ ƒ /                                      133 B         102 kB
  ├ ƒ /admin/damage                          169 B         105 kB
  ├ ƒ /admin/damage/[id]                     965 B         106 kB   <-- 5d
  ├ ƒ /admin/dashboard                       169 B         105 kB
  ├ ƒ /admin/pricing                         169 B         105 kB
  ├ ƒ /admin/pricing/[location]            3.65 kB         109 kB
  └ ...
  ```

- **Bundle-size delta on `/admin/damage/[id]`:** 171 B / 105 kB
  (post-5c) → **965 B / 106 kB** (post-5d). The lightbox client island
  adds ~800 B to the route chunk and ~1 kB to First Load JS — well
  within budget for a `useState`/`useEffect`-driven dialog component.
  Not surprising; below the threshold where a custom modal library
  would even start paying for itself.

### What 5d closes out

- Item 5 in BUILD_STATE.md's prioritized work list is now fully
  Completed (all four sub-briefs landed).
- The damage manager UI is at functional parity with the legacy
  `/manage/*` pages. Anything beyond is polish or new features.
- Out-of-scope-but-noted future work: focus trap inside the lightbox
  for full-keyboard accessibility; per-Quote check-request link gating
  on `amount + pay_to_type` to avoid 400-in-new-tab; lightbox
  next/prev carousel; drag-and-drop file upload; per-doc activity
  timeline; bulk operations.
