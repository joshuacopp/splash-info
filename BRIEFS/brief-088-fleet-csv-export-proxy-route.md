# Brief 88: Fleet CSV export — apps/web proxy route handler (fix cross-subdomain 404)

**Status:** Completed (2026-05-09)
**Drafted:** 2026-05-09
**Blocks:** Operator clicked "Export CSV" on `/admin/fleet`
2026-05-09 and Chrome's download history showed
`submissions.txt — File wasn't available on site` three times in a
row. Signups CSV export works fine on `/admin/signups/{loc}`.
Diagnosis: fleet's CSV URL falls back to a same-origin relative
path (`/admin/api/submissions.csv?...`), which resolves to
`https://staging.splashcarwashes.info/admin/api/submissions.csv` —
but the fleet worker is bound to a SEPARATE subdomain
(`fleet.staging.splashcarwashes.info`, per Brief 82), so that path
hits apps/web instead of the fleet worker. Apps/web has no route
handler at that path, returns Next's 404 HTML, browser saves the
HTML as `submissions.txt`.

Signups CSV works because signup-worker is path-carved on the
SAME hostname as apps/web (`staging.splashcarwashes.info/admin/api/locations/*`).
Same-origin relative URL routes via CF directly to signup-worker.
Fleet's subdomain choice (Brief 82) breaks that pattern.

This brief adds an apps/web route handler at
`/admin/fleet/export.csv` that proxies the request via the
`FLEET_INQUIRY_WORKER` service binding. Browser hits apps/web
same-origin (cookie + auth all work), apps/web service-binds to
the fleet worker, streams the CSV response back. Zero cross-domain
cookie / CORS / Origin issues.

**Dependencies:**
- Brief 83 (the fleet admin viewer that introduced the broken
  CSV URL pattern).
- Brief 86 (the column fix — must be deployed for any CSV to
  generate; already completed).
- Brief 17 (the service-binding pattern this brief reuses).

## Read first

- BRIEFS/brief-083-fleet-submissions-admin-viewer.md.
- BRIEFS/brief-082-fleet-inquiry-staging-custom-domain.md (the
  brief that chose the subdomain pattern that creates this
  cross-origin gap).
- BRIEFS/brief-017-service-bindings.md (the binding-fetch
  pattern this brief uses).
- apps/web/app/admin/fleet/_lib/worker-fetch.ts L155-160 (the
  `getFleetCsvUrl` helper that returns the broken URL today).
- apps/web/app/admin/fleet/page.tsx (where the CSV button URL
  is consumed via `<CsvExportButton href={...}>`).
