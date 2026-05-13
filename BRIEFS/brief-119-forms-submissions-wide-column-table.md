# Brief 119: Forms submissions viewer — wide-column table (every answer as a column, no click-through required)

**Status:** Completed (2026-05-13)
**Started:** 2026-05-13
**Completed:** 2026-05-13
**Blocks:** Neither — UX refactor of the existing
`/admin/forms/[id]/submissions` page (Brief 96). Click-through
detail page remains for focused single-submission review.
**Dependencies:** Brief 95 (form builder — owns the
`form_versions.schema` JSONB this brief reads), Brief 96
(submissions admin — owns the page this brief rewrites),
Brief 118 (Forms submissions admin index — entry point).

## Read first

- CLAUDE.md (`forms-worker` glossary entry — especially the
  Brief 96 paragraph)
- BRIEFS/brief-095-forms-builder-admin-ui.md (form schema shape:
  `{ fields: Field[] }` discriminated union in
  `@splash/forms-schema`)
- BRIEFS/brief-096-forms-submissions-admin.md (the page this
  brief rewrites — Outcome section documents current renderer:
  meta-only columns + per-submission detail page)
- BRIEFS/brief-118-forms-submissions-admin-index-and-post-submit-nav.md
  (entry point to this page)
- apps/web/app/admin/forms/[id]/submissions/page.tsx (Brief 96
  list view, current shape)
- apps/web/app/admin/forms/[id]/submissions/[subId]/page.tsx
  (Brief 96 detail page, kept; renderer logic that handles
  per-field-type display is the pattern to lift into the table
  cells)
- packages/forms-schema/src/types.ts (Field discriminated union
  — every field type the table renderer needs to handle)
- apps/forms-worker/src/handlers/submissions-admin.ts (or
  wherever Brief 96 wired its list endpoint — confirm the list
  response already includes `payload` JSONB on each row; if it
  only returns metadata, this brief extends it)

## Context

Brief 96's submissions viewer at `/admin/forms/[id]/submissions`
renders a narrow table (Submitted at / Status / Submitter /
Splash Notes preview / Version / View →) and requires
click-through to `[subId]` for the full payload. For forms with
~5-15 fields, that's a click-per-row to see the data — operator
asked whether the table itself could render every answer field
as a column with the values inline.

Yes, and this is materially easier for form-builder forms than
for JotForm because we own the schema definitively:
`form_versions.schema` stores the published field set as a typed
JSONB blob. We can flatten every field key → a table column,
read each row's `payload[key]`, and dispatch on field type for
display (same pattern as the per-form detail page).

Two design questions to settle in the brief:

**1. Which schema drives the columns?** Past submissions reference
the version they were submitted against; that version's schema
may differ from the form's current version (Brief 96 doc:
"Past submissions render against THEIR version's schema, NOT the
form's current"). Three approaches:

- **(a) Current version's schema** — clean column set, but
  historical submissions whose old version had different fields
  render either as empty cells or with missing data leaking
  through.
- **(b) Schema-union across versions in the date range** — matches
  the Brief 96 CSV export pattern. Every column from every version
  ever in scope appears; cells empty where a row's version didn't
  have that field.
- **(c) Per-version "section" rendering** — group rows by version,
  each group has its own column set. Visually noisy but accurate.

Pick **(b) schema-union** to match the CSV's behavior. It's the
most complete and matches operator's mental model ("show me
everything"). Display-only `heading` and `image` field types
skipped (no value to render).

**2. How wide is too wide?** Forms with 10+ fields produce wide
tables that scroll horizontally. Acceptable on desktop, awkward
on mobile. Default to wide-table view; provide a "compact" toggle
(via URL search param `?view=compact`) that falls back to Brief
96's narrow renderer with click-through detail. Persist the choice
in localStorage for the URL-less default on subsequent visits.

## Scope

### Phase 1 — Worker list endpoint shape (verify, possibly extend)

Confirm `GET /forms/admin/api/forms/{id}/submissions` already
returns the full `payload` JSONB on each row (Brief 96's list
endpoint likely does, but verify before assuming). If it returns
only metadata (status / splash_notes / version_number etc.) and
strips payload to keep responses small, extend the response to
include `payload` when a new `?include=payload` query param is
passed. Default to current shape for back-compat.

Apps/web list page passes `?include=payload` when rendering the
wide view.

### Phase 2 — Schema-union column computation

In the apps/web list page (`apps/web/app/admin/forms/[id]/submissions/page.tsx`),
add a helper that:

1. Fetches all `form_versions` that any submission in the current
   result set references (the worker list endpoint already returns
   each row's `version_id` — extend the response to include the
   per-version schemas if not already there, or fetch them via a
   batch lookup).
2. Computes the **union of field keys** across those schemas.
   Skip `heading` and `image` field types (display-only).
3. Preserves a stable column order: prefer the most recent
   version's field order; append fields-only-in-older-versions
   alphabetically.

Each column carries:
- `key` (the field's `key` from schema)
- `label` (the field's `label`)
- `type` (the discriminator for cell rendering)

### Phase 3 — Wide-table render

Edit the list page's row rendering. New layout:

- Sticky meta columns on the left: Submitted at | Site | Status |
  Splash Notes (truncated to one line, hover for full).
- Then one column per schema-union entry from Phase 2.
- Trailing column: `View →` link to the detail page (kept for
  focused review use cases).

Cell rendering: lift the Brief 96 detail-page renderer's
per-field-type logic into a reusable `<AnswerCell>` component.
Types and their renders:
- text / textarea / email / phone / number → bare string
- single-select / dropdown → selected option's label
- multi-select → comma-joined labels
- date / datetime → formatted display
- signature → small thumbnail (link to detail for full view) via
  the existing signature serve route (`/forms/admin/api/files/{r2_key}`
  per Brief 92)
- file / file-upload → thumbnail grid for image MIMEs, file-name
  link for everything else (same serve route)
- lookup → display the resolved value (Brief 93's resolution
  surface)
- For any field type not in the row's payload (schema-union case),
  render `—` muted.

Sticky header row + sticky first column so operators can scroll
horizontally through wide tables without losing position.

The table itself is wrapped in `<div className="overflow-x-auto">`
with a min-width on the table. Long text columns (textarea) truncate
to a fixed character count with hover-tooltip showing the full value.

### Phase 4 — Compact view fallback

Add a view-mode toggle:

- URL search param `?view=wide` (default) or `?view=compact`.
- localStorage: persist last choice as `forms.submissions.view`.
- Toggle UI: button group at the top of the page,
  "Wide table | Compact". Active state styled.
- Compact view: Brief 96's original meta-only renderer + click-
  through. Useful on mobile / when the wide table is overwhelming.

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass.
5.2 `pnpm --filter @splash/web build` — must succeed.
5.3 `pnpm --filter @splash/forms-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed (only if
    Phase 1 required a worker change); clean up after.
5.4 No Supabase / R2 / wrangler.toml / secret changes.
5.5 Operator post-deploy smoke (deferred):
    - Load `/admin/forms/{id}/submissions` as super_admin → wide
      table renders with all fields as columns. Each row shows
      values inline. Scroll horizontally if the schema is wide.
    - Toggle to Compact → narrow meta-only table, click-through
      detail.
    - Toggle back to Wide → wide returns. Reload the page →
      localStorage preserves the choice.
    - Visit a form whose old submissions used a different version
      (different field set) → schema-union columns visible, older
      rows show `—` in columns that didn't exist on their version.
    - Submit a NEW row (publish a draft with one extra field, fill
      out a fresh submission) → new column appears in the union
      automatically.
    - Detail page (click View →) still works for focused per-row
      review.

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md: Brief 119 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
  - Brief 119 (YYYY-MM-DD) — forms-builder submissions viewer
    now defaults to wide-column table (one column per schema-union
    field across versions in scope); compact view available via
    `?view=compact` URL param + localStorage. Detail page kept
    for focused per-submission review.
  - Pattern: when the form schema is known (form-builder),
    flatten to wide table. JotForm viewer stays with per-form
    column packs because JotForm schemas aren't owned in
    Supabase — they live in JotForm Enterprise's API.

6.3 CLAUDE.md `forms-worker` glossary entry: append a line noting
the wide-table viewer + the compact fallback option.

## Out of scope

- JotForm viewer rewrite (different data model, different scope).
- Per-column sort / filter on the wide table. v2 polish; the
  date range + scoping handle the core filtering.
- CSV export changes. Brief 96's CSV already does schema-union;
  no change.
- Column reordering or hide/show toggles per operator. v2.
- Editing submission payloads in-place from the wide table. The
  detail page is the edit surface for status / splash_notes
  (Brief 96); payload itself isn't editable from apps/web.
- Per-form schema-aware editing or override. v2.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `/admin/forms/[id]/submissions` default render is the wide table
  with every schema-union field as a column.
- `?view=compact` URL param OR localStorage `forms.submissions.view
  === "compact"` falls back to Brief 96's narrow renderer.
- Worker list endpoint returns full `payload` JSONB (via `?include=payload`
  param if extended, or natively if already there) and per-row
  `version_id` for schema lookup.
- Sticky meta columns + sticky header. Long-text truncation with
  hover-tooltip.
- Per-field-type rendering matches the detail page's existing
  logic (lifted to a shared `<AnswerCell>` component).
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 6.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (estimate: ~250 LOC for the table renderer +
  `<AnswerCell>` extraction, maybe ~30 LOC of worker changes if
  the list endpoint needed extending, plus doc rows).
- Validation results.
- Whether the worker list endpoint already returned `payload` or
  needed the `?include=payload` extension.
- Whether the schema-union computation needs a separate batch
  worker query for `form_versions.schema` per row's `version_id`,
  or whether the existing list endpoint already embeds the schema.
- Any forms whose schema has 20+ fields where the wide table
  becomes unreadable even on desktop (would suggest needing a
  column-visibility selector in v2).

## Outcome

### Files created
- `apps/web/app/admin/forms/[id]/submissions/_components/AnswerCell.tsx`
  (~165 LOC; per-field-type cell renderer with compact truncation and
  inline thumbnails)
- `apps/web/app/admin/forms/[id]/submissions/_components/ViewToggle.tsx`
  (~80 LOC; client island writing `forms.submissions.view` to
  localStorage and `router.push(?view=...)`)
- `apps/web/app/admin/forms/[id]/submissions/_lib/schema-union.ts`
  (~55 LOC; `computeSchemaUnion(items)` returns ordered `AnswerColumn[]`)

### Files modified
- `apps/forms-worker/src/db/admin-submissions.ts` — `SubmissionListItem`
  widened with optional `payload` / `splash_notes` / `form_version_id`
  / `version` fields; new `SubmissionListVersion` exported type;
  `ListSubmissionsArgs.includePayload` opt threaded through;
  `listSubmissions` branches on the opt to widen the PostgREST select
  and the row mapping (new internal `ListSubmissionWithPayloadDbRow`).
- `apps/forms-worker/src/admin/submissions.ts` — `handleListSubmissions`
  reads `url.searchParams.get("include") === "payload"` and forwards
  to `listSubmissions`.
- `apps/web/app/admin/forms/_lib/worker-fetch.ts` — `SubmissionListItem`
  + new `SubmissionListVersion` type exported; `ListSubmissionsParams`
  gains an `include?: "payload"` field that serializes to the qs.
- `apps/web/app/admin/forms/[id]/submissions/page.tsx` — rewrite. Wide
  view is the default; `ViewToggle` toggles to `?view=compact` (and
  back). Wide view calls `listSubmissionsAdmin(..., { include:
  "payload" })`, computes `computeSchemaUnion(items)`, renders sticky-
  header / sticky-first-column overflow-x-auto table with meta columns
  on the left (Submitted / Status / Submitter / Splash Notes / Version),
  schema-union answer columns in the middle, and trailing `View →`
  link. Compact view (`CompactSubmissionsTable` sub-component) is a
  verbatim port of Brief 96's narrow renderer. Cells outside a row's
  own version schema render a muted `—` with hover-tooltip noting
  which version was used.
- `BRIEFS/INDEX.md` — Brief 119 row inserted above Brief 118.
- `BUILD_STATE.md` — Last-updated bumped to 2026-05-13; new Findings
  entry for Brief 119.
- `CLAUDE.md` — `forms-worker` glossary entry gains a Brief 119
  paragraph documenting the wide-column viewer + `?view=compact`
  fallback + `?include=payload` worker contract.
- `BRIEFS/brief-119-forms-submissions-wide-column-table.md` —
  Status flipped to Completed; Outcome filled in.

### Decisions made on operator's behalf

1. **Schema-union approach is option (b)** per the brief — matches the
   Brief 96 CSV export's behavior and "show me everything" mental
   model. Column order: most-recent-version's fields in schema order,
   then older-version-only fields appended alphabetically by key.
2. **Worker `?include=payload` is opt-in** rather than always-on. The
   payload column makes the response materially larger, and Brief 96's
   metadata-only shape is the right back-compat default for any caller
   that doesn't need the wide-table data. apps/web's compact-view
   branch DOES NOT pass `include=payload` — it stays on the smaller
   shape.
3. **Sticky meta columns** are Submitted / Status / Submitter /
   Splash Notes / Version (Brief 96's columns). The brief mentioned
   "Site" as a meta column, but forms don't all have a Site field; a
   `location` field in the schema surfaces as one of the dynamic
   answer columns automatically. Kept Brief 96's meta surface verbatim
   to minimize surprise.
4. **AnswerCell is a NEW shared component, not a refactor of
   PayloadRenderer.** The brief suggested "lift the per-field-type
   logic into a shared component"; in practice the detail-page
   renderer has a richer, full-width-friendly UI worth preserving for
   focused review. The cell variant is intentionally compact (80-char
   truncation, smaller thumbnails, lookup drops the "(resolved from
   X)" annotation). Future v2 candidate: consolidate by adding a
   `variant` prop. Detail page is untouched.
5. **Wide view max-width opens to 1600 px** (vs Brief 96's 1100 px).
   The table still scrolls horizontally within its container when
   schema-union columns exceed that. Compact view keeps the prior
   max-width.
6. **localStorage persistence is a UX nicety, not load-bearing.** When
   localStorage is unavailable (private browsing), the URL param still
   works and the page defaults to wide.
7. **Page max-width for compact view stays narrow** (`max-w-[1100px]`)
   to preserve Brief 96's visual identity for that fallback.
8. **File/signature thumbnails read `r2_key` from the payload itself**
   rather than via a separate `form_submission_files` join — Brief 92
   enriches the submit payload with `r2_key` / `mime` / `size_bytes` /
   `original_filename`, so the table view has everything it needs
   without an extra DB hop. Hand-edited payloads that lack those keys
   render as muted dashes in the table; the detail page's
   PayloadRenderer can still resolve them via the files-table join.

### Latent issues / forward flags

- **Forms with 20+ fields** produce wide-table widths > 2500 px even
  on desktop. The compact fallback is the operator-driven escape
  hatch; a column-visibility selector is a v2 candidate.
- **Per-column sort / filter** on the wide table is a v2 candidate.
  The existing DateRangePicker + status/submitter filters handle the
  core filtering.
- **Schema-drift `—` cells** could be ambiguous to operators ("empty
  or wasn't this field collected?"). The hover-tooltip surfaces
  "Not part of v{N} schema" — sufficient for now.
- **Response-size bloat with `?include=payload`** is real but not
  alarming at v1 (200 rows × moderate schemas stays well under 1 MB).
  Worth watching as forms with many long-text + signature fields
  arrive.
- **Lookup fields in the cell drop the "(resolved from X)" annotation**
  the detail page carries. Operators relying on knowing the lookup
  source must click through.
- **Image-heavy tables** trigger many `<img>` fetches against the R2
  serve route on initial render. v2 candidate: explicit `loading="lazy"`
  on the thumbnails (browsers default to lazy in many cases).

### Validation results

- **`pnpm typecheck`** — 18 / 18 packages green. forms-worker + web
  re-ran fresh post-edit; cached for other packages.
- **`pnpm --filter @splash/web build`** — succeeded.
  `/admin/forms/[id]/submissions` 1.64 kB / 107 kB First Load JS
  (adds the `ViewToggle` client island over Brief 96's 924 B baseline).
- **`pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build`** — succeeded. Bundle 1055.04 KiB raw /
  201.25 KiB gzipped (≈ +1 KiB vs Brief 118 baseline — accounts for
  the wider PostgREST select + the include=payload branch in
  admin-submissions.ts). `.tmp-build` cleaned up after.
- **No Supabase / R2 / wrangler.toml / secret changes.**

### Diff size

~250 LOC across the apps/web side (page rewrite + three new
components/helpers), ~50 LOC of worker changes (widened
`listSubmissions` + new `?include=payload` handler branch), plus
documentation rows in BRIEFS/INDEX.md, BUILD_STATE.md, and CLAUDE.md.

### Operator post-deploy smoke (deferred)

1. `/admin/forms/{id}/submissions` as super_admin → wide table renders
   with all fields as columns; row values inline; scrolls horizontally
   if the schema is wide.
2. Toggle to Compact → narrow meta-only table, click-through detail
   (Brief 96 prior behavior).
3. Toggle back to Wide → wide returns. Reload → localStorage preserves
   the choice.
4. Visit a form whose old submissions used a different version → schema-
   union columns visible, older rows show `—` in columns that didn't
   exist on their version; tooltip says "Not part of v{N} schema".
5. Publish a draft with one extra field, submit a new row → new column
   appears in the union automatically.
6. Detail page (click `View →`) still works for focused per-row review.
