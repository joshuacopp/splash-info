# Brief 147: forced-password-reset leaves stale session; /admin/damage 403 (esp. iOS)

**Status:** Completed (2026-06-01)
**Started:** 2026-06-01
**Completed:** 2026-06-01
**Blocks:** Beta testing — 3/3 testers blocked on damage portal access
**Dependencies:** none

## Read first
- BUILD_STATE.md
- CLAUDE.md
- packages/auth/src/index.ts (authenticate + auth_unified read)
- packages/auth/src/session.ts
- packages/auth/src/cookies.ts (if it exists — cookie helpers)
- apps/dashboard-worker/src/index.ts (the `/api/login`, `/api/logout`,
  and `/api/forced-reset` handlers — particularly what `Set-Cookie`
  headers each emits)
- apps/web/middleware.ts (the `sb-access-token` gate)
- apps/web/app/admin/damage/page.tsx (how the damage list renders its
  "no access" branch)
- apps/web/app/change-password/page.tsx (or wherever the change-
  password form lives) — what the client does AFTER a successful
  forced reset (redirect type, fresh page nav vs client nav)
- apps/damage-worker/src/index.ts (the `adminGate` / equivalent on
  damage endpoints — confirm it reads `session.dcRole` /
  `session.dcLocations`, NOT some other field)

## Context

Production / staging beta testers are hitting a reproducible auth
failure during onboarding:

1. User logs in. Dashboard works. Good.
2. The forced-password-reset flag is true on their `auth_unified` row
   (newly-provisioned user). Middleware redirects them to
   `/change-password?required=true`.
3. They submit a new password. The change succeeds — they return to
   the dashboard, which renders correctly.
4. They click into `/admin/damage`. They get:
   > "You don't have access to Damage Claims. Contact your
   > administrator if this is unexpected."
5. `auth_unified` for that user is correct: `dc_role = "gm"`,
   `dc_locations` populated, dc tool granted in `user_tool_access`.
   Nothing missing data-side.

Reproducibility:
- 3/3 testers have hit this on first session post-forced-reset.
- One tester got the rejection on iPhone Safari but accessed
  `/admin/damage` successfully from their desktop browser (same
  account, no other changes). This is the strongest signal —
  identical server-side state, different browser → cookie/session
  bug, not a data bug.

What we know is NOT the cause:
- `dc_role` is correctly stored.
- `dc_locations` is correctly stored.
- The dc tool grant is correctly present.
- Login itself works (dashboard renders).

What's almost certainly the cause:
- After `POST /api/forced-reset`, the dashboard-worker may not be
  rotating the `sb-access-token` cookie cleanly, OR the change-
  password page client is navigating before the new cookie has
  committed. The next request to `/admin/damage` then carries either
  a stale token or no token, and the damage-worker's `authenticate()`
  call against `auth_unified` returns a session whose `dcRole` is
  null — which the admin-gate treats as "no access".
- Safari iOS handles cookie refresh on navigation more strictly than
  desktop Chrome, which explains the device split.

## Scope — investigate, then fix

This is a diagnostic-then-fix brief. Don't guess at the change —
read the code and confirm the failure mode first, THEN apply the
minimal fix.

1. **Reproduce the auth flow on paper.** Trace the exact sequence:
   - `POST /api/login` → what `Set-Cookie` headers does it emit?
     (Path, Domain, SameSite, Secure, HttpOnly, Max-Age, value.)
   - `GET /change-password?required=true` → middleware allows it
     because the cookie is present; the page renders.
   - `POST /api/forced-reset` → what `Set-Cookie` headers does THIS
     emit? Does it refresh the session, or only update the password
     in Supabase? Read the dashboard-worker handler carefully.
   - Client-side after the response: what kind of navigation happens?
     `router.push` (Next.js client nav) vs `window.location.assign`
     (full browser nav) vs form-action redirect (302 from worker)?
   - Subsequent `GET /admin/damage` → middleware sees what cookie?
     server-component `authenticate()` returns what session?

