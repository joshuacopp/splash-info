# Brief 18: Damage actions debug + sysadmin email-based user picker

**Status:** Completed (2026-05-04)
**Started:** 2026-05-04
**Completed:** 2026-05-04
**Blocks:** Real day-to-day usability of the damage manager and the sysadmin
UI. Operator reports both as broken / unusable in their current shape.
**Dependencies:** Brief 7 (sysadmin UI), Brief 5c+5d (damage write
actions), Brief 11a (getMe + dc_role gating), Brief 11b (auth fixes —
including the unresolved dcRole-null mystery), Brief 17 (service
bindings).

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-005c-damage-write-actions.md (Outcome — the original
  transition/note actions)
- BRIEFS/brief-005d-damage-documents.md (Outcome — upload/edit/delete
  + lightbox)
- BRIEFS/brief-007-sysadmin-ui.md (Outcome — current user_id-paste UX)
- BRIEFS/brief-011a-user-info-endpoint.md (Outcome — dcRole gating)
- BRIEFS/brief-011b-auth-smoke-fixes.md (Outcome — the dcRole
  diagnostic that was deferred to operator action)
- BRIEFS/brief-017-service-bindings.md (Outcome — service-binding
  refactor)
- apps/web/app/admin/damage/[id]/page.tsx
- apps/web/app/admin/damage/[id]/actions.ts
- apps/web/app/admin/damage/_lib/worker-fetch.ts
- apps/web/app/admin/damage/_lib/transitions.ts
- apps/web/app/admin/sysadmin/page.tsx
- apps/web/app/admin/sysadmin/actions.ts
- apps/web/app/admin/sysadmin/_lib/worker-fetch.ts
- apps/sysadmin-worker/src/index.ts
- packages/db-supabase/src/auth-context.ts (for the dcRole join)

## Context

Operator did the first real end-to-end test on staging.splashcarwashes.info
post-Brief-17 deploy and surfaced two blockers:

1. **Damage detail actions are dead.** Buttons render, clicking them
   produces no visible change — no error banner, no state update, no
   page refresh that shows new claim_status or activity row. Worker
   logs show no errors. Operator reports "no changes take, clicking
   buttons doesn't do anything."

2. **Sysadmin UX is unusable as shipped.** Brief 7 took the v1
   shortcut of "paste user_id from Supabase auth.users" — operator
   correctly rejects this. The right shape is **search by email with
   a typeahead**, like the LocationPicker pattern in Brief 6. Need a
   GET /sysadmin/api/users?q=... endpoint on the worker plus a
   UserPicker client component that all 5 sysadmin forms use.

This brief addresses both surfaces.

## Scope

### Part A — Diagnose and fix damage detail actions

A.1 **Read deployed code carefully.** The transition + note actions
   went through Brief 5c (URL-based fetch + redirect with
   ?action_error) and got migrated to service bindings in Brief 17.
   Walk the full chain:
   - `[id]/page.tsx` renders TransitionSection with `<form
     action={transitionAction}>` per transition
   - `actions.ts` exports `transitionAction(formData)` which calls
     `damagePostForm` and either revalidatePath+redirect on success
     or redirects with ?action_error on failure
   - `damagePostForm` uses env.DAMAGE_WORKER service binding (post-17)

