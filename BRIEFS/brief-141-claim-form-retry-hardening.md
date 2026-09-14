# Brief 141: Claim form — retry hardening (drop navigator.onLine gate, longer backoff, post-exhaustion watchdog)

**Status:** Completed (2026-05-21)
**Started:** 2026-05-21
**Completed:** 2026-05-21
**Blocks:** Service worker / Background Sync (still deferred). After
this brief lands, the IndexedDB / service-worker work is the next
logical step but operator-gated.
**Dependencies:**
- Brief 138 (claim form submit resilience) — landed 2026-05-21.
- Brief 140 (truthful D1-failure response) — should land first so
  this brief's retry expansion doesn't surface false "success but
  invisible" cases. Both can be queued in sequence.

## Read first

- `apps/damage-worker/src/render/claim-form.ts`
  - `submitWithRetry` at lines ~1199–1253
  - `scheduleNextAttempt` inside, at ~1238
  - `pendingOnlineRetry` at line 1105 + the 'online' event listener
    at ~1110–1119
  - `setSubmitting(on, attempt)` at ~1169
  - The submit handler call site at ~1331
  - `isRetryableStatus` (post-Brief-140 widening to include 500) —
    grep for it

## Context

Real-world test on 2026-05-21 exposed three problems with Brief
138's Phase 4 retry implementation:

- **G5 (navigator.onLine unreliable).** Operator pulled Wi-Fi
  while filling form. `navigator.onLine` continued to return
  `true` (Windows reports network as "up" whenever ANY interface
  is connected — VPN, LAN, sleeping Ethernet, virtual adapter).
  The `if (!navigator.onLine)` branch in `scheduleNextAttempt`
  never fired. Retries went through the `else` branch
  (setTimeout-with-backoff path) instead of the
  `pendingOnlineRetry` hold path.
- **G6 (1s/2s/4s backoff too aggressive).** Even when the branch
  decision was correct, the total elapsed time between first
  failure and final error banner was ~3 seconds (1s + 2s + ~10ms
  per fast-fail fetch). Operator perceived this as "blasting
  through 1/2/3 as soon as failure occurs". The intent of an
  exponential backoff is to give the network time to recover;
  3 seconds is too short for any realistic flaky-Wi-Fi recovery.
- **G7 (no watchdog after exhaustion).** Once the 3-attempt
  bounded retry loop exhausts, the form surfaces the error
  banner and the loop is done. Nothing watches for connectivity
  to actually return. Operator's 10-minute-wait-after-reconnect
  produced zero automatic retry attempts. The customer is left
  with a banner reading "please retry" — even though the device
  IS now online and a retry would succeed.

Combined effect of G5 + G6 + G7: a customer on a flaky network
(coffee shop Wi-Fi, edge-of-coverage mobile) gets 3 attempts
within 3 seconds, all failing, then a permanent error banner.
They have to MANUALLY click Submit again. The "automatic retry"
feature is functionally a faster manual retry.

This brief replaces the unreliable gate, lengthens the backoff,
and adds a post-exhaustion watchdog.

## Scope

### Phase 1 — Drop the `navigator.onLine` retry gate

`apps/damage-worker/src/render/claim-form.ts`, `scheduleNextAttempt`
at ~1238:

Current:
```js
function scheduleNextAttempt() {
  var delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
  if (!navigator.onLine) {
    pendingOnlineRetry = tryOnce;
  } else {
    setTimeout(tryOnce, delay);
  }
}
```

Replace with the simpler:
```js
function scheduleNextAttempt() {
  var delay = computeBackoffDelay(attempt);
  setTimeout(tryOnce, delay);
}
```

Rationale: empirical fetch failure IS the authoritative signal
that the network is unreachable to OUR origin. `navigator.onLine`
adds nothing useful and lies in the operator's exact test setup.
The retry loop's existing fetch-fail-then-backoff behavior is the
right mechanism — we just need to trust it and not short-circuit
into a "hold for online event" path that can stall forever when
the browser never sees an `offline` event.

