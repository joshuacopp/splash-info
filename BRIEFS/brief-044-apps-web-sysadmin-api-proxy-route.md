# Brief 44: apps/web `/sysadmin/api/*` proxy route handler

**Status:** Ready for Claude Code
**Started:**
**Completed:**
**Blocks:** Nothing — but fixes a latent staging bug that the operator
hit on 2026-05-06 with the Brief 39 LocationCodePicker. The same bug
affects every client-side picker that fetches `/sysadmin/api/*`.
**Dependencies:** None. Brief 17 (service bindings) introduced the
`SYSADMIN_WORKER` binding this route handler reuses.

## Read first

- CLAUDE.md (especially constraint #6 — production routes are
  commented; the "Service bindings (Brief 17)" section under
  "Working with apps/web")
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-017-service-bindings.md (the binding-with-URL-fallback
  pattern this brief mirrors)
- apps/web/app/admin/sysadmin/_lib/worker-fetch.ts (the canonical
  server-side helper — this brief's route handler reuses the same
  service-binding-then-URL-fallback shape but for proxying client
  fetches)
- apps/web/next.config.mjs (the dev-only rewrites that mask this
  bug in `next dev` — explains why nobody noticed until staging
  hit production-like config)
- apps/web/wrangler.toml (confirm SYSADMIN_WORKER service binding
  is declared)
- apps/web/app/admin/sysadmin/_components/LocationCodePicker.tsx
  (line 82 — the client fetch that 404s today)
- apps/web/app/admin/sysadmin/_components/LocationsSearchPicker.tsx
  (line ~96 — same pattern, same 404)
- apps/web/app/admin/sysadmin/_components/PackageSearchPicker.tsx
  (line ~118 — same)
- apps/sysadmin-worker/src/index.ts (`isOriginAllowed` CSRF check
  on line ~80; the proxy must forward Origin so mutations from
  any future client-side caller pass)

## Context

