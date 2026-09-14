# Brief 75: Work Orders New Request — single-photo (drop the broken `/attachment/` path) + Required Phone

**Status:** Completed (2026-05-08)
**Started:** 2026-05-08
**Completed:** 2026-05-08
**Blocks:** Brief 74's New Request submit path. First operator
smoke test 2026-05-08 surfaced two issues: (1) MaintainX returns
`404 Cannot PUT /v1/workrequests/{id}/attachment/{filename}` for
every photo beyond the first, so 4 of 5 uploaded photos fail per
submission; (2) Requester Phone was optional but operator wants it
required.
**Dependencies:**
- Brief 74 (the New Request form, worker endpoint, and helpers
  this brief patches).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-074-workorders-new-request-tab-and-priority-pill-fixes.md
  (the brief this patches; specifically Phase 3 for the worker
  endpoint and Phase 4 for the form)
- apps/workorders-worker/src/index.ts (the
  `POST /workorders/api/request` handler — drops the attachment
  upload loop)
- apps/workorders-worker/src/maintainx.ts
  (`uploadMaintainXWorkRequestFile` — the helper Brief 74 added;
  this brief leaves the helper itself intact but the caller no
  longer invokes it for `endpoint: "attachment"`. Helper signature
  stays for a future brief that brings back multi-photo if
  MaintainX ever exposes a working attachment endpoint for work
  REQUESTS as opposed to work ORDERS.)
- apps/web/app/workorders/_components/NewRequestForm.tsx (the form
  this brief modifies — drops `multiple` on the file input, marks
  phone required)

## Context

### Empirical evidence from Brief 74's first deploy

Operator submitted request `11692116` with 5 photos. Worker logs
captured:

```
"workorders-worker request 11692116 photo 1 (attachment) failed:
 status=404 error=MX 404: {\"error\":\"Cannot PUT
 /v1/workrequests/11692116/attachment/download__2_.jpg\"}"
```

Photo 0 → `/thumbnail/` succeeded (the request was created with a
visible thumbnail). Photos 1–4 → `/attachment/` all 404'd. The
operator's API-doc paste in Brief 74 listed the same `/thumbnail/`
URL twice; the `/attachment/` path was inferred by the planner from
the doc heading "Update work request attachment", not from a
documented URL.

**Most likely root cause** (operator's interpretation 2026-05-08):
work REQUESTS are pre-approval objects with a limited file surface
— only the thumbnail. Once a request is approved into a work
ORDER, additional file endpoints (`/v1/workorders/{id}/...`) become
available. MaintainX's API docs may document an attachment endpoint
on work orders that doesn't exist on work requests. Without a
documented work-request attachment URL, the inferred `/attachment/`
path is invalid.

### Design pivot: single photo only

This brief drops the multi-photo path:
- File input becomes single-file (no `multiple` attribute).
- Worker calls only `/thumbnail/`; the attachment loop is removed.
- Form copy updates to set expectations: "Photo (optional).
  Additional photos can be added in MaintainX after the request is
  approved."
- The helper `uploadMaintainXWorkRequestFile` stays intact —
  unchanged signature, no caller for `endpoint: "attachment"` in
  the codebase. A future brief that lands a working multi-photo
  path can re-call it without modifying the helper.

If operators surface a real need for multi-photo before MaintainX
makes the work-request attachment surface available, a follow-up
brief can:
- Empirically test alternate paths (`/files/`, `/attachments/`
  plural, `/uploads/`, etc.) by curling staging MaintainX with the
  bound API key.
- Or post the request → poll for approval → POST attachments to
  the resulting work-order ID. Two-step async; significantly more
  complex.

Both paths are deferred to a future brief if needed.

### Required phone

Operator's 2026-05-08 review: "requester phone needs to be
required." Brief 74 had it as optional with default "—" inserted
into the description footer. This brief adds the
client-side `required` attribute and the worker-side rejection
mirror (303 redirect to `/workorders?tab=new&request_error=...`
when missing).

## Scope

### Phase 1 — Form: phone required + single-file photo input

1.1 In `apps/web/app/workorders/_components/NewRequestForm.tsx`:

  - Requester Phone input — add `required` attribute, swap the
    placeholder / helper text from "(optional)" to whatever
    matches the rest of the required fields' visual style (e.g.,
    a red `*` after the label).
  - Photo input — remove the `multiple` attribute so the browser
    only accepts a single file. Update the helper text:
    ```
    "Photo (optional). Additional photos can be added in MaintainX
     after the request is approved."
    ```
  - Tighten any inline JS validation that capped at 5 photos —
    drop those lines or simplify to "max 1" (a no-op given the
    `multiple` removal but defensive).

1.2 The form's hidden inputs and other fields are unchanged.

### Phase 2 — Worker: validation + attachment-loop removal

