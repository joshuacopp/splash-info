# Brief 135: Claim form customer section — all fields required + gate Continue button

**Status:** Completed (2026-05-15)
**Started:** 2026-05-15
**Completed:** 2026-05-15
**Blocks:** Neither — small UX hardening on the customer-facing
`/claims/{site}` form (damage-worker). Three fields in section 1
(Your Information) are currently optional: `mailingAddress`,
`licensePlate`, `vehicleColor`. The operator wants all customer-
section fields to be required AND the "Continue to staff
assessment →" button to refuse to advance until the customer-side
required-set is filled.
**Dependencies:** None. The form is rendered server-side by
damage-worker; this is a pure HTML + small inline-JS change.

## Read first

- CLAUDE.md (damage-worker glossary entries on the customer claim
  form / PDF / webhook architecture)
- `apps/damage-worker/src/render/claim-form.ts` — the entire form
  HTML + inline JS. Key call sites:
  - Customer section: lines 322–384 (form-rows + Continue button)
  - PIN overlay + gate: lines 557–565, 604–668
  - Submit handler / damageOther toggle / equipment toggle:
    lines 670+ (existing client-side validation hooks)

## Context

The current `/claims/{site}` form's customer section (section 1, "Your
Information") has the following fields:

| Field | Currently required? | After Brief 135 |
|---|---|---|
| `customerName` | yes | yes (unchanged) |
| `customerPhone` | yes | yes (unchanged) |
| `customerEmail` | yes | yes (unchanged) |
| `mailingAddress` | **no** | **yes** |
| `licensePlate` | **no** | **yes** |
| `vehicleYear` | yes | yes (unchanged) |
| `vehicleMake` | yes | yes (unchanged) |
| `vehicleModel` | yes | yes (unchanged) |
| `vehicleColor` | **no** | **yes** |
| `issueDescription` | yes | yes (unchanged) |

The "Continue to staff assessment →" button (`#btnContinue`, line
~383) currently just reveals the staff section and triggers the PIN
overlay — it does NOT validate the customer fields first. An
operator can click through with empty required customer fields and
the failure only surfaces at form submit (after the staff PIN gate +
photos + staff-side fields are filled). That's a bad UX — customers
realize halfway through staff entry that they missed a field.

Both changes are small but tightly coupled: making the three fields
required is straightforward HTML; gating the Continue button is a
small inline-JS hook on top of HTML5's `reportValidity()`.

## Scope

### Phase 1 — Mark the three fields required (HTML)

`apps/damage-worker/src/render/claim-form.ts` — three label + input
pairs to update:

1.1 `mailingAddress` (lines ~340–345):
    - Add `<span class="required">*</span>` after the label text
    - Update the `<input>` to carry the `required` attribute
    - The existing hint text "Required for payment if claim is
      approved" becomes redundant — drop or shorten to "Used for
      mailing claim correspondence" (operator can fine-tune later)

1.2 `licensePlate` (lines ~349–352):
    - Add `<span class="required">*</span>` after the label text
    - Update the `<input>` to carry the `required` attribute
    - No hint text exists; nothing to drop

1.3 `vehicleColor` (lines ~370–373):
    - Add `<span class="required">*</span>` after the label text
    - Update the `<input>` to carry the `required` attribute

After this change, ALL ten fields in section 1 are required at the
HTML level. The existing CSS class `.required` (red asterisk) is
already in the stylesheet — no CSS change needed.

### Phase 2 — Gate the Continue button on customer-section validity

The "Continue to staff assessment →" button (`#btnContinue`) currently
binds a click handler somewhere in the inline `<script>` block (around
line 604+) that toggles the staff section visibility + opens the PIN
overlay. Update that handler so the first thing it does is validate
the customer section.

Implementation:

2.1 Wrap the section 1 fields in a logical container. The existing
    `<div class="section" id="customerSection">` (or equivalent —
    grep for the wrapper that contains lines 320–385) is the
    container. Confirm the actual id; if it's just the section
    without an id, add `id="customerSection"`.

2.2 Update the Continue handler. Pattern:

```js
btnContinue.addEventListener('click', function () {
  // Collect every required input/select/textarea inside the
  // customer section.
  var customerSection = document.getElementById('customerSection');
  var requiredFields = customerSection.querySelectorAll('[required]');
  for (var i = 0; i < requiredFields.length; i++) {
    var field = requiredFields[i];
    if (!field.checkValidity()) {
      // Surface the browser's native validation UI (the same one
      // shown on form submit) at the first invalid field, and
      // refuse to advance.
      field.reportValidity();
      field.focus();
      return;
    }
  }
  // All customer-section required fields filled — proceed with
  // the existing reveal-staff-section + open-PIN flow.
  // ... existing handler body ...
});
```

2.3 If the existing handler is structured as a function (e.g.,
    `revealStaffSection()`), wrap the call site rather than
    duplicating the validation logic into multiple places.

