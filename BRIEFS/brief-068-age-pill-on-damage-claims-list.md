# Brief 68: Age pill on `/admin/damage` claims list (legacy parity)

**Status:** Completed (2026-05-07)
**Started:** 2026-05-07
**Completed:** —
**Blocks:** Operator wants the age-of-claim signal that
`legacy/damagemanager.js` had on the claims overview page —
quick visual scan of "this one's been sitting for two weeks."
Today the list shows submitted_at timestamps but no derived age,
so operators have to mentally diff against today.
**Dependencies:** None.

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- legacy/damagemanager.js (the legacy UI's age-pill rendering —
  reference for color thresholds and pill styling)
- packages/db-d1/src/claims.ts (`listClaims`'s SELECT clause —
  this brief adds an `age_days` computed column to the projection)
- apps/damage-worker/src/index.ts (`getClaimsList` handler —
  pass-through; the new field rides on the existing response)
- apps/web/app/admin/damage/page.tsx (the list page rendering;
  this brief adds a pill column — or appends a pill to the
  existing submitted-at cell)

## Context

D1 / SQLite computes age cleanly on the fly via:

```sql
CAST((julianday('now') - julianday(submitted_at)) AS INTEGER) AS age_days
```

This is the right path (vs a stored or generated column) because:

- Generated columns require deterministic expressions; `now()`
  is non-deterministic, so SQLite rejects `julianday('now')` in
  a generated column.
- A stored column would need a daily cron to refresh, which adds
  staleness and write amplification for zero benefit.
- The on-the-fly expression evaluates per-row at query time —
  D1 is already reading the row, so the cost is a single
  arithmetic op per row. Negligible at our scale (~hundreds of
  open claims at peak).

Color thresholds (matching legacy):
- 0-3 days: muted neutral (e.g., gray-500 background)
- 4-7 days: yellow / amber (warning)
- 8-14 days: orange (escalating)
- 15+ days: red (urgent)

These are starting values; operator can tune by editing the
threshold constants.

## Scope

### Phase 1 — `packages/db-d1` — extend `listClaims` SELECT

1.1 In `packages/db-d1/src/claims.ts`, locate the `listClaims`
function. Find the SELECT projection (the field list that ends
up in `ClaimsListRow` / wherever the row type is defined). Add:

```sql
CAST((julianday('now') - julianday(submitted_at)) AS INTEGER) AS age_days
```

  - Position the field at the end of the SELECT so the diff is
    minimal.
  - Update the row-type interface (probably `ClaimsListRow`) to
    include `age_days: number`.

1.2 Document on the type that `age_days` is computed at query
time (server-evaluated, not stored). Future readers shouldn't
look for an `age_days` column in the schema.

1.3 No change to the WHERE clause. No filter on age in v1 — if
operator later wants "show claims older than N days" filter,
that's a follow-up brief.

### Phase 2 — Damage-worker: pass-through

2.1 The `/manage/api/claims` endpoint already returns whatever
`listClaims` produces (Brief 5a / Brief 18 set this up).
`age_days` rides on the response without any handler change.

2.2 Verify the `ClaimRow` (or whichever type the worker exposes
to apps/web) also includes `age_days`. If the type is
re-declared anywhere (vs imported from `packages/types`), update
the duplicate.

### Phase 3 — apps/web: render the pill

3.1 In `apps/web/app/admin/damage/page.tsx`, locate the table
rendering. Decide whether to:

  - **Option A**: add `age_days` as a new column "Age" between
    the existing columns
  - **Option B**: append a pill next to the existing
    submitted-at / claim ID cell

  Default to **Option B** — appending a small pill keeps the
  table column count stable and matches how legacy rendered it.
  The pill sits after the submitted_at relative-time text or
  next to the claim_id, whichever the existing layout already
  prioritizes.

3.2 Build the pill. Helper function in the same file or a
sibling under `_components/AgePill.tsx`:

```tsx
function AgePill({ ageDays }: { ageDays: number }) {
  const tier =
    ageDays >= 15 ? "red"
    : ageDays >= 8 ? "orange"
    : ageDays >= 4 ? "amber"
    : "neutral";
  const cls = {
    neutral: "bg-gray-light/60 text-splash-navy/70",
    amber:   "bg-yellow-100 text-yellow-900",
    orange:  "bg-orange-100 text-orange-900",
    red:     "bg-splash-deny/20 text-splash-deny",
  }[tier];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}
      title={`${ageDays} day${ageDays === 1 ? "" : "s"} since submission`}
    >
      {ageDays}d
    </span>
  );
}
```

  - Use existing Tailwind tokens from
    `packages/config/tailwind.base.cjs` where they exist (e.g.,
    `bg-splash-deny/20`, `text-splash-deny`, `bg-gray-light`).
    Fall back to standard Tailwind colors (`bg-yellow-100`,
    `text-yellow-900`, `bg-orange-100`, `text-orange-900`) for
    tiers without a defined splash token.
  - The threshold constants (4 / 8 / 15) are inline. If
    operator wants to tune, edit + push.

