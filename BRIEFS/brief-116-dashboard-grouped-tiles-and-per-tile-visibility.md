# Brief 116: Dashboard tile reorganization — three groups + per-tile visibility

**Status:** Completed (2026-05-13)
**Started:** —
**Completed:** —
**Blocks:** Neither — additive UX refactor. Existing pages and
URLs unchanged; this brief only restructures the dashboard
navigation layer.
**Dependencies:** No direct code dependencies, but pairs naturally
with Brief 115's JotForm fixes (so operators land on a clean
dashboard before drilling in).

## Read first

- CLAUDE.md ("Signup admin" + role definitions glossary)
- apps/web/app/admin/dashboard/page.tsx (current 8-tile grid —
  the file this brief rewrites)
- apps/web/middleware.ts (per-route role gating reference)
- packages/auth session shape — confirm what `session` exposes
  for the tile-level visibility predicates (`role`, `dcRole`,
  `tools` if present)
- apps/web/app/admin/_components/SignupAdminTabs.tsx (Brief 56's
  tab nav — operators currently jump between Pricing and Signups
  via this; the visual split this brief introduces follows the
  same URL structure)
- apps/sysadmin-worker grant_tool / revoke_tool action shapes
  (Brief 30 audit log allow-list) — for understanding the
  Performance tool grant

## Context

The dashboard currently shows an 8-tile flat grid (MaxPass Admin,
Damage Claims, Performance Tracking, Database Admin, MaintainX,
Fleet Inquiries, Forms, JotForm) plus Forms (Brief 99). As the
system grows — more JotForm onboarding, future form-builder
forms, etc. — the flat grid becomes unwieldy. Operator review
2026-05-12 asked for category grouping with per-tile visibility
that matches each user's actual access.

Three groups:

**Submissions** — view-oriented operational data
- MaxPass Signups Viewer (was the Signups tab under MaxPass Admin)
- Fleet Inquiries
- JotForm
- Forms (custom builder-generated form submissions)

**Operations** — workflow-driven write surfaces
- Damage Claims
- Work Orders (MaintainX)
- Performance Tracking

**Admin** — configuration / management
- MaxPass Pricing (was the Pricing tab under MaxPass Admin)
- Form Builder (renamed from "Forms")
- Database Admin

