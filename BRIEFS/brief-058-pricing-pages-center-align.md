# Brief 58: Center-align pricing pages to match sysadmin / damage / performance / signups convention

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Visual consistency across the four /admin/* sections.
Pricing landing + per-location currently render flush-left via
inline `<section style={{ padding: 24, maxWidth: N }}>`; sysadmin,
damage, performance, and the new signups pages (Brief 56) all
center via `<section className="mx-auto w-full max-w-[N] px-5
py-9">`. Operator confirmed 2026-05-06: pricing should match
the centered convention rather than make four other surfaces
left-align.
**Dependencies:** None.

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-056-signup-admin-rename-and-signups-viewer.md
  (the brief that surfaced the inconsistency by adding the new
  centered signups pages alongside the older left-aligned
  pricing pages)
- apps/web/app/admin/pricing/page.tsx (3 `<section>` blocks at
  L27, L49, L66 — all inline-style)
- apps/web/app/admin/pricing/[location]/page.tsx (4-5
  `<section>` blocks across the auth/access-error states + main
  view, all inline-style)
- apps/web/app/admin/sysadmin/page.tsx (~L52 — reference for
  the centered pattern: `mx-auto w-full max-w-[820px] px-5 py-9`)
- apps/web/app/admin/damage/page.tsx (~L116, L137, L172 —
  `max-w-[1100px]` variant for wider content)
- apps/web/app/admin/signups/page.tsx (~L27, L52, L68 —
  Brief 56's centered sections; reference for landing layout)
- apps/web/app/admin/signups/[location]/page.tsx (~L48, L72,
  L88, L114 — Brief 56's centered per-location layout)

## Context

Four admin sections (sysadmin, damage, performance, signups) use:

```tsx
<section className="mx-auto w-full max-w-[N] px-5 py-9">
```

Pricing (the older surface) still uses:

```tsx
<section style={{ padding: 24, maxWidth: N }}>
```

The semantic difference is `mx-auto`: with it, the section centers
within its parent; without it, the section sits flush-left.
Operator's screenshot 2026-05-06 shows the visual stagger when
flipping from a left-aligned Pricing tab to a centered Signups
tab on the same per-location URL — the page "jumps" sideways.

Fix: convert Pricing's inline-style sections to the same
Tailwind utility-class centered pattern. Same widths, same
behavior, just the wrapper class changes.

Width mapping:
- Pricing landing (L27, L49) auth/empty error states:
  `maxWidth: 480` / `maxWidth: 520` → `max-w-[520px]` (collapse
  the two near-identical widths to one for consistency)
- Pricing landing (L66) main view: `maxWidth: 720` →
  `max-w-[820px]` (matches sysadmin's main-view width — the
  landing card grid renders cleanly at either)
- Pricing per-location (auth errors): `maxWidth: 520` →
  `max-w-[520px]`
- Pricing per-location (main view): `maxWidth: 880` →
  `max-w-[880px]` (preserve the wider canvas — the pricing
  grid table needs the room)

## Scope

### Phase 1 — Convert pricing landing page

1.1 In `apps/web/app/admin/pricing/page.tsx`, locate the three
`<section style={{ padding: 24, maxWidth: N }}>` blocks (~L27,
L49, L66) and convert each to the centered Tailwind pattern:

```tsx
// Auth/error states (L27, L49):
<section className="mx-auto w-full max-w-[520px] px-5 py-9">

// Main view (L66):
<section className="mx-auto w-full max-w-[820px] px-5 py-9">
```

1.2 Inside the converted sections, the existing children (h1,
links, location-card grid) keep their inline-style or Tailwind
treatment unchanged. The only change is the outer `<section>`
wrapper. Don't touch interior `style={{ ... }}` blocks (e.g.,
the location-card grid's `display: grid` style) unless they
conflict with the new wrapper — they don't.

1.3 Remove the now-stale `style={{ padding: 24, maxWidth: ... }}`
attribute on the `<section>` element. Tailwind's `px-5 py-9` +
`mx-auto` + `max-w-[N]` covers the same layout intent.

### Phase 2 — Convert pricing per-location page

2.1 In `apps/web/app/admin/pricing/[location]/page.tsx`, locate
each `<section style={{ ... }}>` block — there are four to five
of them spanning the auth-required, access-denied, and main
render branches.

2.2 Convert each to the centered Tailwind pattern. Use:
  - `max-w-[520px]` for auth/access error states
  - `max-w-[880px]` for the main view (preserves the wider
    pricing-grid canvas)
  - `px-5 py-9` for spacing (same as sysadmin/signups)
  - `mx-auto w-full` for centering

2.3 The interior `<PricingGrid ...>` client component does NOT
need any change — it expands to fill its parent. The outer
section wrapper is the only thing changing.

2.4 If any interior `<h1>` or `<p>` in the existing pricing
page uses inline-style font-weight/color tokens, leave them
alone. This brief is layout-only — typography and color
treatments stay as-is.

### Phase 3 — Sanity check sibling files

3.1 Confirm no other file under `apps/web/app/admin/pricing/`
has its own `<section style={{ ... }}>` wrapper that should
also be converted. If a `_components/` or `_lib/` file
renders a section wrapper, convert it consistently. (At time
of brief drafting, the only two files with section wrappers
are the two listed above; this is just a defensive sweep.)

3.2 Do NOT touch any other admin page (sysadmin, damage,
performance, signups, dashboard) — they're already on the
centered convention. This brief is pricing-only.

3.3 Do NOT touch the customer-facing routes
(`/signup/{location}`, `/q/{location}`, `/join/{location}`,
`/claims/{site}`) — those are owned by their respective
workers, not apps/web, and have completely different layout
treatments (worker-rendered HTML strings with inline CSS).

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass for all 13 packages. (This
brief is JSX-class-attribute-only; no type changes expected.)
4.2 `pnpm --filter @splash/web build` — must succeed. Bundle
size delta should be ~0 (Tailwind classes are pre-compiled into
the existing CSS).
4.3 No worker-side change. No new endpoints. No schema
changes. No new env vars.

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 58 row appended.

5.2 BUILD_STATE.md: Findings entry noting:
  - Pricing pages converted from inline-style left-aligned
    `<section>` wrappers to centered Tailwind
    (`mx-auto w-full max-w-[N] px-5 py-9`)
  - Width mapping: 520px for auth/error states (was 480/520
    inconsistent), 820px for landing main view (was 720), 880px
    for per-location main view (preserved)
  - Convention now consistent across all four /admin/* sections:
    sysadmin, damage, performance, signups, pricing
  - Operator follow-up: navigate /admin/pricing → /admin/signups
    via the tab nav and confirm the layout no longer "jumps"
    sideways on the flip

5.3 CLAUDE.md unchanged — section width is a layout choice, not
a behavior contract worth documenting at the project level. The
existing centered pattern is already implicit in every
existing admin page.

## Out of scope

- Migrating any non-admin file's inline-style `<section>` to
  Tailwind. Pricing happens to be the inconsistent one because
  it's the older surface; later refactors should default to
  Tailwind without needing a brief.
- Changing the column width of the pricing grid table itself.
  The table sits inside the section; only the wrapper changes.
- Adjusting the `<Header>` component's centering behavior.
  Header lives at the layout level and is already correct.
- Adding a layout `<main>` wrapper that auto-centers everything.
  That'd be a broader refactor — defer.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/web/app/admin/pricing/page.tsx`: all three `<section>`
  blocks use `<section className="mx-auto w-full max-w-[N]
  px-5 py-9">` with appropriate widths
- `apps/web/app/admin/pricing/[location]/page.tsx`: all
  `<section>` blocks (4-5) use the same centered Tailwind
  pattern with appropriate widths
- No remaining `style={{ padding: 24, maxWidth: ... }}` patterns
  on any `<section>` in `apps/web/app/admin/pricing/`
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely 15-25 lines net: ~7-8 wrapper rewrites)
- Confirmation that flipping between Pricing and Signups tabs
  on the same location URL no longer causes a horizontal jump
- Validation results
- Any decisions made on the operator's behalf (e.g., width
  choices for the auth-error vs. main-view variants)

## Outcome

**Files created:** none.

**Files modified:** 4 —
- `apps/web/app/admin/pricing/page.tsx` (3 `<section>` wrapper rewrites)
- `apps/web/app/admin/pricing/[location]/page.tsx` (2 `<section>` wrapper rewrites)
- `BRIEFS/INDEX.md` (Brief 58 row appended)
- `BUILD_STATE.md` (Last updated bumped, Findings entry inserted, work-list update via the same Findings narrative — no separate Open-work-prioritized row was added since this brief is a layout polish that closes a Brief-56 follow-up rather than an audit-tracked item)

**What changed (concrete diff per wrapper):**
- `apps/web/app/admin/pricing/page.tsx` L27: `<section style={{ padding: 24, maxWidth: 480 }}>` → `<section className="mx-auto w-full max-w-[520px] px-5 py-9">` (auth-error branch — width collapsed from 480 → 520 to match the sibling no-locations branch).
- `apps/web/app/admin/pricing/page.tsx` L49: `<section style={{ padding: 24, maxWidth: 520 }}>` → `<section className="mx-auto w-full max-w-[520px] px-5 py-9">` (no-locations branch).
- `apps/web/app/admin/pricing/page.tsx` L66: `<section style={{ padding: 24, maxWidth: 720 }}>` → `<section className="mx-auto w-full max-w-[820px] px-5 py-9">` (main location-picker view — width raised from 720 → 820 to match sysadmin's main-view canvas; the location-card grid uses `auto-fill, minmax(220px, 1fr)` so it expands to fill the wider canvas naturally).
- `apps/web/app/admin/pricing/[location]/page.tsx` L56: `<section style={{ padding: 24, maxWidth: 520 }}>` → `<section className="mx-auto w-full max-w-[520px] px-5 py-9">` (no-access branch).
- `apps/web/app/admin/pricing/[location]/page.tsx` L78: `<section style={{ padding: 24, maxWidth: 880 }}>` → `<section className="mx-auto w-full max-w-[880px] px-5 py-9">` (main view — width preserved because the `<PricingGrid>` table needs the wider canvas).

Net diff size: ~5 line replacements (one per wrapper); no new imports, no new components.

**Decisions made on the operator's behalf:**
1. **Auth-error widths collapsed to 520px** — the brief explicitly suggested collapsing the two near-identical 480/520 values to a single 520; landed as specified.
2. **Landing main view width 820px** — the brief suggested 820 to match sysadmin's main-view width; landed as specified.
3. **Per-location main view kept at 880px** — preserved per brief; the pricing grid was designed against 880 and narrowing would force horizontal scrolling.
4. **No interior style cleanup** — interior `style={{ ... }}` blocks (location-card grid `display: grid`, h1 `marginBottom`, p `color: #6b7280`, monospace per-location code, etc.) were intentionally left untouched. Brief is layout-only.
5. **No `<PricingGrid>` change** — the client component expands to fill its parent; the outer section wrapper is the only thing changing.
6. **Phase 3 sanity sweep** — confirmed via `grep -n '<section'` that the only files under `apps/web/app/admin/pricing/` with `<section>` wrappers are the two listed above (`grid.tsx` + `_components/PackagePickerModal.tsx` have no section wrappers). No further conversions needed.

**Latent issues found:** none. The conversion was mechanical and the build was clean.

**Forward flags:**
- **Operator follow-up:** navigate `/admin/pricing/{loc}` → `/admin/signups/{loc}` via the tab nav (e.g., `binghamton`) and confirm the layout no longer jumps sideways on the flip. Both pages should now share the same horizontal anchor (centered within the viewport via `mx-auto`).
- **Bundle delta:** `/admin/pricing` route 167 B / 105 kB First Load JS; `/admin/pricing/[location]` 3.66 kB / 109 kB First Load JS — both essentially unchanged from pre-brief baseline. Tailwind classes (including the JIT-arbitrary `max-w-[520px]` / `max-w-[820px]` / `max-w-[880px]`) are pre-compiled into the existing CSS bundle, so no measurable JS delta.
- **No worker-side change, no API change, no schema change, no new env vars** (per brief Phase 4.3).

**Validation results:**
- `pnpm typecheck` — 13/13 packages successful (12 cache hits + fresh `@splash/web` rebuild — only modified package; 4.56s total).
- `pnpm --filter @splash/web build` — succeeded. Next.js 15.5.15 compiled in 4.0s, 12 static pages generated, all 14 routes present (including `/admin/pricing` and `/admin/pricing/[location]`). Build trace clean.
- No new permission prompts, no new dev-only warnings, no Wrangler interaction (no worker change).