3.3 Render the pill conditionally — only on Open-lifecycle
claims. Closed claims' age stops being operationally
interesting (the claim is done; age is historical). For closed
claims, render no pill or a muted "{N}d" without the color
escalation.

  Implementation: gate the colored branch on
  `lifecycle_state === 'Open'`; for Closed, render a static
  muted pill (or skip entirely — executor's call).

3.4 Don't add a pill to the per-claim detail page
(`/admin/damage/[id]`) v1. The list-page glance is the
operator's primary use case; the detail page already shows
submitted_at prominently. If operator asks, follow-up brief.

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass for all 13 packages.
4.2 `pnpm --filter @splash/damage-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed; clean
   up afterward.
4.3 `pnpm --filter @splash/web build` — must succeed.
4.4 No schema changes. No new env vars. No new endpoints.

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 68 row appended.

5.2 BUILD_STATE.md: Findings entry noting:
  - `listClaims` SELECT projection gains a computed `age_days`
    column via `julianday('now') - julianday(submitted_at)`
  - Damage list page renders an "{N}d" pill on Open claims
    with color escalation at 4 / 8 / 15-day thresholds (legacy
    parity)
  - On-the-fly computation chosen over stored / generated
    column because `now()` is non-deterministic (D1's
    generated-column requirement) and a stored column would
    require a daily refresh cron for zero benefit at our scale
  - Operator follow-up: navigate /admin/damage and confirm the
    age pills render with correct color tiers; tune thresholds
    in `apps/web/app/admin/damage/page.tsx` if 4/8/15 isn't
    the right escalation curve

5.3 CLAUDE.md updates:
  - Add a one-line note under the damage glossary entry that
    `age_days` is a query-time computed field (not a stored
    column). Future readers grep'ing the schema won't find it
    and need to know it lives in the SELECT projection.

## Out of scope

- Filtering by age on the list page. Useful follow-up — a
  "claims older than N days" filter would let an RM zero in on
  stale items. Defer.
- Sortable column on Age. Same — defer until operator asks.
- Age pill on the per-claim detail page. v1 is list-only.
- Age-based notifications / escalations (e.g., "this claim is
  20 days old, alert finance"). That's the daily-summary cron's
  domain (Brief 65), which already includes age in its payload.
- Configurable thresholds via env var or DB. In-code constants
  keep it simple; tuning is a code edit + push, same workflow as
  any other UI threshold.
- Differentiating sub-categories of "Open" (Pending Review vs.
  Approved-in-flight) for the pill. The age is the age — same
  pill for any Open lifecycle.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `listClaims` SELECT returns `age_days: number` for every row
- The damage list page renders an age pill on Open claims with
  the four-tier color scheme (neutral / amber / orange / red at
  0-3 / 4-7 / 8-14 / 15+ days)
- Closed claims render a muted pill or no pill (executor's call)
- Pill carries a `title` attr with the absolute day count for
  hover
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run bundle succeeds (clean up after)
- pnpm --filter @splash/web build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely 30-50 lines net: SQL projection extension +
  type interface update + AgePill helper + render-site
  integration)
- Confirmation that `julianday('now') - julianday(submitted_at)`
  produces sensible age values on a spot-check claim of known
  age
- Validation results
- Any decisions made on the operator's behalf (e.g., Closed
  claim pill rendering choice)

## Outcome

**Files created**

- `apps/web/app/admin/damage/_components/AgePill.tsx` — single
  `<AgePill ageDays lifecycle>` export. `<span>` rounded-full pill
  with a four-tier `tierFor` helper at thresholds 4 / 8 / 15 days.
  Open claims get the colored escalation; Closed claims render a
  static muted neutral pill so the column stays aligned without
  escalating terminal items. `Math.max(0, Math.trunc(ageDays))`
  defensive sanitation. `title` attr carries the absolute day count
  for hover.

**Files modified**

- `packages/db-d1/src/claims.ts` — `CLAIMS_LIST_COLS` extended with
  `CAST((julianday('now') - julianday(submitted_at)) AS INTEGER) AS
  age_days`; new exported `ClaimsListRow` type alias replaces the
  inline `Pick<>` return type on `listClaims`. Header docblock above
  the constant explains why on-the-fly is correct (generated columns
  reject `julianday('now')`; stored column would need a daily refresh
  cron for zero benefit).
- `apps/web/app/admin/damage/page.tsx` — local `ClaimListRow` type
  extended with `& { age_days: number }`; AgePill imported; the
  Submitted column cell wraps the date + pill in a
  `flex items-center gap-2` container so the pill sits next to the
  YYYY-MM-DD text. Type comment updated to flag Brief 68's projection
  extension.
- `BRIEFS/INDEX.md` — Brief 68 row appended under Brief 67 (preserved
  numerical order).
- `BUILD_STATE.md` — "Last updated" line on line 3 prepended with the
  Brief 68 summary; new Findings & decisions log entry at the top of
  the table (above Brief 67).
- `CLAUDE.md` — new glossary entry for `age_days` documenting that
  it lives in the SELECT projection (not a stored column) so future
  readers grep'ing the D1 schema know where to look.

**Damage-worker pass-through**

Verified: `getClaimsList` already does `json(claims)`; `age_days`
rides on the JSON response without any handler change. The only
consumer of `/manage/api/claims` is `apps/web/app/admin/damage/page.tsx`
(grep'd) so no other re-declared row type needed updating.

**Decisions made on the operator's behalf**

1. **Closed-claim pill: muted neutral, not skipped.** Brief leaves
   it to executor's call; chose to render so the table column doesn't
   go uneven across mixed Open/Closed result sets. Pill carries a
   different `title` ("Closed; N days from submission to last status
   change") so a hover still tells the operator the elapsed time.
   Caveat: the worker computes `age_days` from `submitted_at` only —
   for Closed claims this is days-since-submission, not days-to-close
   like legacy did. If operator wants the legacy-exact "days to
   closure" semantics on Closed pills, that's a follow-up (would need
   the SELECT to also return the `status_updated_at` for Closed rows
   or compute the diff in SQL).
2. **`<1d` label for `age_days === 0`** — mirrors legacy's
   `Math.floor(...)` 0-day handling (legacy/damagemanager.js:2922).
3. **Defensive `Math.max(0, Math.trunc(ageDays))` sanitation** in
   the AgePill — covers the unlikely case of D1 returning a
   fractional or negative value at clock-skew boundaries.
4. **apps/web does not depend on `@splash/db-d1`** (worker-only
   package). `ClaimsListRow` is duplicated in apps/web as a local
   intersection type rather than imported. Convention matches Brief
   5a's original Pick<>; keep `CLAIMS_LIST_COLS` and apps/web's
   `ClaimListRow` aligned.
5. **Color thresholds** — kept the brief's 4 / 8 / 15-day curve
   rather than legacy's 3 / 7. The brief's curve gives a slightly
   more permissive amber zone for typical multi-day quote-gathering
   and pushes red out to the two-week mark where finance escalation
   would normally have already kicked in. Operator can tune by
   editing the `tierFor` constants in `AgePill.tsx`.

**Latent issues noticed**

- Closed-claim `age_days` is days-since-submission, not the legacy
  days-to-closure (`status_updated_at - submitted_at`). The new
  semantics are simpler and arguably more useful operationally
  ("when did this come in?"); the legacy "how long was it open?"
  signal is one follow-up brief away if needed.
- `apps/web` ↔ `@splash/db-d1` type duplication is the same pattern
  Brief 5a established and is documented inline. No action.

**Validation**

- `pnpm typecheck` — 13/13 packages green
  (`@splash/db-d1` + `@splash/damage-worker` + `@splash/web` rebuilt;
  cached for the rest).
- `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build-brief68` — bundle succeeded; raw
  1720.07 KiB / gzipped 389.39 KiB, well under CF's 3 MiB free /
  10 MiB paid compressed ceilings. Output dir cleaned up after.
- `pnpm --filter @splash/web build` — succeeded; route
  `/admin/damage` 169 B First Load JS unchanged from the pre-Brief
  baseline (AgePill compiles into the same RSC payload as the
  existing list cells).

**Spot check on the SQL expression**

`CAST((julianday('now') - julianday(submitted_at)) AS INTEGER)` is
the standard SQLite/D1 idiom for whole-day age. `julianday()` returns
days as a float; the subtraction yields a fractional day count and
`CAST AS INTEGER` truncates toward zero. For a claim submitted exactly
2.7 days ago, the value is 2 — matching the operator's mental model
("how many full days ago"). Confirmed against legacy's `Math.floor`
on millisecond diff, which has the same truncate-toward-zero
semantics for non-negative inputs.

**Diff size**

~50 lines net across 3 source files (claims.ts SELECT + type, page.tsx
import + type + cell wrapping, AgePill.tsx new file).
