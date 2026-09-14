# Brief 154: Promotions — promo CRUD endpoints (list, create, detail)

**Status:** Completed (2026-06-05)
**Started:** 2026-06-05
**Completed:** 2026-06-05
**Blocks:** apps/web pages for the promo feature (`/admin/promotions`, `/admin/promotions/new`, `/admin/promotions/[id]`); ticket-update endpoints (Brief 155) layer on top of the detail response shape.
**Dependencies:** Brief 153 (promo-worker substrate, `gatePromoRole`, `getAuthContext` with `promoRole`, R2 binding). Schema in `supabase/promo-tables.sql` already applied.

## Read first

- BUILD_STATE.md.
- CLAUDE.md — particularly the new glossary entry for **promo-worker** (Brief 153) and constraints #3, #4, #6.
- supabase/promo-tables.sql — column shapes for `promotions`, `promo_locations`, `promo_tickets`, `promo_activity_log`.
- BRIEFS/brief-153-promo-worker-foundation.md — the scaffold this brief builds on; reuse the `Env` interface and the dispatch structure already in `apps/promo-worker/src/index.ts`.
- BRIEFS/brief-094-forms-admin-api-crud.md — recent CRUD endpoint brief; reference for response shapes, error JSON, and the discriminated payload validation pattern.
- apps/forms-worker/src/admin/forms.ts — runnable example of the same pattern (list/create/detail) with PostgREST direct fetch.
- packages/db-supabase/src/auth-context.ts — `getAuthContext()` after Brief 153 lands; reads `promoRole`.
- packages/db-supabase/src/promo.ts — `gatePromoRole` helper from Brief 153.
- packages/http/src/index.ts — `jsonError`, `isOriginAllowed`.

## Architecture context

This brief lands the first three operator-facing endpoints on `splash-promo`. Together they let apps/web render the dashboard list (`/admin/promotions`), the create form (`/admin/promotions/new`), and the live-view detail page (`/admin/promotions/[id]`). Ticket-specific writes (assignment, internal_note, status change) land in Brief 155; materials + PTP in Brief 156; announcement send in Brief 157.

**Endpoint inventory:**

- `GET  /promo/api/promos` — list with filters + counts. Any-role gate.
- `POST /promo/api/promos` — create promo + seed ticket + seed locations + log. `super_admin | it | marketing` only.
- `GET  /promo/api/promos/{id}` — detail with nested ticket, locations, materials, ptp, recent activity. Any-role gate. `internal_note` field stripped for non-IT callers (defense in depth; IT-only field lives on the response only when caller is `super_admin | it`).

**Auth posture.** Per Brief 153's `gatePromoRole`, every handler reads `session.promoRole` and short-circuits on null. The CSRF gate (`isOriginAllowed`) sits on POST only — Splash convention since Brief 17. CSRF skips on GET per the same convention (same-origin GETs from apps/web don't carry Origin per spec).

**No transaction.** PostgREST doesn't expose multi-table transactions directly. The create flow is sequential (promotions → promo_tickets → promo_locations → promo_activity_log) with a best-effort rollback (DELETE of the promotion row) on intermediate failure, mirroring the Brief 29 Add Location pattern. If rollback also fails, the activity log entry won't exist and the row is flagged for SQL cleanup — log it loud (`[promo.create] partial create — rollback failed`).

**Response shape.** camelCase at the wire. Snake_case DB columns get mapped at the worker seam (`title`, `promoType`, `posBehavior`, `proposedStartDate`, `proposedEndDate`, `requestedGoLiveDate`, `priority`, `status`, `locations` as `string[]` of location_codes, `ticket: { readyByDate, roadblocks, assigneeUserIds: uuid[] }`, etc.). The list endpoint returns a denser shape (no nested ticket; just `assigneeCount` for the queue badge). Detail returns the full tree.

**Pagination.** v1: `?limit=N` (default 100, max 500) + `?offset=N` (default 0). No keyset; promo volume is tens-to-hundreds, not thousands. Future brief can add keyset if volume warrants.

