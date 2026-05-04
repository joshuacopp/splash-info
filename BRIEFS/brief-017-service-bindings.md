# Brief 17: Service bindings for apps/web -> worker subrequests

**Status:** Completed (2026-05-04)
**Started:** 2026-05-04
**Completed:** 2026-05-04
**Blocks:** End-to-end UI testing on staging (and eventual production
cutover). Without 17, every SSR fetch from apps/web to a sibling
worker on the same zone hangs/522s on Cloudflare's same-zone
subrequest gotcha.
**Dependencies:** Brief 16 (staging routes) — surfaces the issue;
Brief 11a (getMe) — primary consumer of the new pattern.

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-016-staging-subdomain.md (Outcome — surface that this
  brief patches over)
- apps/web/wrangler.toml
- apps/web/app/_lib/me.ts
- apps/web/app/admin/damage/_lib/worker-fetch.ts
- apps/web/app/admin/pricing/_lib/worker-fetch.ts (calls signup-worker)
- apps/web/app/admin/performance/_lib/worker-fetch.ts
- apps/web/app/admin/sysadmin/_lib/worker-fetch.ts
- Cloudflare docs on service bindings:
  https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
- @opennextjs/cloudflare context access:
  https://opennext.js.org/cloudflare/howtos/get-cloudflare-context

## Context

When Brief 16 went live on staging.splashcarwashes.info, end-to-end
testing immediately surfaced this:

  - Direct browser GET to /manage/api/claims -> damage-worker -> 200 +
    JSON (works fine).
  - apps/web SSR rendering /admin/damage -> server-side fetch to
    /manage/api/claims -> 19-second hang -> 522 "origin took too long"
    (broken).

Root cause is Cloudflare's same-zone Worker-to-Worker subrequest
behavior. When apps/web (running on splash-web at
staging.splashcarwashes.info) does a `fetch()` whose URL resolves back
to the same zone, CF either loops through the edge inefficiently or
fails outright with 522. This is a documented limitation; the
recommended pattern is **service bindings**.

Service bindings let one Worker call another via a direct in-runtime
binding (`env.DAMAGE_WORKER.fetch(request)`), which Cloudflare routes
internally without going back through the edge. No same-zone gotcha,
no extra latency, and the Cookie/headers pass through cleanly.

This brief migrates apps/web's SSR helpers from URL-based fetches to
service bindings for all 5 backend workers.

## Scope

1. **apps/web/wrangler.toml.** Add 5 `[[services]]` entries:
   ```toml
   [[services]]
   binding = "DASHBOARD_WORKER"
   service = "splash-dashboard"

   [[services]]
   binding = "SIGNUP_WORKER"
   service = "splash-signup-next"

   [[services]]
   binding = "PERFORMANCE_WORKER"
   service = "splash-performance"

   [[services]]
   binding = "SYSADMIN_WORKER"
   service = "splash-sysadmin"

   [[services]]
   binding = "DAMAGE_WORKER"
   service = "splash-damage"
   ```
   Place above the `[assets]` block (top-level keys must precede table
   headers — same TOML ordering rule documented in apps/web/wrangler.toml
   from Brief 16).

2. **Type declarations.** Add or update `apps/web/cloudflare-env.d.ts`
   (create if absent) with the env shape:
   ```ts
   /// <reference types="@cloudflare/workers-types" />
   interface CloudflareEnv {
     DASHBOARD_WORKER: Fetcher;
     SIGNUP_WORKER: Fetcher;
     PERFORMANCE_WORKER: Fetcher;
     SYSADMIN_WORKER: Fetcher;
     DAMAGE_WORKER: Fetcher;
     ASSETS: Fetcher;
   }
   ```
   Verify wrangler.toml's existing assets binding type still resolves;
   adjust if the existing typegen file at apps/web/.open-next/ or
   similar already declares this — don't duplicate.

