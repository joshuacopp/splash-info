# Brief 163: Promo announcement — fillable templates

**Status:** Completed (2026-06-06)
**Started:** 2026-06-06
**Completed:** 2026-06-06
**Blocks:** Marketing operators today write the announcement body free-form for every send. Most announcements follow a small number of recurring shapes ("new special heads-up", "materials & PTP follow-up", "end-of-promo wrap-up"). Free-form composition produces inconsistent voice, typos, missing context, and operator friction. Operator: "would like there to be multiple announcement email options pre-made that offer fields to fill for details that fill a text portion of the email to make it formulaic rather than free text — free text should be an option, but something like 'We're announcing a new special that will be rolling out at your site soon! The special will be {special name}...'".
**Dependencies:** Brief 157 (announcement send endpoint + body_text/body_html plumbing), Brief 160 (preview endpoint + branded HTML shell — templates render through the same path), Brief 161 (inline materials payload — unchanged by this brief).

## Read first

- BUILD_STATE.md
- CLAUDE.md — "Promotions feature" glossary entry (covers the announcement send flow); Brief 157 / 160 entries (queue + render contract).
- BRIEFS/brief-157-promo-announcement-send.md (send endpoint shape — body validation extended here).
- BRIEFS/brief-160-promo-announcement-preview-branded-html-inline-materials.md (preview + render — templates run through `renderAnnouncement`).
- apps/promo-worker/src/handlers/announce.ts (send + preview handlers — both extended to accept template-driven bodies).
- apps/promo-worker/src/announce/render-html.ts (the renderer — templates resolve to plain text BEFORE this; renderer stays template-agnostic).
- apps/web/app/admin/promotions/_components/AnnouncementComposeModal.tsx (the compose modal — template picker added).
- supabase/promo-tables.sql (schema reference for the new `template_id` column).

## Architecture context

A template is a server-defined record: `{id, name, subjectTemplate, bodyTemplate, fields[]}` where `bodyTemplate` is a string with `{fieldKey}` placeholders and `fields[]` is an ordered list of `{key, label, type, required}` entries the UI renders as form inputs.

When the operator picks a template:
1. Compose modal renders the per-field inputs in place of the freeform Subject + Body textareas.
2. On submit, the modal sends `{templateId, templateFields: {fieldKey: value, ...}}` to the worker INSTEAD OF freeform `subject + bodyText`.
3. Worker validates the templateId, validates required fields, substitutes `{fieldKey}` placeholders, then runs the SAME render path (`renderAnnouncement(...)`) as today.
4. Resulting subject + plain text + HTML ride the queue exactly as freeform sends do.

Freeform stays as the default ("None / Custom" option in the picker) — no behavior change for operators who don't pick a template.

Template registry at v1 is code-defined (a TS module exported by promo-worker). Adding a new template is a one-file PR. DB-stored UI-editable templates are v2 — would need a CRUD admin surface and a new `promo_announcement_templates` table.

## Scope

### Phase 1 — Schema add

1.1 Operator runs (in Supabase SQL editor):

```sql
ALTER TABLE promo_announcements
  ADD COLUMN template_id text NULL,
  ADD COLUMN template_fields jsonb NULL;

COMMENT ON COLUMN promo_announcements.template_id IS
  'Template registry id used to compose this announcement, or NULL for freeform. Brief 163.';
COMMENT ON COLUMN promo_announcements.template_fields IS
  'Operator-supplied field values keyed by template field key, captured at send time. Drives the rendered body_text but stored separately for future "resend with this template" or analytics. NULL for freeform sends. Brief 163.';
```

  - Both columns are NULLABLE — freeform sends leave them NULL, template sends populate both.
  - `template_fields` is the as-supplied values (no placeholder substitution applied) so a future "edit & resend" UI can pre-populate the form.

### Phase 2 — Template registry module

2.1 New module `apps/promo-worker/src/announce/templates.ts`:

