# Brief 86: Fleet admin viewer — fix `created_at` → `submitted_at` column reference (500 on every list/CSV/detail call)

**Status:** Completed (2026-05-09)
**Drafted:** 2026-05-09
**Blocks:** Operator hit the new `/admin/fleet` page 2026-05-09 after
Brief 83 deployed and got 500 on every list call. The cause is that
Brief 83's executor wrote `apps/fleet-inquiry-worker/src/admin.js` to
filter and order `fleet_submissions` rows on a `created_at` column
that doesn't exist on the table — only `submitted_at` does (the
public form's submit handler at `src/index.js:368` writes
`submitted_at: new Date().toISOString()` and that's the only timestamp
column on the row). PostgREST rejects with 400 (column does not exist),
the worker surfaces that as 500 to the caller, the apps/web page shows
"Failed to load submissions: Fleet worker GET /admin/api/submissions
failed: 500" / "503" depending on which prerequisite was last
unblocked.

This brief is a one-file surgical swap: every `created_at` reference
in `admin.js` flips to `submitted_at`. Three filter/order sites in
the list handler, three identical sites in the CSV handler, and one
column-inventory entry. CSV_COLUMNS keeps `submitted_at` (renames
the internally-mislabeled `created_at` slot away).

**Dependencies:**
- Brief 83 (the brief that introduced the broken module).
- None other — pure data-model bug fix.

## Read first

- BRIEFS/brief-083-fleet-submissions-admin-viewer.md (background;
  the brief that should be referenced in this brief's lesson
  section).
- apps/fleet-inquiry-worker/src/admin.js (the file getting edited
  — six sites total).
- apps/fleet-inquiry-worker/src/index.js line 368 (canonical source
  of truth for the column name — the public submit handler writes
  `submitted_at`).

## Context

### Why the bug landed

Brief 83's executor inferred `created_at` from a few signals:
1. PostgreSQL's common pattern of auto-adding `created_at` /
   `updated_at` columns via Supabase row-level defaults.
2. Brief 56's signups viewer (the pattern this brief mirrors) reads
   `maxpass_signups` which DOES have a `created_at` column.
3. The CSV_COLUMNS list in `admin.js` includes both `created_at`
   AND `submitted_at` slots, suggesting the executor wasn't sure
   which one was canonical and listed both.

The `fleet_submissions` table doesn't follow the convention — it
has only `submitted_at`, written explicitly by the JS submit
handler at `src/index.js:368`. No DB-level default `created_at`,
no Supabase auto-column.

This is the "URL/column-by-analogy" bug class that's bitten the
project before:
- Brief 76 (URL: `/attachment/` vs `/attachments/`)
- Brief 80 (URL: `/workrequests/{id}` vs `/requests/{id}`)
- Brief 62 (Supabase join key: `pricing_simple.site` vs
  `locations.site_number`)
- Brief 86 (this one — column: `created_at` vs `submitted_at`)

The fix forward is the same as those: probe the actual schema /
URL / column name before inferring.

### What the operator sees

Without the fix:
- `/admin/fleet` page renders, but list area shows "Failed to load
  submissions: Fleet worker GET /admin/api/submissions failed: 500".
- Date-range pickers don't help — they hit the same broken endpoint.
- CSV export button generates a 500 download.
- Detail page (clicking a row) would also 500 — but operator can't
  click a row because the list never loads.

After the fix:
- List populates with rows in the date range, ordered by
  `submitted_at` desc.
- Date-range filter applies to `submitted_at`.
- CSV export downloads a file scoped to the same range.
- Detail page loads (it doesn't filter on the timestamp at all,
  just `id=eq.{id}` — it was actually working independently of
  this bug, but no operator could reach it).

## Scope

### Phase 1 — Swap `created_at` → `submitted_at` in admin.js

**File:** `apps/fleet-inquiry-worker/src/admin.js`

Six sites in the file (per audit on 2026-05-09):

1. **L55 (CSV_COLUMNS)** — drop the `{ key: "created_at", label:
   "created_at" }` entry. Keep `{ key: "submitted_at", label:
   "submitted_at" }` at L56 unchanged. The CSV column inventory
   shrinks by one column.

2. **L240** — change
   ```js
   u.searchParams.append("created_at", `gte.${range.fromIso}`);
   ```
   to
   ```js
   u.searchParams.append("submitted_at", `gte.${range.fromIso}`);
   ```

3. **L241** — change
   ```js
   u.searchParams.append("created_at", `lte.${range.toIso}`);
   ```
   to
   ```js
   u.searchParams.append("submitted_at", `lte.${range.toIso}`);
   ```

4. **L242** — change
   ```js
   u.searchParams.set("order", "created_at.desc");
   ```
   to
   ```js
   u.searchParams.set("order", "submitted_at.desc");
   ```

