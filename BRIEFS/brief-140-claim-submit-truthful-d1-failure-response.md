# Brief 140: Claim submit — truthful D1-failure response + INSERT-time column tolerance

**Status:** Completed (2026-05-21)
**Started:** —
**Completed:** —
**Blocks:** Brief 141 should land after this — 141's retry loop
behavior depends on knowing whether the response correctly distinguishes
success from "D1-invisible success" (the bug 140 closes).
**Dependencies:**
- Brief 138 (claim form submit resilience) — landed 2026-05-21.
- D1 migration adding `idempotency_key` column — landed 2026-05-21.

## Read first

- `apps/damage-worker/src/index.ts`
  - `handleClaimSubmission` at line ~2344
  - Brief 138 idempotency dedup block at lines ~2396–2461
  - D1 write try/catch wrapping `writeClaimBatch` at lines ~2573–2804
  - Success response shape at lines ~2920–2940 (`d1Success` field
    presence)
- `apps/damage-worker/src/render/claim-form.ts`
  - Submit handler at ~1293; success branch at ~1331–1357 where the
    client decides between `showOutcome` and `showError`
- `packages/db-d1/src/claims.ts`
  - `writeClaimBatch` at ~101 (column list at ~104, VALUES at ~130,
    bind chain at ~132)

## Context

Real-world test on 2026-05-21 exposed a critical failure class:

1. Customer fills `/claims/{site}` form, hits Submit.
2. Worker receives submission, parses FormData, validates email +
   damage type.
3. Worker tries `getClaimByIdempotencyKey` — throws `no such column:
   idempotency_key` because the D1 migration hadn't run yet. Caught
   at the existing try/catch, logged, continues.
4. Photos upload to R2 ✓
5. Submission JSON written to R2 ✓
6. `writeClaimBatch(env.DB, insert)` runs with `idempotency_key`
   in the INSERT column list — throws `no such column`. Caught by
   the D1-write try/catch at line ~2802, logged, **`d1Success`
   stays `false`**.
7. PDF generation continues (uses `claimData.claimId`, not D1) ✓
8. Power Automate POST, webhooks fire ✓
9. Worker returns `200 OK` with `{ok: true, d1Success: false, ...}`.
10. Client form checks `out.ok && out.body.ok` and renders the
    success card with claim ID `BIN-XXX`.
11. Admin opens `/admin/damage` — claim is invisible. Photos in R2,
    PDF in R2, submission JSON in R2 — but no D1 row, so the manage
    UI can't find it.

The migration is now applied, so the immediate cause is closed. But
the failure class isn't — any future schema drift (or any other
cause of D1 INSERT failure: D1 outage, network blip to D1, schema
constraint violation) reproduces the same "success card shown, claim
invisible" bug.

Two structural problems:

- **P1 (INSERT not tolerant of missing column).** Brief 138 wrapped
  the dedup SELECT in try/catch with a "no such column" fallthrough,
  but the corresponding INSERT in `writeClaimBatch` has no such
  defense. If any future column rollout lands code before SQL,
  every claim is silently lost from D1 again.
- **P2 (client trusts `ok: true` alone).** The success branch at
  claim-form.ts:1332 reads `if (out.ok && out.body.ok)` — never
  checks `d1Success`. So the customer sees a green check mark on
  a claim that didn't make it to D1. The worker is being honest in
  the JSON (it sets `d1Success: false` faithfully); the client
  isn't listening.

This brief closes both. The customer should NEVER see a success
card for a claim that isn't fully persisted. The R2 backup is the
audit/recovery trail, not a substitute for admin visibility.

## Scope

### Phase 1 — INSERT-time tolerance for missing column

`packages/db-d1/src/claims.ts`, `writeClaimBatch` at ~101:

Wrap the `await db.batch([claimInsert, ...photoInserts, activityInsert])`
call in a try/catch. On error, if the error message matches
`/no such column.*idempotency_key/i` (case-insensitive), retry the
INSERT without the column. Specifically:

- Build a SECOND `claimInsert` prepared statement that excludes
  `idempotency_key` from the column list, VALUES placeholders, and
  bind chain. This is the "legacy" INSERT shape — pre-Brief-138.
