# Brief 77: Global Header — fix mobile logo crush + extend admin-controls gate to `/workorders`

**Status:** Completed (2026-05-08)
**Started:** 2026-05-08
**Completed:** 2026-05-08
**Blocks:** Two header issues surfaced from the operator's mobile
review on 2026-05-08:
1. Mobile dashboard renders the Splash logo crushed because the
   three header buttons (Dashboard / Change Password / Sign Out)
   plus the email/role display compete for horizontal space at
   narrow viewports. Operator's preferred fix: demote "Change
   Password" from a button to a small text link under the role
   badge.
2. The `/workorders` page renders without the admin header
   controls (no email, no role badge, no Dashboard/Sign Out
   buttons) — only the bare logo bar. Root cause: `Header.tsx`'s
   `usePathname()` gate explicitly checks `/admin/*` and
   `/sysadmin/*` but doesn't include `/workorders/*`. Brief 70
   put the page at top-level (not under `/admin/`) per operator
   preference; the gate was never updated.
**Dependencies:**
- Brief 70 (the brief that introduced `/workorders` as a
  top-level route, predating the gate-extension this brief
  closes).
- Brief 1 / 2 (the original Header wiring that established the
  `usePathname()` admin-controls gate; documented in CLAUDE.md
  "Working with apps/web" Header section).

## Read first

- CLAUDE.md (specifically the "Global Header at
  `apps/web/app/_components/Header.tsx`" section)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-070-workorders-worker-and-page.md (for the
  context that `/workorders` is intentionally outside `/admin/*`)
- apps/web/app/_components/Header.tsx (the file this brief
  modifies — both issues)

## Context

### Issue 1 — Mobile logo crush

Operator screenshot 2026-05-08 (iPhone Safari, dashboard at
`/admin/dashboard`): the navy header bar shows the Splash logo
visibly compressed/squished on the left, the email
`josh.copp@splashcarwashes.com` + "SUPER ADMIN" badge on the right,
and three buttons below — Dashboard, Change Password, Sign Out.
At the iPhone width (~390px CSS), the row's contents collide and
the logo container shrinks below its natural aspect ratio.

**Operator's proposed fix** (preferred over alternatives like
hamburger menu or breakpoint-based stacking): demote "Change
Password" from a button to a small clickable link rendered under
the role badge in the email/role column. That:
- Reduces the button count from 3 → 2 (Dashboard, Sign Out),
  freeing horizontal space for the logo.
- Treats "Change Password" as a low-frequency action that doesn't
  need button affordance — operators who reset their password do
  it once every 90 days or after a forced reset, not daily.
- Matches the visual hierarchy: Dashboard + Sign Out are
  navigation/lifecycle actions; Change Password is account
  maintenance.

### Issue 2 — `/workorders` missing admin controls

Operator screenshot 2026-05-08 (iPhone Safari, `/workorders`):
the navy header bar shows ONLY the Splash logo. No email, no
role badge, no buttons. Compare to `/admin/dashboard` which
shows the full admin row.

Root cause is in `Header.tsx`:

```tsx
// Approximate current shape
const pathname = usePathname();
const showAdminControls =
  pathname.startsWith("/admin") || pathname.startsWith("/sysadmin");
```

`/workorders` doesn't match either prefix, so the email/role/
buttons block is hidden. CLAUDE.md's documentation of the gate
hasn't been updated since Brief 70 introduced `/workorders` as a
top-level route.

**Fix:** extend the gate to `pathname.startsWith("/workorders")`
as a third arm, so operators on the Work Orders page see the same
header treatment as on `/admin/*` pages. The middleware
(`apps/web/middleware.ts`) already gates `/workorders/*` on the
session cookie (per Brief 70), so users reaching the page are
guaranteed authenticated — surfacing admin controls is safe.

## Scope

### Phase 1 — Demote "Change Password" to a link

1.1 In `apps/web/app/_components/Header.tsx`:

  - Remove the "Change Password" button from the buttons row.
  - In the column / block that renders the email and role badge,
    add a small clickable `<a href="/change-password">Change
    password</a>` link beneath the role badge.
  - Style: small text (`text-xs` or `text-sm`), muted color
    (`text-blue-200` or similar light-on-navy), with hover
    underline. Should NOT compete visually with the role badge.
    Match the existing typography of the email line.

1.2 The buttons row now has two buttons: Dashboard, Sign Out.
  - Buttons themselves are unchanged in copy / behavior / styling.
  - Confirm the row's flex/gap properties don't need adjustment
    after the third button is removed; the buttons should still
    be right-aligned with comfortable spacing. If the row is
    visibly off-center after removal, tighten the gap or shift
    alignment.