5. **L323** — same swap as L240, in `handleCsvExport`:
   ```js
   u.searchParams.append("submitted_at", `gte.${range.fromIso}`);
   ```

6. **L324** — same swap as L241:
   ```js
   u.searchParams.append("submitted_at", `lte.${range.toIso}`);
   ```

7. **L325** — same swap as L242:
   ```js
   u.searchParams.set("order", "submitted_at.desc");
   ```

Detail handler `handleGetSubmission` (L280-311) is unaffected —
it filters on `id`, not the timestamp.

Inline docblocks elsewhere in the file mentioning `created_at`
(L26-28: "Filtering: server-side gte/lte on
`fleet_submissions.created_at`", L52: "the implicit `id` and
`created_at`") should be updated in lockstep so a future reader
isn't misled. Two comment edits, both pointing at `submitted_at`
now and dropping the "implicit `created_at`" claim.

### Phase 2 — Validation

```sh
pnpm --filter @splash/fleet-inquiry-worker typecheck
pnpm --filter @splash/fleet-inquiry-worker build
pnpm typecheck
```

Smoke test (after operator deploys):
1. Open `/admin/fleet` as admin.
2. List should populate with rows from last-30-days, ordered most
   recent first.
3. Adjust the date range — list updates.
4. Click "Export CSV" — file downloads with all matching rows.
   The CSV no longer has a `created_at` column; rows show
   `submitted_at` for the timestamp.
5. Click any row's "View" → detail page loads (was already
   working at the SQL level, just unreachable).

### Phase 3 — Documentation

1. **CLAUDE.md** — under the existing "MaintainX URLs" /
   inference-warning callout (Brief 80 added one), append a
   one-liner about this same bug class on Supabase column names:
   > Probe Supabase column schemas before inferring. Tables don't
   > universally have `created_at` (Brief 86: `fleet_submissions`
   > has only `submitted_at`, written by the worker on insert).
   > Same bug class as URL-by-analogy (Briefs 76, 80) and Supabase
   > join-key inference (Brief 62).

2. **BUILD_STATE.md** — bump "Last updated" to 2026-05-09 and add
   a Findings entry: "Fleet admin viewer was 500ing on every list
   /CSV call because `admin.js` filtered/ordered on a non-existent
   `created_at` column. Fixed in Brief 86 — three filter/order
   sites swapped to `submitted_at`, plus CSV column inventory
   pruned."

3. **BRIEFS/INDEX.md** — append Brief 86 row.

4. **BRIEFS/QUEUE.md** — entry already appended; this brief
   self-checks.

## Definition of Done

- `apps/fleet-inquiry-worker/src/admin.js` contains zero
  references to `created_at` (verify with grep). All filter /
  order / column references point at `submitted_at`.
- `pnpm --filter @splash/fleet-inquiry-worker build` succeeds.
- `pnpm typecheck` passes.
- CLAUDE.md gains the column-inference warning.
- BUILD_STATE.md "Last updated" bumped + Findings entry added.
- BRIEFS/INDEX.md row added.
- This brief's `Status:` flips to `Completed (YYYY-MM-DD)` with
  the `## Outcome` section filled in.
- Smoke test in the Outcome section confirms the list page now
  loads with no 500.

## Out of scope

- Adding a `created_at` column to `fleet_submissions` via
  Supabase migration — `submitted_at` is the canonical timestamp
  the public form writes; adding a redundant column is scope
  creep.
- Refactoring CSV_COLUMNS to derive labels from the row keys
  automatically — the explicit list is fine for v1.
- Backfilling Brief 83's INDEX.md row to mention the column bug
  was fixed in 86 (the row stays as written; this brief's row
  documents the fix).
- Adding worker-side schema introspection so future bugs of this
  shape are caught at build time — interesting future direction
  but a much bigger brief.

## Outcome

### Files modified

- `apps/fleet-inquiry-worker/src/admin.js` — six SQL/PostgREST sites
  swapped from `created_at` to `submitted_at`:
  - `handleListSubmissions` (was L240-242): three filter/order
    sites — `gte`, `lte`, and `order=…desc`.
  - `handleCsvExport` (was L323-325): three identical filter/order
    sites.
  - `CSV_COLUMNS` (was L55): the bogus `{ key: "created_at",
    label: "created_at" }` entry deleted; `submitted_at` retained
    at slot 2 (column count 22 → 21).
  - File-top docblock (was L25-28): rewrote the "Filtering:
    server-side gte/lte on `fleet_submissions.created_at`"
    paragraph to point at `submitted_at` and explain it's the only
    timestamp column on the table (written by the public submit
    handler in `src/index.js`).
  - `CSV_COLUMNS` JSDoc (was L52): "implicit `id` and `created_at`"
    → "implicit `id` and `submitted_at`".