The `pendingOnlineRetry` variable + `online` event listener at
~1105/1110 stay — Phase 3's watchdog reuses them. But the
in-loop scheduleNextAttempt path no longer touches them.

**Banner behavior (Brief 138 Phase 2):** The amber offline banner
at line 346 still uses `navigator.onLine` for its display logic.
That's fine — the banner is a visual hint to the customer, and
even when wrong it's a low-stakes UI element. The fix is to
prevent `navigator.onLine` from gating the RETRY LOGIC, not from
showing/hiding a banner.

### Phase 2 — Lengthen backoff

Add a `computeBackoffDelay(attempt)` helper that returns longer
delays than Brief 138's `Math.pow(2, attempt - 1) * 1000`:

```js
function computeBackoffDelay(attempt) {
  // attempt is 1-indexed; this is the delay BEFORE the next attempt
  // (i.e., called from scheduleNextAttempt after attempt N fails,
  // before attempt N+1 starts).
  // Schedule: 2s, 5s, 15s. Plus ±20% jitter so concurrent submits
  // from multiple devices don't synchronize their retries.
  var BACKOFF_SCHEDULE_MS = [2000, 5000, 15000];
  var idx = Math.min(attempt - 1, BACKOFF_SCHEDULE_MS.length - 1);
  var base = BACKOFF_SCHEDULE_MS[idx];
  var jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(500, Math.round(base + jitter));
}
```

Total elapsed time across 3 attempts (after first fail): 2 + 5 = 7
seconds before final error banner. Vs Brief 138's 1 + 2 = 3 seconds.
More than double the recovery window. Still fast enough that a
customer with no real connectivity issue won't notice the wait
(modern submits typically resolve in <1s on a good connection, so
the retry chain only kicks in on actual failures).

The `(2000, 5000, 15000)` schedule:
- 2s after attempt 1 → attempt 2 ≈ 2s elapsed
- 5s after attempt 2 → attempt 3 ≈ 7s elapsed
- 15s after attempt 3 → Phase 3's watchdog territory (not used by
  the bounded retry loop; reserved for the watchdog's first attempt)

Jitter ±20% prevents thundering-herd effects when multiple devices
hit a transient outage simultaneously (e.g., CF edge issue affecting
a region).

### Phase 3 — Post-exhaustion watchdog

After the bounded retry loop exhausts (3 attempts, 7 seconds total),
the form should NOT give up entirely. Instead, attach a long-lived
listener that fires ONE MORE attempt under either condition:

- The browser fires an `online` event (it does eventually fire when
  Wi-Fi reconnects, even if `navigator.onLine` was wrong about being
  offline initially — the offline→online transition IS reliable).
- A periodic timer fires (every 60 seconds, max 30 minutes total
  = 30 attempts ceiling, then give up). This handles the navigator
  flap-blind case where the browser never sees the offline event
  but the network is actually broken then restored.

Implementation:

```js
function startWatchdog(fd) {
  var watchdogAttempts = 0;
  var WATCHDOG_INTERVAL_MS = 60000;
  var WATCHDOG_MAX_ATTEMPTS = 30; // 30 minutes total
  var watchdogTimer = null;
  var armed = true;

  function fireWatchdogAttempt() {
    if (!armed) return;
    watchdogAttempts += 1;
    if (watchdogAttempts > WATCHDOG_MAX_ATTEMPTS) {
      teardownWatchdog();
      return;
    }
    submitOnceForWatchdog(fd).then(function (out) {
      if (out.ok && out.body && out.body.ok && out.body.d1Success !== false) {
        // The watchdog succeeded — paint the success card.
        showOutcome(
          out.body.claim_id || out.body.claimId || '',
          out.body.summary_pdf_url || ''
        );
        clearDraft();
        submissionId = generateSubmissionId();
        teardownWatchdog();
      }
      // Non-success → just wait for the next watchdog tick or
      // online event. The error banner is already showing.
    }).catch(function () {
      // Same — wait for next tick.
    });
  }

  function teardownWatchdog() {
    armed = false;
    if (watchdogTimer) clearInterval(watchdogTimer);
    window.removeEventListener('online', fireWatchdogAttempt);
  }

  window.addEventListener('online', fireWatchdogAttempt);
  watchdogTimer = setInterval(fireWatchdogAttempt, WATCHDOG_INTERVAL_MS);

  // Public API to disarm (e.g., when customer manually clicks
  // Submit and the resulting attempt succeeds, OR navigates away).
  return teardownWatchdog;
}
```

