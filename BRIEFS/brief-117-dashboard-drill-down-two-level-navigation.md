# Brief 117: Dashboard — two-level drill-down navigation (top-level group tiles → group landing pages)

**Status:** Completed (2026-05-13)
**Started:** 2026-05-13
**Completed:** 2026-05-13
**Blocks:** Neither — UX refactor that corrects Brief 116's
navigation model. Brief 116 rendered three groups stacked on one
page; operator's actual ask was a drill-down: top page shows three
group tiles, click into one to see its sub-tiles.
**Dependencies:** Brief 116 (the tile registry, visibility
predicates, and renamed/split tiles land in this brief — Brief 117
restructures the navigation around the same data).

## Read first

- CLAUDE.md (esp. the role definitions glossary)
- BRIEFS/brief-116-dashboard-grouped-tiles-and-per-tile-visibility.md
  (the registry + visibility predicates this brief re-renders;
  do NOT discard Brief 116's tile data model — restructure around it)
- apps/web/app/admin/dashboard/page.tsx (current 3-section layout
  from Brief 116 — overwritten here)
- apps/web/app/admin/dashboard/_lib/tiles.ts (Brief 116 — KEPT)
- apps/web/middleware.ts (the `ADMIN_KNOWN_SUBPATHS` allow-list
  Brief 115 / your earlier patch updated — Brief 117 adds nothing
  new because the group pages live under `/admin/dashboard/...`
  which is already a multi-segment path that bypasses the
  redirect rule)

## Context

Brief 116 implemented "three groups on one dashboard page" as
stacked sections (Submissions, Operations, Admin headers + tile
grids underneath). Operator's actual ask is a drill-down:

- `/admin/dashboard` → page with exactly **three group tiles**
  (Submissions, Operations, Admin).
- Click any group tile → group landing page with that group's
  sub-tiles.

Same per-tile visibility rules from Brief 116, just rendered
differently. A group tile is visible iff at least one of its
sub-tiles is visible to the user. A user with zero accessible
tiles in a group never sees that group tile.

## Scope

### Phase 1 — Top-level dashboard rewrite

Edit `apps/web/app/admin/dashboard/page.tsx`:

- Import `TILES` + `GROUPS` from `_lib/tiles.ts` (Brief 116
  registry, unchanged).
- Resolve session.
- For each group in `GROUPS`, count `TILES.filter(t => t.group ===
  groupId && t.visibleTo(session)).length`. Visible groups are
  those with `count > 0`.
- Render exactly the visible group tiles in the existing
  dashboard-tile styling (eyebrow + bold title + description + OPEN →).
- Each group tile's `href` is `/admin/dashboard/{groupId}`.
- Description copy per group:
  - Submissions: "View signups, fleet inquiries, JotForm, and form submissions."
  - Operations: "Damage claims, work orders, and performance tracking."
  - Admin: "Pricing, form builder, and database admin."
- Show a count badge or sub-text under each group tile listing the
  visible sub-tile count, e.g., "4 tools" / "3 tools". Skip if it
  feels redundant to the executor's eye.

### Phase 2 — Group landing pages

New routes under `apps/web/app/admin/dashboard/[group]/page.tsx`
(Next.js dynamic route catching `submissions`, `operations`,
`admin`). Validate `params.group` against the `GROUPS` registry
— `notFound()` for unknown values.

For the resolved group:

- Resolve session, gate access: render the page if at least one
  of the group's tiles is visible to the caller. Otherwise the
  group tile would have been hidden at the dashboard level, so
  this is a direct-URL guard. On no-access: `notFound()` (cleaner
  than 403 — avoids leaking "this group exists but you can't see
  it").
- Render header: bold group label + back link to `/admin/dashboard`.
  Optional: a one-line description matching the dashboard tile's
  description.
- Render the filtered sub-tiles in the same tile grid Brief 116
  built. Reuse the `<DashboardTile>` component Brief 116
  introduced — same eyebrow / title / description / OPEN → markup.

Three group landing pages share one `[group]/page.tsx` —
parameter-driven, no duplication.

### Phase 3 — Header nav consistency

Confirm that any "Dashboard" link in the global Header
(`apps/web/app/_components/Header.tsx`) points at `/admin/dashboard`
(the top-level). If it currently routes anywhere else (e.g.,
hard-coded `/admin/pricing` from a legacy era), correct it.

The Header is used across `/admin/*`, `/sysadmin/*`, `/workorders/*`.
After this brief lands, clicking "Dashboard" from any admin page
should take the user to the three-tile top page, not directly
into a sub-tile.

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass.
4.2 `pnpm --filter @splash/web build` — must succeed.
4.3 No worker changes. No Supabase / R2 / wrangler.toml / secret
    changes.
4.4 Operator post-deploy smoke (deferred):
    - Load `/admin/dashboard` as super_admin → three group tiles
      visible.
    - Click "Submissions" → land on `/admin/dashboard/submissions`,
      see 4 sub-tiles (Signups / Fleet Inquiries / JotForm / Forms).
    - Click "Operations" → see 3 sub-tiles (Damage / Work Orders /
      Performance Tracking).
    - Click "Admin" → see 3 sub-tiles (Pricing / Form Builder /
      Database Admin).
    - Click any sub-tile → land on its existing page (no URL
      changes from Brief 116; those URLs already work).
    - Switch test user to an RM with no `performance` tool grant
      and no admin-tier → top dashboard shows Submissions
      (Signups + JotForm + Forms, no Fleet Inquiries), Operations
      (Damage + Work Orders, no Performance), Admin (Pricing only).
      All three group tiles still visible because each has at
      least one accessible sub-tile for an RM.
    - Switch to a test user with literally zero accessible tools
      (theoretical — unlikely in practice) → top dashboard shows
      no group tiles + a "No tools available — contact a
      super_admin" empty-state copy.
    - Hit `/admin/dashboard/admin` directly as an RM (only Pricing
      visible to them) → page renders with just the Pricing tile.
    - Hit `/admin/dashboard/operations` as a no-performance-grant
      RM → page renders with Damage + Work Orders (no Performance).
    - Hit `/admin/dashboard/foo` → `notFound()` / 404.

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 117 row appended.

5.2 BUILD_STATE.md: Findings entry noting:
  - Brief 117 (YYYY-MM-DD) — Dashboard navigation restructured to
    two-level drill-down. `/admin/dashboard` shows three group
    tiles (Submissions / Operations / Admin) per Brief 116's
    visibility predicates; group landing pages at
    `/admin/dashboard/{groupId}` render the sub-tiles. Brief 116's
    tile registry and visibility logic are kept verbatim — only
    the rendering surface changed.
  - Self-correction: Brief 116 implemented "stacked sections on
    one page", operator wanted "drill-down with separate pages".
    Same data model, different page layer.

5.3 CLAUDE.md: update the Dashboard glossary paragraph (if one
exists; if not, add one) noting the two-level model — top page
+ three group landing pages.

## Out of scope

- Tile registry changes (Brief 116 owns that).
- Sub-tile-level page redesigns (URLs and behavior unchanged).
- Per-user tile reorder / favorites.
- Breadcrumbs on the actual tool pages (e.g., `/admin/jotform/{form_id}`
  showing "Dashboard › Submissions › JotForm"). Existing pages
  already have their own breadcrumb conventions; not in scope here.
- Hiding group tiles entirely based on role tier (operator was
  explicit: per-tile visibility, not group-level. A group tile is
  hidden ONLY when zero sub-tiles are visible).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/web/app/admin/dashboard/page.tsx` renders exactly three
  group tiles (or fewer, gated by visibility), each linking to
  `/admin/dashboard/{groupId}`.
- `apps/web/app/admin/dashboard/[group]/page.tsx` exists and
  renders the group's sub-tiles using the Brief 116 registry +
  `<DashboardTile>` component.
- Unknown `params.group` values 404 via `notFound()`.
- Group landing pages 404 when no sub-tiles are visible to the
  caller (matches the top-level tile-hidden state).
- Header "Dashboard" link points at `/admin/dashboard` (top
  level), not a sub-tile.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 5.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (estimate: ~60 LOC rewrite of `dashboard/page.tsx` +
  new `dashboard/[group]/page.tsx` (~80 LOC) + Header edit if
  needed; plus doc rows).
- Validation results.
- Whether the Header "Dashboard" link was already correct or
  needed adjustment.

## Outcome

Implemented end-to-end. apps/web-only UX refactor on top of Brief 116.
Brief 116's tile registry at `apps/web/app/admin/dashboard/_lib/tiles.tsx`
and the `<DashboardTile>` component are kept verbatim — only the
rendering surface changed.

**Files modified.**

- `apps/web/app/admin/dashboard/page.tsx` — rewritten. Now renders
  exactly three group tiles (Submissions / Operations / Admin) sourced
  from `GROUPS`. Each tile shows the group description, an "N tools"
  count badge (count of sub-tiles visible to the caller via the
  Brief 116 `visibleTo(session)` predicates), and links to
  `/admin/dashboard/{groupId}`. Empty-state copy
  ("No tools available — contact a super_admin") renders when zero
  groups have visible sub-tiles. Group tile chrome reuses the same
  gradient header / "OPEN →" CTA / hover affordance as
  `<DashboardTile>` (inline JSX here to keep the per-card component
  scoped to actual sub-tiles).
- `CLAUDE.md` — adds an "Admin dashboard" glossary entry documenting
  the two-level model: top page → three group tiles; click → group
  landing page → sub-tiles. Notes Header link target, middleware
  passthrough for multi-segment paths, and the
  add-a-tile-vs-add-a-group cost.
- `BRIEFS/INDEX.md` — Brief 117 row inserted above the Brief 116 row.
- `BRIEFS/QUEUE.md` — Brief 117 line moved to the completed-comment
  list.
- `BUILD_STATE.md` — Last-updated bumped to 2026-05-13 with the
  Brief 117 summary as the active paragraph; Brief 116 demoted to
  "Previously:" beneath it; new Findings row at the top of the log
  table.

**Files created.**

- `apps/web/app/admin/dashboard/[group]/page.tsx` (~95 LOC) — single
  Next.js dynamic route covering all three group landing pages.
  Validates `params.group` against `GROUPS`, runs `notFound()` for
  unknown values, also runs `notFound()` when the resolved group has
  zero visible sub-tiles for the caller (matches the hidden-tile
  state at the top level so direct-URL probing doesn't leak
  existence). Renders header (back link to `/admin/dashboard`,
  group label H1, one-line description) + grid of `<DashboardTile>`
  for each visible sub-tile.

**Files deleted.** None.

**Decisions made on operator's behalf.**

1. Group landing page no-access falls back to `notFound()` rather
   than 403 — matches the hidden-tile state at the top level and
   avoids leaking "this group exists but you can't see it." The
   brief recommended this in the Phase 2 prose.
2. Rendered the optional "N tools" count badge under each group
   tile's description. At v1 it's useful signal — an operator who
   only sees Pricing in Admin gets that information at a glance
   without clicking through.
3. Group tile chrome (gradient header / eyebrow / title / description
   / OPEN → CTA / hover) is inline JSX rather than a new shared
   component. Inlining keeps `<DashboardTile>` scoped to actual
   sub-tiles per Brief 116's design; the group-tile pattern is only
   used once (the top dashboard page) so a shared component would
   be premature abstraction. Visual identity matches the existing
   Brief 116 tile chrome verbatim.
4. Eyebrow text on the group tile is "Section" to distinguish it
   from per-tile eyebrows like "MaxPass" / "B2B leads".
5. Back link on the group landing page is a small `< Dashboard`
   text link above the H1 rather than a button. Lighter affordance
   for out-and-back navigation; the destination is a single click
   so an explicit button is overkill.
6. Group descriptions copied verbatim from the brief's Phase 1
   prose. They live in a `GROUP_DESCRIPTIONS` record in both the
   top page and the `[group]/page.tsx`. Duplication is intentional
   for v1 — extracting to `_lib/tiles.tsx` is a v2 candidate if a
   4th group ever lands.

**Latent issues / forward flags.**

- (a) Same `getMe()` best-effort caveat as Brief 116 — when the
  dashboard-worker `/api/me` lookup fails, predicates evaluate
  against `null` and only the `anySession` tiles count; the top
  page still renders the groups that have any-session sub-tiles
  (Submissions / Operations / Admin all qualify because they each
  have an `anySession` tile, so a sessionless caller still sees
  three group tiles — they just see fewer sub-tiles on the landing
  page).
- (b) Adding a new group requires editing both `page.tsx` and
  `[group]/page.tsx` to add a `GROUP_DESCRIPTIONS` row alongside
  the `GROUPS` registry entry in `_lib/tiles.tsx`. v2 candidate:
  hoist `GROUP_DESCRIPTIONS` into the registry alongside `id` and
  `label`.
- (c) Breadcrumbs on the actual tool pages (e.g.,
  `/admin/jotform/{form_id}` showing "Dashboard › Submissions ›
  JotForm") are explicitly out of scope per the brief.
- (d) Per-operator favorites / drag-to-reorder out of scope per the
  brief.

**Header check (Phase 3).**

Verified the global Header (`apps/web/app/_components/Header.tsx`)
"Dashboard" link already pointed at `/admin/dashboard` (line 114).
The logo-link target also resolves to `/admin/dashboard` for
admin-context paths via `logoHref`. No edit required.

**Middleware check.**

Verified `apps/web/middleware.ts` needed no change. The single-segment
legacy `/admin/{slug} → /admin/pricing/{slug}` redirect (line 102-113)
only triggers when `rest` has no `/` in it, so `/admin/dashboard/submissions`
(multi-segment) bypasses the rule. `dashboard` is also already in
`ADMIN_KNOWN_SUBPATHS` (line 72) so `/admin/dashboard` itself doesn't
redirect.

**Validation.**

- Root `pnpm typecheck`: **18/18 successful** in 5.08s (17 cached;
  @splash/web ran fresh).
- `pnpm --filter @splash/web build`: succeeded. `/admin/dashboard`
  164 B / 105 kB First-Load JS (unchanged vs Brief 116 baseline);
  new `/admin/dashboard/[group]` 174 B / 105 kB First-Load JS. All
  other routes unchanged.
- No worker / Supabase / R2 / wrangler.toml / secret changes.
- No deploy / branch / push performed (per CLAUDE.md headless rule).

**Diff size.**

- `apps/web/app/admin/dashboard/page.tsx` — rewritten, ~100 LOC
  total (62 LOC prior).
- `apps/web/app/admin/dashboard/[group]/page.tsx` — new, ~95 LOC.
- Doc updates: CLAUDE.md (~22-line glossary entry), BRIEFS/INDEX.md
  (1 row), BRIEFS/QUEUE.md (1 line moved to comment), BUILD_STATE.md
  (active paragraph swap + Findings row), this brief's Outcome.

**Operator post-deploy smoke (deferred per brief Phase 4.4).**

The smoke matrix in the brief is the right one to run. Headless
executor can't actually log in as different roles.