The MaxPass Admin tile splits along the existing tab boundary
(Brief 56's `SignupAdminTabs`): Pricing goes to Admin group,
Signups Viewer goes to Submissions group. Existing URLs
(`/admin/pricing/*` and `/admin/signups/*`) stay the same — only
the dashboard entry point changes.

The "Forms" tile (form builder admin) is renamed to "Form Builder"
to disambiguate from the new "Forms" submissions tile (custom
builder-generated submissions). Forms-builder URL unchanged
(`/admin/forms`).

**Visibility model.** Each tile declares its own visibility
predicate; the group renders only if at least one of its tiles
is visible. No role-level group hiding — that would inappropriately
hide MaxPass Pricing (used by GMs) from non-admins.

Per-tile visibility rules:

| Tile | Group | Visible to |
|------|-------|-----------|
| Signups Viewer | Submissions | any authenticated session |
| Fleet Inquiries | Submissions | admin-tier (`role==='super_admin'` OR `dcRole in ['admin','super_admin']`) |
| JotForm | Submissions | any authenticated session (worker scopes via `accessibleSiteNumbersForSession`) |
| Forms (submissions) | Submissions | any authenticated session (visibility from forms-worker's `GET /forms/api/visible-to-me` — Brief 99) |
| Damage Claims | Operations | any authenticated session (page-level dcRole gates per-section) |
| Work Orders | Operations | any authenticated session (email-on-locations match per Brief 71) |
| Performance Tracking | Operations | users with **`performance` tool grant** in user_permissions OR admin-tier |
| MaxPass Pricing | Admin | any authenticated session (page-level dcRole scopes which locations are editable) |
| Form Builder | Admin | admin-tier only |
| Database Admin | Admin | super_admin only (`session.role === 'super_admin'`) |

The Performance tile is the special case: not role-based but
tool-grant-based. The grant mechanism is the Brief 30 sysadmin
"Grant tool" action that adds an entry to `user_permissions.tools`
(or similar — confirm exact schema during execution). Admin-tier
users also see it without an explicit grant.

## Scope

### Phase 1 — Tile registry

New module `apps/web/app/admin/dashboard/_lib/tiles.ts`:

```ts
import type { Session } from "@splash/auth"; // or wherever session shape lives

export type TileGroup = "submissions" | "operations" | "admin";

export interface Tile {
  id: string;
  group: TileGroup;
  eyebrow: string;        // small uppercase label on tile, e.g., "SIGNUP FORM"
  title: string;          // bold display name, e.g., "MaxPass Pricing"
  description: string;    // one-line body copy
  href: string;           // click-through URL
  visibleTo: (session: Session) => boolean;
}

export const TILES: Tile[] = [
  // ---- Submissions group ----
  {
    id: "signups-viewer",
    group: "submissions",
    eyebrow: "MAXPASS",
    title: "Signups",
    description: "Recent customer enrollments by location.",
    href: "/admin/signups",
    visibleTo: () => true
  },
  {
    id: "fleet-inquiries",
    group: "submissions",
    eyebrow: "B2B LEADS",
    title: "Fleet Inquiries",
    description: "View and edit fleet customer inquiries.",
    href: "/admin/fleet",
    visibleTo: isAdminTier
  },
  {
    id: "jotform",
    group: "submissions",
    eyebrow: "FIELD FORMS",
    title: "JotForm",
    description: "Rewash, salt log, retention, and time card edits.",
    href: "/admin/jotform",
    visibleTo: () => true
  },
  {
    id: "forms-submissions",
    group: "submissions",
    eyebrow: "CUSTOM FORMS",
    title: "Forms",
    description: "Submissions from custom-built forms.",
    href: "/forms",
    visibleTo: () => true
  },
  // ---- Operations group ----
  {
    id: "damage",
    group: "operations",
    eyebrow: "SERVICE",
    title: "Damage Claims",
    description: "Review and manage vehicle damage claims and resolutions.",
    href: "/admin/damage",
    visibleTo: () => true
  },
  {
    id: "workorders",
    group: "operations",
    eyebrow: "MAINTENANCE",
    title: "Work Orders",
    description: "View MaintainX work orders for your locations.",
    href: "/workorders",
    visibleTo: () => true
  },
  {
    id: "performance",
    group: "operations",
    eyebrow: "INSIGHTS",
    title: "Performance Tracking",
    description: "Location performance metrics and operational insights.",
    href: "/admin/performance",
    visibleTo: hasPerformanceAccess
  },
  // ---- Admin group ----
  {
    id: "pricing",
    group: "admin",
    eyebrow: "MAXPASS",
    title: "Pricing",
    description: "Set per-location MaxPass pricing.",
    href: "/admin/pricing",
    visibleTo: () => true
  },
  {
    id: "form-builder",
    group: "admin",
    eyebrow: "BUILDER",
    title: "Form Builder",
    description: "Build and manage admin-built forms.",
    href: "/admin/forms",
    visibleTo: isAdminTier
  },
  {
    id: "database-admin",
    group: "admin",
    eyebrow: "ADMIN",
    title: "Database Admin",
    description: "Manage user accounts, role assignments, and tool grants.",
    href: "/admin/sysadmin",
    visibleTo: isSuperAdmin
  }
];

function isAdminTier(session: Session): boolean {
  return (
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin"
  );
}

function isSuperAdmin(session: Session): boolean {
  return session.role === "super_admin";
}

function hasPerformanceAccess(session: Session): boolean {
  if (isAdminTier(session)) return true;
  // Confirm exact field during execution — Brief 30 / packages/auth.
  const tools = Array.isArray((session as any).tools)
    ? ((session as any).tools as string[])
    : [];
  return tools.includes("performance");
}

export const GROUPS: { id: TileGroup; label: string }[] = [
  { id: "submissions", label: "Submissions" },
  { id: "operations", label: "Operations" },
  { id: "admin", label: "Admin" }
];
```

Confirm during execution: the exact field name for tool grants
on the session object (probably `session.tools` or
`session.permissions.tools` per Brief 30's grant_tool action).
If sessions don't carry the tool list, fetch it server-side
from `user_permissions` for the dashboard render.

### Phase 2 — Dashboard page rewrite

Edit `apps/web/app/admin/dashboard/page.tsx`:

- Import `TILES` + `GROUPS` from the registry.
- Resolve the session.
- For each group in `GROUPS`, filter `TILES` by `group === groupId &&
  visibleTo(session) === true`. Skip rendering the group if the
  filtered list is empty (would only happen if a future role is
  added without any tile access).
- Render each group as: `<h2>{group.label}</h2>` followed by the
  current 3-column tile grid for that group's visible tiles.
- Tile component: extract the existing JSX into a small
  `<DashboardTile>` server component that takes `{ tile }` and
  renders the existing eyebrow / title / description / "OPEN →"
  link layout. No styling changes.

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass.
3.2 `pnpm --filter @splash/web build` — must succeed.
3.3 No worker changes. No Supabase / R2 / wrangler.toml / secret
    changes.
3.4 Operator post-deploy smoke (deferred):
    - Load `/admin/dashboard` as super_admin → all three groups
      render, all 10 tiles visible.
    - Switch test user to admin (no super_admin) → all three
      groups render, Database Admin missing.
    - Switch test user to RM (rm_email on a few locations, no
      admin tier, no performance grant) → Submissions group
      shows Signups + JotForm + Forms (no Fleet Inquiries),
      Operations shows Damage + Work Orders (no Performance),
      Admin shows Pricing only (no Form Builder, no Database
      Admin).
    - Switch test user to a GM with `performance` tool grant →
      Performance Tracking tile visible.
    - Click-through every tile from a super_admin session →
      every page loads as before (no URL changes).

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 116 row appended.

4.2 BUILD_STATE.md: Findings entry noting:
  - Brief 116 (YYYY-MM-DD) — dashboard refactored into three
    groups (Submissions / Operations / Admin) with per-tile
    visibility predicates. MaxPass Admin tile split into Signups
    (Submissions group) and Pricing (Admin group); "Forms" tile
    renamed to "Form Builder" to disambiguate from the new
    "Forms" submissions tile. No tile-level behavior changes —
    URLs and page-level gates unchanged.
  - Onboarding a future tile means adding an entry to
    `apps/web/app/admin/dashboard/_lib/tiles.ts` with a
    `visibleTo` predicate. Group headers auto-suppress if no
    tiles are visible to the current user.

4.3 CLAUDE.md "Signup admin" glossary entry: update to note that
the MaxPass tile is split — Pricing is its own dashboard tile,
Signups is its own tile, both still linked by SignupAdminTabs at
the page level. URLs unchanged.

## Out of scope

- Any tile-level page redesign (URLs and behavior unchanged).
- Performance worker / tool-grant data-model changes — Brief 116
  reads the existing grant; if the session shape doesn't expose
  it cleanly, executor fetches from `user_permissions` directly
  (small read, no schema change).
- Removing the `SignupAdminTabs` nav from
  `/admin/pricing` + `/admin/signups` pages — operators can still
  use it to switch between the two views once inside either page.
- Per-location filter UX on the dashboard tiles. The tiles are
  navigation; filtering lives inside each page.
- Group reorder by drag-and-drop or operator preferences. Fixed
  order at v1.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/web/app/admin/dashboard/_lib/tiles.ts` exists with the
  `Tile` type, `TILES` array (10 entries), `GROUPS` array, and
  visibility predicates including `hasPerformanceAccess`.
- `apps/web/app/admin/dashboard/page.tsx` renders three group
  sections, filtering each by the per-tile `visibleTo` predicate.
- Empty groups suppress.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 4.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (estimate: ~150 LOC for tiles.ts + ~50 LOC of edits
  to dashboard/page.tsx; plus doc rows).
- Validation results.
- Confirmed source of truth for the `performance` tool grant
  (session field name, where it lives). If session doesn't expose
  it, what server-side read was added and where.
- Any tile whose `visibleTo` predicate is conservatively wider
  than the underlying page's actual access — operators clicking
  through to a no-access state would be a v2 polish.

## Outcome

### Summary

Three-group dashboard refactor landed on top of the Brief 4 / Brief 78 /
Brief 109 flat 8-tile grid. New registry-driven design: each tile carries
its own `visibleTo(session)` predicate; group headers (Submissions /
Operations / Admin) auto-suppress when no tile in the group is visible
to the current session. MaxPass Admin tile split along the Brief 56
SignupAdminTabs boundary — Signups Viewer to Submissions, Pricing to
Admin; both URLs unchanged. Prior "Forms" tile renamed Form Builder to
disambiguate from the new "Forms" submissions tile (links to the
Brief 99 `/forms` credentialed index).

### Files created

- `apps/web/app/admin/dashboard/_lib/tiles.tsx` (~220 LOC) — Tile
  interface (with `icon: ReactNode`), `TileGroup` union, GROUPS array,
  four predicate helpers (`isAdminTier`, `isSuperAdmin`,
  `hasPerformanceAccess`, `anySession`), 8 inline lucide-derived SVG
  icon constants, and the 10-entry TILES registry.
- `apps/web/app/admin/dashboard/_components/DashboardTile.tsx` (~50 LOC)
  — server component, single `tile: Tile` prop, renders the prior
  flat-grid card JSX shape (eyebrow + icon circle + title + description
  + "OPEN →") verbatim.

### Files modified

- `apps/web/app/admin/dashboard/page.tsx` — rewritten to consume
  TILES + GROUPS and render three sections of `<DashboardTile>`s with
  group eyebrows. Top docblock revised; old inline tile array + the
  Brief 109 `visibleTo === "adminTier"` filter removed.
- `CLAUDE.md` — "Signup admin" glossary entry gains a Brief 116
  paragraph noting the dashboard split along the SignupAdminTabs
  boundary.
- `BRIEFS/INDEX.md` — Brief 116 row inserted at top of the recent-briefs
  region above Brief 115.
- `BUILD_STATE.md` — Last-updated bumped to 2026-05-13; Brief 115
  parenthetical demoted to "Previously:"; Findings & decisions log
  row added at top of the table.
- `BRIEFS/QUEUE.md` — Brief 116 active line moved to the completed-
  comment list (`# brief-116-...  (completed 2026-05-13)`).
- `BRIEFS/brief-116-...md` (this file) — Status set to Completed
  (2026-05-13), Outcome filled in.

### Files deleted

None.

### Decisions made on operator's behalf

1. **`tiles.tsx` (not `tiles.ts`)** — the brief's prose interface
   omitted `icon`, but the Phase 2 "no styling changes" requirement
   and the existing flat grid both ship icons. Inline JSX needs `.tsx`.
   Pattern already established by Brief 111's
   `apps/web/app/admin/jotform/[form_id]/_lib/form-columns.tsx` (a
   sibling per-form column registry that also stores ReactNode
   renderers).
2. **Performance tile predicate uses `pertrack`, not "performance"** —
   confirmed via `packages/types/src/auth.ts`: `ToolName = "pricing" |
   "claims" | "pertrack"`. There is no "performance" value in the union.
   `session.tools.includes("pertrack")` is the right check.
   `@splash/auth/tool-access.ts:checkToolAccess` confirms super_admin
   role bypasses; admin-tier dcRole gets it for free as the
   convenience tier the brief specified.
3. **New tile icons.** Signups Viewer → UserPlus inline SVG. Forms
   (submissions) → Inbox inline SVG. Form Builder (renamed from
   "Forms") → kept the prior ClipboardList SVG for visual continuity
   with the previous tile name. Pricing → kept the credit-card SVG
   the prior unified "MaxPass Admin" tile used.
4. **Group headers** render as small uppercase eyebrows in
   `text-splash-navy/70`, separated by `gap-10` between sections.
   Visual rhythm stays light vs the existing tile chrome and
   doesn't compete with the page H1.
5. **`visibleTo` is a UX hint, not access control.** Each destination
   re-checks at its server layer (worker route gates, middleware,
   page-level `getMe()` checks); this is documented in the rewritten
   page docblock.
6. **`getMe()` failure path.** When the dashboard-worker `/api/me`
   lookup throws (e.g., expired cookie between cache TTL and page
   load), predicates evaluate against `null` and only `anySession`
   tiles render. Operators in that state can still navigate via
   bookmarks; the destination redirects to `/login`.

### Latent issues / forward flags

- **Conservative visibility on Damage Claims + Work Orders.** Both
  tiles render for `anySession`; page-level dcRole / email-on-locations
  gates apply on click-through and can leave a non-matched operator on
  an empty list. Brief flagged this as v2 polish. Current behavior
  matches the prior flat grid (those tiles always rendered).
- **Icon library scaling.** The 8 inline SVG constants live in the same
  file as the TILES array. Extracting them to a sibling
  `_lib/icons.tsx` is a clean follow-up if the registry grows beyond
  ~15 entries.
- **No automated UI coverage.** A Playwright/Storybook test would
  validate the three-group render under super_admin / admin / RM / GM
  sessions. Out of scope for Brief 116; v2 candidate.
- **Group reorder + per-operator preferences** explicitly out of scope
  per the brief; fixed group order at v1.

### Validation

- **`pnpm typecheck`**: 18/18 green (17 cache hits, `@splash/web` ran
  fresh). No errors.
- **`pnpm --filter @splash/web build`**: succeeded.
  `/admin/dashboard` route renders at **164 B / 105 kB First-Load JS**
  — ≈ unchanged vs prior baseline; the icons + group-filter logic
  moved out of the page into the registry/component, which the route
  loads server-side.
- **No worker / Supabase / R2 / wrangler.toml / secret changes** — pure
  apps/web refactor.

### Source of truth for the `performance` tool grant

The Performance Tracker tool grant is stored in `user_tool_access.tool`
(see `packages/db-supabase` + the Brief 30 sysadmin "Grant tool"
action). It surfaces on `Session.tools` (type `ToolName[]`) via the
Supabase `auth_unified` view at login. ToolName is the union
`"pricing" | "claims" | "pertrack"` from `packages/types/src/auth.ts`
— `pertrack` is the value to check, NOT `"performance"`. super_admin
role bypasses all per-tool grants per `@splash/auth/tool-access.ts`
`checkToolAccess`. No server-side additional read was needed; the
session field is already on the dashboard-worker `/api/me` response.

### Operator post-deploy smoke (deferred per Phase 3.4)

1. Load `/admin/dashboard` as super_admin → all three groups render,
   all 10 tiles visible.
2. Switch to admin-only test user → all three groups render, Database
   Admin tile missing.
3. Switch to an RM with no admin tier + no pertrack grant →
   Submissions shows Signups + JotForm + Forms (no Fleet Inquiries);
   Operations shows Damage + Work Orders (no Performance Tracking);
   Admin shows Pricing only (no Form Builder, no Database Admin).
4. Switch to a GM with `pertrack` grant via Sysadmin → Performance
   Tracking tile appears in Operations.
5. Click-through every tile from super_admin → every destination
   loads as before (URLs unchanged).

No deploy / branch / push performed.
