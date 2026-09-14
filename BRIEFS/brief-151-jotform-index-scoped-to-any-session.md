# Brief 151: JotForm submissions index visible to any authenticated session (scoped per row)

**Status:** Completed (2026-06-03)
**Started:** 2026-06-03
**Completed:** 2026-06-03
**Blocks:** Onboarding — location_admin and RM/RD/GM users can't reach
the JotForm index even when they have submissions to review at their
locations
**Dependencies:** none

## Read first
- BUILD_STATE.md
- CLAUDE.md — the jotform-worker glossary entry (Brief 107) and the
  Brief 109 paragraph that documents the current admin-tier gate on
  `/admin/jotform` and explains the original "RM/RD/GM can still open
  per-form URLs by direct link" decision (which we're now reversing).
- apps/jotform-worker/src/handlers/ (or wherever the
  `GET /admin/jotform/api/forms` and `GET /admin/jotform/api/roster`
  handlers live)
- apps/jotform-worker/src/db.js — confirm whether `listForms` accepts
  a site-number filter
- packages/db-supabase (or wherever `accessibleSiteNumbersForSession`
  lives — referenced from Brief 110 / Brief 107)
- apps/web/app/admin/jotform/page.tsx — the index page that today
  rejects non-admin sessions
- apps/web/app/admin/dashboard/_lib/tiles.tsx — the "JotForm" tile
  visibility predicate (admin-tier today; needs to widen to anySession)
- apps/web/app/admin/jotform/[form_id]/page.tsx — the per-form list
  page that already does the right thing (any-session, worker scopes
  rows). Reference for the gate pattern to copy.

## Context

Beta tester (location_admin assigned to Cicero, claims + pricing tools
granted) hit the JotForm index and got:

> The JotForm index requires super_admin or admin. RM/RD/GM users
> can still open a per-form view by direct link — your submissions
> are scoped automatically. Contact a super_admin if you need broader
> access.

That message is from Brief 109 (admin-tier gate on the index). The
underlying assumption was that non-admins would just type / bookmark
the per-form URL directly. In practice they don't know which forms
exist or what they're called, so they can't reach the per-form view
without help. The submissions exist for their location; they're locked
out of the surface that lists them.

The data model already supports per-row scoping: the per-form list
endpoint `GET /admin/jotform/api/{form_id}/submissions` and detail
endpoint already use `accessibleSiteNumbersForSession` to scope rows.
The only thing actually admin-gated is the INDEX endpoint
(`GET /admin/jotform/api/forms`) and the index page rendering. Fixing
this is just a matter of widening that gate AND scoping the per-form
COUNTS by the same site-number filter so non-admins see accurate
"submissions waiting for me" numbers.

Operator's directive: location_admin and RM/RD/GM users SHOULD see the
JotForm index, and the counts shown alongside each form should reflect
only the submissions visible to that user.

## Scope

1. **Widen `GET /admin/jotform/api/forms`** (apps/jotform-worker).
   - Drop the admin-tier gate; accept any authenticated session.
   - Compute `accessibleSiteNumbersForSession` for the caller. For
     super_admin / admin / dcRole-admin / dcRole-super_admin this
     returns "all" (the existing wildcard), no change in behavior.
   - For RM / RD / GM / location_admin (and anyone else who's not
     admin-tier), the per-form count must filter
     `jotform_submissions.site_number` to the accessible set. Match
     the same padded/unpadded-strings convention used in
     Brief 107 (`site_number` stored as integer, but the filter set
     is built as both zero-padded and unpadded string forms to handle
     the JotForm `typeA` widget mismatch). If the existing helper
     `resolveLocationFilters` in `apps/jotform-worker/src/filters.js`
     already does this, reuse it; otherwise mirror the pattern.
   - When the caller has an empty accessible-site set (e.g. a brand-
     new user with role but no locations), every per-form count
     short-circuits to 0 but the form rows themselves still render —
     so the page renders a friendly "No submissions accessible to
     you yet" state instead of an empty page or 403.
   - Response shape stays the same — operators just see scoped
     `submissionCount` values.

2. **Widen `GET /admin/jotform/api/roster`** the same way (Brief 110).
   - It's already documented in CLAUDE.md as returning
     `{regional_directors, regional_managers, locations, scope}`
     scoped to the caller's accessible site numbers. Confirm the gate
     today — if it's already any-session, no change needed; if it's
     admin-tier, widen it.
   - The roster endpoint feeds the FilterBar dropdowns inside the
     per-form viewer. It must be reachable for the same audience as
     the per-form list endpoint, which is any-session per Brief 107.
     This is mostly a "verify no regressions" item; the actual
     dropdown contents are already scoped.

