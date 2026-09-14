# Brief 108: Fleet update webhook — coerce top-level `id` to integer (use `arr[0].id`)

**Status:** Completed (2026-05-11)
**Started:** 2026-05-11
**Completed:** 2026-05-11
**Blocks:** Neither — visible bug (PA flow returns 400 on every
dashboard PATCH webhook fire; SharePoint is currently NOT receiving
status / notes updates) but the dashboard PATCH itself succeeds and
Supabase records the edit. Sync is just frozen.
**Dependencies:** Brief 105 (introduced
`fireFleetSubmissionUpdateWebhook` and the webhook payload shape;
this brief fixes one line in the payload build).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-105-fleet-submissions-status-editor-and-update-webhook.md
  (introduced the webhook fire that this brief patches)
- apps/fleet-inquiry-worker/src/admin.js (L443-449 — the call site
  that needs the fix)

## Context

After the operator switched `fleet_submissions.id` from UUID to
integer (Postgres bigint identity), the per-edit webhook fire to
Power Automate started returning 400 on every dashboard PATCH. CF
Workers Logs show:

```
[fleet-submission-update] POST failed for 21: status 400
```

PA was returning 400 at the trigger level (schema validation), not
inside any action. The HTTP trigger's JSON Schema correctly types
`id` as `"integer"` (operator-verified screenshot of the schema).

**Root cause:** the worker reads `id` from the URL path
(`/admin/api/submissions/21`) as a **string** ("21") and passes it
to the webhook payload as `id`. The `row.id` field inside the
payload is correctly an integer (PostgREST returns the integer
column as a JSON number), but the **top-level `id` is a string**.
PA's schema rejects the type mismatch with 400 before any actions
run.

`apps/fleet-inquiry-worker/src/admin.js` L443-449:

```js
await fireFleetSubmissionUpdateWebhook(env, {
  id,                            // ← URL path param, string "21"
  change_type: changeType,
  changed_fields: changedFields,
  actor: { email: actorEmail },
  row: arr[0]                    // ← row.id is integer 21
});
```

**Why Brief 105 didn't catch this:** Brief 105 was drafted when
`fleet_submissions.id` was UUID (string). The shape was correct at
the time. The id-type switch happened later as a Supabase schema
change without a corresponding worker update. The PA flow was also
configured against UUID-string assumptions at first; the operator
already fixed the PA-side schema to `integer` after observing the
real payload. Now the worker is the lone holdout sending a string.

The cleanest fix is worker-side: pull the integer id from the
PostgREST response row (`arr[0].id`) instead of from the URL path.
This keeps top-level `id` and `row.id` consistent and matches PA's
schema.

## Scope

### Phase 1 — Fix the payload in `handleUpdateSubmission`

Single file: `apps/fleet-inquiry-worker/src/admin.js`.

Locate the `fireFleetSubmissionUpdateWebhook` call (~L443-449).
Change the top-level `id` field to use `arr[0].id`:

```js
await fireFleetSubmissionUpdateWebhook(env, {
  id: arr[0].id,                 // integer from PostgREST response
  change_type: changeType,
  changed_fields: changedFields,
  actor: { email: actorEmail },
  row: arr[0]
});
```

That's the entire functional change. `arr[0].id` is the same field
that's inside `row`, so the two are guaranteed consistent post-fix.

### Phase 2 — No PA flow edit required

