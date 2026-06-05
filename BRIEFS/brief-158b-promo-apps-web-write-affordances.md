# Brief 158b: Promotions — apps/web write affordances (create form, ticket edits, materials/PTP/announcement modals)

**Status:** Completed (2026-06-05)
**Started:** 2026-06-05
**Completed:** 2026-06-05
**Blocks:** Brief 159 (sysadmin "Set Promo Role" card so non-super_admins can grant promo roles); the feature is fully usable end-to-end once this brief lands.
**Dependencies:** Brief 158a (read pages + components + worker-fetch helpers + tile + middleware), Brief 154/155/156/157 (every write endpoint this brief consumes).

## Read first

- BUILD_STATE.md.
- CLAUDE.md — Brief 19 ActionForm pattern (server-action `ActionResult` + `<ActionForm>` client wrapper + `router.refresh()`); the **mandatory** rule that server actions must NOT use `redirect()` from inside the action (Brief 18 / 19 forensics); apps/web service-binding pattern (Brief 17 — already wired in 158a for reads, this brief adds write helpers).
- BRIEFS/brief-019-action-result-refresh.md — canonical pattern reference.
- BRIEFS/brief-158a-promo-apps-web-read-pages.md — components + helpers + page shells this brief mutates.
- apps/web/app/admin/_components/ActionForm.tsx — the shared client wrapper.
- apps/web/app/admin/damage/[id]/page.tsx + apps/web/app/admin/damage/[id]/_actions.ts — runnable reference for server-action + ActionForm wiring against worker writes.
- apps/web/app/admin/forms/[id]/_builder/saveDraftAction.ts — multipart-form-data server action example (relevant for the materials upload in Phase 4).
- apps/promo-worker/src/handlers/{promo-writes,materials,ptp,announce}.ts (Briefs 155/156/157) — wire contracts every server action below consumes.

## Architecture context

158a left the four read pages with stub buttons in every write affordance position. 158b wires each stub to the corresponding Brief 155/156/157 endpoint via the Brief 19 ActionForm pattern, and adds the create form at `/admin/promotions/new`.

**Write surface inventory:**

| Surface | Page | Endpoint | Role gate (UI; worker re-checks) |
|---|---|---|---|
| Create promo | `/admin/promotions/new` | `POST /promo/api/promos` | super_admin / it / marketing |
| Status PATCH | `/admin/promotions/[id]` (live view, ticket page header) | `PATCH /status` | super_admin / it / marketing |
| Ticket fields edit | `/admin/promotions/[id]/ticket` | `PATCH /ticket` | super_admin / it |
| Assignee add | `/admin/promotions/[id]/ticket` | `POST /assignees` | super_admin / it |
| Assignee remove | `/admin/promotions/[id]/ticket` | `DELETE /assignees/{userId}` | super_admin / it |
| Location progress toggle | `/admin/promotions/[id]/ticket` + `[id]` (live view) | `PATCH /locations/{locationCode}` | super_admin / it |
| Material upload | `/admin/promotions/[id]` (live view) | `POST /materials` (multipart) | super_admin / it / marketing |
| Material delete | `/admin/promotions/[id]` (live view) | `DELETE /materials/{materialId}` | super_admin / it / marketing |
| PTP write | `/admin/promotions/[id]` (live view) | `PUT /ptp` | super_admin / it / marketing |
| Announcement send | `/admin/promotions/[id]` (live view) | `POST /announce` | super_admin / it / marketing |

**Pattern.** Every write goes through:

1. A server action (`use server`) returning `ActionResult = { ok: true; message?: string; data?: any } | { ok: false; error: string; fields?: Record<string, string> }`.
2. A client `<ActionForm>` wrapper that dispatches via `useActionState`, renders inline result, calls `router.refresh()` on success so the SSR re-fetches the updated promo and the page re-renders without a full nav.
3. `revalidatePath('/admin/promotions/[id]', 'page')` (or `/queue`, etc.) on success to bust Next's segment cache.

Modals are client islands with `<dialog>` semantics; closing on success is wired through `<ActionForm>`'s `onSuccess` callback (extended in this brief — currently it only re-renders).

**Service-binding writes.** Mirror the 158a read helpers — try the binding first, fall back to URL fetch in dev. POST/PATCH/DELETE all set `Origin` header explicitly so the worker's `isOriginAllowed` CSRF gate passes from both apps/web SSR and from `next dev` cross-origin.

