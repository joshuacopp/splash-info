# Brief 160: Promo announcement preview + branded HTML + inline materials

**Status:** Completed (2026-06-06)
**Started:** 2026-06-06
**Completed:** 2026-06-06
**Blocks:** Promo announcements (Brief 157) currently send plain-text bodies with materials as flat attachments. Operators have no way to see what the recipient will receive before firing the send, can't embed marketing images inline in the body (only attached), can't render PTP inline as structured content, and the email itself isn't Splash-branded. Reduces marketing ops's confidence in the channel.
**Dependencies:** Brief 134 (forms-worker `workflow-email-shell.ts` Splash-branded HTML shell — extracted to shared package by this brief), Brief 157 (promo announcement send path — extended here with HTML rendering + preview endpoint), Brief 127 (`outbound_emails` queue + `OutboundEmailAttachment` shape — extended additively with `content_id` + `is_inline`).

## Read first

- BUILD_STATE.md
- CLAUDE.md — Brief 134 glossary entry ("workflow email step rendering" — describes the existing Splash-branded shell on forms-worker; this brief extracts it); Brief 127 / 157 glossary entries (queue + announcement architecture); Brief 17 service-binding pattern (apps/web → promo-worker).
- BRIEFS/brief-134-workflow-email-html-rendering.md (canonical reference for the branded shell + token-to-HTML rendering; this brief lifts and refactors).
- BRIEFS/brief-157-promo-announcement-send.md (the announce endpoint + snapshot + fan-out — this brief extends `handleSendAnnouncement` to render HTML and adds the preview sibling).
- BRIEFS/brief-127-outbound-emails-queue.md (queue table shape + `enqueueOutboundEmail` helper + attachments format).
- apps/forms-worker/src/workflow-email-shell.ts (the shell to extract).
- apps/forms-worker/src/workflow-email-step.ts (`renderTemplate` + `renderTemplateHtml` — the body-rendering pair; this brief reuses the HTML-escape primitives but writes a promo-specific body renderer).
- apps/forms-worker/src/email-queue/attachments.ts (the inline-base64 dispatch — extended to honor `is_inline` + `content_id`).
- apps/promo-worker/src/handlers/announce.ts (Brief 157 send handler — gets `body_html` + preview branch).
- apps/web/app/admin/promotions/_components/AnnouncementComposeModal.tsx (the modal — adds Preview button + per-material inline-vs-attachment toggle).
- packages/db-supabase/src/outbound-emails.ts (`OutboundEmailAttachment` — widened with two optional fields).
- packages/storage-r2/ (`ASSETS.logoWhite` — already used by Brief 134; preserved unchanged).

## Architecture context

Three concerns this brief addresses:

**1. Branded HTML.** Brief 134 already built an Outlook-safe HTML email shell for forms-worker workflow emails. Promo announcements (Brief 157) bypass it entirely — `body_html` is `undefined`, PA falls back to plain-text body. Plumbing exists; just needs wiring on the promo side, plus the shell extracted to a shared package so neither worker owns the canonical version.

**2. Inline materials.** Today every material lands as an attachment. Operators want images embedded in the body so recipients see them on first render (no "open attachment" click). Industry-standard approach for this in transactional email: CID inline attachments — attach the image with a `Content-ID: <materialN>` header, reference via `<img src="cid:materialN" />` in the body HTML. Works in every email client including Outlook desktop. Microsoft 365's Send Email V2 connector supports this via the `IsInline` + `ContentId` fields on each attachment object. No public URL needed; same R2 read path Brief 157 already uses.

**3. Preview.** Operator clicks Preview → modal sub-window renders the same HTML the recipient would see, in an isolated `<iframe srcdoc>` so it can't interact with apps/web's CSS. No DB writes, no fan-out — pure render-and-return. Reuses the send handler's rendering pipeline so the preview cannot diverge from what gets sent.

## Scope

### Phase 1 — Extract `@splash/email-shell` shared package

1.1 New workspace package `packages/email-shell/`:
  - `package.json` — name `@splash/email-shell`, exports `./src/index.ts`, no runtime deps beyond `@splash/storage-r2` (for `ASSETS.logoWhite`).
  - `src/shell.ts` — lift `wrapInEmailShell` + `EmailShellOptions` + `escapeHtml` + `escapeAttr` from `apps/forms-worker/src/workflow-email-shell.ts` verbatim. Behavior unchanged.
  - `src/index.ts` — re-export everything.
  - Add to `pnpm-workspace.yaml`.