PA's HTTP trigger schema already types `id` as integer (operator
verified). PA's Get items Filter Query already reads
`triggerBody()?['id']` (no string quotes around it — OData
comparison against the Number-typed `SubmissionId` column). Both
sides will agree once the worker stops shipping a string.

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass.
3.2 `pnpm --filter @splash/fleet-inquiry-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up
    after.
3.3 No D1 / R2 / Supabase / wrangler.toml / secret changes.
3.4 Operator smoke (post-deploy, deferred):
    - Open `/admin/fleet/[id]` for any submission.
    - Edit status or notes; save.
    - Check CF Workers Logs filtered on `[fleet-submission-update]`
      — the line should now report success (no error log) OR
      simply not appear (the error log only fires on non-2xx).
    - Check the PA flow's run history — the run should succeed
      end-to-end (Get items → Update item).
    - Verify the SharePoint item reflects the new status / notes.

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 108 row appended.

4.2 BUILD_STATE.md: Findings entry noting:
  - Brief 108 (2026-05-11) — fixed Brief 105's update webhook payload
    to ship `id` as integer (from `arr[0].id`) instead of the URL-path
    string. PA was returning 400 on every dashboard PATCH because its
    HTTP trigger schema typed `id` as integer (correct, post-column-type
    switch) but the worker was shipping `"21"` (string). Top-level
    `id` and `row.id` are now consistent.
  - No PA flow edit needed; the schema and Filter Query were already
    correct.
  - Latent reminder: when a Supabase column changes type, also audit
    any worker code that passes URL-path params as that column's
    value in downstream payloads.

4.3 CLAUDE.md "Fleet inquiries admin" glossary entry: append a
one-liner noting that the update-webhook `id` field is sourced from
the PostgREST response row (`arr[0].id`), not the URL param, to
guarantee the wire type matches the underlying column type.

## Out of scope

- Adding runtime type coercion in `fireFleetSubmissionUpdateWebhook`
  (e.g., `Number(payload.id)`). The call-site fix is cleaner — the
  helper stays a thin POST wrapper.
- Auditing the apps/web `FleetSubmissionRow.id` type. Brief 106's
  context already flagged this as Option B cleanup; out of scope
  here.
- Touching the public form-submit path in `apps/fleet-inquiry-worker/src/index.js`.
  No change needed; INSERT lets Supabase generate the id.
- Touching any other worker (damage, workorders, signup, jotform).
  Their webhooks already ship ids from the data row, not URL params.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/fleet-inquiry-worker/src/admin.js` `handleUpdateSubmission`
  fires the webhook with `id: arr[0].id` instead of the URL-path
  `id`.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/fleet-inquiry-worker exec wrangler deploy
  --dry-run` bundle succeeds and cleans up after.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (likely 1 line in admin.js plus doc rows)
- Validation results
- Confirmation that no PA flow edit was needed

## Outcome

**Files modified.**

- `apps/fleet-inquiry-worker/src/admin.js` — single-line change in
  `handleUpdateSubmission` (~L443-449): `fireFleetSubmissionUpdateWebhook`
  call's top-level `id` field switched from the URL-path string `id`
  to `arr[0].id` (the integer from the PostgREST response row that's
  already being shipped as `row`).
- `BRIEFS/INDEX.md` — Brief 108 row appended (Completed 2026-05-11;
  bug fix in a fail-soft optional webhook).
- `BUILD_STATE.md` — "Last updated" header switched to Brief 108
  summary (Brief 107 demoted to a "(Previously: …)" paragraph); new
  Findings & decisions log row at the top of the table.
- `CLAUDE.md` — "Fleet inquiries admin" glossary entry extended with
  a Brief 108 paragraph: the update-webhook `id` field is sourced
  from the PostgREST response row (`arr[0].id`), not the URL param,
  to guarantee wire type matches the underlying column type; plus a
  latent-reminder line for future workers (audit URL-path → payload
  sites whenever a Supabase column type changes).
- `BRIEFS/brief-108-fleet-update-webhook-coerce-id-to-integer.md` —
  Status set to Completed (2026-05-11); Started + Completed dates
  filled; this Outcome section.

**Files created.** None.

**Decisions made on operator's behalf.** None. The brief specified
the exact call-site fix (`id: arr[0].id`) and explicitly rejected
the alternative of runtime coercion inside
`fireFleetSubmissionUpdateWebhook`. No PA flow edit needed — the
operator already updated PA's HTTP-trigger schema to `integer` and
the Get-items Filter Query reads `triggerBody()?['id']` without
string quotes (verified in the brief context).

**Latent issues found.** None new to this brief. Brief 106's
context flagged the apps/web `FleetSubmissionRow.id` type
(`apps/web/app/admin/fleet/_lib/worker-fetch.ts`) as Option B
cleanup; it remains a v2 candidate (explicitly out of scope per the
brief's "Out of scope" section). The forward flag the brief asked
to capture is now in BUILD_STATE.md + CLAUDE.md: when a Supabase
column changes type, audit any worker code that passes URL-path
params as that column's value in downstream payloads. Sweep of the
other monorepo workers (damage, workorders, signup, jotform, forms,
sysadmin) per the brief's framing: their webhook payloads already
ship ids from the data row, not URL params — no parallel fix
needed.

**Validation results.**

- Phase 3.1 — `pnpm typecheck` from the monorepo root: 18 successful,
  18 total, 17 cached + 1 cache-hit re-run (fleet-inquiry-worker
  re-typechecked after the source edit). Green.
- Phase 3.2 — `pnpm --filter @splash/fleet-inquiry-worker exec
  wrangler deploy --dry-run --outdir=.tmp-build`: bundle succeeded
  at **786.26 KiB raw / 149.74 KiB gzipped** (≈ unchanged vs Brief
  105's 786.25 / 149.73 baseline — diff is one expression
  replacement, no new imports or constants). Cleaned up `.tmp-build/`
  after the run.
- Phase 3.3 — No D1 / R2 / Supabase / wrangler.toml / secret changes.
- Phase 3.4 — Operator smoke deferred (no deploy from headless per
  CLAUDE.md).

**Diff size.** 1 line in `apps/fleet-inquiry-worker/src/admin.js`
(payload field value swap) plus the documentation rows in
INDEX.md / BUILD_STATE.md / CLAUDE.md / this brief.

**Confirmation that no PA flow edit was needed.** PA's HTTP-trigger
JSON Schema is already typed `id: "integer"` and the Get-items
Filter Query reads `triggerBody()?['id']` without string quotes
(both operator-verified per the brief's Context section). The
brief's Phase 2 explicitly noted no PA-side change is required.
