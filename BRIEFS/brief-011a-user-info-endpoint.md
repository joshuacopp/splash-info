# Brief 11a: /api/me endpoint + Header user info + retrofit transition gating

**Status:** Completed (2026-05-04)
**Started:** 2026-05-04
**Completed:** 2026-05-04
**Blocks:** Brief 5d (documents — needs dc_role for canMutateDocument
gating). Also surfaces the operator preference of clickable affordances
matching real capability rather than rendering everything and 403-ing
on click.
**Dependencies:** Brief 1 (login flow), Brief 2 (Header in root layout),
Brief 5c (damage detail's transition section — this brief retrofits the
gating, but doesn't otherwise touch 5c's work).

## Read first
- CLAUDE.md
- BUILD_STATE.md (item 11a in the prioritized work list)
- BRIEFS/INDEX.md
- BRIEFS/brief-005c-damage-write-actions.md (Outcome — there's a
  TODO(5c-followup) comment in the damage detail page pointing here)
- apps/dashboard-worker/src/index.ts (existing /api/login,
  /api/logout, /api/forced-reset handlers — /api/me follows the same
  pattern minus the form parsing)
- apps/web/app/_components/Header.tsx (currently a client component
  using usePathname — receives optional user prop after this brief)
- apps/web/app/layout.tsx (root layout — becomes async to fetch /me)
- apps/web/app/_lib/worker-urls.ts (dashboardUrl helper)
- packages/auth/src/session.ts (authenticate() — the canonical session
  contract)
- packages/types/src/session.ts (Session shape)
- packages/types/src/auth.ts (UserRole)
- packages/types/src/claims.ts (DamageRole)

## Context

Until this brief, apps/web has no way to read the current user's
session server-side. Two impacts:

1. **Header has no email or role label.** Brief 2 originally specced
   email + role display; deferred because dashboard-worker has no
   user-info endpoint and reading the JWT in apps/web would require
   duplicating decode logic. Tracked as item 11a.

2. **Damage detail transition buttons are over-rendered.** Brief 5c
   shows every transition the current claim_status allows, regardless
   of the caller's dc_role. The worker rejects on POST and the page
   surfaces the error inline — functional but produces dead-end-feeling
   buttons. Operator's strong preference (2026-05-04) is to align
   what's rendered with what's actually clickable; the worker change
   to enable this is acceptable.

11a closes the gap end-to-end: a small new endpoint on dashboard-worker,
a server-side helper in apps/web, the Header refactor to display the
user, and the damage detail retrofit to gate by dc_role.

## Scope