- `CLAUDE.md` — Work Orders glossary block's URL-asymmetry
  warning (the Brief 80 callout) extended into a four-sibling
  inference-bug cluster: Briefs 76 / 80 / 62 / 86. Adds an
  explicit "Tables don't universally have `created_at`; probe
  Supabase column schemas before inferring" line citing
  `fleet_submissions.submitted_at` as the canonical example and
  contrasting it with `maxpass_signups.submitted_at` (Brief 84
  grounded correctly on the same convention break).
- `BUILD_STATE.md` — Last-updated bump from Brief 85's narrative
  to Brief 86's; new Findings & decisions log entry at the top
  of the table.
- `BRIEFS/INDEX.md` — Brief 86 row Status flipped from
  `Ready for Claude Code` to `Completed (2026-05-09)`.
- `BRIEFS/QUEUE.md` — Brief 86 line moved from the active
  queue into the completed-tombstone block.

### Files created

None.

### Files deleted

None.

### Decisions made on operator's behalf

1. **The two docblock comments were rewritten without a
   "previously assumed `created_at`" footnote.** The DoD
   specifies "zero references to `created_at` (verify with
   grep)" and that takes precedence over a footnote-style
   breadcrumb. The historical record is captured in the
   BUILD_STATE.md Findings entry and in this brief's Outcome.

2. **CSV_COLUMNS column ordering preserved.** Deleting slot 2
   (`created_at`) collapses cleanly to `submitted_at` at slot 2;
   no other column was reordered. Operators who downloaded a
   broken-shape CSV before the fix won't see additional column
   churn after — the only shape change is the dropped column.

3. **No new test added.** Out of scope per the brief; the fix
   is a string swap inside an existing handler. A future polish
   could add a single-shot vitest asserting the constructed
   PostgREST URL contains `submitted_at=gte.…` rather than
   `created_at=gte.…`, but that's a separate brief.

4. **No new `created_at` column added to `fleet_submissions`
   via Supabase migration.** Out of scope per the brief —
   `submitted_at` is the canonical timestamp the public form
   writes, adding a redundant column would be scope creep and
   introduce its own DB-default-vs-app-write divergence.

5. **CLAUDE.md callout extended in place rather than promoted
   to a top-level constraint section.** Four siblings is the
   right size for a glossary footnote; promoting it to a
   numbered constraint would warrant a fifth or sixth sibling
   first. Flagged in the Findings entry as a future
   consideration.

### Latent issues / forward flags

- **CLAUDE.md inference-warning callout has now grown to four
  siblings** (URL paths, plural-vs-singular path segments, join
  keys, column names). Future shapes of the same bug class
  (env var name inference, secret name inference, header name
  inference) would warrant promoting it from a glossary
  footnote to a top-of-file constraint. Not in scope here.
- **`admin.js` test surface is empty.** No vitest run exercises
  the module today. A single-shot test asserting the URL-
  construction logic emits `submitted_at=gte.<iso>` would
  catch this same bug class at PR time on future column-name
  edits.
- **Smoke test deferred to operator post-deploy.** Headless
  Claude Code cannot exercise a live deploy; operator runs the
  list-loads / range-filter / CSV-download / detail-page-loads
  steps from Phase 2 of the brief on the next staging deploy.

### Validation

- `pnpm --filter @splash/fleet-inquiry-worker typecheck` — green
  (single-package run, `tsc --noEmit` returned 0 with the
  `allowJs: true` / `checkJs: false` posture from Brief 81's
  `tsconfig.json`).
- Root `pnpm typecheck` — 15/15 packages green; 14 cache hits,
  only `@splash/fleet-inquiry-worker` cache-missed and re-ran
  (1.278s total).
- `pnpm --filter @splash/fleet-inquiry-worker build` —
  **unrunnable**. Per Brief 79's latent finding and reaffirmed
  by Brief 85, fleet-inquiry-worker has no `build` script in
  `package.json` (CF workers don't bundle ahead of `wrangler
  deploy`; `typecheck` is the build verification per the
  existing pattern). Future brief drafters: spec `typecheck`
  only for fleet validation, not `build`. Wrangler dry-run was
  not exercised here because the brief did not request it and
  the change is a pure string swap inside a JS handler — no
  binding / secret / wrangler.toml edits.
- Final grep across `admin.js` for `created_at` returns zero
  matches per the brief's DoD.

### Smoke test (deferred to operator post-deploy)

1. Open `/admin/fleet` as super_admin or admin.
2. List populates with rows from last-30-days, ordered most-
   recent first by `submitted_at`.
3. Adjust the date range — list updates; rows still ordered
   most-recent first.
4. Click "Export CSV" — file downloads with all matching rows;
   first-row column headers no longer include `created_at`;
   `submitted_at` is present and populated.
5. Click any row's "View" — detail page loads (was already
   working at the SQL level; just unreachable when the list
   500'd).
