# Brief 139: Claim form — persist idempotency_key in localStorage draft

**Status:** Completed (2026-05-21)
**Started:** 2026-05-21
**Completed:** 2026-05-21
**Blocks:** Nothing. Closes the last failure mode in Brief 138's
submit-resilience pass.
**Dependencies:**
- Brief 138 (claim form submit resilience) — MUST land first.
  Brief 139 extends Brief 138's Phase 3 idempotency_key plumbing
  into the Brief 136 draft persistence layer.

## Read first

- `apps/damage-worker/src/render/claim-form.ts`
  - IIFE init at ~620 (where Brief 138 introduces `submissionId =
    crypto.randomUUID()` — confirm exact line post-Brief-138)
  - `loadDraft()` / `saveDraft()` / `clearDraft()` at ~867–893
  - `serializeForm()` at ~904 (the function that captures form
    values into the `values` object that gets persisted)
  - Brief 138's success-branch `clearDraft()` call (post-Phase-1
    reordering — confirm location)
  - Resume banner restoration path — `applyDraftValues()` or
    similar (Brief 136 — find via grep on `loadDraft` callers)

## Context

Brief 138 closed three of the four failure modes in the customer
claim form submit path (lost draft on fail, no offline indicator,
no auto-retry on transient errors). It also introduced an
`idempotency_key` (client-generated UUID v4) that the worker uses
to dedup retried submissions — so the auto-retry loop is safe to
turn on without creating duplicate claims.

But Brief 138's `submissionId` is generated **at IIFE init time
and held in a closure variable**. That means it dies when the page
unloads. The failure mode this leaves open:

1. Customer fills form, clicks Submit.
2. Submit fetch reaches the worker, worker writes the claim row,
   PDF generates, webhooks fire — full server-side success.
3. Response is lost on the way back to the browser (Wi-Fi blip,
   CF edge timeout, customer closes the tab mid-response, mobile
   OS suspends the tab before the response paints).
4. Customer reopens `/claims/{site}` later. Brief 136's Resume
   banner appears with the typed fields intact (Brief 138's Phase 1
   preserved the draft on failed submit).
5. Customer clicks Resume, clicks Submit. IIFE generates a FRESH
   `submissionId`. Worker has no record of the new UUID. New claim
   row inserted. **Duplicate claim.**

The dedup needs the idempotency_key to survive the page-unload
boundary. The right home is the localStorage draft — same
durability as the typed values it protects.

This is a small, surgical follow-up. One line added to the draft
JSON shape, one line in the load path, one line at IIFE init to
prefer the restored key when present, one line in the success
branch to invalidate. No worker-side change (the worker doesn't
care where the UUID came from).

## Scope

### Phase 1 — Persist `idempotency_key` in the draft

`apps/damage-worker/src/render/claim-form.ts`:

**At IIFE init (~620, post-Brief-138):**

Brief 138 introduces:
```js
var submissionId = crypto.randomUUID();
```

Replace with:
```js
// Brief 139: prefer an idempotency_key restored from the localStorage
// draft over a freshly-generated one. The restored key fingerprints
// the customer's prior submit attempt — if that attempt actually
// succeeded server-side but the response was lost, reusing the key
// on retry collapses to the existing claim via the worker's dedup
// path (Brief 138 Phase 3) instead of creating a duplicate.
var existingDraft = loadDraft();
var submissionId = (existingDraft && existingDraft.idempotencyKey)
  ? existingDraft.idempotencyKey
  : crypto.randomUUID();
```

Note: `loadDraft()` is defined further down the file (~867). The
function is hoisted via `var`-style function declaration, so the
call at IIFE init time works. If Brief 136's `loadDraft` is an
arrow-function `const` declaration, hoist the helper above the
`submissionId` init (small mechanical fix).

**In `saveDraft(values)` (~879):**

Brief 136's body:
```js
window.localStorage.setItem(draftKey, JSON.stringify({
  values: values,
  savedAt: Date.now()
}));
```

Replace with:
```js
window.localStorage.setItem(draftKey, JSON.stringify({
  values: values,
  savedAt: Date.now(),
  idempotencyKey: submissionId
}));
```

**In `loadDraft()` (~867):**

