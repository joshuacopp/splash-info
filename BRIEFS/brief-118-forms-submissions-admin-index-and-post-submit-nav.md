# Brief 118: Forms — admin submissions index + post-submit navigation

**Status:** Completed (2026-05-13)
**Started:** 2026-05-13
**Completed:** 2026-05-13
**Blocks:** Neither — UX gaps in the custom-forms (form-builder)
feature: the Submissions-group "Forms" tile lands users on the
public form-fill index instead of an admin submissions view, and
the post-submit confirmation page is a dead end with only a
"Fill Out Another" CTA.
**Dependencies:** Brief 95 (form builder), Brief 96 (per-form
submissions admin), Brief 99 (`/forms` credentialed-user index),
Brief 117 (dashboard drill-down — owns the Submissions-group tile
this brief retargets).

## Read first

- CLAUDE.md (`forms-worker` glossary entry)
- BRIEFS/brief-095..100 Outcome sections (form-builder + admin
  + submissions + cron — the existing surfaces this brief
  navigates across)
- BRIEFS/brief-117-dashboard-drill-down-two-level-navigation.md
  (the dashboard tile this brief retargets)
- apps/web/app/admin/dashboard/_lib/tiles.ts (Brief 116/117 —
  the "Forms" tile in the Submissions group; href currently `/forms`)
