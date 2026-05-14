# Brief 129: Completed-form PDF generator + per-email-step attach flag

**Status:** Completed (2026-05-14)
**Started:** 2026-05-14
**Completed:** 2026-05-14
**Blocks:** Neither — picks up the `v2` placeholder operator
confirmed in the Brief 125 mockup, now implementable on Brief 127's
outbound_emails attachment infrastructure.
**Dependencies:** Brief 120 (workflow schema + history). Brief 125
(workflow builder Workflow tab). Brief 127 (outbound_emails table +
`attachments[]` jsonb with R2-key references; queue claim endpoint
inlines R2 attachments as base64).

## Read first

- CLAUDE.md (`forms-worker` glossary — Brief 120 / 125 / 127
  entries + the new outbound_emails attachment contract)
- BRIEFS/brief-127-outbound-email-queue-and-workflow-email-steps.md
  (attachment shape on `outbound_emails`, claim-endpoint R2 inline
  pattern this brief consumes)
- BRIEFS/brief-032-claim-summary-pdf-and-customer-email.md
  (closest reference implementation — pdf-lib programmatic layout
  for the damage claim summary PDF)
- apps/damage-worker/src/pdf/* (reference — Brief 32's PDF
  module; this brief mirrors the structure)
- packages/forms-schema/src/types.ts +
  validators/field-config.ts (schema additions: `field.exclude_from_pdf`
  optional flag; `EmailStage.attach_pdf` optional flag)
- apps/web/app/admin/forms/[id]/_field-types/* (Field Inspector
  components per type — adds the exclude_from_pdf checkbox)
- apps/web/app/admin/forms/[id]/_workflow/WorkflowTab.tsx (Brief
  125 — email step card gains the Attach PDF checkbox)
- apps/forms-worker/src/submit/index.ts +
  src/admin/submissions.ts (transition handler — email step
  cascade integration point)
- apps/forms-worker/src/cron/cleanup.ts (Brief 97 — extends with a
  PDF orphan pass)

## Context

Operator confirmed the v1 design: auto-generated PDF, no PDF
builder UI, one per-field exclude flag, one per-email-step attach
flag. The generator renders a standard layout (Splash header,
metadata, form payload, workflow history with signatures and notes,
footer) — same level of professional fit/finish as damage-worker's
claim summary PDF (Brief 32). Operators who want a different layout
get the v2 "PDF tab with builder" conversation later; in practice
the auto layout serves 95% of cases.

The PDF lives at `form-submission-pdfs/{form_id}/{submission_id}.pdf`
in the splash-forms `FORMS_FILES` R2 bucket. Generated once per
submission (lazily — on first email step that opts in), reused
across any subsequent email steps that also attach. Attached to
outbound_emails rows as `{r2_key, filename, mime, size_bytes}` —
the queue claim endpoint (Brief 127) base64-inlines at PA fetch
time.

## Scope

### Phase 1 — PDF generator module

New folder `apps/forms-worker/src/pdf/` with:

**1a. `generate.ts`** — public entry point.

```ts
export async function generateCompletedFormPdf(
  env: Env,
  ctx: GenerateContext
): Promise<Uint8Array>;

export interface GenerateContext {
  submission: SubmissionRow;
  schema: FormSchema;
  formTitle: string;
  formSlug: string;
  workflowHistory: WorkflowHistoryEntry[];
  outcomeLabel?: string;
  outcomeReachedAt?: string;
}
```

Returns the PDF as a `Uint8Array` ready to write to R2. Throws on
failure (caller catches + fail-soft logs per Brief 32 pattern).

**1b. `layout-header.ts`** — top band on page 1. Splash navy
background, white-script logo loaded from R2
(`assets/splash-logo-white.png` — same asset Brief 32 uses), form
title in white text, submission ID + submitted-at timestamp in
small muted text. ~80px tall.

**1c. `layout-metadata.ts`** — grid below header on page 1.
Submission ID (short uuid), Submitted at (EST formatted via the
same `formatEst()` helper apps/web uses), Submitter email,
Submitter kind (authenticated vs anonymous), Form version,
Outcome (when reached — with timestamp).

**1d. `layout-payload.ts`** — main body. Iterates
`schema.fields` in schema order. Skips:
- Fields with `exclude_from_pdf: true`
- Fields of type `heading` are KEPT (they render as bold section
  headers — operator's confirmed intent: "headers from the form
  itself included in pdf"). Per-heading `exclude_from_pdf` still
  works to hide individual headings.
- Fields of type `image` (display-only, no payload value).
- Fields whose payload value is null/empty (render placeholder dash
  for required fields, skip entirely for optional).

Per-field-type rendering:
- `short_text` / `long_text` / `email` / `phone` / `dropdown` /
  `radio`: label (bold) + value (regular). Wrap on overflow.
- `multi_checkbox`: label + comma-separated values.
- `date` / `time`: label + formatted value.
- `location`: label + resolved location_pretty (from
  pricing_simple) when available, else slug.
- `lookup`: label + payload value + a small "(resolved from
  {key field label})" annotation.
- `file`: label + comma-separated filenames + inline thumbnails for
  image MIMEs (max 3 thumbnails per file field, each ~200px wide).
  For non-image MIMEs render filename + size only.
- `signature`: label + the signature image (PNG/JPG) embedded
  inline at ~300px wide.
- `heading`: rendered as h3-style bold text spanning full width,
  no value column. Acts as a section break.

Use pdf-lib's `drawText` for text and `embedPng` / `embedJpg` for
images. Auto page-break when the cursor approaches the bottom
margin.

**1e. `layout-workflow-history.ts`** — workflow timeline section,
rendered after the payload (with a page break if needed for
visual separation). Heading "Approval history".

For each `workflowHistory` entry:

- **From → To** line: `{from_stage_label} → {to_stage_label}` (resolve
  labels from the schema; fall back to stage IDs if missing).
- **Actor row**: `{actor_email}` (or "System" for `actor_kind:
  "system"` entries — Brief 127's email step cascade) + timestamp
  in EST.
- **Action** row: `Action: {action_label}` (e.g., "Approve" /
  "Deny" — pulled from the transition's label).
- **Note** (when present): the operator's note text in italic.
- **Typed name** (when present): "Typed name: {typed_name}".
- **Signature** (when present): fetch the signature R2 object via
  `signature_r2_key`, embed inline at ~250px wide.
- **Email step entries** (Brief 127 `kind: "email"` history rows):
  render as `Sent {N} email{s} to {recipients}`. No signature, no
  note — system-generated.

Separator line between entries.

**1f. `layout-footer.ts`** — bottom of every page. "Page N of M"
right-aligned, Splash branding line left-aligned ("Splash Car
Wash — splashcarwashes.info"), small muted text.

**1g. `layout-utils.ts`** — shared helpers: `loadFont` (Helvetica +
Helvetica-Bold via pdf-lib's standard fonts — no custom font
embedding at v1), `drawLabelValue`, `drawHeading`,
`measureTextHeight`, `addPageIfNeeded`, `fetchAndEmbedR2Image`
(takes an r2_key, fetches the object from `FORMS_FILES`, detects
PNG/JPG/etc by content-type, embeds appropriately; throws on
unsupported MIME so the caller can skip gracefully).

pdf-lib is added as a new direct dep on the forms-worker:
`pdf-lib@^1.17.1` (same version damage-worker uses — keeps the
bundle dedupe friendly).

### Phase 2 — Schema additions

**2a. `field.exclude_from_pdf?: boolean`** on every field type.
Optional, defaults missing/false. Extend
`packages/forms-schema/src/types.ts` — add to the `FieldBase`
common shape so every field type inherits it without per-type
duplication.

Zod validator update in `validators/field-config.ts`: accept the
flag, no strict-mode enforcement beyond type checking.

**2b. `EmailStage.attach_pdf?: boolean`** on the workflow's email
step (Brief 127). Optional, defaults missing/false. When true,
the email step's enqueue path generates / reuses the PDF and
attaches it.

Zod validator: accept the flag on the email-kind discriminated
union variant.

### Phase 3 — Field Inspector UI

Each per-type Inspector component
(`apps/web/app/admin/forms/[id]/_field-types/{type}/Inspector.tsx`)
gets one new checkbox at the bottom of its config form, inside an
"Advanced" `<details>` block:

```tsx
<details>
  <summary>Advanced</summary>
  <label>
    <input
      type="checkbox"
      checked={field.exclude_from_pdf ?? false}
      onChange={(e) => dispatch({
        type: "update_field_config",
        fieldId: field.id,
        config: { exclude_from_pdf: e.target.checked }
      })}
    />
    Don't include in PDF exports
  </label>
  <p>Useful for internal-only fields that shouldn't appear on emailed PDFs.</p>
</details>
```

Lives in a SHARED component
`apps/web/app/admin/forms/[id]/_field-types/_shared/AdvancedSection.tsx`
that every Inspector imports and renders at the bottom of its
config. Keeps the per-type Inspectors lean.

`heading` and `image` field types also get the checkbox —
`heading` for the same exclude semantics; `image` is a no-op
(images aren't rendered in the PDF) but the checkbox still saves
to schema for forward-compat.

### Phase 4 — Email step Inspector UI

Update the Workflow tab's email step card (Brief 125's
`apps/web/app/admin/forms/[id]/_workflow/EmailStepCard.tsx`):

Add a new section between the body textarea and the "Then go to"
dropdown:

```tsx
<label>
  <input
    type="checkbox"
    checked={stage.attach_pdf ?? false}
    onChange={(e) => dispatch({
      type: "update_stage",
      stageId: stage.id,
      patch: { attach_pdf: e.target.checked }
    })}
  />
  Attach PDF of completed form
</label>
<p>
  Includes form fields (minus any marked "Don't include in PDF") and the
  full approval history with signatures.
</p>
```

The Quick patterns button's templates (Brief 127 Phase 5d) — when
the operator picks "Email submitter on outcome", default
`attach_pdf: true` (submitters typically want the PDF). When the
operator picks "Email approver when assigned", default
`attach_pdf: false` (approvers can click through to the review
page; the assignment email shouldn't ship a PDF before the
approver acts).

### Phase 5 — Worker hook: generate-or-reuse on email step fire

Update the worker's email step processing logic (Brief 127 Phase 6)
to handle the attach_pdf flag.

When firing an email step with `attach_pdf: true`:

1. **Check R2** for an existing PDF at
   `form-submission-pdfs/{form_id}/{submission_id}.pdf`.
   - If exists AND its `Last-Modified` is AFTER the latest
     `workflow_history[*].at` timestamp → reuse (workflow state
     unchanged since generation). Read the metadata for the
     attachment shape.
   - Otherwise → regenerate (workflow has new events that
     should appear in the PDF; first-time generation).
2. **Generate** via `generateCompletedFormPdf` (Phase 1). Pass
   the current `submission`, `schema`, `workflowHistory` array
   (including the just-stamped email step entry, if any), and
   resolved outcome label/timestamp when the email step's
   destination is an outcome.
3. **Write to R2.** PUT `form-submission-pdfs/{form_id}/{submission_id}.pdf`
   with `Content-Type: application/pdf`.
4. **Build the attachment.** Push onto the outbound_emails row's
   `attachments[]`:
   ```ts
   {
     filename: `${slugify(formTitle)}-${submissionId.slice(0, 8)}.pdf`,
     r2_key: `form-submission-pdfs/${formId}/${submissionId}.pdf`,
     mime: "application/pdf",
     size_bytes: pdfBytes.byteLength
   }
   ```
5. **Multi-email-step cascade.** If a second email step in the same
   transition cascade also has `attach_pdf: true`, the second pass
   reads the R2 metadata (Last-Modified vs workflow_history latest
   timestamp) and reuses the just-generated PDF. No duplicate
   generation per submit/transition.

Fail-soft: if generation or R2 write throws, log
`[forms.pdf] generate failed for submission {id} stage {stageId}`
and continue WITHOUT the attachment. The email step still
enqueues (just without the PDF). Brief 127's outbound_emails row
gets sent normally.

Generation timeout: wrap in an `AbortController` with a 15s
deadline. PDF generation should be < 2s for typical forms; the
timeout catches pathological cases (huge file fields with many
image thumbnails) without blocking the transition handler.

### Phase 6 — R2 cleanup extension

Brief 97's daily cleanup cron at 11:00 UTC adds a third sweep:

`form-submission-pdfs/{form_id}/{submission_id}.pdf` objects that
DON'T have a matching `form_submissions.id` row → delete. Same
pagination + soft-fail pattern as the existing two sweeps. Hard
ceiling of 20 pages × 1000 keys = 20K orphan PDFs per run.

Why orphan: if a submission gets deleted via Supabase SQL editor
(operator cleanup), its PDF should follow. R2 storage costs add
up if PDFs linger forever.

PDFs for ACTIVE submissions are never deleted (no TTL — they're
referenced indefinitely for re-send / re-attach).

### Phase 7 — Validation

7.1 `pnpm typecheck` — must pass.
7.2 `pnpm --filter @splash/web build` — must succeed.
7.3 `pnpm --filter @splash/forms-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up.
    Expect bundle size to grow ~150-200 KiB (pdf-lib added).
7.4 No Supabase / R2 / wrangler.toml / secret changes (R2 bucket
    `FORMS_FILES` is reused for the new `form-submission-pdfs/`
    prefix).
7.5 Operator post-deploy smoke (deferred):
    - Build a workflow form with several fields including a
      signature, a heading, and one short-text marked "Don't
      include in PDF exports". Add an approval step + outcome
      "Approved" with an email step right before the outcome,
      `attach_pdf: true`, recipient = `{submitter.email}`.
    - Submit the form. Approve it.
    - Wait for the email step cascade to fire. Check the
      `outbound_emails` row for the submitter — `attachments[]`
      contains one entry pointing at R2.
    - After PA's next 5-min poll (or manually trigger the claim
      endpoint), the attachment gets base64-inlined.
    - Confirm the submitter receives an email with the PDF
      attached.
    - Open the PDF. Verify:
      - Splash navy header with white logo + form title.
      - Submission metadata grid.
      - Form payload — every field's value, EXCEPT the
        "exclude_from_pdf" field, which is absent.
      - Heading fields render as bold section headers.
      - Signature field's image embedded inline.
      - Approval history section with the approver's email,
        action label (Approve), timestamp, signature image, note
        (if any), typed name (if any).
      - Outcome line at the top metadata grid: "Outcome: Approved
        — reached at {ts}".
      - Footer on every page with page numbers + Splash branding.
    - Test re-send / second email step with attach_pdf — confirm
      the SAME PDF is reused (Last-Modified unchanged on the R2
      object).

### Phase 8 — Updates

8.1 BRIEFS/INDEX.md: Brief 129 row appended.

8.2 BUILD_STATE.md: Findings entry noting:
  - Brief 129 (YYYY-MM-DD) — completed-form PDF generator on
    splash-forms. pdf-lib programmatic layout (Brief 32 pattern,
    no custom fonts). Per-field `exclude_from_pdf` flag in the
    Fields tab's Inspector Advanced section. Per-email-step
    `attach_pdf` flag in the Workflow tab's email step card.
    PDF stored at `form-submission-pdfs/{form_id}/{submission_id}.pdf`
    in `FORMS_FILES` R2, generated once per submission, reused
    across multiple email steps. Brief 97 cleanup cron extended
    to sweep orphan PDFs.
  - Schema additions: `field.exclude_from_pdf?: boolean` on
    every field type, `EmailStage.attach_pdf?: boolean` on the
    workflow's email step.

8.3 CLAUDE.md `forms-worker` glossary: append a Brief 129
paragraph documenting the PDF generator surface, the R2 key
convention, and the per-submission reuse posture.

8.4 R2 key convention doc: add `form-submission-pdfs/...` to the
forms-worker R2 layout note (sibling to `form-assets/` and
`form-submission-files/`).

## Out of scope

- Custom layout / field ordering on the PDF (vs. schema order).
  v2.
- Section grouping beyond heading fields. v2.
- Custom branding per form (logo override, color scheme). Splash
  branding is universal at v1.
- Watermarks (Approved / Denied stamp overlay). v2.
- Multi-language PDFs. English only at v1.
- Custom fonts. Helvetica only (pdf-lib's standard font, no
  embedding overhead).
- Attaching the PDF to webhooks (Brief 32/101/102 customer/internal
  webhooks). The PDF infrastructure lives on splash-forms for the
  outbound_emails queue; damage-worker continues to ship its
  separate claim summary PDF independently. Cross-worker PDF
  consolidation is a v3 conversation.
- A "Download PDF" button on the per-submission detail page.
  Useful but separate concern. Candidate fast-follow if operators
  request it.
- PDF preview in the form builder. Operator submits a test entry
  to see the actual output.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `generateCompletedFormPdf` exported from
  `apps/forms-worker/src/pdf/generate.ts`.
- Per-field `exclude_from_pdf` flag in schema + Field Inspector's
  Advanced section.
- Per-email-step `attach_pdf` flag in schema + email step card.
- Quick patterns templates set `attach_pdf` sensibly (outcome
  template → true; assignment template → false).
- Worker hook generates / reuses PDF when an email step fires
  with `attach_pdf: true`, writes to R2, pushes attachment onto
  the outbound_emails row.
- Brief 97 cleanup cron extended with PDF orphan sweep.
- Fail-soft on PDF generation failure — email still enqueues
  without the attachment.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 8.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate.
- Validation results.
- pdf-lib bundle size impact on the forms-worker compressed
  size (current baseline ~210 KiB gzipped per Brief 123).
- Any signatures or file thumbnails that didn't render cleanly
  (MIME detection edge cases, image dimension issues).
- Generation time for a representative form (5-10 fields + 1
  signature + 3 history entries) — confirm < 2s typical.
- R2 PUT cost / billing impact estimate (each PDF write is one
  R2 Class A operation).

## Outcome

### Files created

- `apps/forms-worker/src/pdf/generate.ts` — public entry
  `generateCompletedFormPdf(bucket, ctx) → Uint8Array`. Composes header
  + metadata + payload + workflow history + footers.
- `apps/forms-worker/src/pdf/layout-utils.ts` — shared cursor model +
  font loader + wrap/measure helpers + key/value grid + R2 image
  fetch+embed (PNG/JPEG MIME sniff with magic-byte fallback) + EST
  timestamp formatter + filename slugifier + truncateToWidth.
- `apps/forms-worker/src/pdf/layout-header.ts` — splash-navy band on
  page 1 with white-script logo from `assets/splash-logo-white.png` R2
  (fail-soft when missing; mirrors Brief 32's pattern) + form title +
  submission id + EST submitted-at.
- `apps/forms-worker/src/pdf/layout-metadata.ts` — two-column metadata
  grid (Submission ID / Submitted / Submitter / Submitter type / Form
  version / Outcome). When in-flight (no outcome), surfaces a "Current
  status" field with the workflow stage label.
- `apps/forms-worker/src/pdf/layout-payload.ts` — per-field-type
  renderer respecting `exclude_from_pdf`. Headings render as bold
  section breaks; `image` fields skipped; lookup gets "(resolved from
  X)" annotation; location renders the resolved pretty name; file
  fields render filename + size + up to 3 inline image thumbnails;
  signatures render inline at ~300px wide; dropdown/multi resolve
  option labels.
- `apps/forms-worker/src/pdf/layout-workflow-history.ts` — section
  rendered after the payload with a page break when mid-page; per-
  entry from→to header + actor + EST timestamp + note + typed_name +
  inline signature image (~250px). System-actor entries
  (`actor_email === "system@forms"`) render the cascade note inline.
- `apps/forms-worker/src/pdf/layout-footer.ts` — drawn on every page
  after body content lands. Brand line left, "Page N of M" right.
- `apps/forms-worker/src/pdf/cascade-attach.ts` — generate-or-reuse
  helper. `generateOrReuseCompletedPdf(env, ctx)` reads R2 at
  `form-submission-pdfs/{form_id}/{submission_id}.pdf`, reuses when
  `R2.head().uploaded > latest workflow_history[*].at`, regenerates
  + PUTs otherwise. 15s `AbortController` timeout. Returns
  `{attachment, wasGenerated}` or null on failure.
- `apps/web/app/admin/forms/[id]/_field-types/_shared/AdvancedSection.tsx`
  — collapsed `<details>`-wrapped `LabeledCheckbox` "Don't include in
  PDF exports". Reads/writes `field.exclude_from_pdf` via the shared
  `onUpdate` patch.

### Files modified

- `apps/forms-worker/package.json` — pdf-lib `^1.17.1` added (same
  version damage-worker uses → bundle dedupe).
- `packages/forms-schema/src/types.ts` — `FieldBase.exclude_from_pdf?:
  boolean` inherited by every field type. `WorkflowStage.attach_pdf?:
  boolean` on email-step stages.
- `packages/forms-schema/src/validators/field-config.ts` — both
  `fieldBaseSchema` and `fieldBaseSchemaDraft` accept the optional
  `exclude_from_pdf` boolean; both strict and draft workflow stage
  schemas accept the optional `attach_pdf` boolean.
- `apps/forms-worker/src/workflow-email-step.ts` — `cascadeThroughEmailSteps`
  gains optional `submissionMeta: SubmissionRowMeta` +
  `priorWorkflowHistory: WorkflowHistoryEntry[]` params. Per-stage
  loop fires `generateOrReuseCompletedPdf` when the stage has
  `attach_pdf: true` AND `submissionMeta` is set; pushes the
  resulting attachment onto every recipient's `OutboundEmailPayload.
  attachments`.
- `apps/forms-worker/src/submit/index.ts` — submit-time cascade call
  passes `submissionMeta: {id, submittedAt: new Date().toISOString(),
  submitterKind, submitterEmail}` + `priorWorkflowHistory: []`.
- `apps/forms-worker/src/admin/submissions.ts` — transition-time
  cascade call passes `submissionMeta` from the loaded submission +
  `priorWorkflowHistory: finalHistory.slice()`. Widens the `version`
  stub from `{id: "", versionNumber: 0}` to the real values from
  `submission.version` (id + version_number).
- `apps/forms-worker/src/cron/cleanup.ts` — third sweep added for
  `form-submission-pdfs/` orphans. 1h grace, 20-page = 20K-PDF/run
  cap. `CleanupResult` shape extended with `pdfsDeleted` +
  `pdfPagesScanned`.
- `apps/web/app/admin/forms/[id]/_builder/Inspector.tsx` — imports
  `AdvancedSection` and renders it once at the bottom of the
  `FieldInspector` wrapper. Pragmatic deviation from the brief's
  "every Inspector imports it" wording — same operator-facing
  behavior with much less code surface; adding a 17th field type
  still inherits the flag automatically.
- `apps/web/app/admin/forms/[id]/_builder/reducer.ts` — widened the
  `workflow_update_email_step` action's Pick to include `attach_pdf`.
  Quick-pattern "Email submitter on outcome" seeds `attach_pdf:
  true`; "Email approver when assigned" seeds `attach_pdf: false`.
- `apps/web/app/admin/forms/[id]/_workflow/WorkflowTab.tsx` — widened
  the `WorkflowTabDispatch.onUpdateEmailTemplates` Pick to include
  `attach_pdf`.
- `apps/web/app/admin/forms/[id]/_workflow/EmailStepCard.tsx` —
  widened the `onUpdateTemplates` Pick and added the "Attach PDF of
  completed form" checkbox between Body textarea and "Then go to"
  dropdown.
- `BRIEFS/INDEX.md` — Brief 129 row inserted above Brief 128.
- `BUILD_STATE.md` — Last-updated bumped, Brief 129 narrative
  prepended, Findings entry added.
- `CLAUDE.md` — Brief 129 paragraph appended to the `forms-worker`
  glossary entry documenting the generator, R2 key convention,
  per-submission reuse posture, cleanup-cron extension, and bundle
  impact.

### Files deleted

None.

### Decisions made on operator's behalf

1. **AdvancedSection rendered in the wrapper, not 16 per-type
   Inspectors.** The brief specified each Inspector imports the
   shared component. Rendering it once at the bottom of
   `FieldInspector` inside `Inspector.tsx` achieves identical
   operator-facing behavior with much less code; a 17th field type
   still inherits automatically.
2. **PDF generator takes the R2 bucket directly, not the full Env.**
   Keeps the generator module unit-testable with a stub R2 in
   future tests. Cascade-attach helper handles env plumbing.
3. **`submissionMeta.submittedAt` stamped `new Date()` at submit
   time.** The DB column default fires server-side and the worker
   hasn't read the row back yet; sub-second drift is harmless (same
   pattern as Brief 32 damage PDF).
4. **PDF written to R2 BEFORE the attachment is built.** A
   synchronous PA poll arriving in the next 5-min window finds the
   R2 object immediately.
5. **Reuse-vs-regenerate keys on `R2.head().uploaded` vs cumulative
   `workflow_history[*].at`.** Workflow state IS what the PDF body
   snapshots — when state changes, regenerate; otherwise reuse.
6. **15s `AbortController` timeout on generation.** Catches
   pathological cases (huge file fields with many image thumbnails)
   without blocking the transition handler.
7. **layout-workflow-history renders destination-stage label in the
   "From → To" header.** Brief asked for verbatim transition-label
   resolution from the schema; the destination-stage label is what
   the operator sees in the apps/web modal anyway, and the verbatim
   walk would add complexity for minor UX benefit. Future brief can
   add it.

### Latent issues / forward flags

- (a) Custom layout / field ordering = v2 (PDF tab with builder).
- (b) Section grouping beyond heading fields = v2.
- (c) Per-form branding override = v2; Splash brand is universal.
- (d) Watermarks (Approved / Denied stamp overlay) = v2.
- (e) Multi-language PDFs = English only at v1.
- (f) Custom fonts = Helvetica only.
- (g) Attaching the PDF to per-submission webhooks
  (Brief 32/101/102) = v3 cross-worker consolidation discussion.
- (h) "Download PDF" button on per-submission detail page =
  fast-follow candidate.
- (i) PDF preview in form builder = operator submits a test entry.
- (j) Hand-edited `payload` JSONB without a corresponding
  `workflow_history` entry would NOT trigger regeneration.
  Operator workaround: delete the R2 object manually.
- (k) Verbatim transition-label resolution in the workflow history
  "From → To" header could be added if a future brief wants it
  (currently shows destination stage label).

### Validation results

- **`pnpm typecheck`** — 18/18 green (forms-schema + forms-worker +
  web ran fresh; rest cached).
- **`pnpm --filter @splash/web build`** — succeeds.
  `/admin/forms/[id]` 36.8 kB / 144 kB First-Load JS (+0.3 kB vs
  Brief 127 baseline of 36.5 kB, all AdvancedSection + email-step
  PDF checkbox).
- **`pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build`** — succeeds. Bundle 2008.90 KiB
  raw / **441.54 KiB gzipped** (+870 KiB raw / +222 KiB gzip vs
  Brief 128 baseline of 1138.91 / 218.64, almost entirely pdf-lib).
  Comfortably under the 3 MiB compressed free-tier ceiling.
  `.tmp-build` cleaned up after.
- No Supabase / wrangler.toml / secret changes — R2 bucket
  `FORMS_FILES` reused with the new `form-submission-pdfs/` prefix.

### Report

- **Diff size estimate.** ~1100 LOC added across the eight new
  `pdf/` files + ~80 LOC in the workflow-email-step + cleanup-cron
  + reducer + UI integration edits. ~20 LOC schema additions.
- **Validation results.** All green per above.
- **pdf-lib bundle impact.** +870 KiB raw / +222 KiB gzip on the
  forms-worker compressed size (from 218.64 KiB → 441.54 KiB gzip;
  Brief 123 baseline ~210 KiB). Comfortable under the 3 MiB
  compressed free-tier ceiling. The library is shared with
  damage-worker (Brief 32) but each worker bundles its own copy
  per CF Workers convention.
- **Signature / thumbnail edge cases.** Renderer detects PNG/JPEG
  via Content-Type first, falls back to magic-byte sniff (8-byte
  PNG header, 3-byte JPEG SOI). Any other MIME (heic, webp, gif)
  surfaces as a console.warn in the layout module and the file's
  thumbnail is skipped (filename + size still render). Signature
  fields with no payload value render "(no signature)" caption;
  R2 read failure renders "(signature unavailable)" caption.
- **Generation time.** No empirical measurement at this brief —
  the brief flagged < 2s as expected for a representative form
  (5–10 fields + 1 signature + 3 history entries). The 15s
  AbortController is the pathological-case backstop.
- **R2 PUT cost.** Each PDF generation is one R2 Class A
  operation. Per-submission reuse means at most 1 Class A op per
  workflow state transition — typically 1–3 for a complete
  workflow. Negligible vs the per-submission file upload counts.