- apps/fleet-inquiry-worker/src/admin.js L313-368 (the
  `handleCsvExport` handler that already works correctly when
  reached via the service binding — this brief doesn't touch it).

## Context

### Why signups works without a proxy

signup-worker's `wrangler.toml` carves a path-based route on
apps/web's staging hostname:
```
staging.splashcarwashes.info/admin/api/locations/*  → splash-signup-next
```
So when the browser navigates to
`https://staging.splashcarwashes.info/admin/api/locations/oswego/signups.csv?from=...`,
CF routes it directly to signup-worker, which auth-gates on the
user's cookie (same-origin, propagates) and returns the CSV.

### Why fleet doesn't

Brief 82 deliberately chose a subdomain pattern for fleet's
staging route: `fleet.staging.splashcarwashes.info` (mirrors prod
posture, avoids `/api/*` collisions with apps/web). That choice
was correct for the public form's sake — but it means the fleet
worker isn't reachable from apps/web's hostname via a relative
URL. The CSV button on `/admin/fleet` (served by apps/web)
constructs `/admin/api/submissions.csv?...` relative, which
resolves to apps/web's hostname → 404.

### Why a proxy route handler is the right fix

Three options were considered:
1. **Set `NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL` to an absolute
   fleet URL.** The CSV button would link directly to
   `fleet.staging.splashcarwashes.info/admin/api/submissions.csv`.
   Problems: requires the auth cookie to be set with
   `Domain=.splashcarwashes.info` (or apex) so it propagates to
   subdomains; the fleet worker's `isOriginAllowed()` would have
   to accept apps/web's origin (cross-origin GET); and exposes
   the fleet hostname in the user's URL bar. Operator-coordinated
   cookie domain change is a CLAUDE.md production-state edit
   (constraint #6), out of scope for a quick fix.
2. **Add a path-based route to fleet's `wrangler.toml` for
   staging (e.g., `staging.splashcarwashes.info/fleet-admin/api/*`).**
   Brief 82 explicitly rejected this option to keep the verbatim-
   lifted JS untouched (paths in `src/index.js` are at bare
   `/admin/api/`). Doing this would require refactoring fleet's
   API URLs.
3. **Apps/web proxy route handler** (THIS BRIEF). Add a Next.js
   route handler at `/admin/fleet/export.csv` that uses the
   existing `FLEET_INQUIRY_WORKER` service binding to forward
   the request. Browser hits apps/web same-origin (cookie + auth
   work without changes); apps/web binds to fleet worker; CSV
   response streams back. Zero changes to fleet worker, zero
   cookie-domain coordination, zero env-var hardcoding. Cleanest.

### Will this same fix be needed for the JSON list endpoint?

No. The JSON list (`getFleetSubmissionsList`) is called server-
side from the apps/web Next.js page render — it's the apps/web
WORKER calling the fleet worker via service binding internally,
not the browser. Browser only sees the SSR'd HTML, never makes
a direct cross-domain call to the fleet worker for JSON. The
problem only surfaces on the CSV button because that's the one
case where the BROWSER itself is the requester (it has to be —
the browser has to receive the file to download it).

## Scope

### Phase 1 — Add apps/web proxy route

**File:** `apps/web/app/admin/fleet/export.csv/route.ts` (NEW)

Next.js Route Handler that:
1. Imports `getCloudflareContext`, `cookies`, etc.
2. On GET: reads the auth cookie, looks up the
   `FLEET_INQUIRY_WORKER` binding, builds a Request to
   `/admin/api/submissions.csv?...` with the cookie + Origin
   forwarded.
3. Awaits the binding.fetch response.
4. Streams the body back with `Content-Type: text/csv` and
   the upstream `Content-Disposition` header preserved (so
   the browser still gets the right filename).
5. Falls through to a URL-based fetch when the binding is
   unavailable (next dev), using the same
   `NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL` env-var fallback as
   the existing helpers.

Skeleton:
```ts
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const incoming = new URL(req.url);
  const cookieHeader = (await cookies()).toString();
  const targetSearch = incoming.search; // includes leading "?" or empty
  const targetPath = `/admin/api/submissions.csv${targetSearch}`;

  const tryBinding = async (): Promise<Response | null> => {
    try {
      const ctx = await getCloudflareContext({ async: true });
      const binding = ctx?.env?.FLEET_INQUIRY_WORKER;
      if (!binding) return null;
      const upstreamReq = new Request(`https://internal${targetPath}`, {
        method: "GET",
        headers: {
          Cookie: cookieHeader,
          Origin: "https://internal"
        }
      });
      return await binding.fetch(upstreamReq);
    } catch {
      return null;
    }
  };

  const tryUrlFallback = async (): Promise<Response | null> => {
    const base = process.env.NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL;
    if (!base) return null;
    return await fetch(`${base}${targetPath}`, {
      method: "GET",
      headers: {
        Cookie: cookieHeader,
        Origin: new URL(base).origin
      }
    });
  };

  const upstream = (await tryBinding()) ?? (await tryUrlFallback());
  if (!upstream) {
    return new Response("Fleet worker unavailable", { status: 502 });
  }

  // Pass through status + content headers, but don't blindly forward
  // every header (Set-Cookie, Server, etc. are not appropriate here).
  const headers = new Headers();
  const ct = upstream.headers.get("Content-Type");
  const cd = upstream.headers.get("Content-Disposition");
  if (ct) headers.set("Content-Type", ct);
  if (cd) headers.set("Content-Disposition", cd);
  headers.set("Cache-Control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    headers
  });
}
```

`export const dynamic = "force-dynamic"` ensures Next doesn't
static-generate this route (it depends on cookies + per-user
filter params).

### Phase 2 — Update `getFleetCsvUrl`

**File:** `apps/web/app/admin/fleet/_lib/worker-fetch.ts`

Change L155-160 from:
```ts
export function getFleetCsvUrl(params: FleetSubmissionsListParams = {}): string {
  const path = `/admin/api/submissions.csv${buildQuery(params)}`;
  const base = process.env.NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL;
  if (base) return `${base}${path}`;
  return path;
}
```
to:
```ts
export function getFleetCsvUrl(params: FleetSubmissionsListParams = {}): string {
  // Brief 88 — point at the apps/web proxy route, NOT the fleet
  // worker's URL directly. The fleet worker lives on a separate
  // subdomain (`fleet.staging.splashcarwashes.info`) so a same-
  // origin relative URL doesn't reach it; instead the proxy at
  // /admin/fleet/export.csv uses the service binding internally.
  return `/admin/fleet/export.csv${buildQuery(params)}`;
}
```

Update the docblock above the function to reflect the new posture
(drop the "no service-binding shortcut" note — service binding IS
available, just not when the click goes directly to the worker;
the proxy route uses it).

`NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL` is no longer consumed by
this helper (it's now consumed only by the proxy route's URL
fallback in `next dev`). Leave the env var in `.env.example` /
deploy docs unchanged — it's still useful for local dev.

### Phase 3 — Middleware allow-list (defense-in-depth)

**File:** `apps/web/middleware.ts`

The existing middleware allow-list for `/admin/fleet` paths (added
in Brief 83) already covers `/admin/fleet/*` so the new
`/admin/fleet/export.csv` route is protected by the same auth
gate. Verify by grep — if `/admin/fleet/[any]` is the matcher
shape, this brief needs no middleware change. If the allow-list
is path-specific, extend it to include `export.csv`.

### Phase 4 — Validation

```sh
pnpm --filter @splash/web typecheck
pnpm --filter @splash/web build
pnpm typecheck
```

Smoke test (after operator deploys apps/web — fleet worker
unchanged):
1. Open `/admin/fleet`.
2. Click "Export CSV" button.
3. Browser downloads `fleet-submissions-{from}-to-{to}.csv` with
   correct filename and CSV content.
4. Open the file — should contain header row + one row per
   matching submission, RFC 4180-quoted.
5. Verify Network tab: the CSV download request goes to
   `https://staging.splashcarwashes.info/admin/fleet/export.csv?from=...`
   (apps/web), returns 200 `text/csv`. No 404.

Adjust date range and re-export to confirm filter passes through
unchanged.

### Phase 5 — Documentation

1. **CLAUDE.md** — under the existing fleet section in the
   "Working with workers" or glossary, append a one-liner:
   > Fleet's CSV export is proxied through apps/web's
   > `/admin/fleet/export.csv` route handler (Brief 88), not
   > linked directly to the fleet worker. This is because fleet
   > lives on a different subdomain than apps/web
   > (`fleet.staging.splashcarwashes.info` vs
   > `staging.splashcarwashes.info`), so a same-origin relative
   > URL on the CSV button wouldn't reach the worker. The proxy
   > route uses the `FLEET_INQUIRY_WORKER` service binding
   > internally and streams the CSV body back with the upstream
   > `Content-Disposition` header preserved. Future workers that
   > use a subdomain pattern + need a browser-direct download
   > should follow the same proxy convention.

2. **PRE_DEPLOY_FLEET.md** — note the proxy route in the
   admin-endpoints section.

3. **PRE_DEPLOY_WEB.md** — note the new route handler.

4. **BUILD_STATE.md** — bump "Last updated" + Findings entry.

5. **BRIEFS/INDEX.md** — append Brief 88 row.

6. **BRIEFS/QUEUE.md** — entry already appended.

## Definition of Done

- `apps/web/app/admin/fleet/export.csv/route.ts` exists,
  exports a GET handler that proxies via the
  `FLEET_INQUIRY_WORKER` service binding with URL fallback for
  dev.
- `apps/web/app/admin/fleet/_lib/worker-fetch.ts:getFleetCsvUrl`
  returns `/admin/fleet/export.csv?...` (apps/web proxy path),
  not a direct fleet-worker URL.
- The helper docblock is updated to explain the proxy choice.
- `apps/web/middleware.ts` allow-list still covers
  `/admin/fleet/*` (verify; no change expected).
- `pnpm --filter @splash/web build` succeeds.
- `pnpm typecheck` passes.
- CLAUDE.md gains the proxy-route note.
- PRE_DEPLOY_FLEET.md / PRE_DEPLOY_WEB.md updated.
- BUILD_STATE.md + INDEX.md updated.
- This brief's `Status:` flips to `Completed (YYYY-MM-DD)`.

## Out of scope

- Refactoring fleet's API endpoints to namespace under
  `/fleet/api/*` so they could be path-carved on apps/web's
  hostname. That'd eliminate the subdomain split but requires
  touching the verbatim-lifted JS — deferred to the eventual TS
  conversion brief.
- Changing fleet's staging route from subdomain to path-carve.
  The subdomain choice mirrors production and is the right
  long-term posture.
- Setting up a similar proxy for the fleet detail / list JSON
  endpoints. Those are SSR-fetched (apps/web Worker → fleet
  worker via binding); they don't have this problem.
- Renaming the route segment (could be `/admin/fleet/export.csv`
  vs `/admin/fleet/submissions.csv` vs `/admin/api/fleet/...`).
  Picked `/admin/fleet/export.csv` for symmetry with how the
  page reads ("Fleet → Export CSV").

## Outcome

**Completed 2026-05-09.**

### Files created

- `apps/web/app/admin/fleet/export.csv/route.ts` — Next.js Route
  Handler. Exports a `GET(req)` that reads the auth cookie via
  `cookies()`, tries the `FLEET_INQUIRY_WORKER` service binding
  first (`getCloudflareContext({ async: true })` → build a Request
  to `https://internal/admin/api/submissions.csv${incoming.search}`
  with Cookie + Origin headers), falls back to a URL fetch using
  `NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL` for `next dev`, and returns
  the upstream `Response` body via `new Response(upstream.body, ...)`
  so the body streams through. `Content-Type` + `Content-Disposition`
  forwarded so the browser saves with the right filename; other
  headers (Set-Cookie, Server, etc.) intentionally not forwarded.
  `Cache-Control: no-store` added. `export const dynamic =
  "force-dynamic"` ensures Next doesn't statically generate the
  route. Returns 502 with a plain-text body if neither the binding
  nor the URL fallback yields an upstream response.
  - The route segment uses a literal `.` in the directory name —
    Next.js App Router supports dot-containing directory names
    verbatim. Verified by the build output: `/admin/fleet/export.csv`
    appeared in the route table at 131 B / 102 kB.

### Files modified

- `apps/web/app/admin/fleet/_lib/worker-fetch.ts` — `getFleetCsvUrl`
  collapsed from a 5-line env-var-or-relative branch to a one-liner
  returning `/admin/fleet/export.csv${buildQuery(params)}`. Helper
  docblock rewritten to explain the proxy choice and the role of
  `NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL` post-Brief-88 (no longer
  consumed in this helper; only by the proxy route's URL fallback
  for `next dev`).
- `CLAUDE.md` — Brief 88 note appended to the fleet-admin glossary
  entry, citing the convention for any future worker that uses a
  subdomain pattern + needs a browser-direct download.
- `PRE_DEPLOY_FLEET.md` — "Service binding from apps/web" paragraph
  split: the original cookie-domain-widening guidance (which would
  have been the alternative fix) was replaced with the proxy-route
  pattern. Now reads "Service binding from apps/web" + "CSV proxy
  route (Brief 88)" subheadings.
- `PRE_DEPLOY_WEB.md` — `FLEET_INQUIRY_WORKER` row in the
  service-bindings table now lists the proxy route alongside the
  fetch helper. New paragraph below the table documents the proxy
  route's purpose, mechanism, and the convention for future
  subdomain workers.
- `BUILD_STATE.md` — "Last updated" bumped; Brief 88 Findings entry
  prepended to the running 2026-05-09 entry.
- `BRIEFS/INDEX.md` — Brief 88 row's `Status` flipped from
  "Ready for Claude Code" to "Completed (2026-05-09)".
- This brief — `Status:` flipped; `## Outcome` filled in.

### Middleware

Verified `apps/web/middleware.ts` matcher `/admin/:path*` (L173)
covers `/admin/fleet/export.csv` — no middleware change needed.
`ADMIN_KNOWN_SUBPATHS` (L63) already includes `"fleet"` from
Brief 83, so the dynamic `/admin/{slug}` legacy redirect path
doesn't intercept either. Defense-in-depth: same auth gate as the
rest of `/admin/*`, so unauthenticated proxy requests redirect to
`/login` before the binding is invoked.

### Decisions made on the operator's behalf

- **Route segment naming.** Picked `/admin/fleet/export.csv` per
  the brief's recommendation (symmetry with how the page reads:
  "Fleet → Export CSV"). Next.js handles the dot in the directory
  name without escaping.
- **Header forwarding.** Forwarded only `Content-Type` and
  `Content-Disposition` from upstream. Stripped `Set-Cookie`,
  `Server`, etc. — not appropriate to leak through a proxy. Added
  `Cache-Control: no-store` (cookie + per-user filter params).
- **Fallback when both binding and URL fail.** Returns 502 with
  plain text "Fleet worker unavailable". The proxy route is on
  `/admin/*` so the browser sees an apps/web-origin error response
  rather than a generic Next 404.

### Latent issues found

None during execution. The proxy pattern slots cleanly into the
existing `_lib/worker-fetch.ts` shape (binding-first, URL-fallback)
introduced by Brief 17. No fleet worker code was touched, so the
fleet worker requires no redeploy after this brief — only apps/web
needs to ship.

### Validation results

- `pnpm --filter @splash/web typecheck` — green.
- `pnpm --filter @splash/web build` — green. Next.js 15.5.15 with
  14 routes; new `/admin/fleet/export.csv` shows up at 131 B /
  102 kB First Load JS (route handler — minimal client weight).
- `pnpm typecheck` (root) — 15/15 packages green; 14 cache hits,
  only `@splash/web` cache-missed and re-ran.

### Out-of-scope items deferred (per brief)

- Refactoring fleet's API endpoints to namespace under
  `/fleet/api/*` so they could be path-carved on apps/web's
  hostname. Touches the verbatim-lifted JS in
  `apps/fleet-inquiry-worker/src/index.js`; deferred to the
  eventual TS conversion brief.
- Switching fleet's staging route from subdomain to path-carve.
  The subdomain mirrors production and is the right long-term
  posture.
- Setting up similar proxies for the JSON list / detail / PATCH
  endpoints — those are SSR'd from the apps/web Worker via the
  service binding (apps/web Worker → fleet worker), so the browser
  never makes a direct cross-domain call for them.

### Smoke test (deferred to operator post-deploy)

1. Deploy apps/web. Fleet worker requires no redeploy.
2. Open `/admin/fleet`, click "Export CSV" → browser downloads
   `fleet-submissions-{from}-to-{to}.csv` with correct filename.
3. Open the file → header row + one row per matching submission,
   RFC 4180-quoted, including the `splash_notes` column from
   Brief 87.
4. Network tab: CSV download request goes to
   `https://staging.splashcarwashes.info/admin/fleet/export.csv?from=...`
   (apps/web hostname), returns 200 `text/csv`. No 404. No
   `submissions.txt`.
5. Adjust date range, re-export — filter passes through unchanged.
