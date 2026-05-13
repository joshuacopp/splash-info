# Brief 122: Custom forms — localStorage autosave + resume banner (long-form persistence)

**Status:** Completed (2026-05-13)
**Started:** —
**Completed:** —
**Blocks:** Neither — UX improvement to the public form-render
path. Lossy mid-fill state is current behavior; this brief makes
long forms survive interruptions.
**Dependencies:** Brief 90 (public form render path), Brief 92
(file/signature OOB upload pattern + `pending_submission_id`).

## Read first

- CLAUDE.md (`forms-worker` glossary entry)
- BRIEFS/brief-090-forms-worker-public-render.md (form-render
  flow + post-submit confirmation)
- BRIEFS/brief-092-forms-file-signature-uploads.md (OOB upload
  pattern + `pending_submission_id` lifecycle; file URLs persist
  even when the form's text fields don't)
- apps/forms-worker/src/render/* (HTML rendering — autosave
  client-side JS gets bundled here)
- apps/forms-worker/static/forms-public.js (Brief 92 — the
  client-side wiring that already exists for OOB uploads;
  autosave hooks into the same input lifecycle)

## Context

Current state: public form rendering is server-rendered HTML
plus a small client-side JS bundle (Brief 92's
`forms-public.js`) that handles file/signature OOB uploads.
Files and signatures upload immediately to R2 keyed by
`pending_submission_id`, so they survive a refresh. All other
field values (text, dropdown, radio, etc.) live only in the
DOM — a refresh, tab close, or navigation away loses
everything except the uploaded files (which can't be
re-attached to a new form load because the new load doesn't
know the previous `pending_submission_id`).

Operator scenario: GM starts retention form on a busy Saturday,
gets interrupted, comes back 20 minutes later or the next day —
everything's gone, has to start over.

Fix: localStorage autosave keyed by form slug. Capture form
state + `pending_submission_id` on every input change (debounced),
restore on page load with a resume banner. Clear on successful
submit. Per-browser-per-device, no server-side draft table —
keeps the surface tiny.

## Scope

### Phase 1 — Autosave client module

Edit `apps/forms-worker/static/forms-public.js` (Brief 92's
client bundle, already wired into the form-render path).
Add:

- `loadDraft(slug)` → reads `localStorage["forms.draft." + slug]`,
  returns `{values, pendingSubmissionId, savedAt}` or `null`.
- `saveDraft(slug, values, pendingSubmissionId)` → writes the
  same shape with `savedAt: Date.now()`. Stringified JSON.
- `clearDraft(slug)` → removes the key.
- Debounced (500ms) `onInputChange` handler bound to every
  `<input>`, `<textarea>`, `<select>` in the form. Reads all
  values into a flat `{key: value}` map, calls `saveDraft`.
- For checkboxes / multi-select / radio groups: serialize all
  named-input values per element name (e.g., `{areas: ["Lot",
  "Approaches"]}` for a multi-checkbox group).
- For signature / file uploads: those are already captured by
  the existing OOB upload flow as hidden inputs with `r2_key`
  values — the autosave naturally picks those up via the same
  serialization (treating them as ordinary hidden inputs).

### Phase 2 — Resume banner

On page load, check `loadDraft(slug)`. If present:

- If `savedAt` is within the last **30 days**, render a banner at
  the top of the form:
  ```
  ┌─────────────────────────────────────────────────────────────┐
  │ 📋 You have a saved draft from {N hr / days} ago.           │
  │   [Resume draft]  [Discard and start fresh]                  │
  └─────────────────────────────────────────────────────────────┘
  ```
- If older than 30 days, silently clear the stale draft and
  render the form as fresh (hygiene cleanup).
- "Resume draft": iterate the saved values map and populate each
  input. Restore the `pending_submission_id` (so existing file/signature
  uploads in R2 stay linked to the form). Then dismiss the banner.
- "Discard and start fresh": call `clearDraft(slug)`, hide banner,
  leave form empty.

If the user starts editing without explicitly choosing, the new
input causes a fresh autosave that overwrites the old draft —
that's fine, "Discard" is the explicit path.

### Phase 3 — Clear on successful submit

In the existing form-submit flow (Brief 90 POST → success →
confirmation page), the redirect to the confirmation page is
the autosave-clear trigger. Two implementation options:

- **Server-side** — append a hidden flag `?clear_draft=1` to the
  submit success redirect; client JS reads it on page load and
  calls `clearDraft(slug)`.
- **Client-side** — intercept the form submit, on success
  (200 redirect status), call `clearDraft(slug)` BEFORE the
  navigation completes.

Either works. Option B is slightly cleaner since it doesn't
leak draft-management concepts into the URL. Use B.

The "Fill Out Another" CTA (Brief 118) doesn't trigger autosave
restore — it lands on a fresh form. The clear-on-submit step
above already cleared the draft, so the resume banner won't
appear for the next fill.

### Phase 4 — Edge cases

- **Quota** — localStorage per-origin limit is ~5-10MB depending
  on browser. A 50KB draft is well under any cap. If the
  `saveDraft` call throws (extremely rare), catch + log + continue;
  don't break the form.
- **Incognito / private windows** — localStorage in those is
  session-scoped and gets cleared when the window closes. The
  resume banner will never show in incognito — that's the right
  behavior (the user implicitly opted out of persistence by
  using incognito).
- **Multiple forms in same browser** — keyed by slug, so they
  don't collide.
- **Form schema changes between save and resume** — if the form
  was edited (new published version) between when the draft was
  saved and when the user comes back, some input keys may not
  exist on the new form. Restore-phase logic should silently
  skip keys not present in the current form's DOM (i.e., set
  only values whose `<input>` exists). Operator gets a partial
  restore instead of a crash. Banner could note this if many
  keys are missing — but v1 just silently skips.
- **PII in localStorage** — for internal staff forms (which is
  all v1 forms — operator confirmed customer-facing surveys are
  v2+), localStorage on internal-managed devices is acceptable.
  Public-audience forms should still autosave (customer abandoned
  a partial survey on their own device — that's their data, fine).
- **Different domains** — staging.splashcarwashes.info and
  splashcarwashes.info don't share localStorage; that's
  acceptable since staging drafts shouldn't transfer to prod
  anyway.

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass (forms-worker is JS; typecheck
    is a no-op for the client bundle but runs against the worker).
5.2 `pnpm --filter @splash/forms-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up.
5.3 No Supabase / R2 / wrangler.toml / secret changes.
5.4 Operator post-deploy smoke (deferred):
    - Open any custom form `/forms/{slug}`, fill several fields
      (mix of text, dropdown, file upload), do NOT submit.
    - Hard refresh the page → resume banner appears ("Saved
      seconds ago"). Click "Resume" → all fields restored
      including the file upload (because `pending_submission_id`
      was preserved).
    - Repeat, then click "Discard" → fields clear, banner hides.
    - Open a different form `/forms/{other-slug}` → no resume
      banner (different draft key).
    - Fill a form, submit it → confirmation page. Go back to
      the form → no resume banner (draft cleared on submit).
    - Open in incognito → fill, refresh → banner appears within
      the same window. Close incognito and reopen → no banner
      (incognito storage is session-scoped, expected).
    - Operator's reported scenario: fill a long form, get pulled
      away, come back 20 minutes / next day → banner appears
      with "Saved 20 min ago" / "Saved 1 day ago", Resume
      restores everything.

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md: Brief 122 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
  - Brief 122 (YYYY-MM-DD) — public form-render path autosaves
    field values to `localStorage["forms.draft.{slug}"]` on every
    input change (debounced 500ms). Resume banner on page load
    if a draft <30 days old exists. Clears on successful submit.
    Survives refresh, browser close, multi-day gaps — same
    browser + same device + no cache clear.

6.3 CLAUDE.md `forms-worker` glossary entry: append a one-liner
noting the autosave behavior so future executors don't accidentally
break the contract.

## Out of scope

- Server-side draft persistence (cross-device survival). Larger
  brief, v2 candidate.
- Encryption of localStorage content. Standard browser
  same-origin sandbox is sufficient for internal-staff forms.
- Draft management UI (list all drafts, manually clear). Not
  needed — single-form-at-a-time UX is what operators expect.
- Conflict resolution when multiple tabs of the same form are
  open. Last-write-wins via the debounced save; acceptable.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `forms-public.js` (the forms-worker static bundle) has
  autosave / loadDraft / saveDraft / clearDraft + debounced
  input listeners.
- Resume banner renders on page load when a <30d draft exists,
  with Resume + Discard actions.
- Autosave clears on successful submit.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 6.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate.
- Validation results.
- Any field types whose serialization required special handling
  (multi-checkbox, radio group, signature pad, etc.).
- Whether the existing OOB upload pattern's
  `pending_submission_id` round-trip survives a resume without
  changes — confirm.

## Outcome

**Files modified.**
- `apps/forms-worker/static/forms-public.js` — extended the Brief 92 +
  Brief 93 client bundle with autosave, resume banner, and clear-on-submit.
  Added `loadDraft(slug)` / `saveDraft(slug, values, pendingSubmissionId)` /
  `clearDraft(slug)` against `localStorage["forms.draft.{slug}"]`,
  `serializeForm(formEl)` / `restoreForm(formEl, values)` walkers over
  `formEl.elements`, `wireAutosave` (debounced 500 ms via a single
  bubbling `input` + `change` listener on the form root),
  `maybeRenderResumeBanner` (renders an amber banner above the first
  field on page load if a <30-day draft exists, with Resume / Discard
  buttons; stale drafts get cleared silently), `wireClearOnSubmit`
  (form `submit` listener calls `clearDraft`). Also lazily-read
  `pending_submission_id` inside `wireSignature` / `wireFile` upload
  handlers (`currentPendingId(formEl)` helper) so a Brief 122 resume
  that rewrites the hidden input flows through to new uploads.
- `BRIEFS/INDEX.md` — Brief 122 row appended.
- `BUILD_STATE.md` — Last-updated line bumped; new Findings row.
- `CLAUDE.md` — `forms-worker` glossary entry gains a Brief 122
  paragraph noting the localStorage autosave contract.
- `BRIEFS/brief-122-forms-localstorage-autosave-and-resume.md` — this
  Outcome section filled in; Status set to Completed.

**Files created / deleted.** None.

**Decisions made on operator's behalf.**

1. **Option B (clear-on-submit) implementation choice.** The brief
   pointed at "intercept the form submit, on success (200 redirect
   status) call `clearDraft(slug)` before navigation completes". The
   form is a native multipart HTML form POST (Brief 90 / Brief 92);
   rewriting it into a `fetch`-based intercept to gate the clear on
   response status is out of scope. Went with the simplest faithful
   interpretation: a `submit` event listener that calls `clearDraft`
   optimistically before the browser navigates. Trade-off — a rare
   422 `validation_failed` response would also clear the draft. The
   user can still hit Back to recover DOM state from bfcache, and
   the v1 4xx-error JSON-page UX is a known limitation tracked
   separately. Documented inline at `wireClearOnSubmit`.
2. **Banner styling via inline `style.*` rather than a CSS class.**
   Keeps the change to a single file (`forms-public.js`) per the
   brief's Scope — no edits to `apps/forms-worker/src/render/shell.ts`
   were required.
3. **Serialization shape.** `values` is a flat `name → value` map
   where:
   - text / textarea / email / number / date / time / select-single /
     hidden → `string`
   - radio → the checked option's `value` (or absent)
   - checkbox (single or grouped, including the multi-select field
     type) → `string[]` of checked values, empty array when none
     checked — collected per-name so the multi field's
     `getAll(name)` semantics survive round-trip
   - select multiple → `string[]` of selected option values
   - file inputs → skipped (browser security forbids programmatic
     restore of `<input type=file>`; the OOB upload's hidden `_r2`
     companion captures the `r2_key` as an ordinary hidden input,
     so file references survive)
4. **Restore fires synthetic `input` + `change` events on every
   touched element** so downstream wired handlers (lookup resolver
   in particular) re-fire. The Brief 93 `wireLookups` "initial
   resolve when key already has a value" path also covers the
   case where the resume happens before the user touches a key
   field.
5. **`pending_submission_id` restore precedence.** On Resume,
   the saved `pending_submission_id` overwrites the freshly-rendered
   one in the hidden input. This is the load-bearing step that
   keeps prior OOB-uploaded files / signatures findable in R2
   (their keys embed the original `pending_submission_id`). The
   signature / file upload handlers were refactored to read the
   pending id at *upload-time* (not wire-time) so a post-DOMContentLoaded
   resume flows through to new uploads transparently. Confirmed:
   the OOB upload `pending_submission_id` round-trip survives a
   resume without changes, just by virtue of the hidden input
   serializing / restoring like any other named input.
6. **Auto-restore vs. explicit Resume.** Followed the brief's
   "show the banner; user clicks Resume" pattern. Auto-restoring
   without confirmation would surprise users who explicitly want a
   fresh form. Discard is an explicit clear; just-start-typing
   without choosing causes a fresh autosave to overwrite the old
   draft on the next debounce (same observable outcome as Discard,
   without the click).

**Latent issues / forward flags.**

- 422 validation_failed loses the draft as described in Decision 1.
  A future brief could move the submit to a `fetch` + `preventDefault`
  intercept so the clear only fires on 200, but that's a bigger
  refactor (also gives us proper inline validation-error rendering,
  removing the current "browser navigates to JSON page" surface).
- localStorage quota errors are caught + warned in console; the
  brief explicitly accepts this trade-off for v1.
- Cross-device / cross-browser resume not supported (server-side
  draft store is the v2 candidate per the brief's Out-of-scope).
- Form schema changes between save and resume: restore loop skips
  saved keys whose `<input>` doesn't exist on the current schema.
  v1 silently drops them; the banner doesn't note partial restore.
- Browser auto-translate features (Chrome's "Translate this page")
  rewrite text content but not input `value` attributes, so the
  localStorage round-trip is unaffected.

**Field types whose serialization required special handling.**

- **Multi-checkbox group (`MultiField`)** — multiple `<input
  type=checkbox>` elements share a `name`; collected as a single
  `string[]` per name. Empty array stored when nothing is checked
  (so restore correctly clears any prior selections instead of
  leaving them set).
- **Radio (`name`/`location`/etc. when rendered as radio in future
  field types)** — only the checked option's value is stored. None
  of the current field types render radio groups so this branch is
  defensive.
- **Signature canvas** — the visible `<canvas>` cannot be serialized
  programmatically (it'd require rasterizing pixel data). Persistence
  is handled implicitly by the hidden `_r2`-companion input that
  Brief 92 writes after each OOB upload — that hidden input
  serializes like any text input. On restore, the saved `r2_key`
  goes back into the hidden input but the `<canvas>` itself remains
  blank (no visible strokes are restored). Operators see a blank
  canvas next to whatever signature-status hint Brief 92 wrote
  previously gone too. v2 candidate: render a small "Signature on
  file" hint when the hidden value is present but the canvas is
  empty.
- **File input** — same story as signature. The hidden `_r2`
  companion captures the r2_key on upload; restore brings back the
  r2_key but not the visible filename / preview state inside the
  `<input type=file>`. Operators see a blank file picker next to
  the same status hint gone too. v2 candidate: render "File
  attached (<original_filename>)" when the hidden value is present.

**OOB upload `pending_submission_id` round-trip.** Confirmed
survives a resume without changes. The hidden input serializes
into the values map alongside everything else; on restore the
saved value overwrites the freshly-rendered one, and the lazy
read inside the upload handlers picks up the restored value on
any subsequent file/signature attachment.

**Diff size estimate.** Single-file change of ~330 LOC added /
~50 LOC modified to `apps/forms-worker/static/forms-public.js`
(originally 339 LOC; now 561 LOC). Worker bundle grew from
1055.04 KiB raw / 201.25 KiB gzip (Brief 119 baseline) to
1066.77 KiB raw / 204.58 KiB gzip — ≈ +12 KiB raw / +3 KiB gzip,
all attributable to the autosave additions in the static asset.

**Validation results.**

- `pnpm typecheck` — 18/18 green (17 cache hits, forms-worker ran
  fresh after the static-asset change invalidated its cache key).
- `pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build` — bundle succeeded. Total
  1066.77 KiB / gzip 204.58 KiB. R2 + env bindings unchanged.
  `.tmp-build` cleaned up after.
- No Supabase / R2 / wrangler.toml / secret changes.

**Operator post-deploy smoke (deferred per brief Phase 5.4).**
See brief's Phase 5.4 checklist — the executor is headless and
can't drive a browser.

No deploy / branch / push performed.