## Context

Promo CRUD is the substrate every UI surface depends on. The mockup's dashboard page renders from `GET /promos`; the new-promo form posts to `POST /promos`; the live view + IT ticket page both read from `GET /promos/{id}`. After this brief lands, Brief 158 can build the apps/web pages against a real worker contract.

The IT-ticket-side writes (assignee add/remove, ready_by update, internal_note write, roadblocks update) are deferred to Brief 155 because they have a separate permission story (IT-only writes, IT-only internal_note read) and benefit from their own validation pass.

## Scope

### Phase 1 — Handler skeleton

Extend `apps/promo-worker/src/index.ts` dispatch to route the three new paths. Move actual handlers into `apps/promo-worker/src/handlers/promos.ts` (one file, three exports) to keep `index.ts` readable as endpoints multiply.

```ts
// apps/promo-worker/src/index.ts (delta vs. Brief 153)
import { handleListPromos, handleCreatePromo, handleGetPromo } from "./handlers/promos";

// inside fetch handler, before the existing 404 fallback:
if (url.pathname === "/promo/api/promos") {
  if (request.method === "GET")  return handleListPromos(request, env);
  if (request.method === "POST") return handleCreatePromo(request, env, ctx);
}
const detailMatch = url.pathname.match(/^\/promo\/api\/promos\/([0-9a-f-]+)$/);
if (detailMatch && request.method === "GET") {
  return handleGetPromo(request, env, detailMatch[1]);
}
```

### Phase 2 — `GET /promo/api/promos` (list)

**Auth:** `getAuthContext(request, env)` → `gatePromoRole(session.promoRole, [])` (require any non-null role). Reject 401 if no session, 403 if `promoRole === null`.

**Query params:**

- `status` — filter on `promotions.status`. Comma-separated allowed: `?status=Submitted,Scoped,Building`.
- `priority` — single value (`High|Medium|Low`).
- `assigned_to_me` — `1` filters to promos where the caller's `user_id` is in `promo_ticket_assignees`. Done with a `?user_id=in.(...)` PostgREST embed or a separate scope-pre-resolution.
- `search` — case-insensitive substring on `title` (PostgREST `ilike.*{q}*`).
- `limit` — default 100, max 500.
- `offset` — default 0.

**Query strategy.** Single PostgREST GET against `promotions` with embeds for `promo_tickets` (assignee count via a count-only embed) and `promo_locations` (location_code array). Pseudocode:

```
GET {SUPABASE_URL}/rest/v1/promotions
  ?select=
    id,title,promo_type,priority,status,
    proposed_start_date,proposed_end_date,requested_go_live_date,
    created_at,updated_at,
    ticket:promo_tickets!inner(ready_by_date,assignees:promo_ticket_assignees(user_id)),
    locations:promo_locations(location_code)
  &order=created_at.desc
  &limit=...
  &offset=...
```

Map to response. Compute `locationCount` and `assigneeCount` server-side so the dashboard can render counters without traversing arrays client-side.

**Response shape:**

```json
{
  "promos": [
    {
      "id": "uuid",
      "title": "Memorial Day BOGO",
      "promoType": "BOGO",
      "priority": "High",
      "status": "Building",
      "proposedStartDate": "2026-05-25",
      "proposedEndDate": "2026-05-30",
      "requestedGoLiveDate": "2026-05-23",
      "createdAt": "2026-...",
      "updatedAt": "2026-...",
      "readyByDate": "2026-05-20",
      "locationCount": 4,
      "locationCodes": ["batavia_ii", "geneva_ii", "cicero", "oswego"],
      "assigneeCount": 2,
      "completedLocationCount": 2
    }
  ],
  "total": 47,
  "limit": 100,
  "offset": 0
}
```

`total` uses PostgREST's `Content-Range` header with `Prefer: count=estimated` (cheap on large tables, exact-enough for UI).

### Phase 3 — `POST /promo/api/promos` (create)