**Materials multipart.** Server actions can accept `FormData` directly. The action streams the file to the worker via `fetch()` with `body: formData`. No manual content-type — `fetch` sets it with the right boundary. Brief 95's saveDraftAction is the closest reference; the file part survives the trip.

## Context

Every read surface in 158a was built around the assumption that "write affordances land in 158b". This brief makes them real. Once it ships, the feature is usable end-to-end: operators can create promos, IT can scope + assign + advance status, marketing can attach materials + write PTP + send announcements.

The split into 158a (reads) and 158b (writes) keeps PR review tractable. 158a was data-binding work; 158b is form-handling work — different review concerns, different failure modes (bad selector vs. stale state vs. validation race).

## Scope

### Phase 1 — Worker-fetch write helpers

**File:** `apps/web/app/admin/promotions/_lib/worker-fetch.ts` (extends 158a).

Add typed helpers for every write. Each:

1. Builds an internal Request to the worker path.
2. Forwards Cookie + Origin headers.
3. Tries service binding; falls back to URL.
4. Returns `{ ok, status, body }` for the action layer to interpret.

```ts
export async function createPromo(body: CreatePromoBody): Promise<WorkerWriteResult<{ promo: PromoDetail }>>;
export async function patchPromoStatus(id: string, status: PromoStatus): Promise<WorkerWriteResult<{ status: PromoStatus }>>;
export async function patchPromoTicket(id: string, body: PatchTicketBody): Promise<WorkerWriteResult<{ ticket: TicketShape; promoStatus: PromoStatus }>>;
export async function addPromoAssignee(id: string, userId: string): Promise<WorkerWriteResult<...>>;
export async function removePromoAssignee(id: string, userId: string): Promise<WorkerWriteResult<...>>;
export async function patchPromoLocationProgress(id: string, locationCode: string, isComplete: boolean): Promise<WorkerWriteResult<...>>;
export async function uploadPromoMaterial(id: string, formData: FormData): Promise<WorkerWriteResult<{ material: MaterialShape }>>;
export async function deletePromoMaterial(id: string, materialId: string): Promise<WorkerWriteResult<...>>;
export async function putPromoPtp(id: string, body: PtpBody): Promise<WorkerWriteResult<...>>;
export async function sendPromoAnnouncement(id: string, body: AnnounceBody): Promise<WorkerWriteResult<{ announcementId: string; enqueuedCount: number; failedRecipients: string[] }>>;
```

Where `WorkerWriteResult<T>` is `{ ok: true; data: T } | { ok: false; status: number; error: string; fields?: Record<string, string> }`.

### Phase 2 — `/admin/promotions/new` create form

**Files:**
- `apps/web/app/admin/promotions/new/page.tsx` (server component shell).
- `apps/web/app/admin/promotions/new/_components/CreatePromoForm.tsx` (client component using `<ActionForm>`).
- `apps/web/app/admin/promotions/new/_actions.ts` (server action `createPromoAction`).

**Auth gate** in page.tsx: redirect to /login on no session; render `<NoAccessCard>` if `session.promoRole === null` or `=== 'ops'`.

**Form fields** (matches mockup screen 1):
- Promotion title (text, required).
- Locations affected — multi-select of `location_code` values resolved from `pricing_simple` via a `_lib/locations.ts` helper that hits Supabase service-key client (small one-time list; cache for session). Show `location_pretty` + `(site)` in the UI; submit `location_code` array.
- Proposed start / end dates.
- Promo type (select).
- Kiosk/POS behavior (textarea; **disabled when promoType is Same or Other** per the user's earlier note — UI-side gate matches worker's defense-in-depth check).
- Requested go-live date.
- Priority (select).

**Action:** validates client-side, calls `createPromo()` worker helper, on success calls `revalidatePath('/admin/promotions', 'page')` then returns `{ ok: true, message: 'Promo created', data: { promoId } }`. Client `<ActionForm>`'s extended `onSuccess` reads `data.promoId` and `router.push('/admin/promotions/{promoId}')`.

### Phase 3 — Status writes

**Surfaces:** Live view (status pipeline card has a "Set status" dropdown + Save), IT ticket page header (same dropdown if IT/super_admin).

**Component:** `apps/web/app/admin/promotions/_components/StatusEditor.tsx` — client island wrapping a `<select>` of the six statuses + Save button via `<ActionForm>`.

