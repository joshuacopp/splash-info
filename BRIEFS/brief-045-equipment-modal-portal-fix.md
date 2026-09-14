# Brief 45: Portal the EquipmentOverrideModal to fix nested-form bug

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Nothing.
**Dependencies:** Brief 43 (the modal this brief patches). Brief 43
landed the modal and worker plumbing; the worker side works
correctly when the modal's submit makes it through. Brief 45 fixes
the modal's submit reliability.

## Read first

- CLAUDE.md (Brief 19 ActionForm pattern + Brief 43 modal pattern)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-043-gm-equipment-related-modal-on-approve.md (the
  brief this patches — review the "Phase 2.4 — On modal submit"
  intent so the fix doesn't accidentally break the contract)
- apps/web/app/admin/damage/_components/EquipmentOverrideModal.tsx
  (the file with the bug)

## Context

Brief 43 shipped a working UI but the modal's submit reaches the
worker only ~1/5 times. Operator confirmed 2026-05-06: modal
opens, choice + equipment piece capture works, but clicking
Confirm only sometimes triggers the underlying transition POST.
The other ~4/5 attempts produce no transition write, just a
follow-up GET to `/manage/api/claim/{id}` (the page rerender's
SSR fetch).

The cause is the JSX layout in
`apps/web/app/admin/damage/_components/EquipmentOverrideModal.tsx`:

```jsx
<>
  <button ref={buttonRef} type="submit" ...>{label}</button>
  {open ? (
    <div role="dialog" ...>
      <form onSubmit={handleConfirm} ...>
        ...
      </form>
    </div>
  ) : null}
</>
```

`EquipmentOverrideSubmit` is rendered INSIDE the parent transition
`<form>` (so the outer submit button can find its form via
`submitButton.form` on line 93). The conditional modal block is a
sibling of the button under the React fragment. When `open === true`,
the modal's `<form onSubmit={handleConfirm}>` becomes a **nested
`<form>` inside the parent transition `<form>` in the actual DOM**,
which is invalid HTML.

Browser behavior with nested forms is implementation-defined.
Sometimes the inner form is detached/inert and events bubble
correctly to the outer form (the 1/5 success). Sometimes the
inner form's submit handler interferes with the outer form's
React useActionState dispatch and the action never runs (the 4/5
failure). The router.refresh-driven GET still fires on close
because `setOpen(false)` triggers a re-render that hits a
downstream `router.refresh()` — that's why we see ONLY the GET
in the failure case, not the transition POST.

Fix: render the modal's JSX through `createPortal` to `document.body`.
The modal DOM lives outside the parent form, so there's no
nested-form invalidity. The submit button (in the parent form) and
`form.requestSubmit(submitButton)` work consistently because
nothing in the DOM is fighting the submit pipeline.

## Scope

### Phase 1 — Portal the modal

1.1 Edit
`apps/web/app/admin/damage/_components/EquipmentOverrideModal.tsx`:

  - Add `import { createPortal } from "react-dom";` to the imports.
  - In the return statement, wrap the modal JSX block (the
    `<div role="dialog">...</div>` that's currently inside the
    `{open ? (...) : null}` conditional) in `createPortal(...)`
    targeting `document.body`. Guard for SSR.

  Concrete diff sketch:

  ```tsx
  return (
    <>
      <button
        ref={buttonRef}
        type="submit"
        disabled={!enabled}
        onClick={handleClick}
        className={submitButtonClass}
      >
        {label}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Equipment-related override"
              className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4"
              onClick={() => setOpen(false)}
            >
              <form
                onSubmit={handleConfirm}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-[480px] rounded-splash-lg bg-white p-6 shadow-splash-card"
              >
                {/* unchanged modal contents — heading, fieldset,
                    equipment piece select, Cancel/Confirm buttons */}
              </form>
            </div>,
            document.body
          )
        : null}
    </>
  );
  ```

  The contents of the modal's `<form>` (heading, fieldset, select,
  buttons) stay verbatim. Only the wrapping changes.

1.2 Verify the SSR guard works. `createPortal` on the server
throws if `document` is undefined. The `typeof document !==
"undefined"` check ensures the portal call only runs on the
client. Since this component is `"use client"` already, it
doesn't render on the server, but the conditional is defense in
depth — Next.js still does an initial render pass and we don't
want that to throw.

