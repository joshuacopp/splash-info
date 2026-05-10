# Brief 89: Forms — foundation (schema, worker scaffolding, shared package, service binding)

**Status:** Completed (2026-05-09)
**Started:** 2026-05-09
**Completed:** 2026-05-09
**Blocks:** Form-builder feature (Briefs 90–98 all depend on this brief landing first; nothing user-visible ships until Brief 90 at earliest)
**Dependencies:** none (greenfield substrate; no prior brief required beyond Brief 17's service-binding pattern and Brief 63's `[observability.logs]` block convention)

## Read first

- BUILD_STATE.md.
- CLAUDE.md (especially constraint #6 / #9 — production routes must stay commented; constraint #3 — secrets bind under `SUPABASE_SERVICE_KEY`, not `_SERVICE_ROLE_KEY`).
- BRIEFS/brief-017-service-bindings.md (the binding-fetch pattern this brief sets up the binding for; future briefs will consume it).
- BRIEFS/brief-063-wrangler-observability-logs.md (the `[observability.logs]` block this worker must include from day one).
- BRIEFS/brief-081-fleet-inquiry-worker-lift-and-shift.md (most recent new-worker brief — reference for `wrangler.toml` shape, `[limits]`, `workers_dev = true`).
- apps/fleet-inquiry-worker/wrangler.toml (current new-worker reference; mirror its block structure for `splash-forms`, EXCEPT `splash-forms` is path-carved per Decision 2 of the planning conversation, NOT subdomain).
- apps/web/wrangler.toml (existing 7 `[[services]]` entries — the new `FORMS_WORKER` binding goes alongside them).
- packages/db-supabase/src/index.ts (where the new `resolveLookup` stub helper gets exported).
- packages/http/package.json (reference shape for the new `@splash/forms-schema` package's `package.json`).

## Architecture context

This brief is the foundation for a 10-brief form-builder feature (Briefs 89–98). All architectural decisions below were made in a planning conversation 2026-05-09 and are encoded inline in this brief so future executors don't need to recover them from conversation history.

**What we're building.** An admin-side form builder UI plus a public form-render surface. Operators (super_admin / admin) build forms in `/admin/forms/[id]` (drag-drop canvas + per-field-type config inspector + preview). Forms render publicly at `splashcarwashes.info/forms/{slug}` (path-carved by the new `splash-forms` worker). Three audiences: `public` (Turnstile-gated, anonymous submitter), `internal` (cookie-gated, captures submitter user_id + email), `link-only` (slug-as-secret, no Turnstile, no auth — operator distributes the URL).

**Why a new worker.** Per planning Decision 2, the form builder gets its own worker (`splash-forms`) rather than extending an existing one. Signup-worker is already crowded with the customer signup flow + signups-admin viewer; damage-worker is the largest in the monorepo. Bolting form-builder logic onto either creates the kitchen-sink worker the monorepo split was designed to avoid.

**Why path-carve, not subdomain.** Per planning Decision 2, `splash-forms` is path-carved on `splashcarwashes.info/forms/*`, NOT a subdomain like fleet's `fleet.splashcarwashes.info`. Three reasons: (1) cookie domain works automatically — internal forms need apps/web's auth cookie (`sb-access-token`) to identify the submitter, and same-origin requires zero cookie-domain widening (CLAUDE.md constraint #6); (2) CSV exports stay simple — no Brief 88-style proxy route needed because direct same-origin downloads just work; (3) URL aesthetics are a wash. Fleet went subdomain only because its verbatim-lifted JS had `/api/*` collisions; we don't have that constraint.

**Storage shape.** Per planning Decision 1, we use a versioned schema (Option B-classic): `forms` (identity + slug + audience + status + draft/current pointers), `form_versions` (schema as JSONB array, immutable once published), `form_submissions` (FK to `form_versions.id`, NOT `forms.id`, so past submissions always render under the exact schema they were submitted with). Files live in R2 under two namespaces: `form-assets/{form_id}/...` (in-form display images, owned by `form_assets` table) and `form-submission-files/{form_id}/{submission_id}/{field_key}/...` (per-submission uploads + signatures, owned by `form_submission_files` table). Two file tables, not one with a discriminator — different lifecycles, different ownership (per Decision 1's X-shape).

**Why R2 over Supabase Storage.** Per planning Decision 1, R2 wins on three axes: (a) zero egress fees vs. Supabase Storage's metered bandwidth (matters most for in-form display images on public forms — read-amplified); (b) the monorepo already has `@splash/storage-r2` + `damagedocs` bucket + the `claim_photos` table pattern — we're extending a convention, not forking one; (c) native CF Workers binding means no client lib, no auth handshake, just `env.FORMS_FILES.put(key, body)`.

**Shared schema package.** Per planning Decision 3, both apps/web (builder, React) and `splash-forms` (public renderer, server-rendered HTML + per-field-type vanilla JS) consume the same `@splash/forms-schema` package — Zod validators per field type plus the discriminated-union `Field` type plus `FormSchema` / `FormVersion` TypeScript types plus the `LOOKUP_SOURCES` registry. Two renderers, one schema contract; the package is what prevents drift between preview and production.

**This brief is non-deployable on its own.** It sets up the substrate — schema, worker skeleton, package, bindings — but no endpoints work yet. The worker boots and returns "404 — Forms worker scaffolding only; see Brief 90+ for endpoints." Brief 90 (public form rendering) is the first user-visible deliverable.

## Context

10-brief feature; this is the foundation. Planning conversation locked the architecture across 8 decisions; brief breakdown was agreed at 10 briefs (89 = Foundation, 90 = Public rendering, 91 = Public submission, 92 = File + signature uploads, 93 = Lookup mechanism, 94 = Admin API CRUD, 95 = Admin builder UI, 96 = Submissions admin UI, 97 = Webhook + cron + cleanup, 98 = Polish + smoke tests). Briefs 89–93 are backend-heavy; 94–97 mix backend + admin UI; 98 wraps. This brief's pieces are mechanical but numerous (schema migrations + new worker + new package + cross-worker binding + helper stub + docs).

Per planning Decision 8, no formal admin audit log is added — `form_versions` rows ARE the audit (every publish writes `published_at` + `published_by`); future briefs surface this in `/admin/forms/[id]/versions`. Status enum on submissions (`new` / `in_progress` / `closed`) plus `splash_notes` mirror fleet Brief 87's pattern.

The schema lands as SQL the operator runs in Supabase's SQL editor (consistent with how Briefs 33 / 87 / 89 / others handle schema changes — no migration framework in this repo). Brief includes the SQL inline; operator runs it before queueing Brief 90.

## Scope

### Phase 1 — Supabase schema (operator runs the SQL)

**File:** new `supabase/forms-tables.sql` (NEW directory `supabase/` if it doesn't exist; this is the first file to live there).

Contents — five tables, all UUID PKs, FK cascades wired conservatively for the v1 no-delete-from-UI posture per Decision 7:

```sql
-- Brief 89: form-builder foundation schema.
-- Operator runs this in Supabase SQL editor before queueing Brief 90.
-- All five tables are new; nothing in the existing schema is modified.

-- 1. forms — identity, slug, audience, status, draft/current pointers.
CREATE TABLE IF NOT EXISTS forms (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text UNIQUE NOT NULL,
  title               text NOT NULL,
  description         text,
  audience            text NOT NULL CHECK (audience IN ('public', 'internal', 'link-only')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  current_version_id  uuid,                                                   -- FK added below (forward ref)
  draft_version_id    uuid,                                                   -- FK added below
  notify_webhook      boolean NOT NULL DEFAULT true,
  success_message     text,
  turnstile_required  boolean NOT NULL DEFAULT true,                          -- public default; internal/link-only sets false
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL,                                          -- auth.users.id (loosely — no FK to auth schema)
  last_edited_at      timestamptz NOT NULL DEFAULT now(),
  last_edited_by      uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forms_status ON forms (status);
CREATE INDEX IF NOT EXISTS idx_forms_slug ON forms (slug);

-- 2. form_versions — immutable schema snapshots; one row per (form, version_number).
CREATE TABLE IF NOT EXISTS form_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id         uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  version_number  int NOT NULL,                                               -- monotonic per form, starts at 1
  schema          jsonb NOT NULL,                                             -- the FieldBase[] array
  is_draft        boolean NOT NULL DEFAULT true,
  published_at    timestamptz,                                                -- NULL while is_draft = true
  published_by    uuid,                                                       -- NULL while is_draft = true
  UNIQUE (form_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_form_versions_form_id ON form_versions (form_id);

-- Forward-ref FKs from forms → form_versions (couldn't be inlined above due to circular ref).
ALTER TABLE forms
  ADD CONSTRAINT forms_current_version_fk FOREIGN KEY (current_version_id) REFERENCES form_versions(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT forms_draft_version_fk   FOREIGN KEY (draft_version_id)   REFERENCES form_versions(id) DEFERRABLE INITIALLY DEFERRED;

-- 3. form_assets — in-form display images, uploaded once at form-build time.
--    R2 path convention: form-assets/{form_id}/{asset_id}.{ext}
CREATE TABLE IF NOT EXISTS form_assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id     uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  r2_key      text UNIQUE NOT NULL,
  mime        text NOT NULL,
  size_bytes  bigint NOT NULL,
  width       int,                                                            -- pixel width (extracted at upload)
  height      int,                                                            -- pixel height
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_form_assets_form_id ON form_assets (form_id);

-- 4. form_submissions — one row per submission. FK to form_versions.id (NOT forms.id)
--    so past submissions always render under the schema they were submitted against.
CREATE TABLE IF NOT EXISTS form_submissions (
  id                       uuid PRIMARY KEY,                                  -- pending_submission_id from client (Brief 92)
  form_id                  uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  form_version_id          uuid NOT NULL REFERENCES form_versions(id),
  payload                  jsonb NOT NULL,                                    -- keyed by field key per Decision 1
  submitter_kind           text NOT NULL CHECK (submitter_kind IN ('authenticated', 'anonymous')),
  submitter_user_id        uuid,                                              -- NULL when anonymous
  submitter_email          text,                                              -- NULL when anonymous; denormalized from session at submit time
  submitter_ip             text,                                              -- captured for both audiences; retention TBD
  submitted_at             timestamptz NOT NULL DEFAULT now(),
  status                   text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'closed')),
  status_updated_at        timestamptz,
  status_updated_by        uuid,
  splash_notes             text,                                              -- mirrors fleet Brief 87
  splash_notes_updated_at  timestamptz,
  splash_notes_updated_by  uuid
);
CREATE INDEX IF NOT EXISTS idx_form_submissions_form_id ON form_submissions (form_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_version_id ON form_submissions (form_version_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_submitted_at ON form_submissions (submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_submissions_status ON form_submissions (status);

-- 5. form_submission_files — per-submission file uploads + signatures.
--    R2 path convention: form-submission-files/{form_id}/{submission_id}/{field_key}/{filename}
--    Source of truth for retention/cleanup queries.
CREATE TABLE IF NOT EXISTS form_submission_files (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id       uuid NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
  field_key           text NOT NULL,
  r2_key              text UNIQUE NOT NULL,
  mime                text NOT NULL,
  size_bytes          bigint NOT NULL,
  original_filename   text,
  uploaded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_form_submission_files_submission_id ON form_submission_files (submission_id);
```

Notes:

- `gen_random_uuid()` requires the `pgcrypto` extension — already enabled on Splash's Supabase project (verified by other tables). If the operator hits "function does not exist" they should run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` first.
- `form_submissions.id` is NOT `DEFAULT gen_random_uuid()` because the client generates the UUID at form-load time (the `pending_submission_id` pattern from Decision 4 / Brief 92). The DB accepts whatever the client sent, and the `INSERT ... ON CONFLICT (id) DO NOTHING` shape (Decision 6) gives us submit idempotency for free.
- The two FKs on `forms` (`current_version_id`, `draft_version_id`) are `DEFERRABLE INITIALLY DEFERRED` so we can write `forms` and `form_versions` rows in either order within a transaction (Brief 94 needs this when creating a new form — the form row needs `draft_version_id`, but the form_version row needs `form_id`).
- No RLS policies declared. Worker code uses `SUPABASE_SERVICE_KEY` and is the only consumer; admin gate enforced at the worker layer (per Brief 83 / 87 precedent on fleet).

### Phase 2 — New worker `apps/forms-worker/`

**Directory:** `apps/forms-worker/` (NEW).

**File:** `apps/forms-worker/package.json` (NEW).

```json
{
  "name": "@splash/forms-worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "echo 'no lint yet'",
    "deploy": "wrangler deploy",
    "deploy:dry-run": "wrangler deploy --dry-run",
    "clean": "rm -rf dist .turbo .wrangler"
  },
  "dependencies": {
    "@splash/auth": "workspace:*",
    "@splash/db-supabase": "workspace:*",
    "@splash/forms-schema": "workspace:*",
    "@splash/http": "workspace:*",
    "@splash/storage-r2": "workspace:*",
    "@splash/types": "workspace:*"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250101.0",
    "@splash/config": "workspace:*",
    "typescript": "^5.6.0",
    "wrangler": "^3.90.0"
  }
}
```

(Mirror the version pins from `apps/fleet-inquiry-worker/package.json` if they differ — executor should compare; the dependency LIST is the load-bearing part, not the version specifiers.)

**File:** `apps/forms-worker/tsconfig.json` (NEW). Mirror the existing `apps/workorders-worker/tsconfig.json` shape — `strict: true`, `module: "esnext"`, `moduleResolution: "bundler"`, `lib: ["esnext"]`, `types: ["@cloudflare/workers-types"]`, `noEmit: true`. (Executor should read workorders-worker's actual file and copy its shape; don't invent.)

**File:** `apps/forms-worker/wrangler.toml` (NEW).

```toml
# Splash Forms Worker — Brief 89.
#
# Hosts the public form-render surface and the admin builder API for the
# form-builder feature. See Briefs 89–98 for the complete feature scope.
#
# DEPLOY STRATEGY: workers.dev only until cutover (CLAUDE.md constraint
# #6). Production routes (`splashcarwashes.info/forms/*`) stay commented.
# Staging route (Brief 16 pattern, path-carved) is bound below — single
# carve covers both public form pages (`/forms/{slug}`) and the admin
# JSON API (`/forms/admin/api/*`).
#
# Path-carve choice (planning Decision 2): chosen over subdomain for
# three reasons: (1) cookie domain works automatically — internal forms
# need apps/web's `sb-access-token` cookie to identify the submitter,
# and same-origin requires zero cookie-domain widening (CLAUDE.md
# constraint #6); (2) CSV exports stay simple — no Brief 88-style proxy
# route needed because direct same-origin downloads just work; (3) URL
# aesthetics are a wash. Fleet went subdomain (Brief 82) only because
# its verbatim-lifted JS had bare `/api/*` collisions with apps/web
# staging's `/api/login` / `/api/me`. This worker is greenfield — no
# such constraint, paths namespace cleanly under `/forms/*`.
#
# Bindings required (set via `pnpm --filter @splash/forms-worker exec
# wrangler secret put NAME` per CLAUDE.md):
#   SUPABASE_URL                     — non-secret var (in [vars] below).
#                                       Same Supabase project URL as
#                                       the rest of the monorepo.
#   SUPABASE_SERVICE_KEY             — secret. Service-key (NOT the
#                                       legacy `_SERVICE_ROLE_KEY`
#                                       name — see CLAUDE.md
#                                       constraint #3). Required for
#                                       form_versions / form_submissions
#                                       writes.
#   TURNSTILE_SITE_KEY               — non-secret var. Public-form
#                                       Turnstile widget. Same value
#                                       as fleet's binding. Optional
#                                       at v1 — public-audience forms
#                                       skip Turnstile silently when
#                                       unbound (matches fleet's
#                                       posture per CLAUDE.md).
#   TURNSTILE_SECRET_KEY             — secret. Optional in code.
#   FORMS_SUBMISSION_WEBHOOK_URL     — secret. Optional. POSTed on
#                                       every successful submission
#                                       when bound; payload includes
#                                       form metadata for PA routing
#                                       (planning Decision 6). Forms
#                                       opt out per-form via
#                                       `forms.notify_webhook = false`.

name = "splash-forms"
main = "src/index.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]
upload_source_maps = true

workers_dev = true

# Staging route — path-carved on apps/web's staging hostname. CF's
# most-specific-match-wins routing means this carve outranks apps/web's
# catch-all `staging.splashcarwashes.info/*`. Brief 16 pattern.
routes = [
  { pattern = "staging.splashcarwashes.info/forms/*", zone_name = "splashcarwashes.info" }
]

# Production routes stay commented until operator-driven cutover.
# routes = [
#   { pattern = "splashcarwashes.info/forms/*", zone_name = "splashcarwashes.info" }
# ]

[vars]
SUPABASE_URL       = "https://rewokyofschtvqgxrxwl.supabase.co"
TURNSTILE_SITE_KEY = "0x4AAAAAADBV7fdfR67Jt-ab"

# R2 bucket binding — owns both `form-assets/` and `form-submission-files/`
# namespaces. Single bucket, two prefixes (planning Decision 1's X-shape).
# Operator must create the bucket via `wrangler r2 bucket create
# splash-forms-files` before first deploy (or via the CF dashboard).
[[r2_buckets]]
binding     = "FORMS_FILES"
bucket_name = "splash-forms-files"

[limits]
cpu_ms = 30000

# Brief 63 — Workers Logs sticky across deploys.
[observability.logs]
enabled = true
invocation_logs = true

# Brief 89 — daily cleanup cron is wired in Brief 97 (orphan R2 objects).
# `[triggers] crons` block is intentionally absent here; Brief 97 will add
# it alongside the scheduled handler implementation. Worker exports a
# `fetch`-only default for now.
```

**File:** `apps/forms-worker/src/index.ts` (NEW). Skeleton — exports a `fetch` handler that returns a 404 explanatory body for any path. Subsequent briefs add real routes.

```ts
// Splash Forms Worker — Brief 89 scaffolding.
//
// This file intentionally returns 404 for every path. Brief 90 adds
// `GET /forms/{slug}` (public render). Brief 91 adds
// `POST /forms/api/submit/{slug}` (public submission). Briefs 92–94 add
// the upload, lookup, and admin API surfaces. See planning conversation
// 2026-05-09 + the per-brief Architecture context blocks for the full
// architecture.

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  FORMS_SUBMISSION_WEBHOOK_URL?: string;
  FORMS_FILES: R2Bucket;
}

export default {
  async fetch(_req: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response(
      "splash-forms: scaffolding only (Brief 89). Endpoints land in Briefs 90+.",
      { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }
};
```

The `Env` interface is the contract every subsequent brief in this feature reads from; future briefs may extend it (e.g., Brief 92 doesn't need new bindings, but if Brief 93's lookup helper takes a session-bound Supabase client, the Env shape stays unchanged because `SUPABASE_SERVICE_KEY` already covers it).

### Phase 3 — New shared package `packages/forms-schema/`

**Directory:** `packages/forms-schema/` (NEW).

**File:** `packages/forms-schema/package.json` (NEW). Mirror `packages/http/package.json` shape exactly, swap the name. **Add `zod` as a runtime dep** — this is a new dependency for the monorepo (verify by grepping `packages/*/package.json` for `"zod"` — if it's absent, this is the first introduction and `pnpm install` is required).

```json
{
  "name": "@splash/forms-schema",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "echo 'no lint yet'",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@splash/config": "workspace:*",
    "typescript": "^5.6.0"
  }
}
```

**File:** `packages/forms-schema/tsconfig.json` (NEW). Mirror `packages/http/tsconfig.json`.

**File:** `packages/forms-schema/src/index.ts` (NEW).

```ts
// @splash/forms-schema — shared schema contract for the form-builder feature.
//
// Both apps/web (builder, React) and `splash-forms` (public renderer,
// server-rendered HTML + per-field-type vanilla JS) consume this package.
// Two renderers, one schema contract — this package prevents drift between
// preview and production.
//
// Brief 89 (this brief) lays down the type skeleton + LOOKUP_SOURCES const +
// stub Zod validators. Subsequent briefs extend per-field-type validation:
//   Brief 90 — adds runtime Zod for the 14 field types' render-time validation.
//   Brief 91 — adds payload-validation Zod for submit-time enforcement.
//   Brief 93 — adds the lookup-source-aware schemas.
//
// Field types per planning Decision 4 + refinements (14 total):
//   name, email, phone, short_text, long_text, heading, dropdown, multi,
//   image, file, date, time, signature, lookup, location, hidden
// (16 strings; "image" + "heading" are display-only and produce no payload;
//  "lookup" + "location" + "hidden" were added in planning conversation
//  refinements to the original 12 — see Architecture context above.)

export * from "./types";
export * from "./lookup-sources";
export * from "./validators";
```

**File:** `packages/forms-schema/src/types.ts` (NEW). The discriminated-union `Field` type + `FormSchema` + `FormVersion` + supporting interfaces. Skeleton only — actual per-field-type config interfaces extend the base in subsequent briefs.

```ts
// Field type discriminator. Order intentional — display-only types last.
export type FieldType =
  | "name"
  | "email"
  | "phone"
  | "short_text"
  | "long_text"
  | "dropdown"
  | "multi"
  | "file"
  | "date"
  | "time"
  | "signature"
  | "lookup"
  | "location"
  | "hidden"
  | "heading"      // display-only, no payload
  | "image";       // display-only, no payload

// Common base every field type extends.
export interface FieldBase {
  id: string;          // UUID, stable for the field's lifetime within draft
  type: FieldType;
  key: string;         // stable slug, operator-editable, snake_case, unique within form
  label: string;
  required: boolean;   // ignored on display-only types (heading, image)
  helpText?: string;
}

// Specific field types extend FieldBase. Brief 90 fills these in;
// for Brief 89 we declare the type alias as `FieldBase` so apps/web
// and splash-forms can import the shape without per-type detail yet.
export type Field = FieldBase;

// Form schema = ordered list of fields. Order is implicit (array index).
export interface FormSchema {
  fields: Field[];
}

export interface FormVersion {
  id: string;
  formId: string;
  versionNumber: number;
  schema: FormSchema;
  isDraft: boolean;
  publishedAt: string | null;
  publishedBy: string | null;
}

export interface FormMeta {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
  status: "draft" | "published" | "archived";
  currentVersionId: string | null;
  draftVersionId: string | null;
  notifyWebhook: boolean;
  successMessage: string | null;
  turnstileRequired: boolean;
}

// Submission payload is keyed by field.key. Per-field value shape varies
// by field type (string for text fields, string[] for multi, object for
// file/signature, etc. — Brief 91 narrows these via Zod).
export type SubmissionPayload = Record<string, unknown>;

export interface FormSubmission {
  id: string;
  formId: string;
  formVersionId: string;
  payload: SubmissionPayload;
  submitterKind: "authenticated" | "anonymous";
  submitterUserId: string | null;
  submitterEmail: string | null;
  submitterIp: string | null;
  submittedAt: string;
  status: "new" | "in_progress" | "closed";
  splashNotes: string | null;
}
```

**File:** `packages/forms-schema/src/lookup-sources.ts` (NEW). Hardcoded source registry per Decision 5c. Friendly labels per the Brief 59 Regional Director / Regional Manager precedent.

```ts
// LOOKUP_SOURCES — the registry of columns operators can configure as
// the source of a Lookup field's resolved value. Hardcoded (NOT
// information_schema-derived) per planning Decision 5c so we control:
//   1. exclusion of system fields (id, created_at, internal join keys)
//   2. exclusion of columns that don't make sense as form-builder lookups
//      (mla_location boolean, etc.)
//   3. labels matching operator vocabulary, not column vocabulary —
//      `am_email` is "Regional Director email" per the Brief 59 RD/RM
//      label convention; `rm_email` is "Regional Manager email"; column
//      names stay as-is because trg_sync_pricing_simple +
//      trg_sync_user_permissions depend on them.
//
// Per planning Decision 5 (corrected): the keyColumn is configurable —
// operators can join on `pricing_simple.location_code` (slug) OR
// `pricing_simple.site` (3-digit text, equivalent to
// `locations.site_number`). The resolver helper hides the two-hop join
// when the source table is `locations`.
//
// `column` is the literal Postgres column name (kept verbatim so SQL
// resolution doesn't need a column-name translation table).
// `label` is what operators see in the inspector dropdown.
// `description` (optional) shows as inspector hint text.

export interface LookupSource {
  table: "pricing_simple" | "locations";
  column: string;
  label: string;
  description?: string;
  type: "string" | "boolean";
}

export const LOOKUP_SOURCES: readonly LookupSource[] = [
  // pricing_simple
  { table: "pricing_simple", column: "location_pretty",  label: "Location display name",            type: "string" },
  { table: "pricing_simple", column: "site",             label: "Location name (e.g. \"Oswego\")",  type: "string" },
  { table: "pricing_simple", column: "address",          label: "Location postal address",          type: "string" },
  { table: "pricing_simple", column: "am_email",         label: "Regional Director email",          type: "string", description: "Per Brief 59 label convention; column name remains am_email." },
  { table: "pricing_simple", column: "rm_email",         label: "Regional Manager email",           type: "string", description: "Per Brief 59 label convention; column name remains rm_email." },
  { table: "pricing_simple", column: "site_email",       label: "Site contact email",               type: "string" },
  { table: "pricing_simple", column: "area_manager",     label: "Regional Director name",           type: "string", description: "Per Brief 59 label convention." },
  { table: "pricing_simple", column: "regional_manager", label: "Regional Manager name",            type: "string", description: "Per Brief 59 label convention." },
  // locations (joined via pricing_simple.location_code → pricing_simple.site → locations.site_number)
  { table: "locations",      column: "hrt_email",        label: "HRT email",                        type: "string" },
  { table: "locations",      column: "rm_group",         label: "RM group",                         type: "string" },
  { table: "locations",      column: "mla_location",     label: "MLA location flag",                type: "boolean" }
] as const;

// keyColumn options — operator picks which DB column to join on.
// `pricing_simple.site` and `locations.site_number` are the same value
// (3-digit string text), so operators can use either depending on which
// table they're sourcing from. `pricing_simple.location_code` is the
// canonical slug (e.g. "oswego").
export type LookupKeyColumn =
  | "pricing_simple.location_code"
  | "pricing_simple.site";       // = locations.site_number
```

**File:** `packages/forms-schema/src/validators/index.ts` (NEW). Stub — actual Zod validators land in Brief 90/91. Brief 89 just declares the file so subsequent briefs extend it.

```ts
// Per-field-type Zod validators. Brief 89 stub — Brief 90 (public render)
// fills in render-time validators; Brief 91 (public submit) fills in
// submit-time payload validators. This file's existence in Brief 89 lets
// `import { ... } from "@splash/forms-schema/validators"` typecheck even
// before the per-field validators land, so dependent files in subsequent
// briefs don't need to dance around the missing module.

export {};
```

### Phase 4 — Service binding from apps/web

**File:** `apps/web/wrangler.toml`. Append a new `[[services]]` entry below the existing `FLEET_INQUIRY_WORKER` block (line ~80):

```toml
# Brief 89 — forms-worker (form-builder feature). Worker name on
# Cloudflare: `splash-forms`. Path-carved on apps/web's hostname per
# planning Decision 2 (cookie + CSV simplicity). apps/web's admin
# pages (/admin/forms/*) call this worker via the binding for SSR;
# the public form pages (/forms/{slug}) are served directly by the
# worker via the path-carved staging/production route — no apps/web
# involvement on the public surface.
[[services]]
binding = "FORMS_WORKER"
service = "splash-forms"
```

**File:** `apps/web/cloudflare-env.d.ts`. Append the `FORMS_WORKER` declaration to the global `CloudflareEnv` interface — match the shape used for the existing 7 bindings (executor should grep the file for `FLEET_INQUIRY_WORKER` to find the pattern, then add `FORMS_WORKER: Service;` or the equivalent; type alias varies by what the file already uses).

### Phase 5 — Lookup resolver helper STUB in @splash/db-supabase

**File:** `packages/db-supabase/src/lookup.ts` (NEW). Brief 89 lands the stub signature only; real implementation in Brief 93. The stub exists so Brief 94 (admin API CRUD) can import the helper without forward-dep churn.

```ts
// Lookup resolver — single source of truth for resolving a Lookup field's
// value given a key. Used by both `splash-forms` (`POST /forms/api/lookup/{slug}`
// at render time, plus the submit-time re-resolve in
// `POST /forms/api/submit/{slug}`) and the admin API (`/forms/admin/api/forms/{id}`
// preview rendering).
//
// Brief 89 — stub only. Returns null + logs a warning. Brief 93 implements
// the real resolution: dispatches on sourceTable, handles the
// pricing_simple → locations two-hop transparently when sourceTable is
// `locations`, returns a string representation of the column value.

import type { LookupSource, LookupKeyColumn } from "@splash/forms-schema";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ResolveLookupArgs {
  client: SupabaseClient;
  source: LookupSource;
  keyColumn: LookupKeyColumn;
  keyValue: string;
}

export async function resolveLookup(_args: ResolveLookupArgs): Promise<string | null> {
  console.warn("[forms] resolveLookup stub called (Brief 89). Real implementation in Brief 93.");
  return null;
}
```

**File:** `packages/db-supabase/src/index.ts`. Append the export:

```ts
export * from "./lookup";
```

(Executor should verify the file uses re-export style; if it uses named exports, mirror that.)

### Phase 6 — Documentation

**File:** `PRE_DEPLOY_FORMS.md` (NEW, root of repo). Scaffolding doc — sections will be filled in by subsequent briefs. Initial structure:

```markdown
# PRE_DEPLOY_FORMS.md

Pre-deploy notes for `splash-forms` (Brief 89 onward). Mirrors the
shape of PRE_DEPLOY_FLEET.md.

## 1. Worker overview

`splash-forms` is the form-builder feature's runtime — owns public form
rendering (`/forms/{slug}`), public submission (`/forms/api/submit/{slug}`),
file uploads (`/forms/api/upload/{slug}`), lookup resolution
(`/forms/api/lookup/{slug}`), and the admin builder API
(`/forms/admin/api/*`). Path-carved on apps/web's hostname (planning
Decision 2). See Briefs 89–98 for the per-surface implementation
breakdown.

## 2. Bindings

(Filled in incrementally by subsequent briefs as bindings get added.
Brief 89 lands `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` + Turnstile
keys + `FORMS_SUBMISSION_WEBHOOK_URL` + the `FORMS_FILES` R2 bucket.)

## 3. Schema

5 Supabase tables added in Brief 89:
  - forms
  - form_versions
  - form_assets
  - form_submissions
  - form_submission_files

Operator runs `supabase/forms-tables.sql` in the Supabase SQL editor
before queueing Brief 90.

## 4. Cutover plan

(Brief 98 fills this in.)

## 5. Smoke tests

(Each brief 90–98 appends its own smoke test scenarios.)
```

**File:** `CLAUDE.md`. Two updates:

1. Append a new entry to the "Critical constraints" list — constraint #10 — flagging the form-builder feature's posture:

   > **10. The `forms` / `form_versions` / `form_assets` / `form_submissions` / `form_submission_files` tables are owned by `splash-forms` worker (Briefs 89–98).** Manual SQL edits to these tables are allowed only via the operator's Supabase SQL editor (no migration framework in this repo). Direct edits to `form_versions.schema` (the published schema JSONB) outside of the Brief 95 admin builder will diverge the live form from what the builder shows; if you need to hand-edit a schema, do it via the builder's draft-then-publish flow instead. Past submissions reference `form_versions.id` directly, so editing a published schema row also rewrites history for existing submissions — don't.

2. Append a new entry to the "Working with workers" / glossary section:

   > **forms-worker** (Brief 89) — Public form-render surface + admin builder API for the form-builder feature. The eighth worker in the monorepo. Path-carved on `splashcarwashes.info/forms/*` (planning Decision 2 — chosen over subdomain for cookie + CSV simplicity; fleet's subdomain choice in Brief 82 was specific to its verbatim-lifted `/api/*` collisions). Worker name on Cloudflare: `splash-forms`. Bindings: `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (writes to forms tables — service key required); `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` (public-audience forms only); `FORMS_SUBMISSION_WEBHOOK_URL` (PA notification, fail-soft when unbound); `FORMS_FILES` R2 bucket (`splash-forms-files` — owns both `form-assets/` and `form-submission-files/` namespaces). Service binding `FORMS_WORKER` from apps/web. Brief 97 wires the daily cleanup cron (orphan R2 objects, 11:00 UTC — picked to not collide with damage 13:00 / workorders 11:30). The `[observability.logs]` block from Brief 63 is included from day one.

**File:** `BUILD_STATE.md`. Bump "Last updated" + add a Findings entry summarizing Brief 89's scope (substrate only — schema + worker skeleton + package + binding + helper stub; no endpoints or UI yet). Add Brief 89 to the prioritized work list (status `not started` until execution; flips to `completed` on completion). Add Briefs 90–98 to the prioritized work list with status `not started`, dependencies pointing back to Brief 89 (or to whichever earlier brief in the chain blocks them).

**File:** `BRIEFS/INDEX.md`. Append a Brief 89 row.

### Phase 7 — Validation

```sh
pnpm install                                                      # picks up new packages/forms-schema + apps/forms-worker
pnpm --filter @splash/forms-schema typecheck                     # green
pnpm --filter @splash/forms-worker typecheck                     # green
pnpm --filter @splash/db-supabase typecheck                      # green (new lookup.ts stub)
pnpm --filter @splash/web typecheck                              # green (new FORMS_WORKER binding declaration)
pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run  # green; check bundle size
pnpm typecheck                                                    # root green (all packages)
```

Smoke test (deferred to operator post-deploy; this brief is non-deployable on its own and the operator will just deploy it as part of the Brief 90 cycle):

1. `wrangler deploy` for `splash-forms` succeeds; worker shows up in CF dashboard.
2. Hit any path on the workers.dev URL — returns the 404 stub message.
3. R2 bucket `splash-forms-files` exists (operator may need to create it via `wrangler r2 bucket create splash-forms-files` or the CF dashboard before first deploy).
4. Run the SQL in `supabase/forms-tables.sql` — five tables created; `\d forms` etc. show the expected columns.
5. apps/web service binding test deferred — no apps/web pages call `FORMS_WORKER` until Brief 94+.

## Configuration

New environment-level config introduced by this brief (none take effect until subsequent briefs consume them, but the bindings are declared so future briefs don't have to wire them):

| Binding                          | Type   | Owner       | Required for                                      |
|----------------------------------|--------|-------------|---------------------------------------------------|
| `SUPABASE_URL`                   | var    | splash-forms | All forms-worker DB reads/writes                  |
| `SUPABASE_SERVICE_KEY`           | secret | splash-forms | Form CRUD + submission writes                     |
| `TURNSTILE_SITE_KEY`             | var    | splash-forms | Public-audience form rendering (Brief 90)         |
| `TURNSTILE_SECRET_KEY`           | secret | splash-forms | Public-audience submission verification (Brief 91) |
| `FORMS_SUBMISSION_WEBHOOK_URL`   | secret | splash-forms | Optional PA notifications (Brief 97)              |
| `FORMS_FILES` (R2 bucket)        | binding | splash-forms | File + signature uploads (Brief 92), assets       |
| `FORMS_WORKER` (service binding) | binding | apps/web    | apps/web → splash-forms SSR calls (Brief 94+)     |

Operator must, before queueing Brief 90:

1. Run `supabase/forms-tables.sql` in Supabase SQL editor.
2. Create R2 bucket: `wrangler r2 bucket create splash-forms-files` (or CF dashboard equivalent).
3. Bind secrets:
   ```sh
   pnpm --filter @splash/forms-worker exec wrangler secret put SUPABASE_SERVICE_KEY
   # (Turnstile + webhook secrets can wait until Briefs 90 / 97 — they're optional in code.)
   ```

## Out of scope

- Any worker endpoint beyond the 404 stub. Brief 90 adds `GET /forms/{slug}`; Brief 91 adds submit; etc.
- The lookup resolver's real implementation. Brief 93 implements; this brief only lands the stub signature.
- Admin builder UI (`/admin/forms/*`) — Brief 95.
- Submissions admin UI — Brief 96.
- Daily cleanup cron — Brief 97.
- Webhook integration — Brief 97.
- The dashboard tile on `/admin/dashboard` (links to `/admin/forms`) — Brief 98 (polish).
- The `<FormsAdminTabs>` component referenced in planning Decision 7 — Brief 95.
- Per-field-type Zod validators — Briefs 90 / 91.
- Don't deploy to Cloudflare automatically — operator deploys via push when ready.
- Don't bind production routes — staging only, per CLAUDE.md constraint #6.
- Don't add this brief to QUEUE.md until the operator decides to start execution.
- Don't commit to git or push.

## Definition of done

- `supabase/forms-tables.sql` exists at the repo root with the five-table schema.
- `apps/forms-worker/` directory exists with `package.json`, `tsconfig.json`, `wrangler.toml`, `src/index.ts`. The worker boots and returns the 404 stub.
- `packages/forms-schema/` directory exists with `package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`, `src/lookup-sources.ts`, `src/validators/index.ts`.
- `apps/web/wrangler.toml` has the new `[[services]]` entry for `FORMS_WORKER`.
- `apps/web/cloudflare-env.d.ts` declares `FORMS_WORKER` on the `CloudflareEnv` interface (or whatever shape that file uses today).
- `packages/db-supabase/src/lookup.ts` exists with the `resolveLookup` stub.
- `packages/db-supabase/src/index.ts` re-exports the new lookup module.
- `PRE_DEPLOY_FORMS.md` exists at repo root with the scaffolding sections.
- `CLAUDE.md` has new constraint #10 and the new forms-worker glossary entry.
- `BUILD_STATE.md` has the new Findings entry + prioritized work list rows for Briefs 89–98.
- `BRIEFS/INDEX.md` has the Brief 89 row.
- `pnpm typecheck` passes (all packages green).
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run` succeeds.
- `zod` appears in `packages/forms-schema/package.json` and is the only new monorepo-wide runtime dep.
- This brief's `Status:` flips to `Completed (YYYY-MM-DD)`.

## Report

Surface in the Outcome section:

- **Decisions made on the operator's behalf.** Anything the brief left underspecified (e.g., which exact `[limits]` value to use, which version pin for `zod`, what package version conventions to follow if `apps/fleet-inquiry-worker/package.json` and `apps/workorders-worker/package.json` differ).
- **Anything surprising in the existing codebase.** Particularly: does `packages/db-supabase` already have a `SupabaseClient` import shape that conflicts with the stub? Does `cloudflare-env.d.ts` use a different Service-binding type alias than expected?
- **`pgcrypto` extension status.** Did the operator confirm it's already enabled, or did the SQL need a `CREATE EXTENSION` prefix?
- **R2 bucket creation.** Did the operator pre-create `splash-forms-files`, or does the executor flag this as a pre-deploy operator step?
- **Latent issues addressed.** Anything that came up while wiring the binding or new package that needed a quick fix in passing.
- **Prep work surfaced for future briefs.** E.g., if Brief 90 will need a new module the executor noticed should be scaffolded earlier.

## Outcome

### Files created

- `supabase/forms-tables.sql` — five-table schema (`forms`, `form_versions`, `form_assets`, `form_submissions`, `form_submission_files`) with deferrable forward-ref FKs from `forms` to `form_versions`, indexes, CHECK constraints, R2-path conventions documented inline. First file in a new `supabase/` repo directory.
- `apps/forms-worker/package.json` — `@splash/forms-worker`, workspace deps (auth/db-supabase/forms-schema/http/storage-r2/types), wrangler ^4.86.0, typescript ^5.6.0, @cloudflare/workers-types ^4.20250101.0.
- `apps/forms-worker/tsconfig.json` — extends `@splash/config/tsconfig.worker.json`.
- `apps/forms-worker/wrangler.toml` — `splash-forms`, staging route `staging.splashcarwashes.info/forms/*` zone-bound, production routes commented; FORMS_FILES R2 binding to `splash-forms-files`; `[observability.logs]` block; `[limits] cpu_ms = 30000`; comment block documents path-carve rationale per planning Decision 2.
- `apps/forms-worker/src/index.ts` — 404 stub returning the explanatory message, with `Env` interface declared so subsequent briefs extend without rewriting (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, optional Turnstile + webhook secrets, `FORMS_FILES: R2Bucket`).
- `packages/forms-schema/package.json` — `@splash/forms-schema`, runtime dep `zod ^3.23.8` (first introduction of zod into the monorepo).
- `packages/forms-schema/tsconfig.json` — mirrors `packages/http`.
- `packages/forms-schema/src/index.ts` — re-exports types/lookup-sources/validators.
- `packages/forms-schema/src/types.ts` — 16 FieldType strings; `FieldBase`/`Field`/`FormSchema`/`FormVersion`/`FormMeta`/`SubmissionPayload`/`FormSubmission` interfaces.
- `packages/forms-schema/src/lookup-sources.ts` — `LOOKUP_SOURCES` const (8 pricing_simple + 3 locations columns, Brief 59 RD/RM label convention) + `LookupKeyColumn` union.
- `packages/forms-schema/src/validators/index.ts` — stub `export {};`.
- `packages/db-supabase/src/lookup.ts` — `resolveLookup` stub (returns null + console.warn) and `ResolveLookupArgs` interface.
- `PRE_DEPLOY_FORMS.md` — scaffolded with five sections (overview / bindings / schema / cutover / smoke tests).

### Files modified

- `apps/web/wrangler.toml` — appended `[[services]]` block for FORMS_WORKER → splash-forms (eighth binding).
- `apps/web/cloudflare-env.d.ts` — added `FORMS_WORKER: Fetcher` to the `CloudflareEnv` interface.
- `packages/db-supabase/src/index.ts` — appended `export * from "./lookup.js";`.
- `packages/db-supabase/package.json` — added `@splash/forms-schema: workspace:*` runtime dep so the new `lookup.ts` import resolves.
- `CLAUDE.md` — appended constraint #10 (forms tables ownership posture; no migration framework; direct schema-JSONB edits rewrite history) and a glossary entry for `forms-worker` with the path-carve rationale, full bindings inventory, Brief 97 cron forward-flag, and observability block note.
- `BUILD_STATE.md` — bumped Last-updated parenthetical with the Brief 89 narrative; added a new `Open work — prioritized` row 89; added a Findings & decisions log entry.
- `BRIEFS/INDEX.md` — appended a Brief 89 row.

### Decisions made on the operator's behalf

1. **Wrangler version pinned `^4.86.0`** matching workorders-worker (and fleet's `^4.86.0`) rather than the brief-sample's `^3.90.0`. The brief explicitly authorized matching the existing workers.
2. **Vitest dev-dep deliberately omitted from forms-worker** — workorders' shape; fleet has it but no tests yet here. Left for the brief that adds the first vitest case to also add the dev-dep.
3. **`dev` script added to forms-worker `package.json`** — brief sample omitted it but every other worker has one; preserved consistency.
4. **`tsconfig.json` shape mirrors workorders-worker** (two-line `extends` form against `@splash/config/tsconfig.worker.json`) rather than the brief's longer prose-described shape — the shared config already encodes strict/esnext/bundler/lib/types/noEmit.
5. **No `worker-configuration.d.ts`** — workorders-worker references one in its `include`, but no such file exists there; not creating an empty placeholder for forms-worker.
6. **`@splash/forms-schema` keeps `@cloudflare/workers-types` in devDeps** mirroring `packages/http`, even though the package is runtime-neutral. Kept for shape consistency.
7. **Re-exports in `packages/forms-schema/src/index.ts` use `.js` extensions** (matches `db-supabase` ESM/bundler convention).
8. **Did NOT pre-create the R2 bucket `splash-forms-files`** — that's the operator's pre-deploy step flagged in PRE_DEPLOY_FORMS.md. `wrangler deploy --dry-run` validates the binding declaration regardless.
9. **Briefs 90–98 NOT pre-populated** as separate prioritized-work-list rows ahead of their drafts. Brief 89's row is added; subsequent briefs added when drafted.
10. **`cloudflare-env.d.ts` uses `Fetcher`** (matches the existing seven bindings) — that's the right type for a service binding even though the brief sample mentioned "Service" generically.
11. **`packages/db-supabase/package.json` gains `@splash/forms-schema` as a dep** in lockstep with the new `lookup.ts` import; the brief implicitly required this since `lookup.ts` imports `LookupSource` / `LookupKeyColumn` types from the schema package.

### Latent issues found

1. **zod is a new monorepo runtime dep.** First time it shows up in any `package.json`; verified by grep across all `package.json` files. Lockfile updated by `pnpm install`.
2. **`packages/forms-schema/src/validators/index.ts` is a stub.** Brief 90 must extend, not replace, this file when adding the per-field-type Zod, otherwise `src/index.ts`'s re-export will surface stale references.
3. **Operator pre-deploy steps before Brief 90 can run:** (a) execute `supabase/forms-tables.sql` in Supabase SQL editor; (b) `wrangler r2 bucket create splash-forms-files`; (c) `pnpm --filter @splash/forms-worker exec wrangler secret put SUPABASE_SERVICE_KEY`. Turnstile + webhook secrets can wait until Briefs 90 / 97 — optional in code.

### `pgcrypto` extension status

Header callout in `supabase/forms-tables.sql` reminds the operator to run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` if `gen_random_uuid()` errors out. Per CLAUDE.md, the project's other tables already use the function so the extension is expected to be enabled, but the safety net is documented inline rather than left to discovery.

### R2 bucket creation

NOT pre-created by this brief. `wrangler r2 bucket create splash-forms-files` is a documented operator pre-deploy step (PRE_DEPLOY_FORMS.md placeholder + brief Configuration section). `wrangler deploy --dry-run` validates the binding declaration regardless of whether the bucket exists.

### Validation results

| Step | Result |
|---|---|
| `pnpm install` | success — lockfile updated for new packages and zod runtime dep |
| `pnpm --filter @splash/forms-schema typecheck` | green |
| `pnpm --filter @splash/forms-worker typecheck` | green |
| `pnpm --filter @splash/db-supabase typecheck` | green (new lookup.ts stub) |
| `pnpm --filter @splash/web typecheck` | green (new FORMS_WORKER binding declaration) |
| `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run` | green — Total Upload: 0.34 KiB / gzip 0.26 KiB. Bindings resolved: FORMS_FILES R2 bucket, SUPABASE_URL var, TURNSTILE_SITE_KEY var |
| `pnpm typecheck` (root) | green — 17/17 packages successful, 0 cached |

### Schema run confirmation

NOT executed by this brief — the schema file is checked in and the operator runs it via Supabase SQL editor. Brief 90 prerequisite.

### Prep work surfaced for future briefs

- Brief 90 will need to extend (not replace) `packages/forms-schema/src/validators/index.ts` and likely add per-field-type files alongside it.
- Brief 90's worker-side route handlers will sit in `apps/forms-worker/src/` alongside the existing `index.ts`. The `Env` interface declared in this brief should be importable; if Brief 90's modules need their own narrower env subsets they can extend it.
- Brief 91's `INSERT ... ON CONFLICT (id) DO NOTHING` shape (planning Decision 6) is enabled by `form_submissions.id` being client-supplied (no `DEFAULT gen_random_uuid()`); SQL comment block documents this so the next executor doesn't "fix" the missing default.
- Brief 92's R2 path conventions are documented inline next to each table's CREATE statement (`form-assets/{form_id}/{asset_id}.{ext}`, `form-submission-files/{form_id}/{submission_id}/{field_key}/{filename}`) — future executors won't need to recover them from conversation history.
- Brief 94's transactional create-form path benefits from the `DEFERRABLE INITIALLY DEFERRED` FKs on `forms.current_version_id` / `forms.draft_version_id`; SQL comment notes this so a future "tighten the FKs" change doesn't accidentally remove the affordance.