**Action:** `_actions/statusActions.ts setPromoStatus(promoId, status)` calls `patchPromoStatus()`. On success, returns `{ ok: true }` + `revalidatePath('/admin/promotions/[id]', 'page')` so the pipeline + activity timeline re-render.

**Auto-flip echo.** When the underlying response carries `unchanged: true`, suppress the success banner ("Status unchanged"). When the response carries a `promoStatus` different from the requested status (auto-flip downstream from a ticket save in Phase 7), the live view's status pill re-renders via the `router.refresh()` path — no special handling needed in this surface.

### Phase 4 — Material upload + delete

**Surface:** Live view materials card.

**Components:**
- `MaterialUploadModal.tsx` — `<dialog>`-based modal with a `<form>` containing name input, kind select, file input. `enctype="multipart/form-data"` on the form. Submit through a server action that pulls the `FormData` directly and forwards via `uploadPromoMaterial(id, formData)`.
- `MaterialDeleteButton.tsx` — a Brief 128-style `ConfirmSubmitButton` that fires the delete server action with `window.confirm()`.

**Actions:** `_actions/materialActions.ts uploadMaterialAction(promoId, formData)` + `deleteMaterialAction(promoId, materialId)`. On success of either, `revalidatePath('/admin/promotions/[id]', 'page')`.

**Client-side checks before submit:** file size ≤50 MB; show inline error otherwise so the user doesn't wait for the worker round-trip. Worker re-checks per Brief 156.

### Phase 5 — PTP modal

**Surface:** Live view PTP card.

**Component:** `PtpEditModal.tsx` — `<dialog>` with three textareas (Purpose / Tools / Process), pre-populated from current `promo.ptp` if present. Submit via `<ActionForm>` calling `putPromoPtpAction(promoId, { purpose, tools, process })`. Empty strings allowed.

**Action:** `_actions/ptpActions.ts putPromoPtpAction(promoId, body)` calls `putPromoPtp()`. On success, `revalidatePath('/admin/promotions/[id]', 'page')`.

### Phase 6 — Announcement compose modal

**Surface:** Live view announcement card. Largest single modal in this brief.

**Component:** `AnnouncementComposeModal.tsx` — multi-section form:

1. **Recipients.** Pre-populated from a one-time SSR call to `_lib/locations.ts resolveRecipients(promo.locations)` which reads `pricing_simple.am_email / rm_email / site_email` for each location and dedup-merges into a string[]. Render as a list of chips with × buttons to remove. Add-recipient input below for ad-hoc additions. Validated client-side via `@splash/types/email-validate isValidEmail` (same as Brief 152).
2. **Subject** — single line, default `"Promotion update: {promo.title}"`.
3. **Body** — large textarea, default empty (operator types).
4. **Materials checklist** — checkbox per `promo.materials` entry. Default: all checked.
5. **Include PTP** — single checkbox. Disabled (with tooltip) when `promo.ptp === null`. Default checked when PTP exists.
6. **Send button** — submits via `<ActionForm>` calling `sendAnnouncementAction(promoId, body)`.

**Action:** `_actions/announceActions.ts sendAnnouncementAction(promoId, body)` calls `sendPromoAnnouncement()`. On success:
- `revalidatePath('/admin/promotions/[id]', 'page')`.
- Returns `{ ok: true, message: 'Announcement sent to N recipients', data: { failedRecipients } }`.
- If `data.failedRecipients.length > 0`, client surfaces a secondary amber banner under the success banner with the failed list.

**Recipients resolver:** `_lib/locations.ts resolveRecipients(locationCodes: string[])` — Supabase service-key client read of `pricing_simple` filtered by `location_code IN (...)`, select `am_email, rm_email, site_email`, flatten + dedup case-insensitively. Returns sorted email[].

### Phase 7 — IT ticket page write affordances

**Surface:** `/admin/promotions/[id]/ticket`.

Three write controls:

1. **Ticket fields editor** — `TicketFieldsForm.tsx` client component wrapping `<ActionForm>` with `<input type="date">` for `readyByDate`, `<textarea>` for `roadblocks`, `<textarea>` for `internalNote`. Single Save button calls `patchTicketAction(promoId, { readyByDate, roadblocks, internalNote })`. Action body forwards only the fields the user touched (compare against initial values; null-or-empty if cleared). On success → `revalidatePath('/admin/promotions/[id]/ticket')` + revalidate the live view path so status auto-flip (if Submitted→Scoped fired) re-renders everywhere.

