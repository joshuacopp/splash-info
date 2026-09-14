# Brief 153: Promotions — foundation (worker scaffolding, service binding, db helpers, auth gate, smoke endpoint)

**Status:** Completed (2026-06-05)
**Started:** 2026-06-05
**Completed:** 2026-06-05
**Blocks:** Promotions feature (every subsequent promo brief depends on this substrate landing first; nothing user-visible ships until the next brief at earliest).
**Dependencies:** `supabase/promo-tables.sql` already run by operator (all 9 tables exist); `auth_unified` view already extended with `pur.promo_role` (operator confirmed via `SELECT user_id, email, role, dc_role, promo_role FROM auth_unified WHERE email = 'josh.copp@splashcarwashes.com'` returning all three roles); R2 bucket `splash-promo-files` already created (Public Access Disabled, Standard storage). Brief 89 + 17 + 63 patterns referenced throughout.

## Read first

- BUILD_STATE.md.
- CLAUDE.md — especially constraint #3 (`SUPABASE_SERVICE_KEY`, not `_SERVICE_ROLE_KEY`), constraint #6 (production routes commented), constraint #4 (don't `wrangler deploy` over UI-set secrets).
- supabase/promo-tables.sql — the schema this worker reads/writes against.
- BRIEFS/brief-089-forms-foundation-schema-worker-package.md — most recent greenfield-worker brief. Mirror the wrangler.toml block structure and the scaffolding shape.
- BRIEFS/brief-017-service-bindings.md — the binding-fetch pattern apps/web must use to reach this worker.
- BRIEFS/brief-063-wrangler-observability-logs.md — the `[observability.logs]` block this worker MUST include from day one.
- apps/forms-worker/wrangler.toml — current reference for wrangler shape (vars / secrets / R2 / observability / staging route).
- apps/forms-worker/src/index.ts — reference for the dispatch shape (top-level fetch handler with method/path switch).
- apps/web/wrangler.toml — existing 8 `[[services]]` entries; the new `PROMO_WORKER` binding goes alongside them.
- packages/db-supabase/src/index.ts — where the new promo helpers get exported.
- packages/db-supabase/src/auth-context.ts — current `auth_unified` read shape; this brief extends the type to include `promoRole`.

## Architecture context

This brief is the foundation for the promotions feature (replaces the ad-hoc email/phone process for promo requests). The mockup (`promotion-flow-mockup.html` at the repo root) is the visual reference for what the eventual UI surfaces look like; this brief lays the substrate underneath.

**Worker name + path-carve.** `splash-promo`, path-carved on `splashcarwashes.info/promo/*` — same reasoning as forms-worker (Brief 89): cookie domain works automatically, downloads stay simple, no Brief 88-style proxy needed. No bare `/api/*` paths (avoids the fleet-style subdomain workaround). All worker endpoints will be under `/promo/api/*` (read/write JSON) or `/promo/admin/api/*` (admin-scoped reads). No public-customer surface at this brief — the worker is internal-tooling only.

**R2 backing.** `splash-promo-files` bucket bound as `PROMO_FILES`. Namespace prefix today is `promo-materials/{promo_id}/{material_id}.{ext}` (matches the comment on `promo_materials.r2_key` in the schema). Single-namespace, single-bucket, room for siblings later (e.g. `promo-announcement-attachments/` if announcement archival materializes).

**Auth domain.** Per Brief 153's preceding setup, `auth_unified.promo_role` returns `super_admin | it | marketing | ops | null` per user. This brief adds `promoRole` to the `AuthSession` type and extends `getAuthContext()` in `@splash/db-supabase` to read it. Worker handlers gate via `promoRole` going forward (same posture as fleet/damage worker `dcRole` gates).

**This brief is non-deployable on its own.** It boots the worker, wires the bindings, exposes one smoke endpoint (`GET /promo/api/ping`), and that's it. No promo CRUD, no material upload, no announcement send. Future briefs build on top.

## Context

The mockup demonstrated the full UX, the schema captures the data model, the R2 bucket is ready, and the auth_unified view exposes the new role. Everything blocking worker scaffolding is done. This brief is mechanical: new directory, new wrangler.toml, new tsconfig, new package.json, new src/index.ts boilerplate, one new helper file in `@splash/db-supabase`, one apps/web binding addition.