2.1 In `apps/workorders-worker/src/index.ts`'s
`POST /workorders/api/request` handler:

  - Add server-side validation for `requester_phone`:
    - Trim the value; reject with 303 redirect
      `?request_error=requester_phone_required` if empty.
    - No format validation (don't try to validate phone
      structure — operators may legitimately enter international
      formats, extensions, etc.). Just non-empty.
  - Remove the photos-2-through-N upload loop. After the
    `createMaintainXWorkRequest` call succeeds:
    - If a `photo` file is present in `formData`, call
      `uploadMaintainXWorkRequestFile` ONCE with
      `endpoint: "thumbnail"` for that single file.
    - On thumbnail-upload failure, log + 303 redirect with
      `?request_ok={id}&photo_warn=thumbnail_failed`. The request
      itself was created; this is the existing degraded-success
      pattern.
  - Drop the multi-photo cap check (≤5) — `formData.getAll("photo")`
    will only return one entry given the form's input lacks
    `multiple`. Defense-in-depth: if more than one photo somehow
    arrives, take the first and silently ignore the rest with a
    `console.warn`.

2.2 The description footer composition stays exactly the same —
phone is no longer rendered as `"—"` because the worker rejects
empty phones before reaching the description-build step.

### Phase 3 — Documentation updates

3.1 CLAUDE.md — under the "Work Orders" glossary entry, append:

```
- Brief 75: Work-request attachment endpoint (`/v1/workrequests/{id}/
  attachment/{filename}`) returns 404 for every request — work
  requests appear to support thumbnail only. Brief 74's multi-photo
  upload path was retired; New Request form takes a single photo
  (the thumbnail). Multi-photo is a future enhancement gated on
  empirical confirmation that a working attachment endpoint exists
  for work requests (or a two-step request → approve → attach
  flow).
```

3.2 BUILD_STATE.md:
  - Bump "Last updated".
  - New row in "Open work — prioritized" for Brief 75.
  - Findings entry: "Brief 74 multi-photo path retired — MX 404
    on `/v1/workrequests/{id}/attachment/{filename}`; single
    thumbnail only. Phone now required."

3.3 BRIEFS/INDEX.md — append Brief 75 row.

3.4 BRIEFS/QUEUE.md — append Brief 75 filename.

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass for all 14 packages.

4.2 `pnpm --filter @splash/web build` — must succeed.

4.3 `pnpm --filter @splash/workorders-worker exec wrangler deploy
--dry-run` — must succeed.

4.4 No D1 / Supabase schema change. No new env vars.

4.5 Live smoke test (operator post-deploy):
  - (a) Submit a New Request with phone field empty — confirm
    303 redirect with `request_error=requester_phone_required`,
    red banner renders on the page.
  - (b) Submit a New Request with phone filled and a single
    photo — confirm 303 redirect with `request_ok={id}`, request
    appears in MaintainX with the photo as thumbnail.
  - (c) Submit a New Request with phone filled and NO photo —
    confirm 303 redirect with `request_ok={id}`, request appears
    in MaintainX with no thumbnail (the existing fail-soft path
    still works when no photo is attached).

## Out of scope

- Investigating alternate MaintainX endpoints for work-request
  multi-attachment (`/files/`, `/attachments/` plural, etc.).
  Deferred to a future brief if operators surface real demand.
- Two-step request-then-approve-then-attach flow. Significantly
  more complex; deferred.
- Phone format validation. Operator may want a regex check later
  ("must contain digits", "must be 10+ chars") — out of scope here.
- Re-introducing `multiple` on the photo input as a forward-compat
  knob. The next brief that lands multi-photo will re-add it
  alongside whatever new endpoint logic works.
- Don't deploy from headless. Push triggers CF Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/web/app/workorders/_components/NewRequestForm.tsx`:
  Requester Phone input has `required`; Photo input lacks
  `multiple`; helper text updated.
- `apps/workorders-worker/src/index.ts` `POST /workorders/api/request`:
  rejects missing phone; only calls `uploadMaintainXWorkRequestFile`
  with `endpoint: "thumbnail"`; no attachment-loop iteration.
- `uploadMaintainXWorkRequestFile` helper signature unchanged
  (still accepts the `"thumbnail" | "attachment"` discriminator).
- pnpm typecheck passes
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/workorders-worker exec wrangler deploy
  --dry-run succeeds
- BRIEFS/INDEX.md, BRIEFS/QUEUE.md, BUILD_STATE.md, CLAUDE.md
  updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Files modified (~3-4: NewRequestForm.tsx, index.ts (worker),
  CLAUDE.md, BUILD_STATE.md)
- Bundle deltas (small — net code reduction in worker since
  attachment loop is removed)
- Validation results
- Decisions made on the operator's behalf
- Latent issues / forward flags

## Outcome

### Files modified (5)