The current return shape is `{values, savedAt}`. The shape should
now also surface `idempotencyKey` (defensively typed — string or
null). Brief 136's existing validation block only asserts `values`
+ `savedAt`; extend it with a tolerant read of `idempotencyKey`:

```js
return {
  values: parsed.values,
  savedAt: parsed.savedAt,
  idempotencyKey: (typeof parsed.idempotencyKey === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.idempotencyKey))
    ? parsed.idempotencyKey
    : null
};
```

Validation regex matches Brief 138's worker-side validator. Drafts
saved by older builds of the form (pre-Brief-139) won't have the
key — that's fine, the IIFE init falls through to
`crypto.randomUUID()` and the customer gets a fresh key.

**In the submit success branch (Brief 138 Phase 1's `clearDraft()`
call site):**

Add a `submissionId = crypto.randomUUID();` line right after
`clearDraft()`. Defensive measure — Brief 138 already specs this
for the "future code that re-shows the form" case, but Brief 139
makes it strictly necessary because the restored key contract
demands a fresh key on any genuinely new submission.

**At the Resume banner's "Start over" / "Discard" action:**

When the customer clicks Start over (Brief 136 wires this), the
flow drops the draft entirely. Add a `submissionId =
crypto.randomUUID();` line so the customer's next submit attempt
gets a fresh key. Find the existing `clearDraft()` call in the
Start over handler and add the key regeneration immediately after.

### Phase 2 — Validation