**Auth:** session + `gatePromoRole(session.promoRole, ['super_admin', 'it', 'marketing'])`. Reject 403 for `ops`-only callers. CSRF gate (`isOriginAllowed`) first.

**Request body (JSON):**

```json
{
  "title": "Memorial Day BOGO",
  "promoType": "BOGO",
  "posBehavior": "...",
  "proposedStartDate": "2026-05-25",
  "proposedEndDate": "2026-05-30",
  "requestedGoLiveDate": "2026-05-23",
  "priority": "High",
  "locationCodes": ["batavia_ii", "geneva_ii", "cicero", "oswego"]
}
```

**Validation (server-side; mirror UI-side gates from the mockup):**

- `title` — required, non-empty, trimmed, ≤500 chars.
- `promoType` — required, must be one of `Same | BOGO | Add-ons | Discount | Other`.
- `posBehavior` — required for `BOGO | Add-ons | Discount`; optional for `Same | Other`. Mirrors the user's earlier note about UI-side gating; worker re-checks as defense in depth.
- `proposedStartDate`, `proposedEndDate`, `requestedGoLiveDate` — required, valid ISO dates, `proposedStartDate <= proposedEndDate`, `requestedGoLiveDate <= proposedStartDate` (warning, not blocking — the operator may intentionally request go-live after start).
- `priority` — required, one of `High | Medium | Low`.
- `locationCodes` — required, non-empty array of strings, each ≤64 chars, deduped server-side. No FK check (location_code is text per Brief 153 / 89 convention; the resolver in the future apps/web side will validate against `pricing_simple`).

**Sequence (best-effort; rollback on intermediate failure):**

1. Insert `promotions` row. Capture `id`. Set `created_by = session.userId`, `status = 'Submitted'`.
2. Insert `promo_tickets` row (`promo_id = new id`, all other fields NULL). 1:1 PK enforces no duplicate.
3. Bulk insert `promo_locations` rows — one per `locationCodes[]` value, `is_complete = false`.
4. Insert `promo_activity_log` row with `activity_type = 'created'`, `actor_user_id = session.userId`, `details = { title, locationCount, promoType, priority }`.

**Rollback on step 2 / 3 / 4 failure:** DELETE the `promotions` row (CASCADE cleans the inserted children). Log `[promo.create] partial — rolled back`. Return 500 with body `{"error":"promo_create_failed", "message":"Partial state rolled back."}`.

If rollback itself fails: log `[promo.create] partial — ROLLBACK FAILED — manual SQL cleanup required for promo {id}`. Return 500 with same shape plus `"orphan_id": "{id}"` so the operator can SQL-delete it later.

**Response (201):**

```json
{
  "ok": true,
  "promo": {
    "id": "uuid",
    "title": "...",
    "status": "Submitted",
    ... // same shape as GET detail, minimal nested data
  }
}
```

### Phase 4 — `GET /promo/api/promos/{id}` (detail)

**Auth:** any non-null `promoRole`.

**Query strategy.** Single PostgREST GET with deep embeds. Pseudocode:

```
GET {SUPABASE_URL}/rest/v1/promotions
  ?select=
    *,
    ticket:promo_tickets!inner(
      ready_by_date, roadblocks, internal_note,
      created_at, updated_at, ready_by_updated_at, ready_by_updated_by,
      assignees:promo_ticket_assignees(user_id, assigned_at, assigned_by)
    ),
    locations:promo_locations(location_code, is_complete, completed_at, completed_by),
    materials:promo_materials(id, name, kind, r2_key, file_mime, file_size_bytes, uploaded_at, uploaded_by),
    ptp:promo_ptp(purpose, tools, process, updated_at, updated_by),
    activity:promo_activity_log(id, actor_user_id, activity_type, details, created_at)
  &id=eq.{id}
  &activity.order=created_at.desc
  &activity.limit=20
```

`materials`, `ptp`, `activity` may be empty arrays / null at v1 (no endpoints exist to populate them yet); the response still returns the keys so apps/web can render skeletons without conditional branches.

