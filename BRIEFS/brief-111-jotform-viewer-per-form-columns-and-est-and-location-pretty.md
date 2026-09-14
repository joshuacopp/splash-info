# Brief 111: JotForm viewer — per-form columns + EST timestamps + location_pretty dropdown

**Status:** Completed (2026-05-11)
**Started:** 2026-05-11
**Completed:** 2026-05-11
**Blocks:** Neither — UI polish on top of Briefs 109 + 110. The
generic columns shipped in Brief 109 are usable but uninformative
for operators (e.g., "Status: active" carries no signal for these
forms); the EST display ask aligns the timestamps with operator
expectations; the location dropdown fix is a one-field correction.
**Dependencies:** Brief 109 (viewer foundation), Brief 110
(FilterBar + grouped rendering + roster endpoint).

## Read first

- CLAUDE.md (esp. **JotForm submissions**, **jotform-worker**
  glossary entries — Brief 107's normalize comment notes the
  timestamp posture is a v2 fix; this brief is that v2 fix)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-109-apps-web-jotform-viewer.md (Outcome section —
  the row-table column shape this brief overwrites)
- BRIEFS/brief-110-jotform-viewer-filters-and-grouping.md
  (Outcome section — the FilterBar + LocationPicker shape this
  brief touches)
- apps/jotform-worker/src/normalize.js (`parseJotformDate`
  function — currently treats JotForm's `"YYYY-MM-DD HH:MM:SS"`
  as UTC; verify whether JotForm Enterprise is actually storing
  UTC or EST before changing display logic)
- apps/web/app/admin/jotform/[form_id]/page.tsx (current
  flat-table renderer that this brief rewrites)
- Sample rows in Supabase for each of the four forms:
  ```sql
  SELECT id, jotform_created_at, answers
  FROM jotform_submissions
  WHERE form_id = '250165655616055' -- rewash
  ORDER BY jotform_created_at DESC LIMIT 1;
  ```
  Repeat for each form_id. Use these to discover the per-form
  answer keys + their `text` labels.

## Context

Operator review on the Brief 109 + 110 viewer flagged three issues:

1. **Status column is useless for these four forms.** Every row's
   `jotform_status` is `"ACTIVE"`. JotForm uses `jotform_status` to
   distinguish active vs deleted submissions; for an admin viewer
   we only render ACTIVE ones anyway (deleted ones don't ingest).
   Drop the column entirely.

2. **Timestamps display as UTC.** Per Brief 107's normalize comment:
   "Treats the input as UTC for v1 — the operator's sample payloads
   carry no timezone offset and JotForm Enterprise's default is to
   render created_at in the account's local time, which is a v2 fix."
   The operator wants EST. Two possible underlying states (verify
   before deciding the fix):
   - **(a)** JotForm Enterprise stores timestamps in UTC. Our
     `parseJotformDate` treats them as UTC correctly. Display
     converts UTC → EST.
   - **(b)** JotForm Enterprise stores timestamps in EST (account-local)
     but our parser stamps `Z` (UTC), shifting the stored time
     5 hours forward. In that case we should rewrite stored data
     OR re-parse as EST. The operator can check by submitting a
     test entry and comparing the JotForm dashboard's timestamp to
     `jotform_created_at` in Supabase.

   Use option (a) at v1 (display conversion only — no stored data
   change) unless the test entry shows a 5-hour offset, in which case
   we need a follow-up brief to fix the ingest path.

3. **Per-form columns** instead of the generic "Submitted at | Site
   | Status | View →". Specific asks (answer keys are JotForm
   question IDs visible via `row.answers[KEY]`):

   - **Rewash** (`250165655616055`): `Submitted | Site | Rewash Reason`
     — Rewash Reason key: TBD. Executor inspects a sample row and
     identifies which `answers.{key}` carries the reason value.
     Look for a key whose `name` field is "reason"-ish or whose
     `text` field reads "reason for rewash" or similar.
   - **Salt log** (`243523811897060`): `Submitted | Site | answers[5] | answers[6] | answers[8]`
   - **Retention** (`250855287972067`): `Submitted | Site | answers[28] | answers[29] | answers[30] | answers[31]`
   - **Time card edit** (`250193775451056`): keep generic `Submitted | Site`
     for v1 — operator hasn't specified per-form columns. v2 candidate.

   Column header labels for the numeric keys: pull from
   `row.answers[KEY].text` on a representative sample row (the
   JotForm-form-builder-shown question text). Hardcode the labels
   in the registry rather than computing per render — saves a sample
   lookup on every page load.