Slot inventory for crons stays untouched at this brief (no scheduled work yet); future briefs may add 11:30 UTC ± something if a cleanup or digest is needed.

## Scope

### Phase 1 — New worker directory `apps/promo-worker/`

**Files (all new):**

1. `apps/promo-worker/package.json` — workspace package `@splash/promo-worker`, dev deps mirror `@splash/forms-worker` (wrangler, typescript, @cloudflare/workers-types, @splash/db-supabase, @splash/http, @splash/types, @splash/auth, @splash/storage-r2).
2. `apps/promo-worker/tsconfig.json` — extend the workspace base; `compilerOptions.types` includes `@cloudflare/workers-types`.
3. `apps/promo-worker/wrangler.toml` — see exact shape under Phase 1a below.
4. `apps/promo-worker/src/index.ts` — fetch handler with path dispatch; returns 404 for anything except the smoke endpoint and `OPTIONS *`.
5. `apps/promo-worker/.env.example` — documents required bindings (parallels forms-worker).

**Phase 1a — wrangler.toml shape (verbatim except for the comments / vars):**

```toml
# Splash Promotions Worker — Brief 153.
#
# Hosts the internal-tooling JSON API for the promotions feature.
# See Briefs 153+ for the complete feature scope.
#
# DEPLOY STRATEGY: workers.dev only until cutover (CLAUDE.md constraint
# #6). Production routes stay commented; staging route is path-carved.

name = "splash-promo"
main = "src/index.ts"
compatibility_date = "2026-06-05"
compatibility_flags = ["nodejs_compat"]
upload_source_maps = true
workers_dev = true

routes = [
  { pattern = "staging.splashcarwashes.info/promo/*", zone_name = "splashcarwashes.info" }
]

# routes = [
#   { pattern = "splashcarwashes.info/promo/*", zone_name = "splashcarwashes.info" }
# ]

[vars]
SUPABASE_URL = "https://rewokyofschtvqgxrxwl.supabase.co"

[[r2_buckets]]
binding     = "PROMO_FILES"
bucket_name = "splash-promo-files"

[limits]
cpu_ms = 30000

[observability.logs]
enabled = true
invocation_logs = true
```

Required secrets (bound via `pnpm --filter @splash/promo-worker exec wrangler secret put NAME`):

- `SUPABASE_SERVICE_KEY` — for `promotions` / `promo_*` writes and reads (service key, NOT `_SERVICE_ROLE_KEY`).
- `SUPABASE_ANON_KEY` — for `authenticate()` cookie→session round-trip.

No webhook secrets at this brief — announcement webhook, internal-note notification, and any future PA integrations are deferred to their own briefs.

**Phase 1b — src/index.ts dispatch:**

```ts
import { jsonError } from "@splash/http";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  SUPABASE_ANON_KEY: string;
  PROMO_FILES: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    // Smoke endpoint — sanity check that bindings resolved and the worker boots.
    if (url.pathname === "/promo/api/ping" && request.method === "GET") {
      return Response.json({
        ok: true,
        worker: "splash-promo",
        timestamp: new Date().toISOString(),
        bindings: {
          supabase_url_set: Boolean(env.SUPABASE_URL),
          supabase_service_key_set: Boolean(env.SUPABASE_SERVICE_KEY),
          supabase_anon_key_set: Boolean(env.SUPABASE_ANON_KEY),
          promo_files_bound: Boolean(env.PROMO_FILES)
        }
      });
    }

    return jsonError(404, "Promo worker scaffolding only; see Brief 154+ for endpoints.");
  }
};
```

### Phase 2 — Service binding from apps/web

**File:** `apps/web/wrangler.toml`.

Add an 9th `[[services]]` entry alongside the existing eight:

```toml
[[services]]
binding = "PROMO_WORKER"
service = "splash-promo"
```

**File:** `apps/web/cloudflare-env.d.ts` — extend the declaration-merged `CloudflareEnv` interface to include `PROMO_WORKER: Fetcher` (matches Brief 17 pattern for the seven existing entries).

No service-binding-using code lands at this brief — the binding exists so the next brief can wire a helper. Smoke verification (Phase 5 below) only hits `/promo/api/ping` directly via the workers.dev URL.

### Phase 3 — `@splash/db-supabase` extensions

**File:** `packages/db-supabase/src/auth-context.ts` — extend the read.

