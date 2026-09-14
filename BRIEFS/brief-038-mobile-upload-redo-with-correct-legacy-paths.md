# Brief 38: Mobile upload redo — verify Brief 37's work with correct legacy-source grounding

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Brief 37 was queued and dispatched with an incorrect
hedge in Phase 1 ("if `legacy/damagemanager.js` isn't in the repo,
ask the operator to paste it from CF dashboard"). The hedge was
wrong — the file IS in the repo (operator confirmed via VS Code
file tree screenshot 2026-05-05). Depending on when Brief 37's
executor read the brief vs. when the planner-side correction
landed, the executor may have:
(a) Read the bad hedge, marked Phase 1 blocked, and not actually
ported the legacy code; or
(b) Found the file anyway despite the hedge and ported it
correctly; or
(c) Done a partial port that doesn't match legacy's behavior.
This brief verifies Brief 37's actual landed state, fills any
gaps, and re-grounds future briefs in the fact that
`legacy/damagemanager.js`, `legacy/signupworker.js`,
`legacy/sysadmin.js`, `legacy/dashboard.js`, and
`legacy/performancetracker.js` are all in the repo and readable
by the executor.
**Dependencies:** Brief 37 (the brief this verifies + completes
if it punted), Brief 5d (document upload pipeline being patched),
Brief 22 (the "Add Note" anchor button pattern Brief 37's Phase 3
mirrors).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-037-mobile-upload-legacy-port-plus-add-doc-anchor.md
  — read the **Outcome section** carefully. That's where the
  executor recorded what they actually did. The Outcome will tell
  you whether Phase 1/2/3 landed in full, in part, or got
  blocked.
- `legacy/damagemanager.js` (in this repo, confirmed present
  2026-05-05) — the legacy upload handler lives here. Use this
  file as the reference for replicating the working mobile upload
  path. Search for handlers responding to upload paths.
- `legacy/signupworker.js` (also in repo) — secondary reference if
  the upload code lives here instead of damagemanager.js.
- `apps/damage-worker/src/index.ts` handleUploadDocument — current
  state after Brief 37 (whatever Brief 37 did, this is where it
  did it).
- `apps/web/app/admin/damage/[id]/_components/UploadDocumentCard.tsx`
  + `actions.ts` — apps/web upload form + (possibly removed)
  server action.
- `apps/web/app/admin/damage/[id]/page.tsx` — claim detail page,
  for the Phase 3 anchor button check.

## Context

**The orchestrator dispatches briefs the moment they're queued.**
There is no "ready to run when you want" — appending a filename
to QUEUE.md IS the run trigger. When Brief 37 was first queued
2026-05-05, it shipped with the wrong "if file isn't in repo,
ask operator" hedge in Phase 1. The planner-side correction (which
removed the hedge) only landed AFTER the executor had already
started reading the brief.

The legacy code paths are all in the repo at
`splash-info/legacy/*.js`:
- `damagemanager.js` — claim form + upload pipeline (this is the
  source of truth for Brief 37's port)
- `signupworker.js` — customer signup logic; possibly also has
  upload code per AUDIT_REPORT.md
- `sysadmin.js`, `dashboard.js`, `performancetracker.js` — other
  legacy modules referenced in many briefs

**Take Brief 37's Outcome at face value.** If it says "Phase 1
deferred to operator" or similar, the executor punted. If it says
"read legacy/damagemanager.js lines NNN-MMM, ported the streaming
upload pattern," it did the work. Verify either way by reading
the actual code state.

## Scope

### Phase 1 — Audit Brief 37's actual landed state

1.1 Read `BRIEFS/brief-037-mobile-upload-legacy-port-plus-add-doc-anchor.md`
end to end — pay closest attention to the **Outcome** section.
Categorize the result into one of:

  - **A) Phase 1 (legacy lookup) executed fully** with line
    citations from `legacy/damagemanager.js`. Phase 2 (port to
    damage-worker) and Phase 3 (anchor button) also completed.
    Brief 37 is essentially done. Brief 38's job is just to
    verify the port matches legacy behavior and smoke-test on
    mobile.
  - **B) Phase 1 partially executed** — executor read SOMETHING
    (maybe just the new code, not the legacy reference) and made
    edits that may or may not match legacy's working pattern.
    Brief 38 needs to compare current new-code state against
    legacy and reconcile.
  - **C) Phase 1 blocked / punted** — executor saw the bogus
    hedge, marked the work blocked, and Phase 2/3 didn't run at
    all. Brief 38 is essentially "do all of Brief 37, but for
    real this time."