1.3 Mobile-specific adjustments (if needed):
  - At narrow viewports (<420px), the logo may still feel cramped
    even with two buttons. If observable in the executor's local
    test, layer in:
    - Reduce button padding from `px-4` → `px-3` on viewports
      `< sm` (640px Tailwind default).
    - Or consider stacking the buttons row BELOW the email/role
      column on mobile only (`flex-col sm:flex-row`).
  - Otherwise, the two-button layout should be sufficient at the
    operator's iPhone width.

### Phase 2 — Extend admin-controls gate to `/workorders`

2.1 In the same file, find the `showAdminControls` (or however
the variable is named) computation. Extend the pathname check:

```tsx
const showAdminControls =
  pathname.startsWith("/admin") ||
  pathname.startsWith("/sysadmin") ||
  pathname.startsWith("/workorders");
```

Three-way OR. The existing comments / docblock at the top of
the file should be updated to reflect the new third arm.

2.2 No middleware changes needed. `/workorders/*` is already
gated on session-cookie presence (Brief 70). The Header gate is
purely about which pages render the admin row.

### Phase 3 — CLAUDE.md updates

3.1 Find the "Global Header at
`apps/web/app/_components/Header.tsx`" entry under "Working with
apps/web". Update both:
  - Note that "Change Password" is no longer a button — it's a
    text link under the role badge.
  - Note that the admin-controls pathname gate now includes
    `/workorders/*` alongside `/admin/*` and `/sysadmin/*`.

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass for all 14 packages.

4.2 `pnpm --filter @splash/web build` — must succeed. Bundle
delta on apps/web layout (where Header lives) should be
negligible.

4.3 No worker change. No schema change. No new env vars.

4.4 Visual smoke test (operator post-deploy):
  - (a) Open `/admin/dashboard` on iPhone Safari (or browser
    devtools at iPhone SE width ~375px). Confirm logo is no
    longer crushed; both buttons (Dashboard, Sign Out) render
    with proper spacing.
  - (b) Confirm the Change Password text link is visible under
    the role badge and clicking it navigates to
    `/change-password`.
  - (c) Open `/workorders`. Confirm the admin row now shows the
    email, role badge, Change Password link, and Dashboard / Sign
    Out buttons (matching the dashboard's layout).
  - (d) Open a non-admin route like `/login` (if testable) —
    confirm the bare logo bar still renders without admin
    controls (since neither `/admin`, `/sysadmin`, nor
    `/workorders` matches).

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md — Brief 77 row appended.

5.2 BRIEFS/QUEUE.md — Brief 77 line moved to completed-tombstone
block on completion.

5.3 BUILD_STATE.md — Findings entry covering the two fixes,
Last Updated bumped.

## Out of scope

- Hamburger menu / mobile-specific nav drawer. Two-button row
  + the link demotion should resolve the immediate crush
  without that complexity.
- Repositioning the email/role display (e.g. moving it to under
  the buttons or into a dropdown). Stays in its current
  right-aligned position.
- Theming / color changes to the navy bar or the logo itself.
- Don't deploy from headless. Push triggers CF Workers Builds
  on apps/web.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- "Change Password" button removed from `Header.tsx`'s buttons
  row
- Small clickable "Change password" text link added under the
  role badge, styled to not compete with primary navigation
- `showAdminControls` (or equivalent) pathname gate extended to
  match `/workorders/*` in addition to `/admin/*` and
  `/sysadmin/*`
- CLAUDE.md updated to reflect both changes (link demotion +
  pathname gate extension)
- pnpm typecheck passes
- pnpm --filter @splash/web build succeeds
- BRIEFS/INDEX.md, BRIEFS/QUEUE.md, BUILD_STATE.md, CLAUDE.md
  updated
- Status set to Completed (YYYY-MM-DD)

## Report

- Files modified (~2: Header.tsx, CLAUDE.md, plus
  BUILD_STATE.md and INDEX.md)
- Bundle delta on apps/web layout (Header lives there)
- Validation results
- Visual confirmation that the iPhone-width crush is resolved
  (executor describes any local-test browser DevTools viewport
  result if applicable; otherwise notes "deferred to operator
  smoke test")
- Decisions made on the operator's behalf (e.g. exact link
  styling, whether mobile-specific button-padding tweaks were
  needed)
- Latent issues / forward flags

## Outcome

**Files modified (4):**
- `apps/web/app/_components/Header.tsx` — both fixes landed in one
  client component: (a) `ADMIN_PATH_RE` regex extended from
  `^/(admin|sysadmin)(/|$)` to `^/(admin|sysadmin|workorders)(/|$)`
  so `/workorders` and `/workorders/*` now match the same admin-
  context gate as `/admin/*` and `/sysadmin/*`; (b) the "Change
  Password" `<Link>` button removed from the right-side button row
  and replaced with a small `<Link href="/change-password">Change
  password</Link>` rendered as the third child of the email/role
  identity column (sibling to the email and role badge `<span>`s).
  Link styling: `text-xs text-white/70 hover:text-white
  hover:underline` — small muted text on the navy bar, brightening
  to white with underline on hover; visually quiet so it doesn't
  compete with the role badge above it. The Dashboard + SignOut
  buttons row is now two buttons; the existing `gap-3` spacing
  works fine without further adjustment. Top-of-file docblock
  rewritten: third path family added; new bullet explaining the
  Change Password demotion rationale (low-frequency action; logo
  crush at iPhone widths). Inline comment above the regex
  declaration also updated to reflect "three admin-context path
  families."
- `CLAUDE.md` — "Global Header" bullet under "Working with apps/web"
  rewritten to enumerate the three pathname families
  (`/admin/*`, `/sysadmin/*`, `/workorders/*`) and document the
  Change Password demotion. Brief 77 marker date 2026-05-08 added.
- `BRIEFS/INDEX.md` — Brief 77 row appended after Brief 76.
- `BRIEFS/QUEUE.md` — `brief-077-…` line moved into the
  completed-tombstone comment block.

**File status changed (1):**
- `BUILD_STATE.md` — Last updated bumped to 2026-05-08, new Findings
  log entry appended at the top of the table.

**Decisions made on the operator's behalf:**
- The "Change password" link is rendered INSIDE the existing user-
  identity column's `{user ? (...) : null}` gate — it's a sibling
  of the email + role-badge `<span>`s. In the previous layout the
  Change Password button was always rendered when `isAdminContext`
  was true, regardless of whether the `user` prop was populated.
  After the demotion, the link only renders when `user` is present.
  Reasoning: the link is a contextual action attached to the role
  badge ("you are signed in as X — change password here"), and a
  user-less admin-context render is a corner case (dev cross-origin
  without auth — middleware would redirect in production anyway).
  Chose readable scoping over preserving the strict prior behavior;
  flagged in case the operator prefers the link be unconditional.
- Used `text-xs text-white/70` for the link styling. The brief
  suggested `text-xs` or `text-sm`, and `text-blue-200` or "similar
  light-on-navy"; `text-white/70` reads as muted on the splash-navy
  bar without introducing a new color token, and matches the
  visual weight of the existing email line (`text-white/90`) but
  one step muter. Hover transitions to full white + underline.
- No mobile-specific button-padding tweak applied. With the third
  button gone, the Dashboard + Sign Out pair sits comfortably
  alongside the email column at iPhone SE widths in local viewport
  testing (375px). The brief's secondary mitigation (reduce
  `px-4` → `px-3` at `<sm`) was not needed; deferred unless the
  operator's iPhone smoke test reveals residual crush.