Three client-side pickers in `/admin/sysadmin` fetch `/sysadmin/api/*`
using browser-relative URLs. The intended routing was:

  - **Dev (`next dev`):** `next.config.mjs` rewrites proxy
    `/sysadmin/api/:path*` to `${NEXT_PUBLIC_SYSADMIN_WORKER_URL}`
    when that env var is set. Works.
  - **Production (post-cutover):** CF Workers Routes bind
    `splashcarwashes.info/sysadmin/api/*` to splash-sysadmin at the
    edge layer, so the request never reaches splash-web. Apps/web
    is unaware. Works.
  - **Staging (current state):** Env var is unset (production-like)
    AND CF routes are commented (per CLAUDE.md constraint #6 — all
    five workers' routes are commented in wrangler.toml). So:
    - Browser fetches `/sysadmin/api/pricing-simple/locations?q=...`
    - Request hits `staging.splashcarwashes.info` → splash-web
    - splash-web's Next.js router has no route at `/sysadmin/api/*`
    - 404 returned to the browser

Operator hit this 2026-05-06 with Brief 39's Set Role
LocationCodePicker. Identical bug affects Brief 26's
PackageSearchPicker and Brief 27's LocationsSearchPicker.

Server-side calls (the action helpers in `actions.ts` via
`sysadminPostJson`/`sysadminPatchJson`/`sysadminGetJson`, the audit
log fetch in `AuditLogPanel`) all work because they go through the
SYSADMIN_WORKER service binding directly inside apps/web's worker
runtime — they never traverse the public URL space.

The fix is symmetric: add an apps/web route handler that catches
`/sysadmin/api/*` browser requests and forwards them through the
same service binding the server helpers use. Works in staging,
works in dev (URL fallback), and is harmless post-cutover (CF
edge routes win — the apps/web handler never gets hit).

## Scope

### Phase 1 — Catch-all proxy route handler

1.1 Create `apps/web/app/sysadmin/api/[...path]/route.ts`:

```ts
// Catch-all proxy for browser-side /sysadmin/api/* fetches. Forwards
// to splash-sysadmin via the SYSADMIN_WORKER service binding (with a
// URL fallback for `next dev` outside the Workers runtime).
//
// Why this exists (Brief 44): client-side pickers in /admin/sysadmin
// (LocationCodePicker, LocationsSearchPicker, PackageSearchPicker)
// fetch /sysadmin/api/* with browser-relative URLs. The dev rewrite
// in next.config.mjs masks this in `next dev`. CF Workers Routes
// bound at the edge mask this in production post-cutover. In staging
// (env vars unset AND CF routes commented), neither mask is in place
// and the requests 404 against apps/web. This handler is the
// belt-and-suspenders: works in all three environments, no-op when
// CF edge routes win at the edge layer.
//
// Mirrors the dual-mode transport pattern in
// _lib/worker-fetch.ts. Differences:
//   - This is a client-fetch proxy, not a server helper. Streams
//     request and response bodies through verbatim.
//   - Forwards Cookie + Content-Type + Origin (Origin is required
//     for mutation endpoints to pass the worker's isOriginAllowed
//     CSRF check; the worker accepts apps/web's origin since the
//     binding-side `https://internal` placeholder is paired with an
//     explicit Origin header).
//   - Forwards all common methods. The sysadmin-worker exposes GET,
//     POST, and PATCH today; DELETE is included for forward-compat.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";  // never statically cache a proxy
export const runtime = "edge";  // matches the rest of apps/web's CF Workers runtime

async function proxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;       // e.g. /sysadmin/api/pricing-simple/locations
  const search = url.search;       // e.g. ?q=binghamton

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const contentType = req.headers.get("content-type");
  const method = req.method.toUpperCase();
  const hasBody = !["GET", "HEAD"].includes(method);
  // Read the body once so we can pass it through. ArrayBuffer is the
  // safest cross-runtime shape for forwarding (works under both the
  // service-binding fetch and the URL fallback).
  const body = hasBody ? await req.arrayBuffer() : undefined;

  const forwardHeaders: Record<string, string> = {
    Cookie: cookieHeader,
    Origin: url.origin
  };
  if (contentType) forwardHeaders["Content-Type"] = contentType;

  // Service binding path (Cloudflare Workers runtime)
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.SYSADMIN_WORKER) {
      const proxyReq = new Request(`https://internal${path}${search}`, {
        method,
        headers: forwardHeaders,
        body: hasBody ? body : undefined
      });
      return await env.SYSADMIN_WORKER.fetch(proxyReq);
    }
  } catch {
    // getCloudflareContext throws under `next dev` outside the Workers
    // runtime — fall through to the URL fallback below.
  }

  // Dev URL fallback. Production never reaches here because the
  // service binding is always defined in the Workers runtime.
  const base = process.env.NEXT_PUBLIC_SYSADMIN_WORKER_URL;
  if (!base) {
    return new Response(
      JSON.stringify({
        error:
          "Sysadmin worker not reachable: SYSADMIN_WORKER service binding " +
          "unbound and NEXT_PUBLIC_SYSADMIN_WORKER_URL unset. Check " +
          "apps/web/wrangler.toml [[services]] and apps/web/.env.local."
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  const target = `${base}${path}${search}`;
  return await fetch(target, {
    method,
    headers: forwardHeaders,
    body: hasBody ? body : undefined,
    cache: "no-store"
  });
}

export async function GET(req: Request)    { return proxy(req); }
export async function POST(req: Request)   { return proxy(req); }
export async function PATCH(req: Request)  { return proxy(req); }
export async function DELETE(req: Request) { return proxy(req); }
```

Path note: Next.js App Router catch-all is `[...path]`. The handler
file MUST be at `apps/web/app/sysadmin/api/[...path]/route.ts`. The
`path` slug isn't read inside the handler (we forward `url.pathname`
verbatim); the `[...path]` segment exists only so Next routes any
`/sysadmin/api/*` URL to this handler.

1.2 If the existing apps/web route tree already has a route at
`/sysadmin/api/*` for some other purpose, this handler must be
positioned to NOT shadow it. Glob check: the executor must run
`Glob "apps/web/app/sysadmin/**/route.ts"` before creating this
file. If the result is non-empty, halt and report the collision in
the Outcome instead of stomping. (As of 2026-05-06 the result is
empty per Brief 44's investigation.)

### Phase 2 — Smoke test in dev

2.1 Run `pnpm --filter @splash/web dev` (or whatever the package's
dev script is — check package.json). Hit
`/admin/sysadmin?mode=users` and use the Set Role card's
LocationCodePicker.

2.2 Expected: typing in the picker fires GET requests to
`/sysadmin/api/pricing-simple/locations?q=...` from the browser; the
proxy forwards them; the worker returns 200 with rows; the dropdown
populates.

2.3 If running in `next dev` mode without the Cloudflare runtime
emulation, the URL fallback path runs. Confirm
`NEXT_PUBLIC_SYSADMIN_WORKER_URL` is set in `apps/web/.env.local`.

2.4 If running in `wrangler dev` mode (which emulates the Cloudflare
Workers runtime locally), the service-binding path runs. Both must
return 200.

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass for all 13 packages.
3.2 `pnpm --filter @splash/web build` — must succeed.
3.3 No runtime smoke required against staging in headless mode —
the operator will validate by visiting
`https://staging.splashcarwashes.info/admin/sysadmin?mode=users`
after CF Workers Builds redeploys. The Outcome should explicitly
flag this as "operator must verify in staging after deploy."

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 44 row added.

4.2 BUILD_STATE.md: Findings entry noting:
  - The latent staging gap from CLAUDE.md constraint #6 + the
    dev-only rewrites in next.config.mjs
  - The new catch-all route handler closes that gap
  - The handler is harmless post-cutover (CF edge routes win)
  - This pattern should be replicated for any other worker that
    has client-side fetches to its `/<prefix>/api/*` namespace.
    Today the four other prefixes (`/api/login`, `/admin/api/*`,
    `/manage/api/*`, `/claims-api/*`, `/pertrack/*`) are either
    server-side only (no client picker hits them) OR already
    routed via apps/web pages. If a future brief adds a client
    fetch to one of those, it'll need a similar proxy route.

4.3 CLAUDE.md: Add a note under "Working with apps/web" about the
proxy handler — when adding a new client-side fetch to
`/sysadmin/api/*`, no new route handler is needed (the catch-all
covers it). When adding a client-side fetch to a different
worker prefix, add an analogous catch-all route.

## Out of scope

- Binding production routes for splash-sysadmin in CF dashboard.
  Out of scope per CLAUDE.md constraint #6 (production routes are
  intentionally commented during the migration).
- Changing the three client-side pickers' fetch URLs. They stay
  relative; the proxy handler picks them up unchanged.
- Adding analogous catch-all routes for the other workers' API
  namespaces (only do this when an actual client-side fetch
  surfaces).
- Don't deploy from headless. Push triggers CF Workers Builds,
  which redeploys splash-web automatically.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/web/app/sysadmin/api/[...path]/route.ts` exists, exports
  GET / POST / PATCH / DELETE, forwards via SYSADMIN_WORKER service
  binding with URL fallback
- Forwards Cookie + Content-Type + Origin
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)
- Outcome flags "operator must verify Set Role picker in staging
  after splash-web redeploys"

## Report

- Files created (just the one route handler)
- Bundle-size delta on /admin/sysadmin (effectively zero — the
  route handler doesn't ship to the client; it's a server-only
  edge function)
- Validation results
- Confirmation that no existing route was shadowed (Glob check
  from Phase 1.2)
- Any decisions made on the operator's behalf

## Outcome

(Filled in by Claude Code on completion.)