2. **Compare to `/api/login`.** The login handler clearly works (the
   dashboard renders after it). Whatever attributes `/api/login`'s
   `Set-Cookie` carries that `/api/forced-reset` doesn't, equalize.
   Specifically check:
   - Same `Path=/`.
   - Same `SameSite=Lax`.
   - Same `Secure` flag.
   - Same `HttpOnly`.
   - Same cookie NAME (`sb-access-token` AND `sb-refresh-token` — both
     legs).
   - Same Max-Age / Expires.
   - No `Domain=` attribute that pins to a host the browser doesn't
     match on the next request.

3. **Refresh the Supabase session inside `/api/forced-reset`.**
   After the password update succeeds, the dashboard-worker should:
   - Call Supabase's password-update via the admin / user API in a
     way that returns a fresh access_token + refresh_token (or call
     `auth.refreshSession()` explicitly).
   - Emit a new `Set-Cookie` for `sb-access-token` AND
     `sb-refresh-token` with the fresh values + same attributes as
     `/api/login`.
   - If the current code only updates the password (without rotating
     the cookie), the cookie ends up with a stale `access_token` that
     no longer matches what Supabase expects on the next
     `auth.getUser()` call — `authenticate()` then returns
     "unauthenticated" or a session with null `dcRole`.

4. **Fix the client-side navigation after forced reset.** Whatever
   the change-password page currently does after success, switch to
   a HARD navigation (`window.location.assign('/admin/dashboard')`)
   rather than `router.push`. Hard nav forces the browser to commit
   the freshly-`Set-Cookie`'d session before issuing the next request.
   Safari iOS is the strict-cookie-commit case where this matters
   most. Desktop Chrome is forgiving and happens to commit in time
   either way — which is why one tester worked on desktop.

5. **Verify the damage-worker side is reading the right field.**
   While in the code, double-check that the damage admin gate
   (whatever rejects with the "you don't have access" message) is
   reading `session.dcRole` from the live `authenticate()` result and
   not from a cached / pre-reset session. Confirm the message is
   coming from where you think it's coming from. If apps/web is
   rendering the message based on its own client-side state instead
   of a fresh server fetch, that's a separate bug to flag.

6. **Add server-side defense in depth.** If `authenticate()` returns
   a session where `role === "super_admin"` OR
   `dcRole !== null` is the existing pattern: keep it. If it returns
   a session with both `role === null` AND `dcRole === null`, that's
   the "stale cookie" failure case — surface it differently from a
   genuine "no access" rejection. Suggested copy split:
   - Genuinely-no-access (dcRole resolved, but null/wrong): "You
     don't have access to Damage Claims. Contact your administrator
     if this is unexpected."
   - Session-not-fully-resolved (no claims at all on session):
     "Session expired or hasn't fully loaded. Try refreshing the
     page or signing out and back in." Plus a "Sign in again" link
     that hard-navigates to `/logout`.
   This makes the iOS-stale-cookie case self-recoverable for end
   users instead of looking like a permission problem.

7. **Sanity check the apps/web middleware.** It currently only checks
   for the PRESENCE of `sb-access-token` (Brief 1). After a forced
   reset, the cookie is still present (stale or fresh — middleware
   can't tell), so middleware lets the request through. The damage
   page server component then calls `authenticate()` against Supabase
   and either gets a valid session, an expired-token, or null. Make
   sure all three paths surface differently. An expired-token branch
   should probably redirect to `/login?next={current_path}` rather
   than render a forbidden page — that lets the customer reauth and
   come back without manually clicking around.

## Configuration

No new env vars or secrets. Reuses existing Supabase admin keys.

## Out of scope

- Don't change the password-rotation rules themselves (cooldown,
  complexity, etc.).
- Don't touch the dc_role / dc_locations write path in sysadmin.
- Don't change the auth_unified view.
- Don't deploy to Cloudflare; don't bind production routes; don't
  commit to git or push.

## Definition of done

- `POST /api/forced-reset` emits `Set-Cookie` for BOTH
  `sb-access-token` and `sb-refresh-token` with attributes identical
  to `/api/login`'s cookies, populated from a freshly-refreshed
  Supabase session.
