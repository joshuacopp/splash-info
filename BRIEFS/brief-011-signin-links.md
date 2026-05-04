# Brief 11: "Sign In" links from auth-failed states

**Status:** Completed (2026-05-04)
**Started:** 2026-05-04
**Completed:** 2026-05-04
**Blocks:** Admin-facing UX (small)
**Dependencies:** Brief 1 (login page exists)

## Read first
- CLAUDE.md
- BUILD_STATE.md
- AUDIT_REPORT.md (section 9, item 11 - the original gap)
- apps/web/app/admin/pricing/page.tsx
- apps/web/app/admin/pricing/[location]/page.tsx
- apps/web/middleware.ts (for the ?return= contract)

## Context
apps/web's pricing pages render a "no access" card when the signup-worker
returns 401/403 from /admin/api/locations or /admin/api/locations/{loc}.
Both cards today are dead-ends: the user sees the message but has no way
to recover without manually navigating to /login. The middleware redirects
unauthenticated users away from these pages already, so the "no access"
state primarily fires when the user has a stale or malformed cookie that
PASSES middleware (presence-only) but FAILS at the worker (validates the
JWT).

This brief adds a "Sign In" link to each no-access card pointing at
/login with a ?return= parameter so that after re-auth the user lands
back where they started. The pattern is identical to what middleware
already does for unauthenticated redirects, just exposed as a
user-clickable affordance from the no-access state instead.

This is also the first non-DryRun exercise of the orchestrator daemon -
it's intentionally small to keep the surface area for early debugging
narrow.

## Scope

1. apps/web/app/admin/pricing/page.tsx
   - In the "You don't have access to Pricing Admin" branch (when
     workerGetJson returns null), add a "Sign In" link below the
     existing message text.
   - Link target: /login?return=%2Fadmin%2Fpricing (encoded). Use
     Next.js's <Link> from "next/link" - same pattern as the dashboard
     tiles in /admin/dashboard.
   - Visual treatment: a button-style affordance matching the
     "Back to Dashboard" button in apps/web/app/admin/sysadmin/page.tsx
     (rounded-splash-sm, bg-splash-blue, white text). Position it
     immediately after the existing <p> message, with a sensible
     vertical gap.
   - Do NOT change the existing message text or the "Setup Incomplete"
     branch (which is a different empty-state - the user IS authed but
     has no locations assigned; that path is fine as is).

2. apps/web/app/admin/pricing/[location]/page.tsx
   - Same treatment in the "You don't have access to {location}" branch.
   - Link target: /login?return=%2Fadmin%2Fpricing%2F{encoded-location}.
     Build the return path with encodeURIComponent on the location code,
     same as the existing /admin/api/locations/{encoded} call elsewhere
     in the file.
   - Keep the existing "Back to location picker" link below the new
     "Sign In" button - both can coexist; the user might choose either
     escape hatch.

3. Verify there are no other "no access" surfaces in apps/web that need
   the same treatment. Likely candidates to grep for:
   - `workerGetJson` callers with `if (!data)` branches
   - Any page that renders an explicit "don't have access" message
   - The /admin/dashboard, /admin/damage, /admin/performance,
     /admin/sysadmin pages do NOT currently auth-check (placeholders
     or dashboard tiles). Leave them out of scope for this brief.

4. Update BUILD_STATE.md per its Conventions:
   - Bump "Last updated"
   - Add a Findings entry summarizing what changed
   - Mark item 11 in the prioritized work list as Completed

5. Update BRIEFS/INDEX.md - flip item 11 row to Completed (YYYY-MM-DD)
   and link the file to brief-011-signin-links.md.

## Out of scope
- Modifying middleware.ts (the redirect contract already works for
  unauthenticated users; this brief is for the post-middleware
  401/403-from-worker case)
- Adding Sign In links to placeholder pages that don't auth-check
- Modifying the login form or change-password form
- Worker code changes
- Don't deploy to Cloudflare
- Don't bind production routes
- Don't commit to git or push