1.2 Document which of A/B/C applies in this brief's Outcome
section, with quotes from Brief 37's Outcome to back it up.

### Phase 2 — Verify or land the legacy upload port

2.1 Open `legacy/damagemanager.js` (it IS in the repo — confirmed
present 2026-05-05). Search for the upload-document handler:

  - grep within the file for `upload`, `document`, `photo`, or
    URL fragments like `/manage/api/`
  - The legacy handler will be a route case inside the worker's
    main `fetch()` event listener
  - Document the exact line range in Brief 38's Outcome

2.2 Identify the legacy upload pattern's distinctive properties:
  - HTTP method + path
  - How the multipart body is parsed (streaming? `request.formData()`?
    custom parser?)
  - How the file bytes get to R2 (direct stream-through? buffered?)
  - Any HEIC handling (transcode? pass-through? reject?)
  - Validation logic (size limits? content-type checks?)
  - Response shape (302 redirect? JSON?)

2.3 Compare against current `apps/damage-worker/src/index.ts`
`handleUploadDocument`:
  - If they MATCH (Brief 37 did the port correctly): note that in
    Outcome, move on to Phase 3 audit.
  - If they DIFFER: patch the new handler to mirror legacy's
    approach. Document each difference and the patch applied.

2.4 Verify the apps/web side bypasses the server action:
  - The form's `action` URL should point directly at damage-worker
    (not at an apps/web `useFormState` server action).
  - `uploadDocumentAction` should be deleted (or marked deprecated
    with a comment explaining why it's left in).
  - If the bypass DIDN'T happen: do it now per Brief 37 Phase 2.

### Phase 3 — Verify or add the "Add Document" anchor button

3.1 Read `apps/web/app/admin/damage/[id]/page.tsx`. Confirm:
  - There IS an `<a href="#upload-document">Add Document</a>`
    anchor button near the "Add Note" button.
  - It mirrors Brief 22's "Add Note" styling.
  - The upload card has `id="upload-document"` (Brief 20).

3.2 If any of the above is missing: add it. Brief 22 is the
reference implementation.

### Phase 4 — Smoke test + Outcome documentation

4.1 The brief CAN'T smoke test from headless (no mobile browser
available). But the executor should leave a clear note in the
Outcome flagging that the operator needs to:
  - Visit `/admin/damage/<some claim id>` on iPhone
  - Tap "Add Document" anchor button — verify smooth scroll
  - Upload an HEIC photo — verify it succeeds
  - Verify the photo appears on the claim's photo list
  - Verify no white-page error

4.2 Outcome must include:
  - Which of A/B/C from Phase 1 categorized Brief 37's state
  - The exact legacy upload code path (file + line range)
  - Diff between legacy and new code (if any)
  - Files touched in this brief vs. left alone
  - Operator-side smoke test instructions

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 38 row added.

5.2 BUILD_STATE.md: Findings entry noting that Brief 37's bogus
"file not in repo" hedge was traced to a planner-side mistake
that wasn't corrected in time before the orchestrator dispatched.
Note that the `legacy/` directory IS in the repo and contains
`damagemanager.js`, `signupworker.js`, `sysadmin.js`,
`dashboard.js`, `performancetracker.js` — future briefs should
treat these as readable, no operator-paste step needed.

5.3 If Brief 37's Outcome includes a "Decisions made on
operator's behalf" entry that says the legacy code wasn't read:
mark Brief 37 as superseded by Brief 38 in INDEX.md.

## Out of scope

- Editing Brief 37's spec retroactively. Briefs are append-only
  once Completed. Brief 38 supersedes Brief 37's gaps, doesn't
  rewrite history.
- Generalizing the legacy code reference into other briefs that
  punted on similar grounds. If you find others, file a separate
  cleanup brief.
- Mobile-vs-desktop branching in the upload code. One code path,
  works everywhere.
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker build succeeds
- pnpm --filter @splash/web build succeeds (if anything in
  apps/web changed)
- Brief 37's actual landed state categorized (A/B/C) with
  evidence in Outcome
- damage-worker `handleUploadDocument` matches the legacy
  pattern from `legacy/damagemanager.js` (or `signupworker.js`,
  whichever holds the upload handler)
- apps/web upload form posts directly to damage-worker, not
  through a Next server action
- "Add Document" anchor button present on claim detail page,
  smooth-scrolling to upload card
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Categorization (A/B/C) of Brief 37's actual outcome
- Legacy upload code location (file + line range)
- Diff between legacy and new code at the start of this brief
- Patches applied in Phase 2 / Phase 3
- Bundle-size delta on damage-worker (whatever Brief 37 + Brief 38
  net out to)