- The change-password client navigates to `/admin/dashboard` via a
  hard browser navigation after a successful reset.
- A fresh user on a fresh iPhone Safari can: log in → change password
  → navigate to `/admin/damage` → see the claims list. No "no access"
  message and no manual reload required.
- The "no access" message is split into two: genuine forbidden
  (operational message) vs session-not-loaded (offers Sign in again).
- `pnpm typecheck` passes.
- `pnpm --filter @splash/dashboard-worker build` succeeds.
- `pnpm --filter @splash/web build` succeeds.
- BUILD_STATE.md updated: bump "Last updated", add a Findings entry
  ("Brief 147: forced-reset now refreshes the session cookie; iOS
  Safari damage-portal 403 after onboarding fixed").

## Report

- What the actual root cause turned out to be (cookie not rotated /
  not committed in time / both / something else).
- The exact difference in `Set-Cookie` headers between `/api/login`
  and `/api/forced-reset` before the fix.
- Whether other workers' admin gates (forms, fleet, signups,
  workorders) have the same failure mode (session loads but a role
  field is null after forced reset) — flag any you find but don't
  fix here.
- Anything you discovered about the apps/web middleware presence-
  only gate that might warrant a follow-up brief (e.g., should the
  middleware validate the token via Supabase, not just check
  presence?).

## Outcome

### Root cause

`POST /api/forced-reset` on the dashboard-worker (`apps/dashboard-worker/src/index.ts`)
called `userCompleteForcedReset` to update the Supabase password and clear
`must_change_password`, then returned `Response.redirect(target, 302)`. That
emitted a 302 with ONLY a `Location` header — no `Set-Cookie`. Supabase
invalidates the previously-issued `access_token` when the password changes
(the PUT against `/auth/v1/admin/users/{user_id}` rotates the user's session
material), so the `sb-access-token` cookie attached to the next request was
stale. `authenticate()` in `@splash/auth` calls `getAuthUser` →
`GET /auth/v1/user` with the stale bearer; Supabase returns non-2xx;
`authenticate()` returns `{ status: "unauthenticated" }`; the damage-worker's
two-step gate (`apps/damage-worker/src/index.ts:370-375`) 401s the
`/manage/api/claims` request. apps/web's `damageGetJson` helper collapsed 401
+ 403 into the same `null` branch, and the page rendered "You don't have
access to Damage Claims" — looking like a permissions problem to the user.

The iOS-Safari-fails / desktop-Chrome-works split was strongest evidence the
problem was cookie-not-data: identical server state, different browser →
cookie/session bug. Most likely Chrome desktop happens to accept the stale
token for one or two requests via cached `auth.getUser()` while iOS Safari
revalidates immediately — but the root cause is the same on both: the cookie
is genuinely stale and the worker never refreshed it. With the fix in place,
both browsers see a freshly-`Set-Cookie`'d session on the 302 and route
cleanly to `/admin/dashboard`.

### Set-Cookie diff (before fix)

```
/api/login  →  Set-Cookie: sb-access-token=...; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600
               Set-Cookie: sb-refresh-token=...; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800

/api/forced-reset  →  (no Set-Cookie headers)   ← the entire bug
```

