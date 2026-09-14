# Brief 130: Roll out <SubmitButton> across every <ActionForm> surface

**Status:** Drafted (not yet queued — hold until next push cycle)
**Started:** —
**Completed:** —
**Blocks:** Neither — UX polish + multi-click-prevention rollout.
The reference impl shipped via the Brief 127-era hotfix (the new
`apps/web/app/admin/_components/SubmitButton.tsx` + its use on
`/admin/forms/new`); this brief propagates the same swap to every
remaining `<ActionForm>`-driven form across apps/web.
**Dependencies:** None. `<SubmitButton>` and `<ActionForm>` already
exist in `apps/web/app/admin/_components/`.

## Read first

- CLAUDE.md (apps/web "Server actions: useActionState +
  router.refresh()" section — Brief 19 pattern)
- apps/web/app/admin/_components/ActionForm.tsx (Brief 19 —
  unchanged here; its `useActionState` already exposes `isPending`
  via React 19's transition machinery)
- apps/web/app/admin/_components/SubmitButton.tsx (the reference
  implementation — client component using `useFormStatus()`,
  renders disabled state + spinner + label swap automatically)
- apps/web/app/admin/forms/new/page.tsx (the reference call site —
  the model every other swap should mirror)

## Context

The Brief 19 `<ActionForm>` pattern wraps every server-action form
in apps/web. The pattern works correctly — the action dispatches,
the result renders inline, `router.refresh()` re-fetches data — but
the submit button itself gives no visible feedback during the
request. Operators clicking "Save" / "Approve" / "Create" / "Send"
see the page sit still for ~0.5-3s while the server-action POST
completes. Visible pending state is missing, which:

1. Confuses operators ("nothing happened, did I miss it?")
2. Risks multi-click double-submits when the action is idempotent
   at the worker layer (most cases) but logs a duplicate audit
   entry / fires a duplicate webhook before the second click is
   no-op'd.
3. Reads as a bug to anyone benchmarking the system against
   modern SaaS UX.

The Brief 127-era hotfix added a shared `<SubmitButton>` client
component that uses React 19's `useFormStatus()` hook to read the
parent form's pending state, disables the button + sets
`aria-busy="true"` + swaps the label to a configurable
`pendingText` + renders a small spinning SVG. The reference call
site is `/admin/forms/new`.

This brief rolls the same swap out to every remaining
`<ActionForm>` surface. Pure UX polish — no schema changes, no
worker changes, no behavior changes beyond visible pending state +
disabled-during-submit.

## Scope

### Phase 1 — Identify every call site

Grep for `<button type="submit"` inside files that import
`ActionForm` from `app/admin/_components/ActionForm`:

```bash
grep -rl "from \".*ActionForm\"" apps/web/app
```

Expected hits (verify against current code state; some may have
already been replaced since this brief was drafted):

- `apps/web/app/admin/sysadmin/page.tsx` — 5 cards (Create user,
  Set role, Grant tool, Revoke tool, Reset password) + the Brief
  30 Add Location / Update Package / Update Location cards + the
  Brief 61 Set DC Role card. Each card's `<form>` has a primary
  submit button.
- `apps/web/app/admin/damage/[id]/page.tsx` — multiple `<ActionForm>`
  blocks: add note, status transition (per-transition button on
  the activity log row), document upload, check request preview /
  finalize.
- `apps/web/app/admin/damage/[id]/_components/*` — supporting
  components (document edit details, etc.) may have their own
  ActionForms.
- `apps/web/app/admin/fleet/[id]/page.tsx` — Brief 87 + Brief 105
  Status & Splash Notes ActionForm (single Save button driving
  both fields).
- `apps/web/app/admin/forms/[id]/submissions/[subId]/page.tsx` —
  Brief 96 status + splash notes + Brief 120 workflow transition
  modal buttons.
- `apps/web/app/admin/forms/[id]/submissions/[subId]/_components/WorkflowSection.tsx`
  (or similar Brief 120 transition action component).
- `apps/web/app/admin/email-queue/[id]/page.tsx` — Brief 128
  Retry now + Abandon buttons (once Brief 128 ships).
- `apps/web/app/admin/forms/[id]/_workflow/*` — any Brief 125
  workflow editor save / publish surfaces using ActionForm.
- `apps/web/app/admin/forms/_components/*` — any list-page action
  forms (delete / archive surfaces — confirm if present).

Run the grep, confirm the actual list against the current code,
discard any already-converted (the create-form page reference is
already done).

### Phase 2 — Mechanical swap per file

For each identified `<button type="submit">` inside an
`<ActionForm>`:

1. Add the import at the top of the file:
   ```tsx
   import { SubmitButton } from "...PATH.../admin/_components/SubmitButton";
   ```
   The exact relative path depends on the file's depth — three
   `../` up from `_components/X.tsx`, four `../` up from
   `[id]/_components/X.tsx`, etc.

2. Replace the button:
   ```tsx
   // Before:
   <button type="submit" className="...">
     Save
   </button>

   // After:
   <SubmitButton
     pendingText="Saving…"
     className="... disabled:cursor-not-allowed disabled:bg-splash-blue/60"
   >
     Save
   </SubmitButton>
   ```

3. Pick a contextual `pendingText`:
   - Submit-noun verbs: "Saving…" / "Creating…" / "Updating…" /
     "Posting…" / "Sending…" / "Uploading…" / "Approving…" /
     "Denying…" / "Retrying…" / "Abandoning…" / "Publishing…"
   - Default if uncertain: just use "Working…" (the component
     default).

4. **Preserve every existing className token** from the original
   button. The disabled-state styling tokens (`disabled:cursor-not-allowed`
   + a faded background like `disabled:bg-splash-blue/60` for blue
   primary buttons, or `disabled:bg-splash-deny/60` for red/danger
   buttons) get appended.

### Phase 3 — Multi-button forms

A few ActionForms have multiple submit buttons (e.g., damage
transitions render N buttons in a list, one per valid-from-status
transition; sysadmin has cards with both a primary "Submit" and a
secondary inline action). For each form:

- Every `<button type="submit">` inside the same `<form>` shares
  the form's pending state — clicking any one of them disables ALL
  of them via the same `useFormStatus()` hook. That's the right
  behavior (operator clicks Approve → can't accidentally click Deny
  before Approve completes).
- For lists of transition buttons: keep them as a row of
  `<SubmitButton>` instances. Each picks its own `pendingText`
  based on its label.
- For "Save" + "Cancel" pairs: the Cancel link is NOT a submit
  button (it's a `<Link>` to a different route). Leave it alone.

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass.
4.2 `pnpm --filter @splash/web build` — must succeed.
4.3 No worker / Supabase / R2 / wrangler.toml / secret changes.
4.4 Operator post-deploy smoke (deferred):
    - Open `/admin/sysadmin`. Trigger any action card's submit.
      Button visibly disables + spinner + label flips to the
      contextual pendingText. Sibling buttons in the same card
      also disable.
    - Open `/admin/damage/[id]`. Add a note → "Posting…". Click a
      transition → that button shows pendingText, all other
      transitions disable. Result renders inline. Page refreshes.
    - Open `/admin/fleet/[id]`. Edit status + notes → click Save
      → "Saving…".
    - Open `/admin/forms/[id]/submissions/[subId]`. Status + notes
      → Save → "Saving…". Workflow transition → "Approving…".
    - Open `/admin/email-queue/[id]` (once Brief 128 ships). Retry
      / Abandon buttons get the same treatment.
    - Negative test: try double-clicking a submit button —
      second click is no-op (disabled).
    - Accessibility: keyboard nav + screen reader announces
      `aria-busy="true"` while submitting.

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 130 row appended.

5.2 BUILD_STATE.md: Findings entry noting:
  - Brief 130 (YYYY-MM-DD) — `<SubmitButton>` rolled out across
    every `<ActionForm>` call site in apps/web. Every server-
    action button now shows disabled state + spinner + contextual
    pendingText during submit. Prevents multi-click double-submits;
    matches modern SaaS UX expectations.

5.3 CLAUDE.md `Server actions: useActionState + router.refresh()`
section: append a one-liner directing future writers to use
`<SubmitButton>` (not bare `<button type="submit">`) inside any
`<ActionForm>`. Reference the SubmitButton.tsx file path.

## Out of scope

- Refactoring `<ActionForm>` itself. The component already exposes
  `data-pending` on the form element; the new `<SubmitButton>`
  consumes the same pending state via `useFormStatus()`. No
  changes needed.
- Adding pending state to NON-ActionForm forms (e.g., the pricing
  client component which uses raw `fetch()` + `setState` — Brief 95
  pattern). Those have their own pending state handling.
- Adding global page-load / route-transition spinners. This brief
  is scoped to per-submit feedback only.
- Changing the spinner SVG, label patterns, or button color tokens
  beyond the Tailwind classes already in use.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- Every `<button type="submit">` inside an `<ActionForm>` replaced
  with `<SubmitButton>` carrying a contextual `pendingText`.
- Every replaced button preserves its prior `className` tokens
  plus the disabled-state additions.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 5.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate (line count + file count).
- Validation results.
- The full list of files touched (helpful for a sanity check —
  the grep-derived list at Phase 1 plus anything else discovered
  during the swap).
- Any ActionForm call sites that DIDN'T fit the mechanical swap
  pattern (e.g., custom button rendering that needed a different
  approach) — flag with context so a fast-follow can address.

## Outcome

(To be filled in by the executor.)