- Operator smoke-test instructions

## Outcome

### Categorization of Brief 37's actual landed state

**Category A — Phase 1 (legacy lookup) executed fully** with explicit
line citations from `legacy/damagemanager.js`. Phase 2 (port to
damage-worker + apps/web bypass) and Phase 3 (anchor button) also
completed. Brief 37 is essentially done; Brief 38's job reduces to
re-verifying the port matches legacy and queuing operator-side mobile
smoke-test instructions.

**Evidence quoted from Brief 37's Outcome:**

- "**File:** `legacy/damagemanager.js` (in repo)." — executor read the
  legacy file directly; the bogus "if file isn't in repo, ask
  operator" hedge was correctly ignored.
- "**Handler:** `handleDocumentUpload(request, env, auth, claimId)` at
  **legacy/damagemanager.js:2446-2621**." — exact line range cited.
- "Line 2467 — `const form = await request.formData();` — fully
  buffered FormData parse on the worker side. **Identical to the new
  port** (apps/damage-worker/src/index.ts:913)." — direct comparison
  done.
- "**Line 2620 — `return Response.redirect(\`${url.origin}/manage/claim/${encodeURIComponent(claimId)}\`, 303);`** — full top-level browser redirect back to the claim detail page. THIS is the difference from the new port…"
  — root-cause diff identified.

This brief therefore lands in the lightest-touch path of Phase 1: no
gap-filling needed.

### Phase 1 audit — Brief 37 verification (Brief 38)

Re-read `legacy/damagemanager.js` lines 2410-2621 directly to confirm
Brief 37's citations. All three claims hold:

- Lines 2416-2426: `DOCUMENT_TYPES = ["Quote", "Receipt"]`,
  `DOCUMENT_MAX_BYTES = 10 * 1024 * 1024`, `DOCUMENT_ALLOWED_MIME` set
  covering pdf/jpeg/png/heic/heif (+ `-sequence` variants). ✓
- Line 2446: `async function handleDocumentUpload(request, env, auth, claimId) {`. ✓
- Line 2467: `const form = await request.formData();` — buffered FormData
  parse, **not** streaming. Brief 37's "streaming-to-R2 hypothesis is
  wrong" call holds. ✓
- Line 2620: `return Response.redirect(\`${url.origin}/manage/claim/${encodeURIComponent(claimId)}\`, 303);`. ✓
- Lines 2418-2425 MIME set + line 2509 ext list — match the new port's
  `DOCUMENT_ALLOWED_MIME` / `DOCUMENT_ALLOWED_EXT` constants in
  apps/damage-worker/src/index.ts. ✓

`uploadToR2` at `legacy/damagemanager.js:260-299` (referenced via line
2571) — HEIC/HEIF detection + `env.IMAGES.input(file.stream()).output({ format: "image/jpeg" })`
transcode + R2 PUT. Mirrors `packages/storage-r2/src/index.ts:96
uploadClaimPhoto` line-for-line as Brief 37 documented.

### Phase 2 audit — current new-code state vs legacy

Verified directly against the live source:

- `apps/damage-worker/src/index.ts:914-930` — `UPLOAD_ERROR_MAX_LEN = 240`
  + `buildUploadRedirect(request, claimId, errorMessage?)` helper. Reads
  `Origin` header (regex-validates to `^https?://` to refuse spoofed
  values), falls back to `new URL(request.url).origin`. Encodes error
  via `encodeURIComponent(errorMessage.slice(0, UPLOAD_ERROR_MAX_LEN))`
  into `?upload_error=<msg>` query param. 303 redirect on every branch.
- `apps/damage-worker/src/index.ts:932-1094` — `handleDocumentUpload`
  matches legacy's flow line-for-line:
  - `isOriginAllowed` (defense-in-depth, mirrors legacy:2447 `checkOrigin`)
  - `loadAndScopeCheck` (port of legacy:2451 `fetchClaimDetail` scope check)
  - multipart-only gate via `Content-Type` substring (legacy:2459-2465)
  - `await request.formData()` (legacy:2467 — same shape)
  - field extraction (file, doc_type, vendor, amount, notes,
    pay_to_type, vendor_address) — same field names as legacy:2469-2475
  - validation chain mirrors legacy:2477-2566, with Brief 20's
    additional Quote-row required-field gating layered on (amount,
    pay_to_type, vendor when pay_to=vendor, vendor_address when
    pay_to=vendor) — enforced both in the new port and at the UI
  - `countPhotosOfType` + `uploadClaimPhoto` (port of legacy:2570-2571
    `nextDocumentSequence` + `uploadToR2`)
  - `insertDocPhoto` + `logActivity` + `touchClaim` (port of
    legacy:2581-2608 INSERT + activity batch)
  - 303 redirect on success branch (`return buildUploadRedirect(request, claimId);` — line 1093) and every error branch