- On the first batch failing with the column-missing error, build a
  fresh batch using the legacy INSERT alongside the unchanged
  `photoInserts` + `activityInsert`, then `await db.batch([...])`.
- If the retry also fails, throw the original error (don't double-
  wrap).
- Log loudly: `[claim.d1] idempotency_key column missing — fell back
  to legacy INSERT shape (apply schema migration)`. This is the same
  log style as Brief 138's SELECT fallthrough.

Long-term: this defense can be removed once the column is universally
applied AND the operator confirms no rollback is plausible. For now
it's belt-and-suspenders.

The same try/catch should ALSO surface any other D1 INSERT error
(constraint violation, schema mismatch, unique-index conflict) by
re-throwing. Don't swallow — Phase 2 of this brief turns those into
client-facing errors. The outer try/catch in `handleClaimSubmission`
at line ~2802 catches them.

### Phase 2 — Truthful response when D1 fails

`apps/damage-worker/src/index.ts`, success response at line ~2920:

The worker currently returns `200 OK` regardless of `d1Success`.
Change the response shape based on `d1Success`:

**When `d1Success === true`** (the existing happy path): unchanged.
Return `200 OK` with `{ok: true, d1Success: true, claim_id, ...}`.

**When `d1Success === false`**: return `500 Internal Server Error`
with `{ok: false, d1Success: false, error: "Claim was received but
not persisted to admin storage. Please notify a manager and save
your claim ID for reference.", claim_id, summary_pdf_url, ...}`.
Keep `claim_id` and `summary_pdf_url` in the body so the customer
can still download their PDF copy and the manager has a recovery
handle. The R2 JSON backup at `submissions/{claim_id}.json` remains
the recovery source.

The 500 status code triggers Brief 138's Phase 4 retry loop on the
client — `isRetryableStatus(500)` is currently false, so widen the
allow-list to include 500 ALSO. (Brief 138 specced 408/502/503/504;
500 was missing because Brief 138 assumed 500 = deterministic
server-side bug, not retryable. Brief 140's redefinition of 500 to
mean "transient D1 failure" makes it retryable.)

Note: there's a risk that a true deterministic 500 (unhandled
exception in the worker) gets retried 3 times when it's pointless.
Acceptable — the worker's idempotency key dedup will collapse the
duplicate attempts, and 3 wasted retries on a buggy code path is
fine. If this becomes noisy in practice, future work can split the
status: 503 for transient D1 / 500 for unhandled (with 503 retryable
and 500 not).

### Phase 3 — Client-side `d1Success` check

`apps/damage-worker/src/render/claim-form.ts`, submit handler at
~1331–1357:

Current:
```js
submitWithRetry(fd, 3).then(function (out) {
  if (out.ok && out.body && out.body.ok) {
    showOutcome(...)
  } else {
    ...showError(errMsg + ' Please retry.');
  }
}).catch(...);
```

Change the success guard:
```js
if (out.ok && out.body && out.body.ok && out.body.d1Success !== false) {
  showOutcome(...)
}
```

The `d1Success !== false` check is permissive: a missing/undefined
`d1Success` (pre-Brief-140 worker, or a future worker that drops the
field) is treated as success. Only an EXPLICIT `false` blocks the
success card. This is the right default — adding the check shouldn't
break against any older worker version.

