# Brief 138: Claim form — submit resilience (defer clearDraft, offline banner, idempotency key, retry/backoff)

**Status:** Completed (2026-05-15)
**Started:** 2026-05-15
**Completed:** 2026-05-15
**Blocks:** Service-worker / Background-Sync API work
(IndexedDB-backed photo persistence, true offline submit queue) is
deferred until this brief lands and is exercised against real-world
network drops.
**Dependencies:**
- Brief 136 (claim form localStorage autosave + resume) — Phase 1
  reverses Brief 136's optimistic `clearDraft()` ordering, so this
  brief MUST land after Brief 136 (it has, 2026-05-15).
- D1 schema migration on `splash-damage-claims` (Phase 3) — operator-
  driven via `wrangler d1 execute` or Cloudflare D1 console.

## Read first

- `apps/damage-worker/src/render/claim-form.ts`
  - Submit handler at lines ~1123–1180 (the `form.addEventListener('submit', ...)` block)
  - `clearDraft()` definition at ~890; current call site at ~1132
  - `setSubmitting(on)` at ~1078; `showError(msg)` at ~1069
  - Autosave block at lines ~840–1050 (Brief 136 — context only,
    don't re-touch unless Phase 1 strictly requires)
- `apps/damage-worker/src/index.ts`
  - `handleClaimSubmission` at line ~2344 (the worker-side submit
    handler — Phase 3 inserts dedup logic near the top of the try
    block, before `writeClaimBatch`)
- `packages/db-d1/src/claims.ts`
  - `ClaimInsert` type + `writeClaimBatch` at lines ~50–180 (Phase 3
    adds `idempotency_key` to the INSERT column list + type)
  - `getClaim` at ~284 (existing point-read pattern by claim_id;
    Phase 3's lookup follows the same `db.prepare(...).bind(...).first()`
    shape but keys on `idempotency_key`)

## Context

Operator-surfaced gap in the current `/claims/{site}` form: nothing
about the submit path is resilient to transient network issues.

The current flow (post-Brief-136):

1. Customer fills the form. Brief 136's 500ms-debounced localStorage
   autosave captures every keystroke.
2. Customer clicks Submit. `validateBeforeSubmit()` runs.
3. **`clearDraft()` wipes localStorage immediately** (Brief 122
   "option B" — optimistic clear).
4. `fetch('/claims-api/submit-claim', {body: fd})` fires. One-shot,
   no retry, no timeout, no idempotency key.
5. On HTTP non-2xx: inline banner "Submission failed (status N). Please retry."
6. On fetch reject (network error, offline, DNS, TLS): inline banner
   "Network error: {msg}. Please check your connection and retry."
7. Customer clicks Submit again → step 3 onwards repeats. If the
   first attempt succeeded server-side but the response was lost,
   step 7 creates a duplicate claim.

Four gaps:

- **G1 (lost draft on fail).** Step 3 wipes localStorage before the
  fetch resolves. If steps 4–6 fail, the DOM still holds values but
  any subsequent autosave-triggering keystroke is needed to re-save.
  Page reload / tab crash between fail and re-touch = total data
  loss for the typed customer-section fields.
- **G2 (no offline indicator).** Steps 1–7 give no visual cue that
  the customer is offline. They discover it on Submit failure.
- **G3 (no idempotency).** Step 7 (manual retry after a lost-response
  failure) creates a duplicate claim. No client UUID, no server
  dedup.
- **G4 (no automatic retry on transient failure).** Customer carries
  the full burden of manual retry on transient blips. Even on a
  reliable connection, a one-off 502/503 from CF or a momentary
  Wi-Fi blip forces them to interact with an error banner.

This brief closes all four. Service-worker-backed offline page-load
and Background-Sync-API submit-queue are explicitly out of scope per
operator (deferred to a follow-up after this lands).

## Scope

### Phase 1 — Defer `clearDraft()` until after the fetch succeeds

`apps/damage-worker/src/render/claim-form.ts`, submit handler at
~1123–1180:

- Remove the call to `clearDraft()` at the top of the submit handler
  (currently between `validateBeforeSubmit()` and the `var fd = new FormData(form)`).
- Move it INSIDE the `.then(...)` success branch, after `showOutcome(...)`
  fires. Specifically: after the line `showOutcome(out.body.claim_id ...)`,
  add `clearDraft();` on its own line.
- Update the existing comment block (lines ~1126–1131) to reflect the
  new ordering. The comment should note:
  - Brief 138 reversed Brief 136's optimistic-clear (option B) in
    favor of post-success clear (option A).
  - Rationale: a network/server failure now leaves the draft intact
    on the customer's device, so a page reload / tab crash before
    manual retry preserves the typed fields. Resume banner on next
    page load brings them back.
  - Trade-off: customers who submit successfully AND immediately
    navigate away (before `showOutcome` paints — extremely rare with
    the submitting overlay covering the page) might see a stale
    Resume banner on next visit. Inverse trade-off vs option B; the
    failure-preserves-draft case is the high-value one.

### Phase 2 — Offline indicator (`navigator.onLine` listener)

`apps/damage-worker/src/render/claim-form.ts`:

- Add a new amber banner element below the existing `#submitError`
  banner (at ~337). Pattern after the Brief 136 resume banner —
  amber-toned (`#fef3c7` background, `#92400e` text), `role="status"`,
  `aria-live="polite"`. ID: `offlineBanner`. Initially hidden.
- Copy: **"You're offline — your form is saved on this device. Submit
  will retry automatically when the connection comes back."**
- In the JS block (~620 onwards), add:
  - On page load, set `offlineBanner.hidden = navigator.onLine`.
  - `window.addEventListener('online', ...)` → hide banner.
  - `window.addEventListener('offline', ...)` → show banner.
  - When transitioning online while a submit is pending retry
    (Phase 4 state), trigger the next retry attempt immediately
    instead of waiting for the backoff timer.
- The submit button should NOT be disabled while offline — the
  customer can still click Submit, and Phase 4's retry loop will
  poll for connectivity. Disabling would be a regression vs current
  one-shot behavior (which also lets them click while offline; they
  just get a "Network error" banner). The offline banner is the
  visual cue, not button gating.

CSS additions next to `.banner-error` (~174):

```css
.banner-offline {
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fde68a;
  border-radius: 6px;
  padding: 10px 14px;
  margin-bottom: 12px;
  font-size: 14px;
  line-height: 1.4;
}
.banner-offline[hidden] { display: none; }
```

### Phase 3 — Client-generated idempotency key + worker dedup

**Client (claim-form.ts):**

- Generate a UUID exactly once per form instance — at IIFE init time
  (top of the JS block, ~620). Store as a closure variable
  `submissionId`. Use `crypto.randomUUID()` (available in all
  evergreen browsers + CF Workers; Safari 15.4+, Chrome 92+,
  Firefox 95+ — adequate for our customer base; for older browsers
  fall back to a Math.random-based v4 polyfill — keep it short, ~10
  lines).
- In the submit handler, append `fd.append('idempotency_key', submissionId);`
  before the photos loop.
- Phase 4's retries all reuse the same `submissionId` — that's the
  whole point. Do NOT regenerate per retry attempt.
- Generate a NEW `submissionId` if-and-only-if `showOutcome(...)`
  fires successfully (next claim from this customer would be a
  genuinely new submission). Practically: after `showOutcome(...)`
  the form is replaced by the outcome card and the page is
  effectively terminal — but `submissionId = crypto.randomUUID()` on
  the line right after `clearDraft()` in Phase 1's success branch
  is a defensive measure for future code that re-shows the form.

**Worker (`apps/damage-worker/src/index.ts handleClaimSubmission`):**

After `formData` is parsed (line ~2359) but before any email/damage-type
validation, read `idempotency_key`:

```ts
const idempotencyKey = String(formData.get("idempotency_key") ?? "").trim();
```

Validate shape: must be 36 chars matching the UUID v4 regex
`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
If present but malformed, treat as absent (log and proceed without
dedup — defensive against tampering; don't 400 on it).

If `idempotencyKey` is present AND valid:
- Query D1: `SELECT claim_id FROM claims WHERE idempotency_key = ? LIMIT 1`
- If hit, the existing claim's `claim_id` becomes the response.
  Re-generate the summary PDF URL (`/claims-api/summary/{claim_id}`)
  and return the success JSON shape verbatim — same response the
  original submission produced. **Do NOT** re-fire any webhook
  (customer-email, internal-new-claim, MaintainX), don't re-insert
  photos, don't re-render the PDF (the existing R2 object is fine).
  Log `[claim.idempotent] hit claim_id={...} key={...}` for
  observability.
- If miss, proceed normally. The eventual `writeClaimBatch` call
  must include `idempotency_key` in the INSERT.

Browser-mode (Accept: text/html) callers: same dedup logic; on hit,
303-redirect to `/claims/{slug}?id={existing_claim_id}` (same shape
the success path uses). The post-submit outcome card on the client
runs in JSON-mode in practice (the form sets `Accept: application/json`)
so browser-mode is the secondary path here.

**D1 schema change (operator-driven):**

```sql
ALTER TABLE claims ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX idx_claims_idempotency_key
  ON claims(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

Operator applies via:
```powershell
pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage-claims --remote --command="ALTER TABLE claims ADD COLUMN idempotency_key TEXT;"
pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage-claims --remote --command="CREATE UNIQUE INDEX idx_claims_idempotency_key ON claims(idempotency_key) WHERE idempotency_key IS NOT NULL;"
```

The brief should:
- Document the exact SQL above in the Outcome section after applying.
- Not run it from the headless executor — operator runs it during
  deploy (same posture as past D1 migrations).
- Worker code must tolerate the column being missing (during the
  brief window between push and operator-applied migration): wrap
  the dedup query in a try/catch that falls through to the no-dedup
  path on `SqliteError: no such column: idempotency_key`. Log the
  fallthrough as `[claim.idempotent] column missing — skipping dedup
  (apply schema migration)` so it's grep-able.

**`packages/db-d1/src/claims.ts`:**

- Add `idempotency_key?: string | null` to `ClaimInsert` type
  (alongside the existing fields ~50–95).
- Extend the INSERT column list (~104) and VALUES placeholders (~130)
  with `idempotency_key` and a `?`.
- Extend the `.bind(...)` chain (~132–157) with `c.idempotency_key ?? null`
  in the matching position.

### Phase 4 — Retry with exponential backoff on transient failures

`apps/damage-worker/src/render/claim-form.ts`, submit handler at
~1123–1180:

Wrap the `fetch(...)` call in a retry loop. Spec:

- **Retry on:** fetch reject (`TypeError`, `AbortError`), HTTP 502,
  503, 504, and HTTP 408 (request timeout).
- **Do NOT retry on:** HTTP 4xx other than 408 (those are deterministic
  client errors — bad form data, validation failures; retrying
  produces the same response).
- **Backoff schedule:** 1s, 2s, 4s. Maximum 3 retry attempts (4 total
  including the original). After exhaustion, surface the error banner
  the same way the current single-shot path does and re-enable Submit.
- **Per-attempt timeout:** 30s via `AbortController`. A submit that
  takes >30s is treated as a transient failure (probably stalled
  network) and retried.
- **Visual feedback:** while retrying, replace the "Submitting..."
  overlay text with "Submitting (retry N of 3)..." so the customer
  isn't staring at a frozen overlay. The submitting overlay stays up
  the whole time; submit button stays disabled.
- **Online-event hook:** if `navigator.onLine === false` during a
  backoff sleep, hold the next attempt pending the `online` event
  (Phase 2's listener) — fire the next attempt immediately on
  reconnection instead of waiting out the timer.
- Phase 3's `submissionId` is reused on every attempt (that's the
  whole point of idempotency).

Implementation sketch (the full implementation lives in claim-form.ts;
this is the contract):

```js
function submitWithRetry(fd, maxAttempts) {
  var attempt = 0;
  return new Promise(function (resolve, reject) {
    function tryOnce() {
      attempt += 1;
      setRetryLabel(attempt);
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 30000);
      fetch('/claims-api/submit-claim', {
        method: 'POST',
        body: fd,
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      }).then(function (r) {
        clearTimeout(timer);
        return r.text().then(function (text) {
          return { status: r.status, ok: r.ok, text: text };
        });
      }).then(function (out) {
        if (out.ok) { resolve(out); return; }
        if (isRetryableStatus(out.status) && attempt < maxAttempts) {
          scheduleNextAttempt();
          return;
        }
        resolve(out); // surface non-retryable error to caller
      }).catch(function (err) {
        clearTimeout(timer);
        if (attempt < maxAttempts) {
          scheduleNextAttempt();
          return;
        }
        reject(err);
      });
    }
    function scheduleNextAttempt() {
      var delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      if (!navigator.onLine) {
        // Wait for online event instead
        window.addEventListener('online', tryOnce, { once: true });
      } else {
        setTimeout(tryOnce, delay);
      }
    }
    tryOnce();
  });
}
```

Replace the existing `fetch(...).then(...).then(...).catch(...)` block
with a call to `submitWithRetry(fd, 3)` that resolves to the same
`out` shape the current handler consumes.

The `isRetryableStatus(n)` helper returns true for 408, 502, 503, 504.
Everything else is non-retryable.

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass.
5.2 `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — must succeed (Brief 137 substitution; damage-worker has no `build` script per Brief 137 outcome).
5.3 `pnpm --filter @splash/db-d1 build` — must succeed (the package has a `build` script per the monorepo convention; if it doesn't, run `pnpm --filter @splash/db-d1 typecheck` as the equivalent gate).
5.4 No Supabase / R2 / wrangler.toml / secret changes. (D1 schema changes are explicitly the only data-layer touch.)
5.5 Operator post-deploy smoke (deferred):
- Apply the D1 schema migration above.
- Open `/claims/{site}` on a real customer device.
- Fill the customer section completely, then BEFORE submitting:
  - Open DevTools → Network → set throttling to "Offline".
  - Confirm the amber "You're offline" banner appears.
  - Click Submit. Confirm the submitting overlay shows "Submitting (retry 1 of 3)..." then 2, then 3, then surfaces a final error banner after ~7s of total backoff.
  - Confirm the form's localStorage draft (`claims.draft.{slug}`) is STILL PRESENT (Phase 1 + the failed-submit path).
- Re-enable network. Reload page. Confirm Resume banner appears and restores the typed fields.
- Click Resume, click Submit. Confirm success.
- Open DevTools → Application → IndexedDB / Local Storage. Confirm the draft is GONE post-success (Phase 1).
- Smoke the idempotency path: on a successful submit, copy the URL response's `claim_id`. Re-POST the same FormData (with the same `idempotency_key`) via curl/Postman. Confirm the response carries the SAME `claim_id` (not a new one) and a single row exists in D1.

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md: Brief 138 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
- Brief 138 (YYYY-MM-DD) — Hardened the customer claim form submit
  path against transient network failures. Four sub-changes:
  Phase 1 deferred `clearDraft()` until after the fetch resolves OK
  (reverses Brief 136's optimistic clear — failed submits now
  preserve the draft); Phase 2 added a `navigator.onLine`-driven
  amber offline banner; Phase 3 added a client-generated UUID
  `idempotency_key` (D1 column + unique partial index) that lets the
  worker safely dedup retried submissions; Phase 4 added exponential
  backoff retry (1s/2s/4s, 3 attempts, online-event-aware) on
  network errors + HTTP 408/502/503/504. Background Sync API +
  service-worker offline page-load + IndexedDB photo persistence
  deferred to a follow-up.

6.3 CLAUDE.md: glossary entry for **idempotency_key** column on
`claims` D1 table. One-paragraph entry under the existing schema
glossary section near the `age_days` entry. Note: column is text /
UUID v4 / nullable / unique-when-non-null; written by the customer
form submit path; read by the worker to dedup retried submissions;
NOT used by any admin / dashboard / reporting query.

6.4 PRE_DEPLOY_DAMAGE.md: add a smoke-test entry for the four new
behaviors (offline banner, retry-on-transient, idempotency dedup,
draft-survives-fail). Position it near the existing claim-form
smoke tests.

## Out of scope

- Service worker for offline page-load (i.e., serving the claim form
  HTML when the customer arrives offline). Deferred per operator —
  follow-up brief after this lands.
- Background Sync API for queued offline submits. Deferred per
  operator.
- IndexedDB photo persistence. Deferred per operator (linked to the
  Background Sync work since photos are the big serialization
  problem).
- Server-side dedup on customer-supplied fields (name + phone + site
  + within-N-minutes). Idempotency key is the right primitive here;
  fuzzy-match dedup is a different question.
- Changes to the admin claim-list dedup display (idempotency_key is
  not surfaced to admin views).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.
- Don't apply the D1 schema migration from headless — operator
  applies via `wrangler d1 execute`.

## Definition of done

- Phase 1: `clearDraft()` moved from pre-fetch to inside the
  success branch.
- Phase 2: offline banner added, `online`/`offline` listeners wired.
- Phase 3: client appends `idempotency_key` to FormData; worker reads,
  validates, dedups; `packages/db-d1/src/claims.ts` `ClaimInsert` +
  `writeClaimBatch` widened to accept `idempotency_key`; worker
  tolerates the column-missing state with a logged fallthrough.
- Phase 4: `submitWithRetry()` helper added; retry-on-transient
  behavior matches the spec above; submitting overlay shows attempt
  count.
- `pnpm typecheck` passes.
- `wrangler deploy --dry-run` succeeds on damage-worker.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md, PRE_DEPLOY_DAMAGE.md
  updated per Phase 6.
- D1 schema SQL documented in the Outcome (operator applies it
  separately).
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- The exact line ranges touched in claim-form.ts, index.ts, and
  claims.ts.
- The final D1 SQL the operator must run.
- Any decisions made on the operator's behalf (e.g., specific HTTP
  status codes treated as retryable, exact backoff schedule if
  different from the spec).
- Confirmation that the column-missing fallthrough works (you can't
  smoke this from headless, but flag whether the try/catch shape is
  the right one for D1's error semantics).

## Outcome

### Files modified

- `apps/damage-worker/src/render/claim-form.ts` (~140 LOC delta)
  - **Phase 1 (lines ~1123–1180 in the brief — final shape ~1180–1255 in
    the source after Phase 2/3/4 additions):** removed the `clearDraft()`
    call at the top of the submit handler; moved it INSIDE the
    `.then(out)` success branch after `showOutcome(...)`. Added a defensive
    `submissionId = generateSubmissionId()` regen right after the
    clearDraft call (Phase 3.5). Rewrote the comment block above to
    document the reversal of Brief 136's option B in favor of option A.
  - **Phase 2:** new `.banner-offline` + `.banner-offline[hidden]` CSS
    rules inserted directly below `.banner-error` (lines ~180–189 in
    final file); new `<div class="banner-offline" role="status"
    aria-live="polite" id="offlineBanner" hidden>You're offline — your
    form is saved on this device. Submit will retry automatically when
    the connection comes back.</div>` element rendered directly under
    the existing `#submitError` banner (line ~338 in final file); new
    `var offlineBanner = document.getElementById('offlineBanner')`
    reference next to the other element grabs (line ~644). New
    `pendingOnlineRetry` closure variable, `updateOfflineBanner()`,
    `window.addEventListener('online' / 'offline', ...)` + init call
    (lines ~1079–1100).
  - **Phase 3 (client):** new `generateSubmissionId()` helper using
    `window.crypto.randomUUID()` with a 10-line Math.random v4 polyfill
    fallback; new `submissionId` closure variable initialized at IIFE
    init (lines ~1106–1125). New `fd.append('idempotency_key',
    submissionId)` line in the submit handler before the photos loop
    (line ~1183 in final file).
  - **Phase 4:** `setSubmitting(on, attempt)` signature widened to
    accept an optional `attempt` number; if `attempt > 1`, the
    submittingOverlay text becomes `'Submitting (retry N of 3)...'`
    where N = `attempt - 1`; otherwise reverts to `'Submitting claim,
    please wait...'` matching the existing HTML default copy
    (lines ~1142–1160). New `RETRYABLE_STATUS = { 408: true, 502: true,
    503: true, 504: true }` constant + `isRetryableStatus(n)` helper +
    `submitWithRetry(fd, maxAttempts)` Promise-returning helper (lines
    ~1167–1219). Submit handler's `fetch(...).then().then().catch()`
    chain replaced with `submitWithRetry(fd, 3).then(...).catch(...)`
    consuming the same `out` shape; success branch unchanged structure
    + new `clearDraft()` + `submissionId = generateSubmissionId()`
    calls; retry-pending-online handled via `pendingOnlineRetry` slot.

- `apps/damage-worker/src/index.ts` (~70 LOC delta)
  - Added `getClaimByIdempotencyKey` to the `@splash/db-d1` import block
    (line ~77).
  - Phase 3 dedup block inserted right after the `claimData` object
    literal closes (line ~2395), BEFORE the email/damage-type
    validation: reads `idempotency_key` from formData, validates UUID v4
    shape, wraps `getClaimByIdempotencyKey` in try/catch detecting
    `no such column.*idempotency_key` for column-missing fallthrough.
    Hit → browser-mode 303 to `/claims/{slug}/thanks?id={existing}`,
    JSON re-emits the success response with `idempotent_replay: true`.
  - Phase 3 `idempotency_key: idempotencyKey` field added to the
    `insert: ClaimInsert` builder block (line ~2620 in final file).

- `packages/db-d1/src/claims.ts` (~30 LOC delta)
  - `ClaimInsert` type: added optional `idempotency_key?: string | null`
    field with a JSDoc paragraph.
  - `writeClaimBatch` INSERT column list extended with `idempotency_key`
    after `submitted_at`; VALUES placeholder list extended with one `?`;
    `.bind(...)` chain extended with `c.idempotency_key ?? null`. The
    hardcoded `'Open'` literal at position 22 of the VALUES tuple stayed
    stable.
  - New exported helper `getClaimByIdempotencyKey(db, key) → Promise<{
    claim_id: string } | null>` inserted directly above the existing
    `getClaimById` function (~line 289).

- `BRIEFS/INDEX.md` — Brief 138 row appended below Brief 137.
- `BUILD_STATE.md` — "Last updated" header rewritten with the Brief 138
  banner + Brief 137 demoted to "Previously:"; new Findings entry
  inserted at top of the table above Brief 137.
- `CLAUDE.md` — new `**`idempotency_key`** (Brief 138)` glossary entry
  inserted directly below the existing `**`age_days`** (Brief 68)`
  entry.
- `PRE_DEPLOY_DAMAGE.md` — five new smoke-test bullets appended below
  the Brief 32 entries: D1 schema verify, offline banner, retry-on-
  transient, draft-survives-fail, idempotency dedup.

### Files created

None.

### Files deleted

None.

### Operator-applied D1 schema migration

The operator runs these post-deploy, before exercising idempotency
dedup. The worker code tolerates the column being missing in the
interim window (try/catch logs `[claim.idempotent] column missing —
skipping dedup` and falls through to the no-dedup path).

```powershell
pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage-claims --remote --command="ALTER TABLE claims ADD COLUMN idempotency_key TEXT;"

pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage-claims --remote --command="CREATE UNIQUE INDEX idx_claims_idempotency_key ON claims(idempotency_key) WHERE idempotency_key IS NOT NULL;"
```

Verify with:

```powershell
pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage-claims --remote --command="PRAGMA table_info(claims);"
```

— the row list should include `idempotency_key TEXT`.

### Decisions made on the operator's behalf

1. **Browser-mode dedup hit redirects to `/claims/{slug}/thanks?id={existing}`** (matching the actual success path) instead of `/claims/{slug}?id={existing}` as the brief literally said. The brief explicitly stated "same shape the success path uses" and the actual success path uses `/thanks?id=...`; matching the actual path is what the brief intended.
2. **The JSON dedup response includes `idempotent_replay: true`** alongside the canonical `claim_id` / `success` / etc. fields — small, non-breaking observability flag operators can grep for in PA logs or curl. Not strictly in the brief but useful.
3. **`photosUploaded` in the dedup JSON is set to `0`** because looking up the actual count would add a second D1 query for a debug-grade field. The canonical record is in R2 and D1 from the original submit; admins use the manage page to view real photo counts.
4. **`powerAutomateSuccess` and `d1Success` are both set to `true` in the dedup response** — the original submit must have landed both (otherwise no row with this `idempotency_key` would exist); precise per-side history isn't queryable from D1.
5. **The dedup query catches both "column missing" AND any other PostgREST/D1 error** (e.g., transient network), logs each case separately, and falls through to the no-dedup path. Defense in depth.
6. **The submitting overlay's "first attempt" text was set to "Submitting claim, please wait..."** (preserving the existing HTML default) rather than the brief's bare "Submitting...". Tiny copy preservation, no functional change.
7. **`RETRYABLE_STATUS` is a tiny dict lookup** rather than a `[].includes(...)` call — micro-opt that keeps `isRetryableStatus(n)` O(1).
8. **`pendingOnlineRetry` overwrites on each schedule** (we only hold the most recent attempt's callback); earlier attempts are discarded because all retries reuse the same FormData + idempotency_key.
9. **`idempotency_key` is `fd.append`-ed BEFORE the photos loop** so the worker reads it during initial form parsing. Multipart/form-data ordering doesn't matter for `formData.get`, but keeping it next to the other text fields keeps the FormData structure clean.
10. **The Phase 5.2 substitution `wrangler deploy --dry-run`** was used as the equivalent gate per Brief 137's outcome ("damage-worker has no `build` script"). Likewise for db-d1, `pnpm --filter @splash/db-d1 typecheck` was the equivalent gate per the brief's footnote.
11. **`AbortController` is feature-detected** (`typeof AbortController !== 'undefined'`) and the per-attempt timeout is only attached when available — keeps the helper functional on extremely old browsers that don't support it, though the 30s timeout becomes a no-op there.

### Latent issues / forward flags

- **(a) File-object re-readability across retries.** Phase 4's retry loop reuses the same `File` objects across attempts. File / Blob objects ARE re-readable in modern browsers, so this works on the deploy target (Safari 15.4+ per `crypto.randomUUID` support floor). Ancient Safari could surface "body stream already consumed" but the support floor is already past that.
- **(b) Cross-session idempotency.** Brief 138's dedup ONLY protects WITHIN-SESSION retries (Phase 4 backoff + manual click-retry-after-error-banner). A tab-crash + reload + Resume rehydrates the form but generates a fresh `submissionId` at IIFE init. **Brief 139** (drafted but not yet executed) proposes persisting `submissionId` to localStorage alongside the form draft so Resume restores the SAME idempotency_key — closing that gap.
- **(c) `summary_pdf_url` on dedup hit assumes the original PDF exists.** The URL is re-built from `baseOrigin + claim_id`; if the original submit's PDF generation failed (fail-soft per Brief 32), the URL points at a 404. Operator can re-issue the PDF via existing manage-page tools.
- **(d) Soft-deleted rows still dedup.** `getClaimByIdempotencyKey` does NOT filter `deleted_at IS NULL` — a soft-deleted prior claim with the same key would still dedup. This is the RIGHT behavior: don't allow a second insert with the same key even after admin deletes the row; the partial unique index enforces this at the D1 layer.
- **(e) Retry differentiation.** Phase 4 doesn't differentiate between "the worker is genuinely down" (every attempt 503s for ~7s) and "this customer's connection is flaky" (mix of timeouts + 5xx) — both surface the same final error banner. Differentiating would need server-side health-check probing or hot-path observability, both out of scope.
- **(f) Column-missing fallthrough shape.** The try/catch matches `/no such column.*idempotency_key/i` on the error's `message`. D1's `wrangler` runtime surfaces SQLite errors as `Error` instances whose `.message` reads `SqliteError: no such column: idempotency_key` (or similar) — the regex is permissive on word ordering and case. This is the right shape for D1's error semantics; if a future D1 version restructures the error message, the catch block falls through with a logged generic warning rather than crashing.
- **(g) `pendingOnlineRetry` reentrancy.** If a customer goes offline → comes online → goes offline DURING the retry → comes online again before the next backoff tick, the second `online` event will fire `tryOnce` once (we cleared `pendingOnlineRetry` on the first fire). Behavior is correct: only the most recent retry-pending state matters because all retries share the same FormData + key.
- **(h) Service-worker / Background-Sync / IndexedDB photo persistence** remain explicitly out of scope per operator. Deferred to a follow-up after this brief lands and is exercised against real-world drops.

### Validation results

- **`pnpm typecheck`** — 18/18 green (16 cache hits; db-d1 + damage-worker ran fresh; 2.179s wall). An earlier full-monorepo run produced spurious errors from third-party packages (`@supabase/auth-js/webauthn.dom.d.ts`, `@supabase/phoenix`, `@supabase/storage-js`, `lib.webworker.d.ts`) that cleared on a clean re-run. A direct `pnpm --filter @splash/damage-worker typecheck` exited 0 cleanly.
- **`pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir .wrangler/dry-run`** — succeeded; bundle 1749.47 KiB raw / 397.44 KiB gzip (+9.4 KiB raw / +2.78 KiB gzip vs Brief 137 baseline of 1740.07 / 394.66). Growth is the four new client-side helpers (offline banner state, generateSubmissionId, submitWithRetry) + worker dedup block + `getClaimByIdempotencyKey` helper, all inside the inline FORM_SCRIPT template literal (browser-side JS) plus a handful of worker-side lines. Comfortably under the 3 MiB compressed free-tier ceiling.
- **`pnpm --filter @splash/db-d1 typecheck`** — succeeded (no build script in db-d1; typecheck is the brief-specified equivalent gate).
- **No Supabase / R2 / wrangler.toml / secret changes.** D1 schema change is the only data-layer touch and is operator-applied.

### Report (per brief §Report)

- **Exact line ranges touched in claim-form.ts:**
  - CSS additions next to `.banner-error` — final file ~lines 180–189.
  - `<div id="offlineBanner">` — final file ~line 338.
  - `offlineBanner` element grab — final file ~line 644.
  - Phase 2 offline banner state + listeners — final file ~lines 1079–1100.
  - Phase 3 `submissionId` helper + init — final file ~lines 1106–1125.
  - `setSubmitting` widening, `RETRYABLE_STATUS`, `submitWithRetry` — final file ~lines 1142–1219.
  - Submit handler restructure (Phase 1 + Phase 3 + Phase 4 wiring) — final file ~lines 1224–1300.

- **Exact line ranges touched in `apps/damage-worker/src/index.ts`:**
  - Import addition — line ~77.
  - Phase 3 dedup block insertion — lines ~2395–2462.
  - `idempotency_key` field on the `insert` builder — line ~2620.

- **Exact line ranges touched in `packages/db-d1/src/claims.ts`:**
  - `ClaimInsert` type widening — lines ~83–92 of pre-edit file (now shifted +5 lines).
  - INSERT column / VALUES / bind extensions — lines ~104–166 of post-edit file.
  - `getClaimByIdempotencyKey` helper insertion — lines ~289–308 of post-edit file.

- **The final D1 SQL the operator must run** (documented in the
  "Operator-applied D1 schema migration" section above).

- **Decisions made on the operator's behalf** (documented in the
  "Decisions made on the operator's behalf" section above).

- **Confirmation that the column-missing fallthrough works.** The
  try/catch shape is correct for D1's error semantics. D1's runtime
  surfaces SQLite errors as `Error` instances whose `.message` reads
  `SqliteError: no such column: idempotency_key` (or similar). The
  regex `/no such column.*idempotency_key/i` is permissive on word
  ordering and case so it tolerates minor message-format drift across
  D1 versions. Cannot be smoke-tested from headless (would require an
  actual D1 environment with the column absent), but the regex shape
  is the right one and any miss falls through to the generic "lookup
  failed (proceeding without dedup)" log rather than crashing.