```ts
export interface TemplateFieldDef {
  key: string;            // matches {key} placeholders in subjectTemplate/bodyTemplate
  label: string;          // operator-facing
  type: "text" | "textarea" | "date";
  required: boolean;
  placeholder?: string;
  hint?: string;
}

export interface AnnouncementTemplate {
  id: string;             // stable; persisted on promo_announcements.template_id
  name: string;           // operator-facing dropdown label
  description?: string;   // muted helper text below the picker
  subjectTemplate: string;
  bodyTemplate: string;
  fields: TemplateFieldDef[];
}

export const ANNOUNCEMENT_TEMPLATES: ReadonlyArray<AnnouncementTemplate>;
export function findTemplate(id: string): AnnouncementTemplate | undefined;
export function substituteTemplate(
  template: string,
  fields: Record<string, string>
): string;
```

2.2 Initial registry — three templates as v1 (operator can request more in follow-up briefs):

```ts
export const ANNOUNCEMENT_TEMPLATES: ReadonlyArray<AnnouncementTemplate> = [
  {
    id: "new_special_heads_up",
    name: "New special — heads up",
    description: "Initial heads-up to the field that a new special is coming. Materials and PTP follow later.",
    subjectTemplate: "Coming soon: {specialName}",
    bodyTemplate:
      "We're announcing a new special that will be rolling out at your site soon!\n\n" +
      "The special will be {specialName}, and will offer customers {kioskBehavior}.\n\n" +
      "The special is planned to run from {startDate} to {endDate}.\n\n" +
      "There will be an announcement with more details, materials, and the PTP coming your way shortly!\n\n" +
      "{signature}",
    fields: [
      { key: "specialName", label: "Special name", type: "text", required: true, placeholder: "e.g. Family Plan BOGO" },
      { key: "kioskBehavior", label: "Kiosk/POS behavior or details", type: "textarea", required: true, placeholder: "What the customer experiences at the kiosk" },
      { key: "startDate", label: "Start date", type: "date", required: true },
      { key: "endDate", label: "End date", type: "date", required: true },
      { key: "signature", label: "Signature", type: "text", required: false, placeholder: "— The Splash team", hint: "Optional. Blank line if omitted." }
    ]
  },
  {
    id: "materials_ptp_followup",
    name: "Materials & PTP follow-up",
    description: "The follow-up to a heads-up send. Materials and PTP are now ready.",
    subjectTemplate: "Now available: materials + PTP for {specialName}",
    bodyTemplate:
      "Following up on the {specialName} announcement!\n\n" +
      "Attached you'll find the marketing materials and the Purpose/Tools/Process document for this special.\n\n" +
      "Please review and reach out to your manager with any questions.\n\n" +
      "{signature}",
    fields: [
      { key: "specialName", label: "Special name", type: "text", required: true },
      { key: "signature", label: "Signature", type: "text", required: false }
    ]
  },
  {
    id: "end_of_promo",
    name: "End-of-promo wrap-up",
    description: "Sent at the end of a promo's run.",
    subjectTemplate: "Wrap-up: {specialName} ended {endDate}",
    bodyTemplate:
      "The {specialName} special ended on {endDate}.\n\n" +
      "{recapText}\n\n" +
      "Thanks for everything you did to make this run successful!\n\n" +
      "{signature}",
    fields: [
      { key: "specialName", label: "Special name", type: "text", required: true },
      { key: "endDate", label: "End date", type: "date", required: true },
      { key: "recapText", label: "Recap notes", type: "textarea", required: false, hint: "Optional. Results, learnings, thank-yous." },
      { key: "signature", label: "Signature", type: "text", required: false }
    ]
  }
];
```

2.3 `substituteTemplate(template, fields)` semantics:
  - Replace every `{key}` occurrence with `fields[key] ?? ""`.
  - Unknown placeholders (no matching field) leave the `{key}` literal in place — defensive; future templates with stale placeholders would otherwise emit empty strings silently.
  - `type: "date"` field values are operator-supplied YYYY-MM-DD strings; the substitute reformats to "MMM D, YYYY" before insertion (more readable in email bodies).
  - HTML special chars in operator-supplied values are NOT escaped here — escaping happens downstream in `render-html.ts` per the existing Brief 160 contract.

### Phase 3 — Worker endpoint widening

