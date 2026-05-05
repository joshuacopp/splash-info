# Brief 19: Server-action result + router.refresh() pattern (replace redirect-based UX)

**Status:** Completed (2026-05-04)
**Started:** 2026-05-04
**Completed:** 2026-05-04
**Blocks:** Real day-to-day usability of damage manager and sysadmin
write surfaces. Pricing admin works because it's client-side fetch +
setState; damage and sysadmin use server-action `redirect()` which
isn't visibly navigating the browser in the staging deploy (Next 15 +
OpenNext + Cloudflare Workers edge).
**Dependencies:** Brief 18 (current state of damage actions + sysadmin
UI), Brief 17 (service bindings — server actions reach workers
correctly).

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-018-damage-and-sysadmin-fixes.md (Outcome — current
  damage detail + sysadmin shape post-18)
- apps/web/app/admin/damage/[id]/page.tsx
- apps/web/app/admin/damage/[id]/actions.ts
- apps/web/app/admin/sysadmin/page.tsx
- apps/web/app/admin/sysadmin/actions.ts
- apps/web/app/admin/pricing/[location]/grid.tsx (reference for the
  client-fetch + local-state pattern that already works in production)
- React 19 docs on `useActionState`
- Next.js 15 docs on `useRouter().refresh()`

## Context

Operator's first real end-to-end test on staging surfaced this:

  - Pricing admin (Brief 4 + worker actions) — works. Client component
    does `fetch()` to /admin/api/.../set-mode, on success updates
    `useState` for packages/resolved, UI reflects new state
    immediately.
  - Damage detail (Brief 5c + 5d + 18) — actions run, worker accepts,
    DB updates. But the browser doesn't visibly refresh. Operator has
    to hard-reload to see the new state.
  - Sysadmin (Brief 7 + 18) — same: action runs, change persists,
    page sits unchanged until manual reload.

Brief 5c's pattern was server actions with `redirect()` to bare URL
(success) or `?action_error=...` (failure). Brief 18's diagnostic ruled
out (a) action throwing, (b) Origin gate rejecting, (c) helper not
firing. The action runs to completion. The `redirect()` throws
`NEXT_REDIRECT` which Next is supposed to intercept, but in the
OpenNext-on-Cloudflare-Workers runtime the response evidently doesn't
trigger a client-side navigation.

Path forward: switch to **React 19 `useActionState` + `router.refresh()`**.
The server action returns a serializable result instead of redirecting;
a thin client wrapper around each form calls the action via
`useActionState`, reads the result on completion, and either calls
`router.refresh()` (success) or displays the error inline. Server
components remain server components; the wrappers are minimal client
islands.

This pattern matches how Next.js docs recommend handling "post-action
inline feedback" and is what pricing admin effectively does (just via
direct `fetch()`).

## Scope

### Part A — Damage detail server actions

