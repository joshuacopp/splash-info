# Brief 5c: Damage write actions (transitions + notes + check-request PDF)

**Status:** Completed (2026-05-04)
**Started:** 2026-05-04
**Completed:** 2026-05-04
**Blocks:** Admin-facing UI parity. Brief 5d (documents) builds on 5c's
form patterns.
**Dependencies:** Brief 5a (list + helper), Brief 5b (detail page).

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-005a-damage-claim-list.md (Outcome — for the helper +
  list page context)
- BRIEFS/brief-005b-damage-claim-detail.md (Outcome — especially
  "Anything Brief 5c / 5d should know")
- apps/web/app/admin/damage/[id]/page.tsx (5b's detail page; 5c adds
  forms to it)
- apps/web/app/admin/damage/_lib/worker-fetch.ts (existing helpers;
  5c needs a POST helper alongside the GET ones)
- apps/damage-worker/src/index.ts — three sections matter most:
  * `handleAddNote` (~line 441) — note POST contract
  * `handleTransition` (~line 473ff) — transition POST contract,
    including the `stamps[]` and role gating
  * `serveCheckRequestPreview` near `/preview-check-request.pdf` — the
    PDF preview endpoint contract
- legacy/damagemanager.js — search for the transition table
  (CLAIM_STATUS_TRANSITIONS or similar) for the canonical state-machine
  source. If it's a literal in that file, mirror it into apps/web; if
  the new damage-worker has its own table (likely `apps/damage-worker/src/transitions.ts`
  or inline in handleTransition), use that as canonical and copy
  verbatim.

## Context

Brief 5c is the third of four sub-briefs porting the damage manager UI:

  5a — claim list (DONE)
  5b — claim detail read-only (DONE)
  5c — write actions on detail (THIS BRIEF)
  5d — documents (Quote/Receipt upload, edit, delete, photo modals)

5c adds three write surfaces to the detail page from 5b:

  1. **Transitions** — action buttons that move the claim through the
     state machine. Each button maps to a specific `target_status`. The
     visible set of buttons depends on (a) the current `claim_status`
     and (b) the user's `dc_role`. The worker validates everything
     server-side; the UI just needs to render only the buttons the worker
     would accept.

  2. **Notes** — a textarea + submit form below the activity timeline.
     POSTs the note text; on success the activity timeline gains a new
     entry on next render.

  3. **Check Request PDF preview** — a single "Preview check request"
     link/button visible when the claim has an `approved_quote_id`. Opens
     the worker's PDF endpoint in a new tab.

5c does NOT touch documents (Quote/Receipt upload/edit/delete) — those
are 5d. The Check Request preview is included here because it's a
single GET link, no forms, no POST handling. 5d will add the
per-quote-row preview links inside the photo gallery's Quote tiles.

## Scope

1. **POST helper.** Extend `apps/web/app/admin/damage/_lib/worker-fetch.ts`
   with a `damagePostForm(path, formData) -> { ok, status, body }`
   function. Server-only. Forwards cookie via the same `cookies()` +
   `Cookie` header pattern as the existing GET helpers. Sends
   `application/x-www-form-urlencoded` (matches the worker's `readForm`
   primary content-type branch). Returns:
     - `ok: true` on 2xx, with parsed JSON body if any
     - `ok: false` on non-2xx, with status + error body (string from
       `body.error` if JSON, else raw text). Doesn't throw on auth/scope
       failures — the caller decides how to surface them inline.
   Keep `damageGetJson` and `damageGetJsonOrStatus` untouched.

