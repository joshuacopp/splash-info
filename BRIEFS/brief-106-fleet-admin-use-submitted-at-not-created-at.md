# Brief 106: Fleet admin pages — render `submitted_at` instead of `created_at`

**Status:** Completed (2026-05-11)
**Started:** 2026-05-11
**Completed:** 2026-05-11
**Blocks:** Neither — visible bug (SUBMITTED column renders blank on
`/admin/fleet` list, "Created at" key/value row is blank on the
detail page) but no functional impact beyond the empty cell.
**Dependencies:** Brief 83 (introduced both apps/web pages and
referenced `created_at` from the start), Brief 86 (worker-side
fix that established `submitted_at` is the authoritative timestamp
on `fleet_submissions` — apps/web was not updated at the time).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-083-fleet-submissions-admin-viewer.md (introduced
  the pages this brief patches)
- BRIEFS/brief-086-fleet-admin-fix-submitted-at-column.md (fixed
  worker-side filter; apps/web's render-time `created_at`
  references slipped through that fix)
- apps/web/app/admin/fleet/page.tsx (~L172-173 — list-row Submitted
  cell reads `r.created_at`)
- apps/web/app/admin/fleet/[id]/page.tsx (~L60-61 + L123 — detail
  page key/value grid + the under-title "Submitted N days ago"
  caption both read `row.created_at`)
- apps/web/app/admin/fleet/_lib/worker-fetch.ts (~L13-17 —
  `FleetSubmissionRow` type currently declares both `created_at`
  and `submitted_at`; only `submitted_at` is actually populated)

## Context