## Definition of done
- pnpm typecheck passes
- pnpm --filter @splash/web build succeeds
- Both pricing no-access cards render a "Sign In" button
- The button link includes the appropriate ?return= for round-trip
- No other "no access" surfaces missed (grep verification documented in
  Outcome)
- BUILD_STATE.md updated
- BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report
- Decisions made on the operator's behalf (visual treatment, link
  positioning, etc.)
- Any other no-access surfaces found and how they were handled
- Any latent issues surfaced during the work
- Validation results (typecheck output, build output)

## Outcome

**Files modified:**
- `apps/web/app/admin/pricing/page.tsx` — added `import Link from "next/link"`; appended a "Sign In" `<Link>` inside the `if (!data)` no-access branch, immediately below the existing message paragraph. Link target hardcoded to `/login?return=%2Fadmin%2Fpricing` (encoded once at author time, since both segments are static).
- `apps/web/app/admin/pricing/[location]/page.tsx` — added `import Link from "next/link"`; built `returnPath = /admin/pricing/${encodeURIComponent(location)}` and rendered a "Sign In" `<Link>` with `href={`/login?return=${encodeURIComponent(returnPath)}`}` (double-encoding is intentional: `encodeURIComponent(location)` first, so the resulting path stays valid post-redirect; then `encodeURIComponent(returnPath)` so the entire path becomes a single safe `?return=` query value). Existing "← Back to location picker" link kept below the new button per the brief.

**Files created:** none.

**Decisions made on the operator's behalf:**
- *Visual treatment:* matched the "Back to Dashboard" button in `/admin/sysadmin/page.tsx` exactly — `inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark`. The brief explicitly called for this style.
- *Positioning:* wrapped the `<Link>` in a `<p>` with `style={{ marginTop: 16 }}` so the new button sits below the existing red "you don't have access" message with a clear vertical gap, while keeping the surrounding inline-style aesthetic of these legacy pricing pages. On the `[location]` page, the existing "Back to location picker" link sits below the new Sign In button with `marginTop: 12`.
- *Mixing inline styles + Tailwind:* the existing pricing pages use plain inline `style={{ ... }}` (legacy carry-over); the new Sign In button uses Tailwind utilities. This is a one-off intentional mix to keep the button visually consistent with the rest of the apps/web admin chrome (the sysadmin placeholder uses the same Tailwind treatment). Restyling the entire pricing page to Tailwind is a separate cleanup, not in scope.
- *Button vs. plain text link:* chose button affordance per brief; explicit recovery action in an error state should look clickable, not like body copy.

**Other no-access surfaces audited:**
- Grepped `apps/web` for `workerGetJson`, `if (!data)`, "no access", "don't have access", `401`, `403`. Hits:
  - `app/login/form.tsx` — 401/403 are inline form errors ("Invalid email or password" / "no_permissions_assigned"), not no-access cards. Out of scope (brief is about post-middleware auth-failed states on protected pages, not the login form's own credential handling).
  - `app/change-password/form.tsx` — 401 from forced-reset is a "session expired" inline error, not a no-access card. Out of scope.
  - `app/admin/dashboard/page.tsx`, `app/admin/damage/page.tsx`, `app/admin/performance/page.tsx`, `app/admin/sysadmin/page.tsx` — none of these auth-check (placeholders or pure tile rendering); per the brief, intentionally out of scope.
  - The two pricing pages were the only `workerGetJson` callers with `if (!data)` no-access branches. No other surfaces missed.

**Latent issues found:** none surfaced during this work. The `[location]` no-access path now has three escape hatches stacked vertically (Sign In button, "Back to location picker" link, and the global Header's Dashboard / Sign Out controls) — that's intentional per brief, since after a stale-cookie clear the user might want any of them.

**Validation:**
- `pnpm typecheck` — **13/13 successful** (turbo cache was empty for the changed pkgs; full run took 9.7s).
- `pnpm --filter @splash/web build` — **succeeded**. Next.js 15.5.15 compiled in 8.1s, generated 12/12 static pages, finalized page optimization. `/admin/pricing` and `/admin/pricing/[location]` both still ƒ (dynamic, server-rendered) at 167 B / 3.65 kB respectively, no size regression.
