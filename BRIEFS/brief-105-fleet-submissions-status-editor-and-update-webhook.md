# Brief 105: Fleet submissions — dashboard status editor + per-edit webhook to PA for SharePoint sync

**Status:** Completed (2026-05-11)
**Started:** 2026-05-11
**Completed:** 2026-05-11
**Blocks:** Neither (additive: new admin field, new fail-soft webhook;
when the secret is unbound the dashboard PATCH still succeeds and
SharePoint just lags).
**Dependencies:** Brief 81 (introduced the monorepo fleet-inquiry-worker
copy — the worker this brief extends), Brief 83 (added admin GET/PATCH
endpoints + apps/web `/admin/fleet/[id]` editor — this brief widens
both surfaces), Brief 87 (added the splash_notes editor + last-write-
wins pattern this brief extends to status), Brief 101 / 102 (the
fail-soft per-event webhook pattern this brief mirrors —
`CLAIM_UPDATE_WEBHOOK_URL` / `INTERNAL_NEW_CLAIM_WEBHOOK_URL`).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-081-fleet-inquiry-worker-lift-and-shift.md (the
  worker; note `status: "new"` is set explicitly by the worker at
  insert time — `apps/fleet-inquiry-worker/src/index.js` ~L371)
- BRIEFS/brief-083-fleet-submissions-admin-viewer.md (the auth /
  endpoint shape this brief extends)
- BRIEFS/brief-087-fleet-detail-splash-notes-editor.md (the
  ActionForm pattern + the existing PATCH this brief widens)
- BRIEFS/brief-101-damage-manage-update-notifications.md
  (per-event webhook pattern + `ctx.waitUntil`-style fire-and-forget
  posture; reuse the JSON envelope shape where it fits)
- apps/fleet-inquiry-worker/src/admin.js (`handleUpdateSubmission`
  ~L323-377 — the PATCH this brief extends; strict allow-list will
  widen)
- apps/fleet-inquiry-worker/src/index.js (~L371 — confirms `status:
  "new"` is worker-set, not a Supabase default)
- apps/web/app/admin/fleet/[id]/page.tsx (the detail page — add
  status dropdown beside the splash_notes textarea)
- apps/web/app/admin/fleet/[id]/actions.ts (the server action — wire
  status alongside splash_notes via the same `<ActionForm>`)
- apps/web/app/admin/fleet/_lib/worker-fetch.ts (~L170-184 —
  `updateFleetSubmissionNotes`; extend signature to accept status)
- apps/web/app/admin/fleet/page.tsx (~L209-215 — `StatusPill`; verify
  it handles all four enum values)
