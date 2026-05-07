# Brief 69: Age pill — collapse to two-tier thresholds (neutral / yellow at >3d / red at >10d)

**Status:** Completed (2026-05-07)
**Started:** 2026-05-07
**Completed:** 2026-05-07
**Blocks:** Operator's preferred urgency curve. Brief 68 shipped a
four-tier pill (neutral / amber / orange / red at 4 / 8 / 15 day
thresholds) matching legacy. Operator's 2026-05-07 review:
prefers a tighter two-tier signal — yellow over 3 days, red over
10 days — to match how they read the list day-to-day. Fewer color
changes makes urgency clearer at a glance.
**Dependencies:** Brief 68 (the AgePill component this brief
patches).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-068-age-pill-on-damage-claims-list.md (the
  component this brief modifies — `AgePill` helper in
  `apps/web/app/admin/damage/page.tsx` or
  `apps/web/app/admin/damage/_components/AgePill.tsx` if
  extracted)

## Context

Brief 68's tier mapping:

```
0-3:   neutral (gray)
4-7:   amber  (yellow)
8-14:  orange
15+:   red
```

Operator's 2026-05-07 ask: collapse to two tiers.

```
0-3:   neutral (unchanged)
4-10:  yellow
11+:   red
```

Three substantive changes:
1. Drop the orange tier entirely (8-14 day claims now render yellow)
2. Move the red threshold from 15 → 11
3. Keep yellow's 4-day floor unchanged

Net effect: claims aged 4-10 days are still yellow (Brief 68's
amber + Brief 68's 8-10 day slice of orange). Claims aged 11-14
days were orange under Brief 68; now red. Claims aged 15+ are
still red.

## Scope

### Phase 1 — Update the AgePill thresholds

1.1 In whichever file Brief 68's `AgePill` helper lives
(`apps/web/app/admin/damage/page.tsx` or a sibling component
file), find the tier-selection logic. Brief 68 wrote:

```ts
const tier =
  ageDays >= 15 ? "red"
  : ageDays >= 8 ? "orange"
  : ageDays >= 4 ? "amber"
  : "neutral";
```

Replace with:

```ts
// Brief 69 (2026-05-07): two-tier urgency curve. Yellow at >3d,
// red at >10d. Operator's ask: fewer color changes makes the
// signal clearer at a glance.
const tier =
  ageDays >= 11 ? "red"
  : ageDays >= 4 ? "yellow"
  : "neutral";
```

1.2 Update the `cls` map. Brief 68's amber and orange entries are
both removed; "yellow" replaces amber's slot. Concretely:

```ts
const cls = {
  neutral: "bg-gray-light/60 text-splash-navy/70",
  yellow:  "bg-yellow-100 text-yellow-900",
  red:     "bg-splash-deny/20 text-splash-deny",
}[tier];
```

  - Yellow's classes mirror Brief 68's `amber` exactly — only the
    key name changes (cosmetic / for clarity).
  - Drop the `amber` and `orange` keys; they're no longer
    referenced.

1.3 Update the title attribute hint if Brief 68 included
threshold-specific copy (it shouldn't — Brief 68's title was just
`{N} day{s} since submission`, which stays accurate).

1.4 Don't touch any other rendering — the pill's shape, position,
font size, and the gating on `lifecycle_state === 'Open'` stay
exactly as Brief 68 set them.

### Phase 2 — Validation

2.1 `pnpm typecheck` — must pass for all 13 packages.
2.2 `pnpm --filter @splash/web build` — must succeed.
2.3 No worker-side change. No new endpoints. No schema changes.
   No new env vars.

### Phase 3 — Updates

3.1 BRIEFS/INDEX.md: Brief 69 row appended.

3.2 BUILD_STATE.md: Findings entry noting:
  - AgePill thresholds collapsed from four-tier (Brief 68) to
    two-tier per operator's 2026-05-07 ask: neutral 0-3d /
    yellow 4-10d / red 11+d
  - Closed-lifecycle pill rendering unchanged (still muted /
    static)
  - Operator follow-up: navigate /admin/damage and confirm
    Open-lifecycle claims older than 10 days now render red
    (e.g., the legacy test row aged 11d should escalate)

3.3 No CLAUDE.md change needed — Brief 68's glossary entry
covers the AgePill at a high level; tier specifics are an
implementation detail that lives in the component.

## Out of scope

- Adding more tiers back. Operator's preference is the
  two-tier curve; if needs change, edit + push.
- Restoring the orange middle tier. Yellow now covers 4-10d
  inclusive; the 8-10d slice that was orange under Brief 68 is
  now yellow.
- Changing the title attribute, position, font, or shape of
  the pill. Visual tweak only — color tiers.
- Applying the same threshold change to the daily-summary
  email's age field (Brief 65). The email's `age_days` is a
  raw integer in the JSON payload; PA renders it. If operator
  wants matching color thresholds in the email, that's a PA
  flow edit — out of code scope here.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `AgePill`'s tier-selection ternary uses the two thresholds:
  4 (neutral → yellow) and 11 (yellow → red)
- The `cls` map drops amber and orange entries; only neutral /
  yellow / red remain
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely 5-10 lines net: tier ternary + cls map)
- Confirmation that Brief 68's other AgePill behaviors
  (lifecycle gating, title attr, pill shape) are untouched
