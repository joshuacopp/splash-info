# Brief 175 — Cold-load session resume (stop re-prompting MFA every morning)

Status: Completed (2026-09-21)

## Problem

Operators were being asked for password **and** an authenticator code roughly
every morning, despite the session design intending a 7-day sliding window.

The cause is an interaction between three pieces that are individually correct:

| piece | value |
|---|---|
| `sb-access-token` cookie `Max-Age` ([cookies.ts:11](../packages/auth/src/cookies.ts)) | 1 hour |
| `sb-refresh-token` cookie `Max-Age` ([cookies.ts:12](../packages/auth/src/cookies.ts)) | 7 days |
| `apps/web/middleware.ts` auth gate | presence of **`sb-access-token`** |

`SessionKeepalive` pings `POST /api/refresh` every 45 minutes, but it only runs
while a page is mounted ([layout.tsx:49](../apps/web/app/layout.tsx) renders it
inside the authed branch). With every tab closed, nothing refreshes. One hour
later the browser drops the access cookie, the gate sees nothing, and the next
navigation redirects to `/login` — **while a valid 7-day refresh token is still
sitting in the cookie jar**, and `POST /api/refresh` would have traded it for a
fresh session without any prompt.

Net effect: the 7-day sliding session only ever accrued for users who left a tab
open. Everyone else had a 1-hour session with a full password + MFA re-auth on
expiry.

Both cookies are persistent on-disk cookies shared across tabs and windows — the
session was never tab-scoped. Only the *refresh trigger* was.

## Non-goals

This does **not** weaken MFA, and deliberately does not:

- lengthen any token or cookie lifetime;
- add a "remember this device" opt-out of MFA;
- change what `authenticate()` asserts.

GoTrue preserves AAL across a refresh (already relied on by `SessionKeepalive`
— see its header comment). This resumes a session that **already completed MFA
on this device**, at its existing assurance level. It cannot elevate an aal1
session, and it cannot create a session for someone who never logged in: the
refresh token is the credential, and middleware only routes to the new endpoint
when that cookie is present.

## Scope

1. **`apps/dashboard-worker/src/index.ts`** — new `GET /api/session-resume?next=<path>`.
   Trades `sb-refresh-token` for a fresh pair via the existing `refreshSession`,
   re-sets both cookies, 302s to `next`. `next` is validated through the existing
   `sanitizeRedirect` allow-list, so it cannot become an open redirect.
2. **`apps/web/middleware.ts`** — new `resumeOrLogin()` replaces the direct
   `redirectToLogin()` call at both gate sites (`/change-password?required=true`
   and the main `/admin|/sysadmin|/workorders|/schedule|/forms` gate). Redirects
   to the resume endpoint when the access cookie is absent but the refresh cookie
   is present; otherwise falls through to `/login` exactly as before.
3. **`apps/dashboard-worker/wrangler.toml`** — route patterns for the new path on
   staging + apex, alongside the `/api/refresh` twins.
4. **`apps/web/next.config.mjs`** — dev rewrite entry so cross-origin `next dev`
   reaches the worker.

## Decisions made

- **Browser redirect, not a middleware-side fetch.** apps/web and
  dashboard-worker share a zone, and same-zone Worker→Worker URL fetches loop
  through the edge and 522 after ~19s (Brief 17). Service bindings aren't
  reachable from Edge middleware either. Bouncing the browser costs one extra
  round-trip on a cold load and sidesteps both constraints.
- **GET, and no `isOriginAllowed` gate.** Middleware redirects the browser, and a
  redirect is a GET; browsers omit `Origin` on same-origin GET navigations, so the
  CSRF check would reject the only case that matters. Same reasoning already
  documented on `/api/me`. Exposure is bounded to rotating the caller's own
  refresh token, which leaves them logged in either way.
- **`/login` deliberately excluded.** Someone navigating there explicitly may be
  switching accounts; silently resuming the previous session would take that away.
- **Two independent redirect-loop guards**, because a loop here would hit every
  operator simultaneously and take out every gated page:
  1. every failure path clears **both** auth cookies before bouncing to `/login`,
     so the next pass cannot route back to the resume endpoint;
  2. a 10-second `sb-resume-tried` breadcrumb that middleware honours as "already
     tried". This is the belt to guard 1's braces — if the browser rejects our
     `Set-Cookie` headers outright, guard 1 never lands. It is set **without**
     `Secure` on purpose: the scenario it exists for is precisely one where Secure
     cookies are being dropped (plain-http origin). It carries no secret.
- **`/sysadmin` resumes to `/`**, because it is absent from
  `REDIRECT_ALLOWED_PREFIXES` by existing design (the sysadmin UI lives at
  `/admin/sysadmin`, which is covered). Left as-is rather than widening the
  allow-list.

## Latent issue found (NOT fixed — operator decision required)

**`apps/dashboard-worker/wrangler.toml` declares `routes` *inside* the `[vars]`
table, so none of its route patterns are bound by config.**

`[vars]` opens at line 27; `routes = [...]` begins at line 50. In TOML every key
after a table header belongs to that table, so this parses as `vars.routes` — a
14-element environment variable. `wrangler deploy --dry-run` confirms it:

```
env.routes ([{"pattern":"staging.splashcarwashes....)   Environment Variable
```

and no Routes section appears in the binding list.

Consequences:

- The staging and apex routes in this file have never been applied by a deploy.
  Whatever is live is bound in the Cloudflare dashboard. This is adjacent to
  CLAUDE.md constraint #6, but the stated reason there ("routes commented") is no
  longer the actual one — they are uncommented and mis-nested.
- **The `/api/session-resume` route added by this brief will not bind on deploy
  either.** Until the nesting is corrected or the route is added in the CF UI,
  the path falls through to apps/web's `/*` and returns a Next 404 — and
  middleware's resume redirect lands on a 404 page instead of resuming.

Not fixed here: moving the array above `[vars]` would suddenly bind ~14 routes
on the next deploy, including apex production patterns staged as inert by
Brief 168. That is a production-state change and an operator call (CLAUDE.md:
"Don't modify production state"). See Deploy notes.

## Routing gotcha found during deploy (applies to every future endpoint)

**A Cloudflare route pattern with no trailing wildcard does not match a URL that
carries a query string.** Route patterns are matched against the whole URL,
query string included, so `splashcarwashes.info/api/session-resume` matches
`/api/session-resume` and *only* that — append `?next=...` and the route stops
matching entirely.

This cost roughly an hour of debugging and presented as an intermittent failure,
because the one probe that happened to omit the query string succeeded while 18
that included it failed. What made it hard to see:

- the request never reached the worker, so nothing appeared in Workers Logs for
  the failing calls — the successful bare-path call *did* appear, which is what
  finally isolated it;
- the legacy `info-signup-worker` holds `splashcarwashes.info/api/*`, whose
  wildcard happily swallows the query string, so the fallthrough returned
  signup-worker's `Package not found` rather than an obvious 404 page.

Every other dashboard-worker route works because nothing calls them with a query
string (`/api/login`, `/api/refresh`, `/api/me`, `/api/logout`,
`/api/forced-reset` are all bare). The pre-existing `/api/mfa/*` is the only one
that already carried a wildcard.

Live routes are therefore:

```
splashcarwashes.info/api/session-resume*
staging.splashcarwashes.info/api/session-resume*
```

Still more specific than signup's `/api/*`, so precedence is unchanged.

**Rule for future briefs: any new worker endpoint that is reached with a query
string needs a trailing `*` on its CF route.** Note this is the opposite of the
hostname rule — a wildcard in the *host* (`*.splashcarwashes.info`) is wrong
because it skips the apex.

Related: the legacy `info-signup-worker` also holds `*splashcarwashes.info/admin*`,
a leading-wildcard pattern matching `/admin*` on the apex *and* every subdomain
including staging. apps/web owns `/admin/*` now. Not touched here; worth
understanding before cutover.

## Deploy notes

**This change is inert until the route exists.** Before it does anything:

1. Decide the routing fix — either correct the `[vars]`/`routes` nesting (and
   accept that a deploy then binds every pattern in the array), or add
   `splashcarwashes.info/api/session-resume` + the staging twin in the
   Cloudflare dashboard next to the existing `/api/refresh` route.
2. Deploy dashboard-worker and apps/web together. Middleware redirecting to a
   route that does not exist yet is strictly worse than today's behaviour, so
   do not ship apps/web ahead of the route.

Smoke test (after both are live):

1. Log in, complete MFA, close **every** tab.
2. Wait > 1 hour (or delete only `sb-access-token` in devtools, keeping
   `sb-refresh-token`).
3. Navigate straight to `/admin/dashboard`.
4. Expect: a brief redirect through `/api/session-resume`, landing on the
   dashboard, **no password and no code**.
5. Expect in devtools: fresh `sb-access-token` + `sb-refresh-token`.
6. Negative: delete **both** cookies, navigate to `/admin/dashboard`, expect the
   normal `/login?return=...` bounce with no redirect loop.
7. Negative: `/login` with a valid refresh cookie and no access cookie should
   still render the login form, not auto-resume.

## Validation

- `pnpm typecheck` — 27/27 passed.
- `pnpm --filter @splash/web build` — succeeded; Middleware 34.3 kB.
- `wrangler deploy --dry-run` on dashboard-worker — bundles clean, 732.39 KiB /
  139.13 KiB gzip. (This is also what surfaced the `env.routes` finding.)
- No runtime smoke test — requires the route to be bound first (see Deploy notes).

## Files

Modified:
- `apps/dashboard-worker/src/index.ts` — dispatch entry, `handleSessionResume`,
  `RESUME_TRIED_COOKIE` / `RESUME_TRIED_MAX_AGE` constants.
- `apps/web/middleware.ts` — `resumeOrLogin()`, `originalPath()`, three cookie
  constants; both gate sites retargeted.
- `apps/dashboard-worker/wrangler.toml` — two route patterns (currently inert;
  see Latent issue).
- `apps/web/next.config.mjs` — dev rewrite entry.

Created:
- `BRIEFS/brief-175-cold-load-session-resume.md` (this file).
