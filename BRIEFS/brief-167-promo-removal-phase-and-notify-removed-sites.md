# Brief 167: Promo removal phase — "Removing" status + IT removal checklist + "Notify removed sites"

**Status:** Completed (2026-06-10)
**Drafted:** 2026-06-10

**Why:** A promo's lifecycle currently ends with a single `Live → Ended`
flip. But teardown is real work that mirrors the build phase: when a
special ends, IT has to *remove* it from the POS one site at a time
(same as the per-site build for `same-as-today` / flash pricing flips),
and the field needs to be told the special is gone. Operator: "We need
a step in the promo IT ticket flow that basically mirrors the creation /
build of the promo by IT (with checkboxes and an option to send a
notification), but for REMOVING the promo — sitting between 'Live' and
'Ended'."

This brief is the symmetric twin of **Brief 164** (the build-phase
"Notify completed sites" flow). Where Brief 164 tracks per-site
*completion* (`is_complete` → notify "IT changes are live"), this brief
tracks per-site *removal* (`is_removed` → notify "the special has been
removed at your site"), and adds a new pipeline status `Removing`
between `Live` and `Ended` so the teardown phase is visible.

**Decisions already made by the operator (do not re-litigate):**

1. **New 7th status `Removing`**, inserted between `Live` and `Ended`.
2. **Per-location removal tracking mirrors build completion** — a
   toggleable per-site checklist on the IT ticket page, exactly like the
   existing "mark complete" grid, backed by new `promo_locations`
   columns.
3. **The removal notification mirrors "Notify completed sites"** — a
   "Notify removed sites" button that emails each removed site's
   contacts (site_email always; RM/RD opt-in checkboxes per the Brief
   166 pattern) that the special has been taken down. Per-site emails
   via the `outbound_emails` queue.
4. **Gate: `super_admin | it` only** — same gate as the build/complete +
   notify-completed-sites flow. Removal is an IT teardown task.

**Dependencies:** Brief 155 (per-location progress toggle endpoint —
this brief adds a parallel removal toggle), Brief 164 (Notify completed
sites — this brief is its symmetric twin; reuse every pattern), Brief
127 (`outbound_emails` queue), Brief 160 (`@splash/email-shell` branded
HTML shell), Brief 158a/b (apps/web IT ticket page + LocationProgress
components), Brief 166 (RM/RD opt-in checkbox pattern on the notify
modal), Brief 101/102 (`getLocationContactInfo` / inline `pricing_simple`
fetch pattern).

## Read first

- BUILD_STATE.md
- CLAUDE.md — "Promotions feature" entry (lifecycle), "outbound_emails
  table" entry (`promo-site-notify` writer + dedup tuple), Brief 155 /
  164 / 166 paragraphs.
- BRIEFS/brief-164-promo-it-notify-completed-sites.md — **the template
  for this brief.** Every file touched here has a Brief 164 analog.
- BRIEFS/brief-155-promo-ticket-status-assignee-progress-writes.md —
  per-location `is_complete` toggle endpoint shape + the
  Submitted→Scoped auto-advance pattern.
- BRIEFS/brief-166-promo-announcement-and-creator-polish-batch.md —
  RM/RD opt-in checkbox pattern on the notify-completed-sites modal
  (reuse for the removal notify modal).
- apps/promo-worker/src/handlers/notify-sites.ts — the
  `handleNotifyCompletedSites` handler (clone → `handleNotifyRemovedSites`).
- apps/promo-worker/src/handlers/promo-writes.ts — `STATUSES` array +
  the per-location toggle handler + status PATCH gate.
- apps/promo-worker/src/handlers/promos.ts — `STATUSES` array + the
  detail-endpoint `promo_locations` embed + mapper.
- apps/promo-worker/src/announce/render-site-notify.ts — clone →
  `render-removal-notify.ts`.
- apps/web/app/admin/promotions/_lib/types.ts — `PromoStatus` union +
  `PROMO_STATUSES` + `PromoLocation` shape.
- apps/web/app/admin/promotions/_components/{PromoStatusPill,
  LocationProgressToggleable, NotifyCompletedSitesButton,
  ActivityTimeline}.tsx — the build-phase components to mirror.
- apps/web/app/admin/promotions/[id]/ticket/page.tsx — the IT ticket
  page (gets the removal checklist + removal FAB).
- supabase/promo-tables.sql — the `promotions.status` CHECK constraint +
  `promo_locations` + `promo_activity_log` CHECK constraint.

## Architecture context

The status pipeline becomes seven states:

```
Submitted → Scoped → Building → Tested → Live → Removing → Ended
```

`Removing` is entered manually (IT flips `Live → Removing` via the
StatusEditor when the campaign ends and teardown begins) and exited
manually (`Removing → Ended` once every site is torn down). No
auto-advance at v1 — same posture as Brief 164's notify flow, which
never auto-flipped status. (Optional auto-advance "all sites removed +
notified → suggest Ended" is explicitly v2, Out of scope.)

`promo_locations` rows already track build state (`is_complete`,
`completed_at`, `completed_by`) and Brief 164's build-notify state
(`notified_at`, `notified_by`). This brief adds a parallel removal
block:

- `is_removed: boolean NOT NULL DEFAULT false` — IT marked the site torn down
- `removed_at` / `removed_by` — when + who
- `removal_notified_at: timestamptz NULL` — when the per-site removal email was sent
- `removal_notified_by: uuid NULL` — which IT user fired it

> **Naming note:** the build-phase notify columns from Brief 164 are the
> bare `notified_at` / `notified_by`. The removal-phase notify columns
> are explicitly prefixed `removal_notified_*` to keep the two phases
> unambiguous on the same row. Do NOT overload `notified_at` for both.

The removal notification body is a single hard-coded branded HTML email
(no template registry): "The special **[promo title]** has been removed
at **[location]**. The promotional pricing is no longer active." plus
basic metadata and an optional operator note line. Recipients per site
come from the same inline `pricing_simple` fetch Brief 164 uses
(`location_pretty` + `am_email` + `rm_email` + `site_email`), with the
Brief 166 RM/RD opt-in: `site_email` always; `rm_email` only when
`includeRm`; `am_email` (= Regional Director, per the CLAUDE.md
label-vs-data mapping) only when `includeRd`.

## Scope

### Phase 1 — Schema adds (operator runs manually in Supabase SQL editor)

1.1 New `Removing` status on the `promotions.status` CHECK constraint:

```sql
ALTER TABLE promotions
  DROP CONSTRAINT IF EXISTS promotions_status_check;
ALTER TABLE promotions
  ADD CONSTRAINT promotions_status_check
  CHECK (status IN ('Submitted','Scoped','Building','Tested','Live','Removing','Ended'));
```

  - Existing rows are unaffected (none are `Removing` yet).
  - Confirm the actual constraint name in `supabase/promo-tables.sql`
    before running; the file uses an inline `CHECK` on the column, so
    the auto-generated name is `promotions_status_check`. Verify with
    `\d promotions` if unsure.

1.2 Removal-tracking columns on `promo_locations`:

```sql
ALTER TABLE promo_locations
  ADD COLUMN is_removed            boolean NOT NULL DEFAULT false,
  ADD COLUMN removed_at            timestamptz NULL,
  ADD COLUMN removed_by            uuid NULL REFERENCES auth.users(id),
  ADD COLUMN removal_notified_at   timestamptz NULL,
  ADD COLUMN removal_notified_by   uuid NULL REFERENCES auth.users(id);

COMMENT ON COLUMN promo_locations.is_removed IS
  'IT marked this site torn down (promo removed from POS). Brief 167.';
COMMENT ON COLUMN promo_locations.removal_notified_at IS
  'When the per-site "special removed" email was sent. NULL = never. Brief 167.';

CREATE INDEX idx_promo_locations_removed_unnotified
  ON promo_locations (promo_id)
  WHERE is_removed = true AND removal_notified_at IS NULL;
```

1.3 New activity types on the `promo_activity_log` CHECK constraint:

```sql
ALTER TABLE promo_activity_log
  DROP CONSTRAINT IF EXISTS promo_activity_log_activity_type_check;
ALTER TABLE promo_activity_log
  ADD CONSTRAINT promo_activity_log_activity_type_check
  CHECK (activity_type IN (
    'created', 'ticket_updated', 'roadblocks_updated', 'internal_note_updated',
    'status_changed', 'assignment_changed', 'location_marked_complete',
    'location_marked_incomplete', 'material_added', 'material_removed',
    'ptp_updated', 'announcement_sent', 'site_notified',
    'location_marked_removed', 'location_marked_unremoved', 'removal_site_notified'
  ));
```

  Also update the canonical `supabase/promo-tables.sql` so the file
  reflects the new status + columns + activity types (the SQL editor run
  is the live change; the file edit keeps the repo honest).

### Phase 2 — Insert `Removing` into every status list (code)

The status enum is duplicated in several places (no shared package
constant — a known wart). Insert `"Removing"` between `"Live"` and
`"Ended"` in ALL of:

2.1 `apps/promo-worker/src/handlers/promo-writes.ts` — `STATUSES` array.
2.2 `apps/promo-worker/src/handlers/promos.ts` — `STATUSES` array.
2.3 `apps/web/app/admin/promotions/_lib/types.ts` — both the
    `PromoStatus` union AND the `PROMO_STATUSES` array.
2.4 `apps/web/app/admin/promotions/_components/PromoStatusPill.tsx` —
    add a `Removing` entry to the `PALETTE` map. Use orange to read as
    "teardown in progress" distinct from Building's amber and Ended's
    muted gray: `Removing: "bg-orange-100 text-orange-800"`. Update the
    docblock color legend.

2.5 Verify (grep) that `PromoStatusPipeline.tsx`, `StatusEditor.tsx`,
    and `PromoFilterBar.tsx` all derive their option lists from
    `PROMO_STATUSES` (they do as of Brief 158a/b) — so they pick up
    `Removing` automatically with no further edits. If any hard-codes
    the six-status list, add `Removing` there too. The status PATCH gate
    in `promo-writes.ts` already allows `super_admin | it | marketing`
    and validates against `STATUSES`, so flipping to/from `Removing`
    works once 2.1 lands — no transition-graph enforcement exists (the
    UI suggests, the endpoint is authoritative), so `Live → Removing →
    Ended` is permitted by construction.

### Phase 3 — Per-location removal toggle endpoint

3.1 Extend the existing per-location toggle rather than adding a new
    route. In `apps/promo-worker/src/handlers/promo-writes.ts`, the
    Brief 155 handler `PATCH /promo/api/promos/{id}/locations/{locationCode}`
    accepts `{ isComplete: boolean }`. Widen its body to ALSO accept
    `{ isRemoved: boolean }` (both optional; at least one required;
    unknown keys → 400 `bad_request`):
    - On `isRemoved = true`: stamp `removed_at = now()`, `removed_by =
      session.userId`, `is_removed = true`. Emit `location_marked_removed`
      activity (`details: {locationCode}`).
    - On `isRemoved = false`: clear `removed_at` + `removed_by` back to
      null, `is_removed = false`. Emit `location_marked_unremoved`.
      **Also clear `removal_notified_at` + `removal_notified_by`** when
      un-removing — un-marking a site means it's no longer torn down, so
      a prior removal notification is stale. (This differs from the
      build-phase, which never had to reconsider notification on
      un-complete because Brief 164 shipped after Brief 155; here we own
      both, so do it right.)
    - Gate: `super_admin | it` (same as the existing complete toggle).
    - Zero affected rows → 404 `location_not_on_promo`.
    - Response: `{ok, locationCode, isRemoved, removedAt}` (mirror the
      existing `{ok, locationCode, isComplete, completedAt}` shape; when
      both fields are sent, return both).

    > If widening the existing handler proves awkward (e.g. the
      `isComplete` path has tightly-coupled validation), a parallel
      `PATCH .../locations/{locationCode}/removal` route accepting
      `{ isRemoved }` is an acceptable fallback — but prefer the single
      widened endpoint for symmetry with how `is_complete` already
      lives there.

### Phase 4 — "Notify removed sites" endpoint (clone of Brief 164)

4.1 New handler `apps/promo-worker/src/handlers/notify-removed-sites.ts`
    (sibling to `notify-sites.ts`) exporting
    `handleNotifyRemovedSites(req, env, promoId, ctx)`. Clone
    `handleNotifyCompletedSites` and change:
    - Endpoint: `POST /promo/api/promos/{id}/notify-removed-sites`
      (super_admin | it; `isOriginAllowed` CSRF; UUID path validation).
    - Body: `{ note?: string (≤500 chars), includeRm?: boolean,
      includeRd?: boolean }` — the Brief 166 RM/RD opt-in (default
      false for both). Unknown keys → 400.
    - Eligible-sites query: `promo_locations WHERE promo_id = {id} AND
      is_removed = true AND removal_notified_at IS NULL`. Empty → 200
      `{ok, notifiedCount: 0, sites: [], skippedCount: 0, message:
      "No new sites to notify"}`.
    - Per site: inline `pricing_simple` fetch for `location_pretty` +
      `am_email` + `rm_email` + `site_email`. Recipients: `site_email`
      always; `rm_email` only when `includeRm`; `am_email` only when
      `includeRd`. Dedup case-insensitive per-site (NOT globally), same
      as Brief 164/166.
    - Render per-site via `renderRemovalNotify` (Phase 5).
    - Enqueue one `outbound_emails` row per recipient per site:
      - `source_worker: 'promo-worker'`
      - `source_kind: 'promo-site-removal-notify'`
      - `source_id: \`\${promoId}:\${locationCode}\``
      - `subject: "The {promo title} special has ended at {location_pretty}"`
      - `body_html` + `body_text` from the renderer; `attachments: []`
    - After ALL enqueues for a location succeed: PATCH the row
      `removal_notified_at = now()`, `removal_notified_by =
      session.userId`; emit one `removal_site_notified` activity
      (`details: {locationCode, recipientCount, note?}`). Any enqueue
      failure → location stays un-notified, surfaces in
      `failedLocations[]`.
    - No-recipient sites → counted in `skippedCount`, stay un-notified.
    - Response shape identical to Brief 164's (`ok`, `notifiedCount`,
      `sites[]`, `skippedCount`, `failedLocations[]`).

4.2 Dedup tuple: `(promo-worker, promo-site-removal-notify,
    "{promoId}:{locationCode}", recipient)`. Two-layer suppression
    (eligible-sites filter + queue unique index), same as Brief 164.
    Operator forced-re-notify workaround (clear `removal_notified_at`
    AND DELETE the queue rows) documented in Phase 8.

4.3 Wire the dispatch in `apps/promo-worker/src/index.ts` next to the
    existing `notify-completed-sites` route. Fire the activity/enqueue
    work `ctx.waitUntil`-style only where Brief 164 does; otherwise
    match its control flow exactly.

### Phase 5 — Removal renderer

5.1 New module `apps/promo-worker/src/announce/render-removal-notify.ts`
    (clone of `render-site-notify.ts`):

```ts
export interface RenderRemovalNotifyInput {
  promoTitle: string;
  promoType: string;
  locationCode: string;
  locationPretty: string;
  notifiedByEmail: string;
  note: string | null;
  liveViewUrl: string;
}
export interface RenderRemovalNotifyOutput { html: string; plainText: string; }
export function renderRemovalNotify(input: RenderRemovalNotifyInput): RenderRemovalNotifyOutput;
```

5.2 HTML body content:
  - `<h2>` "Special ended"
  - Paragraph: "The **{promoTitle}** special has been removed at
    **{locationPretty}**. The promotional pricing is no longer active at
    your site."
  - Optional amber-tinted operator-note callout (only when `note`
    non-empty; line breaks via `<br />` after HTML escaping).
  - Metadata mini-grid (Promo type / Location code monospace / Removed by).
  - Secondary "View promo details" text link → `liveViewUrl`.
  - Closing: "Reach out to your manager if anything still looks active
    at your site."
  - `wrapInEmailShell(bodyHtml, { title: 'Special ended: {promoTitle}',
    preheader: '{promoType} removed at {locationPretty}' })`.

5.3 Plain-text mirror, no styling.

### Phase 6 — Activity-log code + timeline

6.1 `apps/promo-worker/src/handlers/_activity.ts` — add
    `'location_marked_removed'`, `'location_marked_unremoved'`,
    `'removal_site_notified'` to the `PromoActivityType` enum.

6.2 `apps/web/app/admin/promotions/_components/ActivityTimeline.tsx` —
    add cases:
    - `location_marked_removed` → "Marked {locationCode} removed" (orange dot)
    - `location_marked_unremoved` → "Unmarked {locationCode} removed" (neutral dot)
    - `removal_site_notified` → "Notified {locationCode} of removal — N recipient(s)" (orange/sudsy dot)

### Phase 7 — Apps/web: removal checklist + removal FAB

7.1 `PromoLocation` type widening (`_lib/types.ts`): add
    `isRemoved: boolean`, `removedAt: string | null`,
    `removalNotifiedAt: string | null`, `removalNotifiedBy: string | null`.
    Worker detail endpoint (`promos.ts` `GET /promo/api/promos/{id}`):
    widen the `promo_locations` PostgREST embed to include
    `is_removed,removed_at,removed_by,removal_notified_at,removal_notified_by`
    and map them through.

7.2 New component `LocationRemovalToggleable.tsx` (clone of
    `LocationProgressToggleable.tsx`) — a per-location checklist where
    each row toggles `is_removed` via the Phase 3 endpoint, with the
    React 19 `useOptimistic` + `useTransition` pattern the build-phase
    component uses. Per-row indicator: amber clock ⏱ for
    removed-but-un-notified; green envelope ✉ for removal-notified (with
    timestamp tooltip); nothing for not-removed. Reuse the
    `NotificationIndicator` sub-component shape from
    `LocationProgressToggleable`.

7.3 New server action `toggleLocationRemovalAction` (free function, NOT
    a `(prev, formData)` form action — mirror
    `toggleLocationProgressAction`) + worker-fetch helper
    `toggleLocationRemoval(promoId, locationCode, { isRemoved })`.

7.4 New component `NotifyRemovedSitesButton.tsx` (clone of
    `NotifyCompletedSitesButton.tsx`) — sticky bottom-right FAB,
    orange-tinted to distinguish from the (navy) completed-sites FAB.
    Confirmation modal: eligible count + first-5 codes + tail + optional
    500-char note textarea + the **Brief 166 RM/RD opt-in checkboxes**
    ("Also notify (optional): ☐ Regional Manager ☐ Regional Director",
    both unchecked by default; `site_email` always implied). SubmitButton
    `pendingText="Notifying…"`. Success/partial-failure banners identical
    to Brief 164.

7.5 New server action `notifyRemovedSitesAction` + worker-fetch helper
    `notifyRemovedSites(promoId, { note?, includeRm?, includeRd? })`.
    `NotifyRemovedSitesBody` type with the optional booleans (mirror
    Brief 166's `NotifyCompletedSitesBody` widening).

7.6 IT ticket page (`[id]/ticket/page.tsx`):
  - Render the **removal checklist** (`LocationRemovalToggleable`) in a
    new "Removal" card. **Only show this card when the promo's status is
    `Live`, `Removing`, or `Ended`** — there's nothing to tear down
    before the promo is live. (The build "Completion" card stays
    visible per its existing gating.)
  - Render `<NotifyRemovedSitesButton>` outside the card grid (sticky
    FAB), eligible list derived server-side from
    `promo.locations.filter(l => l.isRemoved && l.removalNotifiedAt === null)`.
  - **FAB stacking:** the page may now render two FABs (completed-sites
    + removed-sites). Stack them vertically — removed-sites FAB at
    `bottom: 24px`, completed-sites FAB at `bottom: 88px` (or hide the
    completed-sites FAB once status is `Removing`/`Ended` since the
    build phase is done). Pick the hide-on-removing approach if simpler;
    document the choice. Avoid overlap.

### Phase 8 — Validation + edge cases

8.1 `pnpm typecheck` — must pass (expect the `PromoStatus` union change
    to surface any exhaustive switch that doesn't handle `Removing`; fix
    those — likely none beyond the `PALETTE` map since pills/pipelines
    render from the array).
8.2 `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run
    --outdir=.tmp-build` — bundle emits.
8.3 `pnpm --filter @splash/web build` — bundle emits.
8.4 Operator manual verification post-deploy:
  - Flip a Live promo to `Removing` via the StatusEditor → orange pill
    renders across list/queue/detail/ticket.
  - On the IT ticket page, mark two sites removed via the removal
    checklist → rows show amber clock indicators.
  - Click "Notify removed sites" FAB → modal shows the two sites + RM/RD
    opt-in checkboxes → submit → "Notified 2 site(s)"; within ~5 min the
    site contacts receive the "special ended" email.
  - Re-click → "No new sites to notify" (eligible query empty).
  - Mark a third site removed → re-click → "Notified 1 site".
  - Un-mark a removed site → its `removal_notified_at` clears; re-click
    after re-marking is suppressed by the dedup index unless the queue
    row is also deleted (document).
  - Flip `Removing → Ended`.

### Phase 9 — Docs

9.1 BRIEFS/INDEX.md: append the Brief 167 row.
9.2 BUILD_STATE.md: bump "Last updated"; Findings entry covering the new
    `Removing` status, the `promo_locations` removal columns + index,
    the new activity types, the new endpoint + renderer, and the apps/web
    removal checklist + FAB.
9.3 CLAUDE.md:
  - "Promotions feature" entry: add `Removing` to the lifecycle line;
    add a Brief 167 paragraph describing the removal phase (status flip,
    per-site removal tracking, notify-removed-sites flow, eligibility
    rule `is_removed = true AND removal_notified_at IS NULL`, dedup
    tuple, RM/RD opt-in).
  - "outbound_emails table" entry: add `promo-worker /
    promo-site-removal-notify / {promoId}:{locationCode}` to the writers
    list with the same dedup + workaround notes as `promo-site-notify`.
  - Update the role-by-role permission table if a "Removal" column adds
    clarity (super_admin/it only).

## Out of scope (each a v2 candidate)

- Auto-advance `Removing → Ended` when all sites removed + notified.
  Manual flip only at v1.
- Auto-flip `Live → Removing` on first site-removal toggle. Manual.
- Operator-editable removal email template (hard-coded body at v1).
- "Notify a specific removed site only" (the FAB notifies all eligible).
- Bulk-mark-removed-without-sending. v2 sibling endpoint.
- Removal materials / removal PTP. The removal phase reuses no
  materials.
- Per-site opt-out flags.
- Transition-graph enforcement (preventing `Ended → Live`, etc.). The
  endpoint stays authoritative-without-graph, matching current behavior.
- Schema migration framework — operator runs the SQL manually.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes. Don't commit/push.

## Definition of done

- `promotions.status` CHECK + `promo_locations` removal columns + index +
  `promo_activity_log` CHECK documented; operator runs the SQL (Phase 1).
- `Removing` inserted into every status list (Phase 2); `PromoStatusPill`
  has a `Removing` color; pills/pipeline/filter/StatusEditor render it.
- Per-location removal toggle works (`is_removed` write + activity)
  (Phase 3).
- `POST /promo/api/promos/{id}/notify-removed-sites` returns the
  documented shape, gates super_admin|it, honors RM/RD opt-in,
  dedup-suppresses re-fires, stamps `removal_notified_*` per location
  (Phase 4).
- `render-removal-notify.ts` produces branded HTML matching the shell
  (Phase 5).
- New activity types allowed in `_activity.ts` + rendered in
  `ActivityTimeline.tsx` (Phase 6).
- Apps/web removal checklist + removal FAB + RM/RD opt-in modal +
  `PromoLocation` widening (Phase 7).
- pnpm typecheck passes; promo-worker dry-run deploy + apps/web build
  succeed.
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (expect ~700–900 LOC: schema + status insertion across ~5
  files + toggle widening + notify endpoint + renderer + 4–5 apps/web
  files).
- Confirm: `Removing` renders as an orange pill everywhere; the removal
  checklist toggles `is_removed`; the notify endpoint filters
  `is_removed = true AND removal_notified_at IS NULL`; the dedup tuple
  suppresses double-fires; RM/RD opt-in adds the right recipients;
  un-marking removed clears `removal_notified_at`; the two FABs don't
  overlap.
- Validation results + any decisions made on the operator's behalf.

## Outcome

### Files created (3)

- `apps/promo-worker/src/handlers/notify-removed-sites.ts` — clone of
  `notify-sites.ts` filtering eligible sites by
  `is_removed = true AND removal_notified_at IS NULL`, enqueuing one
  `outbound_emails` row per recipient per site with
  `source_kind: 'promo-site-removal-notify'` and the dedup tuple
  `(promo-worker, promo-site-removal-notify,
  "{promoId}:{locationCode}", recipient)`. Brief 166 RM/RD opt-in
  pattern; default false; site_email always implied. Stamps
  `removal_notified_at` + `removal_notified_by` after all-success per
  site; emits one `removal_site_notified` activity row.
- `apps/promo-worker/src/announce/render-removal-notify.ts` — clone of
  `render-site-notify.ts`. Splash-branded HTML body via
  `@splash/email-shell wrapInEmailShell`: `<h2>` "Special ended" +
  paragraph mentioning promo title + locationPretty + "The promotional
  pricing is no longer active at your site." + optional amber-tinted
  operator-note callout + metadata grid (Promo type / Location code
  monospace / Removed by) + "View promo details" inline link + closing
  "Reach out to your manager if anything still looks active at your
  site." Subject `"The {title} special has ended at {locationPretty}"`.
- `apps/web/app/admin/promotions/_components/LocationRemovalToggleable.tsx` —
  symmetric twin of `LocationProgressToggleable`. React 19
  `useOptimistic` + `useTransition` per-row toggle. Per-row indicator:
  amber clock for removed-but-un-notified, green envelope for
  removal-notified (timestamp tooltip), nothing for not-removed.
- `apps/web/app/admin/promotions/_components/NotifyRemovedSitesButton.tsx` —
  sticky bottom-right FAB, orange-tinted to distinguish from the
  build-phase navy FAB. Confirmation modal with eligible count + first-5
  preview + 500-char note textarea + Brief 166 RM/RD opt-in checkboxes
  + Notifying… submit button. Success → modal closes + transient toast
  with breakdown; partial-failure → amber sub-banner inside the toast.

### Files modified (10)

- `supabase/promo-tables.sql` —
  (a) `promotions.status` CHECK constraint widened to include
  `'Removing'` between `'Live'` and `'Ended'`; (b) `promo_locations`
  gains seven new columns: `notified_at` + `notified_by` (Brief 164;
  the file was already running them as operator-side SQL but they
  weren't reflected here, so the file-state is now aligned) +
  `is_removed boolean NOT NULL DEFAULT false` + `removed_at` +
  `removed_by` + `removal_notified_at` + `removal_notified_by`;
  (c) two partial indexes: `idx_promo_locations_complete_unnotified`
  (Brief 164) and `idx_promo_locations_removed_unnotified` (Brief 167);
  (d) `promo_activity_log` CHECK constraint extended with
  `site_notified` (Brief 164), `location_marked_removed`,
  `location_marked_unremoved`, `removal_site_notified`.
- `apps/promo-worker/src/handlers/promo-writes.ts` — `STATUSES` array
  extended with `"Removing"`; `handlePatchLocationProgress` widened to
  accept `{isComplete?, isRemoved?}` (either or both; at least one
  required; unknown keys → 400). On `isRemoved = true`: stamps
  `removed_at` + `removed_by`. On `isRemoved = false`: clears stamps AND
  clears `removal_notified_at` + `removal_notified_by` (so the FAB
  re-treats the site as eligible on next re-mark). Per-field activity
  rows: `location_marked_removed` / `location_marked_unremoved` (plus
  the existing complete/incomplete pair). Response widened with
  `isRemoved` + `removedAt`.
- `apps/promo-worker/src/handlers/promos.ts` — `STATUSES` array extended;
  `PromoDetailRow` + `PromoDetailResponse` widened with the five
  removal-phase columns; `select` embed widened to
  `promo_locations(...,is_removed,removed_at,removed_by,
  removal_notified_at,removal_notified_by)`; mapper extended.
- `apps/promo-worker/src/index.ts` — new dispatch case
  `POST /promo/api/promos/{id}/notify-removed-sites` →
  `handleNotifyRemovedSites`. Mounted right after the build-phase
  `notify-completed-sites` route.
- `apps/promo-worker/src/handlers/_activity.ts` — `PromoActivityType`
  enum extended with `'location_marked_removed' |
  'location_marked_unremoved' | 'removal_site_notified'`. Docblock
  documents the operator-side CHECK extension SQL.
- `apps/web/app/admin/promotions/_lib/types.ts` — `PromoStatus` union +
  `PROMO_STATUSES` array extended with `"Removing"`; `PromoLocation`
  type widened with five removal-phase fields (`isRemoved`, `removedAt`,
  `removedBy`, `removalNotifiedAt`, `removalNotifiedBy`).
- `apps/web/app/admin/promotions/_components/PromoStatusPill.tsx` —
  `PALETTE` map gains `Removing: "bg-orange-100 text-orange-800"`;
  docblock color legend updated to call out the orange tint as
  "teardown in progress, distinct from Building's amber and Ended's
  gray".
- `apps/web/app/admin/promotions/_components/ActivityTimeline.tsx` —
  three new headline cases (`location_marked_removed` /
  `location_marked_unremoved` / `removal_site_notified`); dot color
  switch case-checks the three orange types FIRST (before the
  generic `location_*` → emerald rule). Docblock activity-type list
  updated.
- `apps/web/app/admin/promotions/_lib/worker-fetch.ts` — added
  `patchPromoLocationRemoval(promoId, locationCode, isRemoved)` calling
  the same PATCH endpoint as the build-phase helper but with
  `{isRemoved}` body; widened `PatchLocationProgressResponseData` with
  optional `isRemoved` + `removedAt` (worker now always returns both).
  Added `notifyRemovedSites(promoId, body)` helper + `NotifyRemovedSitesResponseData` +
  `NotifyRemovedSitesBody` types.
- `apps/web/app/admin/promotions/_actions/ticketActions.ts` — added
  `toggleLocationRemovalAction` (free function — matches the
  `toggleLocationProgressAction` shape used by `useOptimistic`) and
  `notifyRemovedSitesAction` ((prev, formData) shape — used by
  `<ActionForm>` on the modal); both forward to the worker via the new
  worker-fetch helpers.
- `apps/web/app/admin/promotions/[id]/ticket/page.tsx` — derives three
  phase-aware UI flags before render: `showRemovalCard`
  (Live/Removing/Ended), `showBuildFab` (not Removing/Ended),
  `showRemovalFab` (Removing/Ended). Conditional rendering of the
  Removal card (`<LocationRemovalToggleable>`) + the two FABs;
  mutually-exclusive FAB rendering avoids overlap without z-stack
  coordination.

### Decisions made on the operator's behalf

1. **Single widened endpoint vs. parallel route.** The brief offered a
   fallback (`PATCH .../locations/{code}/removal`) if widening proved
   awkward. Widening was clean — the build-phase `isComplete` path's
   stamps are field-local, so the symmetric removal-phase additions
   slot in without touching the build branch. Single endpoint kept.
2. **At-least-one-required body validation.** When both `isComplete`
   and `isRemoved` are absent, the worker returns 400 `bad_request`.
   The pre-167 worker required `isComplete`; this change is technically
   a contract relaxation (any-key-OK instead of `isComplete`-only) plus
   a new contract narrowing (need at least one). Existing build-phase
   callers (`patchPromoLocationProgress` always sends `isComplete`)
   continue to work without change.
3. **Worker response always carries both `isComplete` + `isRemoved`**
   (each side's full pair). Build-phase callers that didn't ask for
   the removal columns get them anyway — harmless extra fields, lets a
   single response shape feed both helpers without per-call shape
   gymnastics.
4. **`isRemoved = false` clears `removal_notified_at`** (and
   `removal_notified_by`) on the worker side, per brief Phase 3. The
   queue dedup index still suppresses a fresh send unless the operator
   also deletes the matching `outbound_emails` row — documented as the
   forced-re-notify edge case in this brief's Phase 8 (mirrors Brief
   164's posture).
5. **FAB hide-on-removing approach** (vs. vertical stacking). Brief
   offered both; the hide approach is simpler and avoids any chance of
   mis-click between the two FABs. Build-phase FAB hides once status is
   `Removing`/`Ended`; removal-phase FAB only shows once status is
   `Removing`/`Ended`. Documented inline at the ticket page render
   site.
6. **Removal card visibility** at `Live | Removing | Ended` (NOT just
   Removing/Ended). Operators frequently want to mark a site torn down
   the same day they flip status, and Brief 155's status PATCH stays
   authoritative-without-graph — so a `Live` promo with a single removed
   site is a valid intermediate state. The build-phase Completion card
   stays visible at every status (its own gating is intentionally
   absent).
7. **Orange tint for `Removing` + the removal FAB.** Brief proposed
   orange explicitly; chose `bg-orange-100 / text-orange-800` for the
   pill (matches Tailwind's standard 100/800 contrast pair used by
   `Building`'s amber and `Ended`'s gray), `bg-orange-600` for the FAB
   (matches Tailwind's primary-button conventions). FAB hover ramps to
   `bg-orange-700`.
8. **Activity dot color tier for removal entries** = orange (matches
   the pill tint). The dot-color switch case-checks the three removal
   activity types FIRST so the generic `location_*` → emerald rule
   (which would otherwise win) is bypassed; the existing build-phase
   `location_marked_complete` / `_incomplete` keep their emerald.
9. **No transition-graph enforcement** at the worker for status flips
   into / out of `Removing`. The brief's "out of scope" called it out
   explicitly; the status PATCH gate stays
   authoritative-without-graph, so a Live → Removing → Ended path is
   permitted by construction. Same posture as every other status edge
   on the worker today.
10. **Operator runs SQL manually.** The Phase 1 SQL (status CHECK
    constraint replacement, column adds, partial index, activity_type
    CHECK extension) is in `supabase/promo-tables.sql` as the canonical
    spec; operator runs it in the Supabase SQL editor per the project's
    schema migration convention. No migration framework lives in this
    repo.

### Latent issues found

None. The only minor surprise was that `supabase/promo-tables.sql`
hadn't been updated when Brief 164 shipped — Brief 164's `notified_at`
+ `notified_by` columns were operator-side SQL only, not reflected in
the file. Brief 167 fixed both gaps in the same edit.

### Validation results

- `pnpm typecheck` — **21/21 successful (7.7s)**.
- `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build` — **succeeded**. Bundle: 939.20 KiB raw / 177.89
  KiB gzip (+18.28 KiB raw / +1.07 KiB gzip vs Brief 166's 920.92 /
  176.82). The new notify-removed-sites handler + render-removal-notify
  module + status enum widening accounts for the bulk.
- `pnpm --filter @splash/web build` — **succeeded**.
  `/admin/promotions/[id]/ticket` route: 5.93 kB / 113 kB First-Load
  (+0.55 kB vs Brief 164's 5.38 kB — comfortably under the 150 kB
  target). `/admin/promotions/[id]` (live view) unchanged at 8.65 kB /
  116 kB.

### Diff size

~870 LOC across 10 modified + 3 new files (close to the brief's
expected ~700–900 LOC range). Schema edit (~30 LOC), status enum
widening across 4 files (~10 LOC), per-location toggle widening (~80
LOC), notify-removed-sites handler (~430 LOC clone), render-removal-
notify (~160 LOC clone), activity types + timeline (~30 LOC), apps/web
types + helpers + actions (~90 LOC), apps/web components
LocationRemovalToggleable + NotifyRemovedSitesButton (~430 LOC), ticket
page (~50 LOC).

### Out-of-scope, per brief

Auto-advance `Removing → Ended` on all-sites-removed + notified;
auto-flip `Live → Removing` on first removal toggle; operator-editable
removal email template; notify-a-specific-site-only;
bulk-mark-removed-without-sending; removal materials / removal PTP;
per-site opt-out flags; transition-graph enforcement; schema migration
framework. Each a v2 candidate.