2.1 `pnpm typecheck` — must pass.
2.2 `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — must succeed.
2.3 No worker / Supabase / R2 / D1 schema / wrangler.toml / secret changes.
2.4 Operator post-deploy smoke (deferred):
- Open `/claims/{site}` on a real customer device.
- Fill the customer section.
- Open DevTools → Application → Local Storage. Confirm the
  `claims.draft.{slug}` key contains an `idempotencyKey` field
  matching the UUID v4 shape.
- Open DevTools → Network → set throttling to "Offline".
- Click Submit. Confirm the retry loop exhausts and the error
  banner surfaces. Confirm the localStorage `idempotencyKey` is
  UNCHANGED throughout.
- Close the tab entirely.
- Re-open `/claims/{site}`. Confirm the Resume banner appears.
- Click Resume. Open DevTools console. Inspect the JS closure
  (e.g., temporarily expose `window.__submissionId = submissionId`
  in dev). Confirm the restored `submissionId` matches the
  localStorage `idempotencyKey` from before the tab close.
- Re-enable network. Click Submit. Confirm success — and confirm
  D1 shows a single row for the claim (not two).
- Idempotency end-to-end check: temporarily corrupt the response
  (DevTools → Network → block the `/claims-api/submit-claim`
  response after the request lands) → close tab → reopen → Resume
  → Submit → confirm response carries the SAME `claim_id` that the
  blocked first attempt actually wrote to D1.

### Phase 3 — Updates

3.1 BRIEFS/INDEX.md: Brief 139 row appended.

3.2 BUILD_STATE.md: Findings entry noting:
- Brief 139 (YYYY-MM-DD) — Persisted Brief 138's
  `idempotency_key` (renamed in the draft JSON as `idempotencyKey`
  per JS convention; the worker still reads `idempotency_key` from
  FormData) into the localStorage draft. Closes the last duplicate-
  claim failure mode in the submit-resilience pass: customer fills
  form → submits → server writes claim → response is lost → tab
  closes → customer reopens → Resume → Submit again. With Brief 139
  the second Submit reuses the original UUID and collapses to the
  existing claim via Brief 138's worker dedup. Trivial diff
  (~6 lines net) on top of the Brief 136/138 plumbing.

3.3 CLAUDE.md: update the existing **idempotency_key** glossary
entry (added in Brief 138 per its Phase 6.3) with a one-sentence
note that the key is persisted in the localStorage draft alongside
the typed field values, so it survives tab-close + reload. No new
glossary entry — this is a refinement of Brief 138's.

## Out of scope

- Service worker for offline page-load (still deferred per Brief 138
  Out of scope).
- Background Sync API for queued offline submits (still deferred).
- IndexedDB photo persistence (still deferred).
- Any change to the worker-side dedup logic.
- Any change to the D1 schema.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `submissionId` IIFE init prefers `loadDraft().idempotencyKey` over
  `crypto.randomUUID()` when a restored key is present and matches
  the UUID v4 shape.
- `saveDraft()` writes `idempotencyKey` alongside `values` +
  `savedAt`.
- `loadDraft()` returns `idempotencyKey` (defensively validated).
- Success branch + Start over handler both regenerate `submissionId`
  after their `clearDraft()` calls.
- `pnpm typecheck` passes.
- `wrangler deploy --dry-run` succeeds on damage-worker.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 3.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- The exact line ranges touched in claim-form.ts.
- Confirmation that `loadDraft()` is callable at IIFE init time
  (i.e., the hoist ordering works), or note the hoist change if
  it was needed.
- Any edge cases discovered during implementation that the smoke
  test should cover.

## Outcome

### Summary

Surgical follow-up to Brief 138 closing the last cross-session
duplicate-claim failure mode in the customer `/claims/{site}` submit
path. Promoted Brief 138's `submissionId` from a closure-only variable
into the Brief 136 localStorage draft alongside the typed field values,
so the key survives tab-close / page-reload / lost-response and the
worker's dedup query collapses a Resume + Submit to the prior claim
instead of creating a duplicate row.

### Files modified

- `apps/damage-worker/src/render/claim-form.ts` — four small inline-JS
  edits inside `FORM_SCRIPT`:
  - `loadDraft()` (~L885–L908 post-edit): return shape extended with
    `idempotencyKey` (UUID v4 regex validator; null when missing or
    malformed).
  - `saveDraft(values)` (~L913–L928 post-edit): persists `submissionId`
    as `idempotencyKey` alongside `values` + `savedAt`.
  - IIFE init in the "Brief 138 Phase 3 — idempotency key" block
    (~L1138–L1162 post-edit): replaced the unconditional
    `var submissionId = generateSubmissionId();` with a `loadDraft()`
    read that prefers the restored key when present.
  - Resume banner Start over handler (~L1090–L1098 post-edit):
    regenerate `submissionId` after `clearDraft()`.
- `BRIEFS/INDEX.md` — Brief 139 row appended in the main numbered table.
- `BUILD_STATE.md` — Last-updated paragraph bumped to 2026-05-21 with
  the Brief 138 summary preserved as "Previously". New Findings entry
  at the top of the table with full file-by-file detail + decisions +
  latent flags + validation results.
- `CLAUDE.md` — `idempotency_key` glossary entry's last paragraph
  rewritten — Brief 139 now describes the realized behavior (persisted
  via localStorage draft, defensively UUID-v4-validated, regen on Start
  over) rather than the proposed future.

### Files created / deleted

- None.

### Exact line ranges touched in claim-form.ts (per brief's Report ask)

- `loadDraft()`: ~L885–L908 (was L877–L888 pre-edit). Net +12 LOC:
  added the `idemRe` const, the `idemKey` resolution, and the
  three-field return-shape rewrite.
- `saveDraft(values)`: ~L913–L928 (was L889–L899 pre-edit). Net +4
  LOC: comment + the `idempotencyKey: submissionId` field on the
  persisted JSON object.
- Brief 138 Phase 3 IIFE init block: ~L1138–L1162 (was L1104–L1126
  pre-edit). Net +5 LOC: extended the existing comment block with the
  Brief 139 explanation; replaced the unconditional init with the
  `existingDraft && existingDraft.idempotencyKey` guard.
- Resume banner Start over handler: ~L1090–L1098 (was L1054–L1057
  pre-edit). Net +4 LOC: comment + `submissionId = generateSubmissionId();`
  line after `clearDraft()`.

Total net delta: ~25 LOC added (mostly explanatory comments per
project commenting posture — actual code change is ~6 LOC net per the
brief's "trivial diff" estimate).

### Confirmation that `loadDraft()` is callable at IIFE init time

Yes — no hoist change required. `loadDraft` is declared with the
`function loadDraft() { ... }` syntax (a function declaration, not an
arrow-function `const`). JavaScript hoists function declarations to
the top of their containing function scope, so `loadDraft()` is
callable from any line inside the IIFE regardless of textual order.
The closure variables it references (`draftKey`) are themselves `var`
declarations set above the init line (at ~L883 pre-edit), so the
runtime values are initialized by the time the init reads them.

### Decisions made on operator's behalf

1. **Field naming.** Persisted JSON uses `idempotencyKey` (camelCase
   per JS convention in this file); the wire / D1 / worker-side name
   stays `idempotency_key` (snake_case). The brief explicitly called
   this out.
2. **Validator regex.** Same UUID v4 regex Brief 138 uses on the
   worker side — consistency means a key that round-trips through the
   draft is guaranteed to also pass worker dedup validation.
3. **Both failure modes return null.** The validator collapses "field
   absent" and "field present but malformed" into the same null
   result — both paths fall through to `generateSubmissionId()` in
   the init, no observable behavior difference.
4. **Second `loadDraft()` call.** The init reads `loadDraft()` even
   though `maybeRenderResumeBanner()` (already called at ~L1076) also
   reads it. The function is cheap (one localStorage read + one
   `JSON.parse`) and the alternative (hoisting a shared
   `var draftSnapshot`) would require restructuring the IIFE ordering.
   Net cost is negligible for a typical claim draft payload.
5. **Start over regen.** Brief 138 already regenerates on success;
   Brief 139 mirrors that pattern on the Start over discard path
   because both move the form into a "genuinely new attempt" state.
   Missing the Start over path would leak the discarded draft's key
   into the next submission.

### Edge cases discovered during implementation (smoke-test additions)

- **Pre-Brief-139 drafts.** A customer with an existing draft saved
  by a pre-Brief-139 build won't have the `idempotencyKey` field.
  `loadDraft()` returns `{values, savedAt, idempotencyKey: null}`;
  the init falls through to `generateSubmissionId()`. As soon as the
  customer types anything (triggering the debounced `saveDraft`),
  the draft gets re-saved WITH the new field. No data migration
  needed. Smoke test should verify a draft saved pre-deploy survives
  the schema change without breaking the form.
- **Resume → immediate Submit without typing.** A customer who
  clicks Resume and immediately clicks Submit (without modifying any
  field) still gets the restored key on the submit FormData — because
  `restoreForm()` fires input/change events at the end of its loop
  (~L988–L992 of the existing Brief 136 code) which triggers
  `scheduleSave` → `saveDraft` with the restored `submissionId`. The
  worker's dedup query catches the duplicate.
- **Start over → immediate Submit.** A customer who clicks Start over
  and immediately clicks Submit (without typing anything) gets the
  freshly-regenerated `submissionId` because the Start over handler
  runs synchronously before any other event. The FormData submitted
  carries the new UUID, the worker treats it as a fresh claim.
- **Two tabs open.** A customer with two `/claims/{site}` tabs open
  for the same site has two independent IIFEs reading the same
  localStorage key. Each IIFE's init reads `loadDraft()` once at
  start; subsequent `saveDraft` calls from either tab overwrite the
  persisted `idempotencyKey`. If tab A submits successfully (clears
  draft + regens), then tab B's in-memory `submissionId` is now
  orphaned — but that's OK because tab B's submit will use its own
  in-memory key, the worker will treat it as a new submission, and
  the customer will see a duplicate claim from tab B. This is an
  existing two-tab-open edge case Brief 138 didn't close and Brief
  139 doesn't either (smoke-test step optional).

### Validation results

- `pnpm typecheck` — 18/18 green. 17 cache hits; damage-worker ran
  fresh. 2.336s wall.
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir .wrangler/dry-run` —
  succeeded. Bundle 1751.20 KiB raw / 398.09 KiB gzip (+1.73 KiB raw /
  +0.65 KiB gzip vs Brief 138 baseline of 1749.47 / 397.44; growth is
  the loadDraft / saveDraft / init delta inside the inline FORM_SCRIPT
  template literal). Comfortably under the 3 MiB compressed free-tier
  ceiling.
- No worker / Supabase / R2 / D1 / wrangler.toml / secret / package.json
  changes. Strictly an inline FORM_SCRIPT template literal edit.

### Operator post-deploy smoke (deferred per Phase 2.4)

Captured in the brief's Phase 2.4 list verbatim. The key additional
step beyond Brief 138's smoke list: confirm that the localStorage
`idempotencyKey` field is present after the first input event,
matches the in-memory `submissionId`, is UNCHANGED across a failed
submit + tab close + reopen + Resume, and that the post-Resume Submit
re-uses the same UUID such that the worker dedups to a single D1 row.
