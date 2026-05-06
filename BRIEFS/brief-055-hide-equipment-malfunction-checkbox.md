# Brief 55: Hide equipment-malfunction checkbox from customer claim form (preserve plumbing)

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Form polish — operator decided 2026-05-06 the
"Was there an equipment malfunction?" checkbox isn't doing useful
work today (not persisted in D1, not surfaced in admin manager
detail, not on the customer PDF; only reaches Power Automate's
SharePoint write, where its destination is unverified).
**Dependencies:** None.

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-023-customer-claim-form.md (the brief that ported
  this checkbox from `legacy/damagemanager.js`)
- BRIEFS/brief-025-claim-form-polish.md (folded the checkbox inside
  the equipment-yes details block)
- apps/damage-worker/src/render/claim-form.ts (the only file that
  needs to change for this brief)

## Context

`legacy/damagemanager.js` had a "Was there an equipment malfunction?"
checkbox; Brief 23 ported it forward; Brief 25 folded it inside the
equipment-yes reveal. The boolean is collected into
`claimData.equipmentMalfunction` (`apps/damage-worker/src/index.ts`
~L1494, L1557) and rides on the SharePoint webhook payload via
`JSON.stringify(claimData)` (~L1917). It is **not** written to D1
(no column in the writeClaimBatch insert), **not** surfaced in
`apps/web` (zero refs to `malfunction` / `equipmentMalfunction`
under apps/web or packages/), **not** on the customer summary PDF
(Brief 47 trimmed Staff Assessment), and not consumed by MaintainX
(Brief 42 keys off `equipment_related` derived from
`equipmentInvolved !== "N/A"`).

Operator's decision 2026-05-06: hide the visible UI now but keep
the parse path + type field + PA payload key intact, in case a
future brief promotes the malfunction signal to a real field
(D1 column + admin display + filter). Removing only the form
HTML + the inline-script wiring leaves a clean revert path:
"un-comment the JSX block + un-comment the toggle handler" and
the data round-trip works again.

## Scope

### Phase 1 — Hide the checkbox in claim-form.ts

1.1 In `apps/damage-worker/src/render/claim-form.ts`, locate the
checkbox markup (lines ~493-496):

```html
<div style="margin-top: 10px; display: flex; align-items: center; gap: 10px;">
  <input type="checkbox" id="equipmentMalfunctionToggle" style="width: 18px; height: 18px; cursor: pointer;">
  <label for="equipmentMalfunctionToggle" style="margin: 0; font-weight: 500; color: #334155; cursor: pointer;">Was there an equipment malfunction?</label>
</div>
```

Wrap the entire `<div>...</div>` block in an HTML comment (`<!-- ...
-->`) with a one-line marker above it explaining why it's hidden:

```html
<!-- Brief 55 (2026-05-06): equipment-malfunction checkbox hidden
  pending decision on whether to promote it to a real field (D1
  column + admin display) or remove entirely. The hidden input
  named "equipmentMalfunction" below stays wired so the
  claimData.equipmentMalfunction field continues to round-trip
  through the worker → Power Automate → SharePoint path with the
  legacy default of "false". To re-enable the visible toggle:
  un-comment this block and the eqMalToggle/eqMalHidden handler
  in the inline script (~L699-L703). -->
<!--
<div style="margin-top: 10px; display: flex; align-items: center; gap: 10px;">
  <input type="checkbox" id="equipmentMalfunctionToggle" style="width: 18px; height: 18px; cursor: pointer;">
  <label for="equipmentMalfunctionToggle" style="margin: 0; font-weight: 500; color: #334155; cursor: pointer;">Was there an equipment malfunction?</label>
</div>
-->
```

Critical: do NOT touch the hidden input near line 316
(`<input type="hidden" name="equipmentMalfunction"
id="equipmentMalfunctionHidden" value="false">`). It's the carrier
that puts `equipmentMalfunction: false` into the form submission;
removing it would change the PA payload shape (the field would
go missing instead of staying `false`), which could break the PA
flow's Parse JSON action if it expects the key to be present.