1.2 Refactor forms-worker:
  - `apps/forms-worker/package.json` — add `"@splash/email-shell": "workspace:*"`.
  - `apps/forms-worker/src/workflow-email-shell.ts` — DELETE.
  - `apps/forms-worker/src/workflow-email-step.ts` — swap `import { wrapInEmailShell } from "./workflow-email-shell"` → `import { wrapInEmailShell } from "@splash/email-shell"`.
  - Confirm `pnpm --filter @splash/forms-worker build` still emits a working bundle — zero behavior change expected.

1.3 Extracted module includes:
  - `wrapInEmailShell(bodyHtml, opts)` — the main entry point.
  - `EmailShellOptions` interface.
  - `escapeHtml(s)` + `escapeAttr(s)` utility functions (used by any caller building body HTML — promo-worker needs them).

### Phase 2 — Widen `OutboundEmailAttachment` for CID inline support

2.1 In `packages/db-supabase/src/outbound-emails.ts`:

```ts
export interface OutboundEmailAttachment {
  filename: string;
  r2_key?: string;
  base64?: string;
  mime: string;
  size_bytes: number;
  bucket?: "FORMS_FILES" | "PROMO_FILES";
  /** When true, the attachment is rendered inline in the email body via
   *  CID reference (`<img src="cid:{content_id}" />`). The Send Email V2
   *  connector flips `IsInline` true + `ContentId` populated for inline-
   *  flagged attachments. Defaults false (regular attachment).
   *  Brief 160. */
  is_inline?: boolean;
  /** CID identifier referenced from the body HTML. Required when
   *  `is_inline` is true. Must be stable for re-fires (the same logical
   *  email re-enqueued should reference the same CID so dedup behaves).
   *  Convention: `material-{materialId}`. Brief 160. */
  content_id?: string;
}
```

2.2 Forms-worker queue claim handler — `apps/forms-worker/src/email-queue/attachments.ts`:
  - Existing `inlineAttachments` function base64-encodes R2-backed attachments before responding to PA. Extend the response shape: include the `is_inline` + `content_id` flags verbatim, scoped per attachment, so PA's Send Email V2 connector picks them up. No changes to existing dispatch (PROMO_FILES / FORMS_FILES bucket selection) — those persist.
  - Per-attachment caps from Brief 127 still apply (5 MB per attachment for the inline-base64 path); inline images count against that. Document this in the function's docblock so the next maintainer doesn't relax it for "promo wants 8 MB images".

2.3 PA flow note — added to PRE_DEPLOY_PROMO.md (or PA_FLOWS_BRIEF_160.md if scope grows): the existing single drain flow needs its ATTACHMENTS expression widened to set `IsInline` + `ContentId` per attachment. Example expression:
```
@if(item()?['is_inline'], true, false)
@if(item()?['is_inline'], item()?['content_id'], null)
```
This is a PA-side edit, not code; the brief flags it but does not block on it. Until the PA flow lands the widening, inline-flagged images fall back to regular attachments (clients render the body without the images but the body HTML still ships).

### Phase 3 — Promo-worker HTML rendering

3.1 New module `apps/promo-worker/src/announce/render-html.ts`:

```ts
import { wrapInEmailShell, escapeHtml } from "@splash/email-shell";

export interface RenderAnnouncementInput {
  subject: string;
  bodyText: string;          // operator-authored plain text
  promoTitle: string;
  includePtp: boolean;
  ptp: { purpose: string; tools: string; process: string } | null;
  inlineMaterials: Array<{
    materialId: string;
    name: string;
    contentId: string;       // `material-{materialId}` per Brief 160 convention
  }>;
  attachmentMaterials: Array<{ materialId: string; name: string }>;
}

export interface RenderAnnouncementOutput {
  html: string;              // wrapped in the Splash shell
  plainText: string;         // body_text with PTP appended when included
}

export function renderAnnouncement(input: RenderAnnouncementInput): RenderAnnouncementOutput;
```

