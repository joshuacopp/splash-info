# Brief 41: Damage type selector on the claim form (employee section)

**Status:** Ready for Claude Code
**Started:**
**Completed:**
**Blocks:** Brief 42 (MaintainX work order on equipment_related=yes)
will use `damage_type` in the work order title. Brief 41 lands the
column + form field; Brief 42 reads it. Brief 41 must complete
before Brief 42 is queued.
**Dependencies:** None. Touches the public claim form
(`apps/damage-worker/src/render/claim-form.ts`), the submit
handler (`apps/damage-worker/src/index.ts handleClaimSubmission`),
the D1 `claims` table schema, the shared `ClaimRow` /
`ClaimInsert` types, and the manager detail page that renders
the staff assessment block.

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-025-claim-form-polish.md (the equipment toggle
  pattern this brief mirrors — segmented toggle reveals a hidden
  details block)
- apps/damage-worker/src/render/claim-form.ts (the form HTML +
  inline JS — damage type field goes in the employee section,
  positioned BEFORE the equipment-related toggle)
- apps/damage-worker/src/index.ts (`handleClaimSubmission` ~L1206,
  `ClaimSubmissionPayload` ~L1180, the SharePoint webhook JSON
  payload further down — search `equipmentInvolved` to find both)
- packages/db-d1/src/claims.ts (`ClaimInsert` interface + the
  `INSERT INTO claims` statement in `writeClaimBatch` — both
  must learn the two new columns)
- packages/types/src/claims.ts (`ClaimRow` — add the two columns)
- apps/web/app/admin/damage/[id]/page.tsx (manager detail render —
  staff assessment block; add a "Damage Type" row alongside
  equipment_piece display)
- apps/damage-worker/src/render/claim-summary-pdf.ts (the
  customer-facing PDF — add Damage Type to the assessment section
  if that section already includes equipment_piece; otherwise
  out of scope for Brief 41)

## Context

Today the public claim form's employee section asks for
`equipmentInvolved` (a dropdown that reveals when the
"equipment related?" toggle is flipped to Yes) but does NOT
capture what KIND of damage occurred. Brief 42 needs the damage
type to title the MaintainX work order
(`Damage Claim - {location_pretty} - {damage_type}`), so we land
the column + form field in this brief and Brief 42 just reads it.

Operator-specified damage type options (in order):

```
License Plate
Wiper
Collision
Roof Rack/Roof Accessory
PS Mirror
DS Mirror
Window
Paint Damage
Rims
Tires
Other
```

When "Other" is selected, a free-text "description of other" input
appears for the employee to fill in.

## Scope

### Phase 1 — D1 schema

1.1 Add two nullable columns to the `claims` table on D1
(`splash-damage`). Run REMOTE only — D1 prod is the live store;
there's no separate test DB:

```sql
ALTER TABLE claims ADD COLUMN damage_type TEXT;
ALTER TABLE claims ADD COLUMN damage_other TEXT;
```

Command (PowerShell, from repo root):

```powershell
pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage --remote --command "ALTER TABLE claims ADD COLUMN damage_type TEXT;"
pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage --remote --command "ALTER TABLE claims ADD COLUMN damage_other TEXT;"
```

Verify with:

```powershell
pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage --remote --command "PRAGMA table_info(claims);" --json
```

Both columns must appear in the output.

1.2 Both columns are nullable so existing rows stay valid. The
worker enforces required-on-submit at the surface (Phase 2.4
below); back-compat for historical rows is the same posture used
for `customer_email` in Brief 32.

### Phase 2 — Form + worker

2.1 In `apps/damage-worker/src/render/claim-form.ts`, add a new
form group for damage type, positioned in the employee section
DIRECTLY BEFORE the existing equipment-related toggle (currently
at ~L450, the comment "Equipment toggle (Brief 25)…"). Mirror
the segmented-toggle/conditional-reveal pattern Brief 25
established for the equipment block:

```html
<div class="form-group">
  <label for="damageType">Damage Type <span class="required">*</span></label>
  <select id="damageType" name="damageType" required>
    <option value="">Select damage type...</option>
    <option value="License Plate">License Plate</option>
    <option value="Wiper">Wiper</option>
    <option value="Collision">Collision</option>
    <option value="Roof Rack/Roof Accessory">Roof Rack/Roof Accessory</option>
    <option value="PS Mirror">PS Mirror</option>
    <option value="DS Mirror">DS Mirror</option>
    <option value="Window">Window</option>
    <option value="Paint Damage">Paint Damage</option>
    <option value="Rims">Rims</option>
    <option value="Tires">Tires</option>
    <option value="Other">Other</option>
  </select>
  <div id="damageOtherWrap" hidden style="margin-top: 12px;">
    <label for="damageOther">Description of other <span class="required">*</span></label>
    <input type="text" id="damageOther" name="damageOther"
           placeholder="Describe the damage..." maxlength="200">
  </div>
</div>
```

2.2 Add inline JS (in the same file's existing `<script>` block,
near the equipment toggle wiring) to reveal/hide the
"description of other" wrap and toggle its required attribute:

```js
var dmgTypeSel = document.getElementById('damageType');
var dmgOtherWrap = document.getElementById('damageOtherWrap');
var dmgOtherInput = document.getElementById('damageOther');
function syncDamageOther() {
  var isOther = dmgTypeSel && dmgTypeSel.value === 'Other';
  if (dmgOtherWrap) dmgOtherWrap.hidden = !isOther;
  if (dmgOtherInput) {
    if (isOther) {
      dmgOtherInput.setAttribute('required', '');
    } else {
      dmgOtherInput.removeAttribute('required');
      dmgOtherInput.value = '';
    }
  }
}
if (dmgTypeSel) dmgTypeSel.addEventListener('change', syncDamageOther);
syncDamageOther();
```

2.3 In `validateBeforeSubmit()` (same file, search for the
function), add a check that `damageType` is set, and if `Other`,
that `damageOther` is non-empty. Mirror the existing missing-field
toast pattern.