1. **`apps/web/app/workorders/_components/NewRequestForm.tsx`**
   - Dropped `useState` import; component is now stateless.
   - Deleted the `MAX_PHOTOS = 5` constant and the `useState<number>(0)`
     photo-count tracker.
   - Requester Phone `<input>`: added `required` attribute, removed
     `placeholder="Optional"`, added the `required` prop on its
     surrounding `FieldRow` so the existing red-asterisk pattern fires
     (matches the other 4 required fields).
   - Photo `<input>`: dropped the `multiple` attribute and the inline
     `onChange` cap-and-clear handler (alert + `e.target.value = ""`
     branch is gone). Field label collapses from
     `Photos (up to ${MAX_PHOTOS})` to `Photo (optional)`. Helper text
     replaced with the brief's verbatim copy:
     `Additional photos can be added in MaintainX after the request is
     approved.`
   - Added a Brief 75 comment block above the photo field explaining
     the work-request-only thumbnail surface so a future reader doesn't
     re-add `multiple` without context.

2. **`apps/workorders-worker/src/index.ts`** (handler at
   `POST /workorders/api/request`)
   - Top-of-section comment block updated to call out the Brief 75
     pivot and the preserved helper signature.
   - Deleted the `REQUEST_MAX_PHOTOS` constant.
   - Added a new validation block immediately after the requester-name
     length check that rejects empty `requesterPhone` with
     `?request_error=requester_phone_required` (no format validation
     per the brief's "operators may legitimately enter international
     formats / extensions" note). The existing 30-char cap stays.
   - Replaced the multi-photo upload loop with a single-photo
     thumbnail-only path. `formData.getAll("photo")` still iterated
     for defense-in-depth (curl / browser-quirk multi-file body); if
     more than one non-empty file arrives, take the first and emit
     `console.warn(...Brief 75 single-photo path)`. Per-photo size cap
     (15 MB) preserved.
   - On success, the warn surface collapses from
     `${photoFailures}-of-${photoFiles.length}-photos-failed` to a
     single `thumbnail_failed` literal when the one upload fails (the
     request is created either way; the operator banner copy now
     surfaces "the photo couldn't be uploaded as the request thumbnail"
     and a re-attach hint pointing at MaintainX).
   - Description-footer composition simplified: phone is no longer
     conditionally rendered as `"—"` because empty phones never reach
     this step. Footer now reads `Requested by: ${requesterName}\n
     Phone: ${requesterPhone}\nSubmitted via: Splash /workorders`.
   - Total endpoint upper bound shrinks from ~90s (1 create + 5
     uploads) to ~30s (1 create + 1 thumbnail).

3. **`apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`**
   - Added a module-level `REQUEST_ERROR_MESSAGES` map that translates
     `requester_phone_required` → `"Requester phone is required."`;
     unknown error codes still render verbatim, matching the prior
     behavior.
   - The warn-banner branch special-cases `thumbnail_failed` →
     `"the photo couldn't be uploaded as the request thumbnail"`, with
     the prior dash-replacement fallback preserved for forward-compat.
     Closing copy reflowed to "You can attach the photo directly in
     MaintainX." (singular, since there's at most one photo now).
   - Decided on the operator's behalf to do this translation here
     rather than only in the worker, so the same plain-form failure
     path that already surfaces machine-readable codes (Brief 74's
     posture) doesn't regress to ugly snake_case banner text. No
     harness changes required and the worker can keep emitting the
     terse code form for log grep.

4. **`CLAUDE.md`** — Work Orders glossary entry under the **Glossary**
   section gained a Brief 75 paragraph noting the 404, the multi-photo
   retirement, the required-phone rule, and the preserved helper
   signature. No other CLAUDE.md sections needed touching.

5. **`BUILD_STATE.md`** — `Last updated:` prefix on the status snapshot
   line bumped with a Brief 75 summary clause prepended ahead of Brief
   74's; new row in **Open work — prioritized** for Brief 75 (priority
   slot 75, status **completed (2026-05-08)**); new row at the top of
   the **Findings & decisions log** documenting the empirical 404
   evidence, the file-by-file changes, and the validation results.

6. **`BRIEFS/INDEX.md`** — Brief 75 row appended after Brief 74 with
   the Brief 75 file link.

(`BRIEFS/QUEUE.md` already had `brief-075-...md` as the active line —
brief instruction "append Brief 75 filename" was already satisfied.
Per project convention the orchestrator is the only writer that
comments completed entries with the `# brief-XXX-...md (completed
YYYY-MM-DD)` form, so this brief leaves the active line as-is and lets
the orchestrator move it on success.)

### Decisions made on the operator's behalf