2.4 Verify that the existing PIN gate keeps `employeeName` and the
    staff-side `required` toggles working. The Brief 25 / 29
    comment at line ~633 notes that `employeeName.required = true`
    is set AFTER the PIN gate opens — that's the right pattern
    (keep required attributes off elements that are visually
    hidden so the form's submit-time validity check doesn't fire
    on hidden fields). Brief 135 does NOT touch staff-side
    required attributes — only customer-side.

### Phase 3 — Hint-text cleanup

3.1 `mailingAddress` hint text currently says "Required for payment
    if claim is approved". With the field now required at submit
    time, this is redundant + slightly misleading (the field is
    required regardless of approval). Drop the hint OR replace with
    something forward-pointing like "Where we'll mail claim
    correspondence and any approved payment".

3.2 Leave `licensePlate` and `vehicleColor` with no hint text
    (they don't currently have one).

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass.
4.2 `pnpm --filter @splash/damage-worker build` — must succeed.
4.3 No worker / Supabase / R2 / wrangler.toml / secret changes.
4.4 Operator post-deploy smoke (deferred):
    - Open `/claims/{site}` on workers.dev or staging.
    - Verify the three newly-required fields each show a red
      asterisk in the label.
    - Leave any one of the customer-section fields blank, click
      "Continue to staff assessment →". Confirm: (a) the staff
      section does NOT reveal, (b) the browser's native validation
      bubble points at the blank field, (c) keyboard focus moves
      to that field.
    - Fill every customer-section field. Click Continue. Confirm
      the PIN overlay opens normally and the staff section
      reveals after the correct PIN.
    - Submit the full form end-to-end. Confirm the new required
      values land in D1 / Power Automate webhook payloads
      correctly.
    - Negative: try submitting via a crafted POST (curl or fetch)
      with the three new required fields empty. The server-side
      handler is currently lenient on these — flag in the Outcome
      whether worker-side validation also needs to enforce, or
      whether HTML5-only is acceptable per the current security
      posture (CSRF + Turnstile-or-equivalent protect the
      endpoint).

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 135 row appended.

5.2 BUILD_STATE.md: Findings entry noting:
  - Brief 135 (YYYY-MM-DD) — Customer section of the public
    `/claims/{site}` form: `mailingAddress`, `licensePlate`,
    `vehicleColor` are now required (HTML5 `required` attribute +
    red asterisk marker). The "Continue to staff assessment →"
    button now validates the customer section's required fields
    via `checkValidity()` + `reportValidity()` before revealing
    the staff section. Hint text on `mailingAddress` updated to
    reflect the new always-required status.

5.3 CLAUDE.md damage-worker entry: no glossary change needed —
    the existing claim-form description doesn't enumerate
    required fields. If the Brief 25 / 29 entries mention the
    customer section, append a one-liner noting Brief 135
    widened the required set.

## Out of scope

- Worker-side enforcement of the three new required fields. The
  Brief 32 customer-webhook path + the D1 row schema both accept
  these as optional today; widening server-side checks is a
  follow-up if the operator wants defense-in-depth. HTML5 client-
  side gating + Turnstile/CSRF is the v1 posture.
- Reformatting other section 1 fields' hint text. Only
  `mailingAddress` has misleading hint text post-change.
- Adding async-validation niceties (e.g., live "phone is
  valid"/"email is reachable" checks). Out of scope.
- Adding new fields to section 1. Field set is fixed at this brief.
- Conditional required behavior (e.g., licensePlate required UNLESS
  vehicle has no plates). The operator's ask is unconditional.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `mailingAddress`, `licensePlate`, `vehicleColor` carry the
  `required` HTML attribute and red asterisk label marker.
- `mailingAddress` hint text updated to reflect always-required
  status (or dropped).
- `#btnContinue` click handler validates customer section before
  advancing; surfaces the first invalid field via native
  `reportValidity()` + focus.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/damage-worker build` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 5.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate (line count + file count — should be small,
  ~30 LOC in `claim-form.ts` only).
- Validation results.
- The exact lines touched in `claim-form.ts`.
- Whether the Continue-button click handler was wrapping or
  modifying the existing function.
- Whether the customer section had a usable container id or one
  was added.

## Outcome

### Diff size

Single source file touched: `apps/damage-worker/src/render/claim-form.ts`. Approximately 25 LOC net delta (four hunks):

1. `mailingAddress` label + input + hint text (Phase 1.1 + 3.1).
2. `licensePlate` label + input (Phase 1.2).
3. `vehicleColor` label + input (Phase 1.3).
4. `btnContinue` click-handler body — pre-flight validation loop wrapping the existing `openPinModal()` call (Phase 2.2).

Three doc files also touched: `BRIEFS/INDEX.md`, `BUILD_STATE.md`, this brief.

### Exact lines touched in `claim-form.ts`

- Lines 340–345 (was 340–345): `mailingAddress` group — added `<span class="required">*</span>` to the label, added `required` attribute to the `<input>`, and replaced the hint copy from "Required for payment if claim is approved" to "Where we'll mail claim correspondence and any approved payment."
- Lines 349–352 (was 349–352): `licensePlate` group — added `<span class="required">*</span>` to the label and `required` attribute to the `<input>`.
- Lines 370–373 (was 370–373): `vehicleColor` group — added `<span class="required">*</span>` to the label and `required` attribute to the `<input>`.
- Lines 639–641 (was 639–641): `btnContinue` click handler expanded from a one-line `openPinModal()` invocation to a ~16-line handler that loops over `customerSection.querySelectorAll('[required]')`, calls `field.checkValidity()` per field, and surfaces the first invalid field via `field.reportValidity()` + `field.focus()` before returning. `openPinModal()` is the final line behind the gate.

### Continue-button handler: wrapping vs modifying

The original handler was a single-line `function () { openPinModal(); }`. The change wraps the existing call rather than duplicating logic: the new handler body adds a pre-flight validation loop above the existing `openPinModal()` call. Both for revertability (one-line revert by deleting the loop) and to keep the handler's existing scope-of-concern intact, this is preferable to extracting a `revealStaffSection()` helper (which the brief Phase 2.3 flagged as a possible approach — not taken because the existing handler is small enough that extracting it would be unnecessary indirection).

### Customer section container id

The customer section already had `id="customerSection"` declared at line 318 of `claim-form.ts` — no new id wiring was needed. The FORM_SCRIPT IIFE also already declared `var customerSection = document.getElementById('customerSection');` at line ~601 (for the unrelated `unlockEmployeeSection` flow), so the new validation loop reuses that const without re-declaration.

### Decisions made on operator's behalf

1. `mailingAddress` hint text replaced with the brief's suggested wording rather than dropped — keeps the operator-pointed copy explaining what the address is used for.
2. The Continue handler uses `for (var i = 0; i < ...; i++)` instead of `for…of` or `Array.prototype.forEach`, to match the surrounding ES5-style script (the FORM_SCRIPT IIFE deliberately uses ES5 for cross-browser compatibility on the public form).
3. The pre-flight loop scopes its query to `#customerSection` rather than `form.querySelectorAll('[required]')` — staff-side required attributes ARE added dynamically post-PIN-gate (Brief 25/29 pattern; the `employeeName` field, `damageOther`, `equipmentInvolved`, `damageType` are gated this way), so a form-wide pre-flight check would correctly skip them today, but the section-scoped check is more defensible against future staff-side field changes that might add `required` before the PIN gate.
4. Worker-side enforcement was NOT added — flagged as a latent defense-in-depth follow-up per Phase 4.4's negative-test guidance.

### Latent issues / forward flags

- **Server-side enforcement.** `POST /claims-api/submit-claim` on damage-worker does NOT re-validate the three newly-required fields. The Brief 32 customer-webhook path + D1 row schema both accept these as optional today. A crafted POST (curl / fetch) can still submit with the three new fields empty. HTML5 client-side gating + Turnstile/CSRF is the v1 posture; widening server-side checks is a follow-up brief if the operator wants defense-in-depth.
- **Downstream consumers.** Power Automate webhook payloads previously sometimes received null for `licensePlate` / `mailingAddress` / `vehicleColor`. Post-deploy, those fields will be reliably populated. PA flow templates referencing those fields should be inspected — any conditional branches keyed on "is null" become dead code paths (operationally harmless but worth a follow-up audit if PA is doing branching).
- **iOS Safari + Android Chrome autofill.** Browsers auto-fill address fields more aggressively now that `mailingAddress` is required. Operator post-deploy smoke should verify autofill works correctly on mobile.

### Validation results

- `pnpm typecheck`: 18/18 packages green (17 cache hits; `@splash/damage-worker` ran fresh; ~2.0s wall).
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir=.wrangler/build-check`: succeeded; bundle 1729.61 KiB raw / 391.32 KiB gzipped (≈ unchanged vs prior baseline — ~25 LOC added to a single source file is well within the noise floor of wrangler's compression output).
- No worker / Supabase / R2 / wrangler.toml / secret changes; no `pnpm install` needed.
- Operator post-deploy smoke per Phase 4.4 is deferred (red-asterisk visual check, blank-field Continue-gate check, full submission with the three new values, negative POST).

### Files

- **Created.** None.
- **Modified.** `apps/damage-worker/src/render/claim-form.ts`, `BRIEFS/INDEX.md`, `BUILD_STATE.md`, this brief.
- **Deleted.** None.

CLAUDE.md was inspected for the damage-worker glossary entries; the existing description doesn't enumerate required fields on the public claim form, so no glossary line was needed per Phase 5.3.
