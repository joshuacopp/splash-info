# Brief 78: Dashboard tile renames + icon swap on Signup tile

**Status:** Completed (2026-05-08)
**Started:** 2026-05-08
**Completed:** 2026-05-08
**Blocks:** Operator's 2026-05-08 dashboard review surfaced four
label/icon adjustments on `/admin/dashboard`'s card grid. Each
tile's eyebrow + title pair gets clarified to match the operator's
mental model of what each tool actually manages. Cosmetic-only —
no behavior changes, no route changes, no permission changes.
**Dependencies:**
- Brief 4 (the original `/admin/dashboard` card grid).
- Brief 56 (the Signup Admin rename — the tile name being changed
  here was set by Brief 56).
- Brief 70 (the Work Orders tile — added by Brief 70's Phase 9).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-070-workorders-worker-and-page.md (the Work Orders
  tile this brief renames was added in Brief 70)
- BRIEFS/brief-056-signup-admin-rename-and-signups-viewer.md (the
  Signup Admin tile this brief renames was renamed in Brief 56)
- apps/web/app/admin/dashboard/page.tsx (the card grid; the only
  file this brief modifies for the user-visible content)

## Context

Operator review of the dashboard tiles (mobile screenshot
2026-05-08) flagged four cosmetic adjustments — three label pairs
and one icon — that better match how operators think about each
tool. None of these change behavior, routes, permissions, or any
backing API.

**Tile changes** (eyebrow shown in CAPS to match the existing
small-caps treatment in the dashboard cards):

| Tile | Current eyebrow | Current title | New eyebrow | New title | Icon change |
|---|---|---|---|---|---|
| Signup | SIGNUP ADMIN | Signup Admin | SIGNUP FORM | MaxPass Admin | `$` → ticket |
| Sysadmin | ADMIN | System Admin | ADMIN | Database Admin | none |
| Work Orders | MAINTAINX | Work Orders | MAINTENANCE | MaintainX | none |

Damage Claims tile and Performance Tracking tile are unchanged.

**Why "Ticket" for the Signup tile icon** (operator's 2026-05-08
choice): the Signup tile manages MaxPass memberships — a recurring
subscription that grants ongoing wash access. A movie-stub-style
ticket icon evokes "admission / membership / pass" more
appropriately than the generic dollar sign currently in use, which
reads as "money/billing" and miscues operators about the tool's
purpose. Lucide-react's `Ticket` icon (or equivalent in whatever
icon set the dashboard already uses — see Decisions) is the
recommended swap.

**Why these label pairs:**
- **Signup tile:** "MaxPass Admin" (white title) is more accurate
  than "Signup Admin" — the tool manages MaxPass pricing + recent
  signups, both MaxPass-product surfaces. "SIGNUP FORM" eyebrow
  describes what the tool's about; "MaxPass Admin" is what the
  tool IS.
- **Sysadmin tile:** "Database Admin" is more honest than "System
  Admin" — the tool is the user/role/table editor, not a
  general-purpose system console. Eyebrow stays "ADMIN".
- **Work Orders tile:** "MaintainX" (white title) names the
  product the tool exposes; "MAINTENANCE" eyebrow describes the
  domain. Inverts the current pairing where "MAINTAINX" was the
  eyebrow and "Work Orders" was the title.

## Scope

### Phase 1 — Signup tile

1.1 In `apps/web/app/admin/dashboard/page.tsx`, find the card
entry currently rendering "SIGNUP ADMIN" / "Signup Admin":

  - **Eyebrow** ("SIGNUP ADMIN") → change to **"SIGNUP FORM"**
  - **Title** ("Signup Admin") → change to **"MaxPass Admin"**
  - **Icon** ($ symbol) → change to a **ticket icon**:
    - If the existing icon set is `lucide-react`, use the
      `Ticket` icon (`import { Ticket } from "lucide-react"`).
    - If the existing icon is rendered inline as SVG path data
      (no library), copy the lucide `Ticket` SVG path inline and
      replace the `$` path. The Ticket icon's distinctive shape
      (rounded rectangle with semicircle notches on the sides,
      evoking a torn movie stub) reads instantly.
    - If a different icon library is in use (heroicons, etc.),
      use that library's ticket equivalent.
    - Do NOT change the icon's container styling (background
      color, size, position) — only the inner glyph.