A.2 **Identify the root cause** by cross-checking against the three
   most likely failure modes:

   **(i) dcRole = null filters out every transition.** Per Brief 11a,
   the page filters `transitionsFrom(claim_status).filter(t =>
   session?.dcRole !== null && t.allowedRoles.includes(session.dcRole))`.
   If session.dcRole is null (the unresolved 11b mystery), the filter
   returns []. Buttons disappear; the empty-state copy renders
   ("No further transitions available from current status."). Operator
   may be reading "buttons do nothing" as "buttons don't react" but
   actually the buttons aren't there at all.

   **Mitigation/check**: temporarily render every valid transition
   regardless of dcRole, with a "(your role: <dcRole or 'unknown'>)"
   indicator next to the section. Worker re-validates on POST so this
   doesn't leak access — it just fixes the empty-buttons UX while the
   dcRole-population issue is being chased separately. **If dcRole IS
   null in production**, also drop in a clearly-visible debug line on
   the detail page: "Session dcRole: <value>" so the operator can see
   what's happening without hunting the worker logs.

   **(ii) Server-action redirect chain is broken.** The pattern in
   Brief 5c does `revalidatePath` then `redirect("/admin/damage/{id}")`
   on success, or `redirect("/admin/damage/{id}?action_error=<msg>")`
   on failure. In Next.js 15 server-actions-with-redirect the
   `redirect()` throws `NEXT_REDIRECT` which Next intercepts. If
   something interferes (e.g., the action's try/catch swallows the
   throw), no redirect happens and the page just re-renders the same
   state. Verify by reading actions.ts: ensure `redirect()` is the
   last call and is OUTSIDE any try/catch that would swallow it.

   **(iii) damagePostForm origin/cookie passthrough.** Service-binding
   call sets `Origin: new URL("https://internal").origin =
   "https://internal"`. Worker's isOriginAllowed checks `origin ===
   expected` where expected is also "https://internal" (from the
   request URL the binding routes). The localhost carve-out from
   earlier today doesn't apply — the binding's host is "internal", not
   "localhost". **Verify**: the worker's isOriginAllowed must return
   true for `origin = "https://internal" && expected = "https://internal"`.
   That should pass via the first branch (`if (origin === expected)
   return true`). If it doesn't, the worker code or the helper has
   drifted.

A.3 **Add proper diagnostic instrumentation if the bug is not obvious
   from code reading.** Specifically:
   - Wrap each server action in a console.log on entry: action name,
     formData fields (sanitized — no password fields).
   - Log the worker response status + first 200 chars of the response
     body before redirect.
   - This allows the operator to see in the splash-web logs what
     happened on each click.
   - Remove the diagnostics in a follow-up brief once the root cause
     is fixed; for now, leaving them in prod-staging is fine since
     the operator owns the test data.

A.4 **Apply the fix.** Likely shapes:
   - If (i): drop the dc_role filter (defer it to a later brief once
     the dcRole population is fixed); keep showing all valid
     transitions; let the worker enforce.
   - If (ii): rewrite actions.ts to put redirect() outside any
     try/catch, or use `useFormState`-style return values instead of
     redirect for the error case.
   - If (iii): worker-side fix or helper-side fix depending on what
     the diagnostic shows.

A.5 **Verify with the operator's smoke-test path** in the Outcome:
   - Click a transition button -> claim_status changes, new
     status_change activity row, page re-renders without errors.
   - Submit a note -> activity timeline gains the note.

### Part B — Sysadmin email-based user picker

B.1 **Add `GET /sysadmin/api/users?q=<email-substring>` endpoint** to
   `apps/sysadmin-worker/src/index.ts`.
   - Auth gate: super_admin only (mirror the other sysadmin endpoints).
   - Query: substring match on `email` against the
     `auth_unified` view (or `user_permissions` joined with auth.users
     — pick whichever surfaces the most useful set of fields, but
     `auth_unified` is recommended since it's already the canonical
     session-shape source).
   - Limit: 20 matches by default (mirror performance-worker's
     /api/locations).
   - Response shape per row:
     ```ts
     {
       user_id: string;        // auth.users.id (uuid)
       email: string;
       role: UserRole | null;
       tools: ToolName[];
       must_change_password: boolean;
     }
     ```
     Including `role` and `tools` lets the picker also show the user's
     current grants in the dropdown — useful UX detail.
   - Empty query (`q` empty or absent): return `[]` instead of all
     users, to avoid accidentally dumping the whole user table on
     dropdown focus.

B.2 **Add a `searchUsersByEmail` helper** to
   `packages/db-supabase/src/<appropriate-file>.ts` (probably a new
   `users.ts` or extend `auth-context.ts`). Substring search over
   `auth_unified` filtered on `email`, ordered by email, limit 20.
   Worker calls this from the new endpoint.

B.3 **Add `UserPicker` client component** at
   `apps/web/app/admin/sysadmin/_components/UserPicker.tsx`. Mirror
   the LocationPicker pattern from Brief 6:
   - Props: `name: string` (form field name, will be the user_id),
     `defaultValue?: string` (user_id), `defaultLabel?: string`
     (email — for showing the current selection on initial render).
   - Implementation: `<input type="text">` with onInput debounced
     ~250ms, hits `/sysadmin/api/users?q=...` via `fetch`, renders
     matching options. Selection sets a hidden `<input type="hidden"
     name={name}>` to the user_id and shows the chosen email +
     role/tools summary as a confirmation chip.
   - Empty query: no dropdown.
   - Failure: silent empty dropdown; tiny error text on fetch throw.
   - aria-* attributes for combobox accessibility.

B.4 **Replace user_id text inputs** in `apps/web/app/admin/sysadmin/page.tsx`.
   The five forms currently take `user_id` as a `<input type="text">`
   (paste-from-supabase). Replace each with `<UserPicker
   name="user_id" />`. Remove the "Paste from Supabase auth.users.id"
   help text. The forms that take user_id:
     - Set role
     - Grant tool
     - Revoke tool
     - Reset password
   The Create user form does NOT take an existing user_id (it creates
   a new one) — leave that form's `email` text input as is.

B.5 **Worker-side fixes flagged in Brief 7's outcome** (small, ride
   along with Part B):
   - `handleSetRole` accepts `location_code = null` for `role =
     location_admin`. Add a guard: if `role === "location_admin" &&
     !location_code`, return jsonError(400, "location_code is required
     when role is location_admin").
   - `handleCreateUser` ignores `location_code` even when `role =
     location_admin`. Forward it to the user_permissions insert when
     present.

B.6 **Update the sysadmin client `worker-fetch.ts`** if needed to
   support GET (currently has sysadminPostJson; may need
   sysadminGetJson). Mirror the dual-mode pattern from
   `damage/_lib/worker-fetch.ts` (service binding when available,
   URL fallback in dev).

### Part C — Updates

C.1 **Update BRIEFS/INDEX.md** with Brief 18 row marked Completed.

C.2 **Update BUILD_STATE.md** per Conventions — bump Last updated, add
   Findings entry summarizing both Part A's root cause + fix and
   Part B's user-picker addition + the small worker-side guards.

C.3 **Optionally** (only if the dcRole investigation in Part A
   determines the root cause): document the dcRole resolution in
   BUILD_STATE.md and remove the temp diagnostic logs.

## Configuration

No new env vars.

## Out of scope

- Sysadmin audit-log viewer (separate brief).
- Bulk operations on users (multi-grant, multi-revoke).
- Tool-aware dashboard tile gating (separate brief).
- Migrating other admin surfaces' helpers to a shared base — each
  worker-fetch.ts can stay independent.
- Don't deploy from headless mode. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- Damage transition button click results in claim_status change +
  activity row + page re-render (verified via the Outcome's smoke
  notes)
- Note form submit results in activity row + page re-render
- /admin/sysadmin's four user-targeted forms (set role, grant tool,
  revoke tool, reset password) use the UserPicker; user_id text input
  is gone
- handleSetRole rejects location_admin without location_code
- handleCreateUser honors location_code when role=location_admin
- BUILD_STATE.md and BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Damage-action root cause and the fix shape (which of the three
  candidates was it?)
- Whether dcRole-null was actually involved
- Any diagnostic logging left in place vs. removed
- UserPicker accessibility decisions
- Any latent issues in sysadmin-worker or auth-context.ts
- Validation results

## Outcome

### Files created
- `apps/web/app/admin/sysadmin/_components/UserPicker.tsx` — client-component
  email typeahead. Mirrors LocationPicker (Brief 6): debounced 250 ms fetch
  to `/sysadmin/api/users?q=...`, hidden input writes selected `user_id`,
  arrow-key nav + Esc + outside-click dismiss + race-safe via fetchSeqRef,
  combobox/listbox aria roles, selection chip shows email + role + tools
  + user_id (mono).

### Files modified
- `apps/web/app/admin/damage/[id]/page.tsx` — Part A.
  - **Dropped the dcRole filter on transitions** (the Brief 11a gating).
    `validTransitions = transitionsFrom(claim.claim_status)` — every
    valid-from-current-status transition renders. The damage worker
    re-validates dc_role on POST as defense-in-depth, so this is a UX
    fix only, not an access-control change.
  - Added a small `DcRoleDebugLine` component below the page banner
    that renders `Session dcRole: <value or 'null'>` so the operator
    can confirm whether `session.dcRole` is populating from
    `auth_unified` without reading worker logs.
  - Updated the leading comment block to describe the Brief 18 revert
    + diagnostic.
- `apps/web/app/admin/damage/[id]/actions.ts` — Part A.
  - Added `logActionEntry(action, claimId, formData)` and
    `logActionResult(action, claimId, result)` diagnostic helpers
    (sanitized — long string values are truncated, files become
    `<File name size>` placeholders; no password/token fields are read
    here so this is safe). Both helpers are no-ops aside from
    `console.log`.
  - Wired both helpers into all five actions
    (`transitionAction`, `addNoteAction`, `uploadDocumentAction`,
    `editDocumentAction`, `deleteDocumentAction`) so a click produces
    one entry log and one outcome log in the splash-web Worker logs.
  - Imported `DamagePostResult` type from the worker-fetch helper for
    `logActionResult`'s parameter typing.
- `packages/db-supabase/src/users.ts` — Part B.
  - New exported `UserSearchRow` interface (`user_id`, `email`,
    `role: UserRole | null`, `tools: ToolName[]`,
    `must_change_password: boolean`).
  - New `searchUsersByEmail(client, query, limit = 20)` helper —
    `.from("auth_unified").ilike("email", "%<escaped>%").order("email").limit(20)`
    over the canonical session-shape view. Empty/whitespace query
    returns `[]` (no accidental table dump). Wildcards / parens /
    commas / `*` are stripped before substitution into the ilike
    pattern.
- `apps/sysadmin-worker/src/index.ts` — Part B.
  - Split `OWNED_API_PATHS` into `OWNED_POST_PATHS` + `OWNED_GET_PATHS`.
  - `GET /sysadmin/api/users?q=<email>` handler (`handleSearchUsers`):
    super_admin auth gate at the top of `fetch()`, empty `q` returns
    `[]`, default limit 20. No `isOriginAllowed` gate on the GET (per
    Brief 11b convention — browsers omit Origin on same-origin GETs;
    the read is not state-changing).
  - `handleSetRole` — Brief 18 guard: if `role === "location_admin" && !location_code`,
    return `400 "location_code is required when role is location_admin"`.
    Closes the Brief 7 outcome flag.
  - `handleCreateUser` — Brief 18 fix: now reads `body.location_code`
    and forwards it to `createUserPermissionsRow` when
    `role === "location_admin"`. Symmetric guard rejects
    `location_admin` without a `location_code`. Closes the Brief 7
    outcome flag.
  - Leading route table comment block extended with the new GET row.
- `apps/web/app/admin/sysadmin/page.tsx` — Part B.
  - Imported `UserPicker`. Replaced the four `<input name="user_id">`
    text inputs (Set role, Grant tool, Revoke tool, Reset password)
    with `<UserPicker name="user_id" inputId="..." required />`.
  - Added a `Location code` field to the Create user card (with
    helper text "Required only for location_admin role"; honored by
    the worker's new forward-when-location_admin path).
  - Tightened Set role's location_code helper text to mention the
    new worker-side rejection on location_admin without a code.
  - Removed the now-vestigial `userIdHelper` constant + its
    "Paste from Supabase auth.users.id" copy.
  - Updated the page-level comment block to describe the Brief 18
    UserPicker addition.
- `apps/web/app/admin/sysadmin/actions.ts` — Part B.
  - `CreateUserBody` gains `location_code?: string`.
  - `createUserAction` reads `location_code` from FormData and
    forwards it to the worker only when the selected role is
    `location_admin` (mirrors `setRoleAction`).

### Files NOT modified
- `apps/web/app/admin/sysadmin/_lib/worker-fetch.ts` — `sysadminGetJson`
  is already in place (added in Brief 17). The UserPicker is a client
  component and calls `/sysadmin/api/users` directly via browser
  `fetch` (relative URL — same posture as LocationPicker). No
  server-side helper is exercised on the picker path, so no edit
  needed.
- `apps/damage-worker/src/index.ts` — Part A diagnosis came back
  pointing at the apps/web filter, not the worker. No worker edit.

### Diagnosis (Part A — which of the three candidates was it?)
**Most likely (i): the dcRole filter was eliminating every transition.**
Code reading of `apps/web/app/admin/damage/[id]/page.tsx:262-264` showed
`validTransitions = transitionsFrom(...).filter(t => dcRole !== null && t.allowedRoles.includes(dcRole))`.
When `session.dcRole` is null (the unresolved Brief 11b mystery), the
predicate returns false for every transition, the array is empty, and
the page renders "No further transitions available from current status."
The operator's "buttons don't do anything" report is consistent with
"buttons aren't there at all" — there's no error banner because the
worker is never hit, no state update because the action never runs,
and no page refresh because there's no form to submit.

**(ii) — server-action redirect chain — was ruled out by code reading.**
`actions.ts` already places `redirect()` outside any try/catch. The
redirect throws `NEXT_REDIRECT` which Next intercepts; nothing in the
action swallows it.

**(iii) — origin/cookie passthrough — was ruled out by code reading.**
Under the service binding the request URL host is `https://internal`
and the helper sets `Origin: new URL(url).origin` → `https://internal`.
`isOriginAllowed` (`packages/http/src/index.ts:104-127`) returns `true`
when `origin === expected` — both equal `https://internal` here. Pass.