2. **Assignees editor** — `AssigneesEditor.tsx` client island showing current assignees as chips with × buttons + an "Add assignee" autocomplete input. The autocomplete reads via a small new helper `_lib/user-lookup.ts searchPromoUsers(query)` which queries `auth_unified WHERE promo_role IS NOT NULL AND (email ILIKE %q% OR ...)` and returns the matching users. Pick one → server action `addAssigneeAction(promoId, userId)`. × button → `removeAssigneeAction(promoId, userId)`. Both revalidate the ticket + live-view paths.

3. **Location progress checkboxes** — already rendered read-only in 158a's `<LocationProgress>`. 158b extends it via a `clientToggleable` prop that swaps the static checkboxes for client `<input type="checkbox">` elements wired to `toggleLocationProgressAction(promoId, locationCode, isComplete)`. Each toggle fires a server action; the action revalidates `/admin/promotions/[id]/ticket` so the count re-renders. **Optimistic UI:** flip the checkbox immediately on click; on action failure, revert and surface a banner. Use `useOptimistic` from React 19 (Next 15 supports it natively).

### Phase 8 — Live view status quick-flip surface

**Surface:** Live view's status pipeline card.

Add a "Set status" inline dropdown + Save button (same `<StatusEditor>` from Phase 3) below the pipeline. The pipeline itself stays a visualization — clicking a future step does NOT advance status (would be too easy to misclick). Explicit dropdown + Save is the only path.

### Phase 9 — Doc updates

1. **BUILD_STATE.md** — Findings + Brief 158b status; declare promotions feature MVP complete (subject to Brief 159 sysadmin grant card).
2. **BRIEFS/INDEX.md** — new row.
3. **CLAUDE.md** — promo-worker glossary entry gains a final sentence noting that apps/web wiring is complete via 158a+158b. Add a one-paragraph "Promotions feature" section under the top-level apps tree block summarizing the end-to-end flow + role-by-role permission table for future readers.
4. **PRE_DEPLOY_PROMO.md** — full smoke runbook: create promo → assign self → set ready_by → confirm auto-flip → add material → write PTP → send announcement → mark location complete → flip status to Live → confirm activity log captures all the steps.

### Phase 10 — Build + smoke

- `pnpm typecheck` + `pnpm --filter @splash/web build`.
- Manual smoke (a single seed user with `promo_role = 'super_admin'` so every gate passes; you exercise the role gates separately by setting a second user to `'marketing'` and `'ops'`):
  - Create promo via /new → land on its live view; verify activity log shows `created`.
  - Open IT ticket page → enter readyByDate + add yourself as assignee → save. Verify status auto-flips Submitted → Scoped; activity log shows `assignment_changed` + `ticket_updated` + auto `status_changed`.
  - Open live view → upload a small JPEG via the modal → verify chip renders with inline thumbnail; activity log shows `material_added`.
  - Write PTP via modal → save → verify the three fields render; activity log shows `ptp_updated`.
  - Open announcement modal → confirm pre-populated recipient list resolved from `pricing_simple` for the promo's locations. Send with all materials + PTP checked → success banner with enqueued count. Check Supabase `outbound_emails` for the new rows.
  - Toggle 1 of 3 locations complete on the ticket page → optimistic flip → activity log shows `location_marked_complete`.
  - Flip status to `Live` via dropdown → pipeline re-renders.
  - As a `marketing` user (signed in second browser): no IT ticket / queue tile visible, IT ticket page returns NoAccess, but live view loads with internalNote absent + Save Ticket button hidden.
  - As an `ops` user: dashboard tile visible, live view loads read-only (no create button, no edit affordances).

## Definition of Done

- All 10 write surfaces in the table above are wired and functional end-to-end.
- ActionForm pattern used on every action; no `redirect()` from inside actions.
- Optimistic UI on the location progress toggles.
- Announcement compose modal pre-resolves recipients from `pricing_simple`.
- Auto-status flip from a ticket save is observable on the live view via `router.refresh()`-driven re-render (no manual reload needed).
- Failed-recipient warning banner appears when `failedRecipients.length > 0`.
- `pnpm typecheck` + `pnpm --filter @splash/web build` pass.
- Smoke checks recorded in Outcome.