- `apps/web/app/admin/damage/_components/UploadDocumentCard.tsx` — plain
  `<form action="/manage/api/claim/{claimId}/document" method="POST" enctype="multipart/form-data">`,
  no `<ActionForm>`, no server-action import. `id="upload-document"` on
  card root preserved (Brief 20).
- `apps/web/app/admin/damage/[id]/actions.ts` — only four exports:
  `transitionAction`, `addNoteAction`, `editDocumentAction`,
  `deleteDocumentAction`. No `uploadDocumentAction`. Comment block at
  lines 9-15 documents the retirement.
- `apps/web/app/admin/damage/_lib/worker-fetch.ts` — only
  `damageGetJson` / `damageGetJsonOrStatus` / `damagePhotoUrl` /
  `damageCheckRequestUrl` / `damagePostForm`. No `damagePostMultipart`.
  Comment block at lines 3-6 documents the retirement.
- `apps/web/app/admin/damage/[id]/page.tsx` — line 190 reads
  `firstParam(sp.upload_error).trim().slice(0, 240)`. Line 331 renders
  `<UploadErrorBanner />` above `UploadDocumentCard` when present. Lines
  1270-1279 define `UploadErrorBanner`. ✓

A repo-wide grep for `uploadDocumentAction` and `damagePostMultipart`
returns only retirement-comment hits in `actions.ts` and
`worker-fetch.ts` — no surviving callers. Phase 2 is fully landed; no
patches applied in Brief 38.

### Phase 3 audit — "Add Document" anchor button

`apps/web/app/admin/damage/[id]/page.tsx` `RecentNotesBox` (lines 663-673)
contains both anchor buttons side-by-side:

```
<a href="#add-note" className="rounded-splash-sm border border-splash-blue …">Add note</a>
<a href="#upload-document" className="rounded-splash-sm border border-splash-blue …">Add document</a>
```

Same Tailwind classes on both anchors; only `href` and label differ.
`id="upload-document"` confirmed on `UploadDocumentCard` root (Brief
20). Smooth-scroll CSS (`html { scroll-behavior: smooth; }`) was already
in place from Brief 22 — verified via project-wide grep, untouched.

### Diff between legacy and new code

Zero functional diffs in the upload flow itself — Brief 37's port is
faithful to the legacy handler. The only meaningful difference is
intentional and load-bearing:

| Aspect | Legacy (`damagemanager.js:2620`) | New port (`apps/damage-worker/src/index.ts:929`) |
|---|---|---|
| Success redirect target | `${url.origin}/manage/claim/{id}` (legacy worker's namespace) | `${appsWebOrigin}/admin/damage/{id}` (apps/web's namespace) |
| Error response | HTML re-render of claim detail with inline error | 303 redirect with `?upload_error=<msg>` query, page re-SSRs banner |
| Origin resolution | `new URL(request.url).origin` (legacy worker WAS the renderer) | `Origin` header → `new URL(request.url).origin` fallback (apps/web is the renderer; worker is just the API) |

These differences flow from the architectural split (legacy = single
worker rendering HTML; new = damage-worker JSON/redirect API + apps/web
SSR). Both paths land the user on the same conceptual screen post-
submit.

### Files touched in Brief 38

- `BRIEFS/brief-038-mobile-upload-redo-with-correct-legacy-paths.md` —
  Status set to Completed (2026-05-06); Outcome filled in.
- `BRIEFS/INDEX.md` — Brief 38 row updated with Completed status.
- `BRIEFS/QUEUE.md` — Brief 38 line moved to the completed-tombstone
  block.
- `BUILD_STATE.md` — Last-updated line bumped to 2026-05-06; new
  Findings entry; prioritized work list row 38 added with
  `completed (2026-05-06)`.

### Files NOT touched (deliberately)

No source changes. Brief 38 is a verification-only brief — Brief 37
landed the work correctly on the first dispatch. The hedge in Brief
37's Phase 1 prompt about "ask operator to paste from CF" was a
pre-execution worry; the executor read `legacy/damagemanager.js` directly
and did not punt.

### Decisions made on operator's behalf

1. **No code patches applied.** Phase 1 audit confirms Brief 37 hit
   Category A — full Phase 1/2/3 execution with legacy line citations
   and a faithful port. The brief's Phase 2/3 instructions were
   contingent ("if they DIFFER … patch the new handler"); they don't
   differ, so no patches are warranted. Patching working code to satisfy
   the verification brief would be a no-op churn commit at best and a
   regression risk at worst.