1.2 In the inline equipment-toggle script (~L676-L703), locate
the eqMalToggle/eqMalHidden block:

```js
var eqMalToggle = document.getElementById('equipmentMalfunctionToggle');
var eqMalHidden = document.getElementById('equipmentMalfunctionHidden');
function syncEquipment() {
  var checked = document.querySelector('input[name="__equipmentRelated"]:checked');
  var isYes = checked && checked.value === 'yes';
  if (eqDetails) eqDetails.hidden = !isYes;
  if (eqSelect) {
    eqSelect.required = !!isYes;
    if (!isYes) {
      eqSelect.value = '';
      if (eqMalToggle) eqMalToggle.checked = false;
      if (eqMalHidden) eqMalHidden.value = 'false';
    }
  }
}
// ...
if (eqMalToggle && eqMalHidden) {
  eqMalToggle.addEventListener('change', function () {
    eqMalHidden.value = eqMalToggle.checked ? 'true' : 'false';
  });
}
```

Behavior with the checkbox commented out:

- `var eqMalToggle = document.getElementById('equipmentMalfunctionToggle')` → `null`
- The `if (eqMalToggle) eqMalToggle.checked = false;` and
  `if (eqMalHidden) eqMalHidden.value = 'false';` lines stay safe
  because of the existing null-guards
- The bottom `if (eqMalToggle && eqMalHidden)` block silently no-ops
  because eqMalToggle is null

So the script tolerates the missing checkbox without modification.
However, for code-clarity (so the next reader doesn't wonder what
these dead var lines are for), restructure to leave a single
comment-marker plus the now-dormant lookups:

```js
// Brief 55 (2026-05-06): equipment-malfunction toggle hidden in
// the form HTML above. The lookups below resolve to null at
// runtime; the existing null-guards make this safe. Restoring
// the visible toggle is a two-step revert — un-comment the
// markup block above (~L493-L496) and these handler bindings
// will pick it up automatically.
var eqMalToggle = document.getElementById('equipmentMalfunctionToggle');
var eqMalHidden = document.getElementById('equipmentMalfunctionHidden');
```

Leave the existing `if (eqMalToggle && eqMalHidden) { ... }` block
unchanged — it's already a no-op when the toggle is missing.

Leave the `eqMalToggle.checked = false` / `eqMalHidden.value =
'false'` reset lines inside `syncEquipment` unchanged — they're
already null-guarded.

1.3 Do NOT touch any of:

- `apps/damage-worker/src/index.ts` `ClaimSubmissionPayload` type
  field `equipmentMalfunction: boolean`
- `apps/damage-worker/src/index.ts` form-parse line 1557
  (`equipmentMalfunction: String(formData.get("equipmentMalfunction") ?? "") === "true"`)
- The PA POST body at `JSON.stringify(claimData)` line ~1917 — this
  is what carries the `equipmentMalfunction: false` key into
  SharePoint
- The hidden `<input type="hidden" name="equipmentMalfunction"
  id="equipmentMalfunctionHidden" value="false">` at line ~316

The whole point of this brief is "remove the UI but preserve the
plumbing." Touching any of the above breaks that contract.

### Phase 2 — Validation

2.1 `pnpm typecheck` — must pass for all 13 packages.
2.2 `pnpm --filter @splash/damage-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed (worker
   has no `build` script per Brief 52's note about workers).
   Clean up `.tmp-build` afterward.
2.3 No new endpoints. No schema changes. No new env vars. No type
   changes. The PA webhook payload shape is identical.

### Phase 3 — Updates

3.1 BRIEFS/INDEX.md: Brief 55 row appended (matching the table
schema used by Briefs 51-54).

3.2 BUILD_STATE.md: Findings entry noting:
  - `equipmentMalfunction` checkbox + label markup commented out
    in `apps/damage-worker/src/render/claim-form.ts` (lines
    ~493-496)
  - Hidden input + parse path + PA payload key preserved so the
    field continues to ride through to SharePoint with its legacy
    default of `false`
  - Operator decision: defer "promote to real field (D1 column +
    admin display)" to a future brief; this brief just hides the
    UI noise
  - Operator follow-up: confirm the form on
    `https://damage.splashcarwashes.info/claims/<slug>` no longer
    shows "Was there an equipment malfunction?" after CF Workers
    Builds redeploys damage-worker on push
  - Operator-side opportunity (no code): in Power Automate's
    customer-email send action, change `Hi,` to `Hi
    @{triggerBody()?['customer_name']},` — `customer_name` is
    already in the webhook payload (Brief 32, line ~2466 of
    damage-worker index.ts)