`submitOnceForWatchdog(fd)` is a one-shot fetch (no retry, no
backoff) — it just fires once and returns whatever the worker says.
The submitWithRetry semantics are too aggressive for a watchdog
poll. If the watchdog attempt fails, we wait for the next tick.

**Why one-shot vs full submitWithRetry?** The watchdog runs across
a 30-minute window. We don't want each watchdog tick to spawn its
own bounded retry loop (3 attempts × 30 ticks = 90 actual fetch
calls, with overlapping backoffs colliding). One-shot per tick is
simpler and the cadence (60s) is already a backoff.

**Idempotency key:** The watchdog reuses the same `submissionId`
the bounded retry loop used. Worker dedup via Brief 138 Phase 3
ensures repeat hits collapse to the existing claim if any earlier
attempt succeeded server-side without the client knowing.

**Customer-facing UI during watchdog:** Update the error banner
copy from "Please retry" to something like "Network unstable —
we'll keep trying every minute. You can also click Submit
manually." Add a subtle progress indicator (text-only: "Last
attempt: 14s ago" or similar — driven by setInterval(1000)).
Keep it understated; the customer's submit is recoverable.

**Manual submit during watchdog:** If the customer manually
clicks Submit while the watchdog is running, the submit handler
calls the watchdog's teardown function first, then runs
`submitWithRetry` normally. The new attempt's success or
exhaustion either way ends the watchdog cycle.

**Page unload:** Standard browser behavior — closing the tab
kills the watchdog. The localStorage draft persists (Brief 138/139),
so the customer can come back later, hit Resume, and try again.
The idempotency key is preserved across the page-unload boundary
via Brief 139's draft persistence, so manual retry from a fresh
page reload still dedups against any prior server-side success.

### Phase 4 — Update setSubmitting / overlay copy

The submitting overlay (Brief 138 Phase 4) currently flashes
"Submitting (retry N of 3)..." between attempts. With the watchdog,
we need:
- During bounded retry loop (attempts 1-3): same as today,
  "Submitting (retry N of 3)..." messaging.
- After bounded loop exhausts, during watchdog: hide the
  submitting overlay (since the form is back to user-interactive),
  show the error banner with the new copy + last-attempt timer.

