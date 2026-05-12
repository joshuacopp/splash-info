# Brief 112: JotForm viewer — content polish (time-card-edit columns + detail page renderer)

**Status:** Completed (2026-05-12)
**Started:** 2026-05-12
**Completed:** 2026-05-12
**Blocks:** Neither — UX polish on top of Briefs 109 / 110 / 111.
The list page works today; this brief makes it useful for the
fourth form (time-card-edit) and rewrites the detail page renderer
so per-submission content reads naturally instead of as JSON dumps.
**Dependencies:** Brief 111 (per-form column registry — extends
the same `form-columns.tsx` here). Brief 109 (detail page
generic renderer — overwritten here).

## Read first

- CLAUDE.md (esp. **JotForm submissions** glossary entry — adds a
  paragraph here for Brief 112)
- BRIEFS/brief-109-apps-web-jotform-viewer.md (detail page
  current state — alphabetical-key generic renderer)
- BRIEFS/brief-111-jotform-viewer-per-form-columns-and-est-and-location-pretty.md
  (the `form-columns.tsx` registry that gets a new entry here +
  the `formatEst` helper this brief reuses)
- apps/web/app/admin/jotform/[form_id]/[submission_id]/page.tsx
  (current detail page — the renderer this brief rewrites)
- apps/web/app/admin/jotform/[form_id]/_lib/form-columns.tsx
  (registry — adds the time-card-edit entry)
- Sample JotForm payloads (live in `jotform_submissions`):
  - Rewash answer types observed: `control_datetime`,
    `control_dropdown`, `control_textbox`, `control_signature`,
    `control_fileupload`, `control_number`, `control_widget` (typeA),
    `control_fullname`, `control_email`, `control_phone`
  - Retention: `control_fullname` (with prettyFormat),
    `control_widget`, `control_textbox`, `control_radio`,
    `control_textarea`, `control_email`, `control_phone`,
    `control_datetime`, `control_signature`
  - Salt log: `control_datetime`, `control_number`,
    `control_checkbox` (with prettyFormat), `control_fullname`,
    `control_widget`, `control_textbox`
  - Time-card-edit: `control_dropdown`, `control_fullname` (×3),
    `control_radio`, `control_datetime` (×20+, mostly empty),
    `control_signature` (×2), `control_email`, `control_widget`,
    `control_textbox`

## Context

The 2026-05-11 operator review post-Brief-111 surfaced two
concrete asks:

1. **Time-card-edit columns** weren't specified in Brief 111 and
   so the form falls back to `DEFAULT_COLUMNS` (Submitted | Site).
   With the sample payload in hand the useful columns are:
   `Submitted | Site | Employee Name | Reason For Edit |
   Manager Making Edits`. The form is dominated by punch-in/out
   timestamps (10-19 for PTO days, 6-9 + 22-26 for corrections);
   those don't belong in a list view — they're detail-page content.

2. **Detail page reads as a JSON dump.** The Brief 109 renderer
   iterates `Object.keys(row.answers)` alphabetically and renders
   value with a coarse `typeof object → JSON.stringify` fallback.
   On a rewash form that means `{day, min, ampm, hour, year, month,
   datetime, timeInput}` dumps for the date field, signature URLs
   render as raw text, and the PTO Day 2-5 fields on time-card-edit
   spam the page with empty entries. With sample data in hand we
   can dispatch per `type` field and render meaningfully:

   - `control_fullname` → prefer `prettyFormat` ("Scott Zufall")
   - `control_datetime` → prefer `prettyFormat` ("05-11-2026 05:51 PM")
   - `control_phone` → prefer `prettyFormat` ("(607) 426-4243")
   - `control_signature` → `<img>` inline (the answer is a JotForm
     CDN URL like `https://splashcarwashes.jotform.com/uploads/...`)
   - `control_checkbox` → `prettyFormat` (already joined)
   - `control_fileupload` → image gallery if `answer` is a non-empty
     array of URLs; skip otherwise
   - `control_widget` (typeA) / `control_textbox` /
     `control_textarea` / `control_radio` / `control_dropdown` /
     `control_email` / `control_number` → render the `answer`
     string verbatim
   - Sort by the `order` field (form-builder display order), not
     alphabetical key
   - Skip entries with empty/null `answer` entirely — these forms
     have many optional fields and `—` em-dash spam degrades
     readability