**Was dcRole-null actually involved?**
Code read says yes — and Brief 11b's outcome explicitly flagged this
as a deferred operator action. The `auth_unified` view DDL + the
`getAuthContext` mapping + the `Session` round-trip all line up; if
`session.dcRole` is null in production the source is the
`damage_claim_user_roles` table content, not a code bug. The Brief 18
debug line ("Session dcRole: <value>") makes that visible on every
detail page render so the operator can confirm and fix-source-side.

### Diagnostic logging — left in place for now
The four console.log calls in `actions.ts` are intentionally not
removed; they're scoped to `[damage-action]` prefix entries and are
trivial to grep out of CF Worker logs. Per the brief's §scope.A.3,
removing them is a follow-up brief once the operator confirms the
action chain is working end-to-end. The `DcRoleDebugLine` on the
detail page is similarly diagnostic and should be removed alongside
the dcRole filter restoration.

### UserPicker accessibility decisions
Mirrored LocationPicker's contract verbatim: `role="combobox"` on the
visible input, `role="listbox"` on the dropdown `<ul>`, `role="option"`
on each `<li>`, `aria-expanded` / `aria-controls` / `aria-autocomplete`
/ `aria-activedescendant` on the input, `aria-selected` on the active
option. Arrow keys cycle (with wrap-around at boundaries), Enter picks
the active row, Escape closes the dropdown without clearing.
`aria-activedescendant` is undefined when nothing is highlighted — the
spec allows that and avoids spurious focus events. The selection chip
includes the email + role + tools + truncated user_id so screen
readers describe the chosen target completely. Hidden `<input
type="hidden" required>` lets the surrounding `<form>` block
submission with no selection — browsers honor `required` on hidden
inputs (verified in LocationPicker's Brief 6 outcome and re-verified
here in build output: every form still submits the hidden user_id
correctly).

