# Brief 53: Audit log diff renders as full-width expanded row, not cramped inside DIFF cell

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Nothing.
**Dependencies:** None.

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-030-sysadmin-mode-hub-and-audit-log.md (the
  audit-log table this brief touches; rendering pattern + filter
  conventions)
- BRIEFS/brief-034-audit-log-occurred-at-column-fix.md (the
  occurred_at rename context — same panel)
- apps/web/app/admin/sysadmin/_sections/AuditLogPanel.tsx (the
  client island that renders the table; this is where the
  "View" toggle on the DIFF column lives)
- apps/web/app/admin/sysadmin/_lib/worker-fetch.ts (the helper
  used to fetch audit-log rows; no change needed but useful to
  confirm the row shape returned by `/sysadmin/api/audit-log`)

## Context

The audit-log panel on `/admin/sysadmin?mode=...` renders rows
in a 5-column table: WHEN / ACTOR / ACTION / TARGET / DIFF. The
DIFF column has a "View" toggle that, when clicked, expands the
JSON diff (action_payload before/after) inline INSIDE the DIFF
cell. The cell is sized to fit "View" / "Hide" labels — about
30-40px wide — so the expanded JSON is squeezed into that
sliver and effectively unreadable. Operator confirmed
2026-05-06: large diffs (e.g., update_packages_bulk on
williamsville) render as a vertical column of single
characters.

The right pattern is a full-width expanded row INSIDE the same
table: click "View" → a sibling row with `colSpan={5}` opens
below the original row, containing the formatted JSON in a
scrollable pre block. Click "Hide" → row collapses. Standard
expandable-row UX, common in admin tables.

## Scope

### Phase 1 — Refactor the DIFF column rendering

1.1 In `AuditLogPanel.tsx`, find the table body rendering. It
likely maps rows to `<tr>` elements with the DIFF cell
containing the View/Hide toggle and (when expanded) the JSON
content. Identify:

  - The state variable tracking which row IDs are currently
    expanded (likely a `Set<string>` or `Set<number>` keyed by
    `audit_log.id` or row index)
  - The `<td>` for the DIFF column
  - The renderer that formats the JSON (probably
    `JSON.stringify(payload, null, 2)` or similar)

1.2 Restructure so each audit row renders as TWO `<tr>` siblings
when expanded:

  - The primary row (5 cells: WHEN, ACTOR, ACTION, TARGET, DIFF
    toggle button)
  - A conditional sibling row when expanded:
    `<tr><td colSpan={5}><pre>{formattedJson}</pre></td></tr>`

  React fragment shape (key on outer fragment by row id):

```tsx
{rows.map((row) => {
  const isExpanded = expanded.has(row.id);
  return (
    <Fragment key={row.id}>
      <tr>
        <td>{formatWhen(row.occurred_at)}</td>
        <td>{row.actor_email}</td>
        <td>{row.action}</td>
        <td>{row.target_type}/{row.target_id}</td>
        <td>
          <button
            type="button"
            onClick={() => toggle(row.id)}
            className={diffToggleCls}
          >
            {isExpanded ? "▼ Hide" : "▶ View"}
          </button>
        </td>
      </tr>
      {isExpanded ? (
        <tr className="bg-sudsy-blue-soft/40">
          <td colSpan={5} className="px-4 py-3">
            <DiffBlock before={row.action_payload?.before} after={row.action_payload?.after} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
})}
```

Where `DiffBlock` is a small inline component (or just
inline JSX) that renders BEFORE and AFTER side-by-side:

```tsx
function DiffBlock({ before, after }: { before?: unknown; after?: unknown }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {before !== undefined ? (
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-splash-navy/60">
            Before
          </h4>
          <pre className="max-h-96 overflow-auto rounded-splash-sm border border-gray-light bg-white p-3 text-xs leading-relaxed text-splash-navy">
            {JSON.stringify(before, null, 2)}
          </pre>
        </section>
      ) : null}
      {after !== undefined ? (
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-splash-navy/60">
            After
          </h4>
          <pre className="max-h-96 overflow-auto rounded-splash-sm border border-gray-light bg-white p-3 text-xs leading-relaxed text-splash-navy">
            {JSON.stringify(after, null, 2)}
          </pre>
        </section>
      ) : null}
    </div>
  );
}
```

1.3 If the existing diff rendering already includes a
before/after split, preserve the data shape. The audit-log
payload shape comes from sysadmin-worker and is whatever the
existing component currently renders — don't change the data
contract, just the layout.

1.4 If the audit-log row only has a single payload field (no
before/after split), render it as a single full-width pre block
spanning `colSpan={5}` instead of the two-column grid.

### Phase 2 — Toggle button styling

2.1 The existing "View" button styling (the link-like text
toggle) is fine. Just ensure the button has:
  - `aria-expanded={isExpanded}` for accessibility
  - The arrow indicator flips between `▶` (collapsed) and `▼`
    (expanded) so the affordance is visually obvious