Implementation detail: when `submitWithRetry`'s promise rejects,
call `setSubmitting(false)` to release the overlay, then call
`startWatchdog(fd)`. The error banner stays visible underneath.

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass.
5.2 `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — must succeed.
5.3 No worker / Supabase / R2 / D1 schema / wrangler.toml / secret changes.
5.4 Operator post-deploy smoke (deferred):
- Smoke A — normal submit. Form fills, submits, success card paints,
  ~1 second total. No regression vs Brief 138.
- Smoke B — bounded retry on transient fail. DevTools → Network →
  "Slow 3G" + block `/claims-api/submit-claim` after request lands
  → submit. Confirm:
  - Overlay shows "Submitting..."
  - Then "Submitting (retry 1 of 3)..." after ~2s
  - Then "Submitting (retry 2 of 3)..." after ~5s more
  - Total elapsed before error banner: ~7s
  - Re-enable network, click Submit again → success
- Smoke C — post-exhaustion watchdog (the main test). Disconnect
  Wi-Fi → submit → wait for bounded retry to exhaust (~7s) →
  error banner appears with "Network unstable — we'll keep
  trying every minute" copy → wait 60s → reconnect Wi-Fi within
  the 60s window → confirm the watchdog auto-fires within seconds
  (online event) → success card paints → D1 has the row → no
  duplicate.
- Smoke D — watchdog 30-minute ceiling. Disconnect Wi-Fi, submit,
  let it run for ~31 minutes without reconnecting. Confirm
  watchdog gives up at the 30-minute mark, error banner stays
  visible. Customer can still click Submit manually after that.
- Smoke E — manual submit during watchdog. Submit while offline,
  let bounded retry exhaust, error banner appears with watchdog
  running. Reconnect Wi-Fi but BEFORE the watchdog fires its next
  tick, click Submit manually. Confirm:
  - Watchdog tears down
  - Manual submit runs through submitWithRetry
  - Success card paints
  - No double-submit / duplicate

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md: Brief 141 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
- Brief 141 (YYYY-MM-DD) — Hardened the claim form retry loop
  against real-world failure modes exposed by Brief 138 testing.
  Three changes: (a) dropped the `navigator.onLine` retry gate
  in `scheduleNextAttempt` — empirical fetch failure is the
  authoritative signal, and `navigator.onLine` is unreliable on
  Windows when ANY network interface is up; (b) lengthened the
  backoff schedule from 1s/2s/4s to 2s/5s/15s with ±20% jitter,
  giving real-world flaky networks more time to recover before
  the bounded retry exhausts (~7s total vs ~3s); (c) added a
  post-exhaustion watchdog that attaches an `online` event
  listener + 60s polling timer for up to 30 minutes after the
  bounded retry exhausts, firing one-shot retry attempts as
  connectivity recovers. Idempotency key reused across watchdog
  attempts. Customer-facing copy on the error banner updated
  to "Network unstable — we'll keep trying every minute."

6.3 CLAUDE.md: no changes needed (the retry contract is internal
to claim-form.ts; the glossary entries for idempotency_key already
cover the dedup semantics).

## Out of scope

- Service worker for offline page-load (still deferred).
- Background Sync API for queued offline submits (still deferred).
- IndexedDB photo persistence (still deferred).
- Watchdog cross-tab coordination (a single customer with the
  same draft open in two tabs could theoretically have two
  watchdogs running. Same idempotency key dedups any conflicting
  retries. Cross-tab BroadcastChannel coordination is overkill).
- Pause-while-tab-hidden semantics for the watchdog. Modern
  browsers throttle setInterval in backgrounded tabs (typically
  to once-per-minute, which happens to match our cadence). No
  special handling needed.
- A retry indicator that survives page reload. The error banner
  + the localStorage draft are the recovery surface; reloading
  the page surfaces the Resume banner from Brief 136/138/139.
  Customer can re-trigger submit manually.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `scheduleNextAttempt` no longer references `navigator.onLine`.
- `computeBackoffDelay(attempt)` returns 2s/5s/15s with jitter.
- `startWatchdog(fd)` exists and is invoked when
  `submitWithRetry`'s promise rejects (or resolves with a
  non-success that exhausted retries).
- Watchdog tears down on success, manual submit, or 30-minute
  ceiling.
- Error banner copy reflects "Network unstable — we'll keep
  trying every minute" when the watchdog is active.
- `pnpm typecheck` passes.
- `wrangler deploy --dry-run` succeeds on damage-worker.
- BRIEFS/INDEX.md + BUILD_STATE.md updated per Phase 6.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- The exact line ranges touched in claim-form.ts.
- Confirmation that the watchdog correctly tears down on all
  three exit paths (success, manual submit, 30-min ceiling).
- Any decisions made about the precise copy of the watchdog-
  active error banner.
- The exact backoff numbers (after jitter applied) observed
  during Smoke B testing if available.

## Outcome

**Files modified.**

- `apps/damage-worker/src/render/claim-form.ts` (inline FORM_SCRIPT template literal):
  - Phase 1 — `scheduleNextAttempt` no longer references `navigator.onLine`
    or `pendingOnlineRetry`; it now unconditionally calls
    `setTimeout(tryOnce, computeBackoffDelay(attempt))`. The
    `pendingOnlineRetry` closure variable + the Phase 2 `online` event
    listener that consumed it are left in place per the brief — they
    have no consumers post-edit but the listener is a harmless no-op
    when `pendingOnlineRetry` is null, and removing them would be
    additional churn outside the brief's Scope. (lines ~1245–1257 in
    the pre-edit file; lines 1263–1266 post-edit.)
  - Phase 2 — new `computeBackoffDelay(attempt)` helper sibling to
    `submitWithRetry` returns `Math.max(500, Math.round(base + jitter))`
    where `base` is `[2000, 5000, 15000][min(attempt-1, 2)]` and
    `jitter = base * 0.2 * (Math.random() * 2 - 1)`. Total elapsed
    across 3 attempts (after first fail): ~2s + ~5s = ~7s, plus or
    minus ~1s of jitter. (lines 1213–1223.)
  - Phase 3 — new `startWatchdog(fd)` function + `submitOnceForWatchdog(fd)`
    one-shot helper + module-scoped `activeWatchdogTeardown` closure
    var. Watchdog fires one attempt per `online` event AND every 60s
    via setInterval up to 30 attempts (30 min ceiling), reusing the
    same FormData (so the idempotency key persists across watchdog
    attempts via FormData's serialized form data). Banner uses
    `submitError` element (the existing `#submitError`); a second
    setInterval(1000) refreshes "Last attempt: Ns ago" suffix every
    second. On success: `showOutcome` + `clearDraft` + regenerate
    `submissionId` + teardown. On 30-min ceiling: replace banner copy
    with "Network unstable — please click Submit to retry manually."
    and teardown. On manual submit: the submit handler tears down via
    `activeWatchdogTeardown` before running `submitWithRetry`. (lines
    1271–1375.)
  - Phase 4 — submit handler's `.then(out)` non-success branch routes
    to `startWatchdog(fd)` when `isRetryableStatus(out.status)` is true
    (HTTP 5xx/408 retries exhausted) and falls through to the original
    `showError(errMsg + ' Please retry.')` otherwise (deterministic
    4xx like 400 — customer must act). `.catch(err)` branch always
    routes to `startWatchdog(fd)` (fetch reject after exhaustion is
    canonical "network is down"). `setSubmitting(false)` runs before
    the watchdog start in both branches so the overlay releases to
    user-interactive. The submit handler's top now tears down any
    pre-existing watchdog before validating + building the new
    FormData. (lines 1418–1424 + 1483–1502.)