1.2 The `href` attribute (`/admin/pricing`, `/admin/signups`, or
wherever it points today) is UNCHANGED. The tile's destination
URL stays the same; only the label and icon swap.

1.3 The description / body text of the card is unchanged. (The
existing copy about pricing + signups still describes the tool
correctly even after the rename.)

### Phase 2 — Sysadmin tile

2.1 Same file. Find the card with title "System Admin":

  - **Eyebrow** ("ADMIN") → unchanged.
  - **Title** ("System Admin") → change to **"Database Admin"**.
  - **Icon** → unchanged.
  - **Description / body** → unchanged.
  - **`href`** → unchanged.

### Phase 3 — Work Orders tile

3.1 Same file. Find the card currently rendering "MAINTAINX" /
"Work Orders":

  - **Eyebrow** ("MAINTAINX") → change to **"MAINTENANCE"**.
  - **Title** ("Work Orders") → change to **"MaintainX"**.
  - **Icon** → unchanged.
  - **Description / body** → unchanged.
  - **`href`** (`/workorders`) → unchanged.

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass.

4.2 `pnpm --filter @splash/web build` — must succeed. Bundle
delta on `/admin/dashboard` should be negligible (just text + 1
icon swap).

4.3 No worker change. No schema change. No new env vars. No
route change.

4.4 Visual smoke test (operator post-deploy):
  - (a) Open `/admin/dashboard`. Confirm the three tiles render
    with their new eyebrow / title pairs:
    - Signup → "SIGNUP FORM" / "MaxPass Admin" with a ticket
      icon (no $ visible).
    - Sysadmin → "ADMIN" / "Database Admin" (icon unchanged).
    - Work Orders → "MAINTENANCE" / "MaintainX" (icon unchanged).
  - (b) Click each tile, confirm the destination route is
    unchanged from before (no broken navigation).
  - (c) Damage Claims tile and Performance Tracking tile are
    UNCHANGED — confirm by visual scan.

### Phase 5 — Documentation

5.1 No CLAUDE.md changes required — the Glossary entries refer
to the tools by their canonical names (Signup admin, sysadmin,
Work Orders), which describe the underlying surfaces. The
dashboard tile labels are user-facing chrome, not architectural
identifiers. If the executor finds CLAUDE.md references
"Signup Admin" / "System Admin" / "Work Orders" specifically as
dashboard-tile labels (not as tool-name references), update
those mentions; otherwise leave CLAUDE.md alone.

5.2 No code-level rename of `SignupAdminTabs.tsx` or any
component / route / file. The tile label changes ONLY in
`apps/web/app/admin/dashboard/page.tsx`. URLs stay
`/admin/pricing`, `/admin/signups`, `/admin/sysadmin`,
`/workorders`.

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md — Brief 78 row appended.

6.2 BRIEFS/QUEUE.md — Brief 78 line moved to completed-tombstone
block on completion.

6.3 BUILD_STATE.md — bump Last Updated; one-line Findings entry
covering the cosmetic dashboard-tile renames.

## Out of scope

- Renaming any route (e.g., `/admin/sysadmin` →
  `/admin/database-admin`). URLs stay the same.
- Renaming any component file (`SignupAdminTabs.tsx` etc.).
- Renaming any worker (`splash-sysadmin` etc.).
- Renaming the tools' canonical names in CLAUDE.md glossary
  (Signup admin / sysadmin / Work Orders) — those are
  architectural identifiers, not display labels.
- Updating tab nav components inside the linked-to pages (e.g.
  `SignupAdminTabs` still says "Pricing" / "Signups" — that's
  intra-tool nav, not the dashboard tile).