A.1 Update `apps/web/app/admin/damage/[id]/actions.ts`:

  - Change every action's signature from `(formData) => Promise<void>`
    to `(prevState, formData) => Promise<ActionResult>` where
    ```ts
    type ActionResult = { ok: true; message?: string } | { ok: false; error: string };
    ```
    The `prevState` param is required by `useActionState`'s contract;
    actions can ignore it.

  - Replace each action's body from
    ```ts
    redirect("/admin/damage/" + claimId);                  // success
    redirect("/admin/damage/" + claimId + "?action_error=" + ...); // failure
    ```
    with
    ```ts
    return { ok: true, message: "Status updated" };
    return { ok: false, error: result.error };
    ```

  - Affected actions (all five): `transitionAction`, `addNoteAction`,
    `uploadDocumentAction`, `editDocumentAction`,
    `deleteDocumentAction`.

  - Keep the `[damage-action]` console.log diagnostics from Brief 18
    in place (the dcRole investigation is still open).

  - Keep the `revalidatePath` calls (still useful — they invalidate
    the route's cached data so the next render sees the new state).

A.2 Add `apps/web/app/admin/damage/[id]/_components/ActionForm.tsx`
   (`"use client"`):

   ```tsx
   "use client";

   import { useActionState, useEffect } from "react";
   import { useRouter } from "next/navigation";

   type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

   interface ActionFormProps {
     action: (prevState: ActionResult | null, formData: FormData) => Promise<ActionResult>;
     children: React.ReactNode;
     className?: string;
     /** Reset form on success. Default true. */
     resetOnSuccess?: boolean;
   }

   export function ActionForm({ action, children, className, resetOnSuccess = true }: ActionFormProps) {
     const [result, formAction, isPending] = useActionState(action, null);
     const router = useRouter();
     // On a fresh ok result, refresh the route data + show toast.
     useEffect(() => {
       if (result?.ok) {
         router.refresh();
       }
     }, [result, router]);

     return (
       <form action={formAction} className={className} {...(resetOnSuccess && result?.ok ? { key: String(result.message ?? "") } : {})}>
         {children}
         {/* Inline status under the form: success toast or error banner. */}
         {result?.ok ? (
           <p role="status" className="mt-2 text-sm font-semibold text-splash-success">
             {result.message ?? "Saved."}
           </p>
         ) : null}
         {result && !result.ok ? (
           <p role="alert" className="mt-2 rounded-splash-sm border border-splash-deny/40 bg-splash-deny/10 px-3 py-2 text-sm font-medium text-splash-deny">
             {result.error}
           </p>
         ) : null}
         {/* Pending indicator the children can read via context if they want;
             for v1, surface it via a data-attribute on the form. */}
       </form>
     );
   }
   ```

   - Use the `key` trick to remount the form on success (clears uncontrolled
     inputs like the note textarea).
   - `router.refresh()` triggers a re-fetch of the route's server-component
     data; the `revalidatePath` inside the action ensures the cache is
     invalidated; together they yield fresh state on the page.
   - Keep TypeScript-strict.

A.3 Update `apps/web/app/admin/damage/[id]/page.tsx` to wrap each
   server-rendered form with `<ActionForm action={...}>`:

   - The transition section's per-transition `<form>`s become
     `<ActionForm action={transitionAction}>...</ActionForm>`
   - The note form becomes `<ActionForm action={addNoteAction}>...</ActionForm>`
   - The upload card -> `<ActionForm action={uploadDocumentAction}>`
   - Edit form inside `<details>` -> `<ActionForm action={editDocumentAction}>`
   - Delete confirm form -> `<ActionForm action={deleteDocumentAction}>`

   Drop the `?action_error=` reading + `<ActionAlert>` banner (the new
   per-form result handling replaces it).

A.4 Drop the `?action_error=` and (if any) `?action_success=` URL
   parameters from any redirects elsewhere in the page — they're no
   longer needed.

### Part B — Sysadmin server actions

B.1 Update `apps/web/app/admin/sysadmin/actions.ts` with the same
   shape change:
   - Each action returns `ActionResult` instead of redirecting.
   - Affected actions: `createUserAction`, `setRoleAction`,
     `grantToolAction`, `revokeToolAction`, `resetPasswordAction`.
   - Success messages should be specific:
     - createUser: `"User created: " + email`
     - setRole: `"Role updated"`
     - grantTool: `"Granted " + tool`
     - revokeTool: `"Revoked " + tool`
     - resetPassword: `"Password reset"`

B.2 Reuse the `<ActionForm>` component from Part A. Put a shared
   copy at `apps/web/app/admin/_components/ActionForm.tsx` instead
   of damage-namespaced — both pages import from there.

   (Refactor: move the file from
   `apps/web/app/admin/damage/[id]/_components/ActionForm.tsx` to
   `apps/web/app/admin/_components/ActionForm.tsx`. Update the damage
   detail import. Add the sysadmin imports.)

B.3 Update `apps/web/app/admin/sysadmin/page.tsx`:
   - Wrap each of the five card forms with `<ActionForm
     action={...}>`. The UserPicker stays inside as a child.
   - Drop the `?action_error=` and `?action_success=` searchParam
     handling at the top of the page (the per-form `<ActionForm>`
     handles result display now).
   - Keep the no-access cards and super_admin gate.

### Part C — Updates

C.1 Update CLAUDE.md with a "Server actions: useActionState +
   router.refresh() pattern" subsection. Document why we don't use
   redirect() from server actions (Next 15 + OpenNext + CF Workers
   edge case where redirect doesn't propagate visibly). Future
   write-action briefs should follow this pattern, not the
   redirect+searchParam pattern.

C.2 BRIEFS/INDEX.md — Brief 19 row marked Completed.

C.3 BUILD_STATE.md — Findings entry summarizing the pattern flip.

## Out of scope

- Refactoring pricing admin (already works via direct client fetch).
- Removing the dcRole filter restoration / debug line on damage
  detail (still open until the dcRole-null mystery is resolved).
- Changing performance-worker's create-submission flow (different
  worker, different shape, not affected by the redirect issue
  because Brief 6's submit path uses redirect-then-success-banner
  via searchParam — works for it, leave alone unless operator
  reports the same symptom).
- Don't deploy from headless mode. Operator pushes; CF Workers
  Builds redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- All five damage detail server actions return ActionResult; no
  more redirect() calls in apps/web/app/admin/damage/[id]/actions.ts
- All five sysadmin server actions return ActionResult; no more
  redirect() calls in apps/web/app/admin/sysadmin/actions.ts
- Shared `<ActionForm>` exists at apps/web/app/admin/_components/
  ActionForm.tsx; both pages import from there
- Damage detail forms wrap in `<ActionForm>`
- Sysadmin five cards wrap in `<ActionForm>`
- `?action_error=` / `?action_success=` URL params no longer
  generated or read on either page
- BUILD_STATE.md and BRIEFS/INDEX.md updated; CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Whether `useActionState` + `router.refresh()` produces visible
  refresh of the page server-component data (verified via local
  reasoning of the data-flow even if not testable in headless)
- Bundle-size delta on /admin/damage/[id] and /admin/sysadmin from
  the new ActionForm client island (~1 kB expected)
- Any TypeScript inference issues with the ActionResult union
- Any remaining places in the codebase still using the
  redirect+searchParam pattern that should follow up later (e.g.,
  performance-worker's submission form — out of scope here, but
  flag if operator-reported)
- Validation results

## Outcome

### Files created

- `apps/web/app/admin/_components/ActionForm.tsx` — shared `"use client"`
  wrapper around `<form>` for server actions that return `ActionResult`.
  Exports `ActionResult` type. Implementation:
  - `useActionState(action, null)` to dispatch the action and read its
    serialized result.
  - `useEffect` that calls `router.refresh()` whenever a fresh ok result
    arrives — pairs with the action's `revalidatePath()` to fetch the
    post-mutation server-component state.
  - Inline result rendering: `role="status"` (success, splash-success
    color) or `role="alert"` (error, splash-deny color) directly under
    the form.
  - `resetOnSuccess` prop (default true) keys the `<form>` off
    `ok:<message>` so React remounts the subtree on success — clears
    uncontrolled `<input>`/`<textarea>`/`<select defaultValue>` inputs.
  - `encType` passthrough so multipart upload forms keep working.
  - `data-pending` attribute on the form for downstream styling hooks
    (read but unused by current children; kept for low-overhead hookup).

### Files modified

- `apps/web/app/admin/damage/[id]/actions.ts` — all five actions
  (`transitionAction`, `addNoteAction`, `uploadDocumentAction`,
  `editDocumentAction`, `deleteDocumentAction`) now have signature
  `(_prevState: ActionResult | null, formData: FormData) => Promise<ActionResult>`
  and return `{ ok: true, message }` / `{ ok: false, error }` instead of
  calling `redirect()`. The `errorRedirect` helper and `redirect` /
  `next/navigation` imports are removed. `revalidatePath` calls remain
  (still useful — they invalidate the route cache so `router.refresh()`
  in `<ActionForm>` sees the new state). Brief 18's
  `logActionEntry` / `logActionResult` diagnostic logging is retained.
  Success messages are specific (e.g., "Status updated to <to_status>",
  "<doc_type> uploaded") so the inline toast is intelligible.

- `apps/web/app/admin/damage/[id]/page.tsx` — every server-rendered
  `<form action={...}>` is now `<ActionForm action={...}>`: the
  per-transition forms (TransitionForm), AddNoteCard, DocumentEditForm,
  ConfirmDeleteBanner's delete form, and the UploadDocumentCard's
  multipart form (passes `encType="multipart/form-data"`). Dropped the
  `actionError` searchParam reading + the page-level `<ActionAlert>`
  banner + its function definition (per-form result rendering replaces
  it). Updated the leading comment block to reflect Brief 19.

- `apps/web/app/admin/sysadmin/actions.ts` — same shape change for all
  five actions (`createUserAction`, `setRoleAction`, `grantToolAction`,
  `revokeToolAction`, `resetPasswordAction`). The
  `errorRedirect`/`successRedirect` helpers are gone along with the
  `redirect` / `next/navigation` import. Success messages match the
  brief's spec (`"User created: <email>"`, `"Role updated"`,
  `"Granted <tool>"`, `"Revoked <tool>"`, `"Password reset"`).