**Files created.** None.

**Files deleted.** None.

**Decisions made on the operator's behalf.**

1. **Watchdog selectivity on the `.then(non-success)` branch.** The
   brief is explicit about the `.catch(err)` path → startWatchdog, and
   the Definition of Done says "when `submitWithRetry`'s promise
   rejects (or resolves with a non-success that exhausted retries)".
   For the resolves-with-non-success path I gated the watchdog on
   `isRetryableStatus(out.status)` — a deterministic 4xx (e.g., 400
   validation error from the worker's email regex) is NOT a transient
   network failure, and watchdogging 30 minutes of 400s would burn
   battery + waste customer attention without ever succeeding. The
   customer needs to act on a 400. A 408/500/502/503/504 that
   exhausted 3 attempts IS transient and gets the watchdog. This
   matches the brief's intent ("after the bounded retry loop exhausts")
   without watchdogging deterministic failures.

2. **Banner copy on 30-minute ceiling.** Brief specified initial copy
   ("Network unstable — we'll keep trying every minute. You can also
   click Submit manually.") but left the ceiling state unspecified —
   said only "error banner stays visible. Customer can still click
   Submit manually after that." I chose to replace the rolling copy
   with "Network unstable — please click Submit to retry manually." on
   ceiling, dropping the "we'll keep trying" promise (which is no
   longer true) and the live last-attempt timer (which would freeze).
   The banner stays visible until the customer manually retries or
   reloads the page.

3. **Watchdog uses its own `online` listener, not Phase 2's
   `pendingOnlineRetry` handoff.** Brief said "the `pendingOnlineRetry`
   variable + 'online' event listener … stay — Phase 3's watchdog
   reuses them." The sketch in Scope showed `window.addEventListener(
   'online', fireWatchdogAttempt)` directly inside `startWatchdog` —
   the watchdog adds its own listener rather than plugging into the
   Phase 2 listener's `pendingOnlineRetry` slot. I followed the sketch
   verbatim — both listeners coexist (Phase 2's is now a no-op since
   `scheduleNextAttempt` no longer writes to `pendingOnlineRetry`),
   and the watchdog cleans up its own listener on teardown via
   `removeEventListener`. The Phase 2 variable + listener could be
   deleted in a future cleanup brief, but removing them is outside
   this brief's Scope.

4. **Last-attempt timer driven by setInterval(1000).** Brief noted
   "(text-only: 'Last attempt: 14s ago' or similar — driven by
   setInterval(1000)). Keep it understated." Implemented as appended
   `" (Last attempt: Ns ago)"` suffix on the same banner. Refresh
   cadence 1s feels live without flickering. The display timer is
   torn down alongside the watchdog poll timer.

5. **`submitOnceForWatchdog` 30s `AbortController` timeout.** Brief
   said "one-shot fetch (no retry, no backoff) — it just fires once
   and returns whatever the worker says." It didn't specify a
   per-attempt timeout; I used the same 30s ceiling that the bounded
   retry's `tryOnce` uses so a stalled watchdog fetch can't block the
   next tick. Without it, the worst-case watchdog could pile up
   simultaneous in-flight fetches if every prior attempt was
   stalled-not-rejected.

6. **`armed` re-check inside the watchdog's `.then` callback.** Brief
   didn't explicitly call this out, but in the race where the customer
   manually clicks Submit while a watchdog attempt's fetch is in
   flight, teardown runs synchronously (sets `armed = false`,
   `removeEventListener`, etc.) but the in-flight Promise continues.
   When it resolves, the `if (!armed) return;` check bails before
   touching `showOutcome` / `clearDraft` / `submissionId`. The new
   manual submit's `submitWithRetry` reuses the same `submissionId`
   (Brief 139 makes it stable across the page-unload boundary; here
   it's stable across the within-page watchdog teardown boundary too
   — same closure var). If both fetches happen to land at the worker,
   `getClaimByIdempotencyKey` (Brief 138) dedups them at the D1 layer.

7. **`_err` parameter on the catch handler.** The brief's "showError
   is intentionally NOT called here" implementation note means the
   `err` value is unused. I renamed it `_err` to satisfy lint
   conventions (some `noUnusedParameters` setups flag bare `err`
   without the underscore prefix). The current tsconfig didn't
   complain about either form, but `_err` is the more durable choice.

**Latent issues / forward flags.**

- (a) The `pendingOnlineRetry` closure variable + the Phase 2
  `online` event listener at lines ~1107–1119 are now dead code
  (no consumer writes to `pendingOnlineRetry` post-Phase-1). The
  brief explicitly asked to leave them in place "Phase 3's watchdog
  reuses them" but the watchdog uses its own listener; deletion is
  a small cleanup candidate but out of scope here.
- (b) Brief 138's `setSubmitting(on, attempt)` overlay-text logic
  is unchanged; "Submitting (retry N of 3)..." still shows during
  the bounded retry loop, and `setSubmitting(false)` clears it
  before the watchdog starts. Brief Phase 4 was a no-op on the
  function itself — only the call ordering at the submit handler's
  resolution branches changed.
- (c) If a customer leaves the page open with a watchdog running
  AND `claims.draft.{slug}` localStorage TTL (30 days, Brief
  136/139) hasn't expired, the watchdog continues to fire from
  the in-memory state for up to 30 minutes. The draft is not
  cleared during the watchdog window — only on success or manual
  Start-over via the resume banner.
- (d) Cross-tab watchdog duplication: a customer with the same
  draft loaded in two tabs after Resume can have two watchdogs
  running. Both reuse the same idempotency key (Brief 139's
  localStorage persistence ensures this), so the worker's dedup
  collapses any duplicate writes. Brief explicitly punted on
  BroadcastChannel coordination as overkill.
- (e) Backgrounded-tab throttling: modern browsers throttle
  setInterval in hidden tabs (typically to once-per-minute), which
  happens to match the watchdog's intended cadence. The display
  timer (setInterval(1000)) likewise throttles, but the banner
  copy is only visible when the customer is looking — flickering
  refresh cadence in a hidden tab doesn't matter.
- (f) The watchdog teardown clears the poll timer + display timer
  + `online` listener but does NOT clear the banner text. On the
  manual-submit teardown path, the submit handler's
  `validateBeforeSubmit` → `clearError` immediately hides the
  banner. On the success teardown path, `showOutcome` swaps to
  the outcome card and the banner becomes irrelevant. On the
  30-minute ceiling path, the banner is intentionally left with
  the final "please click Submit to retry manually" copy.

**Validation.**

- Root `pnpm typecheck`: **18/18 green** (17 cache hits, damage-worker
  ran fresh; 2.089s wall).
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run
  --outdir .wrangler/dry-run`: **succeeded**. Bundle **1763.29 KiB
  raw / 401.15 KiB gzip** (+5.92 KiB raw / +1.61 KiB gzip vs Brief
  140 baseline of 1757.37 / 399.54 — growth is `computeBackoffDelay`
  + `submitOnceForWatchdog` + `startWatchdog` helpers + the
  `activeWatchdogTeardown` plumbing in the submit handler). Comfortably
  under the 3 MiB compressed free-tier ceiling.
- No worker / Supabase / R2 / D1 / wrangler.toml / secret changes.
  Edits scoped to the inline FORM_SCRIPT template literal in
  `apps/damage-worker/src/render/claim-form.ts`.

**Operator post-deploy smoke (deferred per brief Phase 5.4).** Smoke A
through Smoke E inclusive — see brief Scope Phase 5.4 for the full
test matrix. The 30-minute Smoke D requires actual elapsed wall time;
operator may want to manually override `WATCHDOG_MAX_ATTEMPTS` to a
small integer (e.g., 3) via a one-off dev build to compress that test
into ~3 minutes. The exact backoff numbers observed during Smoke B
testing are not available until operator runs the smoke — the brief's
Report ask "exact backoff numbers (after jitter applied) observed
during Smoke B testing if available" is therefore deferred. The jitter
formula deterministically yields a value in `[base * 0.8, base * 1.2]`
clamped to `>= 500ms`: attempt 1's delay ∈ [1600, 2400] ms, attempt
2's delay ∈ [4000, 6000] ms, attempt 3's delay (only reached by the
defensive `Math.min(attempt - 1, BACKOFF_SCHEDULE_MS.length - 1)`
clamp when called with attempt=4+, which `submitWithRetry` never does
with maxAttempts=3) ∈ [12000, 18000] ms.

**Line ranges touched in claim-form.ts (post-edit).**

- 1187–1223 — comment block + `RETRYABLE_STATUS` + `isRetryableStatus`
  + new `computeBackoffDelay` helper.
- 1263–1266 — `scheduleNextAttempt` simplified (Phase 1).
- 1271–1375 — new Phase 3 block: `activeWatchdogTeardown` var +
  `submitOnceForWatchdog` + `startWatchdog`.
- 1418–1424 — submit-handler watchdog teardown on manual submit.
- 1483–1502 — submit-handler `.then(non-success)` + `.catch(err)`
  branches route to `startWatchdog(fd)` on retryable-exhausted /
  network-throw paths.

**Watchdog teardown coverage (per brief's Report ask).**

- ✅ Success path: `submitOnceForWatchdog`'s `.then(out)` callback
  calls `teardown()` after `showOutcome` + `clearDraft` +
  `submissionId = generateSubmissionId()`.
- ✅ Manual submit path: form handler's pre-validate block calls
  `activeWatchdogTeardown()` if non-null.
- ✅ 30-minute ceiling: `fireWatchdogAttempt`'s
  `if (watchdogAttempts > WATCHDOG_MAX_ATTEMPTS)` branch replaces the
  banner copy with the final "please click Submit to retry manually"
  message and calls `teardown()`.