2. **Transition table.** Mirror the canonical transition table from the
   damage-worker into a constant inside apps/web. Two acceptable
   sources, in order of preference:
     a. If the worker exposes the table as a typed export from
        `@splash/types` or `apps/damage-worker/src/transitions.ts` (or
        wherever it lives), import directly. Don't duplicate — share.
     b. If the table is inline in the worker's `handleTransition`
        function, copy it into a new local file
        `apps/web/app/admin/damage/_lib/transitions.ts` with a comment
        marking the worker's source location as canonical, and a
        reminder that the two must be kept in sync (until a future
        cleanup brief moves the table to a shared package).
   The table shape (whichever path):
     - `from: ClaimStatus`
     - `to: ClaimStatus`
     - `roles: DamageRole[]` — who can perform this transition
     - `label: string` — button text (e.g., "Approve — Pending Quotes")
     - `stamps?: AuditStampRole[]` — audit columns the worker bumps
       (display-only; doesn't affect button rendering)
     - `requiresAmount?: boolean` — true when the transition needs an
       `approved_amount` field (e.g., approving an in-house repair).
       UI behavior: render a small inline number input next to the
       button when this is true; submit it as `approved_amount` form
       field.
     - `requiresApprovedQuoteId?: boolean` — for transitions like
       "Approve — Submitted for Payment" that need a `quote_id` from
       a Quote row. UI: render a select populated with the claim's
       existing Quote photos (`photos.filter(p => p.photo_type === "Quote")`).
       Empty state: disable the button with a tooltip "Add a Quote
       document first" — that affordance lives in 5d.
   Read the worker's actual handleTransition body to enumerate exactly
   which fields each transition requires; the brief's enumeration above
   is illustrative, not exhaustive.

3. **Transition buttons UI.** Inside `app/admin/damage/[id]/page.tsx`,
   add a "Move forward" section near the top of the page (between the
   summary card and the photo gallery, or below the summary card —
   pick whichever reads cleaner with the existing layout).
   - Server-side, compute `validTransitions` by filtering the table
     against current `claim.claim_status` and the user's `dcRole`.
     Issue: the page doesn't currently know `session.dcRole` —
     the worker enforces but doesn't echo it. Two options:
       a. Add `damageGetJsonOrStatus` call to a new worker endpoint
          like `/manage/api/me` that returns `{ dcRole, role, email }`.
          Worker code change — out of scope here; flag it and use (b).
       b. Render every transition the **claim's current status** allows
          (regardless of caller's dc_role); the worker rejects forbidden
          transitions on POST and the UI surfaces the error inline. UX
          loss is "user sees a button they can't use until they click it
          and get a 403", but it avoids the worker change.
     **Pick (b)** for 5c. Add a `// TODO(5c-followup):` comment in the
     code pointing at item 11a in BUILD_STATE.md (user-info endpoint).
     When item 11a lands, gate buttons by dc_role server-side.
   - Render valid transitions as a row of buttons. Use the same Tailwind
     button idiom as the dashboard tile CTA (`rounded-splash-sm bg-splash-blue
     px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn ...`).
     Each button is wrapped in a `<form action={transitionAction}>` (a
     server action — see item 4).
   - For transitions with `requiresAmount` or `requiresApprovedQuoteId`,
     render the field inline INSIDE the button's form so it submits
     atomically. e.g.:
       ```tsx
       <form action={transitionAction} className="flex items-center gap-2">
         <input type="hidden" name="target_status" value="Approved — In House — Repaired" />
         <input type="number" name="approved_amount" step="0.01" min="0"
                placeholder="$ amount" required
                className="..." />
         <button type="submit" className="...">Approve repair</button>
       </form>
       ```
     For `requiresApprovedQuoteId`, replace the number input with a
     `<select name="approved_quote_id">` populated from the claim's
     Quote photos.
   - Empty case: when `validTransitions` is empty, render
     "No further transitions available from current status." in
     opacity-60 text. Don't hide the section entirely — preserves
     vertical layout consistency.

4. **Server actions for transitions.**
   - In the page file (or a sibling `actions.ts` with `"use server"`),
     define `transitionAction(formData: FormData)`. Extract claim_id from
     the form (hidden input), target_status, optionally approved_amount /
     approved_quote_id. Call `damagePostForm` against
     `/manage/api/claim/{claim_id}/transition`. On success, call
     `revalidatePath(\`/admin/damage/\${claim_id}\`)` and return.
   - On failure, capture the worker's error message and re-display via
     a query-string redirect: `redirect(\`?action_error=\${encoded}\`)`.
     The page reads `searchParams.action_error` and renders an alert at
     the top. (Server actions in Next 15+ can return values, but the
     redirect pattern is more compatible with `<form action>`-based
     submission than the React-19 useFormState approach. Pick whichever
     works cleanly with Next 15.5.15 + the existing build pipeline.)
   - Add a small `<ActionAlert />` server component that reads
     `?action_error=...` from `searchParams` and renders a red banner at
     the top of the page when present.

5. **Note form.**
   - Below the activity timeline, render an `<form action={addNoteAction}>`
     with a `<textarea name="note" maxLength={5000} required>` and a
     submit button "Add note".
   - Server action `addNoteAction(formData: FormData)` calls
     `damagePostForm(/manage/api/claim/{id}/note, formData)`.
       - Success: `revalidatePath(...)`, return.
       - Failure: same error-redirect pattern as transitions.
   - Empty note text — the worker rejects with 400 "Note cannot be
     empty"; the UI's `required` attribute catches it client-side too.

6. **Check Request PDF preview.**
   - When `claim.approved_quote_id` is non-null, render a "Preview check
     request" `<a target="_blank">` link in the summary card's approval
     details box (which already exists in 5b — extend, don't move).
   - Link href: build via the existing damage-worker base resolution
     (mirror `damagePhotoUrl()` shape):
       ```ts
       function damageCheckRequestUrl(claimId: string, quoteId: number): string {
         const base = process.env.NEXT_PUBLIC_DAMAGE_WORKER_URL ?? "";
         return `${base}/manage/api/claim/${encodeURIComponent(claimId)}/quote/${quoteId}/preview-check-request.pdf`;
       }
       ```
     Place this helper next to `damagePhotoUrl` in `_lib/worker-fetch.ts`.
     Production same-origin: empty base → relative URL works. Dev
     cross-origin: env var → absolute URL.
   - The endpoint requires authentication. In production same-origin
     the cookie travels naturally on the GET. In dev cross-origin the
     cookie won't reach the worker for a top-level navigation if it's
     SameSite=Lax — actually Lax DOES allow cookies for top-level GET,
     so the new-tab open should work in dev too. Document this
     assumption; don't add a workaround unless 5c testing reveals a
     real problem.

7. **Update `app/admin/damage/[id]/page.tsx`.** Wire in:
   - The transition section below the summary card.
   - The note form below the activity timeline.
   - The check-request link inside the existing approval-details box.
   - The action-error alert at the top.
   Don't move existing 5b sections; only add. Keep the page server-component.

8. **Update BRIEFS/INDEX.md** — 5c row marked Completed (today's date).
   Update the 5b "next" pointer if any.

9. **Update BUILD_STATE.md** per Conventions — bump Last updated, add
   Findings entry, document the dc_role-gating compromise (item 11a
   dependency), document the transition-table dual-source decision (path
   a vs b), validation results.

## Configuration
No new env vars.

## Out of scope

- Document upload, edit, delete (Quote / Receipt / photo). All 5d.
- Per-quote-row Check Request preview links (inside Quote photo tiles).
  5d — that interacts with the photo-gallery rendering which is also
  5d's territory.
- Photo lightbox / modal viewer. 5d.
- Adding `/manage/api/me` to dashboard-worker for dc_role echo.
  Tracked as item 11a; out of scope here.
- Soft-delete or rollback of a transition (the worker doesn't expose
  one; legacy doesn't either).
- Real-time updates (WebSocket etc.) — page reload via revalidatePath
  is the v1 update mechanism.
- Modifying any worker source. Read-only against damage-worker.
- Don't deploy, don't bind production routes, don't commit to git or
  push.

## Definition of done
- pnpm typecheck passes
- pnpm --filter @splash/web build succeeds
- /admin/damage/[id] renders transition buttons (gated by current
  status), the note form, and the check-request preview link when
  applicable
- POSTing a transition succeeds and the page re-renders with the new
  status + a fresh activity-log entry
- POSTing a note succeeds and the activity timeline gains the entry
- POSTing a transition that the worker rejects (e.g., wrong role)
  surfaces the error inline as a red banner at the top of the page
- Check-request preview opens in a new tab via the worker's PDF endpoint
- BRIEFS/INDEX.md and BUILD_STATE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report
- Transition-table source path (a or b) and rationale
- Whether the dc_role-gating compromise (path b in scope item 3) feels
  acceptable, or whether item 11a should be promoted ahead of 5d
- Server-action approach used for forms (revalidatePath + redirect, or
  React 19 useFormState, or other) and any sharp edges
- Any new latent issues spotted in damage-worker
- Validation results

## Outcome

### Files created
- `apps/web/app/admin/damage/_lib/transitions.ts` — UI mirror of the
  worker's CLAIM_TRANSITIONS table, with a UI-only `label` field per
  entry, a `transitionsFrom(status)` helper, and strong sync-checklist
  comments pointing at `apps/damage-worker/src/transitions.ts` as the
  canonical source.
- `apps/web/app/admin/damage/[id]/actions.ts` — `"use server"` module
  exporting `transitionAction(formData)` and `addNoteAction(formData)`.
  Both extract `claim_id` from a hidden field, forward the FormData to
  `damagePostForm`, and end in `redirect()` on both success (clears
  `?action_error`) and failure (sets `?action_error=<encoded>`).

### Files modified
- `apps/web/app/admin/damage/_lib/worker-fetch.ts` — added
  `damageCheckRequestUrl(claimId, quoteId)` (mirrors `damagePhotoUrl`
  shape) and `damagePostForm(path, formData)` (URL-encoded body, sets
  Cookie + Origin headers, returns `{ ok, body }` or
  `{ ok: false, status, error }`). Existing `damageGetJson` and
  `damageGetJsonOrStatus` untouched.
- `apps/web/app/admin/damage/[id]/page.tsx` — added the
  `searchParams` prop (Next 15 async), an `ActionAlert` banner at the
  top reading `?action_error`, a `TransitionSection` between the
  summary card and the photo gallery, an `AddNoteCard` below the
  activity timeline, and a "Preview check request →" link inside the
  existing `ApprovalDetails` box (renders only when
  `claim.approved_quote_id !== null`). 5b sections (summary card,
  audit stamps, photo gallery, activity timeline) preserved verbatim.

### Decisions made on operator's behalf
1. **Transition-table source = path (b)** from the brief — mirrored
   into apps/web with strong sync comments. Path (a) would have
   required either a new `@splash/damage-shared` package or a cross-app
   path import. The UI also needs button labels, which the server
   table doesn't carry — so even with a shared import, apps/web would
   still keep a parallel label map. Mirroring is the lower-cost
   approach for 5c; a future cleanup brief can hoist the table.
2. **dc_role gating compromise = path (b)** from the brief — render
   every transition valid from current claim status regardless of
   caller's dc_role. The worker rejects out-of-role transitions on
   POST and the new `ActionAlert` banner surfaces the worker's
   `Transition "X" → "Y" not allowed for role "gm".` message inline.
   `// TODO(5c-followup):` comment in `_lib/transitions.ts` points at
   item 11a — when the user-info endpoint lands, gate by
   `transition.allowedRoles.includes(session.dcRole)`.
3. **Server-action approach = `<form action={fn}>` + redirect** rather
   than React 19 `useActionState`. Reasoning: native form submission
   means the page stays a server component (no `"use client"`
   anywhere), preserves SEO/non-JS fallback, and keeps the
   no-client-JS posture the rest of the apps/web admin pages have. The
   `redirect()` pattern owns the URL after the action completes, so
   `?action_error=` is always either present-and-fresh or cleared.
4. **POST helper sets `Origin` header explicitly.** Server-side fetch
   in Next/Workers does NOT auto-populate Origin, but the worker's
   `isOriginAllowed` rejects mutations without a matching Origin or
   Referer (returns 403 "bad origin"). `damagePostForm` derives Origin
   from the target URL so the worker accepts the subrequest.
   Production same-origin: Origin matches `splashcarwashes.info`.
   Dev cross-origin: Origin matches the `splash-damage.workers.dev`
   target, which the worker's `isOriginAllowed` (request.url-derived
   `expected`) also accepts.
5. **Body encoding = `application/x-www-form-urlencoded`** (per brief).
   Matches the worker's `readForm` primary content-type branch. Files
   in the FormData (none on transition/note paths) would be silently
   dropped — fine for 5c.
6. **Transition button layout** = one form per transition, stacked
   vertically with the action description on the left, optional
   inputs (amount / quote select / requiresInputs / optionalInputs /
   note textarea) flowing to the right, and the submit button at the
   end. Works in both wide and narrow layouts. Atomic submission per
   form — the worker validates all fields together, so collecting
   them in one form avoids partial-submit footguns.
7. **Empty-quotes case for `requiresQuoteSelection`** disables both
   the `<select>` and the `<button>` and adds a `title="Add a Quote
   document first"` tooltip. Brief explicitly mentioned this. The
   `requiresReceiptOnFile` case is NOT given the same treatment —
   the user gets the inline error banner if they try and the worker
   rejects. Decided to match brief scope exactly for v1; a parallel
   receipt-check disable could land in 5d when document upload exists.
8. **Action-error alert** rendered above the back link, with a
   "Dismiss" link that navigates to the bare detail URL. Always
   bordered red (`border-splash-deny/40 bg-splash-deny/10
   text-splash-deny`). One alert at a time — successive failed
   actions overwrite. Acceptable for v1; multi-error queueing isn't
   needed.
9. **Note form is a separate "Add a note" card** below the activity
   timeline — keeps the section visually distinct from transitions.
   Placeholder text "Note text…", `maxLength={5000}` matches the
   worker's `if (noteText.length > 5000)` cap. `required` on the
   textarea so the browser blocks empty submits before reaching the
   worker's 400.

### Latent issues spotted
- **Worker source-of-truth duplication.** The transitions table now
  exists in two files. The sync-checklist comments will drift unless
  someone does the cleanup brief that hoists it into a shared
  package (e.g., extend `@splash/types` with the data; allowedRoles
  expansion can stay in the worker). Tracked informally in the
  transitions.ts header comment; no item number yet.
- **`damagePostForm` cookie on dev cross-origin.** Same caveat as
  the GET helper — the apps/web SSR forwards the user's incoming
  cookie to the worker, but in dev the worker is on
  `*.workers.dev` and the apps/web cookie was set by
  `splash-dashboard.<acct>.workers.dev`. Worker subrequest-from-Next
  IS server-side (no SameSite check), so the explicit `Cookie`
  header forwarding works. Confirmed via worker source — the gate
  reads `request.headers.get("Cookie")` via `authenticate()`. No
  change needed.
- **Server-action `redirect()` post-revalidate.** Calling
  `revalidatePath` then `redirect()` to the same path forces a fresh
  render. Next 15 handles this correctly (the redirect response
  carries the revalidated payload back), but the dev hot-reload can
  show a flash of the stale page on slow renders. Not a production
  issue.
- **Vestigial CEO transitions.** `Approved — Pending CEO Approval` is
  unreachable for new claims (CEO_APPROVAL_THRESHOLD comment in
  worker `transitions.ts:34`). The two CEO escape-hatch transitions
  are mirrored in the UI table for parity, but no current workflow
  ever lands a claim in that state. Kept verbatim per the worker's
  "do not refactor or remove" directive.
- **Per-quote-row check-request preview not added.** The brief
  explicitly excludes per-quote preview links inside Quote photo
  tiles — that's 5d, where document tiles get an edit/delete UI. The
  single approval-box link is for the *approved* quote only.

### Validation results
- `pnpm typecheck`: **13/13 successful**, 3.722s. apps/web ran fresh
  (cache miss on the new files); all other 12 packages cached.
- `pnpm --filter @splash/web build`: **succeeded**. Next 15.5.15
  compiled in 3.7s, 12/12 static pages generated. The
  `/admin/damage/[id]` route is `ƒ` (server-rendered) at 171 B / 105
  kB First Load JS — **identical footprint to 5b** despite the new
  forms (zero client JS added; `<form action={serverAction}>` keeps
  the page fully server-side).
- Manual smoke testing of the live worker round-trip is operator-side
  (requires local dev with cookies + a real claim id; the brief did
  not mandate it).

### Report (per brief §Report)
- **Transition-table source path:** (b) — mirrored locally. Rationale:
  apps/web does not depend on @splash/damage-worker; UI also needs
  labels the worker table doesn't carry; cross-app import would
  require new shared-package infra. See Decision 1.
- **dc_role-gating compromise acceptability:** acceptable for v1.
  Worker enforces and the action-error banner makes the failure
  legible. Item 11a (user-info endpoint) is the right follow-up —
  promote it ahead of 5d if the operator wants the gating UX before
  doc upload, otherwise the gate-on-POST experience is workable.
- **Server-action approach:** `<form action={fn}>` + `redirect()` on
  both branches. Sharp edges: (a) the `redirect()` from a server
  action throws `NEXT_REDIRECT`, which TypeScript flags as the
  function never returning — annotated with `: Promise<void>` to
  satisfy the inference; (b) on success the redirect to the bare
  detail URL adds an extra navigation, but it's the cleanest way to
  drop `?action_error` from the URL after a successful submit; (c) the
  `errorRedirect` helper has a `: never` return type so the
  TypeScript flow analysis treats `redirect()` as terminal.
- **New latent issues in damage-worker:** none surfaced. The worker
  was read in detail and matches what 5b reported. The
  `isOriginAllowed` requirement on POSTs is the most fragile contact
  point — the new `damagePostForm` handles it explicitly, but
  anything that POSTs to the worker via raw `fetch()` would 403
  silently. Worth a comment if more POST helpers land later.
- **Validation results:** see above section.
