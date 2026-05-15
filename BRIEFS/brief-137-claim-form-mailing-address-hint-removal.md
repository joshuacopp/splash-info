# Brief 137: Claim form — drop mailing address hint, keep email hint

**Status:** Ready for Claude Code
**Started:** —
**Completed:** —
**Blocks:** Neither — one-line follow-up to Brief 135. Brief 135's
Phase 3 left the hint-text decision as "drop OR replace"; the
executor went with replace. Operator now explicitly wants the
mailing address hint removed entirely. The `customerEmail` hint
("We'll email you a copy of this claim.") stays — it explains a
post-submit side effect the customer might not otherwise expect.
**Dependencies:** None. Brief 135 shipped 2026-05-15.

## Read first

- `apps/damage-worker/src/render/claim-form.ts` —
  - `customerEmail` label + hint (lines ~335–338, pre-Brief-135
    line numbers — confirm current state)
  - `mailingAddress` label + hint (lines ~340–345 pre-Brief-135;
    Brief 135 may have shifted line numbers slightly)

## Context

Brief 135 made `mailingAddress`, `licensePlate`, and `vehicleColor`
required on the customer-section. Phase 3 of that brief addressed
the hint-text drift on `mailingAddress` ("Required for payment if
claim is approved" → no longer accurate post-Brief-135), and gave
the executor two options:

- Drop the hint
- Replace with forward-pointing copy

Operator's preference now landed: drop entirely. Rationale: no need
to explain why Splash is collecting the field. The asterisk + the
form's overall context (it's a damage-claim form) makes the
mailing-address ask self-evident.

The `customerEmail` hint ("We'll email you a copy of this claim.")
stays unchanged because it explains a behavior the customer wouldn't
otherwise expect (post-submit email with a PDF copy — Brief 32).

## Scope

### Phase 1 — Drop the mailing address hint

`apps/damage-worker/src/render/claim-form.ts`, in the
`mailingAddress` label block:

- Remove the `<span class="hint">...</span>` element entirely
- Leave the label text + required asterisk untouched
- Whatever wording Brief 135's executor settled on for the hint
  (whether the suggested "Where we'll mail claim correspondence
  and any approved payment" or some variant) is the deletion
  target — confirm by reading the current state of the file
  before editing

### Phase 2 — Verify the email hint stays

`apps/damage-worker/src/render/claim-form.ts`, in the
`customerEmail` label block:

- Confirm the existing `<span class="hint">We'll email you a copy
  of this claim.</span>` is unchanged
- If Brief 135 inadvertently touched it, restore the original copy

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass.
3.2 `pnpm --filter @splash/damage-worker build` — must succeed.
3.3 No worker / Supabase / R2 / wrangler.toml / secret changes.
3.4 Operator post-deploy smoke (deferred):
    - Open `/claims/{site}`. Visual check on customer section:
      - Mailing Address label has red asterisk, NO hint underneath
      - Email Address label has red asterisk AND the "We'll email
        you a copy of this claim." hint underneath
      - License Plate + Vehicle Color labels have red asterisk,
        NO hint (unchanged from Brief 135)

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 137 row appended.

4.2 BUILD_STATE.md: Findings entry noting:
  - Brief 137 (YYYY-MM-DD) — Dropped the mailing-address hint
    text on the customer-facing claim form. Email-address hint
    ("We'll email you a copy of this claim.") preserved as it
    explains a behavior the customer wouldn't otherwise expect
    (post-submit PDF email). One-line follow-up to Brief 135's
    Phase 3.

4.3 No CLAUDE.md change needed.

## Out of scope

- Touching any other hint text on the form.
- Anything else.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- The `<span class="hint">` element under the Mailing Address
  label is removed.
- The `<span class="hint">` element under the Email Address label
  is unchanged.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/damage-worker build` succeeds.
- BRIEFS/INDEX.md + BUILD_STATE.md updated per Phase 4.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- The exact lines touched.
- The hint text that was removed (verbatim — for audit).

## Outcome

(To be filled in by the executor.)
