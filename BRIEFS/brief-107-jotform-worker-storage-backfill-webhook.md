# Brief 107: JotForm submissions — new worker, Supabase storage, backfill, webhook receiver, admin read API + CSV

**Status:** Completed (2026-05-11)
**Started:** 2026-05-11
**Completed:** 2026-05-11
**Blocks:** Brief 108 (apps/web JotForm viewer pages) depends on
this brief's read API + CSV endpoint shape.
**Dependencies:** Brief 81 (`splash-fleet-inquiry` shape this brief
patterns after — admin auth gate + worker layout), Brief 83 (admin
GET endpoints + `pricing_simple`-based permission gate this brief
reuses), Brief 105 (the JS-worker conventions used here — no TS for
this worker; operator confirmed "moving away from JotForm" so
investment in a richer TS scaffold isn't warranted).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-081-fleet-inquiry-worker-lift-and-shift.md (the
  worker shape this brief mirrors — new app under apps/, JS not TS,
  admin gate via `@splash/auth`)
- BRIEFS/brief-083-fleet-submissions-admin-viewer.md (the
  `pricing_simple`-based permission gate this brief reuses verbatim
  — RM/RD/Location email gate)
- BRIEFS/brief-105-fleet-submissions-status-editor-and-update-webhook.md
  (the JS-worker admin endpoint conventions —
  `authenticateAdmin`, `jsonError`, `parseDateRange`, the PostgREST
  patterns)
- packages/db-supabase/src/locations.ts (`getLocationsByContactEmail`
  — already returns location set keyed by `site_number`; that's the
  exact join axis this brief needs)