2.2 Don't add a separate "Hide" button inside the expanded row.
The single toggle button on the primary row both expands and
collapses. Keeps the UX consistent with the current pattern.

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass for all 13 packages.
3.2 `pnpm --filter @splash/web build` — must succeed.
3.3 No worker-side change. No new API. No CSS framework changes
(reuse existing Tailwind classes from the project).

### Phase 4 — Smoke test guidance (operator)

4.1 After apps/web auto-redeploys, navigate to
`/admin/sysadmin?mode=tables` (or whichever mode shows the
audit log). Find a row with a substantial diff — operator's
recent `update_packages_bulk` on williamsville is a good test
case (multi-row payload).

4.2 Click "View" → the diff should expand as a full-width row
underneath, with BEFORE and AFTER columns rendered as
formatted JSON in scrollable blocks. Each pre block is bounded
by `max-h-96` (24rem) so a huge diff doesn't push the page; the
operator scrolls within the pre to see overflow.

4.3 Click "Hide" (or "▼ Hide", whatever the toggle reads when
expanded) → row collapses, table returns to compact view.

4.4 Verify multiple rows can be expanded simultaneously (the
state is a Set, so each row's expansion is independent).

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 53 row added.

5.2 BUILD_STATE.md: Findings entry noting:
  - The audit log diff rendering was constrained to the DIFF
    column width, making large diffs unreadable
  - Brief 53 moves the diff to a full-width expanded sibling
    row with `colSpan={5}` and side-by-side BEFORE/AFTER blocks
  - Smoke test verified on update_packages_bulk on
    williamsville (operator-confirmed visible)

## Out of scope

- Changing the audit-log API or what the worker sends. The
  payload shape is unchanged.
- Adding a separate "diff modal" — full-width row expansion
  is sufficient and doesn't fight the existing table layout.
- Adding row-level diff highlighting (color-coded
  added/removed). The full JSON dump is fine for v1; a
  proper diff renderer (jsondiffpatch / react-diff-viewer)
  could be added later if operators ask for it.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- Audit log DIFF column shows only the toggle button on the
  primary row
- Clicking the toggle opens a full-width expanded row
  (`colSpan={5}`) below the primary row
- Expanded row renders BEFORE / AFTER (or a single payload
  block if no before/after split) as formatted JSON in
  scrollable `<pre>` blocks
- Multiple rows can be expanded independently
- Toggle button has correct aria-expanded state
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely ~30-50 lines net, depending on existing
  JSX structure)
- Confirmation that no API change was needed
- Validation results
- Any decisions made on the operator's behalf (e.g., whether
  the audit-log payload had before/after split or a single
  blob)

## Outcome

Completed 2026-05-06.

### Files created

- `apps/web/app/admin/sysadmin/_components/AuditRowExpandable.tsx`
  (~70 lines). Single `"use client"` island. Per-row local
  `useState<boolean>` for expansion. Accepts four cell contents
  (`whenCell`, `actorCell`, `actionCell`, `targetCell`) plus
  `diffContent` as `React.ReactNode` props, so all the server-side
  helpers stay on the server. Returns a Fragment containing the
  primary `<tr>` (5 cells; the DIFF cell holds only the toggle
  button) and a conditional sibling `<tr><td colSpan={5}>` when
  expanded. Toggle button carries `aria-expanded={isExpanded}` and
  the indicator flips ▶ View / ▼ Hide. Border styling: primary row
  drops its bottom border when expanded so there's no double
  separator between primary + expansion; expansion row carries the
  bottom border to separate from the next audit entry; expansion
  row gets a `bg-sudsy-blue-soft/40` tint to visually anchor the
  diff to its parent.

### Files modified

- `apps/web/app/admin/sysadmin/_sections/AuditLogPanel.tsx`
  (1) Added `import { AuditRowExpandable } from "../_components/AuditRowExpandable"`.
  (2) Rewrote `AuditRow` from a `<tr>` returner to an
      `AuditRowExpandable` invoker — passes the four cell nodes
      (using the existing `relativeTime`, `TargetCell`, etc.
      helpers) and a `<DiffBlock>` element as props.
  (3) Deleted the old inline `DiffCell` `<details>` renderer (the
      one that squeezed the JSON inside the ~30-40px DIFF cell).
  (4) Added a new server-side `DiffBlock` helper that renders the
      diff payload as side-by-side `<pre>` blocks on `md+`
      viewports (single full-width column on mobile or when only
      one side has data), each capped at `max-h-96` with
      `overflow-auto` so big diffs scroll within their pre. Falls
      back to a "No diff payload recorded for this entry." italic
      hint when both before/after are null. Notes (when present)
      render below the grid, preserving the prior `<details>`
      block's behavior.
- `BRIEFS/INDEX.md` — Brief 53 row appended with the standard
  one-line summary + status + dependency note + brief link.