3.3 CLAUDE.md unchanged — the form layout is documented inline in
claim-form.ts (Phase 1.1's marker comment carries the rationale).

## Out of scope

- Removing `equipmentMalfunction` from the `ClaimSubmissionPayload`
  type, the form-parse line, the hidden input, or the PA webhook
  payload. The whole point of "hide" vs "remove" is keeping the
  data plumbing in place.
- Adding a D1 column or admin manager-detail row for malfunction.
  That's a future brief if operator decides to promote it.
- Removing the legacy reference in `legacy/damagemanager.js` —
  legacy is a read-only snapshot.
- Power Automate flow changes (e.g., personalizing the customer
  email greeting). PA flow edits happen in the Power Automate
  console, not in the codebase. The BUILD_STATE.md follow-up
  bullet flags the personalization opportunity as operator-side.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- The "Was there an equipment malfunction?" checkbox + label is
  no longer rendered in the customer claim form HTML (commented
  out with a marker explaining the revert procedure)
- The hidden input (`name="equipmentMalfunction"`) is unchanged
- The form-parse line in `handleClaimSubmission` is unchanged
- The PA webhook payload (`JSON.stringify(claimData)`) is unchanged
  in shape (still includes `equipmentMalfunction: false`)
- The inline equipment-toggle script's null-guards still cover
  the now-missing element references (no console errors)
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build bundle succeeds (clean up after)
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely ~10-15 lines net: comment wrap on the markup +
  small comment-marker on the script)
- Confirmation that the PA payload shape is unchanged (the hidden
  input still defaults to `value="false"`)
- Validation results
- Any decisions made on the operator's behalf

## Outcome

Completed 2026-05-06 in a single session. The visible "Was there an
equipment malfunction?" checkbox + label is hidden from the customer
claim form HTML; the hidden input + form-parse + type field + PA
webhook payload all preserved verbatim per the "hide, not remove"
contract. Diff is +20 lines / -4 lines net (+24 lines source) but most
of those lines are inline comment-marker text that ships verbatim into
the bundled worker output (the markup lives inside a template literal).

### Files modified