3.1 In `apps/promo-worker/src/handlers/announce.ts`:

3.1.1 Body shape — accept EITHER freeform OR template, never both. Body union:

```ts
type AnnounceBody =
  | { mode: "freeform"; subject: string; bodyText: string; recipientEmails: string[]; selectedMaterialIds?: string[]; includePtp?: boolean; materialModes?: Record<string, "inline" | "attachment"> }
  | { mode: "template"; templateId: string; templateFields: Record<string, string>; recipientEmails: string[]; selectedMaterialIds?: string[]; includePtp?: boolean; materialModes?: Record<string, "inline" | "attachment"> };
```

  - Back-compat: if `mode` is absent BUT `subject` + `bodyText` are present, treat as freeform. Existing apps/web callers that don't know about Brief 163 continue to work.

3.1.2 Validation for `mode: "template"`:
  - `findTemplate(templateId)` — 400 `unknown_template` if missing.
  - For each `field` where `required: true`: `templateFields[field.key]` is a non-empty trimmed string. Collect missing keys into `fields` map; return 400 `bad_request` with `fields: {fieldKey: "required"}` on any miss.
  - Apply `substituteTemplate(template.subjectTemplate, templateFields)` → `subject`.
  - Apply `substituteTemplate(template.bodyTemplate, templateFields)` → `bodyText`.
  - From here, the rest of the send handler runs identically to freeform — same render call, same enqueue.

3.1.3 Snapshot row insert:
  - `body_text` = the resolved bodyText (post-substitution).
  - `template_id` = `template.id` (NULL for freeform).
  - `template_fields` = `templateFields` (NULL for freeform).

3.2 Preview endpoint (`handlePreviewAnnouncement`) — accept the same body union. Same validation. Same resolution. Returns the same `{html, plainText, attachmentSummary}` shape as today.

### Phase 4 — New endpoint: list templates

4.1 `GET /promo/api/announce/templates` (any non-null `promoRole`):
  - Returns `{templates: ANNOUNCEMENT_TEMPLATES}` — the full registry as defined in the module.
  - No CSRF gate (read-only).
  - No paging (small fixed set).
  - Cache: `Cache-Control: private, max-age=300` — registry is code-defined so it doesn't change between deploys, but a 5-minute cache balances freshness post-deploy with avoiding per-modal-open round-trips.

### Phase 5 — Apps/web compose modal

5.1 New helper `apps/web/app/admin/promotions/_lib/announce-templates.ts`:
  - Mirrors the worker's `AnnouncementTemplate` type.
  - Exports `fetchAnnouncementTemplates()` that calls the worker via the existing service binding pattern (Brief 158a `worker-fetch.ts`).
  - Returns `[]` on fetch error (fail-soft — freeform stays usable).

5.2 In `apps/web/app/admin/promotions/_components/AnnouncementComposeModal.tsx`:

5.2.1 Add a Template picker at the top of the modal, above the Recipients section:
  - `<label>Template</label>`
  - `<select>` with options:
    - `(none — write freeform)` — default, value `""`
    - One option per registered template (`option.value = template.id`, `option.label = template.name`)
  - On change:
    - Picking `""` → show the existing freeform Subject + Body textareas.
    - Picking a template id → hide freeform inputs; render `template.fields` as labeled inputs by type (`text` → `<input type=text>`, `textarea` → `<textarea>`, `date` → `<input type=date>`).
    - Display a muted "preview" below the field inputs showing the resolved Subject + Body (calls `substituteTemplate` client-side on every keystroke; same regex as the worker).

5.2.2 Form submit:
  - If template selected: send `{mode: "template", templateId, templateFields, recipientEmails, selectedMaterialIds, includePtp, materialModes}` to the worker.
  - If no template: send `{mode: "freeform", subject, bodyText, ...}` (or the legacy shape without `mode` — both work per Phase 3.1.1).

5.2.3 Preview button (Brief 160) flows the same body shape through to `/announce/preview`. The preview sub-modal iframe renders identically.

5.2.4 Materials checklist + PTP toggle + recipient editor are unchanged — they sit below the body/template-fields block, same as today.