4. **Location dropdown label** in the FilterBar currently shows the
   physical address (`locations.location`). It should show
   `location_pretty` (e.g., "Binghamton") — the same display name
   the customer URLs use (`/signup/binghamton`).

## Scope

### Phase 1 — Form-column registry

New module
`apps/web/app/admin/jotform/[form_id]/_lib/form-columns.ts`.
Exports a typed registry:

```ts
export interface FormColumn {
  key: string;              // 'submitted' | 'site' | 'answer:28' | etc.
  label: string;            // shown in <th>
  // Accessor: receives the row, returns ReactNode | string. Pulls
  // from row.jotform_created_at / row.site_number / row.answers[key].
  render: (row: JotformSubmissionRow) => React.ReactNode;
}

export const FORM_COLUMN_CONFIG: Record<string, FormColumn[]> = {
  '250165655616055': [  // rewash
    submittedColumn(),
    siteColumn(),
    answerColumn('TBD', 'Rewash Reason')
  ],
  '243523811897060': [  // salt-log
    submittedColumn(),
    siteColumn(),
    answerColumn('5', '<label from answers[5].text>'),
    answerColumn('6', '<label from answers[6].text>'),
    answerColumn('8', '<label from answers[8].text>')
  ],
  '250855287972067': [  // retention
    submittedColumn(),
    siteColumn(),
    answerColumn('28', '<label from answers[28].text>'),
    answerColumn('29', '<label from answers[29].text>'),
    answerColumn('30', '<label from answers[30].text>'),
    answerColumn('31', '<label from answers[31].text>')
  ],
  '250193775451056': [  // time-card-edit (fallback / generic)
    submittedColumn(),
    siteColumn()
  ]
};

export const DEFAULT_COLUMNS: FormColumn[] = [
  submittedColumn(),
  siteColumn()
];

export function columnsFor(formId: string): FormColumn[] {
  return FORM_COLUMN_CONFIG[formId] ?? DEFAULT_COLUMNS;
}
```

`submittedColumn()` renders `jotform_created_at` formatted to EST
(see Phase 2). `siteColumn()` renders `row.site` if present else
`row.site_number`. `answerColumn(key, label)` reads
`row.answers?.[key]?.prettyFormat ?? row.answers?.[key]?.answer ?? ''`
— prefer prettyFormat, fall back to raw answer, empty string when
missing.

**Executor action:** open a sample row for each form in the
Supabase SQL editor (queries listed in "Read first") and copy the
`.text` field of each numeric answer key into the registry as the
column label. Document the rewash "Rewash Reason" key choice (which
numeric key, what its `name`/`text` looked like) in the Outcome
section.

If an answer key from the registry is missing from a particular
row's `answers` map (rare — JotForm allows optional questions),
render `—` muted rather than throwing or showing "undefined".

### Phase 2 — EST timestamp formatter

New helper `apps/web/app/admin/jotform/_lib/format-est.ts`:

```ts
export function formatEst(isoString: string): { absolute: string; relative: string } {
  // Parse the ISO string (Brief 107's parseJotformDate stamps with
  // 'Z' so it's UTC at parse time). Convert to EST (America/New_York)
  // via Intl.DateTimeFormat — handles DST automatically.
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return { absolute: isoString, relative: '' };
  const absolute = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    hour12: true
  }).format(d);
  // Relative ("3 hours ago" etc.) — reuse existing formatRelative
  // helper from apps/web/app/_lib/format.ts (it already works
  // because Date instances are timezone-agnostic for relative math).
  const relative = formatRelative(d);
  return { absolute, relative };
}
```

