# Brief 5b: Damage claim detail page (/admin/damage/[id])

**Status:** Completed (2026-05-04)
**Started:** 2026-05-04
**Completed:** 2026-05-04
**Blocks:** Admin-facing UI parity (functional via curl today). Brief 5c
(write actions) builds on this page.
**Dependencies:** Brief 5a (list page + damageGetJson helper)

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-005a-damage-claim-list.md (5a's Outcome section, especially
  the "Anything Brief 5b should know" section at the bottom)
- apps/web/app/admin/damage/page.tsx (5a's list page; detail-page row links
  already target /admin/damage/{encodedClaimId})
- apps/web/app/admin/damage/_lib/worker-fetch.ts (the damageGetJson helper
  5a created — reuse, do not duplicate)
- apps/damage-worker/src/index.ts (especially `getClaimDetail` around
  line 366 for the response shape, and `serveR2Photo` / any photo-serving
  endpoint — see Scope item 4 below)
- packages/types/src/claims.ts (ClaimRow, ClaimPhotoRow, ClaimActivityRow,
  ClaimPhotoType, ActivityType)
- legacy/damagemanager.js — sections around `renderClaimDetail`,
  `renderActivityLog`, `renderPhotoGallery` (search by identifier; visual
  reference for what the legacy detail page looked like)

## Context

Brief 5b is the second of four sub-briefs porting the damage manager UI:

  5a — claim list at /admin/damage (DONE)
  5b — claim detail at /admin/damage/[id] (THIS BRIEF — read-only)
  5c — write actions on detail (transitions, notes, check-request PDF preview)
  5d — documents (Quote/Receipt upload, edit, delete, photo modals)

5b is read-only on purpose. No buttons that POST. No photo-edit UI. No
transition controls. The page should render every meaningful piece of
claim state cleanly so that 5c and 5d only need to add interactive
overlays without rebuilding the data layout.

The damage-worker's GET /manage/api/claim/{id} returns
`{ claim, photos, activity }` (per `getClaimDetail` at apps/damage-worker/src/index.ts:366).
404 covers both real-not-found and "exists but out of dc_role scope"
(intentional anti-leak per the worker's comment). 403 means "no damage
role assigned" — same generic null branch as 5a.

## Scope

1. **Detail page file.** Create `apps/web/app/admin/damage/[id]/page.tsx`
   as a server component.
   - PageProps `params: Promise<{ id: string }>` (Next 15 async).
   - Decode the route param: `const { id } = await params;` then call
     `damageGetJson<DetailResponse>(\`/manage/api/claim/\${encodeURIComponent(id)}\`)`.
   - DetailResponse type:
     ```ts
     interface DetailResponse {
       claim: ClaimRow;
       photos: ClaimPhotoRow[];
       activity: ClaimActivityRow[];
     }
     ```
   - Three branches:
     a. `data === null` (401/403) — render no-access card with Sign In
        button. Mirror 5a's pattern, return-path = `/admin/damage/{id}`.
     b. `data === null` after a try/catch on `damageGetJson` because the
        worker returned 404 — there's a wrinkle here. damageGetJson
        currently maps 401/403 to null and throws on other non-2xx
        (including 404). For 5b we need to distinguish 404 from
        500-class errors so the UX can render "claim not found or out
        of scope" rather than a scary error. **Add a small helper**
        next to damageGetJson: `damageGetJsonOrStatus<T>(path)` that
        returns `{ data: T } | { status: number }`. Keep the original
        damageGetJson untouched for 5a's contract. The detail page uses
        the new helper.
     c. Success — render the page (see items 2, 3, 4 below).

2. **Page banner + breadcrumb.** Above the content cards:
   - "INTERNAL TOOLS" eyebrow + h1 with the customer name + small
     subtitle showing claim_id in monospace (e.g., "Tom Jones · 8c4f…").
   - A "← Back to claims list" `<Link href="/admin/damage">` immediately
     above the eyebrow. v1 doesn't preserve list filters on Back (5a's
     outcome explicitly accepted this).