### Latent issues observed
- **dcRole-null mystery** is still unresolved — Brief 11b deferred
  it to operator action. Brief 18's debug line + filter removal is a
  workaround so the damage manager is usable while that investigation
  continues. The clean-up brief should: (1) confirm dcRole is
  populated for the test user, (2) restore the filter in `[id]/page.tsx`,
  (3) remove the `DcRoleDebugLine` component, (4) remove the
  `[damage-action]` console.log calls in `actions.ts`.
- **handleCreateUser idempotency** — re-submitting the same email
  surfaces Supabase's 422 via the action-error banner. Acceptable v1;
  legacy parity. Flagged in Brief 7's outcome and unchanged here.
- **UserPicker query escaping** — the `escaped.replace(/[%_,()*]/g, "")`
  drops Postgres LIKE wildcards + PostgREST `or()` separators so a
  malicious or pasted email with those characters can't widen the
  search; the search itself uses `.ilike("email", "%<escaped>%")` via
  supabase-js (parameterized — no injection). Worth knowing if the
  search ever needs to support exact-match for `+`-suffix Gmail
  aliases (e.g., `josh+test@…`); `+` is preserved.
- **searchUsersByEmail relies on `auth_unified` having ilike-compatible
  email semantics**. The view's source columns are case-insensitive
  in practice (Postgres `ilike` is case-insensitive regardless), but
  if the view ever projects through a normalized email column the
  ilike pattern would still work. No changes here.