- Update the `.select(...)` string on the `auth_unified` query to include `promo_role`.
- Add `promo_role` to the local `AuthUnifiedRow` type.
- Map `promoRole: row.promo_role` in the `AuthSession` return.

**File:** `packages/types/src/session.ts` — add `promoRole: PromoRole | null` to `AuthSession`.

**File:** `packages/types/src/promo.ts` — new file. Export `PromoRole`:

```ts
export type PromoRole = "super_admin" | "it" | "marketing" | "ops";
```

Re-export from `packages/types/src/index.ts`.

**File:** `packages/db-supabase/src/promo.ts` — new file, scaffolding only. Exports two zero-impl helpers as placeholders to claim the namespace and shape:

```ts
// Brief 153: promo helpers scaffolding. Implementation lands in Brief 154+.
// These exports exist so subsequent briefs have a stable import surface.

import type { PromoRole } from "@splash/types";

export interface PromoAuthGate {
  promoRole: PromoRole | null;
  isAuthorized: boolean;
}

/**
 * Server-side promo-role gate.
 *
 * Returns isAuthorized=true when the caller has at least one of the
 * required roles. Pass an empty array to require any non-null promoRole.
 *
 * Future expansion: per-promo ACL (created_by + assignees) can be added
 * by widening the signature with a promoId; v1 is role-only.
 */
export function gatePromoRole(
  promoRole: PromoRole | null,
  required: PromoRole[]
): PromoAuthGate {
  if (!promoRole) return { promoRole: null, isAuthorized: false };
  if (required.length === 0) return { promoRole, isAuthorized: true };
  return { promoRole, isAuthorized: required.includes(promoRole) };
}
```

Re-export from `packages/db-supabase/src/index.ts`.

### Phase 4 — Smoke verify (manual, post-deploy)

