# Brief 47: Trim staff assessment in customer PDF + rename "Customer told" → "Splash Response"

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Power Automate webhook setup for `CUSTOMER_CLAIM_WEBHOOK_URL`
(operator paused that on 2026-05-06 to land this PDF cleanup
first; better to wire the email to a clean PDF than retroactively
trim later).
**Dependencies:** None. Touches only the customer-facing PDF
generator.

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-032-claim-summary-pdf-and-customer-email.md (the
  PDF generator's original brief)
- BRIEFS/brief-035-claim-pdf-drop-photos-and-code.md (the prior
  PDF trim — Brief 47 follows the same surgical-edit pattern)
- BRIEFS/brief-036-test-batch-pdf-humanize-mobile-upload-multi-pkg.md
  (the humanizeLabel helper landed here; reuse it if a label
  needs humanizing)
- BRIEFS/brief-041-claim-form-damage-type-selector.md (the
  damage_type column lives on claims now; this brief decides it
  does NOT belong in the customer PDF — operator-confirmed
  2026-05-06)
- apps/damage-worker/src/render/claim-summary-pdf.ts (the file
  to edit)

## Context

Operator review of the customer-facing PDF on 2026-05-06: the
staff assessment block currently surfaces too much. The customer
doesn't need to see equipment-related metadata — that's internal
routing info for the maintenance team. The customer-facing PDF
should be a polite confirmation of what was filed and what
Splash's response was.

Operator-specified staff assessment block (the entire section,
exhaustive):

1. **Staff name** (the employee who took the claim — `submitted_by`)
2. **Determination** (`no_responsibility` / `requires_gm_review`
   / `customer_get_quotes`, humanized via the existing label
   helper)
3. **Splash Response** — RENAMED from "What the customer was
   told." Source field: `customerTold` / `customer_told`
   (whatever the worker wrote into the claim row from the form
   field of the same name). The label change is for the
   customer-facing PDF only; internal admin UI keeps the
   original label.

Anything else currently in that section gets dropped — including
but not limited to: `equipment_related`, `equipment_piece`,
`damage_type`, `damage_other`, `preexisting_damage`,
`customer_demeanor`. Customer doesn't need any of these on
their copy.

## Scope

### Phase 1 — Locate and trim the staff assessment block

1.1 Open `apps/damage-worker/src/render/claim-summary-pdf.ts`.
Find the section that renders the staff assessment. It should
be marked by a heading or sub-heading like "Staff Assessment"
or rendered alongside `equipment_piece` / `determination` /
`customerTold`. Search for `customerTold` / `customer_told`
to land in the right place.

1.2 Strip the section down to exactly three rows, in this
order:

  - Submitted by (`submitted_by`)
  - Determination (humanized; e.g., `customer_get_quotes` →
    "Requested Customer Get Quote(s)")
  - Splash Response (`customer_told`; render the customer's
    actual text, NOT humanized — it's free-form)

  Use the same row-rendering helper Brief 32 established
  (likely `renderRow(label, value)` or similar). Don't fork a
  new helper.

1.3 Remove everything else from the section. Specifically delete
any rows for: `equipment_related`, `equipment_piece`,
`damage_type`, `damage_other`, `preexisting_damage`,
`customer_demeanor`. If the rendering uses a `for`-loop over a
field-array, replace the array with the three-element shortlist
above.

1.4 If a "Splash Response" row's value is empty (the operator
left `customerTold` blank during intake), render `—` (em-dash)
instead of an empty string — same fallback pattern Brief 32
uses for null fields.

### Phase 2 — Internal admin UI is unchanged

2.1 Do NOT modify
`apps/web/app/admin/damage/[id]/page.tsx`. The manager detail
page keeps showing everything (equipment fields, damage type,
pre-existing damage, customer demeanor) under its own
"Staff Assessment" section. This is internal-facing; managers
need the full picture. The label "What was the customer told?"
on the admin page also stays — only the customer PDF gets the
"Splash Response" rename.

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass for all 13 packages.
3.2 `pnpm --filter @splash/damage-worker build` — must succeed.
3.3 No worker-side endpoint or DB-shape change. Bundle-size
delta should be slightly negative (lines removed).

### Phase 4 — Smoke test guidance (operator)

4.1 After damage-worker auto-redeploys (CF Workers Builds on
push, watch path is `apps/damage-worker/**` per the corrected
config), submit a test claim against any location with a fake
customer email. The "Download a copy (PDF)" link in the
post-submit outcome card should produce a PDF whose Staff
Assessment block has exactly three rows: Submitted by,
Determination, Splash Response.

4.2 Verify the admin detail page still shows the full
assessment (equipment, damage type, pre-existing, demeanor) —
that part should be unchanged.

### Phase 5 — Updates

5.1 BRIEFS/INDEX.md: Brief 47 row added.

5.2 BUILD_STATE.md: Findings entry noting:
  - The customer PDF's Staff Assessment is now staff name,
    determination, Splash Response only
  - "What the customer was told" → "Splash Response" rename is
    customer-PDF-only; admin UI label unchanged
  - The PA webhook setup (CUSTOMER_CLAIM_WEBHOOK_URL) is the
    next planned step now that the PDF is in its final shape

## Out of scope

- Modifying the manager detail page on /admin/damage/[id].
  It keeps the full assessment.
- Adding new fields to the PDF.
- Changing the PDF's other sections (header band, customer
  block, vehicle block, damage block, photos — wait, photos
  were already dropped in Brief 35).