1.3 No other behavioral changes. Specifically:
  - `handleClick`, `handleConfirm`, `appendHiddenInput`,
    `EQUIPMENT_PIECE_OPTIONS`, the props interface — all
    unchanged.
  - The order in `handleConfirm` (set hidden inputs → setOpen(false)
    → requestSubmit) stays the same. The portal fix removes the
    DOM-level interference that was causing requestSubmit to
    miss; the React state ordering wasn't the bug.
  - `buttonRef` continues to point at the outer transition button,
    which still lives inside the parent transition form. Portal
    only moves the modal's DOM, not the button's.

### Phase 2 — Smoke test

2.1 After redeploying apps/web (CF Workers Builds will trigger on
push), the operator should:
  - Find a claim with `equipment_related === 0` in
    "Pending GM Review" status (or whichever state allows the
    "Approve — Pending Quotes" or "Approve — In House — Parts
    Ordered" transitions)
  - Click the approve button → modal opens
  - Click Yes → equipment piece dropdown reveals → select one
  - Click Confirm
  - Verify in damage-worker CF Observability that a POST/PATCH
    fired to the transition endpoint AND the claim's
    claim_status updated AND the activity log got two entries
    (status_change + maintainx_workorder_created)
  - Repeat 5 times to confirm consistency

2.2 If the smoke test still shows non-deterministic behavior
(e.g., 4/5 succeed instead of 5/5), the executor's Outcome
should flag this — there may be a SECOND interaction issue
beyond the nested forms (e.g., React 19 + useActionState +
requestSubmit edge case). Likely follow-up: replace
`form.requestSubmit(submitButton)` with `submitButton.click()`
guarded by a "skip-modal" flag to avoid re-entering handleClick.

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass for all 13 packages.
3.2 `pnpm --filter @splash/web build` — must succeed.
3.3 No worker-side changes; damage-worker is not redeployed by
this brief.

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 45 row added.

4.2 BUILD_STATE.md: Findings entry noting the nested-form bug
in Brief 43's executor output and the portal fix. Include a
note that future briefs adding a modal inside a parent form
should portal-by-default to avoid recreating this gotcha.

4.3 EquipmentOverrideModal.tsx: update the file's leading
comment block to mention the portal pattern (so a future reader
knows why createPortal is there and doesn't "simplify" it back
into the parent form).

## Out of scope

- Changing the worker-side handler. The worker code from
  Brief 43 is correct; the bug is purely client-side.
- Refactoring the broader transition form architecture
  (Brief 19's ActionForm pattern). Not needed.
- Replacing `requestSubmit` with `submitButton.click()` (only
  if Phase 2.2's smoke test still shows flakiness).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `EquipmentOverrideModal.tsx` uses `createPortal` to render the
  modal out of the parent form
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- Comment block at the top of the file explains the portal
  pattern
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)
- Outcome flags "operator must verify 5/5 submissions reach the
  worker after deploy"

## Report

- Files modified (just the one component file)
- Diff size (likely < 30 lines)
- Bundle-size delta (~zero — `createPortal` is already in
  react-dom)
- Validation results
- Any decisions made on the operator's behalf

## Outcome

**Files modified:**
- `apps/web/app/admin/damage/_components/EquipmentOverrideModal.tsx` — added
  `import { createPortal } from "react-dom";`, wrapped the
  `<div role="dialog">…</div>` block in
  `createPortal(<div …>…</div>, document.body)` with an SSR guard
  (`open && typeof document !== "undefined"`), and extended the leading
  comment block with a "Brief 45" paragraph explaining the portal
  rationale + a "Do not 'simplify' this back into the inline conditional —
  it will reintroduce the bug" warning so a future reader doesn't
  recreate the gotcha.
- `BRIEFS/INDEX.md` — added a Brief 45 row.
- `BUILD_STATE.md` — bumped "Last updated" to 2026-05-06 with a
  Brief-45 summary; added a Findings entry summarizing the fix,
  decisions, latent issues, and validation.
- `BRIEFS/brief-045-equipment-modal-portal-fix.md` — Status set to
  Completed, this Outcome section filled in.

**Files created:** none.

**Files deleted:** none.

**Diff size in `EquipmentOverrideModal.tsx`:** ~15 lines net (one new
import, the conditional shape change from `{open ? (…) : null}` to
`{open && typeof document !== "undefined" ? createPortal(…, document.body) : null}`,
plus a 16-line addition to the leading comment block describing the
portal rationale). Inner JSX of the dialog (heading, fieldset, select,
buttons, form contents) is unchanged verbatim per the brief's
"contents of the modal's `<form>` … stay verbatim. Only the wrapping
changes." Inner-block indentation is mildly inconsistent post-edit
(the `<form>` and descendants kept the original 10-space indent
while the wrapping `<div role="dialog">` is now 12 spaces inside the
`createPortal(…,` call) — left as-is per the brief's "only the
wrapping changes" guidance; re-indenting 90 lines would inflate the
diff for cosmetic-only reasons.

**Bundle-size delta on apps/web:** `/admin/damage/[id]` 4.11 kB →
4.15 kB (+0.04 kB) / First Load JS 109 kB unchanged. `createPortal`
is already in `react-dom`, so the delta is just the conditional shape
change. No other route bundles changed. No worker bundle changed
(damage-worker not modified).

**Decisions made on the operator's behalf:**

1. **No retreat to `submitButton.click()`** — Phase 2.2 lists this as
   a possible follow-up if the portal fix alone doesn't resolve the
   flakiness. Landed the portal-only fix per the brief's primary
   scope; if the operator's smoke test still shows non-determinism
   (e.g., 4/5 succeed instead of 5/5), Brief 46 can revisit. The
   brief's analysis predicts portal alone is sufficient because the
   React state ordering of `setOpen(false)` → `requestSubmit` was
   never the bug — the DOM-level nested-form interference was.

2. **Inner JSX indentation kept verbatim** — see "Diff size" above;
   the brief's diff sketch shows `{/* unchanged modal contents */}`
   so the inner block stayed exactly as Brief 43 left it. Cosmetic
   re-indent would balloon the diff with no behavioral or
   readability gain (TypeScript/JSX is whitespace-insensitive).

3. **No comment-block surgery beyond the new paragraph** — kept all
   of Brief 43's existing comments intact. The new paragraph is
   inserted as a logical block between the original "render BOTH the
   submit button and the modal" paragraph and the
   "EQUIPMENT_PIECE_OPTIONS hard-fork" paragraph, so reading top-
   to-bottom the document flows: 43's pattern intent → 45's portal
   amendment → 43's options-fork rationale.

**Latent issues / forward flags:**

- **Operator must verify 5/5 submissions reach the worker after the
  next apps/web CF Workers Builds deploy.** Headless cannot exercise
  the live browser interaction; only the operator can confirm the
  portal fix actually resolves the flakiness. The smoke test is
  spelled out in Phase 2.1 of this brief — find a claim with
  `equipment_related === 0` in "Pending GM Review", click approve
  → Yes → equipment piece → Confirm; verify CF Observability shows
  the transition POST/PATCH AND the claim's `claim_status` updated
  AND the activity log got two entries (`status_change` +
  `[maintainx]` `note`). Repeat 5 times.
- **Future modals rendered inside parent forms should portal-by-
  default** — recorded in BUILD_STATE.md's Findings entry as a
  forward flag. Any time a child component renders both a submit
  button (which has to live inside the parent form to be a
  submitter) AND a dialog containing its own form/event handlers
  (which need to NOT nest inside the parent form), portal the
  dialog DOM to `document.body` to avoid recreating this gotcha.
- **No worker-side or PA Parse JSON impact** — Brief 45 is purely a
  client-side DOM-positioning fix; the override-related FormData
  payload, the worker validation, and the activity-log shape are
  all unchanged from Brief 43.

**Validation results:**

- `pnpm typecheck` — 13/13 packages successful (4.11s, cache hit on
  12, fresh build on `@splash/web` only, as expected — only one
  package modified).
- `pnpm --filter @splash/web build` — succeeded; `next build`
  compiled in 5.9s, all 12 routes generated; `/admin/damage/[id]`
  route bundle 4.15 kB / 109 kB First Load JS.
- No worker rebuild attempted (damage-worker not modified per the
  brief's Phase 3.3).

**Operator must verify 5/5 submissions reach the worker after deploy.**