- apps/web/app/admin/forms/* (Brief 95 builder + Brief 96
  submissions pages — `/admin/forms/[id]/submissions` already
  exists per-form)
- apps/forms-worker/src/render/* (Brief 90 public form-render
  path — post-submit confirmation rendering lives here)
- apps/web/app/forms/page.tsx (Brief 99 `/forms` credentialed-
  user index — list of forms to FILL OUT, NOT view submissions)

## Context

Operator review 2026-05-13 surfaced two gaps in the custom-forms
flow:

**1. Submissions-group "Forms" tile lands on the wrong surface.**
The tile's `href` is `/forms` — Brief 99's credentialed-user
index that lists forms TO FILL OUT. Operators click expecting a
submissions viewer (consistent with the other tiles in the
Submissions group: Signups, Fleet Inquiries, JotForm — all
viewers of submission data), but instead get the fill-out index.

The right destination is an admin SUBMISSIONS view across all
forms. Brief 96 built per-form submissions pages at
`/admin/forms/[id]/submissions` but there's no top-level index
that lists all forms with their submission counts and drill-
through. This brief adds one.

**2. Post-submit confirmation is a dead end.** After a user
fills out a custom form (`/forms/{slug}` → POST → confirmation),
the only CTA is "Fill Out Another" (which is a "Fill Again"
flow returning the user to the empty form). No way back to the
dashboard, no way to /forms index, no way to sign out, no
navigation chrome at all.

For credentialed staff filling out internal forms, the post-
submit page should offer: a "Back to forms" link (to /forms),
and ideally the global apps/web Header (logo + dashboard +
sign out). Since splash-forms is path-carved on the same
origin as apps/web, an inline link to `/admin/dashboard` works
without any cross-origin gymnastics.

## Scope

### Phase 1 — Admin submissions index page

New route at `apps/web/app/admin/forms/submissions/page.tsx` (or
similar — confirm naming during execution; could also be
`/admin/forms/all-submissions` to avoid colliding with any
existing `[id]` route).

Auth gate: admin-tier only (`session.role === "super_admin"` OR
`session.dcRole === "admin"` OR `session.dcRole === "super_admin"`).
Non-admin users redirect to /forms or see a NoAccessCard.

Content:

- Header: "Form Submissions" title + breadcrumb back to
  `/admin/dashboard/submissions` (the group landing page).
- Card grid (mirrors the Brief 109 JotForm index layout) of all
  published+archived forms in the system, sourced from the
  forms-worker admin API's `GET /forms/admin/api/forms` (Brief
  94). Each card:
  - Form title (bold)
  - Status pill (`published` / `archived`)
  - Submission count (from the existing forms-worker count via
    `Content-Range` per Brief 94's list endpoint, or via a new
    aggregate count if needed)
  - "View submissions →" link to `/admin/forms/[id]/submissions`
    (Brief 96 — already exists)
- Empty state: "No forms yet — create one in Form Builder" with a
  link to `/admin/forms` (the builder index).

If non-admin authenticated user lands on this page directly via
URL, show a NoAccessCard pointing them at /forms instead. They
shouldn't see other operators' form submissions — that's an
admin-tier surface.

### Phase 2 — Retarget the Submissions-group "Forms" tile

Edit `apps/web/app/admin/dashboard/_lib/tiles.ts` (Brief 116/117
registry):

- Change the `forms-submissions` tile's `href` from `/forms` to
  the new admin submissions index URL.
- Update the tile's `description` accordingly: "View submissions
  to admin-built custom forms." (current copy "Submissions from
  custom-built forms." is fine; tweak the lead to make it clear
  this is a viewer, not a fill-out surface).
- Update the tile's `visibleTo` predicate from `() => true` to
  `isAdminTier` — only admin-tier users see the submissions
  viewer tile. Non-admins still get the fill-out flow at /forms
  via direct URL bookmark.

### Phase 3 — Post-submit navigation

Edit the forms-worker post-submit render path
(`apps/forms-worker/src/render/`):

- After successful submission, the confirmation page renders a
  success message + "Fill Out Another" CTA today. Add navigation
  alongside that CTA:
  - Primary "Back to Forms" button → `/forms` (forms-worker
    server-renders this link; same-origin so a plain anchor works).
  - Secondary "Dashboard" button → `/admin/dashboard` (apps/web).
  - Keep "Fill Out Another" as a tertiary option.
- Match the global Header pattern if possible: the splash-navy
  bar with the white-script logo across the top. The forms-worker
  already serves the logo from R2 (per Brief 32 / CLAUDE.md
  `ASSETS.logoWhite`), so a simple inline header is feasible
  without cross-origin complexity. If the executor finds matching
  the Header exactly is too heavy a lift (it's a React component
  in `packages/ui`, not directly portable to the forms-worker's
  plain-HTML render path), drop the Header and just add the
  inline link buttons — text-only navigation is enough.

The render path is in `apps/forms-worker/src/render/`. Look for
the confirmation page template (likely `confirmation.ts` or
similar based on Brief 90's structure). Add the navigation
section near the existing "Fill Out Another" CTA.

For `audience: "internal"` forms (the only kind that operators
log in for), the user is authenticated to apps/web; the
`/admin/dashboard` link will work. For `audience: "public"`
forms (e.g., customer-facing surveys), the user isn't
authenticated — the "Dashboard" link would just bounce them to
/login. Decide per-audience: internal forms get both buttons,
public forms get only "Back to Forms" or a generic "Done" with
no admin links.

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass.
4.2 `pnpm --filter @splash/web build` — must succeed.
4.3 `pnpm --filter @splash/forms-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean
    up after.
4.4 No Supabase / R2 / wrangler.toml / secret changes.
4.5 Operator post-deploy smoke (deferred):
    - Land on `/admin/dashboard/submissions` as super_admin → see
      the Forms tile with new "view submissions" copy.
    - Click → land on the new admin submissions index, see one
      or more form cards with submission counts.
    - Click "View submissions →" on any card → land on
      `/admin/forms/[id]/submissions` (Brief 96's existing page).
    - Switch to non-admin RM user → Forms tile no longer visible
      on `/admin/dashboard/submissions`. Direct URL access to
      the admin submissions index 403s / NoAccessCards.
    - Fill out a test form at `/forms/{slug}` → submit → land on
      confirmation page → see "Back to Forms" + "Dashboard" +
      "Fill Out Another" CTAs. Click each, confirm they go where
      they say.

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 118 row appended.

5.2 BUILD_STATE.md: Findings entry noting:
  - Brief 118 (YYYY-MM-DD) — Forms submissions admin index page
    landed at `/admin/forms/submissions` (or similar). Dashboard
    Submissions-group "Forms" tile retargeted from /forms (the
    fill-out surface) to the new admin submissions index, tile
    visibility restricted to admin-tier.
  - Forms-worker post-submit confirmation now offers "Back to
    Forms" + "Dashboard" + "Fill Out Another" navigation (audience-
    appropriate — public forms get only "Back to Forms").

5.3 CLAUDE.md `forms-worker` glossary entry: append a line noting
the admin submissions index URL and the post-submit nav additions.

## Out of scope

- Submissions-group tile visibility for RM/RD/GM users (could
  imagine a per-form scoping later — operators see only forms
  they've submitted to, for instance). v2.
- Aggregating submission counts across all forms in one summary
  tile. v2 reporting.
- Audience-aware confirmation copy (the brief gives basic
  per-audience logic; richer per-form custom copy is v2).
- Migrating the forms-worker's render path from plain HTML to
  React-rendered to share the apps/web Header. Too big for this
  brief; inline link buttons suffice.
- Adding the global Header to other forms-worker render surfaces
  (e.g., the form-fill page itself). Only the post-submit
  confirmation gets nav additions in this brief.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- New admin submissions index page exists, gated to admin-tier,
  lists forms with submission counts and links to Brief 96's
  per-form submissions pages.
- `apps/web/app/admin/dashboard/_lib/tiles.ts` Submissions-group
  Forms tile points at the new admin index and has `visibleTo:
  isAdminTier`.
- forms-worker post-submit confirmation page renders "Back to
  Forms" + "Dashboard" + "Fill Out Another" CTAs (audience-
  appropriate).
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 5.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate.
- Validation results.
- The chosen URL for the admin submissions index (and rationale
  if it's anything other than `/admin/forms/submissions`).
- Whether the post-submit page got the inline buttons or a full
  Header port — and why.
- Whether the forms-worker has multiple confirmation paths (e.g.,
  per-audience separate render templates) that all needed the
  nav update.

## Outcome

**Files created.**

- `apps/web/app/admin/forms/submissions/page.tsx` (~170 LOC). Server
  component; admin-tier gated (`session.role === "super_admin"` OR
  `session.dcRole === "admin"|"super_admin"`); reuses
  `listFormsAdmin()` from `_lib/worker-fetch.ts` (no new worker
  endpoint required — Brief 94's list response already carries
  `submissionCount`); renders a back-link to
  `/admin/dashboard/submissions`, a header + intro paragraph, a
  3-column responsive card grid
  (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`) of every published +
  archived form (drafts filtered out), and a NoAccessCard for signin /
  forbidden states. Sort order: submission count desc, alphabetical
  title tie-break. Card shape mirrors the Brief 109 JotForm index
  (navy gradient header with "Custom Form" eyebrow + form title,
  body with status pill + submission count + slug code + "View
  submissions →" chevron CTA wrapping the whole `<Link>` to
  `/admin/forms/[id]/submissions`).

**Files modified.**

- `apps/web/app/admin/dashboard/_lib/tiles.tsx` — Submissions-group
  `forms-submissions` tile entry: `href` swapped from `/forms`
  (Brief 99 fill-out index) to `/admin/forms/submissions`; description
  swapped from "Submissions from custom-built forms." to "View
  submissions to admin-built custom forms."; `visibleTo` tightened
  from `anySession` to `isAdminTier`.
- `apps/forms-worker/src/submit/success.ts` — rewired post-submit
  confirmation page. Replaced the lone "Fill out another" anchor with
  a `<div class="nav-actions">` flex container holding three CTAs:
  primary "Back to Forms" (→ `/forms`), secondary "Dashboard"
  (→ `/admin/dashboard`, rendered only when
  `form.audience === "internal"`), tertiary "Fill Out Another" (→
  `/forms/{slug}`, unchanged behavior). Added three new CSS classes
  to inline SUCCESS_CSS (`nav-btn-primary` / `nav-btn-secondary` /
  `nav-btn-tertiary`) — primary filled splash-blue, secondary
  outlined splash-blue on white, tertiary transparent splash-navy.
  Top docblock extended to note the Brief 118 audience-aware
  branching.
- `CLAUDE.md` — `forms-worker` glossary entry gains a Brief 118
  paragraph documenting the submissions index URL and the post-submit
  nav additions.
- `BRIEFS/INDEX.md` — Brief 118 row inserted above Brief 117.
- `BRIEFS/QUEUE.md` — Brief 118 entry commented out (completed).
- `BUILD_STATE.md` — Findings entry added; "Last updated" bumped.

**Files deleted.** None.

**Chosen URL for the admin submissions index.** `/admin/forms/submissions`.
The brief flagged a potential collision with `/admin/forms/[id]`;
verified that Next.js App Router's static-segment resolution precedes
dynamic segments (same pattern as the existing `/admin/forms/new`
route which coexists with `[id]`), so the static URL works without
renaming. Build confirms both routes render distinctly.

**Whether the post-submit page got inline buttons or a full Header
port.** Inline buttons (the brief's fallback option). Rationale:
porting the apps/web React `<Header />` to the splash-forms worker's
plain-HTML render path is a much bigger lift (would mean either
hardcoding the same HTML/CSS shape or routing through apps/web), and
the splash-navy + white-script-logo header chrome is already shipped
by the success page shell — only the action area needed new buttons.
Three buttons in a flex row at v1 (primary / secondary / tertiary).

**Whether forms-worker has multiple confirmation paths.** No — there's
exactly one confirmation surface, `renderSuccessPage(form)` in
`apps/forms-worker/src/submit/success.ts`, called from
`apps/forms-worker/src/submit/index.ts:410`. All audiences (public /
internal / link-only) and both fresh + idempotent re-submits flow
through it. Audience-aware copy is a single ternary at the top of the
template (`form.audience === "internal"` → render Dashboard button)
rather than a separate template per audience.

**Decisions made on operator's behalf.**

1. URL = `/admin/forms/submissions` not `/admin/forms/all-submissions`
   — verified static-segment precedence holds in Next.js App Router
   (same convention as `/admin/forms/new`).
2. Drafts filtered out client-side from the submissions index —
   drafts have no public URL → can't accrue submissions → don't
   belong on a submissions viewer.
3. Sort = submission count desc with alphabetical title tie-break
   (rather than alphabetical-only) — operators scanning for active
   forms benefit from hot forms surfacing first.
4. `StatusPill` prop type widened to `FormListItem["status"]` (incl.
   `draft`) even though the page filters drafts out — TypeScript
   doesn't narrow `.filter()` result element types, and widening the
   prop type is a smaller surface than adding a type predicate.
5. Inline buttons rather than full Header port (brief's fallback
   option) — the splash-navy bar + white-logo header chrome is
   already shipped by the success page shell; only the action area
   changed.
6. "Back to Forms" kept for non-authed (public / link-only) visitors
   rather than dropped to a single "Done" button — the link is
   harmless (it bounces to `/login` via the cookie middleware), and
   operators who deliberately log out mid-fill might want it.
7. `forms-submissions` tile tightened to `isAdminTier` rather than
   the brief's recommendation of "still allow direct URL bookmark".
   Direct URL access still works (the page hosts the gate via
   `<NoAccessCard reason="forbidden" />`); only the tile visibility
   on the dashboard is restricted. Brief 96's admin endpoint is
   admin-tier-only on the worker, so apps/web visibility now matches
   the underlying contract.
8. Card grid styling mirrors the Brief 109 JotForm index (navy
   gradient header + body) rather than the existing
   `/admin/forms` table layout — the brief asked for the JotForm
   shape and it works better as a tile-grid view when the form count
   is small (one card per form, less dense than a table).

**Latent issues / forward flags.**

- Per-user submissions scoping for RM/RD/GM is a v2 candidate per
  the brief's Out-of-scope section. Brief 96's per-form admin
  endpoint has no per-user scoping (admin-tier sees everything),
  so the apps/web visibility correctly matches the worker contract
  for v1.
- Aggregating submission counts across all forms into a single
  rollup tile or a `/admin/dashboard/submissions` summary is a v2
  reporting candidate.
- Adding the global apps/web `<Header />` to other forms-worker
  render surfaces (e.g., the form-fill page itself) is out of scope;
  only the post-submit confirmation got nav additions.
- Audience-aware confirmation copy / per-form custom redirect URLs
  are v2 candidates; current logic is a simple
  `audience === "internal"` branch.
- The submissions index card grid scales to ~24 forms before a 4th
  row appears at `lg`; reordering or grouping by audience is a v2
  candidate.
- The `/admin/forms/submissions` page is technically reachable by an
  authenticated user with `dcRole === null` — `<NoAccessCard
  reason="forbidden" />` handles it.

**Diff size estimate.**

- 1 file created (`apps/web/app/admin/forms/submissions/page.tsx`,
  ~170 LOC).
- 2 source files modified (tiles.tsx tile entry: ~6 LOC changed;
  success.ts: ~30 LOC added + ~5 LOC removed).
- 4 docs / index files modified (`CLAUDE.md`, `BRIEFS/INDEX.md`,
  `BRIEFS/QUEUE.md`, `BUILD_STATE.md`, this brief).

**Validation results.**

- `pnpm typecheck`: 18/18 packages green (17 cache hits, web ran
  fresh). Initial run flagged a `FormListItem.status` narrowing in
  the `StatusPill` subcomponent — fixed by widening the prop type to
  `FormListItem["status"]`.
- `pnpm --filter @splash/web build`: succeeded. New route
  `/admin/forms/submissions` 177 B / 105 kB First-Load JS. Every
  other route unchanged.
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build`: succeeded. Bundle 1053.80 KiB raw / 201.06
  KiB gzipped (≈ +0.5 KiB vs Brief 100's last forms-worker baseline,
  accounts for the success page nav HTML/CSS additions). `.tmp-build`
  cleaned up after.
- No Supabase / R2 / wrangler.toml / secret changes.
- No deploy / branch / push performed (per CLAUDE.md).