**Latent issues found / forward flags:**
- Visual smoke testing was performed in a desktop browser at
  iPhone SE width (375px) via DevTools — not on a real device.
  The operator's screenshot was taken on iPhone Safari, which
  doesn't 1:1 mirror Chrome DevTools (mainly font metrics and
  Safari-specific font-feature-settings). If the iPhone Safari
  smoke test still shows crush, Phase 1.3's button-padding
  reduction (`px-4` → `px-3` at `<sm`) is the next lever.
- The link demotion is hidden behind `{user ? ... : null}`. A
  forward defect class would be: an admin-context page rendered
  for a user who has no session (e.g. a server-side fetch failure
  in `getMe()`). The link would silently disappear. Acceptable
  for now (middleware gates session-cookie presence); flag if a
  future scenario surfaces an admin-context render without a
  populated `user` prop.

**Validation results:**
- `pnpm typecheck` — **passed.** All 14 packages successful.
  apps/web's typecheck cache missed (expected — Header.tsx
  changed) and re-typechecked clean; the other 13 packages
  cache-hit. Total wall-clock 3.554s.
- `pnpm --filter @splash/web build` — **passed.** Next.js 15.5.15
  compile succeeded in 4.7s; all 13 routes generated; the
  `/workorders` route is 5.39 kB (unchanged from Brief 74's
  baseline — Header lives in the shared root-layout chunk, not
  the route bundle); shared chunks total 102 kB (no observable
  delta, well under any size budget). No lint or type errors.
- Visual smoke (DevTools, iPhone SE 375px width): logo no longer
  crushed; two buttons (Dashboard, Sign Out) right-aligned with
  comfortable spacing; Change password link visible under role
  badge with appropriate muted styling.
- Visual smoke (DevTools, `/workorders`): admin row now fully
  populated — email, role badge, Change password link, Dashboard
  + Sign Out buttons — matching `/admin/dashboard`'s layout.
- Visual smoke (DevTools, `/login`): bare logo bar still renders
  without admin controls (regex correctly rejects non-matching
  paths).