- `apps/web/app/admin/sysadmin/page.tsx` — wrapped all five
  `<OperationCard>` forms with `<ActionForm action={...}>`. Removed the
  `?action_error=` / `?action_success=` searchParams reading + the
  page-level `<ActionAlert>` banner pair + its function definition.
  Removed the now-unused `searchParams: Promise<...>` props (page no
  longer needs them) — `PageProps` interface dropped, `firstParam`
  helper dropped. UserPicker stays nested inside the four user-targeted
  forms. The PASSWORD_MATCH_SCRIPT was rewritten to use event
  delegation on `document` instead of binding to element references at
  parse-time — necessary because `<ActionForm>` remounts the form on
  success (resetOnSuccess=true) and the old script would have stale
  references after the first successful reset.

- `CLAUDE.md` — added a "Server actions: useActionState +
  router.refresh() pattern (Brief 19)" subsection under "Working with
  apps/web", inserted before "Service bindings (Brief 17)". Documents
  the rationale (OpenNext-on-CF redirect propagation gap), the four-
  step pattern (signature, body, wrapper, drop searchParam handling),
  and the inline-script gotcha (event delegation required when scripts
  bind to remounted form inputs).

- `BUILD_STATE.md` — bumped Last updated; added a Findings entry; added
  Brief 19 row to the prioritized work list.

