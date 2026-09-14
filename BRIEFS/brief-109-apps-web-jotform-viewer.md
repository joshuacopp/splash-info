# Brief 109: apps/web JotForm viewer + dashboard tile

**Status:** Completed (2026-05-11)
**Started:** 2026-05-11
**Completed:** 2026-05-11
**Blocks:** Neither — additive. Brief 107 stood up the
`splash-jotform` worker (ingest + admin read API + CSV); operators
can hit the worker via direct fetch today but have no UI surface.
This brief paints the apps/web viewer on top of the existing
`/admin/jotform/api/*` endpoints.
**Dependencies:** Brief 107 (worker + tables + service binding +
read API surface — all live). Closest pattern analog is Brief 96
(forms submissions admin) — three-page set, generic per-form
renderer driven by the row payload. Same date-range + CSV-export
patterns as Brief 83 (fleet admin) and Brief 96.

## Read first

- CLAUDE.md (esp. **JotForm submissions** + **jotform-worker** glossary entries)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-107-jotform-worker-storage-backfill-webhook.md
  (worker + tables + endpoints; the apps/web side was deferred to
  Brief 109)
- BRIEFS/brief-096-forms-submissions-admin.md (closest pattern
  analog — three-page set, generic per-row payload renderer)
- BRIEFS/brief-083-fleet-submissions-admin-viewer.md (date-range
  + CSV-export pattern; service-binding helper layout)
- apps/jotform-worker/src/handlers/admin.js (endpoint shapes the
  apps/web pages will consume)
