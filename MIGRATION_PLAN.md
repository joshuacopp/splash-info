# Splash MaxPass — Monorepo Migration Plan

**Audience:** Claude Code (or any engineer) picking up this migration.
**Source repo:** Five standalone Cloudflare Workers in a Claude Project.
**Goal:** A single GitHub monorepo deployed as Cloudflare Pages (Next.js UI) + 5 Cloudflare Workers (APIs), with shared packages for DB clients, auth, and UI.

This document captures every architecture decision made during planning, the skeleton already created, what remains, and the specific gotchas that will bite you if you don't read them first.

---

## 1. Decisions already made (do not re-litigate)

| Decision | Choice | Why |
|---|---|---|
| **Architecture pattern** | Option C — monorepo: 1 Next.js app + 5 Workers + shared packages | The 5 domains have genuinely different concerns (signup is high-traffic public, sysadmin is auth-heavy, damage has a state machine + R2 + D1). Splitting workers means a bug in one can't take down the others; shared packages prevent duplication. |
| **GitHub + tooling** | GitHub repo, pnpm workspaces, Turborepo, Cloudflare Pages | Standard Cloudflare monorepo setup. Turbo gives us build caching and `--filter` deploys. |
| **Frontend framework** | Next.js (App Router) on Cloudflare via `@opennextjs/cloudflare` | Cloudflare deprecated `@cloudflare/next-on-pages` earlier in 2026. OpenNext is the supported path now. |
| **Node version (local)** | Node 22 LTS | Current active LTS as of May 2026. |
| **Workers `compatibility_date`** | `2026-05-01` | Today's date. Auto-enables all the recent Node compat improvements (child_process, perf_hooks, http modules, sqlite stub, etc.). |
| **Workers `compatibility_flags`** | `["nodejs_compat"]` | Standard. v2 behavior is enabled automatically by the compat date above. |
| **Package namespace** | `@splash/` | E.g., `@splash/db-supabase`, `@splash/auth`, `@splash/web`. |
| **React version** | React 19 | Current stable. Ports React 18 only if a library forces it. |
| **5-worker boundaries** | Keep as-is — one worker per existing file | User explicitly does not want them merged. They are separate tools and functions. |
| **Migration order** | signup → sysadmin → dashboard → performance → damage (last) | Damage is 5,684 lines with the most complex domain (state machine, R2, D1, multi-role workflow). Get the simpler ones done first to build muscle memory. |

### Data layer split

This is critical and was corrected mid-conversation — read the files, do not infer.

| Store | What lives there | Used by |
|---|---|---|
| **Supabase (Postgres)** | `user_permissions`, `pricing_simple`, `pricing_simple_resolved` view, `maxpass_signups`, `suspicious_phones`, `phone_usage_log`, claims metadata that mirrors D1, locations metadata | All 5 workers + Next.js |
| **D1** (binding name: `DB`) | `claims` (parallel record alongside SharePoint), `claim_photos`, `locations` (`is_active`, `site_number`, `location_pretty`, `location_code`), claim activity/audit log | **damage worker only today** (exposed as shared package for future use) |
| **R2** (binding name: `R2_BUCKET`, bucket: `splash-vehicle-claims`) | Damage claim photos, full submission JSON archives, failed-submission fallback | damage worker |
| **R2 (public bucket)** | Brand assets — `SplashScriptWhite_RedCar.png`, `Splash_logo_full (1) 1.png`, `favicon-32x32.png` | All workers (currently hardcoded in 5+ places) |

Public R2 base URL: `https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev` (already centralized in `packages/storage-r2/src/assets.ts`).

---

## 2. Source files in the Claude Project

These are the five existing Workers. They sit in `/mnt/project/` in this Claude Project but you'll have local copies via the project sync. Line counts are accurate as of the planning conversation.