3. **Claim summary card.** White card, rounded-splash-lg, shadow-splash-card,
   border-gray-light. Tailwind only, no inline styles. Sections:
   - **Header row:** customer name (large, splash-navy bold), with
     LifecycleBadge to the right (reuse same styling as 5a — extract to
     a shared component under `app/admin/damage/_components/LifecycleBadge.tsx`
     so 5a and 5b both import it; update 5a's import to point at the
     new location).
   - **Status row:** current `claim_status` in a small pill (sudsy-blue
     soft background, navy text), plus `contact_status` (small text,
     opacity-60).
   - **Two-column field grid below:** Customer / Vehicle / Location /
     Submitted on the left; Damage / Determination / Submitted by /
     Equipment on the right. Use a `<dl>` with label-value pairs. Render
     "—" for null fields rather than hiding empty rows (consistent
     vertical layout). Field list:
     - Customer: name, phone (formatted as `(NNN) NNN-NNNN` if 10 digits,
       else as-is), email, mailing_address.
     - Vehicle: year + make + model + color (comma-joined, mirrors 5a's
       formatVehicle but extended with color), license_plate.
     - Location: `location_pretty` (large) + `location_code` (small monospace).
     - Submitted: full submitted_at (YYYY-MM-DD HH:mm, slice from ISO).
     - Damage: `damage_description` (multi-line, preserve newlines via
       `whitespace-pre-line`).
     - Preexisting damage: `preexisting_damage`.
     - Staff notes: `staff_notes`.
     - Determination: human-friendly label (`no_responsibility` →
       "No Responsibility", `requires_gm_review` → "Requires GM Review",
       `customer_get_quotes` → "Customer Get Quotes"). Render the raw
       enum value in monospace next to the label for transparency.
     - Submitted by: `submitted_by`.
     - Equipment: `equipment_related` ? "Yes" : "No"; if yes also show
       `equipment_piece`.

4. **Photos section.** Below the summary card, separate card.
   - Group `photos[]` by `photo_type` (7 categories from
     `ClaimPhotoType`). Within each group, render thumbnails in a flex
     wrap or CSS grid (`auto-fill, minmax(140px, 1fr)`).
   - Skip groups that have zero photos (don't render an empty header).
   - **Photo serving question — investigate first:** the photos array
     contains `r2_key` and `filename` but not a serveable URL. Three
     paths to render `<img>` tags:
     a. damage-worker exposes a per-photo serving endpoint
        (e.g., `/manage/api/claim/{id}/photo/{photoId}` or `serveR2Photo`).
        Grep `apps/damage-worker/src/` for `r2_key`, `R2`, `photo`,
        `getObject` to find it. If one exists, use it directly as the
        `<img src>`. Authentication flows via the SameSite=Lax cookie
        same as the API (production same-origin) — in dev cross-origin
        the photos won't load, document this as a dev limitation.
     b. damage-worker returns signed R2 URLs in the JSON response
        (would require a worker code change — out of scope; flag as a
        future option).
     c. apps/web proxies through its own server route handler that
        forwards to damage-worker. More moving parts than (a); only do
        this if (a) doesn't exist.
     **Pick option (a) if a serving endpoint exists; document the URL
     pattern used. If no endpoint exists, render a placeholder card per
     photo with the filename + photo_type + "Image preview not yet
     available" text, and flag this as a damage-worker gap that needs
     filling before 5b's photo gallery is fully functional.**
   - Each photo thumbnail is wrapped in an `<a target="_blank">`
     (open-in-new-tab) so users can view full size. No modal/lightbox in
     5b — that's 5d.
   - For Quote / Receipt photos (which have extra metadata: `vendor`,
     `amount`, `pay_to_type`, `vendor_address`, `notes`), render a small
     caption under each thumbnail showing vendor + amount (e.g.,
     "Acme Body Shop · $1,234.56"). Pay-to and vendor address aren't
     surfaced in 5b — they belong in 5d's edit affordances.
   - Soft-deleted photos (`deleted_at != null`) — exclude from the
     gallery entirely. The worker may or may not include them in the
     response; filter defensively.

5. **Activity timeline.** Below photos, separate card.
   - Sort `activity[]` by `created_at` descending (newest first).
   - Render each entry as a row in a vertically-stacked list. Each row:
     - Timestamp on the left (small monospace, YYYY-MM-DD HH:mm, slice
       from ISO).
     - Actor name (bold, splash-navy).
     - Type-specific body:
       - `status_change`: "changed status from {status_from} to
         {status_to}" (plain prose; em-dashes in status names render
         verbatim).
       - `note`: "added a note:" followed by `notes` text on the next
         line, preserved with `whitespace-pre-line`.
       - `document_added`: "{notes}" — legacy overloads this type for
         uploads, edits, AND deletes, distinguished by the notes prose.
         Render the prose as-is.
   - Empty case: "No activity yet on this claim." (Won't happen in
     practice — every claim has at least the initial status_change —
     but render defensively.)

6. **Audit stamps** (small inline in the summary card, separate row near
   the bottom). Render only stamps that are populated. Format: e.g.,
   "GM: noah@splash on 2026-04-23". Don't render headings for stamp
   roles that are null. Approved amount, approved quote id, vendor name,
   parts ordered — render whichever are non-null in a small bordered box
   labeled "Approval details" inside the summary card. Hide entirely if
   all four are null.

7. **404 branch render.** Card with "Claim not found" h2 and:
   "This claim does not exist, or it's outside your access scope.
   Verify the URL with whoever sent it to you, or [Back to claims list]."