- `BRIEFS/INDEX.md` — added Brief 19 row marked Completed.

- This brief — Status set to Completed (2026-05-04), Started + Completed
  filled in.

### Decisions made on operator's behalf

1. **`<ActionForm>` is the entire client island** — no per-form bespoke
   wrappers, no per-action variants. The brief sketched `<ActionForm>`
   as a thin reusable; honored. Both pages (damage detail + sysadmin)
   import from the shared location at
   `apps/web/app/admin/_components/`.

2. **Specific success messages over a generic "Saved"** — the brief
   listed sysadmin's per-action messages explicitly; for damage I chose
   parallel structure (e.g., `"Status updated to <to_status>"`,
   `"<doc_type> uploaded"`) so each operation produces a distinguishable
   success toast. The action body reads the relevant FormData field
   server-side so the message reflects what was actually submitted (not
   a stale closure value).

3. **`resetOnSuccess` defaults to true; multipart upload form keeps the
   default** — the file input is uncontrolled, and after a successful
   upload the operator usually wants to start fresh for the next doc.
   Same logic for the note textarea, the transition forms (which carry
   amount/quote_id/note inputs), and the document edit form (where
   "Save changes" with the same fields would re-edit the just-saved
   doc — clearing prevents accidental double-edit).

4. **No `resetOnSuccess={false}` overrides anywhere** — none of the
   forms have a use case where keeping the just-submitted values
   visible is beneficial. The reset password card was the closest call
   (security smell to leave plaintext passwords in DOM after success),
   and remounting clears them.

5. **PASSWORD_MATCH_SCRIPT switched to event delegation** — the
   original script bound listeners to element references captured at
   parse time. After `<ActionForm>` remounts the form on success, the
   new inputs have no listeners and cross-field validation breaks
   silently. Event delegation on `document` survives remount because
   the listener resolves elements by ID at event time. This is a
   correctness fix tied directly to the pattern flip; not a separate
   refactor.

6. **`revalidatePath()` calls retained on success in every action** —
   the brief calls them out as still useful. They invalidate Next's
   route cache so when `<ActionForm>` calls `router.refresh()` the
   server-component data fetches fresh state. Without revalidatePath,
   the refresh might serve stale cached HTML and the operator would see
   no apparent change.

7. **Brief 18's diagnostic logging stays in damage actions** —
   `logActionEntry`/`logActionResult` are unchanged. Per Brief 18's
   outcome they're a follow-up cleanup, not Brief 19's job. Same for
   the `DcRoleDebugLine` on the detail page.

8. **The damage detail page still doesn't filter transitions by
   dcRole** — Brief 18 dropped the filter, Brief 19 doesn't restore it
   (out of scope: dcRole-null mystery is still open). The page
   continues to render every valid-from-current-status transition;
   worker re-validates on POST.

9. **PageProps shape change on sysadmin** — dropping the `searchParams`
   read meant the function signature became `()` rather than
   `({ searchParams })`. Removed the unused `PageProps` interface and
   `firstParam` helper rather than leaving dead code. Same shape is
   preserved on damage detail because the page still reads
   `confirm_delete_id` (a feature unrelated to action results).

### Latent issues / forward flags

- **Cross-origin dev (next dev) behavior unchanged** — `useActionState`
  + `router.refresh()` works the same in `next dev` as in production;
  no new dev-mode caveat introduced. Service bindings still fall back
  to URL-based fetch via the catch branch in `_lib/worker-fetch.ts`.

- **performance-worker submission form NOT migrated** — out of scope
  per brief §C and §Out-of-scope. That form uses Brief 6's
  redirect-then-success-banner via searchParam; the brief notes "works
  for it, leave alone unless operator reports the same symptom." If the
  operator hits the same redirect-doesn't-navigate issue on
  `/admin/performance`, file a follow-up brief and apply the same
  pattern flip there.