5.3 Templates fetch on modal mount (or on parent page load, prop-drilled into the modal). Cache for the session via simple in-component state — operator opening the modal multiple times shouldn't re-fetch each time.

### Phase 6 — Server actions

6.1 Update `sendAnnouncementAction` in `apps/web/app/admin/promotions/_actions/announceActions.ts` to forward the new body shape — either pass-through or branch on `mode`.

6.2 Update `previewAnnouncementAction` likewise.

### Phase 7 — Validation

7.1 `pnpm typecheck` — must pass.
7.2 `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — bundle still emits.
7.3 `pnpm --filter @splash/web build` — bundle still emits.
7.4 Operator manual verification post-deploy:
  - Open compose modal, pick "New special — heads up", fill all fields, Preview — sub-modal renders the templated body with substitutions applied.
  - Send to self — inbox copy matches preview exactly.
  - Re-open compose modal, leave template at "(none)", confirm freeform path unchanged.
  - Inspect `promo_announcements` row for the template send — `template_id` + `template_fields` populated.

### Phase 8 — Docs

8.1 BRIEFS/INDEX.md: Brief 163 row appended.

8.2 BUILD_STATE.md: Findings entry noting:
  - New announcement template registry at `apps/promo-worker/src/announce/templates.ts` with three v1 templates
  - New endpoint `GET /promo/api/announce/templates` (any non-null promoRole)
  - Worker send + preview endpoints accept `mode: "template"` body shape alongside freeform
  - New `promo_announcements.template_id` + `template_fields` columns (NULL for freeform)
  - Compose modal extended with template picker + dynamic per-field inputs
  - Adding a new template is a one-file PR on `templates.ts`; UI-managed templates are v2

8.3 CLAUDE.md updates:
  - "Promotions feature" glossary entry: add Brief 163 paragraph covering the template registry, the v1 entries, the body shape union, and the schema additions.
  - Note that `template_fields` JSONB stores operator inputs verbatim (no substitution) so a future "edit & resend" UI can pre-populate.

## Out of scope

- UI-managed templates (operator adds/edits templates in the admin UI). v2. Would require a new `promo_announcement_templates` table + admin CRUD + a permission model decision.
- Per-recipient personalization (`{first_name}` etc.). Recipients are a flat email list; no addressbook lookup.
- Conditional/branching templates (`{#if specialName}...{/if}`). Templates are simple `{key}` substitution at v1.
- Multi-language templates. English only.
- Operator-saved drafts (start a template, save half-filled, come back later). v2 candidate.
- Templates that pre-fill from the promo's own data (`title`, `proposedStartDate`, etc.). v2 candidate — would auto-populate fields from the promo row so the operator only fills what's truly variable.
- Schema migration framework — operator runs the SQL manually per Phase 1.1.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `promo_announcements` schema additions documented in the brief; operator runs the SQL
- New module `apps/promo-worker/src/announce/templates.ts` with the three v1 templates + `substituteTemplate` helper + `findTemplate` helper
- New endpoint `GET /promo/api/announce/templates` returns the registry
- `handleSendAnnouncement` + `handlePreviewAnnouncement` accept the `mode: "template"` body shape and validate template + required fields; back-compat for legacy freeform body shape preserved
- `promo_announcements` insert populates `template_id` + `template_fields` on template sends; NULL on freeform
- Compose modal renders the template picker + dynamic per-field inputs + live preview
- pnpm typecheck passes
- promo-worker dry-run deploy succeeds
- apps/web build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (expected 500-700 LOC: registry module + worker validation + endpoint + apps/web modal extension + action passthrough)
- Confirmation that:
  - All three v1 templates render cleanly through preview + send
  - Freeform path unchanged (regression check)
  - Schema columns populate correctly
  - Required-field validation rejects empty submits with field-keyed error
- Validation results
- Any decisions made on the operator's behalf

## Outcome

### Files created

- `apps/promo-worker/src/announce/templates.ts` — code-defined registry of three v1 templates (`new_special_heads_up`, `materials_ptp_followup`, `end_of_promo`) + `findTemplate` + `substituteTemplate` helpers. ~170 LOC.
- `apps/web/app/admin/promotions/_lib/announce-templates.ts` — client-safe type definitions (`AnnouncementTemplate`, `TemplateFieldDef`) + client-side `substituteTemplate` mirror used by the compose modal's live preview. ~70 LOC.

### Files modified

- `apps/promo-worker/src/handlers/announce.ts` — `KNOWN_BODY_KEYS` widened with `mode | templateId | templateFields`; `AnnounceBody` interface + `ValidatedAnnouncePayload` interface gained the template-resolution fields; `parseAndValidateBody` rewritten to discriminate freeform vs. template (explicit `mode` wins; absent `mode` + subject/bodyText present = freeform back-compat); template branch looks up the registry, validates each required field, substitutes via `substituteTemplate`, then runs the post-substitution subject + body through the same length caps as freeform; freeform branch rejects template-only keys as a defense-in-depth check; snapshot insert now writes `template_id` + `template_fields` JSONB columns (NULL for freeform); new handler `handleListAnnouncementTemplates` returns `{templates}` with `Cache-Control: private, max-age=300`.
- `apps/promo-worker/src/index.ts` — new route `GET /promo/api/announce/templates` mounted before the existing announce preview/send routes; new handler imported.
- `apps/web/app/admin/promotions/_lib/worker-fetch.ts` — `SendAnnouncementBody` + `PreviewAnnouncementBody` flipped to discriminated unions (`mode: "freeform" | "template"`); back-compat preserved by making `mode` optional on the freeform branch; new helper `listAnnouncementTemplates()` calling `/promo/api/announce/templates` via the existing `callPromo` dispatcher — fail-soft (returns `[]` on error so the modal degrades to freeform-only); imports `AnnouncementTemplate` type from the client-safe lib module.
- `apps/web/app/admin/promotions/_actions/announceActions.ts` — `ParsedComposeForm` flipped to discriminated union; `parseComposeForm` reads the hidden `templateId` FormData entry first, walks `templateField[{key}]` entries when present, branches to the template path; both `sendAnnouncementAction` and `previewAnnouncementAction` dispatch on `mode` and forward the appropriate body shape to the worker.
- `apps/web/app/admin/promotions/_components/AnnouncementComposeModal.tsx` — new `templates: AnnouncementTemplate[]` prop; new state `selectedTemplateId` + `templateFieldValues` (keyed `${templateId}.${fieldKey}` so picking a different template preserves prior entries when the operator flips back); reset on modal open; template picker `<select>` rendered above Recipients section when `templates.length > 0`; when a template is selected, per-field inputs (text / textarea / date) replace the freeform Subject + Body sections + a live preview block renders the substituted subject + body via the shared client-side `substituteTemplate`; hidden `templateId` + `templateField[{key}]` FormData entries emitted so the server action carries the operator inputs to the worker.
- `apps/web/app/admin/promotions/[id]/page.tsx` — fetches `listAnnouncementTemplates()` in parallel with `resolveRecipients` (canWrite-gated, fail-soft to `[]`); prop-drilled into the modal alongside `defaultRecipients`.

### Decisions made on the operator's behalf

1. **Client-safe split.** First build attempt failed because the modal (client component) imported a module that transitively imported `next/headers` via `worker-fetch.ts`. Split into two files: `announce-templates.ts` is client-safe (types + `substituteTemplate` mirror only); the server-side fetch helper lives directly in `worker-fetch.ts` as `listAnnouncementTemplates()` and is imported by the page server component. Same `AnnouncementTemplate` type shared via a type-only `import type` from worker-fetch.ts.
2. **Template field values keyed by `${templateId}.${fieldKey}`.** Operator may flip between templates while composing; keying the values map by template id preserves their prior inputs in case they flip back. Clearing on modal open ensures each compose session starts fresh.
3. **Template picker hides when `templates.length === 0`.** The fetch is fail-soft — a worker error or unbound role would surface as an empty array, and the modal silently degrades to freeform-only rather than showing an empty/disabled picker.
4. **Live preview rendered as `<pre>` + plain text.** Simpler than embedding the full HTML preview iframe; the preview iframe (Brief 160) is still available via the existing Preview button which flows the same template-resolved body through the `/announce/preview` endpoint.
5. **Defensive template-field value cap at 10 000 chars.** Generous (well above realistic input length) — the post-substitution subject + body still go through `SUBJECT_MAX_LEN=500` / `BODY_MAX_LEN=50000` so the cap is a per-field DoS-defense layer, not a UX gate.
6. **Date field reformatting via `formatIsoDate`.** YYYY-MM-DD input transforms to "MMM D, YYYY" on substitution — the brief specifies this behavior. Helper is duplicated client + server so the live preview matches what's sent. Unknown / malformed dates pass through unchanged (defensive against operator pasting a pre-formatted value).
7. **Unknown placeholders are LEFT IN PLACE.** Per the brief — `{thisIsTypo}` survives verbatim rather than emitting an empty string silently. Makes future stale-template detection easier in operator review.
8. **Freeform body rejects template-only keys with `unexpected`.** A freeform send carrying a stray `templateId` would silently be ignored otherwise — defense in depth surfaces this as a field-level validation error.
9. **The worker preview endpoint and send endpoint share `parseAndValidateBody` so they cannot diverge.** Adding `mode` discrimination once in the shared helper means both flows render the same body for the same input — preview is true preview, not approximation.
10. **Per-field hidden mirrors emitted for every template field.** Rather than building FormData manually at submit time, every template field has a sibling `<input type="hidden" name="templateField[{key}]">` controlled by the visible input's state. Submit just hands the form's FormData to React 19's `useActionState` and the action reads the entries.

### Schema additions

Operator runs in Supabase SQL editor:

```sql
ALTER TABLE promo_announcements
  ADD COLUMN template_id text NULL,
  ADD COLUMN template_fields jsonb NULL;

COMMENT ON COLUMN promo_announcements.template_id IS
  'Template registry id used to compose this announcement, or NULL for freeform. Brief 163.';
COMMENT ON COLUMN promo_announcements.template_fields IS
  'Operator-supplied field values keyed by template field key, captured at send time. Drives the rendered body_text but stored separately for future "edit & resend" or analytics. NULL for freeform sends. Brief 163.';
```

Both columns nullable — freeform sends leave them NULL, template sends populate both. `template_fields` is the as-supplied values (no substitution applied) so a future "edit & resend" UI can pre-populate the form.

### Latent issues found

- The worker accepts a freeform send today even when `mode` is absent + `subject` + `bodyText` are present — Brief 157/160 back-compat for callers that don't know about Brief 163. The apps/web modal always emits a `templateId` hidden input (empty string when freeform) so the server action sees it, but the worker remains tolerant of legacy clients hitting the endpoint directly.
- Template "Preview" via the iframe sub-modal (Brief 160) renders correctly for template sends because the action forwards the template body shape to `/announce/preview` which resolves substitution server-side. The inline `<pre>` preview block is a fast feedback loop; the iframe is the authoritative preview.
- Operator's edit-and-resend UI (v2) is unblocked by `template_fields` JSONB being stored verbatim. No additional schema work required at that brief.

### Validation results

- `pnpm typecheck` — 21/21 green (5.17s after cache; 5.95s with promo-worker + web cache miss).
- `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — bundle 900.84 KiB raw / 172.74 KiB gzip (+7.82 KiB raw / +2.09 KiB gzip vs Brief 162's 893.02 / 170.65).
- `pnpm --filter @splash/web build` — succeeded. `/admin/promotions/[id]` route 7.7 kB / 115 kB First-Load (+0.86 kB / +1 kB vs Brief 160's 6.84 kB / 114 kB) — comfortably under the 150 kB target.

### Diff size

- ~825 LOC added across 8 modified + 2 new files (worker ~250 LOC including the registry; apps/web ~575 LOC across modal + actions + worker-fetch + types).
- Within the brief's "expected 500-700 LOC" — the overage comes from the modal extension carrying both the template picker, the per-field input rendering, the live preview block, and the hidden FormData mirrors all in one file.

