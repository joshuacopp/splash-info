# Brief 7: Sysadmin UI (/admin/sysadmin) — replace placeholder

**Status:** Completed (2026-05-04)
**Started:** 2026-05-04
**Completed:** 2026-05-04
**Blocks:** Admin-facing UI parity. Required for legacy retirement of
sysadmin curl-only operations. After 7 lands, item 7 in BUILD_STATE.md is
fully done.
**Dependencies:** Brief 1 (login), Brief 2 (Header), Brief 4 (dashboard
tile + sysadmin placeholder file), Brief 11a (getMe surfaces session.role
for super_admin gating), Brief 11b (auth fixes — Brief 7's gating depends
on /api/me actually working).

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- AUDIT_REPORT.md (section 4 — sysadmin UI state)
- apps/sysadmin-worker/src/index.ts (the full worker — read top-to-bottom;
  5 endpoints + sysadmin_audit_log writes)
- apps/web/app/admin/sysadmin/page.tsx (current placeholder; replace)
- apps/web/app/admin/damage/_lib/worker-fetch.ts (reference pattern for
  the per-tool worker-fetch helper, including damagePostForm/Multipart
  shape)
- apps/web/app/admin/damage/[id]/actions.ts (reference for the server-
  action + redirect-with-action_error pattern)
- apps/web/app/_lib/me.ts (getMe — used to gate the page super_admin only
  before the worker even sees the request)
- packages/types/src/auth.ts (UserRole, ToolName)

## Context

Brief 7 replaces the /admin/sysadmin "coming soon" placeholder shipped in
Brief 4 with a real UI consuming sysadmin-worker's 5 endpoints. The worker
already enforces super_admin gating + CSRF, audit-logs every operation,
and is fully ported. Brief 7 is purely the apps/web side of the contract.

UX pattern: a single page with five collapsed `<details>` cards, one per
operation. Each card has a server-action `<form>` matching that
endpoint's body shape. No detail page. No user list — sysadmin is rarely
used and the operator can paste user_ids from elsewhere (Supabase SQL
editor, or the auth_unified view).

The worker has NO list-users endpoint. user-search is a follow-up brief.

After this brief lands, the dashboard's Sysadmin tile reaches a real
page that does real work, not a placeholder.

## Scope

1. **Sysadmin worker-fetch helper.**
   New file: `apps/web/app/admin/sysadmin/_lib/worker-fetch.ts`.
   - Mirror `apps/web/app/admin/damage/_lib/worker-fetch.ts` verbatim
     with `NEXT_PUBLIC_SYSADMIN_WORKER_URL` swapped in.
   - Function names: `sysadminGetJson<T>` (for any future GETs — none
     today, but keep the shape for consistency) and
     `sysadminPostJson<T>(path, body)`. The worker reads JSON for all
     5 mutation endpoints, NOT form-encoded bodies — so this helper
     sets `Content-Type: application/json` and stringifies an object,
     unlike damage's `damagePostForm`.
   - Same Cookie + Origin forwarding, same `{ ok, body }` /
     `{ ok: false, status, error }` return shape.