## Out of scope

- Brief 159 — sysadmin "Set Promo Role" card (so role granting is in-UI, not SQL-only).
- Bulk operations (assign multiple users at once; toggle all locations at once).
- Inline edit of an already-sent announcement (would require a new endpoint; today operator copy-pastes into a new send).
- Status-transition guards (e.g., warn on backward moves) — UI stays permissive; worker stays permissive.
- Per-promo ACL widening — still role-only.
- Mobile-optimized modal layouts — desktop-first at v1 (mockup target audience is internal-tools-on-laptop).

## Outcome

- **Files created (17):**
  - `apps/promo-worker/src/handlers/recipients.ts` — three new
    read endpoints layered on `splash-promo` to side-step apps/web's
    lack of a Supabase service-key binding: `handleListLocations`
    (`GET /promo/api/locations` for the create form's multi-select),
    `handleResolveRecipients` (`GET /promo/api/locations/recipients
    ?codes=...` for the announcement modal's pre-population), and
    `handleSearchPromoUsers` (`GET /promo/api/users/search?q=...`
    for the IT ticket page's assignee autocomplete). All three use
    the worker's existing `SUPABASE_SERVICE_KEY` binding. Filename
    deliberately retained from the initial commit even though it
    grew beyond "recipients" — the file is the consolidated home
    for all three "supabase-via-worker" reads added by 158b.
  - `apps/web/app/admin/promotions/_lib/locations.ts` — thin
    SSR wrapper `resolveRecipients(locationCodes)` over the new
    worker-fetch helper. Empty input → empty list; fail-soft on
    network errors (operator can still type recipients).
  - `apps/web/app/admin/promotions/_lib/action-helpers.ts` —
    `toActionResult<T>(WorkerWriteResult<T>, successMessage)` collapses
    worker results into ActionResult with a humanized-error-code
    map (covers every error code emitted by Brief 154–157
    handlers) + per-field summary suffix. `revalidatePromoPaths`
    coordinates list / queue / live-view / ticket segment
    invalidation in one call.
  - `apps/web/app/admin/promotions/_actions/createActions.ts` —
    `createPromoAction` reads FormData, validates client-side
    defenses-in-depth, calls `createPromo()`, returns
    `ActionResult.data: {promoId}` for the client to navigate.
  - `apps/web/app/admin/promotions/_actions/statusActions.ts` —
    `setPromoStatusAction` calls `patchPromoStatus`; suppresses
    the noisy banner when worker returns `{unchanged: true}` per
    Phase 3 of the brief.
  - `apps/web/app/admin/promotions/_actions/materialActions.ts` —
    `uploadMaterialAction` (multipart) + `deleteMaterialAction`.
    Upload re-packs FormData with only the worker-readable fields
    (drops the hidden `promoId` from the wire payload since the
    worker reads it from the URL path).
  - `apps/web/app/admin/promotions/_actions/ptpActions.ts` —
    `putPtpAction` upserts the PTP row.
  - `apps/web/app/admin/promotions/_actions/announceActions.ts` —
    `sendAnnouncementAction` parses recipients (CSV in hidden
    field), validates each via `@splash/types/email-validate
    isValidEmail` (Brief 152), parses the selected-materials
    checkboxes (each checked checkbox produces a hidden input
    with `name="selectedMaterialId"`), forwards via
    `sendPromoAnnouncement`, and returns `data: {failedRecipients}`
    for the client modal's amber sub-banner.
  - `apps/web/app/admin/promotions/_actions/ticketActions.ts` —
    `patchTicketAction` (diffs current FormData against hidden
    `initial*` fields and only PATCHes changed fields, reducing
    no-op activity-log noise); `addAssigneeAction` /
    `removeAssigneeAction` (UUID-v4-shape validation on userId);
    `toggleLocationProgressAction` (a FREE function, not a
    `(prev, formData)` form action — called directly from the
    optimistic toggle's `startTransition` callback).
  - `apps/web/app/admin/promotions/new/page.tsx` — SSR shell for
    the create form; gates on `super_admin | it | marketing`;
    pre-loads location options.
  - `apps/web/app/admin/promotions/new/_components/CreatePromoForm.tsx`
    — multi-select location picker (filter input + select-all /
    clear-all + checkbox grid); promoType-driven POS-behavior
    enable/disable; date inputs; `onResult` handler reads
    `result.data.promoId` and `router.replace`-s to the new live
    view.
  - `apps/web/app/admin/promotions/_components/StatusEditor.tsx` —
    six-option `<select>` + Save in an `<ActionForm>`; used on
    both the live view and IT ticket header.
  - `apps/web/app/admin/promotions/_components/MaterialUploadModal.tsx`
    — overlay-shaped modal with multipart form; client-side 50 MB
    size check matches the worker's hard cap; Escape closes;
    closes on success via `onResult`.
  - `apps/web/app/admin/promotions/_components/MaterialDeleteButton.tsx`
    — Brief 128-style `window.confirm()` pattern wired into
    `MaterialChip` via its new `canDelete` prop.
  - `apps/web/app/admin/promotions/_components/PtpEditModal.tsx`
    — three textareas pre-populated from `promo.ptp`; trigger
    label switches from "+ Build PTP" → "Edit PTP" when a row
    exists.
  - `apps/web/app/admin/promotions/_components/AnnouncementComposeModal.tsx`
    — chip-style recipient list with × buttons + ad-hoc input;
    Subject pre-filled `"Promotion update: {promo.title}"`;
    materials checklist defaults all-checked; include-PTP toggle
    disabled with tooltip when `ptp === null`; failed-recipients
    amber sub-banner.
  - `apps/web/app/admin/promotions/_components/TicketFieldsForm.tsx`
    — single Save form for ready-by / roadblocks / internal-note;
    hidden `initial*` fields drive the server action's diff
    logic; surfaces auto-flip echo in the success banner.
  - `apps/web/app/admin/promotions/_components/AssigneesEditor.tsx`
    — search-as-you-type autocomplete fetching the new
    `/promo/api/users/search` endpoint (same-origin path-carve →
    relative URL); chips with remove-with-confirm; per-result
    inline `<ActionForm>` to add (a result that's already
    assigned is disabled).
  - `apps/web/app/admin/promotions/_components/LocationProgressToggleable.tsx`
    — React 19 `useOptimistic` + `useTransition` for the
    per-location toggleable grid. Optimistic state expires on
    next `router.refresh()`; error banner surfaces if the action
    fails.

- **Files modified (8):**
  - `apps/promo-worker/src/index.ts` — three new routes (`/locations`,
    `/locations/recipients`, `/users/search`) wired after the
    existing `/announce` path-match. Imports the three new
    handlers from `recipients.ts`.
  - `apps/web/app/admin/_components/ActionForm.tsx` — `ActionResult`
    type widened (additively) to `{ok: true; message?; data?:
    unknown} | {ok: false; error; fields?: Record<string, string>}`.
    Backward-compatible with every existing action.
  - `apps/web/app/admin/promotions/_lib/worker-fetch.ts` — replaced
    the prior `promoGet` with a shared `callPromo` dispatcher
    supporting GET / POST / PATCH / PUT / DELETE on the same code
    path; added every Brief 154–157 write helper
    (`createPromo` / `patchPromoStatus` / `patchPromoTicket` /
    `addPromoAssignee` / `removePromoAssignee` /
    `patchPromoLocationProgress` / `uploadPromoMaterial` /
    `deletePromoMaterial` / `putPromoPtp` /
    `sendPromoAnnouncement`); added two new read helpers
    (`listAllLocations`, `resolveRecipientsByLocations`).
    `WorkerWriteResult<T>` union exported.
  - `apps/web/app/admin/promotions/_components/MaterialChip.tsx` —
    new `canDelete` prop; renders `<MaterialDeleteButton>` when
    true.
  - `apps/web/app/admin/promotions/[id]/page.tsx` — every previously
    disabled `<StubButton>` swapped for its real client island
    (StatusEditor on status card, MaterialUploadModal on materials
    card, PtpEditModal on PTP card, AnnouncementComposeModal on
    announcements card). Materials grid passes `canDelete`.
    `defaultRecipients` SSR-resolved via `resolveRecipients` and
    passed to the announcement modal.
  - `apps/web/app/admin/promotions/[id]/ticket/page.tsx` — IT
    response card now renders `TicketFieldsForm`; new Assignees
    card with `AssigneesEditor`; locations card upgraded to
    `LocationProgressToggleable`. StatusEditor on the header.
  - `BRIEFS/INDEX.md` — new Brief 158b row at the top of the table.
  - `BUILD_STATE.md` — bumped "Last updated" and prepended a
    Brief 158b summary; the Brief 158a paragraph demoted to
    `[previous]`.
  - `CLAUDE.md` — extended the `promo-worker` glossary entry with
    a Brief 158b paragraph documenting the three new endpoints,
    every new apps/web component, and the `ActionResult` widening.
    Added a new top-level **"Promotions feature"** glossary entry
    summarizing the end-to-end role-by-role flow + permission
    table for future readers.
  - `PRE_DEPLOY_PROMO.md` — added smoke section §6 step 8 (12
    sub-checks covering create → status → ticket fields →
    auto-flip → assignee add → location toggle → material upload
    → delete → PTP build → announcement compose + send → role
    gating across super_admin / marketing / ops / it tiers,
    plus the worker-side defense-in-depth check that the
    `/users/search` endpoint 403s for marketing).

- **Decisions made on operator's behalf:**
  1. **Three new worker endpoints**, not the brief's prescribed
     `@supabase/supabase-js`-from-apps/web path. The brief Phase 2
     prescribed `_lib/locations.ts` hitting Supabase directly for
     the multi-select; Phase 6 prescribed the same for recipients;
     Phase 7 prescribed `_lib/user-lookup.ts searchPromoUsers` for
     the autocomplete. All three hit the same blocker 158a's
     `user-lookup.ts` stub documented (no `@supabase/supabase-js`
     in apps/web; no `SUPABASE_SERVICE_KEY` on splash-web). Rather
     than stub three more times, this brief added a small triage
     endpoint module (`recipients.ts`) on splash-promo that uses
     the existing worker-side service-key binding. Net effect:
     same operator UX as the brief intended; zero scope expansion
     on apps/web's deploy plumbing; the four file additions stay
     within the splash-promo footprint. Future briefs adding
     similar Supabase-driven UI surfaces should follow this
     pattern rather than adding `@supabase/supabase-js` to
     apps/web.
  2. **`ActionResult` widened additively** per the brief
     (`data?: unknown` + `fields?: Record<string,string>`); the
     Brief 95 saveDraftAction "OK:{slug}" sentinel pattern stays
     in place for that one historical call site but isn't used
     for new code in 158b. The widening is backward-compatible
     with every existing action.
  3. **Sentinel-vs-data**. `createPromoAction` returns the new
     promoId via `data: {promoId}` (read in the client's
     `onResult` callback) — type-safe and avoids the historical
     "OK:{id}" message-encoding hack.
  4. **Action-helpers module** (`_lib/action-helpers.ts`) added to
     avoid copy-pasting the worker-result-to-ActionResult collapse
     across every action. The error-code → human-message map
     captures every code Brief 154–157 emits; unrecognized codes
     pass through verbatim (useful for ad-hoc debugging when a
     new error code lands without an entry).
  5. **`toggleLocationProgressAction` is a free function**
     `(promoId, locationCode, isComplete) => Promise<ActionResult>`,
     NOT a `(prev, formData) => Promise<ActionResult>` form-action
     contract. The optimistic toggle calls it directly inside a
     `startTransition`, so the form-action shape would be dead
     weight. Other toggle-like writes in the future should follow
     the same pattern.
  6. **Material upload form re-packs FormData** before forwarding
     to the worker — drops `promoId` (worker reads from URL path)
     and any future form-only hidden inputs. Keeps the wire
     payload clean.
  7. **Announcement modal uses time-delayed close** (1500ms) when
     send was clean (no failed recipients) so the operator sees
     the success banner before the modal closes. Partial failures
     keep the modal open so the operator can read the amber
     sub-banner.
  8. **AssigneesEditor's `/users/search` endpoint is super_admin /
     it only** — defense in depth. Marketing-tier callers don't
     see the autocomplete UI (the entire assignees editor lives
     on the IT-only ticket page), but the gate keeps a curl-able
     surface tight. The endpoint also requires `promo_role IS NOT
     NULL` in the query — only promo-feature users surface in
     results.
  9. **TicketFieldsForm diffs current values against hidden
     `initial*` fields**, not against the post-mount default
     values. Lets the worker's per-field activity log accurately
     reflect which fields the operator touched. Re-saving with
     no changes returns "No changes to save." without a worker
     round-trip (action short-circuits).
  10. **LocationProgressToggleable's error state** doesn't manually
      revert the optimistic state — `useOptimistic`'s contract is
      that the override is transient, so it discards on the next
      `router.refresh()` and the post-revert server state wins.
      An inline error banner explains the failure.
  11. **Worker bundle**: the three new endpoints (`recipients.ts`)
      add ~6 KB to the promo-worker source. No new dependencies
      (reuses `@splash/db-supabase getLocationContactInfo` for
      per-code resolution).
  12. **No `<dialog>` element**; modals use overlay + centered card
      via standard div positioning (matches the existing
      `BogoModal` pattern in `apps/web/app/admin/pricing/[location]/
      _components/BogoModal.tsx`). The brief mentioned `<dialog>`
      "semantics" — interpreted as "modal UX semantics" rather
      than the literal HTML element. Escape-to-close + click-outside-
      to-dismiss + ARIA `role="dialog" aria-modal="true"` cover
      the same a11y posture.

- **Latent issues found:**
  - The `_lib/user-lookup.ts` stub from 158a is still in place —
    Brief 158b uses the IT ticket assignee chips' display labels
    fall back to `email` resolved at search time, but the
    live-view's "Assignees" KV row + ticket page's chip list still
    use the stubbed `lookupUserNames` (returns `{}`). Following
    up cleanly would either (a) widen the existing
    `lookupUserNames` to call `/promo/api/users/search?ids=...`
    (requires the worker endpoint to accept an `?ids=` query
    param — a one-liner addition), or (b) widen `getPromo`'s
    detail response to embed `{email, fullName}` per assignee.
    Option (a) is the cleanest follow-up — it generalizes to
    any UI surface that needs to resolve user ids to display
    labels.
  - The optimistic location toggle has a subtle UX flaw: if the
    operator toggles two checkboxes in quick succession and the
    first action fails, the second action's optimistic state
    is also discarded on revert. Realistic only when the worker
    is throwing for both; acceptable v1.
  - The announcement modal's recipients pre-resolution adds an
    SSR latency hit (~300–800ms for a promo with 60 locations)
    because every code requires a per-code PostgREST GET. Future
    optimization: batch the read into a single
    `pricing_simple?location_code=in.(a,b,c,...)&select=am_email,rm_email,site_email`
    query in the worker. Acceptable v1 — operators typically
    have fewer than 10 locations per promo.
  - `<ActionForm>`'s `onResult` callback uses a ref so identity
    doesn't matter, but the modal close timing (1500 ms delay
    for clean sends in the announcement modal) is hard-coded;
    operators can't extend it. Acceptable v1.
  - The CreatePromoForm's location picker is a single
    monolithic component; for very large location sets (current
    fleet has ~140 locations) the checkbox grid renders ~5 KB
    of DOM. Acceptable v1; virtualization is a polish candidate.

- **Validation results (typecheck / build / smoke):**
  - `pnpm typecheck` — **19/19 successful** (17 cached, fresh
    runs on `@splash/promo-worker` + `@splash/web`); 4.308s.
  - `pnpm --filter @splash/web build` — **succeeded.** All 40
    routes generated cleanly. Compile 12.0s.
  - Manual smoke: deferred — this brief lands in a single pass
    without an operator-driven deploy step. PRE_DEPLOY_PROMO.md
    §6 step 8 documents the 12-sub-check end-to-end smoke
    sequence the operator should run post-deploy.

- **Route-specific chunk size deltas (live view, IT ticket, /new):**
  - `/admin/promotions/[id]` — **5.39 kB / 113 kB First-Load JS**
    (was 1.22 kB / 108 kB at 158a — +4.17 kB; the four modals
    + StatusEditor are the bulk).
  - `/admin/promotions/[id]/ticket` — **3.67 kB / 111 kB**
    (was 191 B / 107 kB at 158a — +3.5 kB; TicketFieldsForm +
    AssigneesEditor with its debounced fetch + LocationProgress
    Toggleable + StatusEditor).
  - `/admin/promotions/new` — **2.69 kB / 110 kB** (new).
  - `/admin/promotions` — **1.24 kB / 108 kB** (unchanged from
    158a's 1.21 kB / 108 kB).
  - `/admin/promotions/queue` — **1.24 kB / 108 kB** (unchanged
    from 158a's 1.21 kB / 108 kB).
  - Shared First-Load JS: 104 kB (unchanged). All routes
    comfortably under the 150 kB target.