3. Brief 111 confirmed timestamps are UTC at the storage layer
   (sample shows `"jotform_created_at": "2026-05-11T17:53:31+00:00"`
   — explicit `+00:00`), so option (a) from that brief stands. The
   detail page should also use `formatEst()` for its timestamp,
   matching the list page.

Per-form facet filters (filter by Rewash Reason / Reason For
Cancellation / Areas / Reason For Edit) are NOT in this brief —
they require worker-side filter param support + per-form whitelist
of filterable keys. Deferred to Brief 113 once Brief 112's polish
lands and gets some real operator use.

## Scope

### Phase 1 — Time-card-edit per-form columns

Edit `apps/web/app/admin/jotform/[form_id]/_lib/form-columns.tsx`.
Replace the existing time-card-edit entry (`[submittedColumn(),
siteColumn()]`) with:

```ts
// Time card edit
"250193775451056": [
  submittedColumn(),
  siteColumn(),
  answerColumn("4", "Employee Name"),
  answerColumn("5", "Reason For Edit"),
  answerColumn("28", "Manager Making Edits")
]
```

Sample-row mapping (from 2026-05-11 operator-provided payload):
- Key 4: `name: "employeeName"`, `text: "Employee Name"`,
  `type: "control_fullname"`, has prettyFormat ("Khamren Chanthavong")
- Key 5: `name: "reasonFor"`, `text: "Reason For Edit"`,
  `type: "control_radio"`, answer "PTO"
- Key 28: `name: "managerMaking"`, `text: "Manager Making Edits"`,
  `type: "control_fullname"`, has prettyFormat ("Dylan Donovan")

`answerColumn`'s existing `prettyFormat → answer → ""` chain
handles all three correctly — fullname keys render prettyFormat,
radio renders the bare answer string.

### Phase 2 — Detail page renderer rewrite

Rewrite the answer-map renderer in
`apps/web/app/admin/jotform/[form_id]/[submission_id]/page.tsx`.
Replace the alphabetical-key generic loop with a type-dispatched
renderer.

2.1 Add helpers to a new module
`apps/web/app/admin/jotform/[form_id]/[submission_id]/_lib/answer-renderer.tsx`:

```ts
import type React from "react";

interface AnswerEntry {
  name?: string;
  text?: string;
  type?: string;
  order?: string | number;
  answer?: unknown;
  prettyFormat?: string;
}

/**
 * Decide whether a given answer entry has content worth rendering.
 * Used to filter out the many optional fields (especially on
 * time-card-edit) that would otherwise spam the page with empty rows.
 */
export function hasContent(entry: AnswerEntry): boolean {
  if (typeof entry.prettyFormat === "string" && entry.prettyFormat.trim()) {
    return true;
  }
  const a = entry.answer;
  if (a == null) return false;
  if (typeof a === "string") return a.trim().length > 0;
  if (typeof a === "number" || typeof a === "boolean") return true;
  if (Array.isArray(a)) return a.length > 0;
  if (typeof a === "object") return Object.keys(a).length > 0;
  return false;
}

/**
 * Return a stable display-order key for an answer entry. Prefer the
 * JotForm builder's `order` field (form-display order); fall back to
 * the answer-key string. Order is a stringified integer in payloads —
 * parse to number so 2 < 10.
 */
export function orderKey(entry: AnswerEntry, fallbackKey: string): number {
  const o = entry.order;
  if (typeof o === "number") return o;
  if (typeof o === "string" && /^\d+$/.test(o)) return Number.parseInt(o, 10);
  // Fallback: sort answer-key-string lexicographically (rare path).
  const k = Number.parseInt(fallbackKey, 10);
  return Number.isFinite(k) ? k + 100000 : 100000;
}

/**
 * Type-dispatched value renderer. Returns a React node for the value
 * portion of the {label, value} pair. Callers handle the label themselves
 * (entry.text || entry.name || fallbackKey).
 */
export function renderAnswerValue(entry: AnswerEntry): React.ReactNode {
  // Prefer prettyFormat across the board when available.
  const pretty = typeof entry.prettyFormat === "string"
    ? entry.prettyFormat.trim()
    : "";

  switch (entry.type) {
    case "control_signature": {
      // answer is a JotForm CDN URL string for signed forms.
      const url = typeof entry.answer === "string" ? entry.answer.trim() : "";
      if (!url) return null;
      return (
        <img
          src={url}
          alt="Signature"
          className="max-w-xs border border-splash-navy/20 bg-white p-1"
        />
      );
    }
    case "control_fileupload": {
      // answer is an array of CDN URLs; render as a thumbnail grid.
      const items = Array.isArray(entry.answer)
        ? (entry.answer as unknown[]).filter(
            (x): x is string => typeof x === "string" && x.startsWith("http")
          )
        : [];
      if (items.length === 0) return null;
      return (
        <div className="flex flex-wrap gap-2">
          {items.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">
              <img
                src={url}
                alt="Upload"
                className="h-24 w-24 object-cover border border-splash-navy/20"
              />
            </a>
          ))}
        </div>
      );
    }
    case "control_fullname":
    case "control_datetime":
    case "control_phone":
    case "control_checkbox":
      // These all have prettyFormat that's the right surface.
      if (pretty) return <span>{pretty}</span>;
      // Fall through to generic answer rendering when prettyFormat missing.
      break;
    default:
      // textbox / textarea / radio / dropdown / email / number /
      // widget / others → render the bare answer string.
      break;
  }

  const a = entry.answer;
  if (typeof a === "string") {
    return <span className="whitespace-pre-wrap break-words">{a}</span>;
  }
  if (typeof a === "number" || typeof a === "boolean") {
    return <span>{String(a)}</span>;
  }
  if (a != null && typeof a === "object") {
    // Last-resort fallback (rare; most object shapes get caught above).
    return (
      <pre className="text-xs whitespace-pre-wrap break-words text-splash-navy/70">
        {JSON.stringify(a, null, 2)}
      </pre>
    );
  }
  return null;
}
```

2.2 In `page.tsx` (the detail page), replace the existing answer
loop with:

```tsx
const entries = Object.entries(row.answers as Record<string, AnswerEntry>)
  .filter(([, entry]) => hasContent(entry))
  .map(([key, entry]) => ({ key, entry, order: orderKey(entry, key) }))
  .sort((a, b) => a.order - b.order);

return (
  <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
    {entries.map(({ key, entry }) => (
      <Fragment key={key}>
        <dt className="font-medium text-splash-navy/70">
          {entry.text || entry.name || `Field ${key}`}
        </dt>
        <dd className="text-splash-navy">
          {renderAnswerValue(entry)}
        </dd>
      </Fragment>
    ))}
  </dl>
);
```