3.2 Render order in the HTML body:
  1. Operator's body text, split on `\n\n` into `<p>` paragraphs with single `\n` → `<br>`. Escape via `escapeHtml`.
  2. If `inlineMaterials.length > 0` — one `<img src="cid:{contentId}" alt="{name}" style="max-width: 100%; height: auto; margin: 16px 0; display: block;" />` per inline material, in upload order.
  3. If `includePtp && ptp` — three blocks:
     ```html
     <h3 style="...">Purpose</h3>
     <p style="...">{escaped purpose}</p>
     <h3 style="...">Tools</h3>
     <p style="...">{escaped tools}</p>
     <h3 style="...">Process</h3>
     <p style="...">{escaped process}</p>
     ```
     Inline styles only (Outlook-safe — same posture as Brief 134's shell). `<h3>` color `#0E2745` (navy), 16px, bold; `<p>` color `#374151`, 14px, line-height 1.6.
  4. If `attachmentMaterials.length > 0` — one trailing `<p style="...; color: #6B7280;">📎 Attachments: {names joined with ", "}</p>` so recipients know there's more in the attachment tray. (No emoji needed if controversial — use the word "Attachments:" with a paperclip glyph or omit.)

3.3 Plain-text rendering: existing Brief 157 logic stays. PTP appended when opted in. Material attachment list — append a trailing `"Attachments: name1, name2"` line for parity.

3.4 Subject + body shell:
  - `wrapInEmailShell(bodyHtml, { title: input.subject, preheader: bodyText.slice(0, 100) })`.
  - No `showApproverFooter` / `showSubmitterFooter` — promo announcements aren't workflow emails, no per-role footer CTAs at v1.

3.5 Unit-test the renderer with three fixtures:
  - Subject + body only (no PTP, no materials).
  - Subject + body + PTP + 1 inline image + 1 attachment doc.
  - Subject + body + 2 inline images + 0 attachments.
  Inline snapshot the output `body_html` to a file under `apps/promo-worker/test/render-html.snap.ts` so behavior is regression-locked. No CI runner today; the snapshot is for human read review.

### Phase 4 — Promo-worker announce handler — wire HTML rendering

4.1 In `apps/promo-worker/src/handlers/announce.ts handleSendAnnouncement`:
  - After resolving materials + recipients, partition materials into `inlineMaterials` (images by sniffed MIME) and `attachmentMaterials` (everything else). Convention: `file_mime.startsWith("image/")` → inline. Honor the per-material UI toggle (Phase 6) when it lands — until then, image MIME alone is the gate.
  - Build the `OutboundEmailAttachment[]` array:
    - Inline materials: `{filename, mime, size_bytes, r2_key, bucket: "PROMO_FILES", is_inline: true, content_id: "material-{materialId}"}`.
    - Attachment materials: `{filename, mime, size_bytes, r2_key, bucket: "PROMO_FILES"}` (no `is_inline`/`content_id`).
  - Call `renderAnnouncement(...)` once before the fan-out loop (same HTML for every recipient — operator content doesn't vary per recipient at v1).
  - Pass `body_html` + `body_text` to `enqueueOutboundEmail`. PA's drain flow picks `body_html` when populated.

4.2 Snapshot row in `promo_announcements` — store `body_text` only (the operator's raw body). HTML is regenerated on every send (no per-row HTML column, matches Brief 157's intentional snapshot/delivered divergence). If a future brief wants to surface the rendered HTML in a "view announcement" admin page, render on read from the snapshot + materials + PTP-at-send-time.

### Phase 5 — Preview endpoint

5.1 New endpoint `POST /promo/api/promos/{id}/announce/preview`:
  - Same role gate as `/announce` (super_admin | it | marketing).
  - Same CSRF gate (`isOriginAllowed`).
  - Same body shape as `/announce` minus required `recipientEmails` (preview doesn't fan out; recipients aren't needed for rendering). Accept `recipientEmails` as optional so the modal can pass them through for completeness.
  - Same validation as `/announce` for `subject` / `bodyText` / `selectedMaterialIds` / `includePtp`. NO snapshot insert. NO enqueue. NO activity log.
  - Calls the same `renderAnnouncement(...)` to build `{html, plainText}`.
  - Returns:
    ```json
    {
      "ok": true,
      "html": "<!DOCTYPE html>...",
      "plain_text": "...",
      "attachment_summary": {
        "inline_count": 2,
        "attachment_count": 1,
        "total_size_bytes": 152400
      }
    }
    ```
  - The summary lets the modal show a one-liner "2 inline images, 1 attachment, 149 KB" so the operator can sanity-check size before send.

5.2 Handler co-located in `apps/promo-worker/src/handlers/announce.ts` as `handlePreviewAnnouncement`. Dispatch added in `src/index.ts` alongside the send route.

### Phase 6 — apps/web Preview button + per-material inline toggle

6.1 In `apps/web/app/admin/promotions/_components/AnnouncementComposeModal.tsx`:
  - **Add a Preview button** next to Send announcement. Same `<ActionForm>` parent; new server action `previewAnnouncementAction` that calls the preview endpoint and surfaces the result via the existing `onResult` plumbing.
  - **Wire a sub-modal** ("Preview announcement") that opens on successful preview return. Renders the HTML in an `<iframe srcdoc={html}>` with `sandbox="allow-same-origin"` (no JS execution; same-origin so styles render). Iframe min-height 600px so the preview doesn't get squashed. Footer shows the attachment summary line.
  - **Per-material inline toggle** in the materials checklist: alongside the existing checkbox (include/exclude), add a small inline-vs-attachment radio for image-MIME materials. Default: inline. Non-image materials show "Attachment" as a static label (can't be inlined). Persist the operator's choice via additional form fields `materialMode[{materialId}]=inline|attachment` parallel to `selectedMaterialIds`.

6.2 Server actions:
  - `previewAnnouncementAction` in `_actions/announceActions.ts` — mirrors `sendAnnouncementAction` but hits `/announce/preview`. Returns `ActionResult` with `data: {html, plainText, attachmentSummary}` for the modal to consume.
  - `sendAnnouncementAction` widened to read the per-material `materialMode` fields and pass them through to the worker. Worker uses them to override the default image-MIME = inline rule (operator can demote an image to a regular attachment if they don't want it inline).

6.3 Worker — accept `materialModes?: Record<materialId, "inline" | "attachment">` in the send body shape. When present, overrides the auto-rule per material. Defaults to auto-rule when absent or for any material id missing from the map. Same handling in preview.

6.4 SubmitButton wired on both the Preview and Send buttons (Brief 130 pattern; same SubmitButton extracted in this conversation's prior work).

### Phase 7 — Validation

7.1 `pnpm typecheck` — all packages green (+1 with the new `@splash/email-shell` package).
7.2 `pnpm --filter @splash/email-shell build` — sanity check the new package builds.
7.3 `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — bundle still emits (the import swap shouldn't change bundle size meaningfully).
7.4 `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — bundle emits; expect a small size increase from the renderer module + shell dep.
7.5 `pnpm --filter @splash/web build` — apps/web bundle emits; expect a small increase from the new server action + sub-modal.
7.6 Manual verification of the renderer snapshots (Phase 3.5 fixtures) by reading them.

### Phase 8 — Docs

8.1 BRIEFS/INDEX.md: Brief 160 row appended.

8.2 BUILD_STATE.md: Findings entry noting:
  - New shared package `@splash/email-shell` extracted from forms-worker Brief 134
  - Promo announcement send now emits branded HTML body alongside plain text
  - `OutboundEmailAttachment` widened with `is_inline` + `content_id` (additive; existing consumers unaffected)
  - Forms-worker queue claim handler passes the new fields through to PA
  - New endpoint `POST /promo/api/promos/{id}/announce/preview` returns rendered HTML + plain text + attachment summary; no DB writes
  - Apps/web AnnouncementComposeModal gains Preview button + sub-modal with iframe srcdoc + per-material inline-vs-attachment toggle
  - PA flow update required for inline attachments: ATTACHMENTS expression must read `is_inline` + `content_id` per attachment and set Send Email V2's `IsInline` + `ContentId` fields accordingly. Until PA is updated, inline-flagged images fall back to regular attachments; body HTML still ships.

8.3 CLAUDE.md updates:
  - New glossary entry "**@splash/email-shell**" describing the extracted shared shell and its consumers.
  - "Promotions feature" glossary entry: add Brief 160 paragraph covering the preview endpoint, branded HTML body, inline-vs-attachment toggle, and PA flow update requirement.
  - "outbound_emails table" entry: widen the `OutboundEmailAttachment` description with the new fields.
  - Brief 134 entry: update to note that `workflow-email-shell.ts` was extracted to `@splash/email-shell` by Brief 160 (file no longer exists in apps/forms-worker; behavior identical).

8.4 PRE_DEPLOY_PROMO.md: add a "PA flow widening (Brief 160)" section pointing at the inline attachment fields and the expression edits required.

## Out of scope

- **Per-form custom email branding** (custom logo / color overrides per promo). v3+ candidate.
- **Operator-authored HTML body** templates. Today the path is server-side auto-rendering from plain text; allowing the operator to write HTML would require an editor + sanitization pass + Outlook compatibility testing. Not worth the surface area at v1.
- **CID inline for non-image materials.** PDFs / docs / videos stay as regular attachments — no email client renders them inline.
- **Time-limited signed URLs as an inline-image alternative.** Would replace the CID approach and avoid base64 bloat for very large images, but adds a signed-URL handler + key rotation. CID is the right default at v1; signed URLs can be a follow-up if average inline image size grows past ~500 KB.
- **Public R2 bucket variant for materials.** Same trade-off as signed URLs (lighter emails, more attack surface). Not at v1.
- **Embedded videos**. No email client supports `<video>`. Skip.
- **Per-recipient body variation** (e.g., "Hi {first_name}"). Brief 134's token system exists but isn't wired in for promo announcements at v1.
- **Open / click tracking pixels.** Not at v1.
- **Dark-mode CSS targeting.** Not at v1.
- **Don't deploy from headless. Push triggers CF Workers Builds.**
- **Don't bind production routes.**
- **Don't commit to git or push.**

## Definition of done

- New workspace package `@splash/email-shell` exists at `packages/email-shell/` with `wrapInEmailShell` + `EmailShellOptions` + `escapeHtml` + `escapeAttr` exported
- Forms-worker's `workflow-email-shell.ts` deleted; `workflow-email-step.ts` imports from `@splash/email-shell`
- `OutboundEmailAttachment` widened with optional `is_inline` + `content_id` (additive)
- Forms-worker claim handler passes new fields through to PA
- New promo-worker module `announce/render-html.ts` exporting `renderAnnouncement(input)`
- `apps/promo-worker/src/handlers/announce.ts handleSendAnnouncement` partitions materials, builds attachments with `is_inline` + `content_id` for inline-flagged ones, calls `renderAnnouncement`, writes `body_html` + `body_text` to the queue
- New endpoint `POST /promo/api/promos/{id}/announce/preview` returns rendered HTML + plain text + attachment summary; no DB writes
- Worker honors optional `materialModes` body override (per-material inline-vs-attachment)
- Apps/web AnnouncementComposeModal: Preview button + sub-modal with `<iframe srcdoc>` + per-material toggle
- `previewAnnouncementAction` + widened `sendAnnouncementAction` server actions
- Three renderer fixtures under `apps/promo-worker/test/render-html.snap.ts`
- pnpm typecheck passes
- All four worker / web builds succeed
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- PRE_DEPLOY_PROMO.md gains the PA-flow-widening section
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (expected 800-1200 LOC net across shared package + promo-worker + apps/web + forms-worker refactor)
- Confirmation that:
  - Preview rendering matches send rendering byte-for-byte (both call `renderAnnouncement` with the same input shape)
  - The forms-worker bundle still builds and shows no behavioral change after the shell extraction
  - The promo-worker bundle absorbs the renderer + shell without breaching size limits
  - The apps/web bundle's `/admin/promotions/[id]` route remains under the 150 kB First-Load budget
  - Preview sub-modal iframe's `sandbox="allow-same-origin"` prevents script execution while letting styles render
  - PA flow change is documented (not yet executed)
- Validation results
- Any decisions made on the operator's behalf

## Outcome

### Files created

- `packages/email-shell/package.json` — new workspace package `@splash/email-shell`.
- `packages/email-shell/tsconfig.json` — extends `@splash/config/tsconfig.worker.json`.
- `packages/email-shell/src/shell.ts` — `wrapInEmailShell` + `EmailShellOptions` + `escapeHtml` + `escapeAttr`, lifted verbatim from forms-worker's `workflow-email-shell.ts`. `escapeHtml` + `escapeAttr` promoted from module-internal to exported.
- `packages/email-shell/src/index.ts` — re-export everything.
- `apps/promo-worker/src/announce/render-html.ts` — `renderAnnouncement(input)` returning `{html, plainText}`.
- `apps/promo-worker/test/render-html.snap.ts` — three renderer fixtures for human read-review.

### Files modified

- `apps/forms-worker/package.json` — added `"@splash/email-shell": "workspace:*"` dep.
- `apps/forms-worker/src/workflow-email-step.ts` — swap `import { wrapInEmailShell } from "./workflow-email-shell"` → `import { wrapInEmailShell } from "@splash/email-shell"`.
- `apps/forms-worker/src/workflow-email-shell.ts` — DELETED (content lives in `@splash/email-shell` now).
- `apps/forms-worker/src/email-queue/attachments.ts` — `QueueAttachment` widened with optional `is_inline` + `content_id`; both fields passed through verbatim on the existing base64 path and the r2_key fetch path. Function-header docblock notes the 5 MB per-attachment cap remains non-relaxable.
- `packages/db-supabase/src/outbound-emails.ts` — `OutboundEmailAttachment` widened (additively) with optional `is_inline?: boolean` + `content_id?: string` per the brief.
- `apps/promo-worker/package.json` — added `"@splash/email-shell": "workspace:*"` dep.
- `apps/promo-worker/src/handlers/announce.ts` — extensive refactor: added `MaterialMode` type, extracted body validation into shared `parseAndValidateBody(req, {recipientsRequired})`, renamed `promoExists` → `fetchPromoMeta`, added `partitionMaterialsForRender`, rewired `handleSendAnnouncement` to call `renderAnnouncement` and write both `body_text` + `body_html`, added `handlePreviewAnnouncement`.
- `apps/promo-worker/src/index.ts` — imported `handlePreviewAnnouncement`, wired `POST /promo/api/promos/{id}/announce/preview` route BEFORE the bare `/announce` route so the more-specific URL wins.
- `apps/web/app/admin/_components/ActionForm.tsx` — added additive optional `id` prop so a sibling button can read the form's FormData via `getElementById`.
- `apps/web/app/admin/promotions/_lib/worker-fetch.ts` — extended `SendAnnouncementBody` with optional `materialModes`; added `previewPromoAnnouncement` helper + `PreviewAnnouncementBody` + `PreviewAnnouncementResponseData`.
- `apps/web/app/admin/promotions/_actions/announceActions.ts` — extracted `parseComposeForm(formData, {recipientsRequired})` helper, widened `sendAnnouncementAction` to read `materialMode[*]` FormData entries, added `previewAnnouncementAction`.
- `apps/web/app/admin/promotions/_components/AnnouncementComposeModal.tsx` — substantial rewrite: added per-material inline-vs-attachment radio (image-MIME only; non-image shows static label), Preview button (sibling to send `<ActionForm>`, reads form via `getElementById`), Preview sub-modal with `<iframe srcdoc sandbox="allow-same-origin">` minHeight 600px + attachment summary footer.
- `PRE_DEPLOY_PROMO.md` — added §6.5 "PA flow widening (Brief 160 — inline attachments)" documenting the operator-side expression edits required (`IsInline` + `ContentId` per attachment); behavior on a partially-widened flow; recipient client coverage.
- `BUILD_STATE.md` — "Last updated" rolled to Brief 160; Brief 159 demoted to "Previously"; new prioritized-work-list row above Brief 159; new Findings entry at the top of the log.
- `CLAUDE.md` — Brief 134 paragraph notes the extraction to `@splash/email-shell`; `outbound_emails table` entry widened to describe `is_inline` + `content_id`; Promotions feature entry gains a Brief 160 paragraph; new `@splash/email-shell` glossary entry.
- `BRIEFS/INDEX.md` — Brief 160 row added at the top.

### Decisions made on the operator's behalf

1. **Renamed `promoExists` → `fetchPromoMeta`** — the renderer needs the promo title alongside existence; the brief asked for a `promoTitle` field on the renderer input but didn't specify worker plumbing.
2. **Refactored body validation into shared `parseAndValidateBody(req, {recipientsRequired})`** so preview cannot diverge from send byte-for-byte. The `recipientsRequired` flag is true on send, false on preview.
3. **Added optional `id` prop to `<ActionForm>`** (additive) — the cleanest alternative was a controlled-inputs rewrite of every visible input in the modal.
4. **Preview button is `type="button"` + free-function call to `previewAnnouncementAction`** rather than a nested `<ActionForm>` — React 19's `useActionState` contract doesn't multiplex two actions on one form, and a second ActionForm would have required mirroring every visible input as a hidden control. Preview errors surface via `window.alert` as the simplest path; operators hit the same validation at send-time.
5. **Per-material radios use uncontrolled `__material-mode-radio-*` names that never serialize** plus a hidden `materialMode[{id}]` that DOES serialize — keeps the wire-format clean while letting React state drive the radio UI.
6. **`iframe sandbox="allow-same-origin"`** (no `allow-scripts`) — the Splash shell + operator body is already escape-safe and same-origin lets styles render.
7. **`attachmentSummary.total_size_bytes` sums ALL materials' R2 sizes**, not just inline — operator's sanity-check is about TOTAL email weight.
8. **Snapshot `body_text` stays raw** (no rendered HTML stored on the row) — re-render-on-read from snapshot + materials + PTP-at-send-time is the v2 path. Matches Brief 157's intentional snapshot/delivered divergence.

### Latent issues found

- **PA flow change is operator-side and NOT yet executed.** Until PA's drain flow expression maps `is_inline` + `content_id` per attachment onto Send Email V2's `IsInline` + `ContentId`, inline-flagged images fall back to flat attachments. The body HTML still ships; Outlook shows a broken-image placeholder for the unresolved CID, Gmail hides it. PRE_DEPLOY_PROMO.md §6.5 has the exact expression edits the operator needs.
- **Brief 134 entry in CLAUDE.md** previously called the shell file by its forms-worker path; updated to note the Brief 160 extraction. Future executors should grep for both `workflow-email-shell.ts` (legacy mentions in BUILD_STATE.md / INDEX.md) and `@splash/email-shell` (canonical going forward).
- **`promoExists` rename** — no caller outside `announce.ts` referenced the helper; renamed cleanly. Worth grep'ing if a future brief reintroduces a similar lookup helper to avoid name collisions.
- **`PromoMeta` interface stays handler-local** — promo-worker has no shared types module for handlers yet. If the next handler also needs `{id, title}` from `promotions`, candidate for promotion to a shared `_db.ts`.

### Validation results

- `pnpm typecheck` — **21/21 successful** (+1 from new `@splash/email-shell` package). 13.5 s total.
- `pnpm --filter @splash/email-shell build` — clean `tsc` emit.
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — **2024.58 KiB raw / 445.49 KiB gzip**. Behavior identical post-extraction (the swap is one import line).
- `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — **881.31 KiB raw / 167.73 KiB gzip**. +36 KiB raw / +7 KiB gzip vs Brief 157 from the renderer + shell dep. Well under CF's 3 MiB compressed free-tier ceiling.
- `pnpm --filter @splash/web build` — green. `/admin/promotions/[id]` route at **6.84 kB / 114 kB First-Load JS** — comfortably under the 150 kB target. `/admin/promotions/[id]/ticket` at 3.96 kB / 111 kB unchanged.
- Renderer snapshots at `apps/promo-worker/test/render-html.snap.ts` ready for human review (no CI runner). Run with `tsx` to dump the three fixtures' rendered HTML + plain text.
- `.tmp-build` directories cleaned up.

### Confirmations

- **Preview rendering matches send rendering byte-for-byte** — both call `renderAnnouncement` with the same input shape; preview and send share `parseAndValidateBody` so validation cannot diverge.
- **The forms-worker bundle still builds** and shows no behavioral change after the shell extraction — `workflow-email-step.ts` is the only file that changed.
- **The promo-worker bundle absorbs the renderer + shell without breaching size limits** — 881.31 KiB raw / 167.73 KiB gzip vs CF's 3 MiB compressed limit.
- **Apps/web `/admin/promotions/[id]` route remains under 150 kB First-Load budget** at 114 kB.
- **Preview sub-modal iframe `sandbox="allow-same-origin"`** prevents script execution while letting styles render. No `allow-scripts` token.
- **PA flow change is documented** in PRE_DEPLOY_PROMO.md §6.5 (not executed; operator-side).

### Diff size

~1100 LOC net across the new package (~140 LOC), promo-worker handlers (~420 LOC including the preview endpoint and shared validation), apps/web modal rewrite (~300 LOC), forms-worker refactor (~30 LOC of swaps + extra plumbing), docs (~200 LOC). Within the brief's 800-1200 LOC estimate.