2.4 In `apps/damage-worker/src/index.ts handleClaimSubmission`:

  - Extend `ClaimSubmissionPayload` (~L1180) with:
    ```ts
    damageType: string;
    damageOther: string;
    ```
  - Extend the `formData.get(...)` parse block (~L1242) with:
    ```ts
    damageType: String(formData.get("damageType") ?? ""),
    damageOther: String(formData.get("damageOther") ?? ""),
    ```
  - After the existing `emailValid` gate (~L1261), add a
    `damageType` validation:
    - `damageType` must be one of the 11 allowed values (allow-list,
      same strings as the form options). On miss, return the same
      browserMode 303 / JSON 400 pattern the email gate uses, with
      `error=Damage type required` (or `Invalid damage type` for
      out-of-list).
    - If `damageType === 'Other'`, `damageOther.trim()` must be
      non-empty (≤200 chars). On miss, error
      `Description of other required`.
    - If `damageType !== 'Other'`, force `damageOther = ''` server-side
      (don't trust the client to clear it).

  - Pass both fields into the `writeClaimBatch` call: extend
    the `ClaimInsert` shape (Phase 3 below) and bind the two
    new params.

  - In the SharePoint webhook payload (search the function for
    where `equipmentInvolved` is included in the JSON body), add
    `damageType` and `damageOther` alongside it. Power Automate's
    Parse JSON action will need the schema updated by the
    operator after this lands — flag that in the Outcome.

  - In the R2 submission JSON write (search for where the full
    `claimData` is stringified to R2), the new fields ride along
    automatically since they're now on the payload object.

### Phase 3 — Shared types + DB layer

3.1 In `packages/types/src/claims.ts`, add to `ClaimRow`:

```ts
damage_type: string | null;
damage_other: string | null;
```

3.2 In `packages/db-d1/src/claims.ts`:

  - Add to `ClaimInsert` interface:
    ```ts
    damage_type: string | null;
    damage_other: string | null;
    ```
  - Extend the `INSERT INTO claims (...) VALUES (...)` statement
    in `writeClaimBatch`: add `damage_type` and `damage_other` to
    the column list and two more `?` placeholders + `.bind(...)`
    args. Place them right after `equipment_piece` for
    readability.
  - Update the `SELECT * FROM claims WHERE claim_id = ?` and the
    list-claims SELECT (search for `c.equipment_related` in the
    file to find both query bodies) — `SELECT *` callers don't
    need explicit changes, but if any explicit column lists
    reference the equipment columns, add the new ones.

### Phase 4 — Manager detail page

4.1 In `apps/web/app/admin/damage/[id]/page.tsx`, find the staff
assessment block (search for `equipment_piece` or "Equipment
Involved"). Add a new row:

  - Label: "Damage Type"
  - Value: `claim.damage_type ?? "—"` (em-dash for back-compat
    with pre-Brief-41 rows that have NULL)
  - If `claim.damage_type === 'Other'` AND `claim.damage_other`
    is non-empty, render `Other — {damage_other}` instead.

Position the row directly above "Equipment Involved" to mirror
the form order.

### Phase 5 — PDF (conditional)

5.1 If `apps/damage-worker/src/render/claim-summary-pdf.ts`
already includes the equipment fields in its assessment section
(search for `equipment_piece`), add `Damage Type` alongside it
using the same `humanizeLabel` pattern Brief 36 established. If
the PDF doesn't surface assessment fields, leave it alone — the
operator can request a follow-up if customers want to see the
damage type on their copy.

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md: Brief 41 row added with Outcome summary.

6.2 BUILD_STATE.md: Findings entry noting:
   - Two new D1 columns on `claims` (damage_type, damage_other)
   - The 11 allowed damage_type values are an allow-list enforced
     by the worker; adding/removing options requires a coordinated
     change to claim-form.ts (HTML), index.ts (validation), and
     this brief's option list as the source of truth
   - SharePoint Parse JSON schema needs operator-side update
   - Brief 42 (MaintainX) now unblocked

## Out of scope

- MaintainX integration. That's Brief 42, which depends on this.
- Adding damage_type to the post-submit determination/equipment
  modal a GM uses on the manager side — the form-side employee
  field is the single source of truth for now. If GMs need to
  amend damage_type post-submit, that's a separate brief.
- Backfilling damage_type for historical claims. They stay NULL.
  Manager UI renders em-dash. No migration.
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys on push for apps/web. Damage worker is on workers.dev
  only — operator runs `pnpm --filter @splash/damage-worker exec
  wrangler deploy` after smoke testing.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- D1 `claims` table has `damage_type TEXT NULL` and
  `damage_other TEXT NULL` columns (verified via PRAGMA)
- Public claim form shows the Damage Type select in the employee
  section before the equipment toggle, with the 11 listed options
- Selecting "Other" reveals a required free-text input
- Submitting without damage_type set surfaces a validation error
  client-side AND server-side
- Submitting with damage_type=Other but empty damage_other
  surfaces a validation error client-side AND server-side
- The two fields land in D1 on successful submission, in the
  SharePoint webhook payload, and in the R2 submission JSON
- Manager detail page renders the new Damage Type row
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/damage-worker build succeeds (or
  `wrangler deploy --dry-run` if the package uses that pattern)
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Files modified (list)
- Confirmation that PRAGMA shows both new columns
- Bundle-size delta on damage-worker (likely +0.2 kB)
- Bundle-size delta on apps/web /admin/damage/[id] (likely zero
  — just a render row)
- Validation results
- Any decisions made on the operator's behalf

## Outcome

(Filled in by Claude Code on completion.)
