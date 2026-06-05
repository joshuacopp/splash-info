# Brief 157: Promotions — announcement send (snapshot + outbound_emails fan-out)

**Status:** Completed (2026-06-05)
**Started:** 2026-06-05
**Completed:** 2026-06-05
**Blocks:** apps/web live-view "Compose announcement email" affordance (Brief 158); the apps/web detail page surfaces "Announcements sent (N)" with click-through to the per-announcement snapshot.
**Dependencies:** Brief 153 (substrate), Brief 154 (detail response shape for the per-promo `announcements` key — see "Detail-response extension" below), Brief 156 (materials must exist before the attachment-picker has anything to select).

## Read first

- BUILD_STATE.md.
- CLAUDE.md — `outbound_emails` glossary entry (Brief 127); the cross-worker queue conventions for `source_worker` / `source_kind` / `source_id` / `recipient` dedup; the workflow-email-step pattern in forms-worker (Brief 127) as the helper reference.
- supabase/promo-tables.sql — column shape for `promo_announcements` and the `attachments` JSONB shape on `outbound_emails`.
- BRIEFS/brief-127-outbound-email-queue-and-workflow-email-steps.md — the queue conventions + the `enqueueOutboundEmail` helper in `@splash/db-supabase/outbound-emails.ts`.
- BRIEFS/brief-156-promo-materials-upload-and-ptp-write.md — the materials read shape this brief consumes to resolve attachments.
- packages/db-supabase/src/outbound-emails.ts — `enqueueOutboundEmail` helper; reuse it directly (no per-recipient queue logic duplicated in promo-worker).
- apps/promo-worker/src/handlers/_activity.ts — shared activity-log helper.

## Architecture context

This brief lands the announcement send surface. The mockup's "Compose announcement email" modal collected recipients + subject + body + a checkbox list of materials and an "include PTP" toggle, then mock-sent. This brief makes the send real by writing a `promo_announcements` snapshot AND fanning out per-recipient rows on the existing Brief 127 `outbound_emails` queue. PA drains the queue and delivers — single PA flow for the entire monorepo, zero new PA work per promo.

**Endpoint inventory (one new route):**

- `POST /promo/api/promos/{id}/announce` — compose + snapshot + fan-out. `super_admin | it | marketing`.

Plus a small **detail-response extension** to Brief 154: `GET /promo/api/promos/{id}` already returns `announcements: []` placeholder per the Brief 154 contract; this brief makes it return the actual list (most-recent-first, capped at 20 to keep the response light — full history via a separate endpoint if needed later).

**Auth posture.** Same as Brief 156 / 155: `getAuthContext` → `gatePromoRole(role, [...])`. CSRF gate (`isOriginAllowed`) on the POST.

**Recipient list — operator-supplied at v1.** Apps/web (Brief 158) will resolve `pricing_simple.am_email / rm_email / site_email` per affected location and present an editable to-list in the compose modal. The worker accepts the explicit array from the body — keeps the worker simple and lets the UI decide who's on/off the list per send. A v2 brief can add `?derive_from_locations=1` if operators want the worker to do the resolution.

**Snapshot then fan-out.** Sequence:

1. Validate body.
2. INSERT into `promo_announcements` (single row capturing subject, body_text, selected material_ids, recipient_emails, include_ptp). Capture the new `announcement_id`.
3. For each recipient, call `enqueueOutboundEmail(env, payload)` with:
   - `source_worker = 'promo-worker'`
   - `source_kind = 'promo-announcement'`
   - `source_id = announcement_id` (NOT promo_id — dedup uniqueness is per-announcement so re-firing the same announcement is a no-op via Brief 127's `Prefer: resolution=ignore-duplicates` semantics, but a future announcement on the same promo to the same recipient lands cleanly).
   - `recipient = email`
   - `subject`, `body_text` (operator-supplied), `body_html` null at v1 (operator-authored HTML is a v2 candidate; Brief 134's auto-HTML render isn't reused here because the body is operator-typed plain text, not template-rendered).
   - `attachments[]` — one entry per selected material with `{filename: material.name, mime: material.file_mime, size_bytes: material.file_size_bytes, r2_key: material.r2_key, bucket: 'PROMO_FILES'}`. Brief 127's claim endpoint inlines base64 from R2 keys at PA poll time, so the queue rows stay small.
4. Activity log: `announcement_sent` with `details = { announcement_id, recipient_count, material_count, included_ptp, subject }`.

**No transaction across snapshot + fan-out.** PostgREST doesn't transact across multi-row inserts cleanly. If a queue enqueue throws mid-fan-out, the snapshot row exists but some recipients never got queued. Two mitigations:

- Per-recipient enqueue failures are caught individually and logged with `[promo.announce] enqueue failed for {recipient}: {error}`. The handler continues to the next recipient — partial fan-out is acceptable.
- The response carries `enqueued_count` and `failed_recipients[]` so apps/web can surface a warning banner ("Announcement sent to 12 of 13 — wilton@... failed"). Operator can retry the missing recipients via the admin email-queue viewer (Brief 128).

If the snapshot row INSERT itself fails, return 500 `announcement_create_failed` and skip the fan-out entirely.

**PTP inclusion.** When `includePtp = true`, the handler reads `promo_ptp` for this promo and appends a formatted block to the queued `body_text` BEFORE enqueuing:

```
[body_text from operator]

---

PTP (Purpose, Tools, Process)

Purpose: {ptp.purpose}
Tools: {ptp.tools}
Process: {ptp.process}
```

The snapshot row's `body_text` column stores the body WITHOUT the appended PTP (it's redundant — `included_ptp = true` + the joined PTP row at read time covers it). What gets stored on `outbound_emails.body_text` includes the appended PTP because that's what actually gets sent. Two different views, intentional.

## Context

The mockup announcement modal was the most-deferred surface in the UX walkthrough because it depends on three prior pieces: materials (Brief 156), PTP (Brief 156), and the `outbound_emails` queue (already in place from Brief 127). Now that all three are wired, this brief finishes the send loop.