| File | Lines | Worker format | Route(s) | Notes |
|---|---|---|---|---|
| `signupworker.js` | 3,332 | **Service Worker** (`addEventListener("fetch")`) | `splashcarwashes.info/signup/*`, `/api/submit-signup`, `/admin/*` (legacy) | The original. Also serves `/admin/*` UI today — that responsibility is moving to `apps/web`. |
| `sysadmin.js` | 1,951 | **Service Worker** | `splashcarwashes.info/sysadmin`, `/sysadmin/*` | User management, password resets, role assignment. Calls Supabase Admin API directly. |
| `dashboard.js` | 611 | **Service Worker** | `splashcarwashes.info/` (root only) | **SSO entry point.** Sets the Supabase auth cookies (`sb-access-token`, `sb-refresh-token`) with `Path=/` so all other workers share the session. Routes authenticated users to `/admin`, `/manage`, or `/pertrack`. |
| `performancetracker.js` | 448 | **Module Worker** (`export default { fetch }`) | `splashcarwashes.info/pertrack/*` | Already imports a separate `./ui.js`. Cleanest of the five to migrate. |
| `damagemanager.js` | 5,684 | **Module Worker** | `splashcarwashes.info/manage/*`, `/claims-api/*` | Most complex. State machine for claim workflow, R2 photo handling, D1 claims storage, Power Automate POSTs, PDF generation. Migrate **last**. |

### Format consistency note
Three workers use the legacy Service Worker format and need to be rewritten to Module Worker format (`export default { fetch }`) during migration — this is required for `nodejs_compat` v2 and future-proofing. Do not skip this step.

### Other project files for reference
- `Project_architecture_` — the original architecture doc (slightly outdated; follow this migration plan over it where they conflict)
- `Scope_of_Project` — original requirements
- `supabase_pricing_simple` — pricing_simple table schema reference
- `Location_pretty_supabase_columns` — column reference

---

## 3. Skeleton already created

A `splash-maxpass/` directory has been created with the following files. **Do not recreate these from scratch — extend them.**

```
splash-maxpass/
├── .gitignore                          ← covers .wrangler/, .next/, .open-next/, .turbo/, env files
├── package.json                        ← root manifest, pnpm@9.12.0, Node ≥22, Turbo scripts
├── pnpm-workspace.yaml                 ← packages: apps/*, packages/*
├── turbo.json                          ← build/dev/lint/typecheck/deploy pipeline
└── packages/
    ├── config/                         ← shared TS/ESLint/Tailwind configs
    │   ├── package.json
    │   ├── tsconfig.base.json          ← strict TS, ES2022, bundler resolution
    │   ├── tsconfig.worker.json        ← extends base, adds @cloudflare/workers-types
    │   ├── tsconfig.next.json          ← extends base, adds DOM lib + next plugin
    │   ├── eslint.base.cjs
    │   └── tailwind.base.cjs           ← brand colors are placeholders, needs real values from CSS in workers
    ├── types/                          ← shared TS types (empty placeholder)
    ├── db-supabase/                    ← Supabase client + typed queries (empty placeholder, depends on @splash/types)
    ├── db-d1/                          ← D1 client (empty placeholder, depends on @splash/types)
    ├── storage-r2/                     ← R2 helpers
    │   ├── src/index.ts                ← empty placeholder
    │   └── src/assets.ts               ← ✅ REAL CODE — brand asset URL constants
    ├── auth/                           ← Supabase auth + role helpers (empty, depends on db-supabase + types)
    └── ui/                             ← React components (empty, React 19, depends on storage-r2 + types)
```

**The only real code in the skeleton is `packages/storage-r2/src/assets.ts`** — everything else is empty placeholders awaiting Step 5 ports.

### Package dependency graph (build order)

```
config         ← no deps
types          ← no runtime deps
db-supabase    ← types
db-d1          ← types
storage-r2     ← no @splash deps
auth           ← db-supabase, types
ui             ← storage-r2, types
```

---

## 4. Steps to execute (in order)

### Step 4 — Apps directory scaffolding

Create `apps/` with 6 sub-projects. Each gets its own `package.json`, `tsconfig.json`, `wrangler.toml` (workers only), and starter source.

```
apps/
├── web/                                ← Next.js (Cloudflare Pages)
├── signup-worker/                      ← /signup/*, /api/submit-signup
├── sysadmin-worker/                    ← /sysadmin/*
├── dashboard-worker/                   ← / (SSO landing)
├── performance-worker/                 ← /pertrack/*
└── damage-worker/                      ← /manage/*, /claims-api/*
```