- **Pricing admin unchanged** — already uses client-side fetch +
  `setState`; the redirect-from-server-action issue doesn't apply.

- **Brief 18 cleanup brief grows** — should now also remove
  `[damage-action]` console.logs. Same as before. The cleanup is:
  (i) confirm dcRole populates, (ii) restore transition filter,
  (iii) remove DcRoleDebugLine, (iv) remove logActionEntry /
  logActionResult diagnostic logging.

- **`router.refresh()` is a soft refresh** — it re-fetches the route's
  server-component data but does not unmount/remount client components.
  Client islands like `PhotoLightbox` and `UserPicker` keep their
  internal state across a refresh; that's the intended behavior (the
  user's open lightbox or picker selection survives the underlying
  data update). No impact on damage detail or sysadmin in this brief —
  flagged here for awareness when designing future actions where you
  *do* want a hard reset.

- **ActionForm `data-pending` attribute** — exposed on the form
  element but not currently consumed by any styling. Future briefs can
  add `[data-pending="true"]` selectors to gray out submit buttons or
  show a spinner. No-op cost today (just an extra attribute write).

- **TypeScript inference on the ActionResult union** — clean.
  `useActionState`'s generic params resolve from the action signature;
  the result is typed as `ActionResult | null` automatically. Both the
  damage and sysadmin call sites pass the action directly without
  needing explicit type annotations. Verified by a clean `pnpm
  typecheck` (13/13).

- **No remaining redirect+searchParam UX in the codebase changed by
  this brief** beyond the two pages targeted. Performance-worker's
  submission form is the only other instance and it's intentionally
  left alone (see above). Login flow uses `redirect()` from a server
  action but that's a navigation by intent (move from /login to
  /admin/dashboard), not a post-action UX feedback redirect — pattern
  doesn't apply.

### Validation

- `pnpm typecheck`: **13/13 successful**, 4.4s wall (12 cached, 1
  cache miss for `@splash/web` after the source changes invalidated
  the turbo cache).
- `pnpm --filter @splash/web build`: **succeeded**, Next 15.5.15
  compiled in 4.3s, 12/12 static pages generated. No type errors, no
  lint failures.

### Bundle-size delta

| Route | Before (Brief 18) | After (Brief 19) | Delta |
|---|---|---|---|
| `/admin/damage/[id]` | 965 B / 106 kB | 1.33 kB / 106 kB | +365 B route / 0 First Load |
| `/admin/sysadmin` | 1.93 kB / 107 kB | 2.27 kB / 107 kB | +340 B route / 0 First Load |
| `/admin/damage` (list) | 167 B / 105 kB | 167 B / 105 kB | 0 |
| `/admin/dashboard` | 167 B / 105 kB | 167 B / 105 kB | 0 |
| `/admin/performance` | 1.85 kB / 107 kB | 1.85 kB / 107 kB | 0 |
| `/admin/pricing/[location]` | 3.65 kB / 109 kB | 3.65 kB / 109 kB | 0 |

The new `<ActionForm>` client island lands on both pages that import
it (~340-365 B route-chunk delta each). First Load JS is unchanged
because `useActionState`/`useRouter` were already in apps/web's vendor
bundle (used by `apps/web/app/login/form.tsx` and the existing client
islands).

### Will the visible-refresh problem actually be fixed?

Yes — by data flow:

1. Operator clicks a transition button -> `<ActionForm>`'s formAction
   wrapper dispatches `transitionAction(prevState, formData)` via
   `useActionState`.
2. The server action runs (worker call -> DB update), calls
   `revalidatePath("/admin/damage/<id>")` on success, and returns
   `{ ok: true, message: "Status updated to ..." }`.
3. The framework serializes the result back to the browser; React
   re-renders `<ActionForm>` with the new `result`.
4. The `useEffect` notices `result.ok === true` and calls
   `router.refresh()`.
5. `router.refresh()` sends a fetch to the same route URL with the
   `RSC` header, the server re-renders the page (the
   `revalidatePath` from step 2 ensures the data is fresh), and the
   new server-component output replaces the old one in-place.
6. The operator sees the new claim status in the summary card, the
   new activity row in the timeline, and any new transition buttons —
   without manual reload.

This is the same data flow that pricing admin achieves via direct
client `fetch()` + `setState`, just routed through Next's standard
server-action machinery instead of a worker JSON API. No reliance on
redirect-response propagation, which was the OpenNext-on-CF gap.