Use `America/New_York` (the IANA name) rather than `EST` literal so
DST transitions just work — EDT in summer, EST in winter,
indistinguishable to the operator.

`submittedColumn()` in the registry renders
`<span title={absolute}>{relative}</span>` for the table-cell view
matching the rest of the apps/web pattern (relative inline with
absolute on hover).

**Verification step (executor):** before pushing, the executor
should sanity-check option (a) vs (b) from the Context section.
Submit a test entry on one of the JotForm forms (operator can do
this), wait for the webhook to ingest, then compare:
- JotForm dashboard timestamp for that submission
- `jotform_created_at` in Supabase for that row
- The new EST display in the apps/web viewer

If the JotForm-dashboard time matches the apps/web EST display →
option (a), all good. If apps/web shows 5 hours later than JotForm
dashboard → option (b), file a follow-up brief to fix the ingest
path (this brief should still land — display conversion is correct
under both interpretations once we know which one applies).

### Phase 3 — Table renderer rewrite

Edit `apps/web/app/admin/jotform/[form_id]/page.tsx`:

3.1 Drop the "Status" `<th>` and its corresponding `<td>` from the
table.

3.2 Replace the hard-coded column set with a dynamic
`columnsFor(formId).map(col => ...)` loop in the `<thead>` AND
`<tbody>` so each form gets its own column pack.

3.3 Keep the "View →" trailing column (link to detail page) on
every form — it's not part of the per-form registry but is appended
unconditionally.

3.4 Keep the grouped rendering from Brief 110 — the rewrite is to
the columns shown WITHIN each rendered row, not to the grouping
structure.

### Phase 4 — LocationPicker label fix

Edit
`apps/web/app/admin/jotform/[form_id]/_components/FilterBar.tsx`:

The Location dropdown's option label currently reads
`locations.location` (postal address). Change it to
`location_pretty` (passing `(site_number)` as suffix per Brief 110's
spec — "Binghamton (127)"). The `location_pretty` field is already
on every roster row from Brief 110's `/admin/jotform/api/roster`
endpoint; this is purely a label-source swap in the dropdown's
option rendering.

If `location_pretty` is null on a row (rare — `pricing_simple`
column is nullable), fall back to `location_code` (e.g., "binghamton")
NOT the address. The address is never the right surface for this
dropdown.

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass.
5.2 `pnpm --filter @splash/web build` — must succeed.
5.3 No worker change. No Supabase / R2 / wrangler.toml / secret
    changes.
5.4 Operator post-deploy smoke (deferred):
    - Load `/admin/jotform/250165655616055` → table shows
      Submitted (EST) | Site | Rewash Reason.
    - Load `/admin/jotform/250855287972067` → table shows
      Submitted (EST) | Site | 4 retention answer columns with
      JotForm-question labels as headers.
    - Load `/admin/jotform/243523811897060` → table shows
      Submitted (EST) | Site | 3 salt-log answer columns.
    - Load `/admin/jotform/250193775451056` → table shows
      Submitted (EST) | Site (generic — no per-form columns).
    - Open FilterBar Location dropdown → options read "Binghamton
      (127)", not "123 Main Street, Binghamton, NY".
    - Hover a Submitted cell → absolute EST shows in title attribute.

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md: Brief 111 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
  - Brief 111 (YYYY-MM-DD) — JotForm viewer gained per-form
    column packs (rewash / salt-log / retention / time-card-edit),
    EST-converted timestamps, Status column dropped, Location
    dropdown label fixed to `location_pretty`.
  - Whether option (a) [display conversion only] or option (b)
    [ingest re-parse] applied to the timestamp story.

