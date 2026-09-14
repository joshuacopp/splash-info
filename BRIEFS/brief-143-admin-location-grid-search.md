# Brief 143: searchable location grid on /admin/pricing and /admin/signups

**Status:** Completed (2026-05-29)
**Started:** 2026-05-29
**Completed:** 2026-05-29
**Blocks:** Neither
**Dependencies:** none

## Read first
- BUILD_STATE.md
- CLAUDE.md
- apps/web/app/admin/pricing/page.tsx
- apps/web/app/admin/signups/page.tsx
- apps/web/app/admin/_components/SignupAdminTabs.tsx (sibling component for layout cues)
- legacy/signupworker.js or legacy/signup_worker_with_BOGO.js — search the
  `renderUserLocations` function for the existing `.toolbar` + `#locationSearch`
  + `#locationCount` pattern. The legacy admin already does this filter
  client-side; the goal here is to replicate the same UX on apps/web's
  per-tab landing pages.

## Context

Multi-location operators on `/admin/pricing` and `/admin/signups` see a
single flat grid of every location they can access. For super_admin users
that's ~60+ cards, which forces scrolling to find a specific site. The
legacy admin already offered a search filter at the top of its
multi-location card view; apps/web's versions of these landing pages
don't.

Both pages are server components that fetch the user's accessible
locations from signup-worker `/admin/api/locations` and render a grid of
cards. The fix is a small client island above the grid: a search input
that filters cards by `location_pretty` OR `location_code` (case-
insensitive substring match), plus a count badge ("12 of 64").

Behavior to preserve: the redirect-to-single-location case on
`/admin/pricing` (when `locations.length === 1`), the no-access /
no-locations error states, the per-tile rendering (Pricing shows
`Mode: <mode>`, Signups shows the `location_code` slug). The search just
filters which tiles are visible.

## Scope

1. **New shared component
   `apps/web/app/admin/_components/LocationSearchGrid.tsx`** (client
   island, `"use client"`):
   - Props:
     ```ts
     interface LocationItem {
       location_code: string;
       location_pretty: string;
       /** Free-form secondary line. Pricing passes `Mode: <pricing>`;
        *  Signups passes the `location_code` slug. */
       secondaryLine: ReactNode;
     }
     interface LocationSearchGridProps {
       locations: LocationItem[];
       /** Built once per item — e.g. `/admin/pricing/${code}`. */
       hrefFor: (loc: LocationItem) => string;
       /** Optional placeholder; defaults to "Search locations…". */
       placeholder?: string;
     }
     ```
   - Renders a search input + count badge above the existing grid.
     Filter logic: case-insensitive substring match against
     `location_pretty` OR `location_code`. Empty query shows
     everything.
   - Use `useState` for the query, `useMemo` for the filtered list, and
     `useDeferredValue` to avoid input lag on large lists (60+
     locations is small but cheap to be defensive).
   - Grid styles match the existing inline styles on the two pages
     (`gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))"`,
     `gap: 12`) and tile styles match the page-specific ones (use the
     same Tailwind classes already in place — see signups/page.tsx for
     the canonical block + hover treatment).
   - Empty-results state: show muted text "No locations match
     '{query}'."
   - Count badge format: `{visible} of {total}` — visible when query
     is non-empty, hidden when query is empty (matches legacy).
   - Autofocus the input on mount, and select all on focus so a user
     can immediately overwrite.

2. **Refactor `apps/web/app/admin/pricing/page.tsx`** to use
   `<LocationSearchGrid>`:
   - Build the `LocationItem[]` from the worker response:
     `{ location_code, location_pretty, secondaryLine: <span>Mode: {pricing || "—"}</span> }`.
   - Pass
     `hrefFor={(loc) => \`/admin/pricing/${loc.location_code}\`}`.
   - Keep the error states (no data, zero locations) AND the
     single-location redirect EXACTLY as today. Only the multi-
     location branch (`locations.length > 1`) is replaced.

3. **Refactor `apps/web/app/admin/signups/page.tsx`** the same way:
   - secondaryLine: the existing
     `<span className="font-mono text-xs text-splash-navy/60">{location_code}</span>`.
   - hrefFor:
     `(loc) => \`/admin/signups/${encodeURIComponent(loc.location_code)}\``.
   - Keep error states + zero-locations branch unchanged. There is no
     single-location redirect on this page today; do NOT add one.

4. **Styling**
   - The search input should match the broader admin look — splash-navy
     border on focus, 1.5px border, rounded-sm, comfortable mobile tap
     target. Reuse Tailwind classes already in use on the project
     where possible (`border-gray-light`, `text-splash-navy`, etc.) so
     the input feels native.
   - On narrow screens (`max-width: 600px`) the input goes full-width,
     count badge wraps below.

## Configuration

No new env vars or secrets.

## Out of scope

- Don't introduce a debounce library or any new dependency. `useState`
  + `useDeferredValue` is enough; the lists are tiny.