`/api/login` builds both via `@splash/auth/buildAuthCookies(access_token,
refresh_token)`. `/api/forced-reset` never called it because it used
`Response.redirect()` (which can't carry custom headers).

### Files modified

1. **`apps/dashboard-worker/src/index.ts`** — `handleForcedReset` now,
   after `userCompleteForcedReset` succeeds, calls
   `supabasePasswordLogin(env, session.email, newPassword)` to get a fresh
   `{access_token, refresh_token}`, builds `Set-Cookie` headers via
   `buildAuthCookies(...)`, and returns
   `new Response("", { status: 302, headers })` with `Location` + the
   two `Set-Cookie` headers attached. If the re-login throws (defense in
   depth — the password was just accepted by Supabase, so this branch
   should never fire in practice), the catch emits `buildLogoutCookies()`
   and redirects to `/login?return=<safeNext>` so the user manually
   authenticates with the new password rather than landing on a broken
   session.

2. **`apps/web/app/change-password/form.tsx`** — `window.location.href =
   next` flipped to `window.location.assign(next || DEFAULT_AUTHED_LANDING)`
   on the success branch + the 401-fallback branch. Functionally
   equivalent to `.href = ...`, but `assign` is the documented "hard
   navigation" idiom; the surrounding comment now explicitly explains
   that the worker attaches Set-Cookie on the 302 and that the hard nav
   forces Safari iOS to commit the freshly-issued cookies to subsequent
   navigations.

3. **`apps/web/app/admin/damage/page.tsx`** — switched the
   `/manage/api/claims` fetch from `damageGetJson` (which collapses 401
   + 403 into `null`) to `damageGetJsonOrStatus` (which surfaces the HTTP
   status). Page now branches on status:
   - **401 → "Session expired or hasn't fully loaded"** card with a
     "Sign in again" CTA pointing at `/logout?return=<current-path>`.
     `/logout` clears cookies and bounces to `/login`, which then
     authenticates the user back to the original URL via the existing
     dashboard-worker round-trip. This is the user-recoverable path for
     the iOS-Safari-stale-cookie case.
   - **403 → "You don't have access to Damage Claims"** card with the
     existing "Contact your administrator" copy + Sign In CTA. Unchanged
     from pre-Brief-147 except that it no longer fires on stale cookies.
   The roster fetches (`/manage/api/contact-roster`) keep the legacy
   null-on-401/403 shape — they're decorative and don't drive routing.

4. **`apps/web/app/logout/route.ts`** — `logoutResponse` now preserves a
   `?return=<path>` query param through the cookie-clear → `/login`
   redirect so the "Sign in again" CTA on the damage no-access page
   can route the user back to the original URL after re-authenticating.
   Same allowlist defense as `/login`'s `sanitizeReturn` (non-`/`-prefixed
   or `//`-prefixed values fall back to the default).

### Files created

None.

### Decisions made on the operator's behalf

1. **Re-login via `supabasePasswordLogin` rather than
   `auth.refreshSession()`.** Both work; the brief mentions either. The
   password grant flow is already imported into the worker (`/api/login`
   uses it), the same call shape returns `{access_token, refresh_token,
   user}`, and reusing it keeps the cookie-issue path uniform with
   `/api/login` — same `buildAuthCookies` call, same attributes, same
   shape. `refreshSession` would have required an additional import +
   a separate code path.

2. **302 redirect retained instead of switching to 200+JSON.** The brief
   didn't require changing the response shape; the existing client
   already follows redirects transparently and hard-navs after. Switching
   to 200+JSON would have been cleaner (avoids the wasted internal fetch
   of /admin/dashboard during the redirect-follow) but isn't required
   for the bug fix and would be a larger client+server change. Filed
   mentally as a future cleanup if needed.

3. **`/logout` route extended to preserve `?return=<path>`.** The brief
   explicitly suggested the "Sign in again" CTA hard-nav to `/logout`,
   but `/logout` previously dropped the query string and always
   redirected to `/login` (no return). Without this change, the user
   would re-authenticate and land at `/admin/dashboard` instead of back
   at the filter view of `/admin/damage` they started from. Small
   additive change; same allowlist defense as `/login`.

4. **Server-side defense-in-depth on `/admin/damage` is per-status, not
   per-session-field.** The brief suggested checking
   `role === "super_admin" || dcRole !== null` vs both null to detect
   the "stale session" case. Implementation went with the simpler
   `HTTP 401 → session_stale` branch instead, because (a) `damageGetJsonOrStatus`
   already surfaces status, (b) the worker already 401s on
   "unauthenticated", (c) the worker's `damageScopeForSession` already
   403s on `dcRole === null` with a clear "no damage role assigned"
   message, and (d) the 401/403 split is the canonical HTTP contract.
   apps/web doesn't need to peek into session internals to distinguish
   them — the status code already carries the answer.