2.3 Also swap the metadata block's timestamp displays to `formatEst()`
(Brief 111's helper) so the detail page matches the list page. The
current code uses browser-local format (`new Date().toLocaleString()`
or similar — check current implementation). Switch to:

```tsx
const submittedAt = formatEst(row.jotform_created_at);
<span title={submittedAt.absolute}>{submittedAt.relative}</span>
```

The "Raw JSON" expandable `<details>` (if Brief 109's executor
added one) stays as-is — useful debugging surface, intentionally
collapsed by default.

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass.
3.2 `pnpm --filter @splash/web build` — must succeed.
3.3 No worker change. No Supabase / R2 / wrangler.toml / secret
    changes.
3.4 Operator post-deploy smoke (deferred):
    - Load `/admin/jotform/250193775451056` → list page columns
      show Submitted (EST) | Site | Employee Name |
      Reason For Edit | Manager Making Edits.
    - Click any time-card-edit row → detail page renders fields
      in JotForm-builder order, employee name renders as the
      prettyFormat ("Khamren Chanthavong" not the
      `{first, last}` object), datetime fields render
      "04-23-2026 12:00 PM", PTO Day 2-5 empty fields are absent
      (not em-dashes).
    - Open a rewash detail → signature renders as inline image
      (manager signature + employee wash signature), not as a
      raw URL string.
    - Open a retention detail → fields render in order:
      Site Number (key 4, order 2), Site (key 6, order 15),
      Customer Name (key 3, order 5), etc. — operator should
      see a coherent form-shaped page, not alphabetical chaos.
    - Detail page timestamps in EST matching the list page.

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 112 row appended.

4.2 BUILD_STATE.md: Findings entry noting:
  - Brief 112 (YYYY-MM-DD) — JotForm viewer detail page rewritten
    with type-dispatched renderer (signatures inline as images,
    fullname/datetime/phone/checkbox preferring prettyFormat,
    file-upload as thumbnail grid, empty fields hidden, sorted
    by JotForm builder `order`). Time-card-edit per-form columns
    landed (Employee Name | Reason For Edit | Manager Making Edits).

4.3 CLAUDE.md "JotForm submissions" glossary entry: append a
one-liner noting Brief 112 — detail page renderer dispatches on
`answers[KEY].type` and sorts by `answers[KEY].order`; signatures
render inline as images, file uploads render as a thumbnail grid;
empty answers are skipped, not em-dashed.

## Out of scope

- Per-form facet filters (filter by Rewash Reason, Reason For
  Cancellation, Areas Ice Melt Applied, Reason For Edit). Worker-
  side support required (new query param + per-form filterable-key
  whitelist + intersect with accessibleSiteNumbersForSession).
  Deferred to Brief 113 once Brief 112's polish gets operator
  validation.
- Per-form CSV column packs. CSV currently schema-unions all answer
  keys across the date range; operators dump to spreadsheet and
  filter columns there. v2 candidate.
- Column label shortening (e.g., "Pounds of Ice Melt Used" →
  "Lbs Ice Melt", "Action Being Taken" → "Action"). Out of scope
  here — labels render fine; operator can react to actual usage
  before deciding on shorter forms.
- Group-by-section rendering. JotForm form definitions have page
  breaks (`control_pagebreak`) that get stripped at ingest per
  Brief 107's noise-strip rules. Reconstructing sections would
  require re-ingest or a separate JotForm API call. Out of scope.
- Time-card-edit list-page column showing PTO day count (key 21).
  The 5-line per-row table is enough at v1. v2 candidate if
  operators flag it.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/web/app/admin/jotform/[form_id]/_lib/form-columns.tsx`
  time-card-edit entry contains the three new `answerColumn` calls
  (keys 4, 5, 28 with labels "Employee Name", "Reason For Edit",
  "Manager Making Edits").
- `apps/web/app/admin/jotform/[form_id]/[submission_id]/_lib/answer-renderer.tsx`
  exists with `hasContent`, `orderKey`, `renderAnswerValue`.
- `apps/web/app/admin/jotform/[form_id]/[submission_id]/page.tsx`
  renders entries via the new renderer, sorted by `order`, with
  empty entries filtered.
- Detail-page metadata block uses `formatEst()` from Brief 111.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 4.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (estimate: ~250 LOC for the new answer-renderer module
  + ~30 LOC delta on page.tsx + 5 lines on form-columns.tsx; plus
  doc rows).
- Validation results.
- Any answer types observed in production that the type-dispatch
  switch didn't handle gracefully (would suggest extending the
  switch in a v2 brief). Specifically check signatures (control_signature)
  on rewash + retention + time-card-edit detail pages render as
  inline images; flag if any URL shapes failed to render.
- Confirm `formatEst()` is now used for the detail-page submitted-at
  timestamp + relative caption.

## Outcome

### Files created

- `apps/web/app/admin/jotform/[form_id]/[submission_id]/_lib/answer-renderer.tsx`
  (~125 LOC) — exports `AnswerEntry` interface + three pure helpers
  (`hasContent` / `orderKey` / `renderAnswerValue`). Type-dispatched
  switch on `entry.type` with explicit cases for `control_signature`
  (inline `<img>`), `control_fileupload` (thumbnail grid), and the
  prettyFormat-preferring quartet (`control_fullname` /
  `control_datetime` / `control_phone` / `control_checkbox`); default
  branch renders the bare `answer` string covering the remaining
  observed types (textbox / textarea / radio / dropdown / email /
  number / widget). No React state; pure functions over a typed shape.
  No client island — the module is consumed by a server component.

### Files modified

- `apps/web/app/admin/jotform/[form_id]/_lib/form-columns.tsx` —
  time-card-edit registry entry expanded from `[submittedColumn(),
  siteColumn()]` to five columns: Submitted | Site | Employee Name
  (key 4 `control_fullname`) | Reason For Edit (key 5 `control_radio`)
  | Manager Making Edits (key 28 `control_fullname`). Mapping verbatim
  from the brief's Phase 1.
- `apps/web/app/admin/jotform/[form_id]/[submission_id]/page.tsx` —
  header docblock extended with the Brief 112 paragraph; imports
  swapped (`Fragment` not used; `JotformSubmissionRow` named import
  removed; `formatEst` from `../../_lib/format-est` added; renderer
  helpers imported from `./_lib/answer-renderer`); the alphabetical-
  key `<dl>` loop replaced with
  `Object.entries(answers).filter(hasContent).map(orderKey).sort()`
  feeding a type-dispatched render via `renderAnswerValue(entry)`;
  metadata block's "Submitted at" + "Updated at" rows + under-title
  timestamp swapped to `formatEst()`; local `formatAbsolute` /
  `formatRelative` helpers removed; the `<AnswerValue>` component
  removed; section header parenthetical dropped the ", alphabetical"
  suffix.
- `CLAUDE.md` — "JotForm submissions" glossary entry gains a Brief 112
  paragraph describing the type-dispatched renderer + the
  time-card-edit per-form column expansion.
- `BRIEFS/INDEX.md` — Brief 112 row inserted above Brief 111.
- `BUILD_STATE.md` — Last-updated bumped to 2026-05-12; new Findings
  & decisions log entry at top with full Brief 112 summary; previous
  Brief 111 entry preserved in the "Previously:" chain.
- `BRIEFS/QUEUE.md` — Brief 112 line commented with completion date.
- `BRIEFS/brief-112-jotform-viewer-content-polish.md` — this file
  (Status → Completed (2026-05-12); Outcome filled in).

### Decisions made on operator's behalf

1. **Verbatim keys + labels per the brief.** The brief's Phase 1
   mapping already specified the three time-card-edit answer-key
   mappings (4 / 5 / 28) from a 2026-05-11 sample-payload review.
   No Supabase lookup was required, in contrast to Brief 111's
   headless-blocked per-form label placeholders.

2. **`<div>` grid-row pattern over `<Fragment>` in the answers
   render.** The brief's sample used `<Fragment key={key}><dt /><dd
   /></Fragment>` directly under `<dl>`. The Metadata section
   above uses a `<div className="grid grid-cols-1 ...
   sm:grid-cols-[200px_1fr]">` wrapper per row. I matched the
   existing pattern for visual consistency and fewer imports
   (`Fragment` not needed).

3. **`JotformSubmissionRow` named import removed.** It was unused
   after dropping `sortedAnswerKeys` and the local `<AnswerValue>`
   component; the row's `answers` field accessor uses an inline
   `as Record<string, AnswerEntry>` cast.

4. **`control_fullname` etc. without `prettyFormat` falls through to
   the generic answer renderer.** The brief said "Fall through to
   generic answer rendering when prettyFormat missing" inside the
   prettyFormat-preferring case block — defensive against any rare
   JotForm omission of the precomputed pretty surface.

5. **`control_widget` (typeA — site number) handled by the default
   branch.** The brief listed it under the default-branch types but
   didn't add an explicit case. The site number is already surfaced
   separately in the Metadata block as `row.site_number`, so the
   answers-map entry is redundant; rendering it as a bare string
   keeps the page coherent without special-casing.

6. **`hasContent` filter applied BEFORE the sort.** Cheaper than
   filtering after, and the brief's sample chain explicitly placed
   `.filter` before `.map`/`.sort`.

7. **`em()` for the missing-timestamp branches retained the existing
   `text-splash-navy/40` muted style.** Brief 109 already used this
   helper; reusing it keeps the metadata block consistent with the
   pre-existing visual language.

### Latent issues / forward flags

- **Signature image hot-linking.** `<img src={url}>` for
  `control_signature` loads directly from JotForm's CDN
  (`https://splashcarwashes.jotform.com/uploads/...`). If JotForm
  restricts hot-linking by Origin (or applies a per-org auth gate),
  the images won't render in apps/web. The brief's Phase 3.4 already
  flags this as an operator verification step: open a rewash detail,
  confirm signatures render inline.
- **File-upload thumbnails open the JotForm CDN URL in a new tab.**
  Same auth-gate caveat as signatures. None of the observed sample
  forms have non-empty `control_fileupload` entries today, so the
  thumbnail-grid render path is exercised lazily.
- **Per-form facet filters deferred to Brief 113.** Filtering by
  Rewash Reason / Reason For Cancellation / Areas / Reason For Edit
  requires worker-side filter param support + per-form
  filterable-key whitelist + intersect with
  `accessibleSiteNumbersForSession`.
- **Form-specific section grouping not feasible at this layer.**
  JotForm's `control_pagebreak` entries get stripped at ingest per
  Brief 107's noise-strip rules; reconstructing sections would
  require re-ingest with a section-preservation pass, or a separate
  JotForm API call to fetch the form definition.
- **Column-label shortening (e.g., "Pounds of Ice Melt Used" → "Lbs
  Ice Melt") deferred.** Labels render fine; operator can react to
  actual usage before deciding on shorter forms.
- **Time-card-edit PTO-day-count column (key 21)** is a v2
  candidate if operators flag it. Current five-column row is
  enough at v1.

### Validation

- `pnpm typecheck` — 18/18 green. Only `@splash/web` ran fresh
  (~17 cache hits on sibling packages).
- `pnpm --filter @splash/web build` — succeeded.
  - `/admin/jotform/[form_id]/[submission_id]` — 172 B route-
    specific / 105 kB First-Load JS. **Unchanged vs Brief 111
    baseline** — the detail page is fully server-rendered; the new
    `answer-renderer.tsx` module is consumed by a server component
    so it never ends up in a client bundle.
  - `/admin/jotform/[form_id]` — 1.61 kB route-specific / 107 kB
    First-Load JS. **Unchanged vs Brief 111 baseline.**
- No worker / Supabase / R2 / wrangler.toml / secret changes.
- No headless deploy attempted, per CLAUDE.md.

### Report — Brief's `## Report` items

- **Diff size.** ~125 LOC for the new `answer-renderer.tsx` + ~80
  LOC delta on `page.tsx` (renderer block swap + metadata
  timestamp swap + dropped helpers) + 8 LOC delta on
  `form-columns.tsx` (time-card-edit entry expansion). Doc rows
  (CLAUDE.md / INDEX.md / BUILD_STATE.md / brief / QUEUE.md) on
  top.
- **Answer types observed that the type-dispatch switch didn't
  handle gracefully.** None at write-time, but the renderer's
  default branch covers every observed `control_*` type. Two
  branches are exercised lazily and need operator verification on
  live data: (a) `control_signature` — `<img>` rendering depends on
  JotForm CDN allowing hot-linking from the splash apps/web origin;
  (b) `control_fileupload` — none of the four onboarded forms have
  non-empty file uploads in the sample data, so the thumbnail-grid
  render path will exercise on the first live submission with a
  file. The brief's Phase 3.4 operator smoke tests cover both.
- **`formatEst()` is now used for the detail-page submitted-at
  timestamp + relative caption.** Confirmed — the under-title
  caption + the "Submitted at" + "Updated at" metadata rows all
  flow through `formatEst()`. Local `formatAbsolute` /
  `formatRelative` helpers were removed from `page.tsx`. The
  under-title caption renders `{absolute} · {relative}` matching
  the brief's example shape (with `title={absolute}` on the
  surrounding `<span>` for hover-on-precise-time).