- Don't deploy from headless. Push triggers CF Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/web/app/admin/dashboard/page.tsx` updated with the three
  tile label changes per the table above
- Signup tile's icon swapped from `$` to a ticket icon
- All five dashboard tiles (Signup, Damage, Performance,
  Sysadmin, Work Orders) still navigate to their original routes
- Damage Claims tile and Performance Tracking tile are visually
  unchanged
- pnpm typecheck passes
- pnpm --filter @splash/web build succeeds
- BRIEFS/INDEX.md, BRIEFS/QUEUE.md, BUILD_STATE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Files modified (~1: `apps/web/app/admin/dashboard/page.tsx`,
  plus BUILD_STATE.md and INDEX.md)
- Icon library actually in use (lucide-react / heroicons / inline
  SVG / something else) — surface in the Outcome so future
  briefs touching dashboard icons know where to look
- Bundle delta on apps/web `/admin/dashboard` route (kB First
  Load JS)
- Validation results
- Decisions made on the operator's behalf (e.g. exact ticket-icon
  choice if multiple ticket variants exist)
- Latent issues / forward flags

## Outcome

**Files created:** none.

**Files modified:**
- `apps/web/app/admin/dashboard/page.tsx` — three tile entries in the
  `TILES` array updated per the change table:
  - **Signup tile** (`href: "/admin/pricing"`): eyebrow
    `"Signup admin"` → `"Signup form"`, title `"Signup Admin"` →
    `"MaxPass Admin"`, icon `<line>` + S-curve `<path>` (dollar
    sign) replaced with the lucide `Ticket` SVG path data
    (outer `<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/>`
    + three perforation `<path>`s at `x=13` for `y=5..7`,
    `y=11..13`, `y=17..19`). Container span (`h-12 w-12 rounded-full
    bg-white text-splash-blue` + inner `block h-[26px] w-[26px]`)
    and the SVG's `viewBox`/`stroke`/`strokeWidth`/linecap/linejoin
    attributes unchanged.
  - **Sysadmin tile** (`href: "/admin/sysadmin"`): title
    `"System Admin"` → `"Database Admin"`. Eyebrow ("Admin"), icon
    (gear cog), and description preserved verbatim.
  - **Work Orders tile** (`href: "/workorders"`): eyebrow
    `"MaintainX"` → `"Maintenance"` and title `"Work Orders"` →
    `"MaintainX"`. Icon (wrench `<path>`) and description preserved
    verbatim.
- `BRIEFS/INDEX.md` — Brief 78 row appended.
- `BRIEFS/QUEUE.md` — `brief-078-…md` line moved to the completed-
  tombstone block (`# brief-078-…md  (completed 2026-05-08)`).
- `BUILD_STATE.md` — `Last updated` bumped to 2026-05-08 with a
  Brief 78 segment prepended ahead of the Brief 77 segment; new
  Brief 78 row inserted at the top of the `Findings & decisions
  log` table.
- `BRIEFS/brief-078-dashboard-tile-rename-signup-sysadmin-workorders.md`
  — this file: Status → `Completed (2026-05-08)`, Started/Completed
  dates filled in, Outcome populated.

**Files deleted:** none.

**Decisions made on the operator's behalf:**