For each worker:
- `wrangler.toml` with:
  - `compatibility_date = "2026-05-01"`
  - `compatibility_flags = ["nodejs_compat"]`
  - The exact route pattern from the source file (see table above)
  - Bindings: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` for all; `DB` (D1) and `R2_BUCKET` for damage-worker only
- `src/index.ts` with a Module Worker stub (`export default { fetch }`)
- Scripts: `dev` (`wrangler dev`), `deploy` (`wrangler deploy`), `typecheck`, `lint`

For `apps/web`:
- Next.js 15+ with App Router
- `@opennextjs/cloudflare` adapter
- `wrangler.toml` for Cloudflare Pages build
- Tailwind set up using `@splash/config/tailwind.base.cjs`
- App Router structure: `app/signup/[location]/`, `app/admin/pricing/`, `app/admin/dashboard/`, `app/admin/performance/`, `app/admin/damage/`
- Shared layout pulls logo/favicon from `@splash/storage-r2/assets`

After scaffolding: run `pnpm install` from the root. Confirm everything resolves, no version conflicts. Run `pnpm typecheck` — should pass with all empty packages.

### Step 5 — Port shared packages first

Before migrating any worker, populate the shared packages by reading code from the source files:

1. **`@splash/types`** — extract types for:
   - Pricing modes (`full | same | flash5 | flash2 | special | penny`)
   - `pricing_simple` row shape (see `supabase_pricing_simple` doc)
   - `maxpass_signups` row shape
   - User roles (`super_admin | regional_manager | area_manager | site_manager | location_admin`)
   - Claim status enum (read damagemanager.js — there are ~15 states; the transition list in the user's memory is partial)
   - Location row shape (Supabase + D1 versions, since they differ)

2. **`@splash/db-supabase`** — extract from sysadmin.js, signupworker.js:
   - The Supabase REST helpers (raw `fetch` to `/rest/v1/...`)
   - Service-key vs anon-key client creation
   - Query helpers: `getPricing(locationCode)`, `getUserPermissions(email)`, `insertSignup(...)`, `getSuspiciousPhone(phone)`, `logPhoneUsage(...)`
   - **Use `@supabase/supabase-js` v2 instead of raw fetch** for the new package — it handles edge cases better and is well-supported in Workers with `nodejs_compat`.

3. **`@splash/db-d1`** — extract from damagemanager.js:
   - The `writeClaimToD1` function (line ~345)
   - Photo storage helpers
   - Locations lookup (line ~358 — does the `is_active = 1` check)
   - Activity log inserts
   - Claim queries (look for `env.DB.prepare(...)` usage throughout)

4. **`@splash/storage-r2`** — extract from damagemanager.js:
   - `uploadToR2` (line ~260)
   - `saveSubmissionToR2` (line ~318)
   - `saveFailedSubmission` (line ~304)
   - `serveR2Photo` (line ~51)
   - `assets.ts` is already done

5. **`@splash/auth`** — extract from sysadmin.js, signupworker.js, damagemanager.js:
   - `checkAuth` (each file has its own — unify them)
   - `checkToolAccess` (from performancetracker.js — generalize the tool-name parameter)
   - Role-based location filtering (the `rm_email` / `am_email` / `site_email` matching logic)
   - Cookie helpers for `sb-access-token` / `sb-refresh-token`
   - Supabase Admin API password reset (`PUT /auth/v1/admin/users/{id}` — see the user's memory; this is NOT an RPC call)

6. **`@splash/ui`** — extract from all five source files:
   - The shared layout/header/footer HTML → React components
   - The four signup modals: Success / Deny / Warn / Monitor
   - Pricing UI components (mode buttons, package cards, modal selector)
   - Phone input with auto-formatting (the `(607)768-5674` formatter)
   - Damage claim photo uploader
   - Status badges
   - Animated bubble background CSS → Tailwind utility or component
   - Brand colors → put real values into `packages/config/tailwind.base.cjs` (extract from inline `<style>` blocks in the worker files)

### Step 6 — Port workers, simplest first

For each worker: create `apps/{name}-worker/src/index.ts`, port the routing logic, replace inline data access with shared package imports, and confirm types pass.

**Order:**
1. `dashboard-worker` (611 lines, simplest, but critical SSO logic — go slow on cookie behavior)
2. `performance-worker` (448 lines, already split UI/logic)
3. `signup-worker` (3,332 lines — bulk is HTML rendering, which moves to Next.js, so the actual worker shrinks dramatically)
4. `sysadmin-worker` (1,951 lines — admin API only, UI moves to Next.js)
5. `damage-worker` (5,684 lines — state machine, do last)

**Pattern for each port:**
- HTML rendering moves to `apps/web` (Next.js pages)
- API endpoints stay in the worker (form submissions, data mutations)
- Auth logic uses `@splash/auth`
- DB calls use `@splash/db-supabase` / `@splash/db-d1`
- R2 calls use `@splash/storage-r2`
- Types come from `@splash/types`

### Step 7 — Build out Next.js routes

Move the HTML/CSS/JS that was inline in each worker into proper React components and pages:

- `app/signup/[location]/page.tsx` — package picker
- `app/signup/[location]/[package]/page.tsx` — signup form with terms + JotForm/MS Forms routing
- `app/admin/page.tsx` — landing dashboard (was dashboard.js root handler)
- `app/admin/pricing/[location]/page.tsx` — pricing admin (was sysadmin/admin in signupworker.js)
- `app/admin/users/page.tsx` — user management (was sysadmin.js UI)
- `app/admin/performance/page.tsx` — performance tracker UI (was performancetracker.js HTML)
- `app/admin/damage/[claimId]/page.tsx` — damage claim view + actions
- `app/admin/damage/page.tsx` — claims list
- `app/login/page.tsx` — shared login form (was inline in dashboard.js)

Each page server-fetches data using `@splash/db-supabase` and posts mutations to the appropriate worker API.

### Step 8 — CI/CD

`.github/workflows/`:
- `ci.yml` — on every PR: `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm build`
- `deploy.yml` — on push to `main`: deploy each worker via `wrangler deploy`, deploy Pages via the Cloudflare Pages GitHub integration (or `pnpm deploy:web` if doing direct deploys)

Use Turbo's `--filter=...[HEAD^]` flag for change-aware deploys so only modified packages redeploy.

---

## 5. Critical gotchas — read before writing any code

These come from real bugs the user has hit. Skipping any of these will cost you hours.

### Worker-format gotchas
- **Three of the five source workers are old Service Worker format.** They MUST be rewritten to Module Worker format (`export default { fetch(request, env, ctx) }`) during migration. `addEventListener("fetch", ...)` does not work cleanly with `nodejs_compat` v2.
- **`env` is per-request in Module Workers.** Service Worker code that closes over module-scope env vars needs refactoring.

### Routing gotchas
- **The `/dev/` prefix stripping caused dev submissions to hit production** in the past. Test workers must be completely separate Cloudflare Workers with their own bindings/env vars — do not rely on path-based dev/prod separation.
- **Microsoft Forms routing must occur before input validation** in the signup worker. There's a location (Elmira Heights) using MS Forms instead of JotForm; routing logic for that runs first or you get "Missing or invalid required inputs" errors.
- **Form ID must NOT be URL-encoded** in MS Forms redirects.
- Each worker's route pattern is in its source file's header comment — copy them verbatim into `wrangler.toml`.

### Database gotchas
- **Always read column names from the schema files directly.** The user has been bitten repeatedly by inferred names (e.g., `pkg` vs `package`, `single` vs `single_wash_price`). Read `supabase_pricing_simple` and `Location_pretty_supabase_columns` files; do not guess.
- **Supabase Admin API for password changes is `PUT /auth/v1/admin/users/{user_id}`** — NOT an RPC call. The legacy code may show an RPC; the new code must use the Admin API.
- **D1 batches are atomic per-statement, not per-batch.** The damage worker's writeClaimToD1 is structured assuming this — preserve that structure.
- **`pricing_simple_resolved` is a view, not a table.** Do not write to it.

### Cloudflare Workers gotchas
- **"Too many subrequests"** errors come from per-location secondary fetches inside loops. Always capture all needed data in the initial fetch. Use `Map` for deduplication, not `Set`, when you need keyed data.
- **Cache API**: pricing reads are cached 5 minutes with stale-while-revalidate up to 24 hours. Preserve this behavior. Cache must be invalidated on admin pricing updates.

### JotForm/MS Forms integration
- JotForm ID for most locations: `252697336786980`
- Prefill fields: `package49`, `todaysDate`, `todaysPayment`, `nextBilling`, `typeA19`
- Family Plan packages have separate JotForm routing: `family_bubble_bath`, `family_ultra_bath`, `family_express`
- Elmira Heights uses Microsoft Forms with a different form ID and routing logic

### Power Automate column names
- New Supabase/SharePoint columns: `confirmation_token`, `today_price`, `monthly_price`, `email`, `email_sent`, `email_sent_at`
- Date format expression: `convertTimeZone(..., 'UTC', 'Eastern Standard Time', 'MM/dd/yyyy hh:mm tt')`
- Field references in Apply-to-each loops use `@{items('Apply_to_each')?['field']}` syntax
- Parse JSON schemas need `"type": ["string", "null"]` for optional fields

### Pricing modes
Six modes exist: `full`, `same`, `flash5`, `flash2`, `special`, `penny`. Each maps to a different column for "today's price." Quick Flip toggles all packages without a modal; everything else uses a per-package modal selector.

### Vibes SMS (in progress)
- Company key: `4I1t7Lj2`
- Test event: `test_maxpass_signup`
- Power Automate sends HTTP POSTs with Basic Auth
- Two distinct use cases: transactional confirmation (active) and future marketing SMS (separate program)

### Damage workflow specifics
- Approved amounts > $1000 route to CEO (currently vestigial — only reachable via admin dropdown)
- Status transitions are role-gated (gm, rm, admin, super_admin)
- Some transitions require a quote selection or receipt-on-file
- Activity log entries are written for every status transition
- Photos and submission JSON go to R2 unconditionally — even if Power Automate fails

---

## 6. What to ask the user before deviating

The user is `Josh`, IT at Splash Car Wash, 70+ locations. He has explicit preferences:

- **Step-by-step is preferred.** Don't dump 8 files in one go without checkpoints.
- **Verify column names and existing code patterns** — do not infer or assume.
- **Continuity matters.** If something was decided earlier in this plan, do not re-ask it.
- **Save complete files to the project** when working. Don't lose changes between sessions.
- **He is a super admin** — he has the access needed to test anything end to end.
- **The 5 workers are separate tools and functions** — do not propose merging them, even if they look similar (e.g., dashboard + performance both being read-heavy).

If you hit something genuinely ambiguous (a new architectural choice, a tradeoff that affects user-facing behavior), surface it explicitly with options. Don't pick silently.

---

## 7. Verification checklist (run after each step)

- [ ] `pnpm install` succeeds with no peer-dep warnings
- [ ] `pnpm typecheck` passes for every package and app
- [ ] `pnpm lint` passes
- [ ] `pnpm build` succeeds for every package and app
- [ ] `pnpm --filter @splash/{worker} dev` starts wrangler dev for each worker
- [ ] `pnpm --filter @splash/web dev` starts Next.js dev server
- [ ] After each worker is ported: deploy to a dev Cloudflare account and smoke-test the routes
- [ ] After damage worker is ported: verify a test claim end-to-end (form submit → R2 photo upload → D1 claim row → Power Automate fires → SharePoint receives)

---

## 8. Glossary

- **MaxPass** — Splash's unlimited car wash membership program (the product this whole system serves)
- **JotForm** — third-party form provider used at most locations for terms/signature collection
- **Power Automate** — Microsoft workflow tool that polls Supabase every 30 min and writes to SharePoint
- **YAMM** — "Yet Another Mail Merge", used via Google Sheets for staff communication (not relevant to the app, but mentioned in user's tooling)
- **Vibes** — third-party SMS platform (transactional + future marketing)
- **Splash brand domains** — `splashcarwashes.info` is the production domain for this app; `splashcarwashes.com` is the marketing site (separate)