- Don't move the filter server-side. Server already returns the full
  accessible-locations list in one round-trip; client-side filtering
  has no latency cost and no privacy concern (the user already has
  every row).
- Don't fetch from a different endpoint. The existing
  `/admin/api/locations` worker call carries everything we need.
- Don't add sort controls; alphabetical-by-pretty (the order the
  worker returns) is sufficient.
- Don't add multi-select / bulk actions to these landing pages — that
  surface stays scoped to "pick one location and drill in".
- Don't deploy to Cloudflare; don't bind production routes; don't
  commit to git or push.

## Definition of done

- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `apps/web/app/admin/_components/LocationSearchGrid.tsx` exists,
  marked `"use client"`, exports a default React component with the
  props above.
- `/admin/pricing` and `/admin/signups` (the multi-location branch on
  each) render a search input above the card grid. Typing filters the
  visible cards instantly; clearing the input restores everything.
- Filter matches against both `location_pretty` and `location_code`
  (e.g., typing `bing` finds "Binghamton"; typing `cherry_hill` finds
  "Cherry Hill").
- Single-location redirect on `/admin/pricing` still fires before the
  grid renders. Zero-location and no-access states still render the
  appropriate copy on both pages.
- BUILD_STATE.md updated: bump "Last updated", add a Findings entry
  ("Brief 143: searchable location grid landed on /admin/pricing and
  /admin/signups").

## Report

- Whether the shared component picked up additional reuse opportunities
  (e.g., /admin/fleet has its own list page — note if it could move to
  the same primitive in a future brief, but don't migrate it here).
- Any styling quirks where the two existing pages diverged (Pricing
  uses inline styles, Signups uses Tailwind classes) and how the
  component reconciled them.
- Whether `useDeferredValue` was actually needed at this list size, or
  whether plain `useState` + `useMemo` would have been fine — record
  for future similar work.

## Outcome

**Files created.**
- `apps/web/app/admin/_components/LocationSearchGrid.tsx` (~100 LOC) —
  `"use client"` shared client island. Default-exports `LocationSearchGrid`.
  Re-exports `LocationItem` + `LocationSearchGridProps` interfaces matching
  the brief's Scope contract verbatim. Uses `useState` for the query,
  `useDeferredValue` to drive the filter input lag-free, `useMemo` for
  the filtered list, `useRef` + `useEffect` to autofocus the input on
  mount, and `onFocus={(e) => e.currentTarget.select()}` for the
  select-all-on-focus UX. Filter is case-insensitive substring match
  against `location_pretty` OR `location_code`. Empty query shows the
  full list; non-empty query shows the count badge `{visible} of {total}`
  (parity with legacy `#locationCount`). Empty-results state renders
  muted text `No locations match '{query}'.`. Grid uses inline style
  `gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))"` +
  `gap: 12` (matches both pages' existing inline preset). Tile uses
  Tailwind classes from signups (canonical block + hover treatment):
  `block rounded-splash-md border border-gray-light bg-white px-4 py-3
  text-splash-navy hover:border-splash-blue/50 hover:shadow-splash-card-hover`.
  Tile link is `next/link` `<Link>` (canonical signups behavior — gives
  client-side nav).
  Search input: `w-full rounded-splash-sm border-[1.5px] border-gray-light
  bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40
  focus:border-splash-navy focus:outline-none sm:max-w-[360px]`. Filter
  row uses `flex-col items-stretch gap-2 sm:flex-row sm:items-center
  sm:gap-3` so on narrow screens (Tailwind `sm` default 640px — close
  enough to the brief's 600px target; the difference is cosmetic at the
  layout-stack boundary) the input goes full-width and the count badge
  wraps below.

**Files modified.**
- `apps/web/app/admin/pricing/page.tsx` — replaced the multi-location
  grid branch with `<LocationSearchGrid>`. Builds `LocationItem[]` with
  `secondaryLine: <span className="text-xs text-splash-navy/60">Mode:
  {pricing || "—"}</span>` (Tailwind tokens approximate the prior
  `fontSize: 13, color: "#6b7280"` inline styling). `hrefFor=(loc) =>
  \`/admin/pricing/${loc.location_code}\``. The single-location
  `redirect()` branch, the no-data 401/403 branch, and the
  zero-locations branch are unchanged — only the `locations.length > 1`
  render block was refactored.
- `apps/web/app/admin/signups/page.tsx` — replaced the grid block with
  `<LocationSearchGrid>`. `secondaryLine: <span className="font-mono
  text-xs text-splash-navy/60">{location_code}</span>` (verbatim from
  prior render). `hrefFor=(loc) => \`/admin/signups/${encodeURIComponent(
  loc.location_code)}\``. No single-location redirect introduced (per
  brief's Scope item 3). Error states preserved.

**Decisions made on operator's behalf.**
1. Used `next/link` `<Link>` in the shared component (canonical signups
   behavior) rather than raw `<a>` (legacy pricing behavior). Client-
   side nav is the better UX; the signups page has used it since
   Brief 56 without issue.
2. Used Tailwind's `sm:` breakpoint (640px) for the responsive stack
   rather than an inline `@media (max-width: 600px)` to honor the
   brief's intent (stack on narrow, side-by-side on wider screens).
   The difference at 600 vs 640 is cosmetic and falls cleanly inside
   Tailwind's existing design tokens — keeps the component free of
   custom CSS.
3. `useDeferredValue` was kept per the brief's "defensive" recommendation.
   At ~60-location list sizes plain `useState` + `useMemo` would have
   sufficed (sub-millisecond filter time), but `useDeferredValue`
   costs nothing and future-proofs against a 200+ location scale.
   No new dependencies introduced.
4. Search input placeholder defaults to "Search locations…" (ellipsis
   character) — both pages use it; brief allowed override but neither
   page needed one.
5. Empty-results message uses curly single quotes `‘…’` (HTML entities
   `&lsquo;` / `&rsquo;`) for typographic consistency with the rest of
   the codebase. Brief sample showed straight quotes; visually
   equivalent.
6. Tile renders `secondaryLine` inside a `<div className="mt-0.5">`
   wrapper to handle the small vertical gap below the title; styling
   on the secondary text itself (size / color / monospace) lives on
   the page-provided inner `<span>`. Keeps the shared component
   layout-only, page-specific look-and-feel page-controlled.
7. The count badge uses `role="status"` + `aria-live="polite"` so
   screen readers announce filter progress without interrupting.

**Latent issues / forward flags.**
- `/admin/fleet` (Brief 83) renders its own list page directly on
  `apps/web/app/admin/fleet/page.tsx` with a different row schema
  (status pill, splash_notes, submitted_at — not a per-location
  picker). It is NOT a candidate for `LocationSearchGrid` directly;
  the primitive is purpose-built for per-location pickers
  (`location_code` + `location_pretty` + a single secondary line).
  Other surfaces that could reuse this primitive in a future brief
  if they grow location-picker entry points:
  `/admin/jotform/{form_id}` (currently uses a FilterBar dropdown)
  and `/admin/forms/{id}/submissions` (currently uses a Location
  filter dropdown). Neither is a single-cards-grid landing today
  so the migration would be a redesign, not a refactor — flag only.
- Two minor style divergences between Pricing (inline styles) and
  Signups (Tailwind) reconciled toward Signups (canonical Tailwind
  classes on the tile + hover treatment, inline grid layout
  preserved because both pages had the same inline preset and
  Tailwind has no exact `repeat(auto-fill, minmax(220px, 1fr))`
  equivalent without arbitrary values). Result: visual parity
  with signups, slight visual change on pricing (e.g., hover
  shadow + slight border-color shift toward splash-blue/50 vs
  prior static `#dbdbdb`). Both pages now visually match.
- `useDeferredValue` was kept defensive per item 3 above. For the
  current list size (≤ 60 locations for super_admin, often single-
  digit for RM / GM scopes) plain `useState` + `useMemo` would have
  been functionally equivalent. Record for future similar work:
  no observed difference at this scale; the cost of adding
  `useDeferredValue` is zero so default to including it.

**Validation.**
- Root `pnpm typecheck`: 18/18 green (17 cache hits, web ran fresh;
  4.949s wall).
- `pnpm --filter @splash/web build` succeeded. Route sizes:
  `/admin/pricing` 1.06 kB / 108 kB First-Load JS;
  `/admin/signups` 1.06 kB / 108 kB First-Load JS. Both routes shrank
  slightly vs prior fully-server-rendered grids because the new
  client island contains only the filter logic; the page server
  component is now thinner.

**Operator post-deploy smoke (deferred — apps/web only, no worker
changes; no Cloudflare deploy in this brief).**
- As super_admin: navigate to `/admin/pricing` → search input above
  the grid, count badge hidden. Type `bing` → list filters to
  Binghamton; badge shows `1 of 64` (or current total). Clear input
  → full grid restored, badge hidden.
- Type `cherry_hill` (using the slug form) → list filters to Cherry
  Hill if present. Confirm slug-substring matching works.
- Type a non-matching string → "No locations match '…'." muted
  text renders in place of the grid.
- Navigate to `/admin/signups` → same UX. Verify the per-tile slug
  line still renders in monospace.
- As a single-location operator on `/admin/pricing` → the redirect
  to `/admin/pricing/{loc}` still fires before the grid renders
  (no search input is visible because the page returns
  `redirect()` first).
- As a zero-locations operator → "no locations are assigned" copy
  still renders (search input is not rendered because the grid
  branch is skipped).

No Supabase / R2 / wrangler.toml / secret / D1 / CLAUDE.md changes.