- PRE_DEPLOY_FLEET.md (append a section documenting the new
  `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL` secret + operator's PA-flow
  setup steps; mirror the Brief 87 splash_notes section's shape)

## Context

Today the only place an operator can edit a fleet submission's
**status** (`new → reviewed → contacted → closed`) is SharePoint.
The 30-minute PA flow that ingests new submissions from Supabase
also lets the team toggle status there. Brief 87 moved
`splash_notes` editing into the dashboard but left status on the
SharePoint side.

Operator confirmed today (2026-05-11) that **Supabase should become
authoritative for both status and splash_notes**, and that
SharePoint should receive every change via a per-edit webhook
mirroring the Brief 101 / 102 pattern. Reasons:

- Per-edit webhook gives near-realtime sync without polling.
- A 30-minute diff approach would require comparing every Supabase
  row against the SharePoint mirror — heavier and brittle for what
  the operator confirmed is a **low-volume** change rate.
- The existing 30-minute PA flow for new-submission ingest stays
  untouched; this brief adds a parallel update channel.
- Fail-soft contract: when the secret is unbound or PA is down,
  the dashboard PATCH still succeeds and Supabase records the
  edit. Sync just lags until PA catches up or someone runs a
  one-time backfill.

**Status enum.** `new` | `reviewed` | `contacted` | `closed`. Worker-
side validation rejects anything else with 400. The dashboard
dropdown's options match this list.

**Audit columns.** Two pairs added to `fleet_submissions`:
- `status_updated_at timestamptz` + `status_updated_by text`
- `splash_notes_updated_at timestamptz` + `splash_notes_updated_by text`

Worker stamps the appropriate pair on each PATCH based on which
fields are being changed. Mirror Brief 96's pattern on the forms
submissions admin where these column conventions are also used.

**Per-edit webhook payload.** Includes the full updated row (so PA
can upsert SharePoint by ID without a separate read), plus a
`change_type` discriminator (`'status'` | `'notes'` | `'both'`),
plus `actor: {email}` for audit. Same fail-soft posture as
Brief 101's `fireClaimUpdateWebhook`. No 30-min polling backstop —
operator confirmed the volume is low enough that the webhook is
the single sync channel.

**The 30-minute ingest flow stays untouched.** That flow handles
*new* submissions (insert + email notification). The new webhook
handles *updates*. The two paths don't conflict — at worst, if the
30-min flow re-upserts existing rows, it'd just re-write the same
data the webhook just sent (Supabase is authoritative, so SharePoint
converges either way).

## Scope

### Phase 1 — Supabase schema (operator runs SQL once)

Operator-run SQL in Supabase SQL Editor:

```sql
ALTER TABLE fleet_submissions
  ADD COLUMN IF NOT EXISTS status_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_updated_by text,
  ADD COLUMN IF NOT EXISTS splash_notes_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS splash_notes_updated_by text;
```

The brief executor flags this in the outcome — operator pastes into
SQL Editor before pushing code. No migration framework in this repo;
operator-side SQL is the convention.

### Phase 2 — fleet-inquiry-worker — widen PATCH + fire webhook

2.1 `apps/fleet-inquiry-worker/src/admin.js` — `handleUpdateSubmission`
(~L323-377):

- Replace the strict `splash_notes`-only allow-list with a body
  that accepts either or both:
  - `splash_notes: string` (existing, trimmed, capped at
    `SPLASH_NOTES_MAX_LEN`)
  - `status: 'new'|'reviewed'|'contacted'|'closed'`
- Reject the request with 400 if BOTH fields are missing/unchanged
  (no-op edits don't need to round-trip).
- Reject `status` values not in the enum with 400.
- Reject other unknown body keys with 400 (defense-in-depth).
- Build the PATCH payload dynamically based on which fields are
  present:
  - When `splash_notes` is present: also set
    `splash_notes_updated_at = now()`, `splash_notes_updated_by =
    session.email`.
  - When `status` is present: also set `status_updated_at = now()`,
    `status_updated_by = session.email`.
- After successful PostgREST PATCH (response.ok and array length >= 1),
  fire the webhook (Phase 2.4) with the full updated row.

```js
// Sketch — concrete code in the executor's hands.
const allowedStatuses = new Set(["new", "reviewed", "contacted", "closed"]);
const updates = {};
const changedFields = [];
if (typeof body.splash_notes === "string") {
  const trimmed = body.splash_notes.trim();
  if (trimmed.length > SPLASH_NOTES_MAX_LEN) return jsonError(400, "...");
  updates.splash_notes = trimmed;
  updates.splash_notes_updated_at = new Date().toISOString();
  updates.splash_notes_updated_by = gate.session.email;
  changedFields.push("notes");
}
if (typeof body.status === "string") {
  if (!allowedStatuses.has(body.status)) {
    return jsonError(400, "status must be one of: new, reviewed, contacted, closed");
  }
  updates.status = body.status;
  updates.status_updated_at = new Date().toISOString();
  updates.status_updated_by = gate.session.email;
  changedFields.push("status");
}
if (changedFields.length === 0) {
  return jsonError(400, "Provide splash_notes and/or status");
}
const unknownKeys = Object.keys(body).filter(
  (k) => k !== "splash_notes" && k !== "status"
);
if (unknownKeys.length > 0) {
  return jsonError(400, `Unknown body keys: ${unknownKeys.join(", ")}`);
}
```

2.2 `gate.session.email` — the existing `authenticateAdmin` already
resolves a session; surface the email from it. If it isn't already
exposed on the gate result, expose it now (defense-in-depth check
that the auth helper actually returns an authenticated email; bail
to 401 if not).

2.3 Webhook fire (new helper).

Add a new module `apps/fleet-inquiry-worker/src/notifications.js`
(or co-locate at the bottom of `admin.js` — executor's call; the
worker is JS not TS so the modularity gain is smaller than the
damage-worker case). Helper signature:

```js
export async function fireFleetSubmissionUpdateWebhook(env, payload) {
  if (!env.FLEET_SUBMISSION_UPDATE_WEBHOOK_URL) return;
  try {
    const res = await fetch(env.FLEET_SUBMISSION_UPDATE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      console.error(
        `[fleet-submission-update] POST failed for ${payload.id}: status ${res.status}`
      );
    }
  } catch (err) {
    console.error(`[fleet-submission-update] POST error for ${payload.id}:`, err);
  }
}
```

Payload shape:

```ts
{
  id: string;            // fleet_submissions.id (UUID)
  change_type: "status" | "notes" | "both";
  changed_fields: string[];  // ["status"], ["notes"], or ["status","notes"]
  actor: { email: string };
  row: { /* full fleet_submissions row including all columns,
             post-update — directly from PostgREST's
             `Prefer: return=representation` array[0] */ };
}
```

Fire AFTER the PATCH commits successfully, BEFORE returning the
JSON response. Wrap in `try/catch` that swallows (same posture as
Brief 101's `notifyClaimUpdate`); the dashboard PATCH should never
fail because of a webhook hiccup.

2.4 `apps/fleet-inquiry-worker/wrangler.toml` — append a comment
block documenting the new secret. No `[vars]` change; the secret is
bound out-of-code:

```toml
# Brief 105 (YYYY-MM-DD): per-edit webhook fired when the dashboard
# PATCHes status or splash_notes. Fail-soft when unbound (PATCH still
# succeeds, SharePoint just lags). Bind via:
#   pnpm --filter @splash/fleet-inquiry-worker exec wrangler secret put FLEET_SUBMISSION_UPDATE_WEBHOOK_URL
```

2.5 No change to the public-form submit path. `status: "new"` stays
hardcoded at index.js ~L371. Webhook fires only on dashboard
edits — the existing 30-min ingest flow handles new submissions.

### Phase 3 — apps/web — add status dropdown alongside notes editor

3.1 `apps/web/app/admin/fleet/[id]/page.tsx`:

- Add a Status dropdown above (or beside) the splash_notes textarea
  in the existing ActionForm.
- Options: `new`, `reviewed`, `contacted`, `closed` — pulled from
  a shared constant so the worker validation and the dropdown stay
  in sync. Constant lives at
  `apps/web/app/admin/fleet/_lib/constants.ts` (new file) and is
  exported as `FLEET_STATUS_OPTIONS: readonly string[]`.
- The display in the read-only key/value grid (~L88) continues to
  show `row.status ?? em()`.

3.2 `apps/web/app/admin/fleet/[id]/actions.ts` — extend the server
action to read both `status` and `splash_notes` form fields and
pass both to the worker. Use the Brief 19 ActionResult pattern as
the existing `updateSplashNotes` action does. Validate
`status` against `FLEET_STATUS_OPTIONS` before calling the worker
(defense-in-depth; the worker re-validates).

3.3 `apps/web/app/admin/fleet/_lib/worker-fetch.ts` — extend
`updateFleetSubmissionNotes` (~L170-184) to accept an optional
`status` parameter and ship both in the body. Consider renaming
to `updateFleetSubmission` for clarity (parameter object pattern:
`{ id, splashNotes?, status? }`). The body sent to the worker
becomes `{splash_notes?, status?}` — both optional, at least one
required (caller responsibility).

3.4 `apps/web/app/admin/fleet/page.tsx` — verify `StatusPill`
(~L209-215) renders all four enum values. If today's implementation
hardcoded color mappings for only `new`, extend the pill to color
the others (e.g., neutral for `new`, blue for `reviewed`, amber for
`contacted`, green for `closed`). Co-locate the color map in the
same `_lib/constants.ts` so worker, action, and pill stay in sync.

### Phase 4 — Power Automate flow (operator-side, out of code)

4.1 Operator creates a new PA flow:
- Trigger: HTTP request received
- Schema: use sample payload provided in the brief's Outcome
- Logic: PATCH the matching SharePoint list item by submission `id`.
  Update status, splash_notes, and the two audit-column pairs
  (PA flow can either map them to existing SharePoint columns or
  ignore them if SharePoint isn't tracking those — operator's call).
- Save the HTTP-trigger URL; bind via wrangler secret per Phase 2.4.

4.2 The existing 30-minute new-submission ingest flow stays
untouched. Operator verifies that flow's behavior on existing rows
(it almost certainly is INSERT-only with a duplicate check on id;
if it's upsert-style, the dashboard edits and 30-min flow both
converge to Supabase state — no harm). Brief executor flags this
in the outcome for explicit operator verification.

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass.
5.2 `pnpm --filter @splash/web build` — must succeed.
5.3 `pnpm --filter @splash/fleet-inquiry-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up
    after.
5.4 No D1 / R2 schema change. Supabase schema change is documented
    in Phase 1 and is operator-run.
5.5 Local / post-deploy smoke (deferred to operator):
    - Open any `/admin/fleet/[id]` page
    - Change the status dropdown, save → toast / 303 confirms
      success
    - Verify Supabase row's status, status_updated_at,
      status_updated_by changed via Supabase Table Editor
    - Verify webhook fired by checking PA flow run history (when
      the flow is built) OR CF Workers Logs for
      `[fleet-submission-update]` log lines
    - Edit notes and status in one save → both audit pairs update;
      payload's `change_type` is `"both"`

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md: Brief 105 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
  - Brief 105 (YYYY-MM-DD) — fleet submissions dashboard now edits
    status alongside splash_notes; per-edit webhook
    `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL` fires fail-soft to PA so
    SharePoint upserts in near-realtime. Supabase is authoritative;
    SharePoint is a downstream mirror.
  - Four new audit columns on `fleet_submissions`:
    `status_updated_{at,by}` and `splash_notes_updated_{at,by}`.
    Stamped server-side by the worker on PATCH.
  - 30-min ingest flow untouched. Per-edit webhook is the single
    update sync channel.
  - Operator follow-up: run Phase 1 SQL; build PA flow per Phase 4;
    bind webhook via `wrangler secret put`.

6.3 CLAUDE.md:
  - Glossary "Fleet inquiries admin" entry: append a note that
    status is now editable from the dashboard (Brief 105) and
    fires `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL` to PA on each
    change. Note the status enum:
    `new | reviewed | contacted | closed`. Note the audit columns.
  - Add a new glossary entry `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL`
    documenting the secret, the payload shape, and fail-soft
    posture (mirror the `CLAIM_UPDATE_WEBHOOK_URL` entry's structure).

6.4 PRE_DEPLOY_FLEET.md: append a section documenting the new
secret + the operator's PA-flow setup steps. Mirror the layout of
the existing Brief 83 admin section.

## Configuration

| Name | Type | Required | Default | How to set |
|------|------|----------|---------|------------|
| `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL` | secret | optional | unbound | `pnpm --filter @splash/fleet-inquiry-worker exec wrangler secret put FLEET_SUBMISSION_UPDATE_WEBHOOK_URL` after the worker deploys |

No new D1 / R2. Supabase: four new columns on `fleet_submissions`
per Phase 1. No new wrangler `[vars]`.

## Out of scope

- Bidirectional sync (SharePoint → Supabase). Operator confirmed
  Supabase is authoritative; SharePoint edits are out of policy
  going forward. If anyone keeps editing in SharePoint, those edits
  won't flow back. v2 candidate if the policy changes.
- Per-status notification / email rules. Status change → PA flow
  is purely a sync hop; no email is sent on status changes today.
  Adding "notify rm_email when status='contacted'" or similar is a
  v2 candidate, modeled on Brief 101's `STATUS_NOTIFIES_NEXT` map.
- Backfilling existing rows' `status_updated_*` /
  `splash_notes_updated_*` columns from historical data. The
  schema's `IF NOT EXISTS` add leaves existing rows with NULL in
  the new columns. Acceptable v1; the audit data starts accruing
  from the next PATCH.
- One-time SharePoint backfill from Supabase. If operator's
  SharePoint is currently out-of-sync with Supabase on existing
  rows, that reconciliation is a manual operator task (PA flow
  could be triggered once with each row's current state) — out
  of scope for the worker / apps/web change.
- Per-actor permission scoping (e.g., only RD can close a
  submission). Same posture as Brief 87 — admin/super_admin auth
  gate covers all fleet status edits. Brief 105 doesn't add a
  finer-grained authz layer.
- Audit-log table for fleet edits. The four `*_updated_{at,by}`
  columns are last-write-wins; full history isn't tracked. v2 if
  needed.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- Four columns added to `fleet_submissions` via Phase 1 SQL (the
  brief flags this as operator-side work; the executor notes the
  exact SQL in the outcome).
- `apps/fleet-inquiry-worker/src/admin.js` `handleUpdateSubmission`
  accepts either or both of `splash_notes` and `status`, validates
  status against the four-value enum, stamps the appropriate
  audit-column pair(s), fires `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL`
  on success, fail-soft.
- New helper `fireFleetSubmissionUpdateWebhook` defined; payload
  shape per Phase 2.3.
- `apps/fleet-inquiry-worker/wrangler.toml` documents the new
  secret in a comment block.
- `apps/web/app/admin/fleet/[id]/page.tsx` renders a status
  dropdown beside the splash_notes textarea. ActionForm pattern;
  save → success state via Brief 19.
- `apps/web/app/admin/fleet/[id]/actions.ts` passes both fields to
  the worker.
- `apps/web/app/admin/fleet/_lib/worker-fetch.ts` `updateFleetSubmission`
  (renamed or extended) sends `{splash_notes?, status?}`.
- `apps/web/app/admin/fleet/_lib/constants.ts` exports
  `FLEET_STATUS_OPTIONS` + a status→color map used by `StatusPill`.
- `StatusPill` renders all four values with distinct colors.
- `pnpm typecheck` passes for all packages.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/fleet-inquiry-worker exec wrangler deploy
  --dry-run` bundle succeeds and cleans up after.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md, PRE_DEPLOY_FLEET.md
  updated.
- Sample webhook payload JSON (one notes-only edit, one status-only
  edit, one combined edit) included in the outcome for operator
  PA-flow setup.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (likely 250-350 lines net across worker + apps/web)
- Confirmation that the four audit columns are stamped server-side
  on every applicable PATCH
- Confirmation that webhook fires AFTER successful PATCH (so a
  Supabase write failure doesn't trigger PA)
- Confirmation that unknown body keys are rejected (defense-in-depth)
- Sample payloads (notes-only, status-only, combined)
- Validation results
- Any decisions made on the operator's behalf
- Operator follow-up checklist:
  1. Run Phase 1 SQL in Supabase SQL Editor
  2. Build PA flow per Phase 4 (sample payloads in outcome)
  3. `wrangler secret put FLEET_SUBMISSION_UPDATE_WEBHOOK_URL`
  4. Verify next status flip from `/admin/fleet/[id]` writes
     through to SharePoint

## Outcome

### Files created

- `apps/web/app/admin/fleet/_lib/constants.ts` — exports
  `FLEET_STATUS_OPTIONS: readonly ['new','reviewed','contacted','closed']`,
  `FleetStatus` type alias, `isFleetStatus(v)` guard, and
  `FLEET_STATUS_PILL_CLASS` color map (record keyed by enum value +
  `default` fallback for legacy NULL / unexpected values).

### Files modified

**Worker side**

- `apps/fleet-inquiry-worker/src/admin.js`
  - File header docblock extended to mention Brief 105.
  - New module-level `ALLOWED_STATUSES = new Set(["new", "reviewed",
    "contacted", "closed"])` constant.
  - `handleUpdateSubmission` rewritten: accepts either or both
    `splash_notes` + `status`; rejects unknown body keys with 400
    (defense-in-depth); rejects all-missing bodies with 400;
    validates `status` against the enum with 400 on miss; builds
    the updates payload dynamically; stamps
    `splash_notes_updated_{at,by}` and/or `status_updated_{at,by}`
    server-side; fires the new webhook after successful PATCH.
  - New `fireFleetSubmissionUpdateWebhook(env, payload)` helper
    appended at the bottom of the file (15s `AbortSignal.timeout`,
    try/catch swallows on throw / non-2xx, logs
    `[fleet-submission-update] POST {failed|error} for {id}: ...`).
  - New 401 branch in `handleUpdateSubmission` if
    `gate.session.email` is missing (defense-in-depth; shouldn't fire
    in practice because `authenticate()` populates email from
    `auth_unified`).

- `apps/fleet-inquiry-worker/wrangler.toml`
  - Binding comment block extended with the new
    `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL` secret docs + `wrangler
    secret put` command. No `[vars]` change.

**apps/web side**

- `apps/web/app/admin/fleet/_lib/worker-fetch.ts`
  - `updateFleetSubmissionNotes(id, notes)` renamed
    `updateFleetSubmission(id, {splashNotes?, status?})` —
    parameter-object pattern so future field additions don't change
    the call signature.
  - New `UpdateFleetSubmissionInput` interface exported alongside.
  - Docblock rewritten to reference both Brief 87 and Brief 105.

- `apps/web/app/admin/fleet/[id]/actions.ts`
  - Server action renamed `updateSplashNotesAction` →
    `updateSubmissionAction`.
  - Reads both `splash_notes` + `status` from FormData on every save.
  - Validates `status` against `isFleetStatus(rawStatus)` as
    defense-in-depth (worker re-validates server-side).
  - Success message tightened from "Notes saved." → "Saved." now
    that both fields ride the same submit.

- `apps/web/app/admin/fleet/[id]/page.tsx`
  - Import swap: `updateSplashNotesAction` → `updateSubmissionAction`
    + new import of `FLEET_STATUS_OPTIONS`.
  - "Splash Notes" section header relabeled "Status & Notes".
  - Helper text updated to mention SharePoint sync via PA.
  - New Status `<select>` rendered above the textarea inside the
    same `<ActionForm>` (defaults to `row.status` if valid else
    `"new"`); options rendered from `FLEET_STATUS_OPTIONS`.
  - Single Save button drives both fields in one PATCH.
  - The read-only `Status` row in the key/value grid below is
    untouched (continues to render the persisted value).

- `apps/web/app/admin/fleet/page.tsx`
  - Import: added `FLEET_STATUS_PILL_CLASS` + `isFleetStatus`.
  - `StatusPill` widened to color all four enum values via the
    shared color map (with a `default` neutral fallback for
    unexpected values).

**Documentation**

- `CLAUDE.md` — Fleet inquiries admin glossary entry extended with
  the Brief 105 PATCH widening, audit columns, status enum, and
  webhook reference. New `FLEET_SUBMISSION_UPDATE_WEBHOOK_URL`
  glossary entry added after `INCIDENTS_EMAIL`.
- `PRE_DEPLOY_FLEET.md` — new section 4.7 documenting operator
  follow-up (Phase 1 SQL, PA flow setup, secret bind), sample
  payloads (notes-only, status-only, combined), smoke test,
  failure modes & observability table.
- `BRIEFS/INDEX.md` — Brief 105 row appended at the end of the
  table.
- `BUILD_STATE.md` — Last updated bumped to Brief 105 + new
  Findings entry summarizing the work.
- `BRIEFS/QUEUE.md` — Brief 105 line moved to the
  completed-tombstone block.

### Decisions made on operator's behalf

1. **Webhook helper co-located at the bottom of `admin.js`** rather
   than a separate `notifications.js` module. The worker is
   verbatim-lifted JS (Brief 81); the modularity gain is smaller
   than the damage-worker `notifications.ts` case (Brief 101). When
   a second update notification surface appears on fleet, hoist
   then.

2. **Status pill colors.** `bg-amber-100 text-amber-900` (already
   used by `StatusActionPill.tsx` for damage) for `contacted`;
   `bg-emerald-100 text-emerald-900` (default Tailwind palette) for
   `closed`; `bg-splash-blue/10 text-splash-blue` preserved for
   `new`; `bg-sudsy-blue-soft text-splash-navy` for `reviewed`.

3. **Single ActionForm submit for both fields** rather than two
   separate forms. Operator confirmed Supabase should be
   authoritative for both, so one combined Save is more ergonomic
   and PA receives `change_type:"both"` to update both SharePoint
   columns in one shot.

4. **`changed_fields` order** is `["notes","status"]` when both
   ride the same PATCH (push order in the worker is `splash_notes`
   first, then `status`). PA should prefer `change_type` as the
   authoritative discriminator rather than positional order.

5. **Worker re-validates `status`** against the four-value enum
   even though the dropdown options are constrained — UI gating is
   a UX hint, not access control.

6. **Worker rejects unknown body keys** (`Unknown body keys: ...`,
   400) so a future apps/web typo fails fast rather than silently
   dropping the field.

7. **`updateFleetSubmissionNotes` renamed → `updateFleetSubmission`**
   (and the server action) because the new shape genuinely takes
   either field; keeping the legacy name would be misleading. Brief
   allowed either rename or extend; rename was the cleaner option
   since the helper has exactly one call site.

8. **Defensive 401 branch on blank `gate.session.email`** added
   even though `authenticate()` populates email from `auth_unified`
   in practice — keeps the worker observably correct if a future
   refactor ever skips that field.

9. **Phase 1 SQL is flagged in operator follow-up** rather than
   auto-applied. No migration framework in this repo (`CLAUDE.md`).
   Operator runs the four `ADD COLUMN IF NOT EXISTS` statements in
   the Supabase SQL Editor before the next code push. If the
   columns are absent, the worker's PATCH will return 500 (PostgREST
   rejects the unknown columns) and log the upstream errText.

### Latent issues / forward flags

- (a) **Existing rows get NULL** in the four new audit columns
  until their first PATCH. No backfill scope — operator action item
  if historical attribution matters.
- (b) **Last-write-wins audit only** — no append-only history
  table. v2 candidate if a full audit-log is needed.
- (c) **No bidirectional sync** (SharePoint → Supabase). Operator
  confirmed Supabase is authoritative going forward; SharePoint
  edits are out of policy. If anyone keeps editing in SharePoint,
  those edits won't flow back.
- (d) **No per-actor permission scoping** — admin/super_admin auth
  gate covers all fleet status edits. Same posture as Brief 87.
- (e) **Webhook fire is fail-soft** — when unbound or PA is
  unreachable the PATCH still 200s. SharePoint diverges until the
  next successful fire or a one-time operator backfill.
- (f) **Phase 4 PA flow build is operator-side** — the worker
  fires the webhook regardless of whether PA is configured. Until
  the operator builds the PA flow + binds the secret, fires are
  no-ops.
- (g) **The 30-min PA new-submission ingest flow stays untouched**.
  If it's upsert-by-id on existing rows, dashboard edits and the
  30-min flow both converge to Supabase state. If it's INSERT-only
  with a duplicate-id check, no interaction. Operator verifies on
  the next 30-min cycle.

### Validation results

- **`pnpm typecheck`** — 17/17 successful in ~9.7s. All packages
  re-typechecked (turbo cache invalidation from the touched
  `@splash/web` + `@splash/fleet-inquiry-worker` packages and the
  shared apps/web type surface).
- **`pnpm --filter @splash/web build`** — succeeded. Next 15.5.15
  build, all 26 routes generated. `/admin/fleet/[id]` route bundle
  739 B / 106 kB First Load JS (unchanged vs Brief 88 baseline; the
  new dropdown JSX + constants import is below the per-route delta
  threshold).
- **`pnpm --filter @splash/fleet-inquiry-worker exec wrangler
  deploy --dry-run --outdir=.tmp-build`** — succeeded at
  **786.25 KiB raw / 149.73 KiB gzip** (~+1 KiB vs the pre-Brief-105
  baseline of 785 KiB — the new helper + ALLOWED_STATUSES Set +
  docblock comments). `.tmp-build` cleaned up after run.
- **Schema change** — Phase 1 SQL flagged for operator-run; no
  migration framework in this repo (CLAUDE.md). Four `ADD COLUMN IF
  NOT EXISTS` statements; idempotent if re-run.

### Sample webhook payloads

**Notes-only edit** (`change_type: "notes"`):

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "change_type": "notes",
  "changed_fields": ["notes"],
  "actor": { "email": "operator@splashcarwashes.com" },
  "row": {
    "id": "00000000-0000-0000-0000-000000000000",
    "created_at": "2026-05-11T12:00:00.000Z",
    "submitted_at": "2026-05-11T12:00:00.000Z",
    "company": "Acme",
    "name": "Sam",
    "phone": "5551234567",
    "email": "sam@acme.com",
    "address": "123 Main",
    "location_code": "binghamton",
    "location_pretty": "Binghamton",
    "service_type": "monthly",
    "packages": "package_1",
    "packages_detail": null,
    "detailing_requested": false,
    "detailing_location_code": null,
    "detailing_location_pretty": null,
    "number_of_vehicles": 5,
    "anticipated_washes_per_month": 20,
    "ip_address": "1.2.3.4",
    "user_agent": "Mozilla/...",
    "status": "new",
    "splash_notes": "Left voicemail.",
    "status_updated_at": null,
    "status_updated_by": null,
    "splash_notes_updated_at": "2026-05-11T14:30:00.000Z",
    "splash_notes_updated_by": "operator@splashcarwashes.com"
  }
}
```

**Status-only edit** (`change_type: "status"`):

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "change_type": "status",
  "changed_fields": ["status"],
  "actor": { "email": "operator@splashcarwashes.com" },
  "row": {
    "id": "00000000-0000-0000-0000-000000000000",
    "created_at": "2026-05-11T12:00:00.000Z",
    "submitted_at": "2026-05-11T12:00:00.000Z",
    "company": "Acme",
    "name": "Sam",
    "phone": "5551234567",
    "email": "sam@acme.com",
    "address": "123 Main",
    "location_code": "binghamton",
    "location_pretty": "Binghamton",
    "service_type": "monthly",
    "packages": "package_1",
    "packages_detail": null,
    "detailing_requested": false,
    "detailing_location_code": null,
    "detailing_location_pretty": null,
    "number_of_vehicles": 5,
    "anticipated_washes_per_month": 20,
    "ip_address": "1.2.3.4",
    "user_agent": "Mozilla/...",
    "status": "contacted",
    "splash_notes": null,
    "status_updated_at": "2026-05-11T14:30:00.000Z",
    "status_updated_by": "operator@splashcarwashes.com",
    "splash_notes_updated_at": null,
    "splash_notes_updated_by": null
  }
}
```

**Combined edit** (`change_type: "both"`):

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "change_type": "both",
  "changed_fields": ["notes", "status"],
  "actor": { "email": "operator@splashcarwashes.com" },
  "row": {
    "id": "00000000-0000-0000-0000-000000000000",
    "created_at": "2026-05-11T12:00:00.000Z",
    "submitted_at": "2026-05-11T12:00:00.000Z",
    "company": "Acme",
    "name": "Sam",
    "phone": "5551234567",
    "email": "sam@acme.com",
    "address": "123 Main",
    "location_code": "binghamton",
    "location_pretty": "Binghamton",
    "service_type": "monthly",
    "packages": "package_1",
    "packages_detail": null,
    "detailing_requested": false,
    "detailing_location_code": null,
    "detailing_location_pretty": null,
    "number_of_vehicles": 5,
    "anticipated_washes_per_month": 20,
    "ip_address": "1.2.3.4",
    "user_agent": "Mozilla/...",
    "status": "closed",
    "splash_notes": "Booked monthly plan, 5 vehicles.",
    "status_updated_at": "2026-05-11T14:30:00.000Z",
    "status_updated_by": "operator@splashcarwashes.com",
    "splash_notes_updated_at": "2026-05-11T14:30:00.000Z",
    "splash_notes_updated_by": "operator@splashcarwashes.com"
  }
}
```

### Operator follow-up checklist

1. **Run Phase 1 SQL** in Supabase SQL Editor (idempotent; safe to
   re-run):

   ```sql
   ALTER TABLE fleet_submissions
     ADD COLUMN IF NOT EXISTS status_updated_at timestamptz,
     ADD COLUMN IF NOT EXISTS status_updated_by text,
     ADD COLUMN IF NOT EXISTS splash_notes_updated_at timestamptz,
     ADD COLUMN IF NOT EXISTS splash_notes_updated_by text;
   ```

2. **Build PA flow** per PRE_DEPLOY_FLEET.md §4.7 sample payload.
   Trigger: "When an HTTP request is received". Logic: PATCH
   matching SharePoint list item by submission `id`.

3. **Bind the webhook secret**:

   ```powershell
   pnpm --filter @splash/fleet-inquiry-worker exec wrangler secret put FLEET_SUBMISSION_UPDATE_WEBHOOK_URL
   ```

4. **Verify** by flipping a row's status from `/admin/fleet/{id}`
   → confirm Supabase row updates (status + audit columns) +
   PA flow run history shows the fresh POST + SharePoint reflects
   the change within ~PA-flow-run latency. Repeat for notes-only
   and combined edits.