- `BUILD_STATE.md` — bumped "Last updated" preamble to lead with
  Brief 53 (prior Brief 52 lead-in folded into "Earlier:");
  appended a Findings & decisions log entry summarizing the
  before/after, the per-row local state choice, the bundle delta,
  and the operator follow-up smoke tests.

### Decisions made on operator's behalf

1. **Per-row local `useState<boolean>` rather than a panel-level
   `Set<string>`.** The brief mentioned a Set as "the likely
   existing pattern," but the prior code didn't track expansion
   state at all (it used native `<details>`), so there's no
   incumbent Set to preserve. Per-row state is simpler and meets
   the "multiple rows independently expandable" requirement.

2. **Server-side `DiffBlock` helper rather than moving JSON
   formatting into the client island.** Keeps `JSON.stringify`
   work off the client bundle; the client island only flips a
   boolean. The diff DOM is pre-rendered server-side and shipped
   as a React node prop.

3. **Cell contents passed as `React.ReactNode` props.** The
   helpers (`relativeTime`, `TargetCell`, `jsonOrDash`) stay
   server-side and the relative-time string is "frozen" at request
   render — same posture as Brief 30 (no hydration mismatch on
   `Date.now()` since it only runs server-side).

4. **Empty-payload hint added.** The prior `<details>` block
   rendered an empty grid when both before/after were null;
   replaced with an explicit "No diff payload recorded for this
   entry." italic hint so an operator who clicks View on a no-op
   row sees why nothing's there. Doesn't change which rows have
   payload data.

5. **Notes preserved below the diff grid.** The prior `<details>`
   block included `notes` as a final paragraph; kept verbatim in
   the new `DiffBlock` layout under the BEFORE/AFTER grid.

6. **Toggle button styling** reuses the existing `text-splash-blue`
   link-text treatment from the prior summary, with the arrow
   indicator added inline (▶ View / ▼ Hide) instead of relying on
   the browser's default `<details>` triangle.

### Latent issues / forward flags

- (a) **No headless smoke test possible** — operator must verify
  on the next CF Workers Builds redeploy that clicking View on the
  recent williamsville `update_packages_bulk` row expands to a
  full-width row with side-by-side BEFORE/AFTER. The brief's
  Phase 4 enumerates the test cases.
- (b) **Bundle delta** — `/admin/sysadmin` route grew from
  7.06 kB → 8.38 kB / 113 kB First Load JS (was 112 kB).
  Acceptable for the readability win; the +1.32 kB is the new
  client island plus the `AuditRowExpandable` component code.
- (c) **`AuditRowExpandable` returns a Fragment-wrapping pair of
  `<tr>`s.** React 19 / Next 15 handle this cleanly inside a
  `<tbody>`. Future refactors must NOT wrap each row in a `<div>`
  — that would break HTML table semantics. The new component's
  leading comment flags this.
- (d) **No worker-side change.** The audit-log API contract is
  unchanged; only the rendering layout was refactored.

### Validation

- `pnpm typecheck`: **13/13 successful** (5.725s; 12 cache hits +
  fresh `@splash/web` rebuild — the one package modified).
- `pnpm --filter @splash/web build`: **succeeded**. `next build`
  compiled in 5.1s; all 11 routes generated cleanly.
  `/admin/sysadmin` route bundle 8.38 kB / 113 kB First Load JS
  (pre-Brief-53 baseline 7.06 kB / 112 kB → +1.32 kB / +1 kB
  FLJ). Middleware bundle 34.1 kB unchanged. All other route
  bundles unchanged.

### Diff size (per Report)

Net code: ~95 lines added (new client component ~70 lines + new
`DiffBlock` helper ~60 lines), ~40 lines deleted (old `DiffCell`
`<details>` renderer + the inline `<tr>` body of the prior
`AuditRow`). Roughly +55 lines net. Within the brief's predicted
~30-50 lines net (slight upward variance; the brief
underestimated the new server-side `DiffBlock` helper's footprint).

### No API change confirmed

The audit-log row shape (`AuditLogRow`) is unchanged. The
`before` / `after` / `notes` fields on each row are consumed
identically by the new `DiffBlock` helper and the prior
`DiffCell`. Worker-side endpoints (`GET /sysadmin/api/audit-log`)
are not touched.

### Operator follow-up smoke tests

After CF Workers Builds redeploys apps/web on push:

1. Navigate to `/admin/sysadmin?mode=tables` (or any mode that
   shows the audit log).
2. Filter to `update_packages_bulk` action or `pricing_simple`
   table; find the williamsville bulk-edit row.
3. Click ▶ View → expansion row opens directly underneath, full
   table width, with BEFORE on the left and AFTER on the right
   on a desktop viewport (single stacked column on mobile).
4. Click ▼ Hide → the expansion row collapses; the table returns
   to compact view.
5. Open two different rows simultaneously → confirm independence
   (each row's state is its own `useState<boolean>`).
6. Open a row whose payload has only `after` (e.g., a
   `create_user` audit entry) → confirm a single full-width AFTER
   pre block (no empty BEFORE column).