2. **/admin/sysadmin page (replace placeholder).**
   - Top-of-page super_admin gate. Server-side:
     ```ts
     const session = await getMe();
     if (!session) return <NoAccessCard reason="signin" returnPath="/admin/sysadmin" />;
     if (session.role !== "super_admin") {
       return <NoAccessCard reason="forbidden" />;
     }
     ```
   - The "signin" branch renders the Brief 11 Sign In button + return-path.
   - The "forbidden" branch renders "Sysadmin operations are super-admin
     only. Contact a super-admin if you need access." — no Sign In
     button, since the user IS authed but lacks the role.
   - Below the gate, render five `<details>` cards in a single column,
     each with the heading + a brief one-line description + the form.
     Cards listed in order:
       1. **Create user** — `email` (required, type=email),
          `password` (required, type=password, minLength=8),
          `role` (select: super_admin / location_admin / leave-empty),
          `tools` (checkboxes: pricing, claims, pertrack — multiple).
          Submit posts to `/sysadmin/api/create-user`. Body shape per
          worker (`apps/sysadmin-worker/src/index.ts` `handleCreateUser`):
          `{ email, password, role?, tools? }`. tools is sent as an
          array of strings.
       2. **Set role** — `user_id` (required, paste from Supabase),
          `role` (select: super_admin / location_admin / clear),
          `location_code` (required only when role = location_admin).
          Submit posts to `/sysadmin/api/set-role`.
          Body: `{ user_id, role, location_code? }`.
          Conditional rendering: `location_code` field is always
          shown but visually de-emphasized when role !== location_admin
          (worker accepts and ignores it for super_admin). Note in
          help text "Required only for location_admin role."
       3. **Grant tool** — `user_id` (required), `tool` (select:
          pricing / claims / pertrack). Submit posts to
          `/sysadmin/api/grant-tool`. Body: `{ user_id, tool }`.
       4. **Revoke tool** — same fields as Grant tool. Submit posts
          to `/sysadmin/api/revoke-tool`.
       5. **Reset password** — `user_id` (required), `new_password`
          (required, type=password, minLength=8). Submit posts to
          `/sysadmin/api/reset-password`. Body:
          `{ user_id, new_password }`. Add a confirm-password field
          client-side (HTML5 `oninput` matching) — worker doesn't
          require it but UI hygiene says yes.
   - Action-error banner at the top of the page (mirror Brief 5c's
     `ActionAlert`): renders when `?action_error=...` is present.
     Action-success banner: renders when `?action_success=...` is
     present, e.g., "User created: alice@splashcarwashes.com" or
     "Granted 'claims' to <user_id>".
   - Each form's submit button is "Apply changes" (or operation-
     specific verb: "Create user", "Set role", "Grant tool", etc.).
     Disabled state during submit not implemented (server actions
     handle the navigation; double-submit is rare and idempotent for
     most ops — except create-user which a duplicate would 409).

3. **Server actions.**
   New file: `apps/web/app/admin/sysadmin/actions.ts` (`"use server"`).
   - One action per endpoint:
       - `createUserAction(formData)` →
         /sysadmin/api/create-user
       - `setRoleAction(formData)` → /sysadmin/api/set-role
       - `grantToolAction(formData)` → /sysadmin/api/grant-tool
       - `revokeToolAction(formData)` → /sysadmin/api/revoke-tool
       - `resetPasswordAction(formData)` → /sysadmin/api/reset-password
   - Each reads its form fields, builds a typed body, calls
     `sysadminPostJson(...)`. On success: `revalidatePath` + `redirect`
     to `/admin/sysadmin?action_success=<encoded>`. On failure:
     `redirect` with `?action_error=<encoded>`.
   - Specific shapes:
     - Tools array (create-user): FormData.getAll("tools") returns
       string[] — pass as `tools: string[]`.
     - Role coercion (set-role): empty string → null (worker treats
       null as "clear role").
     - Location_code (set-role): empty string → undefined; only
       included in body when non-empty AND role === "location_admin".
   - Don't validate inputs in the action — the worker validates and
     returns 400 with a useful error message; surfacing that error
     inline is the right UX.

4. **NoAccessCard sub-component.**
   New file: `apps/web/app/admin/sysadmin/_components/NoAccessCard.tsx`
   (server component). Two render variants:
   - `reason="signin"` (401/403 from worker, or no session) — Sign In
     button with `?return=/admin/sysadmin`.
   - `reason="forbidden"` (authed but not super_admin) — explanatory
     text only, no button.
   This is essentially Brief 11's pattern broken out into a reusable
   component since 7 has two distinct no-access shapes. Don't refactor
   the existing /admin/damage or /admin/pricing no-access cards to use
   this — those have one branch each; refactor is scope creep.

5. **Active sessions / audit log.** Out of scope for v1.
   sysadmin_audit_log accumulates rows on every operation but the
   worker doesn't expose a list endpoint. A future brief can add
   /sysadmin/api/audit-log + a tab on this page; for now, the
   operator views the audit log via SQL.

6. **User search.** Out of scope. The worker doesn't expose a search
   endpoint and adding one is its own brief. v1 expects user_id pasted
   from Supabase. Add help-text under each user_id field: "Paste from
   Supabase auth.users.id" (or similar).

7. **Update /admin/dashboard's Sysadmin tile.** No change needed —
   the tile already links to /admin/sysadmin (Brief 4). The placeholder
   page just gets replaced.