1. **dashboard-worker GET /api/me.**
   File: `apps/dashboard-worker/src/index.ts`.
   - New handler `handleMe(request, env)` follows the same shape as
     `handleForcedReset` for the auth gate:
       - `isOriginAllowed(request)` first, return jsonError(403, "bad
         origin") if not.
       - `authenticate(request, env)` second; on
         `status !== "authenticated"` return jsonError(401, "unauthorized").
       - On authenticated, return `Response.json(session)` with the
         full Session as defined in `packages/types/src/session.ts`.
         Don't trim fields — Session is already the public-facing
         shape and trimming creates drift between worker and consumers.
   - Method: `GET`. No form parsing. Add to the dispatch table near the
     existing /api/login / /api/logout / /api/forced-reset entries.
   - Cache header: `Cache-Control: no-store` to make refresh semantics
     explicit (the cookie's content can change behind the user's back —
     e.g., a sysadmin grants a new tool — and stale cached /me leads
     to confusing UX).
   - Update the file's leading comment block to list /api/me alongside
     the existing endpoints.

2. **apps/web: getMe() server helper.**
   New file: `apps/web/app/_lib/me.ts`.
   - Pattern mirrors `apps/web/app/admin/damage/_lib/worker-fetch.ts`
     for cross-origin dev support — uses `process.env.NEXT_PUBLIC_DASHBOARD_WORKER_URL`
     when set, falls back to the request host otherwise.
   - Forwards cookies via `cookies()` from `next/headers`.
   - Returns `Session | null` (null on 401, throws on other non-2xx
     including network errors — caller catches if needed).
   - Wrap in React's `cache()` from "react" so multiple components
     in the same server render reuse a single fetch. Document this
     so future briefs know they can call `getMe()` freely without
     amplifying network calls.

3. **apps/web: Header refactor for user info.**
   - `app/_components/Header.tsx` currently is a client component
     using usePathname. Add an optional prop:
       ```ts
       export interface HeaderUser {
         email: string;
         roleLabel: string;        // "Super Admin" | "Location Admin"
         // Future: dcRoleLabel etc. Out of scope here.
       }
       export interface HeaderProps {
         user?: HeaderUser;
       }
       ```
   - When `user` is provided AND `isAdminContext` is true (existing
     usePathname-based check), render an inline user row to the LEFT
     of the existing nav controls:
       - Small text: `{user.email}` (white, opacity-90).
       - Below it (or beside, depending on Tailwind shape): the
         `{user.roleLabel}` in smaller sudsy-blue text (uppercase,
         tracked, mirroring the dashboard's eyebrow).
       - Visual reference: legacy/dashboard.js renderDashboard's
         `.user-bar` (lines ~432-451) — email + buttons grouped on
         the right. The new Header keeps the buttons grouped right;
         email + role go IN that group, just before the buttons.
   - When `user` is undefined (e.g., on /login while unauthenticated),
     render the Header exactly as it does today (no email row).

4. **apps/web: root layout fetches /me, passes to Header.**
   - `app/layout.tsx` becomes `async`:
     ```ts
     export default async function RootLayout({ children }) {
       const session = await getMe().catch(() => null);
       const user = session
         ? { email: session.email, roleLabel: roleLabelFor(session.role) }
         : undefined;
       return (
         <html>
           <body>
             <Header user={user} />
             <main>{children}</main>
           </body>
         </html>
       );
     }
     ```
   - `roleLabelFor(role: UserRole)` lives in a small helper:
     - `super_admin` → "Super Admin"
     - `location_admin` → "Location Admin"
     - Default → "Admin" (fallback for forward compat)
   - Place the helper next to `getMe()` in `app/_lib/me.ts` so consumers
     get both from one import.
   - Don't try to suppress fetching /me on public pages. The 401 path
     is fast, the helper handles it gracefully, and it keeps the layout
     uniform across all routes.

5. **apps/web: Damage detail retrofit — gate transitions by dc_role.**
   - `app/admin/damage/[id]/page.tsx` currently filters transitions by
     current `claim_status` only. Add a second filter using
     `session.dcRole`:
     ```ts
     const session = await getMe().catch(() => null);
     // ... existing claim fetch ...
     const validTransitions = TRANSITIONS.filter(t =>
       t.from === claim.claim_status &&
       (session?.dcRole != null && t.roles.includes(session.dcRole))
     );
     ```
   - Remove the TODO(5c-followup) comment that 5c left in place.
   - If `session === null` on a detail page, the user is unauthenticated
     and middleware would normally have already redirected. The branch
     can render zero transitions (defensive) — don't crash.
   - dcRole === null ("no damage role assigned") — `t.roles.includes(null)`
     is always false, so zero transitions show. The "No further
     transitions available" copy still renders, which is correct
     for that user.

6. **Verify Header display in dev.** (Test instructions for the operator,
   not Claude Code work.) After the brief lands, the operator should
   pull a fresh token, hit /admin/dashboard, and confirm the header
   shows email + role. In dev cross-origin, /me returns 401 because the
   cookie doesn't reach the dashboard-worker — Header gracefully shows
   without user info, matches the existing dev-only limitation flagged
   in BUILD_STATE.md. Document this expectation in the Outcome.

7. **BUILD_STATE.md updates.**
   - Bump Last updated.
   - Add Findings entry summarizing the work: new endpoint, Header
     refactor, damage retrofit, dev limitation reminder.
   - Mark item 11a in the prioritized work list as Completed.
   - Update the existing apps/web pages/files table — note that root
     layout is now async, Header has a user prop.

8. **BRIEFS/INDEX.md updates.**
   - Mark 11a Completed (today's date) with file link.

## Configuration
No new env vars (the existing NEXT_PUBLIC_DASHBOARD_WORKER_URL covers
cross-origin dev for /api/me).

## Out of scope

- Caching policy beyond React's `cache()` per-request. No KV / D1 /
  edge cache.
- Displaying dcRole or tools in the Header (only email + role label
  for v1). Future enhancement if needed.
- Refactoring damage list page (5a) to gate by dc_role — the worker
  already returns appropriately-scoped data, the list shows what the
  user can actually access, and adding a gating layer would be
  redundant. List page stays as-is.
- Any other tool's gating retrofit (sysadmin tile visibility on the
  dashboard, change-password access, etc.). The dashboard-tile-by-tool
  gating is item 11a's natural follow-up but isn't included here to
  keep scope tight.
- Refresh semantics if a user's session changes mid-tab (e.g., admin
  grants a tool during the user's session). Page reload picks up the
  new state via the no-store cache header on /api/me; live update is
  out of scope.
- Don't deploy worker changes. The new /api/me endpoint should land in
  the repo and be smoke-tested locally / on workers.dev only. The
  operator handles deploy.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages — the worker change touches
  apps/dashboard-worker which must remain green)
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/dashboard-worker build succeeds (or the
  equivalent worker-build command if the package uses a different
  script)
- New `apps/dashboard-worker/src/index.ts` includes the GET /api/me
  handler in the dispatch table, returns Session JSON on 200, 401 when
  unauthenticated, 403 on bad origin
- New file `apps/web/app/_lib/me.ts` exports `getMe()` (cached via
  React `cache()`) and `roleLabelFor()`
- `apps/web/app/_components/Header.tsx` accepts an optional `user`
  prop and renders email + role label when provided in admin context
- `apps/web/app/layout.tsx` is `async` and fetches /me, passes the
  derived user to Header
- `apps/web/app/admin/damage/[id]/page.tsx` filters transitions by
  `session.dcRole` and the TODO(5c-followup) comment is removed
- BUILD_STATE.md updated with all required entries
- BRIEFS/INDEX.md updated with 11a marked Completed
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Worker handler placement (where in the dispatch table) and any other
  small worker-side decisions
- Header layout decisions: how email + role landed visually next to
  the existing buttons, any responsive behavior at narrow viewports
- Whether the React `cache()` call in `getMe()` deduped fetches as
  expected (e.g., if any consumer beyond root layout already calls
  it — there shouldn't be in this brief, but flag anything you found)
- Any latent issues spotted while reading dashboard-worker or the
  damage detail page
- Validation results (typecheck output, both worker and web build
  outputs)
- Anything Brief 5d should know now that dc_role is server-available

## Outcome

### Files created

- `apps/web/app/_lib/me.ts` — server-only helper exporting `getMe()`
  (wrapped in React `cache()`, returns `Session | null` from
  dashboard-worker `/api/me`) and `roleLabelFor(role: UserRole)` (maps
  `super_admin` → "Super Admin", `location_admin` → "Location Admin",
  default → "Admin"). Mirrors the cross-origin-dev / same-origin-prod
  URL pattern from `apps/web/app/admin/damage/_lib/worker-fetch.ts`,
  but using `NEXT_PUBLIC_DASHBOARD_WORKER_URL` instead of the damage
  variant. Sets the `Origin` header explicitly so the worker's
  `isOriginAllowed` accepts the server-side fetch.

### Files modified

- `apps/dashboard-worker/src/index.ts` — added `GET /api/me` dispatch
  entry after `/api/forced-reset` (so the file's flow reads login →
  logout → forced-reset → me); added `handleMe(request, env)` after
  `handleForcedReset()` that gates with `isOriginAllowed` then
  `authenticate()`, returns the full `Session` JSON with
  `Cache-Control: no-store`. The leading comment block now lists
  `/api/me` alongside the existing endpoints, including its auth-gate
  position and rationale for `no-store`.
- `apps/web/app/_components/Header.tsx` — exported `HeaderUser` and
  `HeaderProps` types; the `Header` component now accepts an optional
  `user?: HeaderUser` prop. When provided AND in admin context, an
  inline two-line user identity block (email above a small uppercase
  tracked sudsy-blue role label) renders to the LEFT of the existing
  Dashboard / Change Password / Sign Out buttons. The outer `<nav>`
  is now `flex-wrap` with `gap-x-4 gap-y-2` so the bar wraps cleanly
  at narrow viewports rather than horizontally overflowing.
- `apps/web/app/layout.tsx` — `RootLayout` is now `async`; calls
  `getMe().catch(() => null)` and derives a `HeaderUser | undefined`
  passed to `<Header user={user} />`. Comment updated to document
  the React `cache()` deduplication and the swallow-errors choice
  (covers unauthenticated, dev cross-origin cookie limitation, and
  transient worker outages alike).
- `apps/web/app/admin/damage/[id]/page.tsx` — claim fetch and
  `getMe()` now run in parallel via `Promise.all` (the cache makes
  the second `getMe()` call free since the layout already fired
  one); transitions filter is now
  `transitionsFrom(claim.claim_status).filter(t => dcRole !== null && t.allowedRoles.includes(dcRole))`;
  leading comment block updated to reflect the 11a gating.
- `apps/web/app/admin/damage/_lib/transitions.ts` —
  `TODO(5c-followup):` comment removed; the `allowedRoles` JSDoc now
  documents that 11a wired the gating and the worker re-validates as
  defense-in-depth.

### Decisions made on operator's behalf

1. **`/api/me` is GET** — read-only operation, brief implied GET,
   matches read/write split in the rest of the worker.
2. **`isOriginAllowed` gate on the GET** — kept for cross-origin
   readers who would otherwise see a confusing CORS-shaped failure.
   The endpoint reads the user's own session; a clean 403 is the
   right shape on bad origin.
3. **Return the full `Session` JSON** with no field trimming — the
   `Session` type at `packages/types/src/session.ts:11` is already
   the public-facing shape per its leading comment, and trimming
   creates drift between this endpoint and other consumers of
   `authenticate()`.
4. **`Cache-Control: no-store`** so a sysadmin granting a tool, an
   admin flipping a role, etc. take effect on the next page render
   rather than serving a stale Session.
5. **`getMe()` wrapped in React `cache()`** — the root layout calls
   it for the Header and the damage detail page calls it for
   transition gating; both share a single fetch via the cache. The
   cache key is the function identity (no args) so any consumer in
   the same render reuses the result.
6. **`Origin` header set explicitly** — server-side fetch doesn't
   auto-populate `Origin` and the worker's `isOriginAllowed`
   rejects without it; derived from the target URL so it works in
   both prod same-origin and dev cross-origin (modulo the
   well-known dev cookie limitation).
7. **Cross-origin URL fork mirrors the damage helper** —
   `NEXT_PUBLIC_DASHBOARD_WORKER_URL` short-circuit when set,
   request-host fallback otherwise.
8. **Header layout** — `flex-col items-end leading-tight` group
   with `text-sm text-white/90` email above a smaller
   `text-[11px] font-semibold uppercase tracking-[0.18em]
   text-sudsy-blue` role label, placed inline with the buttons via
   a `flex-wrap` outer nav so narrow viewports wrap rather than
   overflow.
9. **Defensive `session === null` branch on damage detail** — in
   practice unreachable (middleware redirects unauthenticated users
   to `/login` before the page renders), but if it ever fires
   `dcRole !== null` is false so the filter yields zero transitions
   and the existing "No further transitions available from current
   status." copy renders without crashing.
10. **`session.dcRole === null` ("no damage role assigned")
    collapses to zero transitions** — `t.allowedRoles.includes(null)`
    is always false (DamageRole has no null variant), so the same
    empty-state copy renders, which is the correct UX for that user.
11. **The brief's TS spec used `t.roles`** — the actual `UITransition`
    field is `allowedRoles` (per `apps/web/app/admin/damage/_lib/transitions.ts:51`).
    Used `allowedRoles` to match the file.

### Latent issues found

- **Dev cross-origin cookie limitation persists** — in dev when
  apps/web (localhost / workers.dev) and dashboard-worker (different
  workers.dev URL) live on different origins, the `sb-access-token`
  cookie set by the worker origin doesn't reach apps/web's origin
  under SameSite=Lax. `/api/me` reliably returns 401 in that mode
  and the Header gracefully renders without user info. Per the
  brief's §6 — operator should expect this in dev and verify
  end-to-end only post-cutover (or with a same-origin proxy in dev).
- **`authenticate()` is two round-trips** — `/auth/v1/user` then a
  Supabase service-role read of `auth_unified`. React `cache()`
  reduces it to one round-trip pair per page render rather than per
  call site. Acceptable for SSR latency; if the layout becomes a
  hotspot, JWT-only decode for email + role plus a separate dcRole
  fetch is the optimization, but not yet warranted.
- **Brief 5d will get free dc_role gating from `getMe()`** — its
  `canMutateDocument` checks for Quote/Receipt edit + delete buttons
  can call `getMe()` directly with no extra network cost (cache-shared
  with the layout's call). `dcRole === null` reliably means "no damage
  role" and should collapse mutation buttons to zero, mirroring how
  transitions now behave.

### Header layout decisions / responsive behavior

- Email + role label live in a single right-aligned column to the
  LEFT of the buttons. The visual reference in the brief
  (legacy/dashboard.js renderDashboard's `.user-bar`) had email +
  buttons sharing the same row; this preserves that shape.
- The outer nav switched from `flex` (buttons-only) to
  `flex-wrap items-center justify-end gap-x-4 gap-y-2` plus an
  inner button group with `flex items-center gap-3`. On narrow
  viewports (mobile), the user identity block wraps to its own
  line above the buttons rather than horizontally overflowing.
- The role label uses `tracking-[0.18em] text-sudsy-blue` to mirror
  the eyebrow treatment used elsewhere in the admin chrome
  (`/admin/dashboard`, `/admin/damage` Internal Tools eyebrow,
  etc.) — gives the role a recognizable visual rhythm without
  introducing a new color or font.

### React `cache()` dedup verification

- `getMe()` is called from two server-render entry points:
  1. `apps/web/app/layout.tsx` (the root layout, fires on every
     page render).
  2. `apps/web/app/admin/damage/[id]/page.tsx` (only on the damage
     detail page).
- Both run in the same server render. React's `cache()` keys by
  the wrapped function identity (no args), so the second call
  re-uses the layout's Promise — verified by reading the
  next/server-rendering contract: `cache()` returns the same
  memoized result for the duration of a single request.
- No other consumer beyond root layout exists in this brief; future
  pages should know they can call `getMe()` freely without
  amplifying the network round-trip.

### Worker handler placement

- Dispatch entry placed after `/api/forced-reset` so the dispatch
  reads login → logout → forced-reset → me — same surface area as
  the leading comment block, easy to scan top-to-bottom.
- Handler function defined after `handleForcedReset` for the same
  reason. Worker-local helpers (`sanitizeRedirect`,
  `void ACCESS_TOKEN_COOKIE`) untouched.

### Verification expectation for the operator (dev)

After the brief lands, pull a fresh access token and hit
`/admin/dashboard`. The header should show email on top and the
role label ("Super Admin" / "Location Admin") below it.

In dev cross-origin (apps/web on localhost, dashboard-worker on
its own workers.dev URL), `/api/me` will return 401 because the
`sb-access-token` cookie doesn't cross origins under SameSite=Lax.
The header will render in its public (logo-only) shape on every
page, which is the documented dev limitation. End-to-end
verification of the user identity block requires either same-origin
production setup or a local same-origin proxy.

### Validation

- `pnpm typecheck` — **13/13 successful, 3.661s** (11 cached + the
  two changed packages — `@splash/dashboard-worker` and
  `@splash/web` — ran fresh).
- `pnpm --filter @splash/web build` — **succeeded**. Next 15.5.15
  compiled in 4.1s, 12/12 static pages generated. The
  `/admin/damage/[id]` route is still `ƒ` at **171 B / 105 kB
  First Load JS** — identical bundle footprint to 5c despite the
  new `getMe()` import (the helper is server-only and adds zero
  client JS). Other routes unchanged from 5c's snapshot.
- `wrangler deploy --dry-run --outdir .wrangler/dry-run-out` for
  `@splash/dashboard-worker` — **succeeded**. Bundle: **713.29
  KiB uncompressed / 135.20 KiB gzipped**, well under CF's 3 MiB
  free / 10 MiB paid limits. No growth concern from adding
  `handleMe`. (Used `wrangler deploy --dry-run` because
  dashboard-worker's `package.json` has no dedicated build script;
  the dry-run deploy is the canonical bundle-build path for CF
  workers.)
