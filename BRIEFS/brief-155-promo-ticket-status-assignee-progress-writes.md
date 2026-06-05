# Brief 155: Promotions — ticket / status / assignee / location-progress writes

**Status:** Completed (2026-06-05)
**Started:** 2026-06-05
**Completed:** 2026-06-05
**Blocks:** apps/web IT ticket detail page + live-view status controls (Brief 158); materials + PTP writes (Brief 156) are sibling, not dependent.
**Dependencies:** Brief 153 (substrate), Brief 154 (CRUD + detail response shape — this brief mutates the same nested fields the detail endpoint reads).

## Read first

- BUILD_STATE.md.
- CLAUDE.md — promo-worker glossary entry (post-Brief-154); the auto-status flip on terminal outcomes in forms-worker (Brief 131) is the pattern for the auto-Submitted→Scoped advance below.
- supabase/promo-tables.sql — column shapes for `promo_tickets`, `promo_ticket_assignees`, `promo_locations`, `promo_activity_log`; the audit-column pairs (`status_updated_at` / `status_updated_by`, etc.).
- BRIEFS/brief-153-promo-worker-foundation.md — `gatePromoRole`.
- BRIEFS/brief-154-promo-crud-endpoints.md — response shape this brief's writes must match on reflection (GET detail re-reads after PATCH and the wire shape must stay stable).
- apps/forms-worker/src/admin/submissions.ts — runnable example of a PATCH-style endpoint with activity-log-style audit (Brief 96).
- apps/promo-worker/src/handlers/promos.ts — handler folder pattern Brief 154 established.

## Architecture context

Brief 154 landed read + create. This brief lands every IT-side write the mockup demonstrated: the per-ticket field editor (`PATCH ticket`), the status pipeline (`PATCH status`), multi-assign add/remove, and the per-location done-checkbox toggle. Materials upload, PTP write, and announcement send all land separately (Brief 156, 157).

**Endpoint inventory (4 routes, 5 HTTP verbs):**

- `PATCH  /promo/api/promos/{id}/ticket`            — partial update of `ready_by_date`, `roadblocks`, `internal_note`. `super_admin | it`.
- `PATCH  /promo/api/promos/{id}/status`            — set `promotions.status` to any valid enum value. `super_admin | it | marketing`.
- `POST   /promo/api/promos/{id}/assignees`         — add a user to `promo_ticket_assignees`. `super_admin | it`.
- `DELETE /promo/api/promos/{id}/assignees/{userId}` — remove. `super_admin | it`.
- `PATCH  /promo/api/promos/{id}/locations/{locationCode}` — toggle `promo_locations.is_complete`. `super_admin | it`.

**Auth posture.** Same as Brief 154: `getAuthContext` → `gatePromoRole(role, [...])`. CSRF gate (`isOriginAllowed`) sits on every write. Marketing-tier gets status PATCH because in practice marketing flags promos as `Ended` when the campaign window closes — but everything else stays IT-only.

**Auto-status advance.** Mockup behavior: when `status === 'Submitted'` and a successful PATCH leaves the ticket with at least one assignee AND a non-null `ready_by_date`, auto-flip status to `Scoped` in the same write path. Mirror Brief 131's terminal-outcome auto-flip — the worker decides; the UI doesn't have to track the threshold. Belt-and-suspenders: emit BOTH the original activity log entry (the field that triggered the auto-flip) AND a `status_changed` entry with `details = { from: 'Submitted', to: 'Scoped', auto: true, trigger: 'ticket_ready' }`.

**Activity log per write.** Every write emits exactly one activity_log row (two on auto-flip — the trigger plus the synthetic `status_changed`). Details JSONB carries the delta:

- `ticket_updated` with `details = { fields: { readyByDate: 'changed', roadblocks: 'changed' } }` (which fields actually changed, not the values themselves — the value lives on the row).
- `internal_note_updated` separately when `internal_note` was in the patch — its own activity_type so non-IT viewers' activity feed can filter it out cleanly without inspecting JSONB.
- `roadblocks_updated` separately for the same reason (ops-visible vs IT-internal — easier to render distinct icons in the timeline if it's its own type).
- `status_changed` with `{ from, to, auto: bool }`.
- `assignment_changed` with `{ action: 'added' | 'removed', userId }`.
- `location_marked_complete` / `location_marked_incomplete` with `{ locationCode }`.

If a single PATCH ticket call modifies multiple fields, emit ONE `ticket_updated` row whose `details.fields` lists every changed field, PLUS the per-field-typed rows where applicable (`internal_note_updated`, `roadblocks_updated`). Adds one row of audit redundancy but keeps the filter contract simple (a "show only the things I can see" feed never has to inspect JSONB).

## Context

The mockup's IT ticket detail page is the densest write surface in the feature. Five separate UI controls (Save ticket, Save status / Advance, Assign-to dropdown, location checkboxes) all hit different endpoints. Brief 158's apps/web side maps each control to one of these five endpoints with a thin server-action wrapper, so the worker contracts here need to be stable before that brief queues.

The internal_note write is the load-bearing IT-only concern. Reads are already gated in Brief 154 (stripped from detail response for non-IT callers); writes are gated here. Two layers of defense — UI hides the field, worker rejects the write — keep IT context from leaking through either a curl OR a stale tab held by a since-demoted user.

## Scope

### Phase 1 — Handler skeleton

Extend `apps/promo-worker/src/index.ts` dispatch to route the new paths. Handlers live in a new file `apps/promo-worker/src/handlers/promo-writes.ts` (separate from `promos.ts` because the read/list path stays a different concern). Five exports: `handlePatchTicket`, `handlePatchStatus`, `handleAddAssignee`, `handleRemoveAssignee`, `handlePatchLocationProgress`.

```ts
// apps/promo-worker/src/index.ts (delta)
import {
  handlePatchTicket,
  handlePatchStatus,
  handleAddAssignee,
  handleRemoveAssignee,
  handlePatchLocationProgress
} from "./handlers/promo-writes";

// inside fetch, after the GET /promo/api/promos/{id} match:
const ticketMatch       = url.pathname.match(/^\/promo\/api\/promos\/([0-9a-f-]+)\/ticket$/);
const statusMatch       = url.pathname.match(/^\/promo\/api\/promos\/([0-9a-f-]+)\/status$/);
const assigneesMatch    = url.pathname.match(/^\/promo\/api\/promos\/([0-9a-f-]+)\/assignees$/);
const assigneeMatch     = url.pathname.match(/^\/promo\/api\/promos\/([0-9a-f-]+)\/assignees\/([0-9a-f-]+)$/);
const locationProgMatch = url.pathname.match(/^\/promo\/api\/promos\/([0-9a-f-]+)\/locations\/([a-z0-9_-]+)$/);

if (ticketMatch       && request.method === "PATCH")  return handlePatchTicket(request, env, ticketMatch[1]);
if (statusMatch       && request.method === "PATCH")  return handlePatchStatus(request, env, statusMatch[1]);
if (assigneesMatch    && request.method === "POST")   return handleAddAssignee(request, env, assigneesMatch[1]);
if (assigneeMatch     && request.method === "DELETE") return handleRemoveAssignee(request, env, assigneeMatch[1], assigneeMatch[2]);
if (locationProgMatch && request.method === "PATCH")  return handlePatchLocationProgress(request, env, locationProgMatch[1], locationProgMatch[2]);
```

### Phase 2 — `PATCH /promo/api/promos/{id}/ticket`

**Auth:** session + `gatePromoRole(role, ['super_admin', 'it'])` + `isOriginAllowed`.

**Body (JSON, all optional — partial update):**

```json
{
  "readyByDate": "2026-05-20",     // ISO date or null to clear
  "roadblocks": "...",             // text or null/empty to clear
  "internalNote": "..."            // text or null/empty to clear
}
```

**Validation:**

- Reject body with any unknown keys (400 `bad_request`, defense in depth against future schema drift).
- `readyByDate`: null OR valid ISO `YYYY-MM-DD`.
- `roadblocks`: null OR string, trimmed, ≤10000 chars.
- `internalNote`: null OR string, trimmed, ≤10000 chars.
- 404 if promo id doesn't exist.

**Sequence:**

1. Read current ticket row (single PostgREST GET). Capture before-state for delta computation.
2. Build the PATCH set with only the fields actually present in the body.
3. If `readyByDate` is being touched, also set `ready_by_updated_at = now()`, `ready_by_updated_by = session.userId`.
4. PATCH `promo_tickets WHERE promo_id = {id}`.
5. Compute deltas vs. step 1's before-state. For each changed field, write the appropriate activity_log row(s):
   - Always emit `ticket_updated` with `details.fields` listing the changed-field names.
   - Additionally emit `internal_note_updated` if `internalNote` was actually changed (not just present in body but unchanged from previous value).
   - Additionally emit `roadblocks_updated` if `roadblocks` was actually changed.
6. **Auto-status advance check.** Fetch the promo row + assignee count. If `promotions.status === 'Submitted'` AND assignee_count ≥ 1 AND new `ready_by_date` IS NOT NULL: PATCH `promotions.status = 'Scoped'`, stamp `status_updated_at = now()`, `status_updated_by = session.userId`, emit a `status_changed` activity_log with `details = { from: 'Submitted', to: 'Scoped', auto: true, trigger: 'ticket_ready' }`.

**Response (200):**

```json
{ "ok": true, "ticket": { ... }, "promoStatus": "Scoped" }
```

`promoStatus` reflects the post-auto-flip status so apps/web doesn't need a second GET to re-render the pipeline.

### Phase 3 — `PATCH /promo/api/promos/{id}/status`

**Auth:** session + `gatePromoRole(role, ['super_admin', 'it', 'marketing'])` + `isOriginAllowed`.

**Body:**

```json
{ "status": "Live" }
```

**Validation:**

- `status`: required, one of the six enum values (`Submitted | Scoped | Building | Tested | Live | Ended`). Worker accepts any valid status (no skip-step enforcement — UI suggests next; this endpoint is authoritative).
- 404 if promo id doesn't exist.
- 204-equivalent no-op if status is unchanged (still 200, but log a `status_changed` row? No — skip the activity log entry on a no-op; that's noise).

**Sequence:**

1. Read current `promotions.status`.
2. If unchanged, return 200 with `{ok: true, status, unchanged: true}` and emit no log row.
3. PATCH `promotions.status = new`, stamp `status_updated_at = now()`, `status_updated_by = session.userId`.
4. Emit `status_changed` activity_log row with `details = { from, to, auto: false }`.

**Response (200):**

```json
{ "ok": true, "status": "Live", "previousStatus": "Tested" }
```

### Phase 4 — `POST /promo/api/promos/{id}/assignees`

**Auth:** session + `gatePromoRole(role, ['super_admin', 'it'])` + `isOriginAllowed`.

**Body:**

```json
{ "userId": "uuid" }
```

**Validation:**

- `userId`: required, valid UUID v4 shape.
- Trust the UUID — no existence check against `auth.users` (cross-schema FK isn't enforced; if the operator supplies a junk UUID, no FK constraint to fail against, and a stale UUID surfaces as a "no row" condition in the assignees query later. Same posture as `created_by` / `actor_user_id` columns).
- Caller must NOT assign someone who lacks a promo_role — light verification step: read `auth_unified.promo_role` for the target user, reject 400 with `target_no_promo_role` if null. (Sysadmin can pre-grant the role; this just stops accidentally adding a non-promo user to the IT queue.)
- 404 if promo id doesn't exist.
- 409 `already_assigned` if a row already exists (`PRIMARY KEY (promo_id, user_id)` would 23505 otherwise).

**Sequence:**

1. Read target user's `promo_role` via `auth_unified` — reject if null per validation.
2. Insert into `promo_ticket_assignees` with `assigned_at = now()`, `assigned_by = session.userId`. Catch 23505 → return 409.
3. Emit `assignment_changed` activity_log with `details = { action: 'added', userId, assignedByEmail: session.email }` (email-on-actor for the dashboard timeline readability — UUIDs are unreadable in raw form).
4. Auto-status check (same as Phase 2 step 6) — adding the first assignee can trigger the Submitted → Scoped flip.

**Response (201):** `{ ok: true, assignee: { userId, assignedAt, assignedBy }, promoStatus: "..." }`

### Phase 5 — `DELETE /promo/api/promos/{id}/assignees/{userId}`

**Auth:** session + `gatePromoRole(role, ['super_admin', 'it'])` + `isOriginAllowed`.

**No body.**

**Sequence:**

1. DELETE from `promo_ticket_assignees WHERE promo_id = {id} AND user_id = {userId}`.
2. Check `RETURNING` (PostgREST's `Prefer: return=representation`) — if zero rows affected, return 404 `not_assigned`.
3. Emit `assignment_changed` activity_log with `details = { action: 'removed', userId, removedByEmail: session.email }`.
4. NO auto-status reversal — removing the last assignee on a Scoped promo doesn't bounce status back to Submitted. The reverse flip is rare enough that a manual status PATCH is fine.

**Response (200):** `{ ok: true, removed: true }`

### Phase 6 — `PATCH /promo/api/promos/{id}/locations/{locationCode}`

**Auth:** session + `gatePromoRole(role, ['super_admin', 'it'])` + `isOriginAllowed`.

**Body:**

```json
{ "isComplete": true }
```

**Validation:**

- `isComplete`: required boolean.
- 404 if no `promo_locations` row matches `(id, locationCode)` (caller is toggling something that isn't on the promo).
- `locationCode` URL segment is opaque text per Brief 153 convention — any non-empty `[a-z0-9_-]+` slug passes.

**Sequence:**

1. PATCH `promo_locations` WHERE `(promo_id, location_code)` matches.
2. On `isComplete = true`: stamp `completed_at = now()`, `completed_by = session.userId`. On false: clear both back to null.
3. Emit `location_marked_complete` OR `location_marked_incomplete` activity_log row with `details = { locationCode }`.

**Response (200):** `{ ok: true, locationCode, isComplete: bool, completedAt: "..." | null }`

### Phase 7 — Shared helper

`apps/promo-worker/src/handlers/_activity.ts` (new file, leading underscore = internal helper module convention used elsewhere in Splash worker code):

```ts
export async function logActivity(
  env: Env,
  promoId: string,
  actorUserId: string | null,
  activityType: string,        // CHECK constraint values from the schema
  details: Record<string, unknown> = {}
): Promise<void> {
  // PostgREST insert into promo_activity_log. Fail-soft: if the insert
  // throws, log via console.warn but DON'T fail the parent write —
  // activity log is observability, not correctness.
}
```

All five handlers + the auto-status path call this helper. Single import, no duplication.

### Phase 8 — Doc updates

1. **BUILD_STATE.md** — Findings + Brief 155 status.
2. **BRIEFS/INDEX.md** — new row.
3. **CLAUDE.md** — promo-worker glossary entry gains the five new endpoints under its endpoint inventory; the auto-status flip behavior gets one sentence ("`PATCH ticket` and `POST assignees` auto-advance `Submitted → Scoped` when assignee ≥ 1 AND ready_by NOT NULL — mirrors Brief 131's terminal-outcome auto-flip in forms").

### Phase 9 — Build + smoke

- `pnpm typecheck` + `pnpm --filter @splash/promo-worker build`.
- Smoke checks (manual, post-deploy; seed one promo via the Brief 154 POST first):
  - PATCH ticket sets readyByDate; status stays Submitted because no assignee yet.
  - POST assignees adds a user; status auto-flips to Scoped (since ready_by is already set). Verify the response carries `promoStatus: "Scoped"` and `promo_activity_log` shows BOTH an `assignment_changed` AND an auto `status_changed` row.
  - PATCH ticket sets internalNote as a super_admin caller — succeeds. PATCH ticket sets internalNote as an `ops` caller — 403.
  - PATCH status to Live — succeeds. PATCH status to Live again — succeeds with `unchanged: true`, no new activity row.
  - DELETE assignees/{userId} — succeeds; status does NOT bounce back. Re-DELETE — 404.
  - PATCH locations/geneva_ii { isComplete: true } — succeeds, `completed_at` populated. Toggle false — `completed_at` cleared.
  - PATCH locations/this_is_not_on_the_promo — 404.

## Definition of Done

- `apps/promo-worker/src/handlers/promo-writes.ts` + `_activity.ts` exist.
- All five endpoints respond per the contracts above.
- Auto-status flip works on both trigger paths (ticket PATCH and assignee POST).
- Activity log entries match the Architecture context's specification (one per write, plus the synthetic `status_changed` on auto-flips, plus per-field-typed entries when applicable).
- Internal note write rejected for non-IT callers (manual smoke verified).
- Typecheck + build pass; smoke checks recorded in Outcome.

## Out of scope (later briefs)

- Materials upload / delete — Brief 156.
- PTP write — Brief 156.
- Announcement send — Brief 157.
- apps/web pages consuming these endpoints — Brief 158.
- Status transition guards (e.g., can't move backward from Live without confirmation) — v2; UI can suggest, this endpoint stays permissive.
- Auto-status reversal on last-assignee-removed — explicitly deferred; manual PATCH covers the rare case.
- Bulk operations (assign multiple users in one call, toggle all locations in one call) — v2.

## Outcome

- **Files created (2).**
  - `apps/promo-worker/src/handlers/_activity.ts` — shared activity-log
    helper. Single exported function `logActivity(env, promoId,
    actorUserId, activityType, details)` that wraps a PostgREST POST to
    `promo_activity_log` with `Prefer: return=minimal`. Try/catch
    wraps both the fetch and the response check; non-2xx + thrown
    errors log `[promo.activity] insert {failed|threw} (non-fatal)`
    and return cleanly. Allow-list type `PromoActivityType` mirrors the
    `promo_activity_log` CHECK constraint (12 values from Brief 153's
    DDL: `created | status_changed | assignment_changed |
    ticket_updated | roadblocks_updated | internal_note_updated |
    material_added | material_removed | ptp_updated |
    location_marked_complete | location_marked_incomplete |
    announcement_sent`). Brief 155 introduces ZERO new activity_type
    values — every type used here was already declared at Brief 153.
    ~75 LOC. Leading underscore on the filename signals "internal
    helper module" per the brief's Phase 7 convention.
  - `apps/promo-worker/src/handlers/promo-writes.ts` — the five
    exported handlers (`handlePatchTicket`, `handlePatchStatus`,
    `handleAddAssignee`, `handleRemoveAssignee`,
    `handlePatchLocationProgress`) plus their shared helpers
    (`pgHeaders`, `jsonResponse`, `requireServiceKey`, `gateCaller`
    (duplicated from `promos.ts` per the brief's "separate from
    promos.ts" split), `fetchPromoState` (single-round-trip GET
    joining `promotions.status` + `promo_tickets.*` +
    `promo_ticket_assignees(user_id)` for the count),
    `maybeAutoAdvanceStatus` (fail-soft Submitted→Scoped auto-flip
    helper), `validateIsoDate`, `isPlainObject`). ~860 LOC. PostgREST
    direct fetch() with the service-role key (same pattern as Brief
    154 — no `@supabase/supabase-js` client in worker code).

- **Files modified (4).**
  - `apps/promo-worker/src/index.ts` — imports the five new handlers;
    dispatches the new routes (`PATCH .../ticket`, `PATCH .../status`,
    `POST .../assignees`, `DELETE .../assignees/{userId}`,
    `PATCH .../locations/{locationCode}`) BEFORE the existing default
    404; per-route method gating returns `405 Method Not Allowed` on
    unsupported methods (e.g., `GET /promo/api/promos/{id}/ticket`);
    the route regex for the locationCode segment is case-sensitive
    (`[a-z0-9_-]+`, NO `i` flag) per the Brief 153 slug convention;
    the promoId segment regex keeps `i` (hex UUID, case-insensitive).
    File-header route inventory comment rewritten to surface the
    9-endpoint surface.
  - `BRIEFS/INDEX.md` — new top row for Brief 155 with the per-endpoint
    summary mirroring the style of the existing Brief 154 row.
  - `CLAUDE.md` — extended the existing `promo-worker` glossary entry
    with a Brief 155 paragraph that documents the five new endpoints
    (per-endpoint signatures + roles + validation + activity-log
    shape), the auto-status advance behavior + trigger conditions, the
    shared `logActivity` helper, and the 11-code standard error
    taxonomy. Mirrors the style of the existing Brief 154 paragraph
    in the same entry.
  - `BUILD_STATE.md` — bumped "Last updated" to 2026-06-05 with the
    Brief 155 entry prepended on line 3 (the previous Brief 154
    chain becomes `— Previously:` ); new top row in the prioritized
    work list table; new top row in the Findings & decisions log.

- **Decisions made on operator's behalf (15).**
  1. **`gateCaller` is duplicated, not shared.** Brief was explicit
     that the write file is "separate from promos.ts because the
     read/list path stays a different concern." Promoting the gate to
     a shared helper module is a future-cleanup candidate once a
     third file needs the same helper.
  2. **`fetchPromoState` is single-round-trip.** One PostgREST GET
     joins promotions.status + promo_tickets.* +
     promo_ticket_assignees (just user_id, for the count). The
     handler uses this output for existence check + before-state
     delta computation + auto-flip evaluation — three separate
     concerns folded into one query for efficiency. Mirrors the
     Brief 154 detail handler's defensive object-vs-array embed
     normalization.
  3. **Auto-status PATCH is fail-soft.** The brief's Phase 7 helper
     signature was "Fail-soft: if the insert throws... DON'T fail the
     parent write," directly applicable to the activity log. The
     brief was silent on the promotions PATCH for auto-flip. The
     implementation extends fail-soft to the auto-flip's promotions
     PATCH too — the trigger write already succeeded, and the
     auto-advance is a UX hint not a correctness guarantee. The
     response's `promoStatus` carries the actual post-flip status
     (so apps/web renders the truthful state), not the
     desired-but-failed `Scoped`.
  4. **`updated_at` always bumps on PATCH ticket.** The
     `promo_tickets` DDL declares `updated_at` with a default but no
     auto-update trigger. The handler explicitly sets it on every
     PATCH so the timestamp reflects the actual last-touched time.
  5. **Ticket PATCH no-op accepts as 200 without rewriting the row.**
     Empty body or all-fields-unchanged → respond with the
     before-state shape and emit no activity log. Apps/web can
     submit-with-no-changes without spamming the timeline.
  6. **Per-field-typed activity rows.** The brief's Architecture
     context specified emitting `ticket_updated` AND
     `internal_note_updated` AND `roadblocks_updated` separately when
     applicable — "non-IT viewers' activity feed can filter it out
     cleanly without inspecting JSONB." The implementation emits the
     umbrella row whenever any field changed, then per-field-typed
     rows only when those specific fields actually changed. Adds
     one row of audit redundancy but keeps the filter contract
     simple.
  7. **Activity log `details.fields` carries camelCase field names**
     (`readyByDate`, not `ready_by_date`) so the JSONB matches the
     API's response shape. Future apps/web timeline renderers don't
     need a snake_to_camel pass.
  8. **PK-collision detection uses dual signals** — HTTP 409 OR
     substring `23505` in the response body. PostgREST surfaces
     SQLSTATE in the JSON error body but the HTTP status code varies
     by version; checking both is cheap and version-agnostic.
  9. **`already_assigned` is 409, NOT 200-no-op.** The brief's Phase
     4 sequence says "Catch 23505 → return 409." A no-op would lose
     the audit log entry that the operator tried to add a duplicate.
     409 surfaces the duplicate intent.
  10. **DELETE assignee 404 covers both promo-missing AND
      not-actually-assigned.** Anti-leak — a curl probing promo+user
      pairs can't distinguish "promo doesn't exist" from "user wasn't
      assigned" (same posture as jotform-worker's anti-leak detail
      endpoint per Brief 107).
  11. **Auto-status advance does NOT reverse on
      last-assignee-removed.** The brief was explicit: "removing the
      last assignee on a Scoped promo doesn't bounce status back to
      Submitted." Manual PATCH covers the rare case.
  12. **`location_marked_*` is per-action activity_type**, not a
      single `location_progress_changed` type with an `isComplete`
      flag in details. Both shapes are valid; the per-action shape
      matches the schema's CHECK constraint allow-list (which already
      declared the two terminal-shape types in Brief 153) and gives
      the future timeline distinct icons per action.
  13. **Internal-note response stripping is object-key omission**,
      not null-replacement (`...(exposeInternalNote ? { internalNote:
      ... } : {})`). Same posture as Brief 154's detail handler — a
      curl'd response can't even SEE the key for non-IT callers.
  14. **Location code regex (`[a-z0-9_-]+`) does NOT use the `i` flag
      on the route regex** — slugs are lowercase by Brief 153
      convention. The promoId segment regex keeps its `i` flag (hex
      UUID; case doesn't materially matter).
  15. **`ticket_missing` is its own 500 error code**, not generic
      `patch_failed`. Surfaces the 1:1 invariant violation (promo
      exists but its `promo_tickets` row doesn't — which the Brief
      154 create flow makes impossible barring partial rollback).
      Distinct error code aids debugging without leaking schema
      details.

- **Latent issues found.**
  - Apps/web side does NOT exist at Brief 155 — the IT ticket detail
    page lands in Brief 158. Worker contracts validated via headless
    typecheck + bundle build; live smoke checks (brief Phase 9)
    operator-driven post-deploy.
  - The handler file is ~860 LOC. Acceptable today; if Brief 156
    pushes past ~1200 LOC consider splitting per-handler into
    `apps/promo-worker/src/handlers/writes/{ticket,status,assignees,
    locations}.ts`.
  - Per the brief's Out-of-scope — bulk operations (multi-assignee
    in one call, all-locations toggle), status transition guards
    (the worker stays permissive; UI can suggest), and auto-status
    reversal on empty-assignees are all v2 candidates.
  - `PROMO_FILES` R2 binding is still unused at Brief 155; material
    upload lands in Brief 156. No-op on build size, no-op on
    wrangler.toml.
  - The 409-dedup substring match against `23505` works for PostgREST
    12.x (which surfaces the SQLSTATE in the response body). Future
    PostgREST upgrades changing the error body shape would need a
    recheck — but the HTTP 409 status check would still cover the
    common case.
  - The brief's Phase 7 helper signature shows `actorUserId: string |
    null` — the implementation matches; the auto-flip path passes the
    operator's `session.userId` (NOT null) so the synthetic
    `status_changed` row attributes correctly to the user who
    triggered it.

- **Validation results (typecheck / build / smoke).**
  - Root `pnpm typecheck` — **19/19 green** (18 cached, promo-worker
    ran fresh, 1.574s).
  - `pnpm --filter @splash/promo-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — **succeeded**. Wrangler 4.87.0
    confirmed bindings: `env.PROMO_FILES (splash-promo-files)` R2
    Bucket + `env.SUPABASE_URL` env var. Secrets
    (`SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`) not displayed in
    dry-run output (set via `wrangler secret put`). `.tmp-build`
    cleaned up.
  - Smoke checks per brief Phase 9 are operator-driven post-deploy
    (headless cannot exercise live session cookies + live PostgREST).
    The brief's Phase 9 explicitly says "manual, post-deploy."

- **Bundle size on splash-promo deploy.**
  - **754.86 KiB raw / 141.85 KiB gzip** (up from Brief 154's 729.33
    KiB raw / 138.97 KiB gzip).
  - Delta: +25.53 KiB raw / +2.88 KiB gzip. The new code is dominated
    by the five handlers' JSON validation + delta computation paths
    plus the shared `_activity.ts` helper. Plenty of headroom against
    CF's 3 MiB compressed / 10 MiB paid limits.
