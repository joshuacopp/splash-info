# Brief 166: Promo announcement + creator polish batch (7 items)

**Status:** Completed (2026-06-08)
**Started:** 2026-06-08
**Completed:** 2026-06-08
**Blocks:** none — UX/quality polish on the promotions feature (Briefs 153–165). No other brief depends on this.
**Dependencies:** Brief 157 (announce send), Brief 160 (branded HTML + inline materials + preview), Brief 163 (fillable templates), Brief 164 (notify-completed-sites). All landed.

## Read first

- `BUILD_STATE.md`, `CLAUDE.md` ("Promotions feature" + "promo-worker" glossary entries).
- `apps/promo-worker/src/announce/templates.ts` — template registry + `substituteTemplate`.
- `apps/promo-worker/src/handlers/announce.ts` — `parseAndValidateBody`, `handleSendAnnouncement`, `handlePreviewAnnouncement`, `partitionMaterialsForRender`, `buildOutboundEmailAttachmentsForAnnouncement`.
- `apps/promo-worker/src/handlers/notify-sites.ts` — `handleNotifyCompletedSites` recipient resolution (item 7).
- `apps/web/app/admin/promotions/_components/AnnouncementComposeModal.tsx` — items 1, 3, 4, 5, 6.
- `apps/web/app/admin/promotions/_lib/announce-templates.ts` — client mirror of `substituteTemplate`.
- `apps/web/app/admin/promotions/[id]/page.tsx` — renders the compose modal; where the `recentPromos` prop gets fetched.
- `apps/web/app/admin/promotions/_lib/worker-fetch.ts` — the promo-list helper (for item 4's recent-promos fetch) + the notify action helper (item 7).
- `apps/web/app/admin/promotions/_actions/announceActions.ts` — forwards the modal's FormData to the worker (item 3 signature passthrough).
- `apps/web/app/admin/promotions/_components/NotifyCompletedSitesButton.tsx` + its backing server action — item 7.
- `apps/web/app/admin/promotions/new/_components/CreatePromoForm.tsx` — item 2.

## Context

Operator (Josh) requested seven changes after live-testing the announcement + IT-notify flows. All seven are confirmed with the decisions baked into Scope below. **No schema changes anywhere in this batch.** The dynamic-copy mechanism in items 5/6 is the only non-trivial design — it reuses the existing `substituteTemplate` "unknown placeholders survive verbatim" behavior with a second substitution pass for worker-computed values.

## Scope

### Item 1 — "Do not attach" default on materials

`AnnouncementComposeModal.tsx`. Today the open-seed checks every material and the checkbox is the attach toggle. Change the seed so **no materials are checked by default** — the operator actively selects what to attach.

- In the `useEffect` that seeds on open, set `setSelectedMaterials(new Set())` (was `new Set(materials.map(m => m.id))`). Keep the per-material `seedModes` map as-is (mode only matters once a material is checked).
- Update the section heading copy to make the default obvious, e.g. "Attach materials ({N} selected) — nothing is attached unless you select it."
- No worker contract change: unchecked materials simply aren't in `selectedMaterialId` FormData entries.
- **Decision:** implement "do not attach" as the unchecked checkbox (not a third per-material radio). Leave the include-PTP checkbox default unchanged (Brief 157/158b behavior: on when PTP exists) — item 1 is scoped to materials/docs.

### Item 2 — 'Same' → 'Same As Today' in the promo creator

`CreatePromoForm.tsx`. Change the `promoType` dropdown **display label** for the `Same` option to "Same As Today". **Keep the stored value `Same`** (renaming the enum value would cascade into worker validation + existing rows + the item-4 autofill which keys off `Same`). Display-only change.

### Item 3 — Signature field on freeform compose

`AnnouncementComposeModal.tsx` (freeform branch) + `announce.ts` (`parseAndValidateBody`) + `announceActions.ts`.

- Add an optional "Signature" `<input name="signature">` in the freeform branch (below the Body textarea). Template sends already have a `{signature}` field, so this is freeform-only.
- `announceActions.ts`: forward the `signature` form value into the JSON body sent to the worker (send + preview).
- Worker `parseAndValidateBody` freeform branch: accept an optional `signature` string (add `"signature"` to `KNOWN_BODY_KEYS`); when present and non-empty (trim, ≤500 chars), append `"\n\n" + signature` to `bodyText`. Do this in `parseAndValidateBody` so send AND preview both reflect it. Ignore `signature` on the template branch (templates own their `{signature}` field).

### Item 4 — Recent-promo picker + autofill + offerings relabel

`templates.ts` (worker) + `AnnouncementComposeModal.tsx` + `[id]/page.tsx`.

- **Relabel** the `new_special_heads_up` template field currently labeled "Kiosk/POS behavior or details" → **"Promo offerings for customers"**. Keep the key `kioskBehavior` (the body template's `{kioskBehavior}` placeholder is unchanged). Label-only change in `templates.ts`.
- **Recent-promo picker:** on `[id]/page.tsx`, fetch the **10 most recently created promos** server-side via the existing promo-list helper in `worker-fetch.ts` (`GET /promo/api/promos?limit=10`, already ordered `created_at desc`), and pass them to the modal as a `recentPromos` prop: `{ id, title, promoType, proposedStartDate, proposedEndDate, createdAt }[]`.
- In the modal, **when a template is selected**, render a "Pull details from a promo" `<select>` above the template fields listing each recent promo as `"{title} — {createdAt formatted}"`. Selecting one autofills the template field state (still fully editable):
  - `specialName` ← promo `title`
  - `startDate` ← promo `proposedStartDate` (where the template has a `startDate` field)
  - `endDate` ← promo `proposedEndDate` (where present)
  - `kioskBehavior` ("Promo offerings for customers") ← preset by `promoType`:
    - `Same` → `"the opportunity to try out their first month as a MaxPass member for the cost of a single wash!"`
    - `BOGO` → `"the opportunity to purchase two months of MaxPass membership for the price of one!"`
    - any other type → leave blank (operator fills in).
  - Only set fields that exist on the currently-selected template (heads-up has all four; follow-up has only `specialName`; end-of-promo has `specialName` + `endDate`). The picker should be available on all templates, autofilling whatever overlaps.
- Autofill writes into the existing `templateFieldValues` state (keyed `${templateId}.${fieldKey}`), so the hidden `templateField[{key}]` FormData mirrors + live preview update automatically.

### Item 5 & 6 — Dynamic body copy based on what's actually attached

`templates.ts` (worker) + `announce-templates.ts` (client mirror) + `announce.ts` (send + preview) + `AnnouncementComposeModal.tsx` (live preview).

The heads-up and follow-up templates currently hard-code copy that assumes a future/fixed attachment state. Make that copy reflect the **actual** send-time state (materials attached? PTP included?).

- **Shared helper** `computeMaterialsPtpCopy({ hasMaterials, includePtp }): { materialsPtpNote: string; materialsPtpBody: string }` — define it exported in `templates.ts` (worker) AND mirror it in `announce-templates.ts` (client), exactly like the existing dual `substituteTemplate`. Wording:
  - `materialsPtpNote` (heads-up trailing line):
    - neither → `"There will be an announcement with more details, materials, and the PTP coming your way shortly!"`
    - materials only → `"Please see the attached materials."`
    - PTP only → `"The PTP is included below."`
    - both → `"Please see the attached materials, and the PTP included below."`
  - `materialsPtpBody` (follow-up body sentence):
    - both → `"Attached you'll find the marketing materials and the Purpose/Tools/Process document for this special."`
    - materials only → `"Attached you'll find the marketing materials for this special."`
    - PTP only → `"Below you'll find the Purpose/Tools/Process document for this special."`
    - neither → `"Materials and the PTP will follow shortly."`
- **Template edits** in `templates.ts`:
  - `new_special_heads_up`: replace the static `"There will be an announcement... shortly!"` line with the placeholder `{materialsPtpNote}`.
  - `materials_ptp_followup`: replace the static `"Attached you'll find the marketing materials and the Purpose/Tools/Process document for this special."` sentence with `{materialsPtpBody}`.
  - These placeholders are NOT operator fields (not added to `fields[]`), so `substituteTemplate`'s first pass leaves them verbatim (unknown-placeholder behavior).
- **Worker second-pass substitution:** in `handleSendAnnouncement` AND `handlePreviewAnnouncement`, after the operator-field substitution and after `resolvedMaterials` + `payload.includePtp` are known, compute the copy via `computeMaterialsPtpCopy({ hasMaterials: resolvedMaterials.length > 0, includePtp: payload.includePtp })` and run a second `substituteTemplate(body, { materialsPtpNote, materialsPtpBody })` pass on the (template) body before `renderAnnouncement`. Only do this for template sends (`templateId` set); freeform bodies have no placeholders so it's a no-op but guard anyway. The worker is authoritative.
- **Snapshot:** store the post-computed-substitution body in `promo_announcements.body_text` (still WITHOUT the appended PTP block, per Brief 157's snapshot-vs-delivered split). This makes the stored history reflect the actual-state copy.
- **Client live preview:** the modal's inline `<pre>` mirror should fold the computed copy into the `currentTemplateFieldValues` it passes to the client `substituteTemplate` (compute from `selectedMaterials.size > 0` + `includePtp`). The authoritative iframe preview already comes from `/announce/preview`, which now computes it server-side, so the two stay in sync.

### Item 7 — Notify-completed-sites recipient selection

`notify-sites.ts` (worker) + `NotifyCompletedSitesButton.tsx` + its backing server action.

Today `handleNotifyCompletedSites` sends to `site_email` + `rm_email` + `am_email` (deduped) per site. Change so **`site_email` is the default and only guaranteed recipient**, with RM/RD opt-in:

- Worker: accept two optional booleans on the POST body — `includeRm` and `includeRd` (default false). Per site, always include `site_email`; include `rm_email` only when `includeRm`; include `am_email` only when `includeRd`. Keep the existing per-site case-insensitive dedup and the no-recipient `skippedCount` behavior. (Note the label-vs-data mapping from CLAUDE.md: RM = `rm_email`, RD = `am_email`.)
- Modal: add two **unchecked-by-default** checkboxes — "Also notify Regional Manager" (→ `includeRm`) and "Also notify Regional Director" (→ `includeRd`). Pass them through the server action into the POST body.
- Use case framing: the button exists to tell the **site** a change is live; informing RM/RD is an explicit opt-in, not the default.

## Out of scope

- No schema changes (no SQL).
- Don't relabel `Same` anywhere except the create-form dropdown (detail views / create-notify email still render the stored value `Same`; a broader display-label sweep is a separate item if wanted).
- No new worker endpoints — item 4 reuses the existing promo-list endpoint; items 5/6 reuse `substituteTemplate`.
- Don't change the include-PTP default behavior (item 1 is materials-only).
- Don't deploy from headless (push triggers CF Workers Builds). Don't bind production routes. Don't commit/push.

## Definition of done

- All 7 items implemented as specified.
- `pnpm typecheck` passes (expected 21/21).
- `pnpm --filter @splash/web build` succeeds; report the `/admin/promotions/[id]` route First-Load delta.
- `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run --outdir=.tmp-build` succeeds; clean up `.tmp-build`. Report bundle size delta.
- `computeMaterialsPtpCopy` exists identically in `templates.ts` (worker) and `announce-templates.ts` (client); note the dual-definition in a comment on both (same pattern as `substituteTemplate`).
- `BUILD_STATE.md`, `BRIEFS/INDEX.md` updated; this brief's Status → Completed (YYYY-MM-DD).
- `CLAUDE.md` "Promotions feature" glossary entry touched if any documented behavior changed (the materials-default and dynamic-copy behaviors are worth a sentence).

## Report

- Per-item confirmation (1–7) with the files touched for each.
- Manual-verification checklist for the operator:
  - Compose modal opens with **no materials pre-checked**.
  - Freeform compose shows a Signature input; it appends to the body (check Preview).
  - With a template selected, the "Pull details from a promo" picker autofills name/dates/offerings; offerings text matches promo type; all fields stay editable.
  - Heads-up trailing line changes with attach state: send with (a) nothing, (b) materials only, (c) PTP only, (d) both — confirm the four `materialsPtpNote` variants in Preview.
  - Follow-up body sentence changes the same way (`materialsPtpBody`).
  - Notify-completed-sites: default send hits site_email only; checking RM/RD adds those addresses (verify in `outbound_emails`).
- Any decisions made on the operator's behalf; any latent issues.

## Outcome

All seven items landed; `pnpm typecheck` 21/21 green; apps/web build green;
promo-worker wrangler dry-run green. No schema changes, no PA flow
changes, no new dependencies.

### Per-item confirmation

**Item 1 — Default unchecked materials.** Modified
`apps/web/app/admin/promotions/_components/AnnouncementComposeModal.tsx`:

- Open-seed flipped from `new Set(materials.map(m => m.id))` to
  `new Set()` so no materials are pre-checked.
- Section heading rewritten to "Attach materials (N selected) —
  nothing is attached unless you select it."
- The per-material `seedModes` map is preserved as-is (mode only
  matters once a material is checked).
- Brief's explicit decision (unchecked checkbox, not third per-material
  radio) followed; include-PTP default behavior unchanged.

**Item 2 — `Same` → "Same As Today" display.** Modified
`apps/web/app/admin/promotions/new/_components/CreatePromoForm.tsx`:

- Added a new `PROMO_TYPE_LABEL_OVERRIDES: Record<string, string> = {
  Same: "Same As Today" }` map keyed by stored value.
- `PROMO_TYPES` array unchanged. The `<option>` `value=` still emits
  the stored value `Same`; `<option>` text emits the override label.
- Decision: map-based override (vs. inline ternary) so adding more
  display overrides later is a one-line append. Detail / queue /
  IT-notify-email surfaces still render the stored value `Same`.

**Item 3 — Freeform signature field.** Modified three files:

- `apps/web/app/admin/promotions/_components/AnnouncementComposeModal.tsx`:
  added an optional `<input name="signature" maxLength=500>` below the
  freeform Body textarea (template branch unchanged).
- `apps/web/app/admin/promotions/_actions/announceActions.ts`:
  `ParsedComposeForm.freeform` widened with `signature: string`. Parse
  trims + validates `≤500 chars`. Both send + preview action calls
  conditionally spread `signature` into the worker body.
- `apps/web/app/admin/promotions/_lib/worker-fetch.ts`:
  `SendAnnouncementBody` and `PreviewAnnouncementBody` freeform
  variants widened with optional `signature?: string`.
- `apps/promo-worker/src/handlers/announce.ts`: new
  `SIGNATURE_MAX_LEN=500` constant; `KNOWN_BODY_KEYS` widened with
  `"signature"`. Freeform branch validates `signature` as optional
  string ≤500 chars and appends `"\n\n{signature}"` to `bodyText`
  when present + non-empty. Template branch ignores `signature` per
  the brief.

**Item 4 — Recent-promo picker + autofill + offerings relabel.**
Modified five files:

- `apps/promo-worker/src/announce/templates.ts`:
  `new_special_heads_up.kioskBehavior.label` relabeled from
  "Kiosk/POS behavior or details" → "Promo offerings for customers".
  Key + placeholder + template body unchanged.
- `apps/web/app/admin/promotions/_lib/announce-templates.ts`: new
  exported `RecentPromoForAutofill` interface
  (`id, title, promoType, proposedStartDate, proposedEndDate, createdAt`)
  next to `AnnouncementTemplate`.
- `apps/web/app/admin/promotions/[id]/page.tsx`: added
  `listPromos({ limit: 10 })` import + fetch (fail-soft
  `.catch(() => null)` → empty array). Threaded as
  `recentPromos: RecentPromoForAutofill[]` prop into the modal.
- `apps/web/app/admin/promotions/_components/AnnouncementComposeModal.tsx`:
  new `OFFERINGS_PRESET_BY_PROMO_TYPE` constant + new
  `bulkSetTemplateFieldValues(templateId, values)` helper (merges
  multi-field updates in one state-update tick). New sub-component
  `RecentPromoAutofillPicker` renders above the template field inputs
  when a template is selected AND `recentPromos.length > 0`. Picking
  a promo writes `specialName/startDate/endDate/kioskBehavior` where
  the picked template has those fields (offerings preset by
  promoType: `Same`/`BOGO` get explicit copy, others blank). Picker
  `<select>` is uncontrolled (resets after each pick) so re-picking
  the same option fires `onChange` again.

**Items 5 & 6 — Dynamic body copy based on actual attached state.**
Modified four files:

- `apps/promo-worker/src/announce/templates.ts`: new exported helper
  `computeMaterialsPtpCopy({ hasMaterials, includePtp })` returns
  `{ materialsPtpNote, materialsPtpBody }` (four cases each). Heads-up
  template body's static "There will be an announcement..." line
  replaced with `{materialsPtpNote}` placeholder; follow-up template
  body's static "Attached you'll find..." sentence replaced with
  `{materialsPtpBody}`. Placeholders are NOT in `fields[]` so the
  first `substituteTemplate` pass leaves them verbatim. Block comment
  on the helper notes the dual-definition pair with the client mirror.
- `apps/web/app/admin/promotions/_lib/announce-templates.ts`: client
  mirror of `computeMaterialsPtpCopy` defined IDENTICALLY (with comment
  noting dual-definition seam matching the existing `substituteTemplate`
  mirror).
- `apps/promo-worker/src/handlers/announce.ts`: `handleSendAnnouncement`
  and `handlePreviewAnnouncement` both compute `dynCopy` via
  `computeMaterialsPtpCopy` AFTER `resolvedMaterials` +
  `payload.includePtp` are known, then run a SECOND
  `substituteTemplate` pass on `payload.bodyText` to fill the
  placeholders. Guarded on `payload.templateId !== null` so freeform
  sends skip the pass. Send-path snapshot insert stores the
  post-substitution body in `promo_announcements.body_text`. Render
  call updated to use `finalBodyText`.
- `apps/web/app/admin/promotions/_components/AnnouncementComposeModal.tsx`:
  added `useMemo(dynCopy)` keyed on
  `props.selectedMaterials.size + props.includePtp` that calls the
  client mirror, then folds the result into a new
  `previewSubstitutionFields` map merged with
  `currentTemplateFieldValues`. The inline `<pre>` preview's
  `previewSubject` / `previewBody` calls now run against this merged
  map so the live preview matches the iframe preview which now runs
  the same computation server-side.

**Item 7 — Notify-completed-sites RM/RD opt-in.** Modified four files:

- `apps/promo-worker/src/handlers/notify-sites.ts`: `KNOWN_BODY_KEYS`
  widened with `"includeRm"`, `"includeRd"`. Body-parse adds optional
  boolean validation for both (defaults false; non-boolean returns
  400 `fields: {includeRm: "invalid"}`). Per-site recipient
  resolution loop changed to always include `site_email`, opt-in
  `rm_email` when `includeRm`, opt-in `am_email` (per CLAUDE.md
  RM/RD mapping) when `includeRd`. Per-site case-insensitive dedup
  retained; `skippedCount` for no-contact rows retained.
- `apps/web/app/admin/promotions/_lib/worker-fetch.ts`:
  `NotifyCompletedSitesBody` widened with optional booleans.
- `apps/web/app/admin/promotions/_actions/ticketActions.ts`:
  `notifyCompletedSitesAction` reads `includeRm` / `includeRd`
  checkboxes from FormData (`"on"` = true) and conditionally spreads
  booleans into the worker body.
- `apps/web/app/admin/promotions/_components/NotifyCompletedSitesButton.tsx`:
  added a new fieldset with two unchecked-by-default checkboxes —
  "Also notify Regional Manager" (`name="includeRm"`) and "Also
  notify Regional Director" (`name="includeRd"`) — under an "Also
  notify (optional)" legend. Modal intro copy reframed from
  "Recipients are the AM / RM / site email on record for each
  location." to "By default we email the site address on file — opt
  in below to also include the Regional Manager / Regional Director."

### Files touched (summary)

Created: 0 (no new files — every change folded into existing modules).
Modified: 11 files.

- `apps/promo-worker/src/announce/templates.ts` — items 4, 5 & 6
- `apps/promo-worker/src/handlers/announce.ts` — items 3, 5 & 6
- `apps/promo-worker/src/handlers/notify-sites.ts` — item 7
- `apps/web/app/admin/promotions/_components/AnnouncementComposeModal.tsx` — items 1, 3, 4, 5 & 6
- `apps/web/app/admin/promotions/_components/NotifyCompletedSitesButton.tsx` — item 7
- `apps/web/app/admin/promotions/_actions/announceActions.ts` — item 3
- `apps/web/app/admin/promotions/_actions/ticketActions.ts` — item 7
- `apps/web/app/admin/promotions/_lib/worker-fetch.ts` — items 3, 7
- `apps/web/app/admin/promotions/_lib/announce-templates.ts` — items 4, 5 & 6
- `apps/web/app/admin/promotions/[id]/page.tsx` — item 4
- `apps/web/app/admin/promotions/new/_components/CreatePromoForm.tsx` — item 2

### Decisions made on the operator's behalf

1. Default-off materials implemented as the unchecked checkbox (not a
   third per-material radio) — brief decision explicit; mirrors the
   pre-166 checkbox affordance so operator muscle memory carries.
2. Recent-promo picker is universal across all templates; autofills
   whatever overlaps with the picked template's `fields[]`. Brief was
   explicit.
3. Picker `<select>` is uncontrolled (resets after each pick) so
   re-picking the same option re-fires `onChange`. Otherwise picking
   promo A → editing fields → picking promo A again wouldn't
   re-autofill.
4. `bulkSetTemplateFieldValues` defined as a separate helper (vs.
   calling `setTemplateFieldValue` N times) so multiple field updates
   merge in one React state tick. Avoids intermediate renders + the
   stale-prev-state risk of N sequential `setState` calls within a
   single event handler.
5. Dual-definition seam for `computeMaterialsPtpCopy` placed next to
   `substituteTemplate` in both worker `templates.ts` and client
   `announce-templates.ts` so future executors find both side by
   side. Worker version stamped "Keep this function identically
   defined in..."; client version stamped "Client mirror of the
   worker's...". Same pattern as `substituteTemplate`.
6. Worker second-pass `substituteTemplate` guarded on `templateId !==
   null` per the brief — defensive; freeform bodies have no
   placeholders, so a second pass would be a no-op, but skipping
   avoids a useless regex pass per send.
7. Signature field cap = 500 chars (symmetric with the notify-sites
   note cap from Brief 164; consistent ceiling for "short single-line
   free-text" inputs across the feature so operator-facing limits are
   memorable).
8. "Same As Today" relabel implemented as a `PROMO_TYPE_LABEL_OVERRIDES`
   map so adding more overrides later is a one-line append — vs.
   inline ternaries that scatter across the file.
9. RM/RD worker body parse rejects non-boolean values with 400 +
   `fields: {includeRm: "invalid"}` (defense in depth; the modal sends
   booleans, but a typo'd PA call from an unrelated future surface
   would surface fast vs. silently falling through to false).
10. Modal intro copy reframed away from "Recipients are the AM/RM/
    site email" to "By default we email the site address on file —
    opt in below" so the new default is obvious at modal open.

### Latent issues found

- The per-submission detail page's `/admin/promotions/{id}` route
  jumped from 7.7 kB → 8.64 kB First-Load JS (+0.94 kB). The bulk
  is the recent-promo picker JSX + `computeMaterialsPtpCopy` client
  mirror + the new `useMemo(dynCopy)`. Comfortably under the 150 kB
  target — flagging for future executors profiling client bundle.
- The dual-definition contract on `computeMaterialsPtpCopy` is now
  the SECOND such pair in `_lib/announce-templates.ts` (alongside
  `substituteTemplate`). Adding a third would be a candidate for
  promoting these helpers to a shared package — out of scope here
  but worth noting if a fourth ever lands.
- The PA drain flow doesn't need changes for Brief 166 — the
  second-pass body substitution happens server-side before the
  queue row is written, so PA sees the same `body_text` / `body_html`
  shape it always has.

### Validation results

- `pnpm typecheck` — 21/21 green (9.206s).
- `pnpm --filter @splash/web build` — succeeded.
  - `/admin/promotions/[id]` route at 8.64 kB / 116 kB First-Load JS
    (+0.94 kB vs. Brief 163's 7.7 kB / 115 kB).
  - `/admin/promotions/new` at 3.02 kB / 110 kB (unchanged label
    map is display-only).
  - `/admin/promotions/[id]/ticket` at 5.49 kB / 113 kB (+0.11 kB —
    new RM/RD checkboxes).
- `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build` — succeeded.
  - Bundle: 920.92 KiB raw / 176.82 KiB gzip (+4.81 KiB raw /
    +1.11 KiB gzip vs. Brief 164's 916.11 / 175.71). Bulk is the
    `computeMaterialsPtpCopy` helper, signature parse branch in
    `parseAndValidateBody`, RM/RD parse branch in notify-sites, and
    the extensive comments documenting the dual-definition contract.
  - `.tmp-build` cleaned up post-validation.

### Manual-verification checklist for the operator

- Compose modal opens with no materials pre-checked; section heading
  reads "Attach materials (0 selected) — nothing is attached unless
  you select it."
- `/admin/promotions/new` promoType dropdown shows "Same As Today"
  for the `Same` option; stored value remains `Same` in the request.
- Freeform compose shows a Signature input below Body; "— The Splash
  team" typed there appears two newlines below the body in both
  Preview (iframe) and the sent email.
- With a template selected, the "Pull details from a promo"
  dropdown appears above the template fields; picking a promo
  autofills name/dates/offerings; offerings text matches promo type
  (`Same` / `BOGO` get explicit copy, others blank); all fields
  remain editable.
- Heads-up trailing line changes with attach state: send with
  (a) nothing, (b) materials only, (c) PTP only, (d) both — confirm
  the four `materialsPtpNote` variants in the iframe Preview.
- Follow-up body sentence changes the same way (`materialsPtpBody`).
- Notify-completed-sites: default send hits `site_email` only;
  checking "Also notify Regional Manager" adds `rm_email`; checking
  "Also notify Regional Director" adds `am_email`. Verify in
  `outbound_emails`.
- No deploys, no production-route bindings, no git commits per
  CLAUDE.md — operator drives the push when ready.
