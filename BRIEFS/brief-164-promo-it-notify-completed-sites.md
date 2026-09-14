# Brief 164: IT ticket — "Notify completed sites" button

**Status:** Completed (2026-06-06)
**Started:** 2026-06-06
**Completed:** 2026-06-06
**Blocks:** IT changes for specials (e.g. same-as-today, flash5, flash2 pricing flips) often have to be made one site at a time. Today, IT marks a site complete in the per-location progress widget, but there's no proactive way to inform the field that the change is live. Operators end up sending one-off emails manually. Operator: "As IT changes often must be made a single site at a time — for specials like same as today/flash sales (that change the actual prices of the products) — it would help to have an automated 'Inform site(s) of change' on the IT ticket — where after making a change, the IT user can select the site that is 'completed' and a convenient no-scroll 'notify site' button with a hint that 'Only site(s) that have not been notified yet will receive an email'".
**Dependencies:** Brief 155 (per-location progress toggle endpoint — this brief layers per-site notification on top), Brief 127 (`outbound_emails` queue), Brief 160 (`@splash/email-shell` branded HTML shell — reused for the per-site notification body), Brief 158a/b (apps/web IT ticket page + LocationProgressToggleable component — both extended here), Brief 101/102 (damage-worker's `getLocationContactInfo` helper pattern — same primitive reused here).

## Read first

- BUILD_STATE.md
- CLAUDE.md — "Promotions feature" entry (covers the IT ticket + location progress flow); Brief 101/102 entries (`getLocationContactInfo` pattern — `am_email`/`rm_email`/`site_email` fan-out); Brief 127/160 entries (queue + shell).
- BRIEFS/brief-155-promo-ticket-status-assignee-progress-writes.md (per-location progress endpoint shape — sibling to the new notify endpoint).
- BRIEFS/brief-158b-promo-apps-web-write-affordances.md (LocationProgressToggleable component + apps/web action wiring — this brief layers on top).
- packages/db-supabase/src/locations.ts (`getLocationContactInfo` helper).
- apps/promo-worker/src/handlers/promo-writes.ts (per-location progress handler — co-locate the new notify handler here).
- apps/web/app/admin/promotions/_components/LocationProgress.tsx + LocationProgressToggleable.tsx (the progress widgets — extended with a "notified" indicator).
- apps/web/app/admin/promotions/[id]/ticket/page.tsx (the IT ticket page — gets the new "Notify completed sites" button).

## Architecture context

A promo's `promo_locations` rows track per-(promo, location_code) state:
- `is_complete: boolean` — IT marked the site finished (Brief 155)
- `completed_at` / `completed_by` — when + who

This brief adds two more per-row columns:
- `notified_at: timestamptz | null` — when the per-site email was sent
- `notified_by: uuid | null` — which IT user fired the notification

Plus one endpoint, one helper, one UI button, one activity-log type, and a small visual indicator.

The notification body is a single hard-coded branded HTML email (no template registry — that's Brief 163's domain, scoped to marketing announcements). The body is short: "IT changes for [promo title] are live at your location. The special [name] is now active." plus the promo's basic metadata and an optional operator-supplied note line.

Recipients per site come from `getLocationContactInfo(locationCode)` — `am_email` + `rm_email` + `site_email` deduped. Same primitive damage-worker uses for claim notifications.

The button must be **convenient + no-scroll**, per operator. Two options:
- A. Sticky bottom-right floating action button on the IT ticket page (always visible).
- B. A slot in the IT ticket page's header strip, next to the "Open ticket" / status editor row.

Either works; the brief picks A as the operator-described "no-scroll" framing — sticky FABs match "convenient + always reachable" better than header slots.

## Scope

### Phase 1 — Schema add

1.1 Operator runs (in Supabase SQL editor):

```sql
ALTER TABLE promo_locations
  ADD COLUMN notified_at timestamptz NULL,
  ADD COLUMN notified_by uuid NULL REFERENCES auth.users(id);

COMMENT ON COLUMN promo_locations.notified_at IS
  'When the per-site "IT changes are live" email was sent. NULL = never notified. Brief 164.';
COMMENT ON COLUMN promo_locations.notified_by IS
  'IT user who fired the per-site notification. NULL = never notified. Brief 164.';

CREATE INDEX idx_promo_locations_complete_unnotified
  ON promo_locations (promo_id)
  WHERE is_complete = true AND notified_at IS NULL;
```

  - The partial index makes the "find eligible sites for this promo" query a one-row scan.
  - `notified_at` / `notified_by` are NULLABLE — every existing row starts un-notified, consistent with prior behavior.

### Phase 2 — New worker endpoint

2.1 `POST /promo/api/promos/{id}/notify-completed-sites` (super_admin | it only):
  - Auth: `gatePromoRole(session.promoRole, ['super_admin', 'it'])`.
  - CSRF: `isOriginAllowed(req)`.
  - Path validation: `{id}` matches `UUID_RE`.
  - Body shape: `{ note?: string }` — optional free-text note (≤ 500 chars trimmed) that prepends to each per-site email body. Empty/missing is the common case.
  - Flow:
    1. Read `promotions` row by id — 404 `promo_not_found` if missing. Capture `title` for the email.
    2. Query `promo_locations` where `promo_id = {id} AND is_complete = true AND notified_at IS NULL`. Empty result → 200 `{ok, notifiedCount: 0, sites: [], skippedCount: 0, message: "No new sites to notify"}`. Operator UI surfaces this verbatim.
    3. For each location code: resolve contacts via `getLocationContactInfo(locationCode)`. Dedup case-insensitive across sites within this fire (e.g., one RM email covering multiple locations gets one email per location — NOT deduplicated globally — because each email is per-site).
    4. Render the email per-site (see Phase 3).
    5. Enqueue one `outbound_emails` row per recipient per site:
       - `source_worker: 'promo-worker'`
       - `source_kind: 'promo-site-notify'`
       - `source_id: \`\${promoId}:\${locationCode}\``
       - `recipient` (per-recipient)
       - `subject`: `"IT changes are live at {site}: {promo title}"`
       - `body_html` + `body_text` from the renderer
       - `attachments: []`
    6. After ALL enqueues for a given location succeed, PATCH the `promo_locations` row: `notified_at = now()`, `notified_by = session.userId`. If ANY enqueue for a location failed, do NOT mark the location notified — operator can retry.
    7. Activity log: emit one `site_notified` entry per location (new activity_type — needs allow-list extension in `_activity.ts` allowlist), with `details: {locationCode, recipientCount, note?}`.
  - Returns:
    ```json
    {
      "ok": true,
      "notifiedCount": 3,
      "sites": [
        {"locationCode": "oswego", "recipientCount": 2, "notifiedAt": "2026-..."},
        {"locationCode": "binghamton", "recipientCount": 3, "notifiedAt": "2026-..."}
      ],
      "skippedCount": 0,
      "failedLocations": []
    }
    ```
    `failedLocations[]` carries any location codes where enqueue failed — operator sees them in the success banner ("Notified 3, failed 1: review and retry").

2.2 Dedup posture: `(promo-worker, promo-site-notify, "{promoId}:{locationCode}", recipient)` is the unique tuple. Re-firing the button after the row's `notified_at` is set is suppressed at TWO layers — (a) the eligible-sites query filters them out, (b) the queue unique index suppresses duplicates if step (a) gets bypassed somehow. Belt and suspenders.

2.3 If the operator manually clears a row's `notified_at` via SQL (e.g., "the site had to be redone, re-notify them"), the next button press picks the row up again — the dedup index ALSO suppresses the re-fire because `source_id` is identical. To force a fresh notification after a re-do, operator clears `notified_at` AND DELETEs the matching queue row. Document this in Phase 6.3 — it's an operator-facing edge case but unlikely at v1.

### Phase 3 — Renderer

3.1 New module `apps/promo-worker/src/announce/render-site-notify.ts`:

```ts
import { wrapInEmailShell, escapeHtml } from "@splash/email-shell";

export interface RenderSiteNotifyInput {
  promoTitle: string;
  promoType: string;
  locationCode: string;
  locationPretty: string;     // human-readable from pricing_simple, falls back to code
  notifiedByEmail: string;    // for the signature line
  note: string | null;        // operator-supplied optional note
  liveViewUrl: string;        // https://splashcarwashes.info/admin/promotions/{id}
}

export interface RenderSiteNotifyOutput {
  html: string;
  plainText: string;
}

export function renderSiteNotify(input: RenderSiteNotifyInput): RenderSiteNotifyOutput;
```

3.2 HTML body content:
  - `<h2>` "IT changes are live"
  - Paragraph: "The IT setup for **{promoTitle}** is now live at **{locationPretty}**."
  - Operator note section (only when `note` is non-empty): a styled callout block with the operator's verbatim text.
  - Promo metadata mini-grid (Promo type / Location code / Notified by).
  - Optional secondary CTA "View promo details" → `liveViewUrl` (text link, smaller — less prominent than the IT-notify CTA because the field user has no role in this promo's downstream).
  - Closing: "Reach out to your manager if anything looks off at your site."

3.3 Plain-text body mirrors the HTML structure with line breaks, no styling.

3.4 Use `wrapInEmailShell(bodyHtml, { title: 'IT changes are live: {promoTitle}', preheader: '{promoType} at {locationPretty}' })`.

### Phase 4 — Activity log extension

4.1 In `apps/promo-worker/src/handlers/_activity.ts`:
  - Add `'site_notified'` to the `PromoActivityType` enum.
  - Update the Supabase `promo_activity_log` table's CHECK constraint allow-list. Operator runs:
    ```sql
    ALTER TABLE promo_activity_log
      DROP CONSTRAINT IF EXISTS promo_activity_log_activity_type_check;
    ALTER TABLE promo_activity_log
      ADD CONSTRAINT promo_activity_log_activity_type_check
      CHECK (activity_type IN (
        'created', 'ticket_updated', 'roadblocks_updated', 'internal_note_updated',
        'status_changed', 'assignment_changed', 'location_marked_complete',
        'location_marked_incomplete', 'material_added', 'material_removed',
        'ptp_updated', 'announcement_sent', 'site_notified'
      ));
    ```
  - Activity timeline renderer in apps/web (`ActivityTimeline.tsx`) — add a case for `site_notified` rendering as "Notified {locationCode} — {recipientCount} recipient(s)". Icon: bell or envelope, neutral tint.

### Phase 5 — Apps/web — IT ticket page button + LocationProgress indicator

5.1 New apps/web server action `notifyCompletedSitesAction` in `_actions/ticketActions.ts`:
  - Calls `notifyCompletedSites(promoId, {note?})` via the existing worker-fetch helper (Brief 158b pattern).
  - Returns `ActionResult` with `data: {notifiedCount, sites, skippedCount, failedLocations}` for the UI to render.

5.2 New worker-fetch helper `notifyCompletedSites(promoId, body)` in `_lib/worker-fetch.ts` mirroring the existing Brief 158b write helpers.

5.3 New component `apps/web/app/admin/promotions/_components/NotifyCompletedSitesButton.tsx` — sticky bottom-right floating action button:
  - `position: fixed; bottom: 24px; right: 24px; z-index: 50` styling.
  - Pill-shaped, primary navy fill, sudsy-blue hover.
  - Content: bell icon + "Notify completed sites" label.
  - Small hint pill above the button on hover/focus: "Only sites marked complete and not yet notified will receive an email." (Or a static hint below the button — pick one based on layout density.)
  - Click → opens a small confirmation modal:
    - Lists the eligible sites (count + first 5 codes + "and N more" tail).
    - Optional textarea for the per-fire note (≤ 500 chars).
    - Submit fires `notifyCompletedSitesAction`.
    - SubmitButton pending state: "Notifying…".
  - Disabled-with-hover-hint state when zero eligible sites exist (server-side count surfaced via the ticket page's SSR fetch — see 5.4).
  - On success: success banner shows "Notified N site(s)." OR "No new sites to notify." with the per-site breakdown.
  - On partial failure: amber sub-banner lists the failed location codes.

5.4 IT ticket page (`apps/web/app/admin/promotions/[id]/ticket/page.tsx`):
  - Server-side fetch the eligible-sites count (sites where `is_complete = true AND notified_at IS NULL`). Wire into the `<NotifyCompletedSitesButton>` so it can render the disabled state pre-click.
  - Place the FAB outside the card grid (at the bottom of the page render) so it floats independently of scroll.

5.5 `LocationProgressToggleable.tsx`:
  - Per-row indicator AFTER the checkbox: small icon showing notification state.
    - Complete + not notified: amber clock icon, hover hint "Marked complete; site not yet notified".
    - Complete + notified: green check icon, hover hint "Notified {timeAgo}".
    - Not complete: no indicator (no notification possible yet).
  - The indicator data comes from the promo's `locations[]` SSR fetch — add `notifiedAt` to the API response shape.

5.6 API response shape — `PromoLocation` type widening (in `_lib/types.ts`):
  - Add `notifiedAt: string | null`.
  - Add `notifiedBy: string | null` (for future who-notified-who UI; not rendered at v1).
  - Worker's detail endpoint (`GET /promo/api/promos/{id}`) returns these fields on every `promo_locations` row.

### Phase 6 — Validation + edge cases

6.1 `pnpm typecheck` — must pass.
6.2 `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — bundle still emits.
6.3 `pnpm --filter @splash/web build` — bundle still emits.
6.4 Operator manual verification post-deploy:
  - Mark two sites complete via the LocationProgressToggleable.
  - Click "Notify completed sites" FAB → confirmation modal shows the two sites.
  - Optionally add a note.
  - Submit → success banner shows "Notified 2 site(s)". Within 5 minutes, the configured contacts on those sites receive the email.
  - Re-click the FAB → success banner now shows "No new sites to notify" (eligible-sites query empty).
  - Mark a third site complete → re-click the FAB → success banner shows "Notified 1 site". The previous two remain dedup-suppressed.
  - Edge case: clear `notified_at` on one row via SQL → re-click FAB → the row is eligible again, but the queue's unique index suppresses re-enqueue. Operator must DELETE the matching `outbound_emails` row to force a re-send. Document in CLAUDE.md.

### Phase 7 — Docs

7.1 BRIEFS/INDEX.md: Brief 164 row appended.

7.2 BUILD_STATE.md: Findings entry noting:
  - New per-location notification path on the IT ticket page
  - Schema additions: `promo_locations.notified_at` + `notified_by` + partial index
  - New activity_type `site_notified` (CHECK constraint allow-list extended)
  - New worker endpoint `POST /promo/api/promos/{id}/notify-completed-sites` (super_admin | it only)
  - New renderer `render-site-notify.ts` reusing `@splash/email-shell`
  - Apps/web sticky FAB + confirmation modal + per-location notification indicator
  - Dedup tuple suppresses re-fires; operator workaround for forced re-notify documented

7.3 CLAUDE.md updates:
  - "Promotions feature" glossary entry (Brief 164 paragraph): describe the per-site notification path, eligibility rule (`is_complete = true AND notified_at IS NULL`), recipient resolution (`getLocationContactInfo`), dedup tuple, and the operator workaround for re-notification.
  - "outbound_emails table" glossary entry: add `promo-worker / promo-site-notify / {promoId}:{locationCode}` to the writers list.

## Out of scope

- Operator-editable email body template for the per-site notification. Hard-coded at v1.
- Bulk-mark-notified without sending (operator wants to "mark these as already notified outside the tool"). v2 candidate — would be a sibling endpoint.
- Per-site opt-out / opt-in flags. v2.
- CC'ing IT on every per-site notification. v2 — could derive from the operator's choice in the confirmation modal.
- Auto-notify on toggle-complete (without explicit button press). Operator explicitly wants the manual button for confirmation + the optional note field, so auto-notify is rejected at v1.
- Notification of sites that get UN-marked complete (rollback). v2 candidate.
- "Notify SPECIFIC site only" (not the bulk eligible set). v2 candidate — the FAB notifies all eligible at once.
- Schema migration framework — operator runs the SQL manually.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `promo_locations` schema additions documented; operator runs the SQL (Phase 1.1)
- `promo_activity_log` CHECK constraint extended for `site_notified` (Phase 4.1)
- New endpoint `POST /promo/api/promos/{id}/notify-completed-sites` returns the documented shape, gates super_admin|it, dedup-suppresses re-fires, stamps `notified_at` + `notified_by` per location
- New renderer `render-site-notify.ts` produces branded HTML body matching the shell
- New activity_type `site_notified` allowed in `_activity.ts` enum + apps/web `ActivityTimeline.tsx`
- Apps/web sticky FAB + confirmation modal + LocationProgressToggleable indicator
- `PromoLocation` API response shape widened with `notifiedAt` + `notifiedBy`
- pnpm typecheck passes
- promo-worker dry-run deploy succeeds
- apps/web build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (expected 600-800 LOC: schema + endpoint + renderer + worker-fetch helper + 3-4 apps/web components)
- Confirmation that:
  - Eligible-sites query correctly filters by `is_complete = true AND notified_at IS NULL`
  - Dedup tuple suppresses double-fires for the same (promo, site) pair
  - Partial-failure recovery: failed locations remain un-notified, surface in `failedLocations[]`, retry on next click
  - The FAB renders in a no-scroll bottom-right position
  - LocationProgressToggleable indicator distinguishes pending vs. notified visually
- Validation results
- Any decisions made on the operator's behalf

## Outcome

**Status:** Completed (2026-06-06).

**Files created (3):**

- `apps/promo-worker/src/announce/render-site-notify.ts` — `renderSiteNotify(input): {html, plainText}`; Splash-branded HTML via `@splash/email-shell wrapInEmailShell` with `<h2>` "IT changes are live" header + opening paragraph + optional amber-tinted operator-note callout + three-row metadata grid (Promo type / Location code monospace / Notified by) + sudsy-blue "View promo details" inline link + closing copy. Subject `"IT changes are live at {locationPretty}: {promoTitle}"`. ~165 LOC.
- `apps/promo-worker/src/handlers/notify-sites.ts` — `handleNotifyCompletedSites(req, env, promoId)`. Auth gate (`super_admin | it`) + CSRF + UUID path validation + body `{ note?: string }` ≤500 chars with unknown-keys rejection. Read promo `title` + `promo_type` (404 if missing); query eligible sites; per-site parallel `pricing_simple` fetch for `location_pretty` + `am_email` + `rm_email` + `site_email`, dedup recipients case-insensitively per-site; render once per site via `renderSiteNotify`; enqueue one `outbound_emails` row per recipient (`source_kind: 'promo-site-notify'`, `source_id: "{promoId}:{locationCode}"`); on all-success per site, PATCH `notified_at` + `notified_by` + emit one `site_notified` activity row. On per-site enqueue failure OR stamp PATCH failure, surface the locationCode in `failedLocations[]`. Empty recipient list per site counted in `skippedCount`. ~330 LOC.
- `apps/web/app/admin/promotions/_components/NotifyCompletedSitesButton.tsx` — sticky bottom-right FAB (`position: fixed`, `bottom: 24px`, `right: 24px`, `z-50`). Pill-shaped, splash-navy fill (hover sudsy-blue), bell icon + label + eligibleCount badge. Disabled-with-hover-hint when `eligibleSites.length === 0`. Click opens centered confirmation modal (`role="dialog"`, ESC + outside-click close, opacity-70 backdrop) showing eligible count + first-5 codes monospace + tail + optional 500-char `<textarea>` (live char counter) + SubmitButton with `pendingText="Notifying…"`. Success → modal closes + transient sub-banner above the FAB (success message + amber partial-failure sub-banner reading `data.failedLocations`). ~225 LOC.

**Files modified (9):**

- `apps/promo-worker/src/handlers/_activity.ts` — `PromoActivityType` union widened with `'site_notified'`; docblock annotated for Brief 164.
- `apps/promo-worker/src/handlers/promos.ts` — `PromoDetailRow.locations[]` + `PromoDetailResponse.locations[]` gained `notified_at` / `notifiedAt` + `notified_by` / `notifiedBy`; PostgREST `select` embed widened to `promo_locations(location_code,is_complete,completed_at,completed_by,notified_at,notified_by)`; mapper passes the new fields through.
- `apps/promo-worker/src/index.ts` — `handleNotifyCompletedSites` imported and dispatched at `POST /promo/api/promos/{id}/notify-completed-sites`, slotted before the existing `/locations/recipients` block.
- `apps/web/app/admin/promotions/_lib/types.ts` — `PromoLocation` interface widened with `notifiedAt: string | null` + `notifiedBy: string | null` (both documented with Brief 164 comments).
- `apps/web/app/admin/promotions/_lib/worker-fetch.ts` — new `notifyCompletedSites(promoId, body)` write helper + `NotifyCompletedSitesResponseData` + `NotifyCompletedSitesBody` interfaces.
- `apps/web/app/admin/promotions/_actions/ticketActions.ts` — new `notifyCompletedSitesAction(_prev, formData)` server action; reads `promoId` + optional `note`, validates ≤500 chars, calls the worker helper, builds an `ActionResult` with `data: {notifiedCount, sites, skippedCount, failedLocations, message?}` for the FAB's banner.
- `apps/web/app/admin/promotions/_components/LocationProgressToggleable.tsx` — per-row notification indicator (amber clock ⏱ for complete-but-un-notified; green envelope ✉ for notified with timestamp tooltip; nothing for not-complete) via new `<NotificationIndicator>` sub-component.
- `apps/web/app/admin/promotions/_components/ActivityTimeline.tsx` — new `case 'site_notified'` headline ("Notified {locationCode} — N recipient(s)") + sudsy-blue dot in `<ActivityDot>`; details bag widened with `note` field.
- `apps/web/app/admin/promotions/[id]/ticket/page.tsx` — `<NotifyCompletedSitesButton>` rendered outside the card grid; eligible-sites list derived server-side from `promo.locations.filter(l => l.isComplete && l.notifiedAt === null)`.

**Schema additions (operator runs manually):**

```sql
ALTER TABLE promo_locations
  ADD COLUMN notified_at timestamptz NULL,
  ADD COLUMN notified_by uuid NULL REFERENCES auth.users(id);
COMMENT ON COLUMN promo_locations.notified_at IS
  'When the per-site "IT changes are live" email was sent. NULL = never notified. Brief 164.';
COMMENT ON COLUMN promo_locations.notified_by IS
  'IT user who fired the per-site notification. NULL = never notified. Brief 164.';
CREATE INDEX idx_promo_locations_complete_unnotified
  ON promo_locations (promo_id)
  WHERE is_complete = true AND notified_at IS NULL;

ALTER TABLE promo_activity_log
  DROP CONSTRAINT IF EXISTS promo_activity_log_activity_type_check;
ALTER TABLE promo_activity_log
  ADD CONSTRAINT promo_activity_log_activity_type_check
  CHECK (activity_type IN (
    'created', 'ticket_updated', 'roadblocks_updated', 'internal_note_updated',
    'status_changed', 'assignment_changed', 'location_marked_complete',
    'location_marked_incomplete', 'material_added', 'material_removed',
    'ptp_updated', 'announcement_sent', 'site_notified'
  ));
```

**Decisions made on the operator's behalf:**

1. **Sticky bottom-right FAB (option A)** vs. header-strip slot. Matches the operator's "convenient + no-scroll" framing better; the FAB is always visible across scroll.
2. **Per-site recipient dedup; no global dedup.** One RM covering 3 eligible sites gets 3 emails (correct — each email is per-site with site-specific subject and metadata), NOT 1 email summarizing all 3 sites.
3. **No-recipient sites counted in `skippedCount`**, stay un-notified. Future operator action: assign a contact email to the location row + re-click the FAB.
4. **Stamp-failure surfaces as a failure.** If `notified_at` PATCH fails after enqueues land, the location appears in `failedLocations[]` so the operator notices. The dedup index protects against duplicate sends on the next button press.
5. **Optional operator note prepends to email body** as an amber-tinted callout block. Operator-typed line breaks preserved via `<br />` after HTML escaping; max 500 chars enforced both client-side (textarea counter) and server-side.
6. **No new PA flow needed** — drain handles `source_kind: 'promo-site-notify'` automatically via Brief 127's source-agnostic pattern; the PA expression that picks `body_html` over `body_text` already covers this row shape too.
7. **Reused `resolveAppsWebBase` pattern from `_notify.ts`** — workers.dev hostnames rewrite to `env.APPS_WEB_BASE_URL`, staging passes through, so the "View promo details" link always points at a real apps/web URL.
8. **Inline `pricing_simple` fetch per site** rather than reusing `getLocationContactInfo`. Needed `location_pretty` too for the email subject + body; single combined query is one round-trip per site, run in parallel across sites.
9. **Notification indicator on `LocationProgressToggleable` only.** Read-only `LocationProgress` (live-view page) does NOT get the indicator at v1 — the notification action lives only on the IT ticket page; surfacing the state on the live view is a v2 enhancement.
10. **No `notify-completed-sites` on the bare live view page.** Feature is scoped to the IT ticket page exclusively per the brief's "convenient + no-scroll" framing.

**Latent issues found:** None.

**Validation results:**

- `pnpm typecheck` → 21/21 green (5.25s; promo-worker + apps/web rebuilt, rest cached).
- `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run --outdir=.tmp-build` → 916.11 KiB raw / 175.71 KiB gzip (+15.27 KiB raw / +2.97 KiB gzip vs Brief 163's 900.84 / 172.74). Bindings surface cleanly: `env.PROMO_FILES`, `env.SUPABASE_URL`, `env.APPS_WEB_BASE_URL`.
- `pnpm --filter @splash/web build` → succeeded. `/admin/promotions/[id]/ticket` route weighs 5.38 kB route-specific / 113 kB First-Load (+1.71 kB vs Brief 158b's 3.67 kB / 111 kB — comfortably under the 150 kB target).

**Diff size:** ~720 LOC across 9 modified + 3 new files. Within the brief's 600–800 LOC expectation.

**Confirmation against the brief's Report checklist:**

- Eligible-sites query filters by `is_complete = true AND notified_at IS NULL`: ✓ (see `notify-sites.ts:225`).
- Dedup tuple suppresses double-fires: ✓ `(promo-worker, promo-site-notify, "{promoId}:{locationCode}", recipient)` is the unique key; re-firing the FAB after success is a no-op via both the eligible-sites filter AND the `outbound_emails` unique index.
- Partial-failure recovery: ✓ Failed locations remain un-notified, surface in `failedLocations[]`, retry on next click.
- FAB renders in no-scroll bottom-right position: ✓ `position: fixed; bottom: 24px; right: 24px; z-50` (component file `NotifyCompletedSitesButton.tsx`).
- `LocationProgressToggleable` indicator distinguishes pending vs. notified visually: ✓ amber clock ⏱ vs. green envelope ✉.

No deploys to CF; no production-route bindings; no git commits or pushes per CLAUDE.md.
