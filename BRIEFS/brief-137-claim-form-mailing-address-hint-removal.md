# Brief 137: Claim form — drop mailing address hint, keep email hint

**Status:** Completed (2026-05-15)
**Started:** 2026-05-15
**Completed:** 2026-05-15
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

### Files modified

- `apps/damage-worker/src/render/claim-form.ts` — Phase 1.
  - Removed line 367 (the `<span class="hint">Where we'll mail
    claim correspondence and any approved payment.</span>` element)
    and collapsed the surrounding three-line label block to a
    single line matching the hint-less labels above and below.
  - Net diff: -2 lines (removed the hint span line + folded the
    closing `</label>` onto the same line as the label text).
- `BRIEFS/INDEX.md` — Phase 4.1: appended a Brief 137 row at the
  end of the main table just before the `**Folded items**`
  section.
- `BUILD_STATE.md` — Phase 4.2: bumped the line-3 `Last updated`
  summary to a fresh Brief 137 entry; inserted a new
  `Findings & decisions log` row at the top of the table (date
  2026-05-15) describing the change.
- `BRIEFS/brief-137-claim-form-mailing-address-hint-removal.md`
  — this file: Status flipped to `Completed (2026-05-15)`,
  Outcome filled in.

### Files created

None.

### The exact lines touched (per the Report section)

Before (lines 365–370 of `claim-form.ts` pre-edit):

```html
            <div class="form-group">
              <label for="mailingAddress">Mailing Address <span class="required">*</span>
                <span class="hint">Where we'll mail claim correspondence and any approved payment.</span>
              </label>
              <input type="text" id="mailingAddress" name="mailingAddress" required autocomplete="street-address">
            </div>
```

After (lines 365–368 of `claim-form.ts` post-edit):

```html
            <div class="form-group">
              <label for="mailingAddress">Mailing Address <span class="required">*</span></label>
              <input type="text" id="mailingAddress" name="mailingAddress" required autocomplete="street-address">
            </div>
```

The hint text removed verbatim (for audit):

> Where we'll mail claim correspondence and any approved payment.

The `customerEmail` hint at line 361 was confirmed unchanged:

> We'll email you a copy of this claim.

License Plate (line 373 post-edit) and Vehicle Color (line 394
post-edit, in its own form-row outside this form-group) labels
were not touched — both already hint-less per Brief 135.

### Decisions made on the operator's behalf

- **Single-line label format.** With the hint removed, the
  mailing-address label was collapsed from three lines to one,
  matching the surrounding hint-less labels (e.g.,
  `<label for="customerName">Your Name <span class="required">*</span></label>`).
  Leaving it as a three-line block with an empty middle line
  would have been visually weird in the source and produced
  identical HTML output. The brief said "Remove the
  `<span class="hint">` element entirely" without specifying the
  re-formatting; the natural choice was to make it look like
  every other hint-less label in the file.
- **Build verification via `wrangler deploy --dry-run`.** The
  damage-worker package has no `build` script (its `scripts`
  block is `dev`/`deploy`/`typecheck`/`lint`/`clean`), so
  `pnpm --filter @splash/damage-worker build` returns "None of
  the selected packages has a build script." This is the same
  posture every Cloudflare Worker in the monorepo has — wrangler
  bundles at deploy time, no separate build step. I substituted
  `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run`
  as the equivalent bundle-validation gate — this is the same
  substitution Briefs 135 and 136 used (their INDEX.md entries
  cite `wrangler deploy --dry-run` rather than a `build` script).
  Output: 1740.07 KiB raw / 394.66 KiB gzip — essentially flat
  vs Brief 136's 1740.19 KiB / 394.69 KiB baseline (net -2 lines).
  The `--dry-run` flag does NOT touch Cloudflare — confirmed by
  the "--dry-run: exiting now." line in stdout.

### Latent issues found

None. The change is purely subtractive UX polish on the
customer-facing claim form. No worker logic, no Supabase, no R2,
no D1, no wrangler.toml, no secrets touched. The Email Address
hint was verified unchanged at line 361 (confirming Brief 135 did
not regress it).

### Validation results

- `pnpm typecheck`: **18/18 tasks successful** (17 cached, 1
  fresh — `@splash/damage-worker` ran fresh because the file
  changed; output `tsc --noEmit` clean).
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir .wrangler/dry-run`:
  **succeeded**. Bundle 1740.07 KiB / 394.66 KiB gzip. All seven
  bindings resolved (D1 `splash-damage-claims`, R2 `damagedocs`,
  Images, plus four `[vars]`: `MAINTAINX_MODE` / `MAINTAINX_BASE_URL`
  / `APPS_WEB_BASE_URL` / `INCIDENTS_EMAIL`). The `--dry-run`
  exited cleanly without touching Cloudflare.
- Phase 3.3 confirmed: no worker / Supabase / R2 / wrangler.toml /
  secret changes.
- Phase 3.4 operator post-deploy smoke deferred to operator (per
  the brief).