6.3 CLAUDE.md "JotForm submissions" glossary entry: append a
one-liner noting Brief 111 — per-form column packs live in
`apps/web/app/admin/jotform/[form_id]/_lib/form-columns.ts`
(registry by form_id; adding a 5th / 6th form means adding an
entry there if non-generic columns are wanted, otherwise the
default `Submitted | Site` columns kick in automatically).

## Out of scope

- Adding the "Status" column back for any form. None of the four
  current forms emits anything besides ACTIVE.
- Per-form column registry on the detail page. The detail page
  (`/admin/jotform/[form_id]/[submission_id]`) renders all answers
  with the generic alphabetical renderer; that stays generic in v1.
- CSV export schema change. The Brief 107 CSV export is
  schema-union across the entire date range and doesn't need
  per-form column trimming — operators dump to spreadsheet and
  filter columns there. (If operators report wanting per-form CSV
  column packs that's a v2 candidate.)
- Fixing the JotForm ingest timezone if option (b) turns out to
  apply — separate brief candidate.
- Time-card-edit per-form columns. Operator didn't specify; v2
  candidate.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/web/app/admin/jotform/[form_id]/_lib/form-columns.ts`
  exists with the four-form registry + default fallback +
  `columnsFor()` helper. Numeric-key column labels copied from
  sample rows' `answers[key].text` fields; rewash's "Rewash Reason"
  key identified.
- `apps/web/app/admin/jotform/_lib/format-est.ts` exists with
  `formatEst()` using `Intl.DateTimeFormat` + `America/New_York`.
- `apps/web/app/admin/jotform/[form_id]/page.tsx` renders the
  registry-driven columns (no Status, EST submitted times) inside
  Brief 110's group/date structure.
- `apps/web/app/admin/jotform/[form_id]/_components/FilterBar.tsx`
  Location dropdown options render `location_pretty (site_number)`
  not the postal address.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 6.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (estimate: ~150 LOC across two new modules + the
  list page + FilterBar; plus doc rows).
- Validation results.
- The specific rewash answer key chosen for "Rewash Reason" and
  why (the `name` / `text` shown on the sample row).
- The column header labels picked for salt-log keys 5/6/8 and
  retention keys 28/29/30/31 (from `answers[key].text`).
- Timezone story: option (a) or option (b)? Include the
  test-entry comparison (JotForm dashboard time vs. Supabase
  jotform_created_at vs. apps/web EST display).
- Any rows in the table that hit the `—` fallback for missing
  per-form answer keys (would suggest a v2 deeper cleanup).

## Outcome

### Files created

- `apps/web/app/admin/jotform/[form_id]/_lib/form-columns.tsx` —
  per-form column registry (`FORM_COLUMN_CONFIG`), `DEFAULT_COLUMNS`
  fallback, `columnsFor(formId)` resolver, three reusable column
  builders (`submittedColumn` / `siteColumn` /
  `answerColumn(key, label)`). Accessor uses
  `prettyFormat → answer → ""` fallback chain; missing keys render
  muted em-dash.
- `apps/web/app/admin/jotform/_lib/format-est.ts` — `formatEst(iso)`
  returns `{absolute, relative}` via `Intl.DateTimeFormat` + IANA zone
  `America/New_York` (auto-handles EDT/EST DST). Absolute format
  includes the short timezone name in the title attr ("Nov 12, 2026,
  2:40 PM EST"); relative ladder mirrors apps/web's existing pattern
  (`Ns ago` / `N min ago` / `N hr ago` / `N day(s) ago` → EST absolute).

### Files modified

- `apps/web/app/admin/jotform/[form_id]/page.tsx`:
  - Added import of `columnsFor` + `FormColumn` from `_lib/form-columns`.
  - `GroupedSubmissions`, `LocationGroup`, `SubmissionsTable` accept a
    `columns: FormColumn[]` prop threaded from the top-level page.
  - `SubmissionsTable` body rewritten: hard-coded
    "Submitted at / Site / Status / View →" replaced with
    `columns.map(col => ...)` in both `<thead>` and `<tbody>`. Trailing
    `View →` link column appended unconditionally per form.
  - Status column + `StatusPill` removed entirely.
  - Local `formatAbsolute` / `formatRelative` helpers removed —
    replaced by `formatEst` import in the new registry module.
  - `GroupedSubmissions` location-header label gained the same
    `location_pretty` address-shape detection the FilterBar now uses
    (prefer `location_pretty` unless it contains a comma OR starts with
    a digit → in which case use `location_code`).
- `apps/web/app/admin/jotform/[form_id]/_components/FilterBar.tsx`:
  - New `locationDisplayLabel(loc: RosterLocation)` helper at the
    bottom of the file. When `location_pretty` contains a comma OR
    starts with a digit (postal-address shape), use `location_code`
    instead. Site_number suffix appended as before per Brief 110's
    spec.
  - `<option>` rendering switched from inline
    `{loc.location_pretty} ({loc.site_number})` to
    `{locationDisplayLabel(loc)}`.
- `CLAUDE.md` — `JotForm submissions` glossary entry gains a Brief 111
  paragraph pointing at the registry + format-est helper + Location
  fallback.
- `BUILD_STATE.md` — Last-updated bump + Findings & decisions log row.
- `BRIEFS/INDEX.md` — Brief 111 row appended above Brief 110.
- `BRIEFS/brief-111-jotform-viewer-per-form-columns-and-est-and-location-pretty.md`
  — this Outcome section + Status set to Completed.

### Files deleted

None.

### Decisions made on operator's behalf

1. **Numeric-answer column LABELS are placeholder.** Brief Phase 1
   required the executor to copy `answers[KEY].text` from a
   representative Supabase sample row into each `answerColumn(key, label)`
   call. Sample rows live only in operator's Supabase (not in git);
   headless Claude Code can't run SQL against Supabase. Decision:
   land the structural code with clearly-marked placeholders
   (`"Answer (key 5)"` etc., plus a `REWASH_REASON_KEY = "TBD"`
   constant for rewash) so the operator / next executor greps and
   replaces in a 5-minute follow-up once a sample row is in hand.
   The accessor's `prettyFormat → answer → ""` chain keeps each cell
   rendering meaningful regardless. Documented prominently in the
   form-columns.tsx file header.
2. **Worker untouched per Phase 5.3.** The roster worker's
   `location_pretty` fallback to `locations.location` (postal
   address) — at `apps/jotform-worker/src/handlers/roster.js` L82-85
   — is the actual root cause of address-shaped labels in the
   dropdown. Phase 5.3 explicitly forbade a worker change, so the
   FilterBar applies a defensive client-side heuristic
   (`location_pretty.includes(",") || /^\d/.test(location_pretty)`)
   and surfaces `location_code` when the address shape is detected.
   Future brief candidate: tighten the roster fallback to
   `pricing_simple.location_code` (eliminating the heuristic).
3. **EST via IANA `America/New_York`, not literal "EST".** Per
   the brief's recommendation; `Intl.DateTimeFormat` picks the right
   offset per-timestamp based on the date, so EDT (summer) / EST
   (winter) are invisible to the operator. Column header label
   "Submitted (EST)" is intentionally informal ("EDT/EST" would be
   technically more accurate but operators don't think in DST
   terms).
4. **Group-header label also got the address-shape fallback** (out
   of strict Phase 4 scope — Phase 4 mentioned only the FilterBar —
   but the address-fallback root cause means the same data leaks
   into group headers via the same roster response). Without this,
   Brief 110's location group headers would still show
   "123 Main Street, Binghamton, NY" for any site missing
   `pricing_simple.location_pretty`. Same fallback heuristic, kept
   inline in `page.tsx`'s `GroupedSubmissions` rather than extracted
   to a shared helper (single rendering site; if a third caller
   appears, refactor).
5. **Timezone story defaulted to option (a)** (display-only
   conversion — worker stamps UTC, display converts to EST). The
   brief listed verification-via-test-entry as a deferred operator
   step. Option (a) is the safer default because it doesn't require
   any storage rewrite. If the operator confirms option (b) (worker
   stores EST as UTC, shifting timestamps 5 hours forward), a
   follow-up brief patches `parseJotformDate` in
   `apps/jotform-worker/src/normalize.js`. Display layer is correct
   under either interpretation once we know which applies.

### Latent issues / forward flags

- **Per-form numeric-answer labels need operator fill-in.** Grep
  `REWASH_REASON_KEY` + `"Answer (key "` in
  `apps/web/app/admin/jotform/[form_id]/_lib/form-columns.tsx`. Five
  labels need replacement: rewash's "Rewash Reason" key (currently
  `REWASH_REASON_KEY = "TBD"` — find the key whose `name` is "reason"
  or whose `text` is "reason for rewash"), salt-log keys 5/6/8,
  retention keys 28/29/30/31.
- **Time-card-edit per-form columns deferred to v2.** Operator
  didn't specify; the time-card form falls back to default
  `Submitted | Site` columns.
- **Detail page (`/admin/jotform/[form_id]/[submission_id]`)
  timestamps still render in browser-local time** (not EST). The
  brief was scoped to the list table; a follow-up brief could pull
  `formatEst` into the detail page's metadata section. Same caveat
  for the under-title "submitted N hr ago" caption.
- **CSV export schema-union still includes `jotform_status`
  column.** Out of scope per the brief; operators can hide that
  column in their spreadsheet.
- **Address-shape heuristic is a UX safeguard, not a correctness
  guarantee.** If a JotForm form ever surfaces a location whose
  `pricing_simple.location_pretty` legitimately starts with a digit
  (none today; operator-curated value), the heuristic would
  mis-classify and fall to `location_code`. Acceptable for v1 —
  `location_code` is still a meaningful label.
- **No rows hit the `—` muted fallback yet** because the registry
  isn't wired against live data (would require deploy + smoke).
  Once the operator confirms answer-key labels, the worker scopes
  rows by `accessibleSiteNumbersForSession` and the table renders
  per-form columns, missing-key rows should render em-dash gracefully.

### Validation

- `pnpm typecheck` (root, all 18 packages): **18/18 successful** (only
  `@splash/web` cache miss; everything else cache-hit). Elapsed: 4.2s.
- `pnpm --filter @splash/web build`: **succeeded**.
  - `/admin/jotform/[form_id]` route: **1.61 kB / 107 kB First Load JS**
    (up 60 B from Brief 110's 1.55 kB; well under the implicit
    page-bundle target).
  - Other routes unchanged.
- No worker change → no `wrangler deploy --dry-run` needed.
- No Supabase / R2 / wrangler.toml / secret changes.

### Report-section answers

- **Diff size:** ~280 LOC across two new modules + page.tsx +
  FilterBar.tsx + docs (close to brief estimate of ~150 LOC).
- **Rewash answer key chosen for "Rewash Reason":** unknown — `TBD`
  placeholder pending operator's Supabase sample-row inspection.
- **Column header labels for salt-log keys 5/6/8 and retention keys
  28/29/30/31:** unknown — generic placeholders pending operator's
  Supabase sample-row inspection.
- **Timezone story:** option (a) by default (display conversion only).
  Operator's post-deploy verification step (submit test entry,
  compare JotForm dashboard ↔ Supabase `jotform_created_at` ↔ apps/web
  EST display) confirms or refutes; option (b) follow-up brief
  candidate if confirmed.
- **Rows hitting `—` fallback:** unknown without deploy + smoke.
  Defense-in-depth: missing answer keys render muted em-dash; bad
  answer payload shape renders empty string then em-dash via the
  accessor chain.