- Validation results
- Any decisions made on the operator's behalf

## Outcome

**Files modified (1):**
- `apps/web/app/admin/damage/_components/AgePill.tsx` — `Tier` type narrowed from `"neutral" | "amber" | "orange" | "red"` to `"neutral" | "yellow" | "red"`; `TIER_CLASSES` map drops the `amber` and `orange` keys, renames `amber`'s slot to `yellow` (same Tailwind classes — `bg-yellow-100 text-yellow-900`); `tierFor` ternary collapsed from four-tier (≥15 / ≥8 / ≥4) to two-tier (≥11 / ≥4). Header docblock updated with a Brief 69 paragraph explaining the curve change. Title attribute, lifecycle gating, pill shape/font/position untouched.

**Files created:** none.

**Diff size:** ~16 lines net (docblock comment expanded slightly + Tier type narrowing + cls map shrink + ternary simplification). The mechanical edits are 1 type alias, 3 map entries (drop amber, drop orange, rename amber→yellow), and 1 ternary branch (drop the orange-tier branch, move red-tier threshold from 15→11).

**Validation:**
- `pnpm typecheck` — PASS (13/13 packages green; @splash/web cache miss, all others cached).
- `pnpm --filter @splash/web build` — PASS. `/admin/damage` route still 169 B First Load JS (unchanged from Brief 68 baseline; the AgePill component compiles into the same RSC payload as before).
- No worker change, no API change, no schema change, no env var change.

**Brief 68 behaviors preserved:**
- Lifecycle gating: Closed claims render the static muted neutral pill (`TIER_CLASSES.neutral`); only Open claims pick up tier escalation.
- `<1d` label for `age_days === 0`; `${days}d` otherwise.
- Title attribute: `${days} day(s) since submission` for Open; `Closed; ${days} day(s) from submission to last status change` for Closed.
- Pill shape: `inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold`.
- Defensive `Math.max(0, Math.trunc(ageDays))` sanitation on input.

**Decisions made on operator's behalf:**
- The brief's `Tier` examples used inline ternary; I kept Brief 68's named `tierFor` helper instead of inlining, because the helper's three early-return branches are easier to grep for the next operator who wants to tune thresholds. Single-edit point preserved.
- Kept the existing comment-block at the top of the file but extended it with a Brief 69 paragraph (replacing the now-stale "Thresholds (4 / 8 / 15 days)" line) so a future reader sees the rationale for the two-tier curve next to the constants.

**Latent issues found:** none. The change is mechanical and isolated to a single component file.

**Operator follow-up:** navigate `/admin/damage` and confirm Open-lifecycle claims aged 11+ days now render red (e.g., the legacy test row aged 11d should escalate from amber/orange under Brief 68 to red under Brief 69). Yellow now covers the full 4-10d range.