The operator reported on 2026-05-11 that the SUBMITTED column on
`/admin/fleet` renders empty for every row. Diagnosis: the list
page (page.tsx L172-173) reads `r.created_at`, but
`fleet_submissions.created_at` is either non-existent or NULL on
every row — the fleet-inquiry-worker writes `submitted_at`
explicitly on insert (per Brief 86's note: "fleet_submissions has
only `submitted_at`, not the conventional `created_at`").

The detail page has the same bug in three places:
- `{ label: "Created at", value: formatAbsolute(row.created_at) }`
  (L60) — always blank
- `{ label: "Submitted at", value: formatAbsolute(row.submitted_at) }`
  (L61) — correct
- The under-title caption "Submitted {formatRelative(row.created_at)}"
  (L123) — always blank because it reads `created_at`

Brief 86 fixed the worker-side filter / sort to use `submitted_at`
but didn't touch apps/web. This brief closes that gap.

## Scope

### Phase 1 — `apps/web/app/admin/fleet/page.tsx`

List-page Submitted cell (~L172-173): change `r.created_at` to
`r.submitted_at`:

```tsx
<td className="px-3 py-2 align-top text-splash-navy">
  <span title={formatAbsolute(r.submitted_at)}>
    {formatRelative(r.submitted_at)}
  </span>
</td>
```

### Phase 2 — `apps/web/app/admin/fleet/[id]/page.tsx`

Two edits:

2.1 The key/value grid around L60-61. **Drop the "Created at" row
entirely** — it has never rendered usefully because the column is
empty in Supabase. Keep the "Submitted at" row.

2.2 The under-title caption at ~L123. Change `row.created_at` to
`row.submitted_at`:

```tsx
Submitted {formatRelative(row.submitted_at)} ·{" "}
```

### Phase 3 — `apps/web/app/admin/fleet/_lib/worker-fetch.ts`

Decision call for the executor — either:

- **Option A (recommended):** keep `created_at: string;` on
  `FleetSubmissionRow` for now. Harmless leftover; the worker
  still SELECTs `*` so PostgREST returns whatever columns exist.
  Removing the field touches more code paths (every consumer of
  the type) for no functional gain.
- Option B: drop `created_at` from the type. If the executor
  prefers the cleanup, also verify no other apps/web call site
  reads `r.created_at` after the fix (grep for `created_at` under
  `apps/web/app/admin/fleet/` and the worker-fetch type).

Default to Option A unless typecheck or grep shows a clear case
for B.

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass.
4.2 `pnpm --filter @splash/web build` — must succeed.
4.3 No worker change. No Supabase / R2 / D1 schema change. No new
    env / secret.
4.4 Operator post-deploy smoke (deferred): load `/admin/fleet`,
    confirm SUBMITTED column shows a relative-date string for every
    row (e.g., "2h ago", "3d ago", or absolute "May 11, 2026" via
    the title attribute on hover). Load any detail page, confirm
    the under-title caption shows a date and the "Created at" row
    is gone from the key/value grid.

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 106 row appended.

5.2 BUILD_STATE.md: Findings entry noting:
  - Brief 106 (2026-05-11) — fixed `/admin/fleet` list and
    `/admin/fleet/[id]` detail pages to render `submitted_at`
    instead of `created_at` (the latter is empty on every row;
    Brief 86 had already established `submitted_at` is
    authoritative).
  - Dropped the "Created at" key/value row on the detail page;
    "Submitted at" / under-title caption are now the timestamp
    surface.

5.3 CLAUDE.md "Fleet inquiries admin" glossary entry: append a
one-liner noting that apps/web reads `submitted_at` (matching the
worker-side authoritative timestamp post-Brief-86).

## Out of scope

- Adding a true `created_at` column to `fleet_submissions` with a
  Supabase row-default of `now()`. The legacy worker has shipped
  with `submitted_at` for the row's entire history; adding a
  separate column would split the timestamp surface in two for no
  product gain.
- Backfilling any historical row data. Not applicable — only
  rendering changes.
- Touching the worker's PostgREST query. The worker still SELECTs
  `*` and returns whatever columns Supabase has; the row shape on
  the wire is unchanged.
- Touching the CSV export. The export queries Supabase with
  `select=*` and already filters / orders by `submitted_at` per
  Brief 86.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/web/app/admin/fleet/page.tsx` list-row Submitted cell
  reads `r.submitted_at`.
- `apps/web/app/admin/fleet/[id]/page.tsx`:
  - The "Created at" key/value entry is removed.
  - The under-title caption reads `row.submitted_at`.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size confirmation (likely 6-10 lines net across 2 files,
  plus doc rows)
- Whether the executor went Option A (kept `created_at` on the
  type) or Option B (dropped it)
- Validation results

## Outcome

**Files modified.**

- `apps/web/app/admin/fleet/page.tsx` — list-row Submitted cell (L172-173)
  now reads `r.submitted_at` (both title attr + visible text).
- `apps/web/app/admin/fleet/[id]/page.tsx` — dropped the always-blank
  "Created at" key/value entry from the detail grid (was L60 pre-change);
  under-title "Submitted N days ago" caption (was L123 pre-change) now
  reads `row.submitted_at`.
- `CLAUDE.md` — appended a Brief 106 one-liner to the "Fleet inquiries
  admin" glossary entry noting apps/web reads `submitted_at` post-Brief-106,
  matching the worker-side authoritative timestamp from Brief 86. Also
  flagged that the Brief 86 / 88 paragraphs above pre-date this correction
  so future readers treat `submitted_at` as the single timestamp surface.
- `BRIEFS/INDEX.md` — Brief 106 row appended.
- `BUILD_STATE.md` — Last-updated bumped to 2026-05-11 with Brief 106
  summary; new Findings entry at the top of the log; previous Brief 105
  entry preserved.
- `BRIEFS/brief-106-fleet-admin-use-submitted-at-not-created-at.md` —
  Status set to Completed (2026-05-11); Outcome filled.

**Files created.** None.

**Files deleted.** None.

**Decisions made on operator's behalf.**

- Went with **Option A** on the type per the brief's recommendation:
  `created_at: string` stays on `FleetSubmissionRow` in
  `apps/web/app/admin/fleet/_lib/worker-fetch.ts`. After the fix, a
  whole-directory grep confirmed no remaining `created_at` references
  under `apps/web/app/admin/fleet/` aside from the type declaration
  itself, so Option B (drop the field) was also viable — but removing
  it would touch the type's structural contract for no functional gain,
  and the worker still `SELECT *`s so PostgREST returns whatever
  columns exist. Option A is the lower-risk, smaller diff.
- The CLAUDE.md one-liner explicitly cross-references the older Brief
  86 / 88 paragraphs as pre-dating this correction — those entries
  contained "filtering is on `fleet_submissions.created_at`" language
  that no longer matches the worker's actual behavior (Brief 86 changed
  worker-side filter/sort to `submitted_at`). Rather than rewriting the
  earlier paragraphs (Brief 86 should have done that, and the brief's
  scope here is "append a one-liner"), I appended a clarifying
  paragraph that points future readers at the corrected behavior.

**Latent issues found.**

- The CLAUDE.md "Filtering is on `fleet_submissions.created_at` (Supabase
  row default `now()`), NOT the JS-written `submitted_at` field" sentence
  in the Brief 88 paragraph is now factually wrong post-Brief-86. Not in
  scope to rewrite here (out of scope per brief Phase 5.3), but flagged
  here for future cleanup. The new Brief 106 sentence I appended after
  the Brief 88 paragraph corrects the record without rewriting Brief 88's
  text.

**Validation results.**

- `pnpm typecheck` — **green**, 17/17 tasks successful (cache miss on
  `@splash/web` only; all worker / package tasks cache-hit). Ran in
  ~4.7s.
- `pnpm --filter @splash/web build` — **green**. Next 15.5.15
  compiled successfully in 5.5s. Route sizes for the changed pages:
  - `/admin/fleet` — 920 B / 106 kB First-Load JS (unchanged vs Brief 105).
  - `/admin/fleet/[id]` — 739 B / 106 kB First-Load JS (unchanged vs
    Brief 105 — the row-drop and three-character text swap have no
    measurable bundle impact).
- No worker change. No Supabase / R2 / D1 schema change. No new env /
  secret. Net diff size: 8 lines across 2 TSX files, plus doc rows.

## Report

- **Diff size:** 8 lines net across 2 files + doc rows
  (1 `page.tsx` cell, 1 `[id]/page.tsx` row removal, 1 `[id]/page.tsx`
  caption — each a single-token rename plus one row entirely removed).
- **Option A vs B:** **Option A** — `created_at: string` kept on
  `FleetSubmissionRow`. Post-fix grep confirms zero remaining
  `created_at` reads anywhere under `apps/web/app/admin/fleet/`.
- **Validation:** `pnpm typecheck` 17/17 green; `pnpm --filter
  @splash/web build` green. Operator post-deploy smoke deferred per
  CLAUDE.md (don't deploy from headless).
