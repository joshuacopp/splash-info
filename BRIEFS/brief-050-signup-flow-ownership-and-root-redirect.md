# Brief 50: Signup customer flow ownership decision + root `/` redirect

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Nothing.
**Dependencies:** None.

## Read first

- CLAUDE.md (load-bearing customer URLs constraint #1; "Real
  pages" + "Placeholder pages" list under "Working with apps/web")
- BUILD_STATE.md ("Open work" items 8 and 12; deployed-components
  table for `signup-worker` showing `splash-signup-next` owns
  customer signup rendering)
- BRIEFS/INDEX.md
- BRIEFS/brief-023-customer-claim-form-port.md (the precedent
  decision: customer-facing forms live in their owning worker,
  not apps/web)
- apps/web/app/signup/[location]/page.tsx (the placeholder being
  retired)
- apps/web/app/page.tsx (the root page being repointed)
- apps/web/middleware.ts (Brief 1's auth middleware — reference
  for the cookie name and redirect-to-login pattern)
- apps/web/wrangler.toml (verify it does NOT claim `/signup/*`
  routes; routes are commented per CLAUDE.md constraint #6)

## Context

Two open audit items, single small brief:

**Item 8** — Signup customer flow ownership. The original
`apps/web` audit assumed apps/web should own `/signup/[location]`
as a Next.js page; a placeholder file was scaffolded but never
filled in. Brief 23 redrew the line for damage claims (customer
forms live in the owning worker, not apps/web), and the same
logic applies to signup. The legacy `splash-signup` worker (and
its successor `splash-signup-next`) renders the customer signup
form server-side. Operator-confirmed 2026-05-06: keep signup
customer rendering in the worker, retire the apps/web placeholder.

**Item 12** — Root `/` page. Currently a placeholder. Should
redirect unauth users to `/login` and authed users to
`/admin/dashboard`. Standard SaaS landing pattern.

Both touch only `apps/web`. Single deploy.

## Scope

### Phase 1 — Retire signup placeholder

1.1 Delete `apps/web/app/signup/[location]/page.tsx`.

  - Don't replace with a Next.js redirect. The customer URL
    `/signup/{location}` is load-bearing (CLAUDE.md constraint
    #1) — bookmarks must continue to work. In production,
    `splash-signup-next` (renaming to `splash-signup` at
    cutover) owns the route via CF Workers Routes binding. In
    staging, the route already binds to splash-signup-next at
    the edge (operator-confirmed working). apps/web does NOT
    need a fallback page here.

  - If the directory `apps/web/app/signup/[location]/` becomes
    empty after deletion, delete the directory too. Same for
    `apps/web/app/signup/` if no other children remain.

1.2 Verify `apps/web/wrangler.toml` does NOT have a `/signup/*`
route claim. If it does (it shouldn't per CLAUDE.md constraint
#6 — all production routes are commented), leave it commented.
This brief makes no wrangler.toml change.

1.3 Verify `apps/web/next.config.mjs` rewrite map's
`/signup/*` entry is unchanged. The rewrite only fires in dev
when `NEXT_PUBLIC_SIGNUP_WORKER_URL` is set; production
behavior unaffected. No change here.

### Phase 2 — Root `/` redirect

2.1 Replace `apps/web/app/page.tsx` with a server component that
reads the auth cookie and redirects accordingly:

```tsx
// apps/web/app/page.tsx
//
// Brief 50: root path redirects unauthenticated users to /login
// and authenticated users to /admin/dashboard. The middleware on
// /admin/* (Brief 1) is the source of truth for auth correctness;
// this file is only a UX shortcut to skip a placeholder.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RootPage() {
  const cookieStore = await cookies();
  // Cookie name is "sb-access-token" per @splash/auth's
  // ACCESS_TOKEN_COOKIE constant. Don't import from @splash/auth
  // here — that package is server-only Node and breaks Edge
  // runtime; the constant is duplicated as a literal string in
  // apps/web's middleware.ts as well. Same posture here.
  const hasAccessToken = cookieStore.has("sb-access-token");
  redirect(hasAccessToken ? "/admin/dashboard" : "/login");
}
```

2.2 Behavior matrix:

  - Unauth user navigates to `/` → 307 to `/login` (Next.js
    default redirect status). Login flow on success sends them
    to `/admin/dashboard`.
  - Authed user with valid cookie navigates to `/` → 307 to
    `/admin/dashboard`.
  - Authed user with EXPIRED cookie (still in browser, not
    server-validated) navigates to `/` → 307 to
    `/admin/dashboard` → middleware on `/admin/*` re-validates
    and 308s back to `/login?required=true` if expired. The
    user sees one extra hop on stale-cookie cases — acceptable
    UX trade for keeping `/` dumb (cookie-presence-only).

2.3 No middleware changes. Middleware (Brief 1) gates
`/admin/*`, `/sysadmin/*`, `/change-password?required=true` —
none of those overlap with `/`. The root page's redirect runs
BEFORE middleware on `/admin/*`, so there's no loop risk.

### Phase 3 — Documentation updates

3.1 BUILD_STATE.md:

  - "Open work — prioritized" table: mark items 8 and 12 as
    Completed (2026-05-06).
  - Findings & decisions log entry: signup customer flow stays
    in `splash-signup-next`/legacy `splash-signup` worker per
    Brief 50; apps/web placeholder retired. Mirrors Brief 23's
    decision for damage claims. Customer URLs unchanged
    (CLAUDE.md constraint #1 honored).
  - Deployed components table: `apps/web` "pages built" list
    drop the `/signup/[location]` placeholder row, and update
    the `/` row from "placeholder" to "auth-aware redirect".

3.2 CLAUDE.md:

  - Under "Working with apps/web" → "Real pages" / "Placeholder
    pages" list:
    - Move `/` from placeholder to a new third category
      "Redirect-only pages" with note "Brief 50: redirects to
      /login or /admin/dashboard based on cookie presence."
    - Drop `/signup/[location]` from the placeholder list
      entirely (the file no longer exists).
  - Add a one-line decision callout near the load-bearing-URL
    constraint: "Customer-facing routes (`/signup/{location}`,
    `/q/{location}`, `/join/{location}`, `/claims/{site}`) are
    served by their owning workers (signup-worker for
    signup/q/join, damage-worker for claims), NOT by apps/web.
    apps/web is admin-only post-Brief-50."

3.3 BRIEFS/INDEX.md: Brief 50 row added.

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass for all 13 packages.
4.2 `pnpm --filter @splash/web build` — must succeed.
4.3 No worker changes. No CF dashboard changes.

### Phase 5 — Smoke test guidance (operator)

5.1 After apps/web auto-redeploys (CF Workers Builds), open
`https://staging.splashcarwashes.info/` in an incognito window
(unauth) → should land on `/login` instantly.

5.2 Sign in. After redirect to `/admin/dashboard`, manually
navigate back to `/` → should land on `/admin/dashboard`
without a flicker.

5.3 Visit `https://staging.splashcarwashes.info/signup/oswego` —
should render the customer signup form from `splash-signup-next`
(not a 404, not the apps/web placeholder). This proves the
edge route binding for `/signup/*` is live and apps/web is no
longer in the path.

## Out of scope

- Changing the customer signup form itself.
- Renaming `splash-signup-next` to `splash-signup` — that's
  the cutover task (BUILD_STATE item 13).
- Adding any UI to `/` (loader spinner, etc.) — instant
  redirect is the right pattern; no flicker, no shell.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/web/app/signup/[location]/page.tsx` deleted (and parent
  directory removed if empty)
- `apps/web/app/page.tsx` is a server component that redirects
  on cookie presence
- BUILD_STATE.md items 8 and 12 marked Completed
- CLAUDE.md updated per Phase 3.2
- BRIEFS/INDEX.md updated
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Files modified / deleted
- Any decisions made on the operator's behalf
- Validation results
- Confirmation that smoke tests pass on staging post-deploy

## Outcome

**Files modified (2):**

- `apps/web/app/page.tsx` — placeholder `redirect("/admin/dashboard")` replaced with a server-component auth-aware redirect. Awaits `cookies()`, branches on `cookieStore.has("sb-access-token")`, redirects to `/admin/dashboard` (cookie present) or `/login` (absent). `export const dynamic = "force-dynamic"` added so the cookie read isn't statically analyzed at build time. Cookie name inlined as the literal string `"sb-access-token"` per the same Edge-runtime posture as `apps/web/middleware.ts`.
- `CLAUDE.md` — (a) Constraint #1 extended with a one-line ownership callout: "Customer-facing routes (`/signup/{location}`, `/q/{location}`, `/join/{location}`, `/claims/{site}`) are served by their owning workers (signup-worker for signup/q/join, damage-worker for claims), NOT by apps/web. apps/web is admin-only post-Brief-50." (b) "Working with apps/web" page lists reorganized into three categories — Real / Placeholder / Redirect-only. `/signup/[location]` dropped from the placeholder list (file no longer exists); `/` moved from placeholder to a new "Redirect-only pages" category with Brief 50 cross-reference.

**Files deleted (1):**

- `apps/web/app/signup/[location]/page.tsx` — the never-filled-in Step-7 placeholder. The empty parent directories `apps/web/app/signup/[location]/` and `apps/web/app/signup/` were also removed.

**Files verified unchanged (per brief Phase 1.2 + 1.3):**

- `apps/web/wrangler.toml` — no `/signup/*` route claim. Production routes are commented per CLAUDE.md constraint #6; the staging catch-all `staging.splashcarwashes.info/*` outranks-by-most-specific-match against the per-worker `signup/*`/`q/*`/`join/*` patterns and so doesn't need explicit `/signup/*` exclusion.
- `apps/web/next.config.mjs` — the dev rewrite map already explicitly comments that `/signup/*`, `/q/*`, `/join/*` customer routes aren't proxied through apps/web (per decision 8). There's no entry to scrub.
- `apps/web/middleware.ts` — matcher list `/admin/:path*`, `/sysadmin/:path*`, `/change-password`, `/login`, `/logout` excludes `/` already, so the root-page redirect runs in the page component itself before any /admin/* middleware fires. No loop risk.

**Documentation updates:**

- `BUILD_STATE.md` — Last-updated header bumped with a Brief 50 summary; deployed-components apps/web pages-built table updated (`/` row now "real (Brief 50) — server-component auth-aware redirect…", `/signup/[location]` row deleted, tally updated to 9 real / 1 server-route / 2 placeholder); Open work items 8 and 12 marked Completed (2026-05-06 — Brief 50); customer-facing cutover blockers summary line updated; Findings & decisions log entry added.
- `BRIEFS/INDEX.md` — item 12 row updated to point at this brief; Brief 50 row appended; Decisions section item 8 annotated "Executed in Brief 50 (2026-05-06 — placeholder retired)".
- `BRIEFS/QUEUE.md` — `brief-050-signup-flow-ownership-and-root-redirect.md` moved to the completed-tombstone block.

**Decisions made on operator's behalf:**

1. **Cookie name inlined as the literal string `"sb-access-token"`** rather than imported from `@splash/auth`'s `ACCESS_TOKEN_COOKIE` — `@splash/auth` is server-only Node and breaks Edge runtime; `apps/web/middleware.ts` already takes the same posture (inline `const ACCESS_TOKEN_COOKIE = "sb-access-token"`). The root page's runtime is also Edge-bounded post-OpenNext build, so the same trade-off applies. A comment in the page body explains the duplication.
2. **`export const dynamic = "force-dynamic"`** added — Next.js 15 will attempt to statically analyze server components by default; reading `cookies()` at request time requires the dynamic opt-out so the redirect runs per-request rather than getting a stale build-time bake.
3. **No loader UI / spinner / shell** rendered before the redirect — the brief explicitly out-of-scoped a UX shell, and the SSR redirect lands as a 307 before any HTML ships, so there's no flicker to mask.
4. **Empty parent directories deleted** — both `apps/web/app/signup/[location]/` and `apps/web/app/signup/` had no other children once the placeholder was deleted; leaving them as empty dirs would have shown up in future grepping for signup-related code in apps/web.
5. **No `next.config.mjs` rewrite scrubbing** — the existing rewrite map already explicitly comments that customer-facing signup URLs are NOT proxied through apps/web. The dev rewrites that DO proxy through signup-worker (`/api/submit-signup`, `/admin/api/:path*`) stay; those are admin/API surfaces, not the customer signup form itself.
6. **CLAUDE.md callout placed inside Constraint #1's body** rather than as a new constraint — keeps the customer-URL-immutability rule and the worker-ownership rule colocated.

**Latent issues / forward flags:**

- **No headless smoke test possible** — Phase 5's three smoke tests (incognito visit to staging `/` lands on `/login`; sign-in then `/` lands on `/admin/dashboard`; `/signup/oswego` renders the customer signup form from `splash-signup-next`) require operator-side staging redeploy and live browser verification. CLAUDE.md headless rule prohibits this session from deploying.
- The `apps/web/wrangler.toml` staging catch-all relies on per-worker route patterns being more specific (confirmed working in Brief 16's outcome notes). Cutover (Brief 13) will replace the staging catch-all with explicit production routes.
- `apps/web/app/admin/error.tsx`'s `UnrecognizedActionError` boundary (Brief 31) does NOT cover `/`. The boundary is scoped to the `/admin/*` segment; the root `/` page is a pure redirect with no server actions, so it has no failure mode that requires a boundary.

**Validation results:**

- `pnpm typecheck` — 13/13 successful (6.561s, 12 cached, 1 cache miss on `@splash/web` as expected since `apps/web/app/page.tsx` changed).
- `pnpm --filter @splash/web build` — succeeded. `next build` compiled in 4.2s, all 11 routes generated (down from 12 because `/signup/[location]` is gone). Route bundle sizes: `/` 127 B / 102 kB First Load JS, `/_not-found` 994 B, `/admin/damage` 167 B, `/admin/damage/[id]` 4.15 kB / 109 kB, `/admin/dashboard` 167 B, `/admin/performance` 1.85 kB, `/admin/pricing` 167 B, `/admin/pricing/[location]` 3.65 kB, `/admin/sysadmin` 8.14 kB / 113 kB, `/change-password` 1.32 kB, `/login` 1.32 kB, `/logout` 127 B. Middleware 34.1 kB. All other route bundles unchanged from pre-Brief-50.
- No worker changes; no CF dashboard changes; no deploy.

**Operator follow-up (smoke tests on next staging redeploy):**

1. `https://staging.splashcarwashes.info/` in incognito → instant land on `/login` (no flicker, no shell).
2. Sign in → land on `/admin/dashboard`; manually navigate back to `/` → instant land on `/admin/dashboard`.
3. `https://staging.splashcarwashes.info/signup/oswego` → renders the customer signup form from `splash-signup-next` (proves the edge route binding for `/signup/*` is live and apps/web is no longer in the path).