- Touching the SharePoint webhook payload. Internal-facing
  systems still get every field.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- Customer PDF's Staff Assessment block contains exactly three
  rows (Submitted by, Determination, Splash Response) in that
  order
- "What was the customer told" label in the customer PDF is
  rendered as "Splash Response"
- Manager detail page is unchanged
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Files modified (just the one PDF generator)
- Diff line count (likely 10-30 lines of removals + 1 label
  rename)
- Bundle-size delta on damage-worker (likely slightly negative)
- Validation results
- Any decisions made on the operator's behalf

## Outcome

**Files modified (2):**

- `apps/damage-worker/src/render/claim-summary-pdf.ts` — interface
  trim: dropped `equipmentRelated: "yes" | "no" | null` from
  `ClaimSummaryPdfInput.assessment`. Section 5 (Staff Assessment)
  rendering replaced — was a 2-col `drawKeyValueGrid` (Staff Name +
  Equipment-Related) followed by two full-width label/text-block
  pairs (Determination + What the Customer Was Told). Now three
  uniform full-width label/text-block pairs in this order:
  **Submitted By** (`dash(staffName)`), **Determination**
  (`humanizeLabel(determination)`), **Splash Response**
  (`whatCustomerWasTold || "—"`). Section comment block
  expanded to record the Brief 47 rationale, the customer-PDF-only
  scope of the "What the Customer Was Told" → "Splash Response"
  rename, and the explicit list of internal-only fields
  (`equipment_related` / `equipment_piece` / `damage_type` /
  `damage_other` / `preexisting_damage` / `customer_demeanor`)
  intentionally NOT rendered on the customer copy.
- `apps/damage-worker/src/index.ts` — `buildAndStoreClaimSummaryPdf`
  call site lost its 7-line `equipmentRelated:` ternary that was
  decoding `claimData.equipmentInvolved` into a `"yes" | "no"`
  literal. The field was the sole consumer of the deleted
  Equipment-Related PDF cell, so removing the source ternary kept
  the literal in lockstep with the trimmed interface and removed
  ~7 lines of pure-dead code.

**Diff line count:** ~30 lines removed, ~12 lines added (3 new
label/value pairs + the section-comment expansion). Net negative,
matching the brief's prediction.

**Files created:** none.

**Files deleted:** none.

**Bundle-size delta on damage-worker:** **−0.27 KiB uncompressed,
−0.04 KiB gzip** (1685.75 → 1685.48 KiB / 381.94 → 381.90 KiB gzip
vs. Brief 46 baseline). Slightly negative, as expected from net
removal.

**Decisions made on operator's behalf:**

1. **`equipmentRelated` removed from the interface rather than
   left dead-stored.** Brief 35 took the opposite call for
   `locationCode` (kept it on the interface, no longer rendered)
   to avoid rippling into `buildAndStoreClaimSummaryPdf`. Brief 47
   removes the field because (a) CLAUDE.md's general guidance is
   "delete completely if unused" and (b) the call site's value
   was a 7-line ternary built specifically to feed this single
   PDF cell — the entire computation becomes dead with the cell,
   so deleting it nets out cleaner than keeping the dead code.
   The ripple is one call site, ~7 lines of touch.