2. **No new "Brief 37 superseded by 38" marker on INDEX.md.** Brief
   38's Phase 5.3 instruction was conditional on Brief 37's Outcome
   including a "Decisions made on operator's behalf" entry that says
   the legacy code wasn't read. The actual entry says the opposite —
   "HEIC handling left as-is — Phase 1 read confirmed
   `packages/storage-r2/src/index.ts uploadClaimPhoto` already mirrors
   legacy." Brief 37 stays Completed; Brief 38 is its successful
   verification.
3. **The "future briefs should treat `legacy/` as readable" callout
   lives in the Findings entry, not as a CLAUDE.md edit.** The Findings
   log is where decisions land for future executors to read; CLAUDE.md
   is the orientation doc and doesn't need a "remember the legacy
   directory exists" line because every brief already references
   specific legacy files when relevant. The orchestrator daemon's brief
   templates are the more durable place to scrub the bogus hedge — out
   of scope for Brief 38, but flagged below.
4. **No mobile smoke test executed in headless** — same posture as
   Brief 37; operator runs the smoke test on next deploy.

### Latent issues / forward flags

- **Planner-side template bug.** Brief 37's draft contained a
  pre-execution hedge ("if `legacy/damagemanager.js` isn't in the repo,
  ask the operator to paste it from CF dashboard") that was wrong
  on its face — `legacy/damagemanager.js` IS in the repo, alongside
  `signupworker.js`, `sysadmin.js`, `dashboard.js`, and
  `performancetracker.js`. The hedge was caught + corrected on the
  planner side, but only after the brief was already queued, and the
  orchestrator dispatches the moment a filename hits QUEUE.md. Brief
  37's executor read past the hedge and did the work anyway, but a
  more cautious executor could have punted Phase 1 entirely. Forward
  fix is to remove the "if file isn't in repo, ask operator" template
  language from the planner's brief template before it gets re-used.
  Out of scope for Brief 38 (per its own §Out of scope: "Generalizing
  the legacy code reference into other briefs that punted on similar
  grounds. If you find others, file a separate cleanup brief.").
- **No mobile smoke test executed.** Same as Brief 37 — operator's
  iPhone Safari is the only environment where the regression
  reproduces, and headless can't drive it. Smoke test instructions
  re-iterated below.

### Operator smoke-test instructions (carry-over from Brief 37)

On next staging deploy:

1. Visit `/admin/damage/<some claim id>` on iPhone Safari (Safari, not
   Chrome — the original digest 924441341@e394 was Safari-specific).
2. Tap the "Add document" anchor button at the top of the Recent
   notes box. Verify smooth scroll lands on the upload card.
3. From iPhone's Photos app, pick a HEIC photo (any recent iPhone
   photo will be HEIC by default). Set doc_type to Quote, fill in
   amount + pay_to_type. Submit.
4. Expected: <5 second redirect back to `/admin/damage/{id}`, the new
   photo appears in the Documents section. No white-page error, no
   `digest 924441341@e394`.
5. Negative test: upload a `.txt` file or oversized 11 MB JPEG.
   Expected: redirect back to `/admin/damage/{id}?upload_error=<msg>`,
   the `UploadErrorBanner` renders above the upload card with the
   worker's validation message.

### Bundle-size delta (cumulative Brief 37 + 38)

No code changes in Brief 38, so deltas equal Brief 37's reported
values, re-verified via dry-run:

- `apps/damage-worker` — `wrangler deploy --dry-run` reports
  **1662.94 KiB / 377.28 KiB gzip** (matches Brief 37's reported
  values exactly; cumulative delta from Brief 35 baseline:
  +1.24 KiB / +0.31 KiB gzip).
- `apps/web` — `next build` reports `/admin/damage/[id]` route at
  **3.1 kB / 108 kB First Load JS** (matches Brief 37 exactly; 4
  server actions in the route, down from 5 pre-Brief-37).

### Validation results

- `pnpm typecheck` — 13/13 successful, 199 ms (FULL TURBO — all
  cached, confirming zero source changes since Brief 37 closed).
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir=./dist`
  — succeeded; bundle 1662.94 KiB / 377.28 KiB gzip.
- `pnpm --filter @splash/web build` — succeeded; `next build`
  compiled in 4.9 s; all 12 routes generated; `/admin/damage/[id]`
  route 3.1 kB / 108 kB First Load JS.
- Mobile smoke test — **deferred to operator** (headless cannot drive
  iPhone Safari).