In the else branch, surface the worker's `error` message when
present (Phase 2 makes that the customer-readable "Claim was
received but not persisted to admin storage..." copy). The existing
`(out.body && out.body.error) || ('Submission failed (status ' +
out.status + ').')` chain already handles this — verify it does
without modification.

### Phase 4 — Internal alert on D1-failed submissions

Add a fire-and-forget notification to `INCIDENTS_EMAIL` (the
existing damage-worker `[vars]` entry from Brief 102) on every
D1-failed submission. This is the operator-facing pager for the
"orphan claim" failure class.

`apps/damage-worker/src/notifications.ts`: add a new helper
`fireD1FailureAlert({env, claimData, errorMessage})` that POSTs to
`INTERNAL_NEW_CLAIM_WEBHOOK_URL` with a discriminator field
`alert_type: "d1_failed"`. Payload includes:
- `claim_id`
- `location_code`
- `customer_name`
- `customer_email`
- `r2_submission_url` (the `submissions/{claim_id}.json` URL —
  worker-private auth-gated)
- `summary_pdf_url`
- `error_message` (the D1 throw's message, truncated to 500 chars)
- `recipients` (just `INCIDENTS_EMAIL` — not the location contacts,
  because this is an internal infra alert, not a customer-facing
  claim notification)

Same fail-soft + 15s `AbortSignal` posture as Brief 101/102.
`ctx.waitUntil`-ed so it doesn't block the customer response.

Power Automate flow PA_FLOWS — add a new entry. The existing
`INTERNAL_NEW_CLAIM_WEBHOOK_URL` flow can branch on `alert_type` to
either send the existing internal-new-claim notification (when
absent) or the new d1-failure alert (when `"d1_failed"`). Document
in PA_FLOWS_BRIEF_140.md.

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass.
5.2 `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — must succeed.
5.3 `pnpm --filter @splash/db-d1 typecheck` — must pass (no `build`
    script per CLAUDE.md convention).
5.4 No Supabase / R2 / wrangler.toml / secret changes. D1 schema
    untouched.
5.5 Operator post-deploy smoke (deferred):
- Open `/claims/{site}`, fill form, submit normally. Verify success
  card paints AND D1 has the row AND admin page shows the claim. Same
  as today.
- Manually break the D1 INSERT by adding a temporary constraint
  violation (e.g., dupe a claim_id via direct SQL, then try to
  submit a claim with that same id — pathological, but it exercises
  the failure path). Verify:
  - Worker returns 500 with the user-readable error
  - Client surfaces the error banner (NOT the success card)
  - INCIDENTS_EMAIL receives a `d1_failed` alert
  - R2 submission JSON and photos still wrote
  - PDF still generated and accessible

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md: Brief 140 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
- Brief 140 (YYYY-MM-DD) — Closed the "success card shown but claim
  invisible to admin" failure class exposed by Brief 138 testing on
  2026-05-21. Three changes: (a) `writeClaimBatch` in
  `packages/db-d1/src/claims.ts` retries with a legacy INSERT shape
  on `no such column.*idempotency_key`, so any future schema drift
  doesn't silently drop claims from D1; (b) worker response returns
  500 + truthful error message when `d1Success === false`, and Brief
  138's `isRetryableStatus()` allow-list widened to include 500;
  (c) client success guard now requires `d1Success !== false` in
  addition to `ok` truthiness, so the customer never sees a green
  check mark on a D1-orphan claim; (d) new `fireD1FailureAlert`
  helper in `notifications.ts` POSTs to
  `INTERNAL_NEW_CLAIM_WEBHOOK_URL` with `alert_type: "d1_failed"`
  on every D1 failure, alerting INCIDENTS_EMAIL.

6.3 CLAUDE.md: update the **idempotency_key** glossary entry with
a note about the writeClaimBatch fallback behavior + the d1Success
response contract.

6.4 PA_FLOWS_BRIEF_140.md: document the PA branch on `alert_type` —
existing internal-new-claim flow + new d1-failed alert flow share
the webhook URL.

## Out of scope

- Service worker for offline page-load (deferred).
- Background Sync API for queued offline submits (deferred).
- Backfilling existing D1-orphan claims from R2 (one-off operator
  SQL only — already covered by the BIN-20260521-170744-B0NP
  backfill from the 2026-05-21 testing if/when operator runs it).
- Changes to the photo upload or PDF generation paths.
- Server-side retry of the D1 INSERT after a transient error (the
  client retry loop covers this; D1 outages on the order of minutes
  resolve via the customer hitting the retry path).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `writeClaimBatch` retries without `idempotency_key` on the column-
  missing error; loud log on fallthrough.
- Worker returns 500 (not 200) when `d1Success === false`, with a
  customer-readable error message.
- Brief 138's `isRetryableStatus()` includes 500.
- Client checks `d1Success !== false` in the success guard.
- `fireD1FailureAlert` helper added to
  `apps/damage-worker/src/notifications.ts`; called from
  `handleClaimSubmission` after the D1 catch block when `d1Success
  === false`.
- `pnpm typecheck` passes.
- `wrangler deploy --dry-run` succeeds on damage-worker.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md, PA_FLOWS_BRIEF_140.md
  updated per Phase 6.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- The exact line ranges touched in claims.ts, index.ts,
  claim-form.ts, notifications.ts.
- Whether the column-missing retry path was straightforward or
  required restructuring `writeClaimBatch` more than expected.
- Any decisions made about the precise wording of the customer-
  facing error message.

## Outcome

### Files modified

- `packages/db-d1/src/claims.ts` — `writeClaimBatch` wrapped in
  try/catch with column-missing-tolerant retry. Original try-less
  invocation at the function tail was replaced with a wrapping
  try/catch; on `/no such column.*idempotency_key/i` the catch builds
  a legacy claim INSERT (drops `idempotency_key` column + bind +
  placeholder), rebuilds the photo + activity statements (D1
  prepared statements can't be rebound after a failed batch), and
  retries `db.batch([...])`. Any other D1 throw rethrows. Retry-
  failed branch rethrows the ORIGINAL column-missing error so the
  failure mode stays grep-able. New LOC ~75 inside `writeClaimBatch`.

- `apps/damage-worker/src/index.ts` — three call sites:
  - Lines ~287-289: fetch dispatcher passes `ctx` through to
    `handleClaimSubmission` (was `_ctx`).
  - Line ~2349: `handleClaimSubmission` signature widened to accept
    `ctx: ExecutionContext`.
  - Line ~2577: new `let d1ErrorMessage: string | null = null;` local
    alongside `let d1Success = false;`.
  - Line ~2806: D1 try/catch's catch body extended to capture
    `d1ErrorMessage` from `d1Error.message`.
  - Lines ~2917-2965 (new): D1-failure response block inserted
    BEFORE the existing 200 success response. When `!d1Success`,
    fires `fireD1FailureAlert` via `ctx.waitUntil(...)` then returns
    500 (JSON) or 303 to `/claims/{slug}?error=...` (browser-mode)
    with the customer-readable copy.
  - Line ~138: import of `fireD1FailureAlert` added to the
    `./notifications.js` import block.

- `apps/damage-worker/src/notifications.ts` — appended new
  `D1FailureAlertPayload` interface and `fireD1FailureAlert(args)`
  helper at end of file (~85 LOC). Same fail-soft + 15s
  `AbortSignal.timeout(15_000)` posture as
  `fireInternalNewClaimWebhook` (Brief 102). Sends discriminator
  `alert_type: "d1_failed"` so the existing
  `INTERNAL_NEW_CLAIM_WEBHOOK_URL` flow can branch templates
  without spawning a second webhook URL.

- `apps/damage-worker/src/render/claim-form.ts`:
  - Line ~1197: `RETRYABLE_STATUS` map widened to include 500.
    Header comment updated to call out the redefinition.
  - Lines ~1338-1347: submit handler success guard widened from
    `out.ok && out.body && out.body.ok` to also require
    `out.body.d1Success !== false`. Comment block above explains the
    permissive missing/undefined back-compat semantics.

- `BRIEFS/INDEX.md` — Brief 140 row appended at bottom (the table
  is not strictly numeric; chronological-by-completion is the
  observed convention — Brief 136 came before 135).

- `BUILD_STATE.md` — Findings & decisions log entry inserted at
  top of the table; Last-updated line at file top rewritten to
  lead with Brief 140 (Brief 139 retained as "Previously").

- `CLAUDE.md` — the `**idempotency_key**` glossary entry extended
  with a new paragraph describing the Brief 140 `writeClaimBatch`
  fallback path + the `d1Success` response contract + the
  `fireD1FailureAlert` helper + the `ExecutionContext` signature
  widening.

### Files created

- `PA_FLOWS_BRIEF_140.md` — concise PA flow guide documenting the
  `alert_type` branch on the shared `INTERNAL_NEW_CLAIM_WEBHOOK_URL`
  flow. Mirrors the Brief 101/102/105/121/125/127 pattern; less
  verbose because the change is a single Switch action added to an
  existing flow rather than a brand-new flow.

### Files deleted

None.

### Decisions made on operator's behalf

1. **Customer error copy** — exact wording from the brief: "Claim
   was received but not persisted to admin storage. Please notify a
   manager and save your claim ID for reference." Surfaces the
   claim_id intentionally so the manager has a recovery handle.
   Browser-mode submitters get the same copy via the `?error=...`
   redirect, even though they can't see the claim_id (their
   browser-mode UX trade-off is well-established in the existing
   form: all non-form-validation errors collapse to the same
   `/claims/{slug}?error=...` shape).
2. **`r2_submission_url` shape** — shipped as the literal R2 key
   path (`submissions/{claim_id}.json`), not an HTTP URL. There's
   no public serve endpoint for the submission JSON archive today;
   operator pastes the key into the R2 bucket UI to retrieve.
   `PA_FLOWS_BRIEF_140.md` calls this out so the PA email template
   doesn't render it as a clickable link.
3. **`ctx.waitUntil` over inline-await** — Brief 32/102's webhook
   helpers await inline because they fire on the success path where
   adding ~100ms of webhook latency is acceptable. Brief 140's D1-
   failure path is already an unhappy path returning 500, so
   blocking on a 15s webhook timeout would compound the customer-
   facing latency. Plumbed `ctx` through the fetch dispatcher to
   make this clean.
4. **Retry rethrows ORIGINAL error** — on a writeClaimBatch retry
   failure, the rethrow surfaces the `no such column` message rather
   than the retry's downstream symptom. This is the more
   grep-friendly outcome from logs when both attempts fail.
5. **`fireD1FailureAlert` parameter typing** — used a narrow `env: {
   INTERNAL_NEW_CLAIM_WEBHOOK_URL?: string; INCIDENTS_EMAIL?: string
   }` structural type rather than importing the worker's full `Env`
   interface, so the helper stays decoupled from `index.ts` (the
   `Env` interface lives in `index.ts`, not in a shared types
   package, and circular-importing it back would be awkward).

### Whether the column-missing retry path was straightforward

Mostly. The non-obvious bit was that D1 prepared statements can't
be re-bound after a failed batch — calling `legacyClaimInsert =
db.prepare(...).bind(...)` is fine, but the photo + activity
statements that ran in the original (failed) batch can't be reused;
fresh `db.prepare(...)` calls are required. The first draft of this
brief reused `photoStmt` and `activityInsert` from the outer scope
and ran into runtime weirdness in my mental model; the final
version rebuilds both inside the catch. ~75 LOC inside one
function is bigger than the brief suggested but the alternative
(extract `buildPhotoInserts(c)` + `buildActivityInsert(c)` helpers
that both code paths share) would have meant a larger surface area
of refactor for not much LOC savings. Left the duplication in for
clarity at the cost of ~30 LOC.

### Customer-facing error message wording — final decision

Used the brief's exact wording verbatim. Considered shorter
alternatives ("Submission received, but admin update failed —
please notify a manager. Claim ID: BIN-XXX") but kept the brief's
because (a) "not persisted to admin storage" is more precise about
what failed, (b) "save your claim ID" gives the customer agency,
(c) the brief's copy is what made it into the PA email template
and consistency between the customer-facing banner and the
operator-facing email is valuable.

### Latent issues / forward flags

- The Brief 138 dedup lookup AND the Brief 140 INSERT retry share
  the `/no such column.*idempotency_key/i` regex — a column rename
  needs both sites updated. Belt-and-suspenders defense for the
  D1-migration window only; deletion candidate once the column is
  universally applied and rollback is implausible.
- The Phase 4 retry now treats 500 as transient — true
  deterministic 500s (unhandled exception in the worker) get
  retried 3 times pointlessly. Brief acknowledged this is
  acceptable; the idempotency-key dedup collapses the duplicates.
- The `r2_submission_url` field name keeps "URL" suffix per the
  brief but the value is an R2 key path. If a public serve
  endpoint is added later, the field will become a real URL and
  the PA template can switch to rendering it as a link.
- The legacy INSERT fallback path in `writeClaimBatch` is the
  same long-term removal candidate as the Brief 138 SELECT
  fallthrough — both can be retired once the operator confirms
  the column is universally applied with no rollback plausible.

### Initial typecheck failure caught + fixed mid-execution

The first typecheck pass hit `TS1005` errors at `claim-form.ts:1339`
because the comment text added inside the inline `FORM_SCRIPT`
template literal contained backtick characters around
`d1Success !== false` — the TS parser saw them as nested template
literals. Fix: dropped the backticks from the comment body. The
CLAUDE.md "Working with workers" section deserves a one-line
glossary touch about backtick-in-template-literal-comments but
that's out of scope for this brief.

### Validation

- `pnpm typecheck` → 18/18 green (17 cache hits, damage-worker +
  db-d1 ran fresh on first pass that exposed the TS1005 above;
  second pass after the backtick fix was clean; 2.12s wall).
- `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run --outdir .wrangler/dry-run` → succeeded. Bundle
  1757.37 KiB raw / 399.54 KiB gzipped (+6.17 KiB raw / +1.45 KiB
  gzip vs Brief 139 baseline of 1751.20 / 398.09; growth is the
  legacy-INSERT fallback path + the truthful-500 response block +
  the `fireD1FailureAlert` helper + `D1FailureAlertPayload` type +
  the ExecutionContext signature thread). Comfortably under the 3
  MiB compressed free-tier ceiling.
- `pnpm --filter @splash/db-d1` has no `build` script per CLAUDE.md
  convention; the writeClaimBatch changes are exercised by the
  root `pnpm typecheck` pass via the damage-worker dep chain.
- No Supabase / R2 / wrangler.toml / secret changes. D1 schema
  untouched.

### Operator post-deploy smoke (deferred per Phase 5.5)

1. Push to main → CF Workers Build deploys splash-damage.
2. Open `/claims/{site}`, fill, submit normally → verify success
   card paints AND D1 has the row AND `/admin/damage` shows it.
   Same as today's happy path.
3. To exercise the failure path on a non-prod D1 (production
   `idempotency_key` column is in place, so the column-missing
   path won't naturally fire): temporarily DROP the
   `idempotency_key` column on staging D1, submit a claim, verify:
   - The success card does NOT paint (Brief 140 Phase 3).
   - The error banner surfaces with the customer-readable copy.
   - Worker logs `[claim.d1] idempotency_key column missing —
     fell back to legacy INSERT shape`.
   - Worker also logs `[d1-failure]` lines from the alert path.
   - Wait — actually, the legacy INSERT fallback would SUCCEED in
     this case (column gone → drop column → retry succeeds), so
     the d1Success path is the happy one. The d1_failed alert
     only fires when BOTH attempts throw.
   - To exercise the d1_failed alert specifically: violate the
     UNIQUE constraint on `claim_id` (rare — the random suffix
     makes the natural collision pathological), or simulate a D1
     outage by binding a stale/wrong DB UUID temporarily.
4. INCIDENTS_EMAIL inbox receives one alert email with the
   recovery template (PA flow setup per `PA_FLOWS_BRIEF_140.md`
   must land first).
5. R2 submission JSON and photos still wrote (verify in the
   Cloudflare R2 dashboard).
6. PDF still generated and accessible via
   `/claims-api/summary/{claim_id}`.

### Report

- **Exact line ranges touched.**
  - `packages/db-d1/src/claims.ts` lines ~109-187 (the existing
    `writeClaimBatch` function body); change is contained to the
    function — exports, types, helpers unaffected.
  - `apps/damage-worker/src/index.ts`: line 138 (import),
    line 276 + 288 (fetch dispatcher), lines ~2349-2353
    (function signature), lines ~2576-2580 (d1ErrorMessage local),
    line ~2806 (catch capture), lines ~2917-2965 (new
    D1-failure response block).
  - `apps/damage-worker/src/render/claim-form.ts`: lines ~1187-1205
    (RETRYABLE_STATUS comment + map), lines ~1338-1351 (success
    guard).
  - `apps/damage-worker/src/notifications.ts`: lines ~269+ (new
    helper appended at end of file).
- **Was the column-missing retry path straightforward?** Mostly,
  with one twist (D1 prepared statements not re-bindable after a
  failed batch — see "Whether the column-missing retry path was
  straightforward" above).
- **Customer error message wording.** Used the brief's exact
  wording verbatim — see "Customer-facing error message wording"
  above.