2. **All three rows rendered as
   `drawFullWidthLabel` + `drawTextBlock` (uniform full-width
   treatment)** rather than mixing a 2-col `drawKeyValueGrid` for
   the two short rows + full-width for Splash Response. The
   brief asks for "exactly three rows, in this order"; full-width
   × 3 reads as three stacked rows; the grid would put two of them
   side-by-side. Uniform treatment also makes the Splash Response
   row (which can be multi-line free text) sit naturally below
   the two short rows. Reuses the existing helper Brief 32
   established — no new helper forked, per the brief's explicit
   instruction.
3. **Internal field name `whatCustomerWasTold` was NOT renamed**
   to match the new "Splash Response" label. The field name is
   internal-to-the-PDF-generator and the source DB column is
   `customer_told`; renaming the interface field would force
   renaming the corresponding key in `buildAndStoreClaimSummaryPdf`'s
   literal too, churn for no benefit. The label change is purely
   user-facing.
4. **`humanizeLabel(determination)` retained** even though the
   brief's example output ("Requested Customer Get Quote(s)")
   doesn't quite match the helper's mechanical title-casing
   ("Customer Get Quotes" — the helper splits on `_`/`-` and
   title-cases each token, no "Requested" prefix). The brief's
   example is illustrative; `humanizeLabel` from Brief 36 is the
   canonical formatter and is already shared by the rest of the
   PDF. Diverging the formatter just for this row would fork a
   new helper, which the brief explicitly forbade. If the
   operator wants the "Requested" prefix specifically for
   `customer_get_quotes`, that's a follow-up brief on
   `humanizeLabel` itself or a determination-specific override.
5. **Em-dash fallback for blank Splash Response** uses the
   existing `text || "—"` pattern inside `drawTextBlock`'s
   `wrapText(text || "—", …)` call, matching the prior "What the
   Customer Was Told" row's behavior. No change to fallback
   semantics. The "Submitted By" row uses the existing `dash()`
   helper (returns "—" for null/empty) for the same reason.

**Latent issues / forward flags:**

- **Power Automate webhook setup for `CUSTOMER_CLAIM_WEBHOOK_URL`
  is the next planned step.** Operator paused that work on
  2026-05-06 to land Brief 47 first so the email goes out with
  the trimmed PDF, not the verbose one. Brief 47 unblocks it.
- **The PDF's "Splash Response" wording is intentionally
  polite-but-vague** — the source field (`customer_told`) is what
  an employee said to the customer at intake. If a future
  workflow wants a more formal Splash-side response (e.g., the
  determination's customer-friendly translation), that's a
  separate brief; this one preserves the field as the
  customer-facing artifact of the actual conversation.
- **No worker-side endpoint or DB-shape change.** The
  `equipment_related` D1 column is unchanged; only the PDF
  rendering changed. Webhook payload, manager UI, sysadmin audit
  trail are all unaffected.
- **Operator must redeploy damage-worker.** CF Workers Builds
  triggers on push to `main` (watch path `apps/damage-worker/**`).
  After redeploy, submit a test claim with a fake email, click
  "Download a copy (PDF)" in the post-submit outcome card, and
  verify the Staff Assessment section reads exactly: Submitted By
  / Determination / Splash Response.

**Validation:**

- `pnpm typecheck` — 13/13 successful (2.403s, 12 cache hits,
  fresh build on `@splash/damage-worker` only, the one package
  with src changes). The interface trim compiled cleanly; no
  call site referenced `assessment.equipmentRelated` outside
  `buildAndStoreClaimSummaryPdf`.
- `pnpm --filter @splash/damage-worker build` — N/A (workers
  have no `build` script; bundling happens at deploy time via
  wrangler). Equivalent dry-run validation:
  `pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run --outdir=.dryrun` — succeeded; Total Upload
  **1685.48 KiB / gzip 381.90 KiB**; all 6 bindings (DB /
  R2_BUCKET / IMAGES / MAINTAINX_MODE="test" /
  MAINTAINX_BASE_URL / APPS_WEB_BASE_URL) resolved cleanly.

**Operator action items:**

1. After CF Workers Builds redeploys damage-worker on push,
   submit a test claim with a fake customer email. Verify the
   "Download a copy (PDF)" link in the post-submit outcome card
   produces a PDF whose Staff Assessment block reads exactly
   Submitted By / Determination / Splash Response — no Equipment-
   Related row, no "What the Customer Was Told" wording.
2. Verify the manager detail page on `/admin/damage/[id]` STILL
   shows the full assessment (equipment, damage type, pre-existing
   damage, customer demeanor) — that part should be unchanged.
3. Resume the Power Automate webhook setup for
   `CUSTOMER_CLAIM_WEBHOOK_URL` now that the customer PDF is in
   its final shape.