- `apps/damage-worker/src/render/claim-form.ts` — three edits:
  1. Wrapped the `<div style="margin-top: 10px; ...">...</div>` block
     containing the `equipmentMalfunctionToggle` checkbox + its label
     (formerly at L493-L496) in an HTML `<!-- -->` comment, with a
     multi-line Brief-55 marker comment immediately above explaining
     the revert procedure ("To re-enable the visible toggle: un-comment
     this block and the eqMalToggle/eqMalHidden handler in the inline
     script below."). Total span post-edit ~L493-L507.
  2. Added a 6-line Brief-55 JS comment marker (~L690-L695) above the
     existing `var eqMalToggle = document.getElementById('equipmentMalfunctionToggle');`
     and `var eqMalHidden = document.getElementById('equipmentMalfunctionHidden');`
     lookups, explaining that the lookups now resolve to `null` at
     runtime and the existing null-guards keep the script safe.
  3. Did NOT modify the `if (eqMalToggle && eqMalHidden) { ... }`
     event-listener block (~L716-L720) — already a null-guard no-op
     when the toggle element is missing. Did NOT modify the
     `if (eqMalToggle) eqMalToggle.checked = false; if (eqMalHidden)
     eqMalHidden.value = 'false';` reset lines inside `syncEquipment`
     — already null-guarded.

### Files unchanged (per Phase 1.3 — critical-not-to-touch list)

- `apps/damage-worker/src/render/claim-form.ts` `<input type="hidden"
  name="equipmentMalfunction" id="equipmentMalfunctionHidden"
  value="false">` at ~L316 — verified untouched.
- `apps/damage-worker/src/index.ts` `ClaimSubmissionPayload`
  `equipmentMalfunction: boolean` field — verified untouched.
- `apps/damage-worker/src/index.ts` form-parse line at ~L1557
  (`equipmentMalfunction: String(formData.get("equipmentMalfunction") ?? "") === "true"`)
  — verified untouched.
- `apps/damage-worker/src/index.ts` PA POST body at ~L1917
  (`JSON.stringify(claimData)`) — verified untouched.

### Files updated (standard documentation)

- `BRIEFS/INDEX.md` — new Brief 55 row appended below Brief 54.
- `BRIEFS/QUEUE.md` — `brief-055-hide-equipment-malfunction-checkbox.md`
  line commented in place with `(completed 2026-05-06)` suffix per
  the established pattern (the orchestrator's tombstone convention
  used by all 17 prior completed entries).
- `BUILD_STATE.md` — Last updated stamp bumped + line-3 paragraph
  prepended with Brief 55 summary; new Findings table row inserted
  at the top of `## Findings & decisions log`.
- `BRIEFS/brief-055-hide-equipment-malfunction-checkbox.md` — Status
  flipped to `Completed (2026-05-06)`, Started/Completed dates set,
  this Outcome section filled in.

### Decisions made on operator's behalf

1. **Comment marker phrasing** — both the HTML and JS comment markers
   carry a "Brief 55 (2026-05-06)" prefix and one-paragraph rationale
   spelling out the revert procedure inline. CLAUDE.md prefers comments
   that explain *why* (load-bearing context); the revert path is
   exactly that here.
2. **Kept the dormant `var eqMalToggle = …; var eqMalHidden = …;`
   lookups** rather than deleting them — the brief explicitly called
   for the comment-marker-plus-dormant-lookups pattern so a future
   un-comment of the markup re-activates the existing handler binding
   without requiring a second edit.
3. **Comment text uses "above" rather than the brief's literal "below"
   wording** for the `equipmentMalfunction` hidden-input reference —
   the hidden input is at line 316 (above the checkbox at lines
   493-496), so "above" is the accurate file-position reference. The
   brief's wording was a documentation slip.
4. **HTML comment wraps the original markup verbatim** rather than
   deleting it — leaves a clean one-line revert path: un-comment to
   restore the visible toggle, no re-typing required. This costs ~3
   lines of bundled worker output (the markup lives inside a template
   literal) but the savings on revert effort are worth it.
5. **Touched `BRIEFS/QUEUE.md`** (commented brief-055 entry with
   `(completed 2026-05-06)` suffix) following the in-place comment-out
   pattern used by the 17 prior completed entries; the brief itself
   only mentions INDEX.md + BUILD_STATE.md updates, but the QUEUE
   convention is consistent across prior outcomes and skipping it
   would have left the orchestrator queue inconsistent.
6. **No `legacy/damagemanager.js` edit** — legacy is a read-only
   snapshot per Brief 38's audit; if a future brief decides to fully
   remove `equipmentMalfunction` from the new code, legacy would still
   be left alone. Out-of-scope per the brief.
7. **No prioritized-work-list row added in `BUILD_STATE.md`** — that
   list is "authoritative — derived from the audit + the work the
   operator has called out" (CLAUDE.md Conventions), and Brief 55 is
   a small polish brief that originated from the planner, not from
   the audit's numbered backlog. Briefs 51-54 took the same posture.

### Latent issues / forward flags

(a) **PA payload shape unchanged** — the hidden input still ships
`equipmentMalfunction=false` on every form submission; the worker
still parses it; PA still receives `equipmentMalfunction: false` in
the JSON body. SharePoint write-end behavior is identical to
pre-Brief-55. No PA-side schema change needed. Operator must only
confirm post-redeploy that the form on
`https://damage.splashcarwashes.info/claims/<slug>` no longer renders
the visible checkbox.

(b) **No new endpoints / no schema change / no new env var / no type
change** — per Phase 2.3 of the brief.

(c) **Bundle delta** — Total Upload 1688.34 KiB / gzip 382.64 KiB.
Brief 49 baseline was 1687.32 / 382.21 → +1.02 KiB / +0.43 KiB gzip.
Slightly larger than expected for ~24 net source lines because the
Brief-55 marker comments live inside template literals
(`claim-form.ts`'s exported function returns a string template that
includes the entire `<form>` HTML and inline `<script>` body), so
both comment blocks ship verbatim into the bundled worker output.
Acceptable for a documentation-grade revert pointer; future cleanup
option is to strip the verbatim original markup from the wrapped
HTML comment block once the operator commits to "remove" rather
than "hide" the field.

(d) **Legacy reference in `legacy/damagemanager.js` not touched**
(legacy is a read-only snapshot per Brief 38).

(e) **No headless smoke test possible** — operator must navigate to
the public claim form post-redeploy and confirm the checkbox is no
longer rendered (and ideally inspect the form's network POST in
DevTools to confirm `equipmentMalfunction=false` still appears in
the FormData body — the hidden input is what carries the key).

(f) **Operator-side opportunity (no code) — PA customer-email greeting
personalization.** PA's Send Email action currently uses `Hi,` as the
greeting; `customer_name` is already in the webhook payload (Brief 32,
~L2466 of damage-worker `index.ts`). Swap `Hi,` for
`Hi @{triggerBody()?['customer_name']},` in the PA console — pure
PA-side edit, no worker change needed. Flagged in the brief's Phase
3.2 as an operator-side opportunity.

(g) **Future "promote to real field" brief outline** (if the operator
later decides the malfunction signal should land in admin tooling):
(i) `claims.equipment_malfunction INTEGER NULL` D1 column added via
`wrangler d1 execute splash-damage-claims --remote --command="ALTER
TABLE claims ADD COLUMN equipment_malfunction INTEGER NULL"`,
(ii) `writeClaimBatch` in `apps/damage-worker/src/index.ts` extended
to insert the value, (iii) `apps/web/app/admin/damage/[id]/page.tsx`
extended to render an "Equipment Malfunction" row in the
staff-assessment block, (iv) optionally an `equipment_malfunction`
filter in the list view. Estimated brief-size: small (~3 files, ~30
lines net). The current "hide" leaves a clean substrate for that
future brief — un-comment the markup, add the column, wire the
display.

### Validation results

- `pnpm typecheck` — **13/13 successful** (1.552s; 12 cache hits +
  fresh `@splash/damage-worker` rebuild — the only modified package).
  Output: `Tasks: 13 successful, 13 total`.
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build` — **succeeded**. Total Upload **1688.34 KiB /
  gzip 382.64 KiB** (Brief 49 baseline 1687.32 / 382.21 → +1.02 KiB
  / +0.43 KiB gzip). All 6 bindings (DB / R2_BUCKET / IMAGES /
  MAINTAINX_MODE="test" / MAINTAINX_BASE_URL / APPS_WEB_BASE_URL)
  resolved cleanly. `.tmp-build` directory removed afterward.

### Confirmation summary (per brief Report section)

- **Diff size:** ~+20 lines source net (HTML comment-wrap +
  multi-line marker comment + 6-line JS comment marker), close to
  the brief's predicted ~10-15 lines.
- **PA payload shape unchanged:** confirmed by inspection — the
  hidden input at L316 still defaults to `value="false"`; the
  worker's form-parse line at index.ts:1557 still reads
  `formData.get("equipmentMalfunction")`; the PA POST body at
  index.ts:1917 still serializes `claimData` (which still includes
  `equipmentMalfunction: boolean`).
- **Validation:** typecheck + wrangler dry-run both green; bundle
  +1.02 KiB / +0.43 KiB gzip vs. Brief 49 baseline (last
  damage-worker deploy of record).
- **Decisions made on operator's behalf:** see "Decisions" subsection
  above (7 items).