1. **Icon library:** the dashboard already renders icons as inline
   SVG path data (no `lucide-react` / `heroicons` / other library
   imported). Kept that pattern by copying the lucide-react `Ticket`
   SVG path data inline rather than introducing a new dependency.
   The brief explicitly authorized this fallback ("If the existing
   icon is rendered inline as SVG path data (no library), copy the
   lucide `Ticket` SVG path inline and replace the `$` path").
2. **Lucide `Ticket` path variant:** lucide-react's canonical
   `Ticket` icon renders the rounded-rectangle ticket body with
   three short vertical perforation lines down the middle of the
   ticket. That's what was copied. (Lucide also ships `TicketCheck`,
   `TicketSlash`, `TicketX`, `TicketPercent`; chose the plain
   `Ticket` per the brief's "movie-stub-style" hint.)
3. **Eyebrow casing in source:** stored as sentence-case
   (`"Signup form"`, `"Maintenance"`) matching the existing source
   patterns ("Signup admin", "Service", "Insights", "Admin",
   "MaintainX"). The wrapping `<span>` applies
   `uppercase tracking-[0.16em]` so display is uppercased regardless.
   The brief's change table showed eyebrows in CAPS to match the
   rendered form, not the source.
4. **Damage Claims / Performance Tracking tiles:** verified by
   reading the file that they remain visually unchanged. No edits
   to those tile entries.
5. **CLAUDE.md left unchanged:** per the brief's Phase 5.1, Glossary
   entries refer to tools by their canonical names (Signup admin,
   sysadmin, Work Orders) which describe the underlying surfaces;
   the dashboard tile labels are user-facing chrome, not
   architectural identifiers. Searched for tile-label references
   tied specifically to dashboard chrome — none found beyond the
   canonical-name uses. Glossary entries for `admin` / `sysadmin` /
   `Work Orders` continue to describe the tools themselves.
6. **No component / route / file rename** per the brief's Phase 5.2:
   `SignupAdminTabs.tsx` and the `/admin/sysadmin`, `/admin/pricing`,
   `/workorders` URLs all preserved.

**Latent issues / forward flags:**

- **(i)** `SignupAdminTabs.tsx` (the in-tool tab nav for
  Pricing / Signups) still says "Pricing" / "Signups" — explicitly
  out of scope here per the brief's Out-of-scope list. If operator
  wants the in-tool nav rebranded ("Pricing" / "Recent signups"
  under a "MaxPass Admin" page-title heading), that's a separate
  follow-up brief.
- **(ii)** The `description` body copy on the Signup tile
  ("Manage MaxPass pricing and review recent signups across your
  locations.") still describes the tool correctly post-rename;
  left unchanged. If operator wants a description tweak to match
  the new "MaxPass Admin" framing (e.g., "Manage MaxPass
  pricing and recent membership signups."), that's a quick follow-up.
- **(iii)** Workers and component files are NOT renamed:
  `splash-sysadmin` worker name preserved; component file names
  (`SignupAdminTabs.tsx`, etc.) preserved; URLs preserved.
- **(iv)** `lucide-react` is NOT a project dependency — only the
  path data was copied. If a future brief wants the full lucide
  icon set (or wants animated/themed icons), the icon-library
  decision should be made deliberately at that point.

**Validation results:**

- `pnpm typecheck` — **passed** (14/14 packages; 13 cached, 1
  cache-miss for `@splash/web`; 3.439s wall-clock).
- `pnpm --filter @splash/web build` — **passed** on second attempt.
  First attempt aborted with `TypeError: fetch failed` /
  `cause: Error: bad port` from the undici fetch implementation
  during the Next.js build worker's initial network call; this is
  a transient outbound-network blip during Next telemetry/build
  worker init unrelated to the diff (no Splash-side code on that
  call path). Second attempt clean: Next.js 15.5.15 compiled in
  4.2s; all 13 routes generated; `/admin/dashboard` route bundle
  **161 B / 105 kB First Load JS** — no observable delta vs
  Brief 77 baseline (icon swap is path-data only, zero JS weight
  change). Other routes' bundle sizes unchanged.
- No worker change, no schema change, no env vars added/changed,
  no new bindings.
- Visual smoke test in browser deferred to operator post-deploy
  (Phase 4.4 of the brief).

**Icon library actually in use** (per brief's Report ask):
**inline SVG path data**, no icon library imported in the project.
`lucide-react` / `heroicons` / `react-icons` are not in
`apps/web/package.json` dependencies. Future briefs touching
dashboard icons should keep copying SVG path data inline (or
introduce a library deliberately as a separate decision).

**Bundle delta:** `/admin/dashboard` route 161 B / 105 kB First
Load JS — unchanged from Brief 77 baseline (text + path-data swap,
no logic change).