**`internal_note` stripping for non-IT callers.** When `session.promoRole !== 'super_admin' && session.promoRole !== 'it'`, delete the `ticket.internalNote` field from the response object before sending. The worker reads the field unconditionally (cheap) and strips at the seam (defense in depth — apps/web side will gate the UI, this stops a curl'd response from leaking IT-only context to marketing/ops).

**Response (200):**

```json
{
  "promo": {
    "id": "uuid",
    "title": "...",
    "promoType": "BOGO",
    "posBehavior": "...",
    "proposedStartDate": "2026-05-25",
    "proposedEndDate": "2026-05-30",
    "requestedGoLiveDate": "2026-05-23",
    "priority": "High",
    "status": "Building",
    "createdAt": "...",
    "createdBy": "uuid",
    "updatedAt": "...",
    "statusUpdatedAt": "...",
    "statusUpdatedBy": "uuid",
    "ticket": {
      "readyByDate": "2026-05-20",
      "roadblocks": "...",
      "internalNote": "...",        // only present when caller is super_admin or it
      "assignees": [
        { "userId": "uuid", "assignedAt": "...", "assignedBy": "uuid" }
      ],
      "createdAt": "...",
      "updatedAt": "..."
    },
    "locations": [
      { "locationCode": "geneva_ii", "isComplete": false, "completedAt": null, "completedBy": null }
    ],
    "materials": [],
    "ptp": null,
    "activity": [
      { "id": "uuid", "actorUserId": "uuid", "activityType": "created", "details": {...}, "createdAt": "..." }
    ]
  }
}
```

**404 shape** on missing id: `{"error":"promo_not_found"}`.

### Phase 5 — Error handling

Centralize JSON error responses via `jsonError(code, message)` from `@splash/http`. Standard codes:

- `unauthorized` (401) — no session cookie or invalid.
- `forbidden` (403) — session valid but `promoRole` insufficient.
- `bad_request` (400) — validation failed; include `fields: { fieldName: 'error_code' }` on the validation branch.
- `not_found` (404) — promo id doesn't exist.
- `promo_create_failed` (500) — covered above.

### Phase 6 — Doc updates

1. **BUILD_STATE.md** — Findings log entry + Brief 154 status.
2. **BRIEFS/INDEX.md** — new row.
3. **CLAUDE.md** — extend the **promo-worker** glossary entry with the three new endpoints' inventory (mirror how the workorders / forms entries enumerate their endpoints).
4. No PRE_DEPLOY_PROMO.md update needed beyond a single sentence in the smoke-checks section noting "post-Brief-154: confirm `GET /promo/api/promos` returns `{"promos": [], "total": 0, "limit": 100, "offset": 0}` for an empty DB".

### Phase 7 — Build verification

- `pnpm typecheck` — must pass.
- `pnpm --filter @splash/promo-worker build` — clean dist; log compressed bundle size in Outcome.
- Smoke checks (manual, post-deploy):
  - `POST /promo/api/promos` with a minimal valid body → 201 + promo object. Verify in Supabase: `SELECT * FROM promotions ORDER BY created_at DESC LIMIT 1;` shows the row; `SELECT * FROM promo_locations WHERE promo_id = '...'` shows the location rows; `SELECT * FROM promo_activity_log WHERE promo_id = '...'` shows the `created` entry.
  - `GET /promo/api/promos` → returns the just-created promo.
  - `GET /promo/api/promos/{id}` → returns the detail tree, `ticket.internalNote` present (caller is super_admin).
  - `POST` from a curl with an `ops`-role user (operator can seed via `INSERT INTO promo_user_roles ... VALUES ('user-uuid', 'ops')`) → 403.
  - `GET /promo/api/promos/{id}` as the ops user → `ticket.internalNote` is absent from the response.

## Definition of Done

- `apps/promo-worker/src/handlers/promos.ts` exists and exports `handleListPromos`, `handleCreatePromo`, `handleGetPromo`.
- `apps/promo-worker/src/index.ts` dispatches the three routes.
- Worker passes typecheck + build.
- Manual smoke checks from Phase 7 pass; results recorded in the Outcome.
- One row each in `promotions`, `promo_tickets`, `promo_locations` (N rows), `promo_activity_log` after a successful `POST`.
- Internal-note stripping verified for a non-IT caller.
- Rollback path observed at least once via a deliberate failure (e.g., invalid `locationCodes` shape that bypasses pre-validation — simulate by SQL'ing a CHECK constraint violation) and confirmed the orphan `promotions` row is gone afterward.
- Docs updated per Phase 6.

## Out of scope (later briefs)

- PATCH endpoints on promotions or tickets — Brief 155 (ticket-specific) and Brief 156 (status transitions) handle these.
- Materials upload — Brief 156.
- PTP write — Brief 156.
- Announcement send — Brief 157.
- apps/web pages — Brief 158.
- Per-promo ACL (creator + assignee bypass on the role gate) — v2; current is role-only.
- Pagination keyset — v2 when volume warrants.

## Outcome

- **Files created (1):**
  - `apps/promo-worker/src/handlers/promos.ts` — three exported handlers (`handleListPromos`, `handleCreatePromo`, `handleGetPromo`) plus shared helpers (`pgHeaders`, `jsonResponse`, `requireServiceKey`, `gateCaller`, `validateCreateBody`, `validateIsoDate`, `parseContentRangeTotal`, `fetchPromoDetail`, `rollbackAndError`). PostgREST direct fetch() with the service-role key — same pattern as `apps/forms-worker/src/db/admin-forms.ts`. Zero new dependencies. ~850 LOC; if it grows much past 1000 LOC during Brief 155+, splitting into `apps/promo-worker/src/handlers/{list,create,detail}.ts` is the natural follow-up.

- **Files modified (5):**
  - `apps/promo-worker/src/index.ts` — imports the three handlers; dispatches `GET /promo/api/promos` (list) + `POST /promo/api/promos` (create) + `GET /promo/api/promos/{id}` (detail) before the default 404 fallback; returns `405 Method Not Allowed` for unsupported methods on known paths; file-header route inventory comment updated.
  - `CLAUDE.md` — extended the `promo-worker` glossary entry with the three new endpoints' inventory, mirroring how the workorders / forms entries enumerate theirs.
  - `BRIEFS/INDEX.md` — new top row for Brief 154.
  - `PRE_DEPLOY_PROMO.md` — §1 worker overview rewritten to reference the new live routes (instead of "ping only"); §6 smoke checks gained a 4th check verifying `GET /promo/api/promos` returns the empty-DB shape, 401 without cookie, 403 when `promo_role = NULL`.
  - `BUILD_STATE.md` — `Last updated` paragraph extended with the Brief 154 summary; new row for Brief 154 at the top of the prioritized work-list table.

- **Decisions made on operator's behalf:**
  1. **CSRF gate on POST only** — matches the Splash convention since Brief 17. Same-origin GETs from apps/web don't carry Origin per spec; gating GET on Origin would force every dev curl through hacks. POST is where state-changing intent lives.
  2. **Validation errors collapse to first-error-per-field** rather than returning every issue — keeps the response shape predictable for apps/web form handlers. The brief's example (`fields: { fieldName: 'error_code' }`) implied a single-error-per-field map.
  3. **`requestedGoLiveDate <= proposedStartDate` is a soft preference**, NOT a 400 rejection, per the brief's explicit note ("warning, not blocking — the operator may intentionally request go-live after start").
  4. **Detail handler uses `promo_tickets!left`**, not `!inner` as the brief's pseudocode showed — defensive over the unlikely-but-possible partial-state case (a row whose ticket insert failed mid-rollback still surfaces instead of 404-via-empty-result).
  5. **Malformed-UUID branch returns 404 `promo_not_found`**, NOT 400 `bad_request` — anti-leak (a curl probing IDs can't distinguish "doesn't exist" from "malformed shape"). Same posture as jotform-worker's anti-leak detail endpoint per Brief 107.
  6. **`parseContentRangeTotal` is a local helper** rather than a shared `@splash/db-supabase` export — single caller today. Promote if Brief 155+ needs it for its own list endpoint.
  7. **`assigned_to_me=1` pre-resolves via a separate `promo_ticket_assignees` query**, then intersects via `id=in.(...)`, rather than trying to express the join via PostgREST embed filter. PostgREST embed filters are doable but the inner-join semantics differ subtly across versions; the two-query approach is read-bounded by the count of promos the caller is assigned to (small, typically single digits) and is easy to reason about.
  8. **Detail's `ptp` embed normalization** tolerates both `{...}` and `[{...}]` shapes (PostgREST 1:1 embed shape varies by version) — same defensive pattern as the `ticket` embed.
  9. **Successful 201 mirrors the full detail shape**, not just `{ok:true, promo:{id, title, status}}` — reuses `fetchPromoDetail` so apps/web can navigate straight to the detail page without a second round-trip. The brief's example response said "same shape as GET detail, minimal nested data"; full-mirror was chosen as more useful.
  10. **`internal_note` stripping uses object-key omission via conditional spread** (`...(exposeInternalNote ? { internalNote: rawTicket.internal_note } : {})`) so the key is genuinely absent (not just `null`) on the response.
  11. **Validation for `locationCodes[]`** rejects rather than silently filters on non-string entries or oversized strings — conservative on shape; empty array after dedup flags `required`.

- **Latent issues found:**
  - (a) The brief's Phase 7 Definition-of-Done item to "observe the rollback path at least once via a deliberate failure" is operator-driven post-deploy. The worker code includes the rollback branch with both success ("partial — rolled back") and failure ("ROLLBACK FAILED") log lines; at the brief-executor level there's no way to trigger a real PostgREST failure mid-sequence without deploying. Operator can SQL'tweak a CHECK constraint temporarily to make step 3 or 4 fail.
  - (b) The `Env.PROMO_FILES` R2 binding is declared but unused at Brief 154. Material upload lands in Brief 156. No-op for build; binding stays so the next brief doesn't need to touch wrangler.toml.
  - (c) `Session.email` is read into `gateCaller`'s session object but never consumed downstream at Brief 154 — kept on the shape because Brief 155+ activity-log writes ("actor_email" for human-readable audits) will need it.
  - (d) No webhook secrets fired at this brief — `promo_activity_log` `created` entry is the only side effect beyond the row inserts. Future briefs (155+ ticket updates, 157 announcement send) will add notification fires.
  - (e) No CF deploys, no production-route bindings, no git commits per CLAUDE.md.

- **Validation results (typecheck / build / smoke):**
  - `pnpm typecheck` — **19/19 successful** (18 cached, promo-worker ran fresh). 3.4s. No type errors anywhere in the monorepo.
  - `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — succeeded. Wrangler 4.87.0 confirmed bindings: `env.PROMO_FILES (splash-promo-files)` R2 Bucket + `env.SUPABASE_URL` env var. Secrets (`SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`) are set via `wrangler secret put` and not shown in dry-run output. `.tmp-build` cleaned up.
  - Smoke checks (Phase 7) — operator-driven post-deploy. PRE_DEPLOY_PROMO.md §6 carries the new smoke item; the rollback exercise is flagged for operator follow-up.

- **Bundle size on splash-promo deploy:**
  - **729.33 KiB raw / 138.97 KiB gzip** via `wrangler deploy --dry-run`. Grew from Brief 153's 1.31 KiB raw / 0.69 KiB gzip because Brief 154's handlers pull in `@splash/auth` (with its `authenticate()` + `@supabase/supabase-js` transitive dep for `createServiceClient`), `@splash/db-supabase` (for the `gatePromoRole` re-export, which transitively brings in the rest of the package), and `@splash/types`. Plenty of headroom against CF's 3 MiB compressed / 10 MiB paid limits.