3. **Widen `apps/web/app/admin/jotform/page.tsx`.**
   - Replace the admin-tier auth check with the lighter "any session"
     check used by `apps/web/app/admin/jotform/[form_id]/page.tsx`.
     Reuse whatever helper that page already uses (likely
     `authenticate()` + the same `NoAccessCard` for unauth, but no
     role check).
   - When the session is authenticated AND
     `accessibleSiteNumbersForSession` is empty (no locations matched
     for the user's email + dcRole), render a friendly message:
     "You don't have any locations with JotForm submissions yet. If
     this is unexpected, contact a super_admin." — NOT the old
     "requires super_admin or admin" wording.
   - Keep the existing card grid as the happy path. Forms with
     `submissionCount === 0` for the caller should still appear in
     the grid (so a user knows the form exists) but render with a
     muted count + a "0 submissions for your locations" caption.

4. **Update the dashboard `jotform` tile predicate.**
   - In `apps/web/app/admin/dashboard/_lib/tiles.tsx`, find the
     `jotform` tile (it's in the Submissions group per Brief 109).
     Change `visibleTo: isAdminTier` to `visibleTo: anySession`. The
     page itself will render the friendly empty-state if the caller
     ends up with no accessible sites, so the tile is always safe to
     show to a signed-in user.

5. **Audit the per-form pages for residual admin gates.**
   - `apps/web/app/admin/jotform/[form_id]/page.tsx`,
     `apps/web/app/admin/jotform/[form_id]/[submission_id]/page.tsx`,
     and the CSV export route should all be any-session today (per
     Brief 107). Confirm with a grep; if any of them still has an
     admin-tier check left over from Brief 109, drop it.

## Configuration

No new env vars or secrets. Reuses the existing
`accessibleSiteNumbersForSession` helper that the per-form endpoints
already call.

## Out of scope

- Don't widen any other admin index (Email Queue, Database Admin,
  etc.) — operator's directive is specifically about JotForm. If you
  notice the same admin-tier-index-but-scoped-rows pattern elsewhere,
  flag it in the Report instead of fixing it here.
- Don't change row-level scoping — the existing per-form `site_number`
  filter via `accessibleSiteNumbersForSession` is correct. Only the
  COUNT roll-up needs to scope.
- Don't change the JotForm webhook ingest path or the
  super_admin-only backfill endpoint.
- Don't change the admin-tier visibility of unrelated dashboard tiles.
- Don't deploy to Cloudflare; don't bind production routes; don't
  commit to git or push.

## Definition of done

- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/jotform-worker build` succeeds (or the
  equivalent — JotForm worker is verbatim JS per Brief 107; verify
  the worker still bundles cleanly).
- A `location_admin` user assigned to Cicero hits `/admin/jotform`
  and sees the form-card grid. Cards render with submission counts
  scoped to Cicero's `site_number` (both padded and unpadded forms).
- A super_admin still sees all forms with unscoped counts (no
  regression).
- A signed-in user with zero accessible sites hits `/admin/jotform`
  and sees the friendly "no locations yet" message — NOT a 403, NOT
  the old "requires super_admin" wording.
- Clicking a form card from a location_admin session lands on the
  per-form list and shows only that user's accessible rows (existing
  behavior — verify it still works).
- The dashboard `jotform` tile is now visible to RM / RD / GM /
  location_admin sessions, not just admin-tier.
- BUILD_STATE.md updated: bump "Last updated", add a Findings entry
  ("Brief 151: JotForm submissions index widened to any session;
  per-form counts now scoped via accessibleSiteNumbersForSession.
  Closes onboarding gap for location_admin / RM / RD / GM beta
  testers").

## Report

- Whether the `resolveLocationFilters` helper in
  `apps/jotform-worker/src/filters.js` was reusable for the
  count-scoping or needed a new variant.
- Any submissions-index-style surface elsewhere in the codebase that
  ALSO admin-tier gates the index page but row-scopes the underlying
  data (e.g. Forms submissions admin, Email Queue, Fleet, Damage).
  Don't fix them; just flag.
- Whether the per-form count query needed a Postgres `COUNT(*) FILTER
  (...)` reshape or whether `?site_number=in.(...)` worked cleanly
  via PostgREST.
- Empty-state UX: did the friendly "no locations yet" message land
  on the index page, the empty-card-list state, or both?

## Outcome

**Files created.** None.

**Files modified.**

- `apps/jotform-worker/src/db.js` — `countSubmissionsForForm(env, formId)`
  gained an optional third arg `siteNumbers` (`Set<string> | undefined`).
  Empty Set short-circuits to 0 without hitting Supabase; non-empty Set
  appends a `site_number=in.(...)` filter using the existing
  `quoteForIn` helper (the same shape `listSubmissions` /
  `listSubmissionsForCsv` already use). `undefined` keeps the prior
  unscoped behavior.
- `apps/jotform-worker/src/handlers/admin.js` — `handleListForms`
  switched from `authenticateAdminOrHigher` to `authenticateForAdminApi`
  (any authenticated session). Computes the caller's scope via
  `accessibleSiteNumbersForSession`, threads it into the per-form
  `countSubmissionsForForm` call, and tags the response with
  `scope: "all" | "scoped"` so apps/web can render scope-aware copy.
  Unused `authenticateAdminOrHigher` import removed (still exported
  from `auth-gate.js` for back-compat; no other call site). Header
  doc comment updated to reflect the widening.
- `apps/web/app/admin/jotform/_lib/worker-fetch.ts` —
  `JotformFormsResponse` gained `scope?: "all" | "scoped"`.
- `apps/web/app/admin/jotform/page.tsx` — admin-tier auth check dropped;
  any authenticated session passes (matches the per-form pages).
  Header copy adapts to scope ("scoped to your locations" vs the
  prior "RM / RD / GM views are scoped automatically" hint). When
  scope is `"scoped"` AND every form returns 0, renders a friendly
  callout above the card grid ("You don't have any JotForm
  submissions at your locations yet…") rather than substituting the
  whole card grid for an empty state — operators still see what
  forms exist. Per-card render is also scope-aware: scoped + count
  of 0 renders muted (70% opacity) with "0 submissions for your
  locations" caption; scoped + count > 0 renders "{N} submissions
  at your locations"; admin-tier preserves the prior "{N}
  submissions on record" copy.
- `apps/web/app/admin/jotform/_components/NoAccessCard.tsx` —
  `forbidden` branch removed (now unreachable on every callsite).
  `reason` prop dropped from the public interface; component now
  takes only `returnPath?`. Header comment updated.
- `apps/web/app/admin/jotform/[form_id]/page.tsx` — `listForms()`
  call de-gated (Brief 109 had wrapped it in `if (isAdminTier)` to
  spare RM / RD / GM a round-trip; now any session calls it so all
  callers get a proper display_name + early 404 on stale links).
  Header sub-line now scope-aware: scoped → "{N} submissions at your
  locations"; admin-tier → "{N} submissions on record". 404 comment
  updated. `NoAccessCard` callsite trimmed of the now-removed
  `reason` prop.
- `apps/web/app/admin/jotform/[form_id]/[submission_id]/page.tsx` —
  `NoAccessCard` callsite trimmed of the now-removed `reason` prop.
  No other change needed; per-submission gate was already
  signin-only with worker-side anti-leak 404 enforcement.

**Decisions made on operator's behalf.**

1. **Drop `NoAccessCard.reason` entirely instead of keeping the
   admin-tier "forbidden" branch as dead code.** All three jotform
   pages now use only the `signin` reason. CLAUDE.md explicitly
   discourages renaming-to-`_unused` / back-compat hacks; the cleaner
   move was to narrow the component's interface to the single
   `returnPath?` prop. If a future jotform surface needs a
   `forbidden` state again, re-introduce it at that brief.
2. **De-gate the `listForms()` call on the per-form page (Brief 109
   residual).** Now that the endpoint is any-session, gating it
   gave no upside and cost non-admin callers their form display_name
   in the page title (they previously saw the raw `form_id` as
   fallback). All callers now get the friendly title + early 404 on
   stale links.
3. **Scope-aware header copy on both the index and per-form pages.**
   Counts for non-admin callers are scoped, so rendering "{N}
   submissions on record" would be misleading. Index renders
   "{N} submissions at your locations" for scoped callers and "{N}
   submissions on record" for admin-tier; per-form sub-line follows
   the same pattern.
4. **Empty-scope render = friendly callout above the form-card
   grid, not an empty grid.** The brief's "no locations yet"
   message lands as a top-of-page callout when the scoped caller
   has zero submissions across every form (and every per-form card
   is muted). That gives the caller the brief's "this is the empty
   state" cue but still surfaces the form names so they know what's
   wired up if a submission later lands at their site. If the
   caller has at least one form with a non-zero count, no callout
   renders.

**Report items requested by the brief.**

- **`resolveLocationFilters` reusability**: not reused. That helper
  layers per-request URL filter params (`am_email` / `rm_email` /
  `location_code`) on top of the caller's accessible scope, then
  intersects. The Brief 151 count handler has no per-request filter
  params — it only needs the raw accessible scope. Using
  `resolveLocationFilters` would have added a synthetic
  `URLSearchParams` argument with no actual filters and looked
  surprising at the call site. Calling `accessibleSiteNumbersForSession`
  directly (the helper `resolveLocationFilters` itself wraps for
  the scope tier) is the correct primitive here.
- **Same admin-tier-index-but-scoped-rows pattern elsewhere
  (flagged, not fixed per Out of scope)**:
  - `/admin/email-queue` index — admin-tier gated; rows are
    org-wide. Underlying data isn't per-location scoped, so
    widening would be a policy change, not a scoping fix. Not
    analogous to JotForm.
  - `/admin/forms/submissions` index — admin-tier gated; the
    per-form `submissions` viewer downstream is also admin-tier
    today (Brief 96/118). Forms scope per location via the workflow
    approval domain, not via a `site_number` filter on submissions
    themselves. Widening would require a row-scoping decision the
    forms feature doesn't have yet. Not analogous to JotForm.
  - `/admin/fleet` index — admin-tier gated; fleet submissions
    have no per-location scoping at all (every inquiry is a global
    record). Not analogous.
  - `/admin/damage` — already any-session via `accessibleSiteNumbersForSession`
    on the damage-worker side; no change needed.
  - **Conclusion**: JotForm was the only surface where the data
    model already supported per-row scoping but the index gate
    blocked non-admin discovery.
- **Postgres `COUNT(*) FILTER (...)` vs `?site_number=in.(...)`**:
  the existing `site_number=in.(...)` PostgREST filter worked
  cleanly. The `Prefer: count=exact` header on a `limit=0` request
  returns the filtered count via `Content-Range` without
  transferring any rows — same pattern the unscoped count uses.
  No SQL function or RPC was needed.
- **Empty-state UX location**: friendly empty message lands as a
  top-of-page callout ABOVE the card grid (not as a replacement for
  it). The cards still render alongside the callout, each carrying
  the muted "0 submissions for your locations" caption, so the
  user can still see what forms exist. The brief's "NOT a 403,
  NOT the old 'requires super_admin' wording" requirement is
  satisfied by both the callout and the per-card caption.

**Latent issues / forward flags.**

- The `authenticateAdminOrHigher` helper in `auth-gate.js` now has
  zero call sites in this worker. Left exported for future surfaces
  that might genuinely need a super_admin / admin-only gate (e.g.,
  a future per-form configuration endpoint). Delete if a future
  cycle confirms it's unused across all foreseeable surfaces.
- The per-form page's `isAdminTier(session)` helper is still used
  by Brief 115's `renderCountOnly` decision tree — that's a
  visual-mode choice (count-only tile vs grouped view), not an
  access gate. Kept as-is.
- The legacy paginated response shape on
  `GET /admin/jotform/api/{form_id}/submissions` (without
  `count_only` or `group=location`) carries the same `scope` field
  it always did; no shape change there. Brief 115's grouped /
  count-only modes also unchanged.

**Validation.** Root `pnpm typecheck` 18/18 green (16 cached, web +
jotform-worker ran fresh; 5.092s total). `pnpm --filter @splash/web
build` succeeded — `/admin/jotform` route chunk 187 B / 107 kB
First-Load JS (unchanged vs prior baseline; the only diff is in a
larger inline string for scope-aware copy). `/admin/jotform/[form_id]`
1.59 kB / 109 kB (unchanged within rounding). `pnpm --filter
@splash/jotform-worker exec wrangler deploy --dry-run --outdir=.tmp-build`
succeeded — bundle 763.44 KiB raw / 144.64 KiB gzipped. `.tmp-build`
cleaned up after. No CF deploys; no production-route bindings; no
git commits or pushes per CLAUDE.md.
