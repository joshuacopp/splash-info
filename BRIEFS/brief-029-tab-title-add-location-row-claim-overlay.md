# Brief 29: Tab title + Add Location locations-row + claim-form overlay clear

**Status:** Completed (2026-05-05)
**Started:** 2026-05-05
**Completed:** 2026-05-05
**Blocks:** Three small post-Brief-25/26/27 polish items surfaced by
operator end-to-end testing on 2026-05-05. Two are functional bugs
(claim-form overlay never clears on success; Add Location only writes
pricing_simple, leaving locations table empty for the new code so
Update Location can never find it); one is cosmetic (browser tab
title still says "Splash MaxPass" - operator wants "Splash Tools").
**Dependencies:** Brief 24 (Add Location), Brief 25 (claim form
JS-driven submit / overlay), Brief 27 (Update Location depends on
locations row existing).

## Read first

- CLAUDE.md (especially the `pkg$` constraint and the locations vs.
  pricing_simple varchar/int site asymmetry note - "varchar
  zero-padded `pricing_simple.site` vs int `locations.site_number` -
  cast with `LPAD(::text, 3, '0')`")
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-024-sysadmin-add-location.md (Outcome - existing
  worker handler `handleCreateLocation`, AddLocationCard form,
  createLocationAction)
- BRIEFS/brief-025-claim-form-polish.md (Outcome - the claim form's
  JS submit pipeline + showOutcome / setSubmitting helpers)
- BRIEFS/brief-027-sysadmin-update-location.md (the
  GET /sysadmin/api/locations/search + PATCH /sysadmin/api/locations
  endpoints landed there - this brief's Add Location locations-row
  insert needs to round-trip through that search + edit flow once
  Brief 29 ships)
- apps/damage-worker/src/render/claim-form.ts (the customer claim
  form HTML + inline submit script)
- apps/sysadmin-worker/src/index.ts (handleCreateLocation)
- apps/web/app/admin/sysadmin/_components/AddLocationCard.tsx
- apps/web/app/admin/sysadmin/actions.ts (createLocationAction)
- apps/web/app/layout.tsx (the `metadata.title = "Splash MaxPass"`
  string)

## Context

End-to-end testing on 2026-05-05 surfaced three issues:

1. **Browser tab title is "Splash MaxPass" everywhere.** Per operator,
   change to "Splash Tools" across all surfaces.
2. **Add Location only writes pricing_simple, not locations.** Brief
   24 did the bulk pricing_simple insert correctly (4-row test
   submission produced 4 properly-shaped rows). But the `locations`
   table still has no row for the new location, which means:
   - Brief 27's Update Location editor can never find the new
     location to edit AM/RM/email fields.
   - The `trg_sync_pricing_simple` trigger is `ON locations AFTER
     UPDATE`, so cascading edits will never fire because there's no
     locations row to update.
   The fix: extend `handleCreateLocation` to also INSERT a single
   row into `locations` before the pricing_simple bulk POST. Use
   the form fields already collected (location_pretty, area_manager,
   regional_manager, am_email, rm_email, site_email, site, plus a
   new `address` field per below) and derive `site_number` from the
   `site` text input (parse to integer).
3. **Add Location form should accept `address` (postal address).**
   Currently the form has no address field and pricing_simple.address
   stays null. Operator wants the field exposed; it should map to
   `locations.location` (the column in locations table that holds the
   street address per the trigger spec). The `trg_sync_pricing_simple`
   trigger then propagates locations.location -> pricing_simple.address
   on subsequent updates. For initial INSERT, write address directly
   to both tables so the new pricing_simple rows have the address
   populated immediately (don't rely on the trigger firing on INSERT).
4. **Claim form `Submitting claim, please wait...` overlay never
   clears on success.** Visible in operator's screenshot: the
   `#outcomePage` "Claim submitted" card renders correctly, but the
   `#submittingOverlay` div (which sits OUTSIDE both #formPage and
   #outcomePage) stays visible because `showOutcome()` calls
   `formPage.hidden = true; outcomePage.hidden = false;` but does
   NOT call `setSubmitting(false)`. Only the error paths
   (`showError` callers) call `setSubmitting(false)`. The fix: call
   `setSubmitting(false)` at the top of `showOutcome()`.

## Scope

### Part A - Tab title cosmetic fix

A.1 `apps/web/app/layout.tsx` line 28: change
`title: "Splash MaxPass"` to `title: "Splash Tools"`.

A.2 Audit the five workers for any `<title>` tags that customer-or-
admin-facing pages render. Confirmed locations from grep:
  - `apps/damage-worker/src/render/claim-form.ts`:
    - Line 298: `<title>Vehicle Issue Report - ${escHtml(locationPretty)}</title>` -
      LEAVE AS-IS (this is customer-facing, location-specific, and
      not an admin tool).
    - Line 840: `<title>Claim Submitted - ${escHtml(locationPretty)}</title>` -
      LEAVE AS-IS (same reason - customer-facing thank-you).
    - Line 878: `<title>Location Not Found</title>` - LEAVE AS-IS
      (customer-facing 404).
  - `apps/signup-worker/src/render/form.ts` line 60:
    `<h1>${escHtml(cap(locationCode))} MaxPass</h1>` - this is an
    `<h1>` heading on the customer signup page, NOT a tab title.
    LEAVE AS-IS (it's the customer-product-facing brand).
  - Other "MaxPass" mentions (in code comments, R2 helper docstrings,
    success modal copy, etc.) - LEAVE AS-IS. Brief 29 is scoped to
    the browser tab title only.

A.3 If during the audit any other admin-tool tab title surfaces (e.g.,
the dashboard-worker shell, performance-worker, sysadmin-worker
forced-reset page, etc.) that says "MaxPass" rather than reflecting
the admin tool, change those to "Splash Tools" too. Report the
list in Outcome.

### Part B - Add Location: insert locations row + accept `address`

B.1 Worker: extend `handleCreateLocation` in
`apps/sysadmin-worker/src/index.ts`:

  - Body interface gains an optional `address: string | null` field.
  - Validation:
    - `site` (already collected) must parse to a positive integer
      when locations row insert is desired. Per the existing brief
      24 outcome, `site` is currently optional. With this brief, it
      becomes effectively required: if `site` is blank, error 400
      "Site number required (used as locations.site_number)".
    - `address` if present is trimmed; empty -> null.
    - Pre-check uniqueness on locations as well: `GET .../locations
      ?site_number=eq.{n}&limit=1` AND `?location_code=eq.{code}&limit=1`
      (whichever column locations actually uses for code; if it has
      both site_number and a separate code/slug, check both). Return
      409 "Location already exists in locations table" on hit.
  - Order of operations on valid input:
    1. INSERT locations row first via Supabase REST POST to
       `/rest/v1/locations`. Payload:
       ```json
       {
         "site_number": <int(site)>,
         "site": <location_pretty>,
         "location": <address or null>,
         "area_manager": <area_manager or null>,
         "regional_manager": <regional_manager or null>,
         "am_email": <am_email or null>,
         "rm_email": <rm_email or null>,
         "site_email": <site_email or null>
       }
       ```
       Use `Prefer: return=representation` so the inserted id comes
       back. Capture the returned `id` for the audit log.
    2. THEN the existing pricing_simple bulk array POST (unchanged
       except: each row's `address` column is now populated from the
       form's address field, mirroring how am_email/rm_email/site_email
       are denormalized into pricing_simple already).
  - If the locations INSERT fails: return 500 with the Supabase error;
    do NOT proceed to pricing_simple. (No rollback needed - nothing
    written yet.)
  - If the pricing_simple INSERT fails after locations succeeded:
    return 500 with the error AND issue a best-effort DELETE of the
    just-inserted locations row by id. If the cleanup DELETE fails,
    return 500 with both errors and flag in the audit log that
    manual cleanup is needed (`{ "needs_manual_cleanup": true,
    "orphan_location_id": <id> }`). Document this in the Outcome.
  - Audit log: extend the existing `create_location` audit entry's
    `after` payload to include the new `location_id` (from the
    locations INSERT) and `address`.
  - Cache-invalidation TODO comment - same gap as Briefs 24/26/27.
    No new code; just confirm the existing TODO comment is still
    accurate after this brief's changes.

B.2 Worker: confirm the locations table actually has the columns this
brief assumes (`site_number` int, `site` text, `location` text,
`area_manager`, `regional_manager`, `am_email`, `rm_email`,
`site_email`). If the schema differs, surface in Outcome and adjust.

B.3 apps/web `AddLocationCard.tsx`:

  - Add `address` text input (optional) to the location-level fields
    section. Help text: "Street address. Stored on locations row +
    propagated to pricing_simple.address."
  - Make the `site` input required (was optional in Brief 24).
    Update the help text: "Site number (positive integer). Used as
    `locations.site_number`."
  - Pattern attribute for site: `pattern="[0-9]+"` for client hint.

B.4 apps/web `createLocationAction`:
  - Read the new `address` field from formData and include it in the
    JSON body.
  - Update the success message to include the new locations row id:
    `Location created: <code> (#<site_number>, <package_count>
    packages)`. Pull `location_id` and `package_count` from the
    worker response (now includes both).

### Part C - Claim form overlay clear on success

C.1 `apps/damage-worker/src/render/claim-form.ts`: in the inline
`<script>${FORM_SCRIPT}</script>` block, the `showOutcome` function
currently does:
  ```js
  function showOutcome(claimId) {
    formPage.hidden = true;
    outcomePage.hidden = false;
    outcomeClaimId.textContent = claimId || '(unknown)';
    // ... (rest)
  }
  ```
  Add `setSubmitting(false);` as the FIRST line of `showOutcome`,
  before the formPage/outcomePage hide/show. This both hides the
  overlay and re-enables the now-orphaned submit button (defensive;
  the form is hidden anyway, but consistent state is cheap).

C.2 Verify by reading the function that the only call sites for
`showOutcome` are the success path. If `showOutcome` is also called
from any other path (it shouldn't be), keep the `setSubmitting(false)`
at the top regardless - it's idempotent.

C.3 Don't change the overlay's HTML or CSS. Only the `showOutcome`
function body changes. (One-line addition.)

### Part D - Updates

D.1 BRIEFS/INDEX.md: Brief 29 row added; Briefs 26/27 row status
should reflect their actual completion status (this brief assumes
26/27 land first or in parallel - if executing this before
26/27, the executor should still be able to complete Part A and
Part C; Part B's `address` field doesn't depend on 26/27 but the
locations-row insert is independent of them).

D.2 BUILD_STATE.md: Last updated, Findings entry covering the three
fixes. Note that Brief 29 closes the locations-row gap that made
Brief 27's Update Location editor unable to find newly-created
locations.

D.3 CLAUDE.md: extend the sysadmin glossary entry to note that Add
Location now writes BOTH locations and pricing_simple atomically.

## Out of scope

- Backfilling locations rows for any previously-created locations
  that have pricing_simple rows but no locations row (e.g., the
  "Test" location in operator's test data). If the operator wants
  that backfilled, it's a one-shot SQL or a separate brief.
- Changing the H1 "MaxPass" branding on customer-facing
  signup-worker pages (operator decision needed; may be re-branded
  in a future cutover step).
- Cross-worker cache invalidation (Brief 28 owns this - still
  flagged as the future brief).
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- Browser tab title shows "Splash Tools" on all admin tool pages
  (apps/web at minimum; any worker-rendered admin shell tab titles
  if found)
- Customer-facing claim form, signup form, and 404 pages keep their
  context-specific tab titles unchanged
- Add Location form has an `address` field and `site` is required
- POST /sysadmin/api/pricing-simple/create-location now writes both
  locations and pricing_simple, in that order, with rollback DELETE
  on partial failure
- Claim form `Submitting claim, please wait...` overlay clears
  immediately when the outcome card renders
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Full list of "MaxPass" tab title hits found and which were changed
  vs. left as-is, with one-line rationale per file
- Whether the locations table schema matched assumptions; column
  list if it didn't
- Whether any pre-existing locations had unique constraints that
  would catch duplicate site_number / code (besides the explicit
  pre-checks)
- Bundle size delta on /admin/sysadmin (likely +0.2 kB from one
  extra input)
- Whether `showOutcome` was called from any path other than the
  success branch
- Validation results

## Outcome

Completed 2026-05-05. All three Definition-of-Done items shipped.

### Files modified

- `apps/web/app/layout.tsx` — Part A. `metadata.title` flipped from
  `"Splash MaxPass"` to `"Splash Tools"`. The favicon + description
  fields are unchanged.
- `apps/damage-worker/src/render/claim-form.ts` — Part C. One line
  added (`setSubmitting(false);`) as the first statement inside the
  inline FORM_SCRIPT's `showOutcome(claimId)` function (the body of
  `function showOutcome(...)` inside the template-literal script
  block at line 745). No HTML or CSS touched.
- `apps/sysadmin-worker/src/index.ts` — Part B (worker side).
  - Header comment for `POST /sysadmin/api/pricing-simple/create-location`
    extended to document Brief 29's locations-row + address +
    rollback behaviour.
  - `PricingSimpleInsertRow` interface gained `address: string | null`.
  - New `LocationsInsertRow` interface (site_number, site, location,
    area_manager, regional_manager, am_email, rm_email, site_email).
  - `handleCreateLocation`:
    - Reads new `address` body field (trim, empty → null).
    - `site` body field is now required and must parse to a positive
      integer (`Number.isInteger && > 0`); 400 errors for blank /
      non-numeric / non-positive cases.
    - Adds a `GET /rest/v1/locations?site_number=eq.{n}&select=id&limit=1`
      pre-check. Returns 409 "Location already exists in locations
      table" on hit.
    - INSERTs the locations row first via `POST /rest/v1/locations`
      with `Prefer: return=representation`; captures the returned
      `id` for the audit log + cleanup path.
    - THEN issues the existing pricing_simple bulk POST, with each
      row now carrying the new `address` field denormalized into
      pricing_simple (mirroring the existing am_email/rm_email/
      site_email/site/area_manager/regional_manager denormalization).
    - On pricing_simple failure: best-effort
      `DELETE /rest/v1/locations?id=eq.{insertedId}` rollback. If
      the DELETE also fails (or the cleanup `fetch()` throws), the
      worker writes an audit row with
      `action: "create_location_failed"`,
      `needs_manual_cleanup: true`,
      `orphan_location_id: <id>` and surfaces both the original
      pricing_simple error and the cleanup-failure note in the 500
      response body.
    - On success: audit log `after` payload extended to include
      `location_id`, `site_number`, and `address` alongside the
      existing `location_code` / `location_pretty` / `package_count`.
    - Worker JSON response shape gained `location_id` and
      `site_number` fields.
- `apps/web/app/admin/sysadmin/_components/AddLocationCard.tsx` —
  Part B (UI side).
  - `site` input gained `required`, `inputMode="numeric"`, and
    `pattern="[0-9]+"`. Help text reworded from "Optional" to
    "Positive integer. Used as locations.site_number."
  - New `address` input added to the location-level grid. Help
    text: "Street address. Stored on locations row + propagated
    to pricing_simple.address." The input is optional (no
    `required` attribute) — operators can leave it blank for
    locations whose street address isn't known yet.
- `apps/web/app/admin/sysadmin/actions.ts` — Part B (action side).
  - `CreateLocationBody` interface gained `address?: string | null`.
  - `createLocationAction` reads `address` from formData via
    `fieldOptionalNullable` and forwards it as `body.address`.
  - Success message extended: previously
    `"Location created: <code> (<package_count> packages)"`, now
    `"Location created: <code> (#<site_number>, <package_count> packages)"`.
    Reads `site_number` from the worker response if present;
    falls back to the package-count-only form when the worker
    didn't return one.
- `BRIEFS/INDEX.md` — Brief 29 row marked Completed (2026-05-05).
  No new rows added.
- `BUILD_STATE.md` — "Last updated" bumped; Findings entry added
  describing all three Parts; new prioritized work list row 29
  added with full one-line summary of what shipped.
- `CLAUDE.md` — sysadmin glossary entry extended to note that Add
  Location now writes BOTH `locations` and `pricing_simple` (with
  rollback semantics on pricing_simple failure) and accepts a new
  `address` field.

### Files created

None.

### Decisions made on the operator's behalf

1. **`address` lands in BOTH `locations.location` and
   `pricing_simple.address` on initial INSERT** — not relying on
   `trg_sync_pricing_simple` to backfill. Per Brief 27's spec the
   trigger fires `ON locations AFTER UPDATE` (not INSERT), so a
   fresh INSERT wouldn't propagate without a follow-up UPDATE. The
   brief itself called this out in Part B's bullet 3 ("don't rely
   on the trigger firing on INSERT") — confirming the design.
2. **`locations.site` is populated with `location_pretty`** (the
   display name like "Binghamton"), per the brief's payload spec
   and `packages/types/src/locations.ts:19`. `pricing_simple.site`
   continues to receive `stringOrNull(body.site)` (the form's site
   number text, e.g. "34") — the two columns named `site` mean
   different things by schema design.
3. **`location_code`-on-locations pre-check skipped.** The brief
   said "whichever column locations actually uses for code; if it
   has both site_number and a separate code/slug, check both." Per
   `packages/types/src/locations.ts`, `locations` has only
   `site_number` as a unique business key — no `location_code`
   column. So `site_number` is the only locations-side collision
   key and the pre-check uses only that arm.
4. **Best-effort rollback DELETE captures the inserted id from the
   `Prefer: return=representation` POST response.** If Supabase
   ever omits the id (older config, RLS quirks), the worker
   degrades gracefully to `orphan_location_id: null` in the audit
   row and `needs_manual_cleanup: true`.
5. **`needs_manual_cleanup` audit row is wrapped in try/catch.** If
   the audit insert ALSO fails (cascading failure), the worker
   silently swallows that — it doesn't want to mask the original
   500 with a third error. The 500 response still surfaces both
   the pricing_simple error AND the cleanup DELETE error in its
   body so the operator has the full picture.
6. **Site-number `pattern="[0-9]+"` + `inputMode="numeric"` is a UX
   hint only** — server-side validation in `handleCreateLocation`
   does the real `Number.isInteger() && > 0` check.
   `inputMode="numeric"` nudges the mobile keypad without forcing
   strict numeric type (the form value is still serialized as a
   string and parsed worker-side).
7. **`address` input is optional** (no `required` attribute on the
   client; worker accepts null) — operators may not have the
   street address at the moment they're standing up a new
   location's pricing.
8. **Tab-title audit determined the worker `<title>` tags are all
   customer-facing and stay unchanged.** None of the workers
   renders an admin-tool `<title>`. The single admin-tool tab
   title in the entire monorepo lives at
   `apps/web/app/layout.tsx:28`, and that's the one that flipped.

### Latent issues / forward flags

- **No `locations.site_number` unique constraint verified at the
  DB level.** The pre-check returns 409 if a row already exists,
  but if the DB constraint isn't enforced (or has a different
  name), a TOCTOU race between two simultaneous create-location
  calls could insert two rows with the same site_number.
  Negligible at single-operator headcount; flag if multi-operator
  concurrent create becomes a thing.
- **`trg_sync_pricing_simple` trigger behaviour on UPDATE not
  re-verified.** The brief stated `ON locations AFTER UPDATE`
  (also flagged in Brief 27); Brief 29 doesn't UPDATE locations,
  so trigger behaviour isn't exercised here. Smoke-test the
  Update Location → pricing_simple cascade once a Brief 29
  location is in production.
- **`pricing_simple.site` (form's site text, e.g. "34") will get
  overwritten by `locations.site` (display name, e.g.
  "Binghamton") if `trg_sync_pricing_simple` syncs that column on
  UPDATE.** This is consistent with Brief 26's documentation but
  worth re-verifying once the operator runs the full
  create-then-update cycle in production. If the trigger does
  overwrite, `pricing_simple.site` will end up as the display
  name after any locations-side edit — which may or may not be
  what the rest of the system expects.
- **`address` values are not normalized** (no shape validation,
  no zip parsing). Whatever the operator types is what's stored.
- **Cross-worker pricing cache invalidation gap is now in its
  FOURTH confirmation.** signup-worker still caches
  `pricing_simple_resolved` for 5 minutes; new Brief 29 locations
  still take up to 5 minutes to surface on the customer signup
  form. Brief 28 (separate from this one) tracks that work.
- **Order of pre-checks: pricing_simple → locations → INSERTs.**
  A race between two operators creating the same slug + same
  site_number (or different slug + same site_number) is not
  fully serialized; the operator headcount makes this irrelevant
  in practice, but worth knowing.
- **`location` column in `locations` is `text`** with no length
  constraint. Long addresses are accepted as-is.
- **Brief filename quirk surfaced and reconciled.** The brief was
  initially filed as `brief-028-...md` and self-titled "Brief
  28", but BUILD_STATE.md row 28 was already reserved for the
  cross-worker cache invalidation followup. The orchestrator /
  cowork tooling renamed the live file to
  `brief-029-tab-title-add-location-row-claim-overlay.md` and
  added a `brief-028-...md` tombstone redirecting to the 029
  filename. Both files exist in BRIEFS/; the 028 file is a
  pointer that says "do NOT execute it." Outcome was filled in
  on the 029 (live) file.

### Validation results

- `pnpm typecheck` — **13/13 successful**, 4.753s. 10 cached + 3
  fresh (`@splash/sysadmin-worker`, `@splash/web`, and
  `@splash/damage-worker` source changes invalidated turbo
  cache).
- `pnpm --filter @splash/web build` — **succeeded**. Next
  15.5.15 compiled in 5.2s, 12/12 static pages generated, all
  type checks green.

### Bundle deltas

- `/admin/sysadmin`: post-Brief-29 **7.05 kB / 112 kB First Load
  JS** (was **6.94 kB / 112 kB** post-Brief-27) — **+0.11 kB /
  +0 kB**, in line with the brief's "+0.2 kB" estimate. The
  delta is one extra `<input>` for address; the site input
  also gained `pattern` + `inputMode` attrs.
- All other route bundles are unchanged from the post-Brief-27
  snapshot.

### Brief Report answers

- **"Full list of MaxPass tab title hits found and which were
  changed vs. left as-is":**
  - `apps/web/app/layout.tsx:28` — `metadata.title: "Splash
    MaxPass"` → **changed to "Splash Tools"**. The single admin-
    tool tab title in the monorepo.
  - `apps/damage-worker/src/render/claim-form.ts:298` —
    `<title>Vehicle Issue Report — ${locationPretty}</title>`
    — **left as-is** (customer-facing claim form, location-
    specific title — not a "MaxPass" string).
  - `apps/damage-worker/src/render/claim-form.ts:840` —
    `<title>Claim Submitted — ${locationPretty}</title>` —
    **left as-is** (customer-facing thank-you page).
  - `apps/damage-worker/src/render/claim-form.ts:878` —
    `<title>Location Not Found</title>` — **left as-is**
    (customer-facing 404).
  - `apps/signup-worker/src/render/picker.ts:46` —
    `<title>${locationCode} – Choose Package</title>` — **left
    as-is** (customer-facing signup picker; not a MaxPass
    string).
  - `apps/signup-worker/src/render/form.ts:44` — `<title>Sign
    Up – ${pretty_pkg} – ${locationCode}</title>` — **left as-
    is** (customer-facing signup form; not a MaxPass string).
  - `apps/signup-worker/src/render/form.ts:60` — `<h1>${cap}
    MaxPass</h1>` — **left as-is** (h1 heading, not a tab
    title; out of scope per the brief's A.2).
  - `apps/web/app/admin/dashboard/page.tsx:40` — tile
    description string `"Manage MaxPass signup pricing across
    all locations."` — **left as-is** (description copy, not a
    tab title; out of scope).
  - `apps/web/app/admin/pricing/page.tsx:66` — body copy
    `"Pick a location to manage its MaxPass pricing."` —
    **left as-is** (page body, not a tab title).
  - `apps/web/app/_components/Header.tsx:71` — `aria-
    label="Splash MaxPass"` on the logo link — **left as-is**
    (accessible label for the brand mark; out of scope).
  - `apps/signup-worker/src/render/form.ts:288` — success
    modal copy `"MaxPass Success!"` — **left as-is** (modal
    copy on customer signup, not a tab title).
  - `apps/signup-worker/README.md:3` — README mention — left
    as-is (docs, not user-visible).
- **"Whether the locations table schema matched assumptions; column
  list if it didn't":** matched the brief's assumptions exactly.
  `packages/types/src/locations.ts` declares `site_number: number`,
  `site: string | null`, `location: string | null`,
  `area_manager: string | null`, `regional_manager: string | null`,
  `am_email: string | null`, `rm_email: string | null`,
  `site_email: string | null`, `hrt_email: string | null`,
  `rm_group: string | null`, plus `id: number` and the read-only
  `mla_location` / `hrt1` / `hrt2` / `fivestar` columns. No
  `location_code` column on `locations` — confirmed (Decision 3
  above).
- **"Whether any pre-existing locations had unique constraints that
  would catch duplicate site_number / code (besides the explicit
  pre-checks)":** not verified at the DB level (no live DB query
  from the headless session). The worker's pre-check against
  `?site_number=eq.{n}` is the only enforced uniqueness check from
  the worker side. If the DB carries a UNIQUE constraint on
  `site_number`, a TOCTOU race would surface as a Supabase
  constraint violation on the INSERT, which the worker would 500
  with the Supabase error message. Smoke-test the dup-site_number
  case once in production to confirm.
- **"Bundle size delta on /admin/sysadmin (likely +0.2 kB from one
  extra input)":** **+0.11 kB** (6.94 kB → 7.05 kB). First Load
  JS unchanged at 112 kB. Within the brief's estimate.
- **"Whether `showOutcome` was called from any path other than the
  success branch":** **no.** Single call site at
  `apps/damage-worker/src/render/claim-form.ts` inside
  `form.addEventListener('submit', ...)`'s `.then(...)` success
  branch (line 808: `showOutcome(out.body.claim_id || out.body.claimId || '');`).
  All error paths call `showError(...)` + `setSubmitting(false)`
  separately. The new `setSubmitting(false)` at the top of
  `showOutcome` is idempotent regardless.
- **Validation results:** see "Validation results" section above
  — `pnpm typecheck` 13/13, `pnpm --filter @splash/web build`
  succeeded.
