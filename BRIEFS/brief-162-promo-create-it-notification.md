# Brief 162: Promo creation → IT notification email

**Status:** Completed (2026-06-06)
**Started:** 2026-06-06
**Completed:** 2026-06-06
**Blocks:** Creating a promo in the UI lands a `promotions` row + auto-spawned `promo_tickets` row (Brief 154), but IT has no proactive notification channel. They have to remember to check `/admin/promotions/queue` to discover new submissions. Latency between a marketing operator submitting and IT seeing it can be hours. Operator: "creating the promo should trigger an email to IT with details of the promo from the submission and a link to the ticket".
**Dependencies:** Brief 154 (create promo endpoint that this brief hooks into), Brief 127 (`outbound_emails` queue infrastructure — the notification rides this), Brief 160 (`@splash/email-shell` shared branded HTML shell — reused for the notification body), Brief 159 (`promo_user_roles` table — recipient resolution reads this), Brief 161 (recent attachments-payload fix — establishes the worker-side notification pattern).

## Read first

- BUILD_STATE.md
- CLAUDE.md — "Promotions feature" glossary entry (covers the create flow + role gates); Brief 127 / 160 / 161 glossary entries (queue + shell + attachment patterns).
- BRIEFS/brief-154-promo-crud-endpoints.md (create endpoint shape — the hook point).
- BRIEFS/brief-160-promo-announcement-preview-branded-html-inline-materials.md (the rendering pattern + email shell extraction — reused here).
- BRIEFS/brief-127-outbound-emails-queue.md (queue helper + dedup contract).
- apps/promo-worker/src/handlers/promos.ts (the `handleCreatePromo` handler — the post-insert hook point).
- apps/promo-worker/src/announce/render-html.ts (the rendering pattern for the announcement — this brief writes a sibling renderer for the create-notify email).
- packages/db-supabase/src/outbound-emails.ts (`enqueueOutboundEmail` helper + `OutboundEmailAttachment` shape).
- packages/email-shell/ (the `@splash/email-shell` package — reused for the branded shell).

## Architecture context

A promo creation event today:
1. Marketing operator hits `/admin/promotions/new`, fills form, submits.
2. Apps/web `createPromoAction` → worker `POST /promo/api/promos`.
3. Worker INSERTs `promotions` row + auto-spawns `promo_tickets` row + `promo_locations` per code + `promo_activity_log created` row.
4. Apps/web router.push's to `/admin/promotions/{id}` (live view).
5. **End of flow.** IT learns about the new promo on their next visit to `/admin/promotions/queue`.

Brief 162 adds step 4.5: enqueue a branded HTML email to every IT-tier user notifying them of the new submission with a link to the ticket page.

Mechanism mirrors Brief 157's announcement send: fan out one `outbound_emails` row per recipient via `enqueueOutboundEmail`. The existing Brief 127 PA flow drains the queue and sends. Zero new infrastructure.

## Scope

### Phase 1 — Recipient resolution

1.1 New helper `resolveItNotificationRecipients(env): Promise<string[]>` in `apps/promo-worker/src/handlers/_notify.ts` (new file — sibling to `_activity.ts`).

  - Query `auth_unified` via PostgREST for `promo_role IN ('it', 'super_admin')` AND `email IS NOT NULL`.
  - Dedup case-insensitive preserving first-occurrence casing.
  - Return sorted array.
  - Empty result (zero IT users) is valid — handler logs and skips the fan-out.

1.2 Decision: scope-tier vs. static distro.
  - **Chose: dynamic role-based** (`promo_role IN ('it', 'super_admin')`). Onboarding/offboarding is automatic — Brief 159's Set Promo Role card maintains the recipient list as a side effect of role grants.
  - **Rejected: static IT distro `[vars]` entry**. Adds a config surface that drifts from auth_unified state. Operators who want a shared-inbox backstop can grant `promo_role = 'it'` to the inbox's auth user.
  - **Rejected: combined (dynamic + static)**. Adds dedup complexity for marginal value at v1. Future brief can add `INCIDENTS_EMAIL`-style backstop if operationally needed.

1.3 The submitter does NOT receive a copy. They already see the live view they just landed on. Future brief can opt-in.

### Phase 2 — Render the notification email

2.1 New module `apps/promo-worker/src/announce/render-create-notify.ts`:

```ts
import { wrapInEmailShell, escapeHtml } from "@splash/email-shell";

export interface RenderCreateNotifyInput {
  promoId: string;
  title: string;
  promoType: string;
  posBehavior: string | null;
  priority: string;
  proposedStartDate: string;       // YYYY-MM-DD
  proposedEndDate: string;         // YYYY-MM-DD
  requestedGoLiveDate: string;     // YYYY-MM-DD
  locationCodes: string[];
  submitterEmail: string;
  ticketUrl: string;               // https://splashcarwashes.info/admin/promotions/{id}/ticket
  liveViewUrl: string;             // https://splashcarwashes.info/admin/promotions/{id}
}

export interface RenderCreateNotifyOutput {
  html: string;
  plainText: string;
}

export function renderCreateNotify(input: RenderCreateNotifyInput): RenderCreateNotifyOutput;
```

2.2 Body content (HTML):
  - `<h2>` "New promotion submitted" — navy, matches the shell's accent palette.
  - Brief metadata grid (`<dl>` styled with inline CSS):
    - **Title**: input.title
    - **Type**: input.promoType
    - **Priority**: input.priority (color-tinted span: red for High, amber for Medium, neutral for Low)
    - **Requested go-live**: input.requestedGoLiveDate formatted as "MMM D, YYYY"
    - **Proposed window**: "{startDate} → {endDate}" (formatted)
    - **Locations affected**: `N location codes` (count); first 5 listed, then "and N more" if `locationCodes.length > 5`
    - **POS behavior**: input.posBehavior or `(not specified)` muted
    - **Submitted by**: input.submitterEmail
  - Primary CTA button "Open IT ticket" → input.ticketUrl (sudsy blue, prominent).
  - Secondary link "View promo overview" → input.liveViewUrl (text link, smaller).
  - Closing paragraph: "Pick this up in the IT queue when you're ready to scope."

2.3 Plain-text body: same content, line-break separated, no styling. URLs spelled out in full so plain-text clients render clickable.

2.4 Use `wrapInEmailShell(bodyHtml, { title: 'New promotion submitted: {title}', preheader: '{title} — {type}, {priority} priority' })` for the wrap.

### Phase 3 — Wire into `handleCreatePromo`

3.1 In `apps/promo-worker/src/handlers/promos.ts`, locate `handleCreatePromo`. After the four-step insert sequence (promotions → promo_tickets → promo_locations → promo_activity_log) AND after the `201` response is already in flight (use `ctx.waitUntil` so the fire-and-forget doesn't block the operator's redirect):

```ts
ctx.waitUntil(fireCreateNotify(env, {
  promoId,
  title,
  promoType,
  posBehavior,
  priority,
  proposedStartDate,
  proposedEndDate,
  requestedGoLiveDate,
  locationCodes,
  submitterEmail: gate.session.email,
}).catch((err) => {
  console.error("[promo.create] IT notify failed (fail-soft):", err);
}));
```

3.2 Implement `fireCreateNotify(env, input)` in `apps/promo-worker/src/handlers/_notify.ts`:
  - Resolve IT recipients via `resolveItNotificationRecipients(env)`.
  - Empty → log `[promo.create] no IT recipients — skipping notify` and return.
  - Build the `ticketUrl` + `liveViewUrl` from `APPS_WEB_BASE_URL` (existing var on the worker — mirrors damage-worker's Brief 32 pattern; if not yet bound on promo-worker's wrangler.toml, add it).
  - Render the email via `renderCreateNotify(...)`.
  - Fan out: one `enqueueOutboundEmail` per recipient with:
    - `source_worker: 'promo-worker'`
    - `source_kind: 'promo-create-it-notify'`
    - `source_id: promoId`
    - `recipient` (per-recipient)
    - `subject: \`New promo: \${title}\``
    - `body_html` + `body_text` from the renderer
    - `attachments: []` (no materials at creation time)
  - Per-recipient `try/catch` — failures collected into a logged array but don't block other recipients.

3.3 Dedup posture: `(promo-worker, promo-create-it-notify, promoId, recipient)` is the unique tuple per Brief 127. Re-firing for the same promo + recipient is a no-op. Each promo notifies each IT user at most once.

3.4 `ExecutionContext` plumbing: `handleCreatePromo` already receives `_ctx: ExecutionContext` (or similar) — confirm and use. If currently typed as `_ctx`, rename to `ctx` for the `waitUntil` call. Mirrors Brief 102's `fireInternalNewClaimNotification` pattern.

3.5 The fire-and-forget MUST run AFTER the 201 response is constructed so a slow Supabase recipient query doesn't slow the operator's redirect. `ctx.waitUntil` is the right primitive — the response returns immediately; the fan-out runs in background.

### Phase 4 — `APPS_WEB_BASE_URL` binding

4.1 If `apps/promo-worker/wrangler.toml` does NOT yet declare `APPS_WEB_BASE_URL` as a `[vars]` entry, add it:

```toml
[vars]
SUPABASE_URL = "https://rewokyofschtvqgxrxwl.supabase.co"
APPS_WEB_BASE_URL = "https://splashcarwashes.info"
```

  - Staging override is per-environment if the worker has multiple environments; if it's single-env on workers.dev only, the value is the production host (the URL is what recipients SEE in the email).
  - Mirrors damage-worker's pattern.

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass.
5.2 `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — bundle still emits.
5.3 Manual verification (operator runs post-deploy):
  - Grant promo_role = 'it' to a test user (sysadmin → Set Promo Role).
  - Create a promo via `/admin/promotions/new`.
  - Confirm:
    - 201 response from create endpoint (operator redirects to live view).
    - Within ~10 seconds, an `outbound_emails` row appears with `source_kind = 'promo-create-it-notify'` for each IT recipient.
    - Within 5 minutes, the PA flow drains and recipients receive the email.
    - Recipient inbox shows Splash-branded HTML body with the promo details + working "Open IT ticket" CTA.
  - Negative case: create a second promo immediately. New rows in the queue with the new promo_id — NOT dedup-suppressed (different `source_id`).
  - Negative case: re-fire the SAME promo's notify (would only happen via a worker bug, not user action) — dedup-suppressed cleanly.

### Phase 6 — Docs

6.1 BRIEFS/INDEX.md: Brief 162 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
  - New promo-creation IT notification path: post-insert `ctx.waitUntil` fires a branded HTML email to every `promo_role IN ('it', 'super_admin')` user
  - New module `apps/promo-worker/src/handlers/_notify.ts` (sibling to `_activity.ts`)
  - New renderer `apps/promo-worker/src/announce/render-create-notify.ts` reusing `@splash/email-shell`
  - New `source_kind = 'promo-create-it-notify'` in `outbound_emails` (dedup keyed on `(source_worker, source_kind, promoId, recipient)`)
  - APPS_WEB_BASE_URL var added to promo-worker wrangler.toml (if not already present)
  - No PA flow changes required — drain handles the new kind automatically via Brief 127's source-agnostic pattern

6.3 CLAUDE.md updates:
  - "Promotions feature" glossary entry (Brief 162 paragraph): describe the create-notify path, recipient resolution rule (`promo_role IN ('it', 'super_admin')`), dedup tuple, fail-soft posture, and that the notification rides the Brief 127 queue (no new PA work).
  - "outbound_emails table" glossary entry: add `promo-worker / promo-create-it-notify / {promo_id}` to the writers list.

## Out of scope

- Notifications on OTHER lifecycle events (status changes, ready-by changes, assignment, completion). Each is a candidate for its own brief — this one scopes to the creation event only.
- Per-IT-user opt-out / opt-in flags. v2 candidate. Today, granting `promo_role = 'it'` is the opt-in.
- Submitter receives a copy. Out of scope per Phase 1.3.
- Configurable subject template / body template via UI. The subject + body are server-rendered constants.
- Threading the IT notification email into the eventual announcement send. They're separate concerns; threading would only confuse the recipient.
- CC'ing the submitter or any other party.
- Backfilling notifications for promos created before this brief lands. Operator can manually trigger an announcement from those promos' live view if they want IT awareness retroactively.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- New helper `resolveItNotificationRecipients(env)` exported from `apps/promo-worker/src/handlers/_notify.ts`
- New renderer `renderCreateNotify(input)` exported from `apps/promo-worker/src/announce/render-create-notify.ts` (or co-located in `_notify.ts` if smaller than expected)
- `handleCreatePromo` fires `ctx.waitUntil(fireCreateNotify(...))` AFTER the 201 response is constructed
- `outbound_emails` dedup tuple `(promo-worker, promo-create-it-notify, promoId, recipient)` correctly suppresses re-fires for the same logical event
- Fail-soft: any error in recipient resolution OR render OR per-recipient enqueue is logged and swallowed — never blocks the promo create response
- `APPS_WEB_BASE_URL` bound on the worker (existing or new)
- pnpm typecheck passes
- promo-worker dry-run deploy succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (expected 200-350 LOC: helper module + renderer + handler wiring + wrangler.toml var if needed)
- Confirmation that:
  - Create returns 201 immediately even when recipient resolution is slow (the fire is `waitUntil`-ed)
  - Empty IT recipient list logs cleanly and skips the fan-out
  - Dedup index suppresses double-fires for the same promo/recipient tuple
  - Validation results
- Any decisions made on the operator's behalf

## Outcome

### Files created

- `apps/promo-worker/src/handlers/_notify.ts` — sibling to `_activity.ts`.
  Exports `resolveItNotificationRecipients(env)` (PostgREST GET on
  `auth_unified` filtered to `promo_role=in.(it,super_admin)` AND
  `email=not.is.null`; dedup case-insensitive preserving first-occurrence
  casing; sorted) and `fireCreateNotify(env, req, input)` (composes the
  email via `renderCreateNotify` + fans out one `enqueueOutboundEmail`
  per recipient with `source_kind: 'promo-create-it-notify'` +
  `source_id: promoId` + `attachments: []`). Fail-soft on every layer
  (recipient resolution throw → log + skip; empty recipient list → log
  + return; per-recipient enqueue throw → log + collect into a
  `failed[]` array, never blocks other recipients, never blocks the
  parent response). Includes a local `resolveAppsWebBase(env, request)`
  helper that mirrors damage-worker's `resolveAdminBase` (workers.dev
  hostnames rewrite to production; `staging.splashcarwashes.info`
  passes through; missing request → env fallback) so staging-test
  promos link to the staging apps/web and production promos link to
  production apps/web.

- `apps/promo-worker/src/announce/render-create-notify.ts` — sibling to
  `render-html.ts`. Exports `renderCreateNotify(input):
  {html, plainText}`. HTML body: `<h2>` "New promotion submitted" (navy),
  short intro paragraph, two-column `<table>` metadata grid (Title /
  Type / Priority pill (red/amber/neutral by tier) / Requested go-live /
  Proposed window / Locations affected (count strong + first 5 listed
  + "and N more" tail) / POS behavior (or "(not specified)" muted) /
  Submitted by), prominent sudsy-blue "Open IT ticket" CTA button
  (table-wrapped for Outlook compatibility), secondary "view promo
  overview" text link, closing "Pick this up in the IT queue when
  you're ready to scope." Wrapped in `wrapInEmailShell` from
  `@splash/email-shell` with `title: "New promotion submitted: {title}"`
  + `preheader: "{title} — {type}, {priority} priority"`. Plain text
  mirrors the same content line-break separated, URLs spelled out in
  full so plain-text clients render them clickable.

### Files modified

- `apps/promo-worker/src/handlers/promos.ts` — added `import
  { fireCreateNotify } from "./_notify.js"`. Renamed
  `handleCreatePromo`'s third arg from `_ctx: ExecutionContext` to
  `ctx: ExecutionContext`. Added `ctx.waitUntil(fireCreateNotify(env,
  req, {...}).catch(...))` immediately before the `return
  jsonResponse({ ok: true, promo: detail }, 201)`. The `.catch` is a
  belt-and-suspenders guard for anything that escapes
  `fireCreateNotify`'s internal try/catches (it shouldn't, by design,
  but `waitUntil` swallows unhandled rejections silently and we want
  the log line).

- `apps/promo-worker/src/index.ts` — `Env` interface gained
  `APPS_WEB_BASE_URL: string;` with a documentation comment.

- `apps/promo-worker/wrangler.toml` — `[vars]` block gained
  `APPS_WEB_BASE_URL = "https://splashcarwashes.info"` with a Brief 162
  preamble comment. Mirrors damage-worker's pattern.

### Decisions made on operator's behalf

1. **Dynamic role-based recipient resolution** (per the brief's
   Decision section in Phase 1.2): `promo_role IN ('it', 'super_admin')`
   AND `email IS NOT NULL`. Onboarding/offboarding flows automatically
   through Brief 159's Set Promo Role card — no separate IT distro
   `[vars]` entry to drift out of sync.

2. **`APPS_WEB_BASE_URL` resolution mirrors damage-worker's
   `resolveAdminBase`** (workers.dev → production; staging hostname
   passes through). The brief noted "mirrors damage-worker's pattern";
   `_notify.ts` ships a small local copy of the helper rather than
   importing across worker boundaries — `damage-worker/src/admin-url.ts`
   isn't a shared package, and inlining 15 LOC is lower-friction than
   manufacturing a `@splash/admin-url` workspace dep at v1. If a third
   notification-firing worker materializes, that's the right time to
   promote it.

3. **Inbound `Request` is threaded into `fireCreateNotify`** so the
   admin-base resolver can prefer the inbound request's hostname over
   the env fallback. `handleCreatePromo`'s `ctx.waitUntil` captures the
   `req` closure — by the time `fireCreateNotify` runs, the response
   has already returned, but the `Request` object's `url` is still
   readable (it's a string field, not a stream). Lets the same code
   path work cleanly across workers.dev / staging / production without
   per-env wrangler files.

4. **`attachments: []` on every enqueue.** The brief explicitly scoped
   this to creation-event notifications; no materials exist yet at
   create time, and the IT recipients can pull the empty-materials
   promo up from the live view link to confirm. No PA flow change
   required vs. Brief 157 (drains the queue identically regardless of
   `source_kind`).

5. **Date format `"MMM D, YYYY"` is rendered server-side** in the
   renderer using a small hardcoded `MONTHS` lookup + UTC parsing
   (matches Brief 32 / Brief 134 conventions where the email is sent
   in batch and the recipient's timezone isn't known — the dates are
   wall-clock business dates anyway, not instants).

6. **HTML body uses inline-styled `<table>` for the metadata grid** —
   matches the workflow-email-shell's documented boring-and-correct
   path. Outlook's Word renderer doesn't honor modern flex/grid CSS
   and may strip `<style>` blocks; `<table>` + inline `style="..."` is
   the universal-rendering path.

7. **No new `PromoActivityType` enum entry.** The notification fan-out
   doesn't write to `promo_activity_log` — adding "notification_sent"
   would require a Supabase CHECK-constraint widening for marginal
   value (the queue table already carries every enqueued row with
   `source_kind = 'promo-create-it-notify'`, queryable via the
   Brief 128 admin email-queue viewer).

### Latent issues / forward flags

- **The recipient resolution query reads `auth_unified` directly** —
  if the `promo_role` column is dropped or the view is recreated
  without it, the query 400s with an `"unknown column"` error that
  surfaces as a thrown `Error` in the log line. The recipient
  resolution path swallows this (fail-soft) and the create succeeds
  silently. Future schema changes that touch `auth_unified.promo_role`
  should grep this brief's path.

- **Power Automate flow doesn't need any edit.** PA's queue drain
  reads `body_html` / `body_text` from the row and sends —
  `source_kind` is opaque metadata. Worth a smoke test on first
  staging deploy to confirm the rendered HTML displays correctly in
  Outlook (renderer is patterned after the announcement renderer
  which already ships), but no expression edit is required.

- **No backfill for promos created before Brief 162 lands.** Per the
  brief's Out-of-scope section, IT can manually trigger an
  announcement from those promos' live view if they want IT awareness
  retroactively.

- **Submitter does NOT receive a copy.** Per Phase 1.3. Future brief
  can add an opt-in "CC me on the notification" toggle on the create
  form if operators request it.

- **No per-IT-user opt-out flag.** Granting `promo_role = 'it'` is the
  opt-in today. v2 candidate (mirrors the `promo_notify_opt_out`
  pattern any future per-event notification brief might also need).

### Validation results

- **`pnpm typecheck`**: 21/21 packages green (13.0s).
- **`pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run`**:
  bundle emits at **893.02 KiB raw / 170.65 KiB gzip** (+11.44 KiB raw
  / +2.88 KiB gzip vs Brief 161's 881.58 KiB raw / 167.77 KiB gzip).
  Both new bindings surface in the dry-run report:
  - `env.APPS_WEB_BASE_URL ("https://splashcarwashes.info")` —
    Environment Variable.
  - Existing `env.SUPABASE_URL` + `env.PROMO_FILES` unchanged.
- Diff size: ~290 LOC added (`_notify.ts` ~180 LOC including comments;
  `render-create-notify.ts` ~210 LOC including comments; ~20 LOC
  added to `promos.ts` for the `ctx.waitUntil` block + import; ~7 LOC
  in `wrangler.toml` + `index.ts` for the new var). Comfortably
  inside the brief's 200-350 LOC expectation.

### Manual verification checklist (operator-side, post-deploy)

1. Push triggers CF Workers Builds; confirm `splash-promo` deploys.
2. Grant `promo_role = 'it'` to a test user via sysadmin → Set Promo Role.
3. Create a promo via `/admin/promotions/new`. Confirm:
   - 201 response from the create endpoint (operator redirects to live view immediately).
   - Within ~10 seconds, an `outbound_emails` row appears for each IT
     recipient with `source_worker='promo-worker'`,
     `source_kind='promo-create-it-notify'`,
     `source_id=<promo_id>`.
   - Within 5 minutes, the PA drain flow picks up the rows and
     recipients receive the email.
   - Recipient inbox shows the Splash-branded HTML body with the promo
     details + a working "Open IT ticket" CTA (production URL on
     production / staging URL on staging).
4. Create a second promo immediately — new queue rows with the new
   promo_id (NOT dedup-suppressed; different `source_id`).
5. Re-fire the same promo's notification path (would only happen via
   a worker bug, not user action) — dedup-suppressed cleanly via
   `outbound_emails` unique index on `(source_worker, source_kind,
   source_id, recipient)`.