5. **Did NOT widen the same 401/403 split to other admin gates** (forms,
   fleet, signups, sysadmin, workorders, jotform). Out of scope per the
   brief's report section ("flag any you find but don't fix here"). The
   same failure mode exists on all of them in theory, but in practice
   operators only land on `/admin/damage` immediately after the reset
   (the brief is specifically scoped to "beta testers, damage portal");
   the freshly-Set-Cookie'd session is committed to subsequent navigations
   before any other worker call fires.

### Latent issues / forward flags

1. **Other workers' admin gates have the same 401-vs-403 collapse.**
   Forms (`apps/web/app/admin/forms/_lib/worker-fetch.ts`), fleet
   (`apps/web/app/admin/fleet/_lib/worker-fetch.ts`), signups (via
   `apps/web/app/admin/signups/_lib/worker-fetch.ts`), sysadmin, and
   workorders all use the same null-on-401/403 helper pattern. The
   immediate damage fix doesn't propagate. A future brief could widen
   the split across all admin surfaces — the change is mechanical and
   the new copy is reusable. Not done here because (a) the brief is
   specifically about damage, (b) the failure mode doesn't reach those
   pages in the forced-reset flow today.

2. **apps/web middleware presence-only cookie check.** `apps/web/middleware.ts`
   only checks for the PRESENCE of `sb-access-token`, not its validity.
   The brief flagged this explicitly. Widening middleware to do a
   Supabase JWT validation round-trip would catch stale cookies at the
   middleware layer and could `307` to `/logout?return=...` cleanly,
   but adds a per-request /auth/v1/user fetch (one Supabase RT per
   page load gated by middleware) which is meaningful overhead. Worth
   a future brief if the per-worker `authenticate()` split isn't
   enough on its own.

3. **`Response.redirect()` shape elsewhere.** A quick grep across the
   monorepo would surface any other worker handler that uses
   `Response.redirect(target, 302)` after a state-changing operation
   that needs to update cookies. None are obvious from the brief's
   touched surface, but it's a known footgun — the helper is
   convenient but loses you Set-Cookie. Worth a sweep in a future
   brief.

4. **`/api/forced-reset` no longer 302's via `Response.redirect()`.**
   This means there's no longer a self-call to `Response.redirect`'s
   implicit URL validation. The replacement `new Response("", { status:
   302, headers })` with a `Location: <target>` header where target is
   built from `new URL(safeNext, request.url).toString()` performs the
   same validation upstream via `sanitizeRedirect`. No regression.

5. **The damage-worker's per-handler `damageScopeForSession` reads
   `session.dcRole` from the live `authenticate()` result.** No
   pre-reset caching; no stale-session issue server-side. Brief 147
   scope item 5 confirmed — the bug was the cookie, not the gate.

### Validation results

- **`pnpm typecheck`**: 18/18 packages successful (15 cached, 3 fresh:
  `@splash/web`, `@splash/dashboard-worker`, `@splash/damage-worker`).
  Wall: 6.108s. No errors.
- **`pnpm --filter @splash/dashboard-worker build`**: no `build` script
  exists for workers; `typecheck` is the build validator (the
  dashboard-worker package.json's only validation script is
  `tsc --noEmit`, run as part of the root `typecheck` above).
- **`pnpm --filter @splash/web build`**: Next.js 15.5.15 compiled
  successfully. 14 static pages generated, 34 routes emitted, 104 kB
  shared First-Load JS unchanged. `/admin/damage` route stayed at
  187 B / 107 kB First-Load (the 401/403 split adds no client code —
  both branches render server-side).
- **End-to-end forced-reset test on iPhone Safari**: not run here per
  the brief's "Don't deploy" rule. Operator post-cutover smoke per
  the Definition-of-done line: log in → change password → navigate to
  /admin/damage → see the claims list. The expected fix path is:
  POST /api/forced-reset → worker re-issues fresh cookies on the 302
  → fetch follows the 302 → browser commits the new sb-access-token
  + sb-refresh-token → window.location.assign(next) → middleware
  presence-check passes → /admin/damage server component fetches
  /manage/api/claims with the new cookie → 200 with claims → list
  renders.