The `promo_announcements` snapshot table is what makes per-send audit feasible. Without it, "for promo X, which materials were attached to the announcement on May 5?" requires forensic reconstruction from `outbound_emails` (which carries the rendered attachments by R2 key but not the operator's intent — "materials 1, 3 and the PTP doc"). The snapshot row captures intent at compose time, so the live-view page can render a clean "Announcements sent (3)" affordance with click-through to each one's manifest.

## Scope

### Phase 1 — Handler skeleton

New handler file `apps/promo-worker/src/handlers/announce.ts` exporting `handleSendAnnouncement`. Plus a small edit to `promos.ts` (Brief 154) to populate the `announcements` array on the detail response.

Update `apps/promo-worker/src/index.ts` dispatch:

```ts
import { handleSendAnnouncement } from "./handlers/announce";

const announceMatch = url.pathname.match(/^\/promo\/api\/promos\/([0-9a-f-]+)\/announce$/);
if (announceMatch && request.method === "POST") return handleSendAnnouncement(request, env, ctx, announceMatch[1]);
```

### Phase 2 — `POST /promo/api/promos/{id}/announce`

**Auth:** session + `gatePromoRole(role, ['super_admin', 'it', 'marketing'])` + `isOriginAllowed`.

**Body (JSON):**

```json
{
  "subject": "Memorial Day BOGO — go-live May 23",
  "bodyText": "Hi team, here's what's queued for your locations...",
  "recipientEmails": ["rd-binghamton@...", "rm-binghamton@...", "binghamton@..."],
  "selectedMaterialIds": ["uuid", "uuid"],
  "includePtp": true
}
```

**Validation:**

- Reject body with unknown keys (400 `bad_request`).
- `subject` — required, trimmed, ≤500 chars.
- `bodyText` — required, ≤50000 chars (longer than ticket fields; announcement bodies can be substantive).
- `recipientEmails` — required, non-empty array, ≤500 entries (defense in depth), each a syntactically-valid email per `packages/types/src/email-validate.ts isValidEmail` (Brief 152). Dedup server-side (case-insensitive). Reject 400 `invalid_recipients` listing the failing entries.
- `selectedMaterialIds` — optional array (default `[]`). Each must be a UUID v4 shape AND must reference a material belonging to this promo. Reject 400 `material_not_on_promo` listing offenders.
- `includePtp` — optional boolean (default `false`).
- 404 if promo id doesn't exist.

**Sequence:**

1. Read the promo's materials (SELECT id, name, kind, r2_key, file_mime, file_size_bytes FROM promo_materials WHERE promo_id = ... AND id IN (...selectedMaterialIds)). Verify all `selectedMaterialIds` resolved; reject 400 if any missing.
2. If `includePtp` is true, read `promo_ptp` for this promo. If no row (PTP was never written), proceed with empty values — render the appended block with `Purpose: (none)` etc. so the recipient still sees the placeholder. (Alternative: reject 400 `ptp_not_set`. Going with permissive for v1 — UI can warn the operator at compose time.)
3. INSERT into `promo_announcements` with `(promo_id, sent_by, subject, body_text, recipient_emails, included_material_ids, included_ptp)`. Capture `announcement_id`.
4. Build the rendered body that gets enqueued (operator's `body_text` + appended PTP block if `includePtp`).
5. Build the `attachments[]` JSONB array — one entry per resolved material with `{filename, mime, size_bytes, r2_key, bucket: 'PROMO_FILES'}`.
6. Loop `recipientEmails`. For each, `await enqueueOutboundEmail(env, { source_worker, source_kind, source_id: announcement_id, recipient, subject, body_text: renderedBody, body_html: null, attachments })`. Catch per-recipient errors; collect into `failed_recipients[]`.
7. Activity log: `announcement_sent` with `details = { announcement_id, recipient_count: recipientEmails.length, enqueued_count, failed_recipient_count: failed_recipients.length, material_count: selectedMaterialIds.length, included_ptp }`.

**Response (201):**

```json
{
  "ok": true,
  "announcementId": "uuid",
  "enqueuedCount": 12,
  "failedRecipients": ["wilton@splashcarwashes.com"],
  "sentAt": "2026-06-05T14:32:00Z"
}
```

`failedRecipients` is empty on full success. apps/web warns when non-empty.

### Phase 3 — Detail-response extension on `GET /promo/api/promos/{id}`

The Brief 154 detail response already returns `announcements: []` placeholder. Replace with a real read:

```ts
// In handleGetPromo (handlers/promos.ts), the PostgREST embed gains:
announcements:promo_announcements(
  id, sent_at, sent_by, subject, body_text,
  recipient_emails, included_material_ids, included_ptp
)
&announcements.order=sent_at.desc
&announcements.limit=20
```

`body_html` is intentionally skipped (always null at v1 and would inflate the response payload).

Returned shape on detail (added under `promo.announcements`):

```json
{
  "announcements": [
    {
      "id": "uuid",
      "sentAt": "...",
      "sentBy": "uuid",
      "subject": "...",
      "bodyText": "...",
      "recipientEmails": ["..."],
      "includedMaterialIds": ["uuid"],
      "includedPtp": true
    }
  ]
}
```

20-row cap matches the recent-activity-log cap on the same response. A future brief can add a paginated `GET /promo/api/promos/{id}/announcements` endpoint if operators want to browse history beyond 20.

### Phase 4 — Doc updates

1. **BUILD_STATE.md** — Findings + Brief 157 status.
2. **BRIEFS/INDEX.md** — new row.
3. **CLAUDE.md** — promo-worker glossary entry gains the announce endpoint + the detail-response extension. Add a one-liner to the outbound_emails glossary entry: "`source_kind='promo-announcement'` writers: promo-worker (Brief 157); source_id is the `promo_announcements.id`, NOT the promo_id."
4. **PRE_DEPLOY_PROMO.md** — add a smoke step for the announce endpoint.

### Phase 5 — Build + smoke

- `pnpm typecheck` + `pnpm --filter @splash/promo-worker build`. Bundle size delta should be small (reusing `enqueueOutboundEmail` from db-supabase).
- Smoke checks (manual, post-deploy; need a promo with at least one material from Brief 156 already in place):
  - POST `/announce` with 2 recipients + 1 material + `includePtp: true` (PTP exists) → 201, `enqueuedCount: 2`, `failedRecipients: []`. Supabase: 1 new row in `promo_announcements`, 2 new rows in `outbound_emails` with `source_kind='promo-announcement'` and matching `source_id`.
  - Re-POST the same announcement (same recipients) → succeeds, but the duplicate `outbound_emails` rows would 23505 the unique index → `enqueueOutboundEmail`'s `Prefer: resolution=ignore-duplicates` makes them no-ops. Confirm by counting `outbound_emails`: still 2 rows.
  - POST a NEW announcement for the same promo with overlapping recipients → 2 new `outbound_emails` rows (different `source_id` = new announcement_id, so dedup doesn't fire).
  - POST with an invalid recipient (`name.@gmail.com` — trailing dot per Brief 152) → 400 `invalid_recipients`.
  - POST with a material id from a DIFFERENT promo → 400 `material_not_on_promo`.
  - GET `/promo/api/promos/{id}` → response includes the announcement in `announcements[]`.
  - GET admin email queue viewer (Brief 128) at `/admin/email-queue` → see the new rows with `source_kind='promo-announcement'`.

## Definition of Done

- `apps/promo-worker/src/handlers/announce.ts` exists.
- `handleGetPromo` populates `announcements[]` per the extension above.
- Snapshot + fan-out + activity log all happen on a successful POST.
- Per-recipient enqueue errors are caught individually and surfaced in `failedRecipients[]`.
- Validation rejections (`bad_request`, `invalid_recipients`, `material_not_on_promo`) all return the correct shape.
- Typecheck + build pass; smoke checks recorded in Outcome.

## Out of scope (later briefs)

- Operator-authored HTML bodies — v2; current is plain text only.
- Auto-derived recipient lists (`?derive_from_locations=1`) — v2.
- PDF rendering of the snapshot — v2.
- Resend a previously-sent announcement to a subset of recipients — v2; operator can copy-paste subject/body into a new send today.
- Per-announcement attachment count display in the activity log timeline (currently captured in `details` JSONB; UI can render it via Brief 158).
- apps/web pages consuming this endpoint — Brief 158.

## Outcome

- **Files created:**
  - `apps/promo-worker/src/handlers/announce.ts` — `handleSendAnnouncement`
    (`POST /promo/api/promos/{id}/announce`). Validates body shape +
    recipient emails + material membership; INSERTs the
    `promo_announcements` snapshot; loops recipients calling
    `enqueueOutboundEmail` with `source_kind='promo-announcement'` +
    `source_id=announcement_id` + `bucket:'PROMO_FILES'` attachments;
    activity-logs `announcement_sent` via `ctx.waitUntil`. Per-recipient
    enqueue errors caught individually + surfaced in
    `failedRecipients[]`.

- **Files modified:**
  - `apps/promo-worker/src/index.ts` — import + dispatch the new
    `POST /promo/api/promos/{id}/announce` route; updated the route
    inventory comment block; updated the auth-posture comment to
    include Brief 157. The default 404 message now says "Brief 157+"
    so it stays accurate.
  - `apps/promo-worker/src/handlers/promos.ts` — extended
    `PromoDetailRow` + `PromoDetailResponse` with an `announcements`
    embed; widened the PostgREST `select` to include
    `announcements:promo_announcements(id, sent_at, sent_by, subject,
    body_text, recipient_emails, included_material_ids, included_ptp)`;
    added `announcements.order=sent_at.desc` and
    `announcements.limit=20`; mapped snake_case → camelCase in
    `fetchPromoDetail` with `recipientEmails` / `includedMaterialIds`
    defaulting `[]` when null.
  - `packages/db-supabase/src/outbound-emails.ts` — widened
    `OutboundEmailAttachment.bucket` from `"FORMS_FILES"` to
    `"FORMS_FILES" | "PROMO_FILES"` with an updated JSDoc block
    pointing future executors at the three-file change required to
    add a third bucket.
  - `apps/forms-worker/src/email-queue/attachments.ts` — widened
    `QueueAttachment.bucket` to match the helper type, and rewrote the
    `inlineAttachments` bucket-selection block to dispatch on
    `att.bucket === "PROMO_FILES"` → `env.PROMO_FILES` (else
    `env.FORMS_FILES`). Unbound or unknown bucket → skip with log,
    email still sends without attachment.
  - `apps/forms-worker/src/index.ts` — added optional `PROMO_FILES?:
    R2Bucket` to the `Env` interface with a JSDoc explaining the
    deploy-time binding requirement.
  - `BRIEFS/INDEX.md` — new Brief 157 row.
  - `CLAUDE.md` — promo-worker glossary entry gains the Brief 157
    paragraph (endpoint + validation + sequence + detail-response
    extension + bucket-widening sub-section + v2 candidates);
    `outbound_emails table` glossary entry gains the
    `source_kind='promo-announcement'` writer one-liner pointing at
    `announcement_id` as the `source_id` semantics.
  - `BUILD_STATE.md` — bumped "Last updated" with a Brief 157 summary;
    added a new Brief 157 row to the prioritized work list table.
  - `PRE_DEPLOY_PROMO.md` — §1 narrative bumped to Brief 157; §2
    gained a "Cross-worker dependency" callout documenting the
    operator-side `[[r2_buckets]] binding="PROMO_FILES"` block to add
    to `apps/forms-worker/wrangler.toml`; §6 gained smoke step 6 with
    a happy-path POST, the dedup re-POST behavior, a fresh
    announcement re-fan-out, three failure-mode probes, the detail
    GET, and the email-queue viewer hop.

- **Decisions made on operator's behalf:**
  1. **`bodyText` is NOT trimmed.** The brief says "≤50000 chars" but
     doesn't specify trimming; I left it raw because operators may
     legitimately use leading/trailing whitespace for letterhead-style
     formatting (e.g. ASCII signature block). Empty-string still
     rejects as `required`.
  2. **`recipientEmails > 500` returns 400 `bad_request` with
     `fields:{recipientEmails:"too_many"}`** rather than a dedicated
     code. The brief calls 500 a "defense-in-depth" cap; the
     too-many-recipients case in practice means an operator's CSV
     import went wrong, so the field-level error code is enough for
     apps/web to surface contextually.
  3. **Permissive PTP missing → `(none)` placeholders.** Brief
     explicitly lists this as an option ("Alternative: reject 400
     `ptp_not_set`. Going with permissive for v1") and I followed
     it. A future stricter mode is a one-line `return jsonError(400,
     "ptp_not_set")` if needed.
  4. **Activity-log fire wrapped in `ctx.waitUntil`** rather than
     awaiting before the response. `logActivity` is already fail-soft
     internally, so the only benefit of awaiting is slowing down the
     response. Mirrors what `handleCreatePromo` does NOT do (it
     awaits), but `handleSendAnnouncement` is on a per-recipient
     latency-sensitive path so the deferred fire is the better fit
     here.
  5. **Cross-worker bucket widening landed in-brief rather than
     deferred.** The brief specifies `bucket: 'PROMO_FILES'`
     verbatim, but Brief 127's existing
     `OutboundEmailAttachment.bucket` type was `"FORMS_FILES"`
     only — passing the string would TypeScript-error at the
     handler. Two options: widen the type (this brief) or fall
     back to inlining base64 in the queue row (defeats Brief 127's
     "rows stay small" intent). I went with widening because (a)
     the brief implicitly assumes the type already accepts
     `"PROMO_FILES"` (it says "Brief 127's claim endpoint inlines
     base64 from R2 keys at PA poll time" as if the path was
     already wired), (b) `enqueueOutboundEmail`'s contract should
     be the single source of truth for legal bucket names, and (c)
     the three-file change is small and surgical. forms-worker's
     `PROMO_FILES` binding is OPTIONAL so an un-redeployed
     forms-worker doesn't crash on existing queue rows — the
     attachment skips with a log line. PRE_DEPLOY_PROMO.md
     documents the operator-side `[[r2_buckets]]` block.
  6. **404 vs 400 on malformed promo UUID.** I used 404
     `promo_not_found` rather than 400 `bad_request`, matching the
     existing Brief 154/156 convention in `handleGetPromo` /
     `handleDeleteMaterial` (`PROMO_ID_RE.test(promoId)` → 404).
     Brief is silent on which one to use.
  7. **Material-id format-failure vs membership-failure.** A
     malformed-UUID material id (i.e. fails `MATERIAL_ID_RE`) lands
     in `invalidMaterialIds` and surfaces as 400 `bad_request` with
     `fields:{selectedMaterialIds:"invalid"}`. A well-formed UUID
     that doesn't belong to this promo OR doesn't exist surfaces as
     400 `material_not_on_promo` with `missing[]`. Distinct error
     codes so apps/web can render specific UX (the brief uses the
     same `material_not_on_promo` code for both — kept the format
     check separate because the failure mode is operator-controlled
     not server-state-controlled).

- **Latent issues found:**
  1. **forms-worker's `PROMO_FILES` binding requires an operator
     deploy step.** Until the operator adds the `[[r2_buckets]]
     binding="PROMO_FILES" bucket_name="splash-promo-files"` block to
     `apps/forms-worker/wrangler.toml` and redeploys, every promo
     announcement attachment will skip with a
     `[forms.email-queue] attachment ... references unsupported or
     unbound bucket PROMO_FILES; skipping` log. The email itself
     still sends, just without the attached materials. This is
     documented in PRE_DEPLOY_PROMO.md §2 ("Cross-worker
     dependency"). The fail-soft posture is intentional — operators
     can ship promo-worker independently and add the binding when
     ready.
  2. **No 5MB / attachment policy check at enqueue time on
     promo-worker.** The Brief 156 upload path enforces 50 MB per
     material and 20 materials per promo, but the queue inliner has
     its own 5 MB / attachment cap at PA poll time. A 6 MB promo
     material attached to an announcement will succeed at enqueue
     time but get dropped (with log) at claim time. The brief
     doesn't surface this — apps/web Brief 158 should warn the
     operator at compose time when a selected material exceeds 5 MB.
  3. **`enqueueOutboundEmail`'s `was_duplicate` return is not used
     here** because `failedRecipients[]` only collects throws, not
     no-op dedups. A re-fired announcement (same announcement id +
     same recipient) returns `was_duplicate: true` silently, which
     is the correct UX — the operator can hit the endpoint twice and
     PA still only sends one email. But the response's
     `enqueuedCount` will increment as if a fresh enqueue happened.
     This matches Brief 127's intent (the dedup is the queue's
     job, not the caller's accounting), but apps/web should label
     `enqueuedCount` as "rows touched", not "emails newly sent", in
     Brief 158's success banner.
  4. **`promo_announcements.sent_by` has no FK to `auth.users`** so
     a stale `session.userId` (e.g. a deleted user re-resurrected
     with a different UUID) would silently land. Same posture as
     every other actor column in the Splash schema (per
     promo-tables.sql conventions). Not a Brief 157 concern.
  5. **No rate limiting on the announce endpoint.** A super_admin
     could in theory POST 500 recipients × N times rapidly to flood
     `outbound_emails`. PA's 5-minute poll cap is a coarse
     downstream rate limit; CF's default request rate limit is the
     other backstop. No explicit per-IP / per-user cap at v1.

- **Validation results (typecheck / build / smoke):**
  - `pnpm typecheck` — **19/19 green** (7.745s; 12 cache hits + 7
    fresh compiles). Includes all four edited packages (db-supabase,
    promo-worker, forms-worker, fleet-inquiry-worker is unrelated
    but co-typechecked).
  - `pnpm --filter @splash/promo-worker exec wrangler deploy
    --dry-run` — **succeeded**. Bundle 860.30 KiB raw / 163.29 KiB
    gzip (vs Brief 156 baseline 845.03 / 160.58 → +15.27 KiB raw /
    +2.71 KiB gzip — entirely the new announce handler). Well under
    CF's 3 MiB compressed free-tier ceiling. Bindings printout
    confirms `env.PROMO_FILES` + `env.SUPABASE_URL` resolve at
    bundle time.
  - `pnpm --filter @splash/forms-worker exec wrangler deploy
    --dry-run` — **succeeded**. Bundle 2024.19 KiB raw / 445.37 KiB
    gzip (unchanged from Brief 156 baseline — the bucket dispatch
    rewrite is a few-line diff with no new imports). `env.PROMO_FILES`
    is NOT bound on forms-worker today (the operator needs to add the
    `[[r2_buckets]]` block per the deploy notes). The bindings
    printout shows just `FORMS_FILES`.
  - **Smoke tests deferred** per the brief's "manual, post-deploy"
    instruction. PRE_DEPLOY_PROMO.md §6 step 6 captures the full
    happy-path + dedup + fresh-fan-out + three failure-mode probes +
    detail GET + email-queue viewer check.

- **Bundle size on splash-promo deploy:** 860.30 KiB raw / 163.29 KiB gzip.