- apps/web/app/admin/forms/[id]/submissions/* (Brief 96 reference
  implementation — payload renderer + admin list page layout)
- apps/web/app/admin/fleet/_lib/worker-fetch.ts (Brief 83
  service-binding fetch helper — copy structure)
- apps/web/wrangler.toml lines 92-100 (the `JOTFORM_WORKER`
  service binding is already declared)
- apps/web/cloudflare-env.d.ts (declaration-merge new binding here
  if not already there)

## Context

Brief 107 stood up `splash-jotform` with these endpoints under
`staging.splashcarwashes.info/admin/jotform/api/*` (path-carved on
apps/web's hostname per Brief 89 / Brief 107 convention):

- `GET /forms` — admin-tier only (`super_admin` / `admin` / dcRole
  admin / dcRole super_admin). Returns
  `{ forms: [{form_id, slug, display_name, enabled, submission_count}] }`
  for enabled forms.
- `GET /{form_id}/submissions?from=&to=&limit=&offset=&site_number=`
  — any authenticated session. Worker scopes via
  `accessibleSiteNumbersForSession` (RM via `rm_email`, RD via
  `am_email`, GM via `site_email`; admin-tier sees all). Returns
  `{rows, count, total, total_estimate, limit, offset, from, to, scope}`
  where each row carries `id`, `form_id`, `site_number`, `site`,
  `site_email`, `jotform_created_at`, `jotform_updated_at`,
  `jotform_status`, `answers` (JSONB map).
- `GET /{form_id}/submissions/{id}` — any session. 404 on
  out-of-scope (anti-leak — caller can't distinguish "doesn't
  exist" from "exists but not yours"). Returns `{ row }`.
- `GET /{form_id}/submissions.csv?from=&to=&site_number=` — any
  session, scoped. Header is the union of every `answers` key
  across the date range as `answers__{key}__answer` columns. 10000
  row safety cap; 416 on overflow.

apps/web already declares the service binding
(`JOTFORM_WORKER` → `splash-jotform`, line 98-100 of
`apps/web/wrangler.toml`) and `@splash/forms-schema` is NOT
relevant (different worker). No worker change is needed in this
brief.

Operators today have no apps/web page for this — the dashboard
tile grid (per recent operator screenshot) lacks a JotForm card.
This brief adds the three pages + the dashboard tile so RM / RD /
GM operators can see their scope's submissions without dropping
to the browser console.

The four onboarded forms (per CLAUDE.md):

- `250165655616055` — Rewash (~30K rows)
- `243523811897060` — Salt log (~3K rows)
- `250855287972067` — Retention (~16K rows)
- `250193775451056` — Time card edit (~700 rows)

Onboarding form #5 / #6 down the line is INSERT into
`jotform_forms` + run backfill — no apps/web code change needed
because the viewer is generic.

## Scope

### Phase 1 — Worker fetch helper

Create `apps/web/app/admin/jotform/_lib/worker-fetch.ts` mirroring
the Brief 83 fleet helper structure exactly:

- `listForms()` → `Promise<{forms: JotformForm[]}>`. Calls
  `GET /admin/jotform/api/forms` via the `JOTFORM_WORKER` binding;
  URL fallback for `next dev`. Forwards the user's Cookie.
- `listSubmissions(formId, {from, to, limit, offset, siteNumber})`
  → `Promise<JotformSubmissionsList>`. Calls
  `GET /admin/jotform/api/{formId}/submissions?...`.
- `getSubmission(formId, subId)` →
  `Promise<{row: JotformSubmissionRow} | null>`. 404 collapses to
  `null` so the page renders `notFound()` cleanly.
- `csvExportUrl(formId, {from, to})` → relative same-origin URL
  string for use as `<a href download>`. Same-origin works because
  splash-jotform is path-carved on apps/web's hostname (path-carve
  pattern from Brief 89 / Brief 107) — NO Brief 88-style proxy
  route is needed (that was specific to fleet's subdomain split).

Types: declare locally in the helper or in a sibling
`_lib/types.ts`. Match the worker's response shape verbatim. The
`row.answers` field is `Record<string, unknown>` — preserve as
generic JSON so the renderer can iterate keys without enforcing a
shape.

### Phase 2 — Index page (`/admin/jotform`)

Server component at `apps/web/app/admin/jotform/page.tsx`. Auth
gate: admin-tier only (`session.role === "super_admin"` OR
`session.dcRole === "admin"` OR `session.dcRole === "super_admin"`).
RM / RD / GM hits this page → render a "no access" card directing
them to the per-form URLs they would have bookmarked (or just a
generic "you don't have access to this view, contact a super_admin"
copy; per-form deep linking is operator UX that's currently
out-of-scope).

Layout: simple card grid (4 cards at v1, one per enabled form).
Each card shows `display_name`, `submission_count`, and a
click-through to `/admin/jotform/{form_id}`. Mirror the dashboard
tile look (`bg-splash-navy` header, white card body) to stay visually
consistent.

If `JOTFORM_WORKER` service binding is unbound (dev mode without
the binding, or 503 from worker), surface a clear "JotForm
worker not configured" empty state — do NOT crash the page.

### Phase 3 — Submissions list (`/admin/jotform/[form_id]`)

Server component at `apps/web/app/admin/jotform/[form_id]/page.tsx`.
Auth gate: any authenticated session (worker re-validates scope).
Forbid `form_id` values not in the `listForms` result —
`notFound()` for unknown IDs to avoid leaking probe-ability.

URL search params: `from=YYYY-MM-DD`, `to=YYYY-MM-DD`, `offset=N`.
Default range: last 30 days (matches the worker default). Default
offset 0. Page size: 50 (default limit; user can't change in v1
UI, but the worker supports it).

Page content:

- Top: form display_name title, breadcrumb back to `/admin/jotform`,
  `submission_count` summary.
- Below: shared `<DateRangePicker>` (URL-driven, same component
  fleet/forms use), `<CsvExportButton>` (same-origin
  `csvExportUrl()` from the helper).
- Table: columns "Submitted at" (formatRelative + absolute tooltip
  on `jotform_created_at`), "Site" (`site` if present else
  `site_number`), "Status" (`jotform_status` rendered as a muted
  pill), "View →" (link to detail page).
- Pagination: Prev / Next buttons keyed off `total` and current
  `offset` + `limit`. Disable Prev when offset=0; disable Next when
  `offset + limit >= total`. Use `total_estimate` if `total` is
  missing.
- Empty state: "No submissions in this date range" + a hint to
  widen the date range. If `scope === "scoped"` AND zero rows,
  append "(scoped to your locations)".

### Phase 4 — Detail page (`/admin/jotform/[form_id]/[submission_id]`)

Server component at
`apps/web/app/admin/jotform/[form_id]/[submission_id]/page.tsx`.
Auth gate: any session. `getSubmission(formId, subId)` returning
null → `notFound()` (covers both "not found" and "out of scope" —
the anti-leak 404 from the worker).

Layout: two-column or stacked. Meta block at top (form name, site
/ site_number / site_email, submitted at absolute + relative,
jotform_status). Below that: generic key-value renderer over the
`row.answers` map.

Renderer rules:

- Iterate `Object.keys(row.answers)`. For each key, render
  `<dt>{key}</dt><dd>{value}</dd>`.
- Value formatting: if value is a string, render as-is in a
  `<span>` (preserve whitespace via `whitespace-pre-wrap` for
  multi-line answers like Retention's notes). If object, render
  via `JSON.stringify(value, null, 2)` inside `<pre>` so nested
  data is at least legible. If number / boolean, coerce to string.
  If null / empty string, render `—` muted.
- Sort keys: rendering order is alphabetical at v1. Form-specific
  field ordering would require per-form schemas — deferred to v2
  (planning Decision: generic-first, schema-aware second).

Optional: a "Raw JSON" expandable `<details>` block at the bottom
showing the full row (for super_admin debugging). Off by default.

### Phase 5 — Dashboard tile

Edit `apps/web/app/admin/dashboard/page.tsx` to add a "JotForm"
tile (or whatever copy reads cleanly next to "Forms"). Tile
header: small uppercase eyebrow + bold display name; body: a
one-line description like "View submissions from rewash, salt log,
retention, and time card edit forms." Click-through to
`/admin/jotform`.

Tile visibility: only render to users who can reach the index
(super_admin / admin / dcRole admin / dcRole super_admin). RM / RD
/ GM can still navigate to per-form URLs by bookmark; surfacing
the tile to them would invite confusion since the index page
no-access-cards them.

### Phase 6 — Validation

6.1 `pnpm typecheck` — must pass. No worker changes; only apps/web.
6.2 `pnpm --filter @splash/web build` — must succeed. Next 15.5
    should compile the new pages cleanly. Bundle size impact
    should be modest (<5kB on the new routes since the renderer is
    server-rendered).
6.3 No worker change. No Supabase / R2 / D1 schema change. No new
    env / secret.
6.4 Operator post-deploy smoke (deferred):
    - Load `/admin/jotform` as super_admin → see 4 cards with
      counts matching Supabase `SELECT form_id, COUNT(*) FROM
      jotform_submissions GROUP BY form_id`.
    - Load `/admin/jotform/250855287972067` → submissions list
      renders, date range filter works, pagination Prev / Next
      advances correctly.
    - Click any row → detail page renders the answers map and
      meta block.
    - Click "Export CSV" → browser downloads `jotform-{slug}-
      {from}-to-{to}.csv` (filename per worker's
      Content-Disposition).
    - Switch to a non-admin role test user (RM with rm_email set
      on a few locations) → index page no-access-cards them; visit
      `/admin/jotform/250855287972067` directly and see only their
      scoped rows.

### Phase 7 — Updates

7.1 BRIEFS/INDEX.md: Brief 109 row appended.

7.2 BUILD_STATE.md: Findings entry noting:
  - Brief 109 (YYYY-MM-DD) — apps/web JotForm viewer set landed
    (index + per-form list + per-submission detail + CSV export
    button + dashboard tile). Pairs with Brief 107's worker
    surface; no worker change needed.
  - Visibility gate: admin-tier sees index + dashboard tile;
    RM / RD / GM can reach per-form URLs by direct navigation and
    the worker scopes their rows automatically via
    `accessibleSiteNumbersForSession`.
  - Renderer is generic (alphabetical key order over `row.answers`)
    so new forms onboarded via SQL INSERT + backfill don't require
    apps/web code changes. Form-specific field ordering is a v2
    candidate.

7.3 CLAUDE.md: append a one-liner to the "JotForm submissions" /
"jotform-worker" glossary entries noting that apps/web's
`/admin/jotform/*` is the credentialed viewer for the worker's
admin API surface (post-Brief-109).

## Out of scope

- Editing submissions (no status / splash_notes column on
  `jotform_submissions` at v1 — JotForm itself is the edit
  surface). If operators later want apps/web write surfaces, that
  needs a schema add + worker PATCH endpoint, both out of scope
  here.
- Per-form custom field renderers / ordering. The v1 generic
  renderer is alphabetical-key. Form-specific UX is a v2 candidate.
- Per-form site_number filter dropdown in apps/web. The worker
  accepts `?site_number=` but UX is not painted in v1 — operators
  who want to narrow further can use the URL bar or the CSV export
  + spreadsheet filter. Decide whether to add the dropdown in a v2
  brief once operators report needing it.
- Bulk operations (export selected rows, delete, etc.). Read-only
  v1.
- Adding new JotForm forms to the registry — operator does this
  via SQL INSERT into `jotform_forms` + run backfill. No apps/web
  change required because the viewer is generic over the form list.
- Webhook re-fire / replay UI. If a submission's webhook failed and
  Supabase missed the row, the operator runs the backfill endpoint
  to catch up. UI for selective replay is v2+.
- Notification / alert wiring on new submissions. JotForm itself
  has email integrations; apps/web doesn't need to duplicate.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes (constraint #9 / staging-first
  posture — apps/web is on `staging.splashcarwashes.info/*`,
  `splash-jotform` is on `staging.splashcarwashes.info/jotform/*`
  + `/admin/jotform/api/*`).
- Don't commit to git or push.

## Definition of done

- `apps/web/app/admin/jotform/_lib/worker-fetch.ts` exists with
  the four helpers (`listForms`, `listSubmissions`, `getSubmission`,
  `csvExportUrl`) using the service binding + URL fallback pattern.
- `apps/web/app/admin/jotform/page.tsx` renders the four-card
  index with admin-tier gating and a NoAccessCard fallback.
- `apps/web/app/admin/jotform/[form_id]/page.tsx` renders the
  per-form list with DateRangePicker + CSV button + pagination.
- `apps/web/app/admin/jotform/[form_id]/[submission_id]/page.tsx`
  renders the generic answers map + meta block.
- `apps/web/app/admin/dashboard/page.tsx` has a new "JotForm" tile
  visible to admin-tier users.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 7.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (estimate: ~6 new files in apps/web, ~5 lines edited
  in dashboard page, plus doc rows).
- Validation results.
- Whether any per-form schema-aware rendering surfaced as obviously
  needed in v1 (i.e., were any forms' answer keys cryptic enough
  that the generic alphabetical renderer felt unusable?). Flag for
  v2 if so.
- Any other latent issues.

## Outcome

### Files created (6)

- `apps/web/app/admin/jotform/_lib/worker-fetch.ts` — typed wrappers
  around the four admin endpoints (`listForms`, `listSubmissions`,
  `getSubmission`) + the `csvExportUrl` builder. Service-binding-first
  via `JOTFORM_WORKER`, URL fallback for `next dev`
  (`NEXT_PUBLIC_JOTFORM_WORKER_URL` env var or request host). Mirrors
  fleet's Brief 83 helper shape: `jotformGetJson` collapses 401/403/404
  to `null` for clean caller-side branching; non-2xx throws. Types declared
  inline (`JotformForm`, `JotformSubmissionRow`, list/detail response
  shapes); `row.answers` typed as `Record<string, unknown>` to stay
  schema-agnostic.
- `apps/web/app/admin/jotform/_components/NoAccessCard.tsx` — admin-tier
  copy mirroring Brief 95's forms NoAccessCard. Two reasons: `signin`
  (return-path-aware sign-in CTA) and `forbidden` (mentions that per-form
  URLs remain navigable for RM/RD/GM scoped users).
- `apps/web/app/admin/jotform/page.tsx` — index. Admin-tier gate via
  `getMe()` (`session.role === "super_admin"` OR `session.dcRole ===
  "admin"|"super_admin"`); RM/RD/GM hits get `<NoAccessCard
  reason="forbidden" />`. Renders `forms` as a 3-column responsive card
  grid mirroring the dashboard tile look (`bg-gradient-to-br from-splash-blue
  to-splash-navy` header, white card body, View arrow). Three empty
  states: fetch error (red banner), worker-unbound (`forms === null && !fetchError`,
  italic "JotForm worker not configured" hint), and zero forms (italic
  "no forms registered yet").
- `apps/web/app/admin/jotform/[form_id]/page.tsx` — per-form submissions
  list. Any-session gate; admin-tier callers additionally resolve
  `formMeta` via `listForms()` to populate the title + slug subtitle and
  to `notFound()` on unknown `form_id` (anti-probe). Non-admin callers
  drop straight to the submissions call (the worker 404s for unknown /
  disabled forms; we collapse `data === null && !formMeta` to
  `notFound()`). URL params: `from=YYYY-MM-DD`, `to=YYYY-MM-DD`,
  `offset=N`. Default range last-30-days, default offset 0, default
  limit 50 (worker default). Page composition: breadcrumb +
  `<DateRangePicker>` + `<CsvExportButton>` + meta-only table (Submitted
  at / Site / Status / View →) + Prev/Next pagination keyed off
  `total`+`offset`+`limit`. Empty state appends "(scoped to your
  locations)" when `scope === "scoped"`.
- `apps/web/app/admin/jotform/[form_id]/[submission_id]/page.tsx` —
  detail. Any-session gate; the worker's anti-leak 404 (out-of-scope row
  → 404 not 403) means `getSubmission()` null collapses to `notFound()`
  uniformly. Composition: metadata grid (Submission ID / Site / Site
  number / Site email / Submitted at / Updated at / JotForm status) +
  alphabetical-key `<dl>` over `row.answers` with a `<AnswerValue>`
  renderer that handles strings (preserved whitespace via
  `whitespace-pre-wrap`), numbers/booleans (`String()` coerce), objects
  (prefers `prettyFormat` → `answer.text/value` → JSON pre-block), and
  null/empty (em-dash mute). Bottom-of-page `<details>` "Raw JSON
  (debug)" `<pre>` block of the full row for super_admin debugging.
- `apps/web/app/admin/jotform/_lib/` and
  `apps/web/app/admin/jotform/_components/` directories implicitly
  created by the helper + NoAccessCard above.

### Files modified (4)

- `apps/web/app/admin/dashboard/page.tsx` — added new "JotForm" tile
  (eyebrow "Submissions", inline lucide FileText SVG, href
  `/admin/jotform`, description "Browse submissions from rewash, salt
  log, retention, and time card edit forms."). First gated tile: extended
  `Tile` interface with optional `visibleTo?: "adminTier"` field; made
  `AdminDashboardPage` async to read `getMe()` and filter the TILES
  array. Other tiles (no `visibleTo`) continue to render unconditionally
  per the existing dashboard policy. `getMe()` failure (caught) means the
  gated tile drops silently — safe default.
- `BUILD_STATE.md` — Last-updated bumped to 2026-05-11 / Brief 109;
  previous Brief 108 paragraph moved to "(Previously:" prefix.
- `BRIEFS/INDEX.md` — Brief 109 row appended before the "Folded items"
  separator.
- `CLAUDE.md` — `jotform-worker` glossary entry extended with a
  Brief 109 paragraph noting that apps/web's `/admin/jotform/*` is the
  credentialed viewer for the worker's admin API surface, calling out
  the dashboard tile visibility-gate as the first of its kind, and
  flagging form-specific field ordering as a v2 candidate.

### Decisions made on the operator's behalf

1. **Dashboard tile gated to admin-tier only** — the brief specified
   this; honored over the dashboard's existing v1 "all tiles render
   unconditionally" policy. The destination's index page already
   no-access-cards non-admins, so surfacing the tile to them would have
   been visual noise. Implemented additively via a new optional
   `Tile.visibleTo` field so the existing tiles' unconditional behavior
   is preserved.
2. **`AdminDashboardPage` made async to call `getMe()`** — needed for the
   gate; mirrors the same pattern used elsewhere (sysadmin / forms / fleet
   pages already do this). `getMe()` failure is `.catch(() => null)`-ed
   so a transient dashboard-worker outage doesn't break the dashboard
   for everyone — the gated tile just drops out.
3. **`/admin/jotform/[form_id]` admin-only listForms resolution** —
   non-admin sessions can't hit `GET /admin/jotform/api/forms` (the
   worker gates it admin-tier). The page therefore tries listForms only
   for admin-tier callers and falls through to the form_id as the page
   title for RM/RD/GM, who see "form_id" as the title until the operator
   either widens the worker's `/forms` endpoint or per-form
   `display_name` is added to the submissions response. Acceptable for
   v1 because the operator-stated form cap is 5–6 and form_ids are
   stable, but flagged as a latent UX gap.
4. **Pagination keyed off `total` from the worker** — the worker returns
   both `total` and `total_estimate`; the page reads `total` first and
   falls back to `total_estimate`. PostgREST exact count vs estimate isn't
   exposed in the Brief 107 worker shape, so the pagination shows an
   exact "Showing X–Y of Z" string from whichever the worker provides.
5. **`<AnswerValue>` renderer prefers `prettyFormat` over `answer`** —
   JotForm payloads typically wrap each entry as
   `{answer, prettyFormat?, type, name, text}`; the `prettyFormat`
   string when present is the human-formatted version (e.g., currency,
   formatted date). Falls back to `answer` (and further to JSON
   pre-block) when `prettyFormat` is absent. This is the same
   precedence the worker's CSV renderer uses (Brief 107 `renderCsv` in
   `apps/jotform-worker/src/handlers/admin.js`).
6. **No "Raw JSON" gate by role** — the bottom-of-page `<details>` block
   is rendered for any caller who can reach the detail page, not gated
   to super_admin. Rationale: the worker already enforces the
   site-number scope (out-of-scope rows return 404), so the row payload
   that lands in the page is by definition in-scope for the caller. The
   block is collapsed by default and labelled "debug" so it's visible
   noise floor, not a security signal.

### Latent issues found

- **`/admin/jotform/[form_id]` shows `form_id` as the title for
  non-admin-tier callers** — because the listForms endpoint is gated to
  admin-tier (Brief 107 worker shape). RM/RD/GM users navigating to
  `/admin/jotform/250855287972067` see "250855287972067" as the page
  heading until the worker is widened to surface form display_names on
  the submissions response or expose a public-tier `/forms` variant.
  Low-impact (form IDs are stable, operator-stated form cap is 5–6), but
  worth a v2 brief to add `form_display_name` to the submissions
  response.
- **Per-form site_number filter dropdown not painted** — the worker
  accepts `?site_number=` (Brief 107) but the v1 UX doesn't expose it.
  Operators who want to narrow further can edit the URL or use CSV
  export + spreadsheet filter. Brief 109's out-of-scope list flagged
  this; left for v2.
- **Generic alphabetical-key renderer means form-specific UX is
  uniform across all 4 forms** — answer keys like `q15_field` show up
  alphabetically rather than in source-form order. For rewash and salt
  log this is acceptable (most fields are self-evident from the key);
  for retention's larger payload it could be noisy. Flag for v2 if
  operator reports finding it cryptic during smoke testing.
- **Empty `row.answers` payload doesn't error** — renders "No answers
  recorded for this submission." cleanly. Worth a glance during smoke
  testing on a backfilled row if the operator sees one (legacy
  pre-normalize entries might be sparse).

### Validation results

- `pnpm typecheck` — **18/18 green**. The first run hit a flaky Windows
  TypeScript lib-merge issue (`@cloudflare/workers-types` ↔
  `lib.webworker.d.ts` conflicts) on `@splash/http`'s cache-miss step;
  the second run hit Turbo's cache and went clean. Reproduced this on
  the stashed pre-change state too — same flake unrelated to this
  brief's diff.
- `pnpm --filter @splash/web build` — **succeeds**. New routes' bundle:
  - `/admin/jotform` — 172 B / 105 kB First Load
  - `/admin/jotform/[form_id]` — 924 B / 106 kB First Load
  - `/admin/jotform/[form_id]/[submission_id]` — 172 B / 105 kB First Load

  All well under the 5 kB / 150 kB targets the brief flagged.
  `/admin/dashboard` itself moved from 164 B (Brief 100 baseline) to
  164 B (unchanged — the async + filter logic doesn't add client weight).
- No worker change, no schema change, no env/secret change.