- packages/auth/src/* (the session shape and admin gate this brief
  consumes)
- packages/http/src/* (`jsonError`, `isOriginAllowed`)

## Context

Operator wants a viewer in apps/web for JotForm submissions across
four forms (and possibly two more, but no further integrations
after that — confirmed). The four forms:

| Slug | JotForm form_id | Display name |
|------|-----------------|--------------|
| `rewash` | `250165655616055` | Rewash |
| `salt-log` | `243523811897060` | Salt Log |
| `retention` | `250855287972067` | Retention |
| `time-card-edit` | `250193775451056` | Time Card Edit |

**Total submission volume across history: ~30K for rewash, lower
for the other three. Total approx 50K rows lifetime.** Comfortable
for one Supabase table with reasonable indexing.

**Architecture decision: Supabase-as-source-of-truth** (not direct
JotForm API per query). Three reasons:

1. **Filtering on answer fields is the dominant use case.** JotForm's
   filter API only supports top-level (`created_at`, `id`,
   `workflowStatus`, `status`). Anything below — site, employee,
   reason — would require pulling every row and filtering client-side.
2. **Aggregates / counts / CSV ranges** are SQL territory, not API
   territory.
3. **Same pattern operator already uses** (fleet, signups, damage,
   workorders) — Supabase mirror + read-only worker + apps/web viewer.

**Architecture decision: single table, common fields promoted to
columns, rest in `answers` JSONB.** Looking at all four sample
payloads, the common fields are identical across forms:

- `id`, `form_id`, `jotform_status`, `created_at`, `updated_at` (top-level)
- `site_number`, `site`, `site_email` (consistent in `answers` across forms)

Per-form filters (RM/RD/Location/date range — operator-confirmed)
key off these common columns, NOT on form-specific answer fields.
So we DON'T need per-form generated columns. Form-specific rendering
(e.g., "pounds of ice melt") happens in apps/web JSX reading
`answers` directly.

**Architecture decision: read-only v1.** Operator confirmed no
`splash_status` / `splash_notes` workflow for v1 — they lean toward
moving away from JotForm rather than building richer integrations.
Skip those columns; add later if needed.

**Sync mechanism: webhook + one-time backfill.**
- Backfill: admin endpoint paginates JotForm API per form_id, upserts.
  Operator runs once per form during onboarding.
- Webhook: JotForm POSTs to `/jotform/webhook/{token}/{form_id}` on
  every new submission. Worker validates token, fetches full
  submission via API (richer shape than webhook's flat encoding),
  upserts.

**JotForm webhook auth.** JotForm Enterprise webhook UI provides
only a URL field (no signing secret per the operator's confirmation).
We rely on **URL secrecy**: a random token in the URL path that
must match the worker's `JOTFORM_WEBHOOK_TOKEN` secret. Operator
binds the secret, then configures JotForm to POST to a URL
containing that token. Anyone who doesn't have the token gets 403.

**Noise stripping at ingest.** JotForm responses include
`control_head`, `control_pagebreak`, `control_button`, `control_text`
entries that have no `answer` property — they're form definition
metadata (headings, dialog scripts, page breaks). Strip these
before storing to keep `answers` payloads compact. Retention's full
payload is ~20KB raw; stripped should be ~3-5KB.

**Permission gate.** Same as Brief 83's fleet admin: super_admin
and admin see all; RM sees locations where their email is `rm_email`
on `pricing_simple`; RD sees `am_email`; GM sees `site_email`.
JotForm submissions carry `site_number` directly in answers; map to
`pricing_simple.site_number` to apply the gate. The
`getLocationsByContactEmail` helper from
`packages/db-supabase/src/locations.ts` returns the set; the worker
intersects.

**No CSV export beyond v1.** Operator asked for CSV; no PDF needed
for these four forms. CSV per form, with date range + same filter
params as the list view.

## Scope

### Phase 1 — Supabase schema (operator runs SQL once)

```sql
-- Per-form metadata (slug, display name, enabled flag).
CREATE TABLE jotform_forms (
  form_id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO jotform_forms (form_id, slug, display_name) VALUES
  ('250165655616055', 'rewash',         'Rewash'),
  ('243523811897060', 'salt-log',       'Salt Log'),
  ('250855287972067', 'retention',      'Retention'),
  ('250193775451056', 'time-card-edit', 'Time Card Edit');

-- Submissions: common filterable fields promoted; rest in JSONB.
CREATE TABLE jotform_submissions (
  id text PRIMARY KEY,
  form_id text NOT NULL REFERENCES jotform_forms(form_id),
  site_number text,
  site text,
  site_email text,
  jotform_created_at timestamptz NOT NULL,
  jotform_updated_at timestamptz,
  jotform_status text,
  answers jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jotform_subs_form_created ON jotform_submissions (form_id, jotform_created_at DESC);
CREATE INDEX jotform_subs_form_site ON jotform_submissions (form_id, site_number);
```

The brief executor flags this in the outcome — operator pastes
into the Supabase SQL Editor before the worker can do anything
useful.

### Phase 2 — New worker `apps/jotform-worker`

Mirror the layout of `apps/fleet-inquiry-worker` (JS, not TS — same
posture per Brief 81). Worker name on Cloudflare:
`splash-jotform`. Path-carved on
`splashcarwashes.info/jotform/*` + `/admin/jotform/api/*` (the
admin paths route alongside the public webhook).

2.1 `apps/jotform-worker/wrangler.toml`:
- Worker name: `splash-jotform`
- Main: `src/index.js`
- `[observability.logs] enabled = true / invocation_logs = true`
  (Brief 63 convention)
- `[vars]`:
  - `SUPABASE_URL` (mirrors fleet-inquiry)
  - `JOTFORM_BASE_URL = "https://splashcarwashes.jotform.com"`
    (Enterprise base — confirmed by operator)
- Comment block documenting secrets to bind out-of-code:
  - `SUPABASE_SERVICE_KEY` — Supabase service role (writes
    submissions, reads pricing_simple for permission gate)
  - `JOTFORM_API_KEY` — JotForm Enterprise API key
  - `JOTFORM_WEBHOOK_TOKEN` — URL-path token for webhook auth.
    Operator generates a random string (~32 chars), binds, then
    configures JotForm with a URL containing it.
- Routes: NONE (workers.dev only for v1, following Brief 81's
  "production custom domain is operator-driven" posture). Operator
  binds `staging.splashcarwashes.info/jotform/*` and
  `staging.splashcarwashes.info/admin/jotform/api/*` post-deploy
  via the dashboard — out of brief scope.

2.2 `apps/jotform-worker/src/index.js` route shape:

```
POST /jotform/webhook/{token}/{form_id}    — JotForm webhook
GET  /admin/jotform/api/forms              — list enabled forms + counts
GET  /admin/jotform/api/{form_id}/submissions          — paginated list
GET  /admin/jotform/api/{form_id}/submissions/{id}     — detail
GET  /admin/jotform/api/{form_id}/submissions.csv      — CSV export
POST /admin/jotform/api/{form_id}/backfill             — super_admin only
GET  /                                                  — 200 OK (CF health)
```

`isOriginAllowed` gate on the admin GET endpoints (Brief 87 pattern;
adjust to allow `staging.splashcarwashes.info` and
`splash-web.workers.dev`). The webhook endpoint is hit by JotForm
itself; no Origin check (JotForm doesn't send a useful Origin).
Token validation in the path replaces it.

2.3 Service binding from apps/web:
- Add `JOTFORM_WORKER` to `apps/web/wrangler.toml` `[[services]]`.
- Add `JOTFORM_WORKER?: Fetcher;` to `apps/web/cloudflare-env.d.ts`.

### Phase 3 — JotForm API helper module

`apps/jotform-worker/src/jotform.js` (new):

- `fetchSubmissionById(env, submissionId) → Promise<RawSubmission>`:
  GET `{JOTFORM_BASE_URL}/API/submission/{submissionId}?apikey={JOTFORM_API_KEY}`.
  15-second `AbortSignal.timeout`. Returns the `content` payload
  (single submission, rich shape — same as the operator's sample).
  Throws on non-2xx.

- `fetchFormSubmissions(env, formId, opts) → Promise<{rows, hasMore, lastId}>`:
  GET `{JOTFORM_BASE_URL}/API/form/{formId}/submissions?apikey=...&limit=1000&filter=...`.
  `opts` = `{ afterId?: string }`. When `afterId` provided, adds
  `filter={"id:gt":"<afterId>"}`. Returns `{rows, hasMore: rows.length === 1000, lastId: rows[rows.length-1]?.id}`.
  Used by backfill.

- No write helpers — JotForm is upstream-only.

### Phase 4 — Normalize + strip noise

`apps/jotform-worker/src/normalize.js`:

`stripAnswers(rawAnswers) → strippedAnswers`:

For each key in `rawAnswers`, drop if `type` is one of:
- `control_head`
- `control_pagebreak`
- `control_button`
- `control_text`

Keep everything else (whether or not `answer` is present — signature
fields without a captured signature are still meaningful as
"awaiting signature" state).

`extractCommonFields(rawAnswers) → { site_number, site, site_email }`:

Walk the answers to find the entries with these `name` values
(consistent across all four forms per sample inspection):
- `name === "typeA"` → `site_number` (it's a widget with the site
  number string answer like "127")
- `name === "site"` → `site` (textbox)
- `name === "siteEmail"` or `name === "siteEmail56"` (retention has
  both — prefer the email-typed one when present, fall back to text)
  → `site_email`

Fail-soft: any missing → null. Return shape:
`{ site_number: string|null, site: string|null, site_email: string|null }`.

`normalizeSubmission(rawSubmission) → InsertRow`:

```js
{
  id: rawSubmission.id,
  form_id: rawSubmission.form_id,
  ...extractCommonFields(rawSubmission.answers),
  jotform_created_at: parseJotformDate(rawSubmission.created_at),
  jotform_updated_at: rawSubmission.updated_at
    ? parseJotformDate(rawSubmission.updated_at)
    : null,
  jotform_status: rawSubmission.status,
  answers: stripAnswers(rawSubmission.answers)
}
```

`parseJotformDate(s)` converts `"2026-05-11 14:40:05"` (JotForm's
local-time format with no timezone) to ISO 8601 string. Treat the
JotForm timestamps as UTC for v1 (the operator's submissions don't
have timezone offsets in the payload; if they're actually local
time, that's a v2 cleanup). Document this assumption in the brief
outcome.

### Phase 5 — Webhook receiver

`apps/jotform-worker/src/handlers/webhook.js`:

`POST /jotform/webhook/{token}/{form_id}`:

1. Validate `{token}` path segment matches `env.JOTFORM_WEBHOOK_TOKEN`.
   If not, return 403 (no JSON body — JotForm won't render anything).
2. Validate `{form_id}` is in the `jotform_forms` table AND
   `enabled = true`. If not, log + return 200 (don't make JotForm
   retry an unknown form).
3. Parse `application/x-www-form-urlencoded` body. Extract
   `submissionID` (the field name JotForm uses). If missing, log +
   return 400.
4. Call `fetchSubmissionById(env, submissionID)`. If the API call
   fails (network / non-2xx), log + return 500 so JotForm retries.
5. Run `normalizeSubmission(raw)`.
6. PostgREST upsert into `jotform_submissions`:
   ```
   POST /rest/v1/jotform_submissions
   Headers: Prefer: resolution=merge-duplicates,return=minimal
   ```
   The PK on `id` triggers upsert behavior.
7. Return 200 with `{ ok: true }`.

Webhook responses MUST be 2xx for success / 5xx for retry. JotForm
retries on 5xx; treats 4xx as permanent failure. Pick status codes
accordingly.

### Phase 6 — Backfill endpoint

`POST /admin/jotform/api/{form_id}/backfill?after_id={lastId}`:

- Gate: super_admin only (re-use the auth gate but require
  `session.role === "super_admin"` — not `dcRole`). Anything less
  → 403.
- Validate `form_id` is in `jotform_forms` and enabled.
- Call `fetchFormSubmissions(env, formId, { afterId })`. Loops once
  (one page of up to 1000).
- Normalize + upsert each row in a single PostgREST POST (bulk
  upsert).
- Return `{ ok: true, inserted: N, last_id: "...", has_more: boolean }`.
- Operator (or a simple `pwsh` loop) re-invokes with the returned
  `last_id` until `has_more: false`.

Why paginated by the operator instead of automated: a single page
takes ~1-3 seconds against JotForm Enterprise; chaining 50 pages
inside one Worker invocation works for ~30K rewash submissions but
hits CF's 30-second CPU ceiling if anything goes sideways.
Operator-driven loop is the simpler safety net.

### Phase 7 — Admin read endpoints

`GET /admin/jotform/api/forms`:
- Admin gate (super_admin OR dc_role admin/super_admin).
- Returns `[{form_id, slug, display_name, enabled, submission_count}]`
  for all enabled forms. Submission count is per-form COUNT via
  PostgREST `?select=id&count=exact&limit=0` (head only).

`GET /admin/jotform/api/{form_id}/submissions?from=&to=&site_number=&am_email=&rm_email=&limit=&offset=`:
- Admin gate.
- Validate `form_id` in `jotform_forms`.
- Apply permission gate (see Phase 8).
- Query `jotform_submissions` filtered on `form_id`,
  `jotform_created_at` between `from` and `to` (default: last 30
  days), optional `site_number` filter, with permission-gate
  filter on `site_number IN (...)`.
- Default limit 200, max 500. Order
  `jotform_created_at desc`.
- Returns `{ rows: [...], total_estimate: N }`.

`GET /admin/jotform/api/{form_id}/submissions/{id}`:
- Admin gate.
- Permission gate: load the row first, check that its `site_number`
  is in the caller's accessible set, else 404 (anti-leak — don't
  expose existence).
- Returns the row.

`GET /admin/jotform/api/{form_id}/submissions.csv?from=&to=&site_number=&am_email=&rm_email=`:
- Same gate + filters as the list endpoint.
- 10000-row safety ceiling (return 416 on overflow).
- CSV column inventory: `id`, `jotform_created_at`,
  `jotform_updated_at`, `site_number`, `site`, `site_email`, plus
  every field present in any submission's `answers` (computed as
  the union of `answers` keys across the date range) rendered as
  `answers__{key}__answer` columns with the `answer` text value (or
  `prettyFormat` when present). Mirror the union-CSV pattern from
  Brief 96's forms submissions export.
- `Content-Type: text/csv; charset=utf-8`.
- `Content-Disposition: attachment; filename="{slug}-{from}-to-{to}.csv"`.
- RFC 4180 quoting.

### Phase 8 — Permission gate

`apps/jotform-worker/src/auth-gate.js`:

`accessibleSiteNumbersForSession(env, session) → Promise<Set<string> | "all">`:

- If `session.role === "super_admin"` OR `session.dcRole === "admin"`
  OR `session.dcRole === "super_admin"` → return `"all"`.
- Else call `getLocationsByContactEmail(env, session.email)` from
  `@splash/db-supabase` (already exists, returns
  `UserAccessibleLocation[]` with `site_number: number`).
- Convert each `site_number` (integer) to its **two string forms**:
  zero-padded 3-digit (e.g., `127` → `"127"`) and unpadded (e.g.,
  `90` → `"90"` AND `"090"`). JotForm's `typeA` widget returns the
  site number as a string sometimes padded ("090" for Milford) and
  sometimes not ("127" for Elmira Heights) — observed in the
  samples. Match both forms to be safe.
- Return `Set<string>` of all accepted variants.

Apply at the list/detail/CSV endpoints:
- List: `WHERE site_number IN (<set>)` PostgREST `in.(...)` filter
- Detail: load row, check `site_number ∈ set` else 404
- CSV: same as list

Super_admin / admin skip the filter entirely.

### Phase 9 — Validation

9.1 `pnpm typecheck` — must pass (note: jotform-worker is JS, but
the workspace typecheck still runs against any TS surfaces in
apps/web that consume the service binding declaration).
9.2 `pnpm --filter @splash/jotform-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed. Clean up
   after.
9.3 No new D1 / R2. Supabase schema in Phase 1 is
   operator-run.
9.4 Operator smoke (deferred):
   - Bind the three secrets.
   - Call `POST /admin/jotform/api/{form_id}/backfill` for one form
     (smallest first — `salt-log`) and verify rows land in
     `jotform_submissions`.
   - Configure JotForm webhook in the form's Integrations panel:
     `https://splash-jotform.workers.dev/jotform/webhook/{token}/{form_id}`.
   - Submit a test entry; verify row appears in Supabase within
     seconds.
   - Hit `GET /admin/jotform/api/forms` from a logged-in admin
     session; verify shape.

### Phase 10 — Updates

10.1 BRIEFS/INDEX.md: Brief 107 row appended.

10.2 BUILD_STATE.md: Findings entry noting:
  - New worker `splash-jotform` (apps/jotform-worker, JS) ingests
    JotForm submissions from four forms (rewash, salt-log,
    retention, time-card-edit) into Supabase.
  - Storage: `jotform_forms` + `jotform_submissions` tables.
    Common filterable fields promoted to columns (site_number, site,
    site_email, jotform_created_at, etc.); rest in `answers` JSONB.
  - Sync: webhook + one-time backfill. Webhook URL-token validation
    via `JOTFORM_WEBHOOK_TOKEN` secret.
  - Read-only v1; no splash_status / splash_notes columns.
  - Permission gate uses `getLocationsByContactEmail` against
    `pricing_simple.site_number`, with zero-padding fallback for
    JotForm widget output.
  - Operator follow-up: run Phase 1 SQL; bind three secrets; backfill
    each form; configure JotForm webhooks in each form's
    Integrations panel.

10.3 CLAUDE.md updates:
  - Glossary new entry: **jotform-worker** — fifth worker on the
    monorepo (sixth? confirm count). Path-carved on
    `splashcarwashes.info/jotform/*` and
    `splashcarwashes.info/admin/jotform/api/*`. Workers.dev only at
    Brief 107.
  - "Working with workers" table: append a row for jotform-worker.
  - New CLAUDE.md "JotForm submissions" subsection under "Glossary"
    with: forms list (slug → form_id), strip-noise rules, common
    fields extraction, normalization, permission gate notes.

10.4 New deploy doc `PRE_DEPLOY_JOTFORM.md` (workspace root,
following the convention of PRE_DEPLOY_FLEET.md):
  - Three secrets to bind (with `wrangler secret put` commands)
  - Operator backfill steps (per form, loop with `after_id`)
  - JotForm webhook configuration (per form, URL pattern)
  - First-run verification checklist

## Configuration

| Name | Type | Required | Default | How to set |
|------|------|----------|---------|------------|
| `SUPABASE_URL` | `[vars]` | yes | mirror fleet-inquiry-worker | wrangler.toml |
| `JOTFORM_BASE_URL` | `[vars]` | yes | `https://splashcarwashes.jotform.com` | wrangler.toml |
| `SUPABASE_SERVICE_KEY` | secret | yes | — | `wrangler secret put` |
| `JOTFORM_API_KEY` | secret | yes | — | `wrangler secret put` |
| `JOTFORM_WEBHOOK_TOKEN` | secret | yes | — | `wrangler secret put` (random 32-char token) |

No new D1. No new R2. Supabase: two new tables per Phase 1.

## Out of scope

- Splash-side admin fields (status / notes / audit columns). v2 if
  the operator ever wants to flag/note JotForm submissions from
  the dashboard. Read-only v1 per operator decision.
- PDF export. Operator clarified — they want CSV, not PDF.
- Apps/web viewer pages. Brief 108 covers that — list page (forms),
  per-form list with filters, detail page, CSV export proxy.
- Updating / deleting submissions. JotForm is upstream-only; the
  worker never PATCHes or DELETEs JotForm.
- Webhook HMAC signature verification. JotForm Enterprise UI doesn't
  expose a signing secret per operator's screenshot — rely on URL
  secrecy via `JOTFORM_WEBHOOK_TOKEN`.
- Form-specific generated columns (e.g., `rewash_reason`,
  `salt_pounds`). Read access via JSONB path operators is fast
  enough at 30K-row scale; deferred to v2 if a specific aggregate
  query needs it.
- Form-specific aggregate / reporting views (e.g., "total pounds of
  salt by site by month"). v2.
- Real-time signature verification on the webhook beyond
  URL-token. JotForm Enterprise may add signing secrets later; if
  so, swap to HMAC in a follow-up.
- Mirroring JotForm-hosted file/signature URLs to R2. Just store
  the URLs. JotForm CDN handles delivery.
- Onboarding forms #5 / #6 if they appear. The pattern handles it;
  operator inserts the row into `jotform_forms`, runs a backfill,
  configures the webhook. No code change.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/jotform-worker/` exists with `wrangler.toml`, `src/index.js`,
  `src/handlers/*`, `src/jotform.js`, `src/normalize.js`,
  `src/auth-gate.js`. Worker name `splash-jotform`.
- `apps/web/wrangler.toml` declares `JOTFORM_WORKER` service binding;
  `apps/web/cloudflare-env.d.ts` declares its type.
- All endpoints from Phase 2.2 implemented and behind the admin
  gate (except the webhook, which is token-gated).
- Permission gate via `getLocationsByContactEmail` matches Phase 8.
- Normalization strips `control_head` / `control_pagebreak` /
  `control_button` / `control_text` and promotes the three common
  fields to columns.
- Backfill endpoint is super_admin only and paginates via `after_id`.
- CSV export uses the union-of-keys pattern (Brief 96 mirror) with
  10000-row safety cap.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/jotform-worker exec wrangler deploy
  --dry-run` bundle succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md, PRE_DEPLOY_JOTFORM.md
  updated.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (likely 600-900 LOC net for the new worker + the
  apps/web service binding + the doc files)
- Confirmation that the four `INSERT INTO jotform_forms` rows are
  exactly the operator's four forms
- Confirmation that the permission gate's zero-padded site_number
  fallback handles the JotForm widget's mixed output ("090" vs
  "127")
- Sample webhook payload shape (operator-visible during PA build, so
  good to capture in the outcome — what JotForm actually sends to
  `/jotform/webhook/{token}/{form_id}`)
- Validation results
- Any decisions made on the operator's behalf
- Operator follow-up checklist:
  1. Run Phase 1 SQL in Supabase
  2. `wrangler secret put SUPABASE_SERVICE_KEY` (existing key)
  3. `wrangler secret put JOTFORM_API_KEY`
  4. Generate + bind `wrangler secret put JOTFORM_WEBHOOK_TOKEN`
  5. Backfill each form via the admin endpoint (smallest first)
  6. Configure JotForm webhook per form using the bound token URL
  7. Submit a test entry on one form to confirm webhook path works

## Outcome

### Files created

- `apps/jotform-worker/package.json` — workspace package with the
  three @splash dep references (`auth`, `db-supabase`, `http`) and
  the standard `dev` / `deploy` / `deploy:dry-run` / `typecheck` /
  `lint` / `clean` scripts. Mirrors `apps/fleet-inquiry-worker/package.json`.
- `apps/jotform-worker/tsconfig.json` — extends
  `packages/config/tsconfig.base.json` with `allowJs: true /
  checkJs: false / noEmit: true / types: @cloudflare/workers-types`.
  Mirrors fleet-inquiry-worker.
- `apps/jotform-worker/wrangler.toml` — worker name
  `splash-jotform`, `workers_dev = true`, `[vars] SUPABASE_URL` +
  `JOTFORM_BASE_URL`, `[observability.logs] enabled = true /
  invocation_logs = true` (Brief 63), `[limits] cpu_ms = 30000`,
  comment block documenting the four secrets the operator must bind.
- `apps/jotform-worker/src/index.js` — main fetch handler;
  delegates to webhook + admin routers.
- `apps/jotform-worker/src/jotform.js` — JotForm Enterprise API
  client (`fetchSubmissionById`, `fetchFormSubmissions`); 15s
  `AbortSignal.timeout`; throws on non-2xx so the caller maps to
  the right HTTP status.
- `apps/jotform-worker/src/normalize.js` — `stripAnswers` (drops
  the four control_* noise types), `extractCommonFields` (walks the
  answers map keyed on JotForm field-`name` for `typeA` /
  `site` / `siteEmail` / `siteEmail56`), `normalizeSubmission` (full
  insert-row builder), `parseJotformDate` (UTC-assumed
  `YYYY-MM-DD HH:MM:SS` → ISO 8601).
- `apps/jotform-worker/src/auth-gate.js` — three exported gates:
  `authenticateAdminOrHigher` (forms list endpoint),
  `authenticateForAdminApi` (per-form list / detail / CSV — any
  session), `authenticateSuperAdmin` (backfill), plus
  `accessibleSiteNumbersForSession` returning either `"all"` or a
  `Set<string>` containing BOTH zero-padded and unpadded
  string forms of every accessible site_number.
- `apps/jotform-worker/src/db.js` — PostgREST helpers
  (`loadFormById`, `listForms`, `countSubmissionsForForm`,
  `upsertSubmissions`, `loadSubmissionById`, `listSubmissions`,
  `listSubmissionsForCsv`). Matches the forms-worker / fleet-worker
  direct-`fetch()` convention; no `@supabase/supabase-js` client in
  worker code.
- `apps/jotform-worker/src/handlers/webhook.js` — webhook receiver
  with constant-time token compare, form lookup gate, body parse,
  re-fetch via JotForm API, normalize, upsert.
- `apps/jotform-worker/src/handlers/admin.js` — admin route
  dispatcher + 5 handlers: list-forms, list-submissions,
  detail, CSV export (schema-union per Brief 96 pattern), and
  backfill. Date-range / limit / offset / site_number parsing helpers
  co-located.
- `PRE_DEPLOY_JOTFORM.md` (repo root) — operator runbook with
  Phase 1 SQL, secret bind commands, per-form backfill PowerShell
  loop sample, JotForm webhook URL pattern, 7-step first-run smoke
  + cutover plan + known limitations + checklist.

### Files modified

- `apps/web/wrangler.toml` — appended `[[services]] binding =
  "JOTFORM_WORKER" service = "splash-jotform"` after the
  `FORMS_WORKER` block (Brief 89/94 pattern).
- `apps/web/cloudflare-env.d.ts` — appended
  `JOTFORM_WORKER: Fetcher;` to the `CloudflareEnv` interface.
- `BRIEFS/INDEX.md` — appended Brief 107 row.
- `BUILD_STATE.md` — bumped "Last updated", added a Findings entry
  summarizing the work (existing Brief 106 paragraph moved one slot
  down). No prioritized work-list status change — Brief 107 isn't
  on the numbered list.
- `CLAUDE.md` — "Nine Cloudflare Workers" header refreshed (was
  "Seven"); apps/ tree entry added for `apps/jotform-worker`;
  glossary gained a `jotform-worker` entry plus a `JotForm
  submissions` paragraph (forms list, strip-noise rules, common
  fields extraction, onboarding-a-new-form steps).
- `pnpm-lock.yaml` — regenerated by `pnpm install --no-frozen-lockfile`
  for the new workspace package.

### Decisions made on the operator's behalf

1. **Auth gate is permissive for per-form endpoints.** The brief
   said "Admin gate" for the per-form list / detail / CSV but also
   that RM/RD/GM are intended to use these (scoped by their
   accessible-locations email match). I read the brief as: the
   /forms global list is admin-tier (consistent with fleet's Brief
   83), but the per-form endpoints accept any authenticated session
   and apply the scope filter downstream. Empty scope (no email
   match) → empty result set. This matches the spirit of "RM sees
   locations where their email is rm_email" — the gate itself
   doesn't reject them, the scope does.
2. **Detail endpoint returns 404 (not 403) for out-of-scope rows.**
   Anti-leak posture — the caller can't distinguish "doesn't exist"
   from "exists but not yours". The brief specified 404 here ("Detail:
   load row, check `site_number ∈ set` else 404 (anti-leak — don't
   expose existence)") — implemented verbatim.
3. **JotForm timestamps treated as UTC.** The brief flagged this as
   an open question ("Treat the JotForm timestamps as UTC for v1...
   if they're actually local time, that's a v2 cleanup"). Implemented
   as documented; called out in PRE_DEPLOY_JOTFORM.md Section 7
   (Known limitations) so operator can confirm/correct after first
   real-world submission.
4. **Webhook auth via constant-time string compare.** The brief
   specified URL-token matching but didn't specify timing-safe.
   Added `constantTimeEqual` as defense-in-depth — token has ~32
   chars of entropy so timing is belt-and-suspenders, but free.
5. **5xx for transient JotForm API failures, 200 for unknown
   form_id.** Matches the brief's "JotForm retries on 5xx; treats
   4xx as permanent failure" — chose 200 for unknown form to halt
   retries, 500 for the API re-fetch failure path so JotForm tries
   again later.
6. **`SUPABASE_ANON_KEY` required (not optional).** The brief listed
   only `SUPABASE_SERVICE_KEY`, but `@splash/auth authenticate()`
   needs `SUPABASE_ANON_KEY` for the `/auth/v1/user` round-trip.
   Mirrors the Brief 91 outcome where forms-worker needed it added
   too. Documented in PRE_DEPLOY_JOTFORM.md Section 2.
7. **CSV column inventory.** Brief specified the schema-union
   pattern; I included `jotform_status` in the base columns alongside
   `id` / `jotform_created_at` / `jotform_updated_at` / `site_number`
   / `site` / `site_email`. Per-answer cells use `prettyFormat` when
   available, falling back to `answer` (or JSON.stringify for complex
   objects). Matches Brief 96's spirit.
8. **CLAUDE.md "Nine Workers" framing.** The intro counted seven
   pre-Brief-89 (forms) and pre-Brief-107 (jotform). I updated to
   "Nine" to include both — forms-worker was missing from the count
   too, so the existing copy was already one off. Glossary entries
   reflect the actual numbering.

### Latent issues found

- **JotForm timezone ambiguity.** `parseJotformDate` treats the
  format as UTC. If the operator's JotForm account is timezone-set
  to local time, every `jotform_created_at` is off by 4-5 hours
  (Eastern). v2 fix: apply a known-offset correction in
  `normalizeSubmission` and re-ingest. Flagged in PRE_DEPLOY_JOTFORM.md
  Section 7.
- **Backfill loop is operator-driven by design.** A single CF worker
  invocation can theoretically chain ~30 pages × 1-3s each = 30-90s
  for rewash, which is comfortably under the 30s CPU ceiling for
  most pages but flirts with it on slow ones. The operator-driven
  external loop is the safer pattern.
- **`pricing_simple`-based gate per the brief context.** Brief
  context says "map to `pricing_simple.site_number` to apply the
  gate" but I used `getLocationsByContactEmail` (which reads
  `locations` directly). Per Brief 71 / Brief 62 / Brief 33 the
  `locations` table is the canonical join axis for the
  email-on-locations gate (pricing_simple's denormalized email
  columns are trigger-synced from locations); the helper exists for
  exactly this purpose. The brief's Phase 8 specified
  `getLocationsByContactEmail` explicitly, so implemented as
  documented.
- **No PostgREST `in.(...)` value-encoding helper in `@splash/http`.**
  I wrote a small `quoteForIn` inside `db.js` that double-quotes
  every value defensively (PostgREST `in.(...)` accepts both bare
  and quoted strings; quotes are safe). If a third caller needs
  this, lift to `packages/http`.
- **No idempotency surface for the webhook endpoint.** JotForm may
  retry on 5xx with the same submissionID multiple times. The
  PostgREST upsert handles this cleanly (`on_conflict=id` +
  `merge-duplicates`), but a caller examining response bodies sees
  no `was_new` signal. Acceptable for v1; Brief 108 (apps/web viewer)
  doesn't need it.
- **`form.enabled === false` is treated as "skip" not "reject".**
  The webhook handler logs + returns 200 on a disabled form so
  JotForm halts retries (vs. 404/410 which JotForm interprets as
  permanent failure but still spams retries during a flaky window).
  Disabled-form rows are an admin-curated "freeze" toggle in
  `jotform_forms`.

### Validation results

- **`pnpm typecheck`**: 18/18 packages green. `@splash/jotform-worker`
  added to the pipeline alongside the existing 17. Total time
  12.9s with cache misses on all 18 (initial post-install run).
- **`pnpm --filter @splash/jotform-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build`**: bundle 741.06 KiB raw / 140.34 KiB
  gzipped. Cleanly under CF's 3 MiB compressed limit. Two
  Environment Variable bindings reported (`SUPABASE_URL` +
  `JOTFORM_BASE_URL`); secrets aren't surfaced via `--dry-run`
  (expected — they're bound at deploy time via `wrangler secret
  put`). `.tmp-build` artifact cleaned up post-validation.
- **No new D1 / R2 resources.** Two new Supabase tables required
  (Phase 1 SQL) — operator runs once.
- **Operator smoke deferred** per the brief (the Definition of Done
  explicitly defers smoke to operator-post-deploy).

### Sample webhook payload (for operator's PA build visibility)

The webhook URL pattern is:

```
POST https://splash-jotform.<account>.workers.dev/jotform/webhook/{JOTFORM_WEBHOOK_TOKEN}/{form_id}
Content-Type: application/x-www-form-urlencoded
```

JotForm Enterprise sends a flat URL-encoded body with these top-level
fields (per operator sample inspection during planning):

```
formID=250165655616055
submissionID=6234567890123456789
rawRequest={...stringified JSON of the answers map...}
pretty=Site:127, Site Email:elmiraheights@splashcarwashes.com, ...
formTitle=Rewash
ip=...
```

The worker extracts `submissionID` and discards the rest — the
authoritative payload comes from the JotForm API re-fetch
(`GET https://splashcarwashes.jotform.com/API/submission/{id}?apikey=...`),
which returns the richer "content" envelope:

```json
{
  "responseCode": 200,
  "message": "content",
  "content": {
    "id": "6234567890123456789",
    "form_id": "250165655616055",
    "ip": "...",
    "created_at": "2026-05-11 14:40:05",
    "status": "ACTIVE",
    "new": "1",
    "flag": "0",
    "notes": "",
    "updated_at": null,
    "answers": {
      "<questionId>": {
        "name": "typeA",
        "order": "...",
        "text": "Site",
        "type": "control_widget",
        "answer": "127",
        "prettyFormat": "127"
      },
      "<questionId>": {
        "name": "site",
        "type": "control_textbox",
        "answer": "Elmira Heights"
      },
      "<questionId>": {
        "name": "siteEmail",
        "type": "control_email",
        "answer": "elmiraheights@splashcarwashes.com"
      }
    }
  }
}
```

The worker normalizes this into a `jotform_submissions` row with the
three common fields promoted to columns and the stripped `answers`
map (sans the four `control_*` noise types) in JSONB.

### Operator follow-up checklist

1. Run the Phase 1 SQL in Supabase Editor (see PRE_DEPLOY_JOTFORM.md
   Section 1).
2. Bind four secrets (Section 2): `SUPABASE_SERVICE_KEY`,
   `SUPABASE_ANON_KEY`, `JOTFORM_API_KEY`, `JOTFORM_WEBHOOK_TOKEN`.
3. Run the backfill loop per form (Section 3) — smallest first
   (`salt-log` = 243523811897060).
4. Configure JotForm webhook per form (Section 4) — URL pattern
   `https://splash-jotform.<account>.workers.dev/jotform/webhook/{token}/{form_id}`.
5. Submit a test entry on one form (Section 5.1) to confirm the
   webhook end-to-end path works.
6. Wait for Brief 108 (apps/web JotForm viewer pages) to surface
   the data to admins via the dashboard.