8. **Update BRIEFS/INDEX.md** — add the 5b row marked Completed (today's
   date) with file link, update the 5a row's "next" pointer if it has one.

9. **Update BUILD_STATE.md** per Conventions — bump Last updated, add
   Findings entry summarizing what shipped, latent issues found
   (especially anything new about damage-worker photo serving).

## Configuration
No new env vars.

## Out of scope

- Write actions: transitions, notes form, document upload, document
  edit/delete. All in 5c or 5d.
- Photo lightbox / modal viewer. 5d.
- Quote-row inline editor (vendor/amount/notes/pay_to_type fields). 5d.
- Check Request PDF preview link. 5c.
- Pagination on the activity timeline (claims have at most a few dozen
  activity rows in practice; full render is fine).
- Adding /manage/api/claim/{id}/photo serving endpoint to damage-worker
  if it doesn't already exist. If absent, fall back to placeholder
  cards as described in scope item 4.
- Modifying the damage-worker source for any reason. Read-only against
  it.
- Don't deploy, don't bind production routes, don't commit to git or
  push.

## Definition of done

- pnpm typecheck passes
- pnpm --filter @splash/web build succeeds
- New file `apps/web/app/admin/damage/[id]/page.tsx` renders all four
  branches (success, 401/403, 404, 5xx) cleanly