3. **Helper refactor pattern.** All 5 helpers (`_lib/me.ts` for
   dashboard, plus the 4 admin/*/.../_lib/worker-fetch.ts files) follow
   the same shape change:

   Before:
   ```ts
   const url = await workerUrl(path);
   const resp = await fetch(url, { method: "GET", headers: {...} });
   ```

   After:
   ```ts
   import { getCloudflareContext } from "@opennextjs/cloudflare";
   ...
   const { env } = await getCloudflareContext({ async: true });
   const req = new Request("https://internal" + path, {
     method: "GET",
     headers: { Cookie: cookieStore.toString() }
   });
   const resp = await env.DAMAGE_WORKER.fetch(req);
   ```
   The `https://internal` host is a placeholder — service bindings
   ignore the URL host, only the path matters. Use `https://internal`
   consistently across helpers so logs/debugging are predictable.

   Each helper still:
     - Forwards the user's cookie via `cookies()` from `next/headers`
     - Returns the parsed body on 2xx, null on 401/403, throws on other
       non-2xx (per existing contract)
     - Sets Origin header for POST helpers (mirror existing pattern)

   The `workerUrl(path)` function and `process.env.NEXT_PUBLIC_*_WORKER_URL`
   handling stay in each helper as a fallback for **dev mode** (where
   service bindings aren't available because Next.js dev server runs
   outside the CF Workers runtime). When `getCloudflareContext()`
   throws or `env.<BINDING>` is undefined, fall through to the existing
   URL-based fetch. This preserves localhost dev behavior.

   Concrete files to update with this pattern:
   - `apps/web/app/_lib/me.ts` -> uses `env.DASHBOARD_WORKER`
   - `apps/web/app/admin/damage/_lib/worker-fetch.ts` -> uses
     `env.DAMAGE_WORKER` for both `damageGetJson` and `damagePostForm`
     (and `damagePostMultipart` from 5d if present)
   - `apps/web/app/admin/pricing/_lib/worker-fetch.ts` -> uses
     `env.SIGNUP_WORKER` (signup-worker owns /admin/api/* per the audit)
   - `apps/web/app/admin/performance/_lib/worker-fetch.ts` -> uses
     `env.PERFORMANCE_WORKER`
   - `apps/web/app/admin/sysadmin/_lib/worker-fetch.ts` -> uses
     `env.SYSADMIN_WORKER`

4. **Photo URL helper.** `damagePhotoUrl()` in
   `apps/web/app/admin/damage/_lib/worker-fetch.ts` returns an absolute
   URL used directly as `<img src>`. Service bindings don't apply here
   because the browser fetches the URL, not the apps/web Worker. Keep
   this function URL-based (host-relative when env var is unset, else
   absolute via env var). Same for `damageCheckRequestUrl()` if
   present from Brief 5c.

5. **Dev-mode fallback verification.** After the refactor, the
   localhost dev path (Next.js `pnpm dev` with the rewrites in
   `next.config.mjs`) must still work. The fallback in each helper
   triggers when `getCloudflareContext()` is unavailable, which is the
   case in `next dev`. Document this with a comment block at the top
   of each helper.

6. **Update CLAUDE.md** with a "Service bindings" section under
   "Working with apps/web". Pattern: when SSR-fetching another worker,
   use the binding via `getCloudflareContext()`. Include a one-line
   reminder that this is a CF same-zone limitation, not an apps/web
   choice.

7. **Update BUILD_STATE.md** per Conventions — bump Last updated, add
   Findings entry summarizing 17, mark Brief 17 in the prioritized
   list (add the row), and document the same-zone gotcha as a known
   constraint going forward.

8. **Update BRIEFS/INDEX.md** — add Brief 17 row, marked Completed
   today.

## Out of scope

- Rewriting the dev rewrites in `next.config.mjs` — they stay as the
  dev-mode fallback when service bindings aren't available.
- Migrating client-side fetches (login form, sign out button) to
  bindings — they're browser-originated, not relevant.
- Production cutover route binding (separate brief).
- Splitting `cloudflare-env.d.ts` into per-package typegen — keep one
  file at `apps/web/cloudflare-env.d.ts` for now.
- Don't deploy from headless mode. The brief produces config + code;
  CF Workers Builds picks up the next push automatically.
- Don't bind production routes.
- Don't commit to git (operator handles git push to trigger CF
  Workers Builds).

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- apps/web/wrangler.toml has all 5 `[[services]]` entries
- Type declarations file (cloudflare-env.d.ts or equivalent) declares
  the 5 bindings
- All 5 worker-fetch helpers use the service-binding-with-URL-fallback
  pattern
- Each helper's leading comment block documents the dual-mode behavior
  (production: bindings; dev: URL via rewrites)
- CLAUDE.md has a Service bindings subsection
- BUILD_STATE.md and BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Whether `getCloudflareContext({ async: true })` is the right import
  path for the OpenNext version in use, or if a different shape was
  needed
- Any TypeScript inference issues with the Fetcher type
- Whether the dev-mode fallback worked cleanly or required a
  feature-detect that wasn't obvious
- Latent issues spotted in the existing helpers
- Validation results

## Outcome

### Files modified

- `apps/web/wrangler.toml` — added 5 `[[services]]` blocks above `[assets]`,
  with a comment block explaining *why* (CF same-zone Worker-to-Worker
  subrequest gotcha) and the TOML ordering rule. Service names match
  the `name = "..."` fields in each sibling worker's wrangler.toml:
  `DASHBOARD_WORKER → splash-dashboard`, `SIGNUP_WORKER →
  splash-signup-next`, `PERFORMANCE_WORKER → splash-performance`,
  `SYSADMIN_WORKER → splash-sysadmin`, `DAMAGE_WORKER → splash-damage`.
- `apps/web/app/_lib/me.ts` — `getMe()` now tries
  `env.DASHBOARD_WORKER.fetch(req)` first, falls back to URL-based
  fetch on `getCloudflareContext()` throw or undefined binding.
  Leading comment block updated to document the dual-mode behavior +
  `https://internal` placeholder host convention.
- `apps/web/app/admin/damage/_lib/worker-fetch.ts` — extracted internal
  `damageGetResponse` and `damagePost` dispatchers; the 4 public
  helpers (`damageGetJson`, `damageGetJsonOrStatus`, `damagePostForm`,
  `damagePostMultipart`) reshape onto these. `damagePhotoUrl` and
  `damageCheckRequestUrl` stay URL-based per brief §scope.4 (browser
  is the consumer, not the apps/web Worker).
- `apps/web/app/admin/pricing/_lib/worker-fetch.ts` — `workerGetJson`
  inline-pattern: tries `env.SIGNUP_WORKER.fetch`, falls back to URL
  fetch in catch and undefined-binding branches.
- `apps/web/app/admin/performance/_lib/worker-fetch.ts` — same pattern
  applied to `performanceGetJson` and `performancePostJson` for
  `env.PERFORMANCE_WORKER`.
- `apps/web/app/admin/sysadmin/_lib/worker-fetch.ts` — same pattern
  applied to `sysadminGetJson` and `sysadminPostJson` for
  `env.SYSADMIN_WORKER`.
- `CLAUDE.md` — added a "Service bindings (Brief 17)" subsection under
  "Working with apps/web" — documents the binding-with-URL-fallback
  pattern, lists the 5 bindings, explains *why* (CF same-zone
  limitation), and describes how to add new SSR worker calls.
- `BUILD_STATE.md` — bumped Last updated; added Brief 17 row to the
  prioritized work list; added Findings & decisions entry; added the
  same-zone gotcha as a load-bearing constraint.
- `BRIEFS/INDEX.md` — added Brief 17 row marked Completed today.

### Files created

- `apps/web/cloudflare-env.d.ts` — declaration-merges the 5 worker
  bindings into the global `CloudflareEnv` interface declared by
  @opennextjs/cloudflare (which already declares ASSETS / IMAGES /
  cache bindings, so we extend rather than redeclare). Uses
  `/// <reference types="@cloudflare/workers-types" />` to make
  `Fetcher` resolvable. Picked up automatically by apps/web's tsconfig
  via `**/*.ts` in include.

### Decisions made on operator's behalf

1. **`https://internal` placeholder host** consistent across all 5
   helpers — service bindings ignore the URL host so the literal value
   doesn't matter, but pinning a single value prevents debug
   confusion if a request leaks.

2. **`damagePhotoUrl` and `damageCheckRequestUrl` stay URL-based** —
   both return absolute URLs the *browser* fetches (via `<img src>`
   and `<a href>`), not the apps/web Worker, so the same-zone
   subrequest concern doesn't apply. Comment block in
   `damage/_lib/worker-fetch.ts` calls this out so future maintainers
   don't migrate them by reflex.

3. **`try/catch` around `getCloudflareContext({ async: true })` AND
   `if (env.<BINDING>)` undefined-check** — covers both `next dev`
   (where `getCloudflareContext` throws because the Workers runtime
   isn't running) and any future runtime where the binding might be
   unbound. Both branches fall through to the same URL-based fetch
   path so behavior is uniform.

4. **`Origin` header set to `new URL(url).origin`** in POST helpers
   across both binding and URL paths. Under the binding,
   `url = "https://internal" + path`, so Origin becomes
   `https://internal`. **Forward flag:** the worker `isOriginAllowed`
   gates currently allowlist origins like `https://splashcarwashes.info`
   and the workers.dev URLs; `https://internal` is NOT in any worker's
   allowlist today. The operator should either (a) add
   `https://internal` to each worker's `ALLOWED_ORIGINS` env var at
   next deploy (small surface, keeps the check on), or (b) drop the
   Origin header under the binding path and have the worker skip
   `isOriginAllowed` for service-binding requests (e.g., via a
   custom `X-Service-Binding: 1` header). Recommended: (a). Flagged in
   Findings & decisions log. Not blocking this brief because per
   brief §Out of scope, this brief produces config + code only — the
   operator triggers deploys.

5. **Type declaration approach = single `cloudflare-env.d.ts` at
   apps/web root**, declaration-merging `CloudflareEnv` rather than
   redeclaring it. opennext's own `cloudflare-context.d.ts` already
   declares `ASSETS?: Fetcher; IMAGES?: ImagesBinding; ...` — extending
   keeps those typed correctly without duplicating.

6. **Service name `splash-signup-next` (not `splash-signup`)** matches
   `apps/signup-worker/wrangler.toml`'s current `name` field. **Forward
   flag for cutover (item 13):** when signup-worker renames to
   `splash-signup` at full production cutover, the SIGNUP_WORKER
   binding's `service = "splash-signup-next"` line in
   `apps/web/wrangler.toml` must update too. Inline-mentioned in the
   wrangler comment block.

7. **No changes to `next.config.mjs` rewrites** — they stay as the
   dev-mode fallback when service bindings aren't available (per brief
   §Out of scope).

### Latent issues / observations

- `getCloudflareContext({ async: true })` is the right shape for
  OpenNext 1.19.5 (verified via
  `apps/web/node_modules/@opennextjs/cloudflare/dist/api/cloudflare-context.d.ts:56-58`):
  the async overload returns `Promise<CloudflareContext>`. We use
  async and rely on the throw → URL-fallback path for dev.

- **`Fetcher` type resolution.** apps/web's tsconfig (via
  `@splash/config/tsconfig.next.json`) does NOT include
  `@cloudflare/workers-types` in `types`, but the helpers don't
  reference `Fetcher` directly — they call `.fetch(req)` on
  `env.DASHBOARD_WORKER` (etc.) which is typed via the merged
  interface. The merged interface declaration in `cloudflare-env.d.ts`
  does name `Fetcher`; the
  `/// <reference types="@cloudflare/workers-types" />` directive at
  the top pulls workers-types globally for that file (and consequently
  the project, since it's in the include set). With
  `skipLibCheck: true`, the heavy workers-types globals don't conflict
  with DOM lib at lib-check time. Verified clean: `pnpm typecheck`
  13/13 green.

- **POST helpers' Origin under service binding.** See Decision 4 above.
  Operator action item.

- **Five copies of the binding-vs-URL fork** is duplication-by-design
  for now (each helper has its own URL env-var name + Cookie/Origin
  posture). Future cleanup could hoist a generic `workerSubrequest`
  into `apps/web/app/_lib/worker-subrequest.ts` parameterized on
  binding name + helper. Collapse if the pattern grows further.

- **When the binding is bound but throws at the worker layer** (e.g.,
  5xx), the helpers surface the worker error without falling back to
  URL. This is correct (we don't want to hide real bugs behind a
  fallback) but worth knowing for future debugging.

- **Dev-mode fallback verification.** The catch branch around
  `getCloudflareContext` covers `next dev`. Logic is clean, but
  smoke-testing in `next dev` couldn't be done within this headless
  session (would need an interactive terminal). Operator can verify by
  running `pnpm --filter @splash/web dev` and exercising one of the
  admin pages — the helper should fall through cleanly to the
  URL-based path with the existing `NEXT_PUBLIC_*_WORKER_URL` env
  vars or same-origin proxies, same as before.

### Validation

- `pnpm typecheck` — **13/13 successful**, 9.055s. All packages re-ran
  fresh after TOML/.d.ts changes invalidated the turbo cache.
- `pnpm --filter @splash/web build` — **succeeded**. Next 15.5.15
  compiled in 4.2s, 12/12 static pages generated. All route bundle
  sizes unchanged from the Brief 16 snapshot:
  - `/admin/damage`        167 B / 105 kB
  - `/admin/damage/[id]`   965 B / 106 kB
  - `/admin/dashboard`     167 B / 105 kB
  - `/admin/performance` 1.85 kB / 107 kB
  - `/admin/pricing`       167 B / 105 kB
  - `/admin/pricing/[location]` 3.65 kB / 109 kB
  - `/admin/sysadmin`      161 B / 105 kB

  Service bindings are server-only — zero client JS delta.
  Middleware bundle 34.1 kB unchanged.