8. **Update BRIEFS/INDEX.md** — mark 7 Completed, file link, item 7
   top-level row updated.

9. **Update BUILD_STATE.md** per Conventions — bump Last updated, add
   Findings entry, mark item 7 Completed in the prioritized work list,
   update apps/web pages table (`/admin/sysadmin` flips placeholder →
   real with super_admin gating), validation results.

## Configuration
No new env vars. `NEXT_PUBLIC_SYSADMIN_WORKER_URL` already in
`.env.example`. Rewrites in next.config.mjs already handle
/sysadmin/api/:path*.

## Out of scope

- User search / list endpoint on the worker — separate brief.
- Audit-log viewer — separate brief once worker exposes a list.
- Bulk operations (multi-grant, multi-create) — not in legacy either.
- Soft-delete or undo of operations — not in legacy.
- Worker code changes (other than possibly a comment update to point
  at the new UI consumer; even that's optional).
- Don't deploy, don't bind production routes, don't commit to git or
  push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- /admin/sysadmin renders the five-card UI when accessed by a
  super_admin
- Non-super_admin users see the "forbidden" card; unauthenticated
  users see the "signin" card
- Each form submits successfully against the worker (verified by:
  POST a known operation, observe a row appear in Supabase
  user_permissions / user_tool_access / sysadmin_audit_log)
- Action-error banner surfaces worker error messages inline
- Action-success banner shows on completion
- BUILD_STATE.md and BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Decisions on form layout and field grouping
- Whether the role/tools coercion logic in actions handled all the
  edge cases the worker accepts (empty role, null location_code, etc.)
- Bundle-size delta on /admin/sysadmin (was placeholder, now real
  page with five forms — should still be small, no client islands)
- Latent issues spotted in sysadmin-worker
- Validation results

## Outcome

**Files created (4):**
- `apps/web/app/admin/sysadmin/_lib/worker-fetch.ts` — `sysadminGetJson<T>(path)` (no consumers today, kept for shape parity) + `sysadminPostJson<T>(path, body)`. Same dev-vs-prod URL fork as the damage helper, same Cookie + Origin forwarding. Differs from `damagePostForm` in that it sets `Content-Type: application/json` and stringifies an object body — the worker reads `request.json()` for all 5 mutations.
- `apps/web/app/admin/sysadmin/_components/NoAccessCard.tsx` — server component with two render variants. `reason="signin"` shows a Sign In button targeting `/login?return=<encoded>`; `reason="forbidden"` shows explanatory text + Back to Dashboard. Both variants share the eyebrow + title + card chrome of the prior placeholder so the page silhouette is consistent.
- `apps/web/app/admin/sysadmin/actions.ts` — `"use server"` exporting `createUserAction`, `setRoleAction`, `grantToolAction`, `revokeToolAction`, `resetPasswordAction`. All five follow the same shape: pull fields off FormData → build typed JSON body → call `sysadminPostJson` → on failure `redirect(?action_error=...)` / on success `revalidatePath` + `redirect(?action_success=...)`. No pre-validation in the action — worker is the single source of validation truth.
- `apps/web/app/admin/sysadmin/page.tsx` — replaced the Brief 4 placeholder. Server-component page with super_admin gate at the top via `getMe()`; on no-session renders `NoAccessCard reason="signin"`, on authed-but-not-super_admin renders `NoAccessCard reason="forbidden"`, otherwise renders five collapsed `<details>` cards (Create user / Set role / Grant tool / Revoke tool / Reset password). Action-error and action-success banners read `?action_error` / `?action_success` query params.

**Files modified:** none. Brief 4's `/admin/dashboard` Sysadmin tile already targets `/admin/sysadmin` — no change needed there. The worker source was untouched.

**Decisions on operator's behalf:**

1. **Page layout = single column of `<details>` cards** per brief §scope.2 — five cards at full content width, all collapsed by default. No tabs, no sidebar, no two-column layout. Each `<summary>` shows the title + one-line description + "Open / Close" affordance on the right (gated via `group-open:` Tailwind utilities — pure CSS, no JS).
2. **Banner UX** = both error and success banners render at the top of the page (above the cards), each with a "Dismiss" link to the bare `/admin/sysadmin` URL. Success banner uses `splash-success` palette; error uses `splash-deny`. Mirrors the damage detail page's `ActionAlert` shape.
3. **Confirm-password matching** = inline `<script>` tag (not a client component). React/Next strips native `oninput` attributes on server-rendered `<input>` elements. The two cleanest paths were (a) split off a tiny `"use client"` component or (b) emit a one-liner via `dangerouslySetInnerHTML`. Chose (b) — keeps the page entirely server-rendered (zero client islands → no client JS shipped, build output confirms 161 B route size, identical to the placeholder), and the script is 12 lines of vanilla DOM — fewer moving parts than a React island. Calls `setCustomValidity('Passwords do not match')` on input → browser-native form blocking.
4. **Set-role location_code field always rendered** per brief §scope.2 — the input is shown unconditionally with helper text "Required only for location_admin role" beneath. The action only includes `location_code` in the JSON body when role === "location_admin" AND the field is non-empty (matches the worker's behavior of accepting and ignoring it for super_admin / clear-role).
5. **Tools as multi-checkbox on Create user** per brief §scope.2 — `name="tools"` on three checkboxes (pricing/claims/pertrack); `formData.getAll("tools")` collects the selected values into a string[] passed as the `tools` field on the JSON body. The action omits the field entirely when zero tools are checked (the worker accepts undefined as zero grants).
6. **Empty role on Create user** = the `role` field is omitted from the body when the empty option is selected. Worker treats missing `role` as "auth user only — no user_permissions row" (apps/sysadmin-worker/src/index.ts:284). Helper text under the role select calls this out plus the "use Set role afterwards to attach a location" caveat (the worker's create-user handler accepts `role: 'location_admin'` but always inserts with `location_code: null`, per its inline comment at line 289-291).
7. **Empty role on Set role** = JSON body sets `role: null` per worker contract; the helper text under the select reads "— Clear role —" so the destructive operation is labeled before submission. Worker `handleSetRole` (apps/sysadmin-worker/src/index.ts:192) treats null as "clear all roles" and emits a `clear_role` audit row.
8. **Sign In return-path** for the no-session branch = `/admin/sysadmin` (hard-coded — no current-page-with-query preservation since this page has no meaningful filter state). Matches the Brief 11 pricing pages' return-path pattern.
9. **`action_error` / `action_success` are mutually exclusive in practice** but the page renders both if both happen to be present (defensive — never observed; the actions never set both in a single redirect). Each gets its own banner.
10. **Cookie + Origin forwarding identical to damage helper** — `sysadminPostJson` derives Origin from the target URL (worker rejects mutations without a matching Origin/Referer). Cookie is the user's `sb-access-token` from `cookies()`; in dev cross-origin the well-documented SameSite=Lax limitation applies (apps/web's origin won't carry the dashboard-worker's cookie until cutover).

**Role/tools coercion edge cases verified:**

- Empty role string on create → omitted from body (worker accepts).
- Empty role string on set-role → sent as `role: null` (worker's "clear" path).
- Tools array empty on create → field omitted from body (worker treats as zero grants).
- location_code empty on set-role + role !== location_admin → field omitted (worker would have ignored anyway).
- location_code empty on set-role + role === location_admin → field omitted; **worker accepts `null` per its `setRole` helper signature** (locationCode parameter is `string | null`). Confirmed against apps/sysadmin-worker/src/index.ts:184,214 — `stringOrNull` plus pass-through. So sending no `location_code` for a location_admin role is silently accepted and produces a `user_permissions` row with `location_code = NULL`. **Latent UX issue:** the worker doesn't 400 on this case, even though a location_admin without a location_code is functionally equivalent to "clear" for that user. v1 behavior matches legacy; flagging for a follow-up.
- new_password < 8 chars on reset → worker 400; client-side `minLength={8}` blocks at the browser layer first.
- email malformed on create → worker would 400 from Supabase; HTML5 `type="email"` blocks at browser layer first.

**Bundle-size delta:** `/admin/sysadmin` is `ƒ` (server-rendered) at **161 B / 105 kB First Load JS** in the Next.js build output. The Brief 4 placeholder was the same baseline (161 B / 105 kB — the placeholder was already a server component with no client JS); the new five-card UI ships zero client JS as well. The inline `<script>` for password match is server-rendered into the static HTML, not a React client island. **No bundle regression.**

**Latent issues spotted in sysadmin-worker:**

1. **`handleSetRole` accepts `location_code = null` for `role = location_admin`** without erroring (apps/sysadmin-worker/src/index.ts:177-225). A location_admin row with `location_code = NULL` is functionally a no-op — that user is admin "for no location." The worker's `setRole` helper passes `locationCode: null` straight through. Legacy parity per the inline comment in `handleCreateUser` (line 289-291: "legacy doesn't accept one here"). Not a bug per se, but the UI now lets a super_admin make this misconfiguration trivially. **Forward action:** add a worker-side guard that returns `400 "location_code required for location_admin"` when role === "location_admin" and locationCode is null. Out of scope for Brief 7 (worker code change) but called out for the next sysadmin-worker pass.
2. **`handleCreateUser` ignores `location_code` even when `role = location_admin`** (apps/sysadmin-worker/src/index.ts:289-291 — inline "Caller may eventually want a location_code on creation; legacy doesn't accept one here. Add when sysadmin UI ships in Step 7."). The Brief 7 UI doesn't expose a location_code field on the Create user card — the operator must use Set role after Create user to attach a location. The worker comment says "Add when sysadmin UI ships in Step 7" which is now; the brief explicitly omitted this from scope (UI path is two-step). **Forward action:** if the two-step UX is annoying in practice, add a `location_code` field to `handleCreateUser` and the Create user card. Single-PR follow-up.
3. **No idempotency on Create user** — re-submitting the same email returns whatever Supabase's `adminCreateUser` returns, which is a 422 / non-2xx that gets surfaced in the action-error banner via `result.error`. Worker doesn't pre-check existence. Acceptable v1.
4. **Create user race: auth.users insert succeeds, then user_permissions or grant fails** — would leave an orphaned auth user with no permissions row. The worker doesn't transact across these (Supabase admin API + service-role inserts to two different tables). Legacy parity. **Forward action:** none required for v1; surface in a future cleanup.
5. **`sysadmin_audit_log` writes are best-effort and swallowed** — per the worker's leading comment (line 27-29). A dropped audit row leaves the mutation succeeded but unaudited. Legacy parity; acceptable per the worker's stated posture.

**Validation:**
- `pnpm typecheck`: 13/13 successful, 4.287s (12 cached + apps/web ran fresh).
- `pnpm --filter @splash/web build`: succeeded — Next 15.5.15 compiled in 5.0s, 12/12 static pages generated, route table:
  - `/admin/sysadmin`: `ƒ` at **161 B / 105 kB First Load JS** (no regression from placeholder).
  - All other route bundle sizes unchanged from Brief 11b snapshot.

**Smoke-test expectations** (operator-side, post-deploy):
- Hit `/admin/sysadmin` as a super_admin → five `<details>` cards render.
- Hit it as a non-super_admin → "Sysadmin operations are super-admin only" forbidden card.
- Hit it unauthenticated → Sign In card with `?return=/admin/sysadmin`.
- Submit Grant tool with a known user_id + tool → row appears in `user_tool_access`, success banner reads "Granted '<tool>' to <user_id>", row appears in `sysadmin_audit_log` with `action = 'grant_tool'`.
- Submit Reset password with mismatched confirm → browser blocks submission (setCustomValidity); fix mismatch → submits, row appears in `sysadmin_audit_log` with `action = 'reset_password'`.
- Submit Create user with a fresh email → returns user_id, success banner shows the email, rows appear in `auth.users` + `user_permissions` (if role specified) + `user_tool_access` (per checkbox) + `sysadmin_audit_log` action `create_user`.

**Anything Brief 8/9 (decisions) or future audit-log brief should know:**
- The five mutation endpoints are now consumed by apps/web. If a future "list audit log" brief lands, it should add a `<details>` "Recent audit log" card alongside the five existing cards (not a separate page) — keeps the sysadmin surface single-page. Pagination via query param.
- A user-search brief (out of scope per §scope.6) could add a 6th card "Find user" with email/substring → list of {user_id, email, role, tools} — would unblock the operator from needing the Supabase SQL editor for every grant/revoke. Worker-side: a single GET endpoint reading `auth_unified` filtered by email substring.