- New helper `damageGetJsonOrStatus<T>` exists in `_lib/worker-fetch.ts`
  alongside the original `damageGetJson` (don't replace; add)
- New shared component `app/admin/damage/_components/LifecycleBadge.tsx`
  exists; 5a's page imports from there (refactor)
- Photos either render via the worker's serving endpoint OR fall back to
  styled placeholder cards if no endpoint exists (with a flag in the
  Outcome describing which path was taken)
- BRIEFS/INDEX.md and BUILD_STATE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Photo-serving path taken (a/b/c from scope item 4) and rationale
- Any new latent issues spotted in damage-worker during the read
- Whether the 404-vs-500 disambiguation made the page noticeably better
  or whether collapsing them would've been fine
- Any decisions on the field rendering edges (null handling, multi-line
  description, determination labels)
- Validation results

## Outcome

**Files created:**
- `apps/web/app/admin/damage/[id]/page.tsx` — server-component detail page
  with four branches (success / 401-403 / 404 / other 5xx-class). Uses
  Next 15 async `params: Promise<{ id: string }>`. Renders three stacked
  cards on success: claim summary (header row + status pill + two-column
  `<dl>` grid + audit stamps + approval-details bordered box), photo
  gallery (grouped by `photo_type` in canonical order, skipping empty
  groups), and activity timeline (sorted desc by `created_at`, then `id`).
- `apps/web/app/admin/damage/_components/LifecycleBadge.tsx` — extracted
  from 5a's inline component; shared between list and detail.

**Files modified:**
- `apps/web/app/admin/damage/_lib/worker-fetch.ts` — added
  `damageGetJsonOrStatus<T>` (returns `{ data } | { status }`, leaves
  the original `damageGetJson` alone for 5a's contract) and
  `damagePhotoUrl(r2Key)` (builds the absolute URL for the public
  `/claims-api/photo/{suffix}` endpoint, stripping the leading `claims/`
  from `r2_key` since `serveClaimPhoto` re-prepends it).
- `apps/web/app/admin/damage/page.tsx` — replaced the inline
  `LifecycleBadge` with an import from the new
  `_components/LifecycleBadge`.

**Decisions made on operator's behalf:**

1. **Photo-serving path: option (a)** — the damage-worker already exposes
   a public R2 photo endpoint at `/claims-api/photo/{r2-key-suffix...}`
   (`serveClaimPhoto` in `@splash/storage-r2`, no auth gate per
   `legacy/damagemanager.js:5666`). Building absolute URLs via
   `damagePhotoUrl()` lets `<img src>` work without any worker code
   change. URL helper lives next to `damageGetJson` so the photo URL and
   API URL share the dev-vs-prod base resolution code path. **Latent
   note for 5d:** the public-no-auth posture is "obscurity, not access
   control" — anyone with the r2_key can fetch the image. The legacy
   keeps it that way and the R2 keys include a 4-char random suffix.
   The damage-worker's own comment flags this as fixable later; not in
   5b's scope.

2. **404 vs 5xx disambiguation: kept** — the brief asked for it and the
   page is noticeably better with it. The 404 card explicitly says
   "claim not found, or outside your access scope" which is the
   accurate semantic (the worker returns 404 for both real-not-found
   and "exists but out of dc_role scope" — anti-leak). Collapsing into
   the generic error card would have been confusing for gm/rm users
   who just typed a URL their colleague sent them.

3. **Photo-tile rendering for non-image content_types** — Quote/Receipt
   PDFs and Check Request PDFs render a centered `PDF` (or whatever the
   uppercased content-type) chip instead of broken `<img>` tags. The
   tile still wraps in an `<a target="_blank">`, so clicking opens the
   PDF in a new tab via the same `/claims-api/photo/...` URL. R2 sets
   the right Content-Type so the browser handles inline display.

4. **Determination labeling** — rendered the friendly label (e.g.,
   "No Responsibility") with the raw enum value (`no_responsibility`) in
   monospace next to it, per brief. Falls back to "—" when null.

5. **Phone formatting** — `(NNN) NNN-NNNN` for 10-digit, otherwise the
   raw value, "—" when null. Pulled the digits with `replace(/\D/g, "")`
   to be tolerant of stored whitespace/punctuation.

6. **Activity sort tiebreaker** — sorted by `created_at` desc, then `id`
   desc, so multiple rows with identical timestamps (the activity log
   has 1-second resolution from `datetime('now')`) order as the worker's
   `ORDER BY created_at DESC, id DESC` would.

7. **Audit stamps** — only the populated stamp rows render; the section
   itself is hidden when `gm/rm/ceo_approved_*` are all null (brand-new
   claim). Format matches brief: `GM: noah@splash on 2026-04-23` (well,
   `noah@splash on 2026-04-23 14:30` since the helper renders date+time;
   keeping consistent with all other timestamp displays on the page).

8. **Approval details box** — bordered, slightly tinted background
   (`bg-sudsy-blue-soft/30`) inside the summary card, hidden when
   `approved_amount` / `approved_quote_id` / `vendor_name` /
   `parts_ordered` are all null. Renders whichever subset is populated.

9. **Two-column field grid layout** — the brief listed Customer / Vehicle /
   Location / Submitted on the left and Damage / Determination / Submitted
   by / Equipment on the right. I added rows for `preexisting_damage` and
   `staff_notes` (also listed in scope item 3) by alternating
   left/right pairs in the `<dl>`: Customer | Damage, Vehicle | Preexisting,
   Location | Staff notes, Submitted | Determination, Submitted by |
   Equipment. Falls back to single-column on `<md`.

10. **Empty photo gallery card vs hidden card** — the brief's "skip
    groups with zero photos" left the all-zero case ambiguous. Chose
    to render the gallery card with a "No photos or documents on this
    claim yet." line so the page layout stays consistent across claims.

**Latent issues spotted in damage-worker during the read:**

- The `/claims-api/photo/{...}` endpoint is fully public (no auth check).
  The worker's own comment (apps/damage-worker/src/index.ts:188-191)
  flags this: "R2 keys include a 4-char random suffix in the claim_id
  ... which provides obscurity but not real access control." For 5b's
  read-only display this is fine and matches legacy behavior. If 5d
  decides claim photos shouldn't be world-readable, the auth-gating
  follow-up surfaces here.
- `damageGetJson` (5a's helper) collapses 401 and 403 into the same null
  branch — the detail page now uses `damageGetJsonOrStatus` and could
  distinguish them, but the brief says both should land in the same
  no-access card so they're collapsed in the page-level branch logic.
  If a future brief wants to distinguish "no claims tool grant" from
  "no damage role assigned," `damageGetJsonOrStatus` already exposes
  the status — just split the 401 vs 403 branches in the page.
- The activity timeline can render `(none)` for `status_change` rows
  with null `status_from`/`status_to`. In practice the worker always
  writes both (`legacy/damagemanager.js:2007-2009`), but the type allows
  null and the defensive render is cheap.

**Validation:**
- `pnpm typecheck` — 13/13 successful, 3.879s (12 cached + apps/web ran
  fresh after the worker-fetch + new page additions).
- `pnpm --filter @splash/web build` — Next 15.5.15 compiled in 3.7s,
  12/12 static pages generated. New route `/admin/damage/[id]` listed
  as `ƒ` (server-rendered) at 171 B / 105 kB First Load JS. No lint or
  type errors. Existing `/admin/damage` route still 171 B (unchanged
  bundle after the LifecycleBadge extraction).

**Anything Brief 5c / 5d should know:**
- The detail page is purely server-rendered, no client JS shipped (171 B
  page bundle, all in shared chunks). 5c's transition / note forms can
  be added either as standalone client-component overlays or as
  server-action `<form>`s (the latter keeps the no-client-JS posture).
- `damagePhotoUrl()` is reusable for 5d's photo lightbox modal — same
  URL works as both `<img src>` and the lightbox's "Open original" link.
- The activity timeline already handles all three `ActivityType` cases.
  When 5d adds Quote/Receipt edits + deletes, those keep arriving as
  `document_added` rows with distinguishing prose in `notes` — no
  rendering changes needed.
- The audit stamps and approval-details sections will need re-renders
  after a successful 5c transition. If 5c uses Next's `revalidatePath`
  on POST, both sections naturally update on the next read.