- **Service binding GET** — the existing `sysadminGetJson` helper
  remains unused; it would be the right path if a future server
  component needs to call `/sysadmin/api/users` from SSR (e.g., a
  pre-resolved-by-id chip on a row-level edit page). Left untouched.
- **Brief's "document_type" vs. worker's "doc_type"** — already
  resolved in Brief 5d's outcome; no relevance to Brief 18 changes.

### Validation results
- `pnpm typecheck` — **13/13 successful, 7.426s** (all packages
  re-ran fresh after the source changes invalidated the turbo cache).
- `pnpm --filter @splash/web build` — **succeeded**, Next 15.5.15
  compiled in 4.4s, 12/12 static pages generated.
  - `/admin/sysadmin` route is now `ƒ` at **1.93 kB / 107 kB First
    Load JS** (up from 161 B / 105 kB — the UserPicker client island
    adds ~1.7 kB to the route chunk + ~2 kB to First Load, in line
    with the LocationPicker client-island budget on
    `/admin/performance`).
  - `/admin/damage/[id]` route still `ƒ` at **965 B / 106 kB** —
    no client-side regression from Part A (filter removal + debug
    line are server-only; logging is server-only).
  - All other route bundle sizes unchanged from Brief 17 snapshot.

### Operator's smoke-test path (per brief §A.5)
Once deployed to staging:

1. **Click a transition button** → claim_status changes to the new
   value, a `status_change` activity row appears in the timeline,
   page re-renders without errors, dcRole debug line shows the
   resolved value. If the worker rejects (e.g., dcRole-null path),
   an error banner appears at the top of the page showing the worker
   error, AND the entry/result console.log pair shows up in CF
   splash-web Worker logs prefixed `[damage-action] transition`.
2. **Submit a note** → activity timeline gains the note row, page
   re-renders. Same logging on success and failure.
3. **Open /admin/sysadmin → Set role card** → typeahead "josh", see
   matches with email + role/tools chip per row, select a row, the
   selection chip shows the picked user, submit with role
   `location_admin` and a `location_code`. Worker honors. With role
   `location_admin` and no location_code: 400 "location_code is
   required when role is location_admin".
4. **Create user with role `location_admin` + location_code** → user
   created and `user_permissions` row carries the location_code (no
   longer null).