1. **Brief 75 banner code translation.** The brief specified the worker
   should emit `?request_error=requester_phone_required` and
   `?request_warn=thumbnail_failed` machine-readable codes but didn't
   specify what apps/web should render for them. I added a small
   translation layer in `WorkOrdersTabsClient.tsx` rather than
   hand-write copy in the worker, so the worker stays grep-friendly
   for log analysis and the UI copy stays in apps/web's editing scope.
   If the operator prefers different wording, it's a one-line edit in
   `REQUEST_ERROR_MESSAGES` / the warn-branch ternary.

2. **Defense-in-depth take-first instead of reject.** The brief said
   "if more than one photo somehow arrives, take the first and silently
   ignore the rest with a `console.warn`." I followed that exactly
   rather than rejecting the request — the form drops `multiple` so a
   normal browser submit can't produce N>1, but a curl/quirk path
   still gets a created request with the first photo as thumbnail
   instead of a 4xx redirect. Aligns with the brief's "fail-soft
   posture" theme.

3. **`useState` import deleted.** Brief said "tighten any inline JS
   validation that capped at 5 photos — drop those lines or simplify
   to 'max 1' (a no-op given the `multiple` removal but defensive)."
   I dropped the `useState` import + tracker entirely since (a) the
   `multiple` attribute is the actual gate, (b) the stateless form
   is smaller (route bundle 5.25 kB vs 5.29 kB on Brief 74), and
   (c) defense-in-depth lives in the worker now. If the operator
   wants a client-side cap as a UX hint (e.g., "you selected too many"),
   that's a follow-up.

4. **`REQUEST_MAX_PHOTOS` constant deleted.** No remaining caller after
   the loop removal. Brief 74's "max 5" semantics are gone; per the
   brief's out-of-scope ("Re-introducing `multiple` on the photo input
   as a forward-compat knob…") a future multi-photo brief will define
   its own cap when it lands.

5. **Did NOT update the `NewRequestForm.tsx` top-of-file comment block
   to mention Brief 75.** The existing Brief 74 docblock already
   describes the plain-form posture and the 303-redirect contract; the
   inline Brief 75 comment above the photo field captures the actual
   pivot. Avoided two spots that would drift independently.

### Latent issues / forward flags

- **MaintainX's docs vs. the empirical 404.** The brief calls this out
  ("MaintainX's API docs may document an attachment endpoint on work
  orders that doesn't exist on work requests"). If the operator
  surfaces real demand for multi-photo on Brief 75's heels, a follow-up
  brief could either (a) curl-probe alternate paths (`/files/`,
  `/attachments/` plural, `/uploads/`) on staging with the bound API
  key, or (b) implement a two-step request → poll for approval →
  attach-to-the-resulting-work-order flow. Both are deferred per the
  brief's Out-of-Scope.
- **Phone format validation deferred.** Worker accepts any non-empty
  string up to 30 chars. If operators enter, e.g., "n/a" to satisfy the
  required gate, MaintainX still gets a footer with "Phone: n/a". A
  follow-up brief can add a regex (digits-only, ≥10 chars) if that
  becomes a problem. Not done here per the brief's explicit
  out-of-scope note.
- **Helper signature preserved as a forward-compat hook.** No call
  site for `endpoint: "attachment"` exists anywhere in the codebase
  post-Brief 75. TypeScript still types it as a valid discriminator —
  a future brief that confirms a working work-request multi-photo
  endpoint can re-add the per-photo loop without touching the helper.
  If the multi-photo path stays dead long-term, a future cleanup brief
  could narrow `UploadWorkRequestFileInput["endpoint"]` to
  `"thumbnail"` only and rename the helper. Out of scope here.

### Validation results

| Check | Result |
|---|---|
| `pnpm typecheck` | ✅ 14 packages, all green (`Tasks: 14 successful, 14 total`; @splash/web and @splash/workorders-worker both rebuilt fresh — `cache miss, executing`). |
| `pnpm --filter @splash/web build` | ✅ `Compiled successfully in 6.3s`. `/workorders` route 5.25 kB / 107 kB First Load JS — slightly smaller than Brief 74's 5.29 kB baseline, expected (deleted `useState`, the photo-count handler, `MAX_PHOTOS`). 13/13 static-page generation green. |
| `pnpm --filter @splash/workorders-worker exec wrangler deploy --dry-run` | ✅ `Total Upload: 748.10 KiB / gzip: 142.38 KiB` — same as Brief 74 baseline (the multi-photo loop removal balances against the new validation + helper comment + warn-string changes). Bindings list unchanged: `MAINTAINX_BASE_URL`, `APPS_WEB_BASE_URL`. `--dry-run: exiting now.` |
| Smoke tests (operator post-deploy) | Deferred — headless cannot exercise live MaintainX. Brief Phase 4.5 enumerates the three operator-side smoke cases (empty phone → red banner; phone + photo → request created with thumbnail; phone + no photo → request created without thumbnail). |

No D1 / Supabase schema change. No new env vars. No new secrets. No
new bindings.