Operator deploys via `pnpm --filter @splash/promo-worker exec wrangler deploy` (CLAUDE.md constraint #4 applies — secrets must be bound via CLI, not UI, before first deploy).

Smoke checks (in order):

1. `GET https://splash-promo.<account>.workers.dev/promo/api/ping` returns 200 JSON with all four binding flags `true`. If any flag is `false`, the corresponding `wrangler secret put` step was skipped.
2. `GET https://splash-promo.<account>.workers.dev/promo/api/anything-else` returns 404 with body `{"error":"Promo worker scaffolding only; see Brief 154+ for endpoints."}`.
3. `GET https://staging.splashcarwashes.info/promo/api/ping` returns the same JSON shape as (1) — confirms staging route binding picked up the most-specific-match-wins routing per CF zone config.

### Phase 5 — Doc updates

1. **PRE_DEPLOY_PROMO.md** — new file, brief stub. Covers: bindings checklist (secrets above + R2 + `[vars]`), smoke checks from Phase 4, the workers.dev-only posture, no cron at this brief, "production routes stay commented per constraint #6". Mirror PRE_DEPLOY_FORMS.md shape.
2. **BUILD_STATE.md** — bump "Last updated", add a Findings log entry summarizing what Brief 153 landed, add Brief 153 to the prioritized work list with status `Completed (YYYY-MM-DD)`.
3. **BRIEFS/INDEX.md** — new row for Brief 153.
4. **CLAUDE.md** — three additions (concise, follow existing patterns):
   - Under the apps/ tree comment block: new bullet for `apps/promo-worker     Promotions feature (Brief 153) — internal-tooling JSON API at /promo/api/*`.
   - Under the packages/ helper docs near `@splash/db-supabase`: add `gatePromoRole` + `promo.ts` to the helper list.
   - New glossary entry **promo-worker** (Brief 153) — analog of the jotform-worker entry: what it is, what it owns, bindings, namespaces, what's deferred to future briefs.

### Phase 6 — Build verification

Run from repo root:

- `pnpm install` — picks up the new workspace package.
- `pnpm typecheck` — must pass across the monorepo (apps/web's cloudflare-env type extension lands cleanly; @splash/types' new PromoRole export resolves; @splash/db-supabase's new exports type-check).
- `pnpm --filter @splash/promo-worker build` — must produce a clean dist.
- `pnpm --filter @splash/web build` — must still pass (catches the apps/web service-binding type extension).

## Definition of Done

- `apps/promo-worker/` directory exists with the four files above + `.env.example`.
- `wrangler.toml` binds R2 + observability + staging route + workers_dev = true.
- `apps/web/wrangler.toml` declares the 9th `[[services]]` binding.
- `apps/web/cloudflare-env.d.ts` extends CloudflareEnv with `PROMO_WORKER: Fetcher`.
- `@splash/types` exports `PromoRole`.
- `@splash/types/session.AuthSession` includes `promoRole: PromoRole | null`.
- `@splash/db-supabase` exports `gatePromoRole` + an updated `getAuthContext` that reads `promo_role` from `auth_unified`.
- `pnpm typecheck` passes monorepo-wide.
- `pnpm --filter @splash/promo-worker build` produces a clean dist (compressed bundle size logged in the Outcome).
- `pnpm --filter @splash/web build` still passes.
- PRE_DEPLOY_PROMO.md exists.
- BUILD_STATE.md + INDEX.md + CLAUDE.md updated per Phase 5.
- Smoke checks (Phase 4) executed and recorded in the Outcome. Operator confirms all four binding flags reported `true` on the ping response.

## Out of scope (v2 / later briefs)

- Any promo CRUD endpoint (`GET /promo/api/promos`, etc.) — first one is Brief 154.
- Any material upload endpoint (`POST /promo/api/materials`) — Brief 155+.
- Announcement send (`POST /promo/api/promos/{id}/announce`) — separate brief.
- apps/web pages (`/admin/promotions/*`) — at least one worker endpoint must ship first.
- Cron jobs — none required at this brief; daily cleanup / digest can come with the first endpoint that creates orphan-prone state.
- RLS policies — service-key-only access for now per the rest of the monorepo.
- Per-promo ACL (created_by + assignees override) — role-only at v1.
- Production custom domain route — operator-driven cutover only.

## Outcome

- **Files created (8):**
  - `apps/promo-worker/package.json` — `@splash/promo-worker` workspace package; dev deps mirror forms-worker (wrangler 4.86, typescript 5.6, @cloudflare/workers-types 4, plus workspace deps @splash/auth, @splash/db-supabase, @splash/http, @splash/storage-r2, @splash/types).
  - `apps/promo-worker/tsconfig.json` — extends `@splash/config/tsconfig.worker.json` (which pulls in `@cloudflare/workers-types` via `compilerOptions.types`).
  - `apps/promo-worker/wrangler.toml` — verbatim from brief Phase 1a. Staging route `staging.splashcarwashes.info/promo/*` bound; production routes commented; `[vars] SUPABASE_URL`; `[[r2_buckets]] PROMO_FILES → splash-promo-files`; `[limits] cpu_ms = 30000`; `[observability.logs]` block on day one (Brief 63 pattern); `compatibility_date = "2026-06-05"`; `workers_dev = true`.
  - `apps/promo-worker/src/index.ts` — verbatim from brief Phase 1b. Single `fetch` handler: `OPTIONS → 204`, `GET /promo/api/ping → 200 JSON` with `{ok, worker, timestamp, bindings: {supabase_url_set, supabase_service_key_set, supabase_anon_key_set, promo_files_bound}}`, everything else `→ jsonError(404, "Promo worker scaffolding only; see Brief 154+ for endpoints.")`. `Env` interface declares the four bindings. `ctx` param underscored as `_ctx` per "no consumer yet, name flagged for future `ctx.waitUntil` use".
  - `apps/promo-worker/.env.example` — bindings reference (non-secret vars + secrets + R2 bucket). First per-worker `.env.example` in the monorepo; documents the day-one minimum and flags deferred items (no webhook secrets, no scheduled triggers at this brief).
  - `packages/types/src/promo.ts` — exports `PromoRole = "super_admin" | "it" | "marketing" | "ops"`. Header comment captures the four role meanings from `supabase/promo-tables.sql` (super_admin bypass, it ticket fields, marketing create/materials/PTP, ops read-only).
  - `packages/db-supabase/src/promo.ts` — exports `gatePromoRole(promoRole, required[]) → PromoAuthGate` + the `PromoAuthGate` interface (`{promoRole, isAuthorized}`). Empty `required[]` returns `isAuthorized: true` for any non-null promoRole; null promoRole always returns `isAuthorized: false`. Verbatim from brief Phase 3.
  - `PRE_DEPLOY_PROMO.md` — mirrors PRE_DEPLOY_FORMS.md shape. 7 sections: worker overview, bindings (`wrangler secret put` reminder + CLAUDE.md constraint #4 cross-ref), 9 Supabase tables already applied via `supabase/promo-tables.sql`, R2 bucket namespace, cutover plan (no production cutover at this brief — workers.dev only), three smoke checks (Phase 4 from the brief), known v2 candidates.

- **Files modified (8):**
  - `apps/web/wrangler.toml` — 9th `[[services]]` block `PROMO_WORKER → splash-promo` inserted right after the Brief 107 JOTFORM_WORKER entry, before the `[assets]` block. Includes a comment matching the surrounding format.
  - `apps/web/cloudflare-env.d.ts` — `PROMO_WORKER: Fetcher;` appended inside the declaration-merged `CloudflareEnv` interface (9th entry).
  - `packages/types/src/index.ts` — `export * from "./promo.js";` appended after the email-validate re-export.
  - `packages/types/package.json` — `"./promo": "./src/promo.ts"` added to the `exports` map for subpath imports (`@splash/types/promo`).
  - `packages/types/src/session.ts` — imported `PromoRole`; added `promoRole: PromoRole | null` as the last field of the `Session` interface with a docblock noting the auth_unified surface.
  - `packages/db-supabase/src/auth-context.ts` — `AuthUnifiedRow` interface gained `promo_role: PromoRole | null` (with a `@splash/types/promo` import); the `.select(...)` string appended `,promo_role`; the returned Session maps `promoRole: row.promo_role`.
  - `packages/db-supabase/src/index.ts` — `export * from "./promo.js";` appended after the outbound-emails re-export.
  - `CLAUDE.md` — three additions: new bullet for `apps/promo-worker` in the apps/ tree, `@splash/db-supabase` helper bullet extended with `gatePromoRole` + `promo.ts` reference, new `promo-worker (Brief 153)` glossary entry placed before the jotform-worker entry (covers what it is, what it owns, bindings, namespaces, permission domain, what's deferred to future briefs).
  - `BRIEFS/INDEX.md` — new top row for Brief 153.
  - `BUILD_STATE.md` — Last updated bumped to 2026-06-05 with a Brief 153 summary; new Findings & decisions log entry at the top of the table; new row for Brief 153 in the prioritized work list.

- **Decisions made on operator's behalf:**
  1. **`PromoRole` lives in its own file** (`packages/types/src/promo.ts`) rather than appended to `claims.ts` or `auth.ts` — keeps the new permission domain narrow and parallels the existing `claims.ts → DamageRole` shape. Subpath export `@splash/types/promo` is the canonical import path for callers that want surgical tree-shaking.
  2. **`Session.promoRole` placed at the END of the `Session` interface** so existing field ordering stays intact; `getAuthContext` mapping appends to the existing object literal rather than re-ordering. No existing call sites construct a `Session` literal outside `getAuthContext` (confirmed via repo-wide grep for `dcLocations: [`), so the change ripples cleanly.
  3. **`.env.example` per-worker is a NEW convention** introduced here. No other worker had one; the brief's scope called for it. Documents the day-one minimum (vars + secrets + R2 binding) in the same style as `apps/web/.env.example`. If the convention sticks, a follow-up brief should retrofit the other six TS workers.
  4. **The worker's dispatch shape is a flat `if (path && method)` chain** with one match + a default 404 — same shape as forms-worker's pre-Brief-90 scaffolding moment, easy to widen in Brief 154 without rework. `compatibility_date` set to today (2026-06-05) per the brief's verbatim spec; matches the "use the most recent stable date" Cloudflare guidance.
  5. **`_ctx: ExecutionContext`** (underscored unused) on the fetch handler so future briefs can plumb through `ctx.waitUntil` without altering the signature.
  6. **No `[[rules]]` Text-bundling block + no `[triggers] crons` block at this brief** — neither needed; future briefs add them when first vendored client JS or first cron lands.
  7. **The brief's spec called for adding `promoRole` to "`AuthSession`"** but the actual symbol in `packages/types/src/session.ts` is `Session` (which `@splash/auth/session.ts` re-exports verbatim). Treated as equivalent; added to `Session`.
  8. **`gatePromoRole`'s empty-`required[]` semantics** ("any non-null promoRole passes") chosen to match the brief's explicit example — lets future worker handlers express "any logged-in promo user" without enumerating all four enum values.

- **Latent issues found:**
  - **(a)** `BUILD_STATE.md` prioritized work list table contains rows for briefs 1–98 + 91/95/96/97; briefs 100–152 are tracked in the Findings log only (no prioritized-list rows). Added Brief 153 as a new row anyway per the brief's Phase 5.2 spec. A future cleanup brief could backfill the missing intermediate rows.
  - **(b)** This is the FIRST per-worker `.env.example` in the monorepo. If the convention sticks, a follow-up brief should retrofit the other six TS workers (signup, sysadmin, dashboard, performance, damage, workorders, forms, jotform) with the same shape.
  - **(c)** The brief assumed operator already applied `supabase/promo-tables.sql` AND extended the `auth_unified` view. Confirmed via the brief's Dependencies section: "operator confirmed via `SELECT user_id, email, role, dc_role, promo_role FROM auth_unified WHERE email = 'josh.copp@splashcarwashes.com'` returning all three roles". If `promo_role` is NOT yet a column on `auth_unified` in any environment (dev / staging / prod), the `getAuthContext` `.select(...)` call will 400 at runtime — `getAuthContext` then throws, which surfaces as a 500 on any auth-dependent endpoint. No Brief 153 endpoint depends on `getAuthContext` (the ping endpoint is bindings-only), so the smoke check still works even if the view extension is missing in a given environment. Brief 154+ should re-confirm before consuming `session.promoRole`.
  - **(d)** `Session` widening is monorepo-global. Confirmed via TypeScript that no existing call site constructs a `Session` literal outside `getAuthContext` — `pnpm typecheck` 19/19 green confirms. Any future test fixture or session constructor must include `promoRole`; the new field is non-optional (`PromoRole | null`, not `PromoRole | null | undefined`).
  - **(e)** No CF deploys, no production-route bindings, no git commits per CLAUDE.md — all operator-driven post-brief.
  - **(f)** No cron, no webhook secrets at this brief — scaffolding only.

- **Validation results (typecheck / build / smoke):**
  - `pnpm install` — `22 workspace projects` resolved (was 21 pre-brief; new `@splash/promo-worker` picked up). 0 packages installed; existing workspace symlinks reused. Done in 4.1s.
  - `pnpm typecheck` — **19/19 successful** (0 cached, 19 total — first run after the install picked up the new workspace; all workers, all packages, all apps green). 15.9s. No type errors anywhere in the monorepo from the new `Session.promoRole` field, the new `AuthUnifiedRow.promo_role`, the new `@splash/types/promo` export, or the new `@splash/db-supabase/promo` export.
  - `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — succeeded. **Bundle: 1.31 KiB raw / 0.69 KiB gzip.** Wrangler 4.87.0 confirmed bindings: `env.PROMO_FILES (splash-promo-files)` R2 Bucket + `env.SUPABASE_URL` env var. Secrets (`SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`) not shown in dry-run output (set via `wrangler secret put`, not displayed). `.tmp-build` cleaned up after.
  - `pnpm --filter @splash/web build` — succeeded. Next 15 compiled 38 routes; `/admin/dashboard` 169 B / 107 kB First-Load JS (unchanged); no new apps/web route at this brief (apps/web pages deferred to Brief 154+). Middleware 34.1 kB. No new routes, no new client islands; the only apps/web change is the type-level `PROMO_WORKER: Fetcher` declaration + the `[[services]]` block, which doesn't ship to the browser.
  - **Smoke checks (Phase 4)** — operator-driven post-deploy; documented in PRE_DEPLOY_PROMO.md §6 and the brief's Phase 4. Three checks: (1) `GET https://splash-promo.<account>.workers.dev/promo/api/ping → 200 JSON` with all four binding flags `true`; (2) `GET /promo/api/anything-else → 404` with the documented body; (3) `GET https://staging.splashcarwashes.info/promo/api/ping → 200 JSON` same shape as (1) confirming the staging route binding.

- **Bundle size on splash-promo deploy:**
  - **1.31 KiB raw / 0.69 KiB gzip** via `wrangler deploy --dry-run`. Worker is essentially empty by design at this brief — only the ping endpoint and a default 404. Bundle grows with Brief 154+ as real endpoints land. Plenty of headroom against CF's 3 MiB compressed / 10 MiB paid limits.
