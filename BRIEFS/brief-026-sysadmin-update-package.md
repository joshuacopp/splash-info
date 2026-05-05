# Brief 26: Sysadmin - Update Package (pricing_simple search + per-row edit)

**Status:** Completed (2026-05-05)
**Started:** 2026-05-05
**Completed:** 2026-05-05
**Blocks:** Direct edit of per-package pricing values from sysadmin UI.
Brief 24 added create-location; this brief adds update-package
(per-row edit of an existing pricing_simple row identified by
composite PK). Brief 27 adds update-location (cascades via trigger).
**Dependencies:** Brief 24 (Add Location precedent), Brief 18 (search
typeahead pattern from UserPicker), Brief 19 (ActionForm result
pattern).

## Read first
- CLAUDE.md (especially the "pkg$ column name is intentional"
  critical constraint)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-024-sysadmin-add-location.md (Outcome - existing
  create-location surface; mirror its worker endpoint shape +
  validation pattern)
- BRIEFS/brief-018-damage-and-sysadmin-fixes.md (UserPicker shape
  for search-typeahead)
- BRIEFS/brief-019-action-result-refresh.md (ActionForm pattern)
- apps/sysadmin-worker/src/index.ts (existing handlers + audit log)
- apps/web/app/admin/sysadmin/page.tsx (current cards layout)
- apps/web/app/admin/sysadmin/actions.ts
- apps/web/app/admin/sysadmin/_lib/worker-fetch.ts
- packages/types/src/pricing.ts (PricingSimpleRowWithRawPrices etc.)

## Context

The `pricing_simple` table is per-package pricing (composite PK
`(location_code, pkg)` - one row per package per location). Operator
needs to edit pricing-specific fields (primarily `pkg$` and `single`,
also `flash2`, `flash5`, `sort`, `pkg`, `location_pretty`) without
opening Supabase SQL editor.

**Two trigger constraints from the database spec** drive the editor's
field set:

1. `trg_sync_pricing_simple` ON `locations` AFTER UPDATE syncs the
   denormalized columns (`area_manager`, `regional_manager`,
   `am_email`, `rm_email`, `site_email`, `address`) FROM locations
   INTO pricing_simple. **Editing those denormalized columns directly
   in pricing_simple gets silently reverted on the next
   locations-side update.** The Update Package editor MUST NOT
   expose them; users edit those via the Update Location editor
   (Brief 27).

2. `trg_sync_user_permissions` ON `pricing_simple` AFTER UPDATE syncs
   email changes to user_permissions. As a defense-in-depth, the
   Update Package editor's payload should never include the email
   fields (and the worker should reject them if present), so the
   trigger fires harmlessly with no actual diff.

**Editable fields in this editor** (the only fields the user can
touch):
- `pkg$` (numeric)
- `single` (numeric)
- `flash2` (numeric, default 2.00)
- `flash5` (numeric, default 5.00)
- `sort` (integer or null)
- `pkg` (text - composite PK part; changing it means PK change, see
  scope)
- `location_pretty` (display name - safe to edit; affects all rows
  for the location, but per-row UPDATE is fine)

**Read-only fields shown for context** (display only, no edit):
- `location_code` (composite PK; not editable - if it needs to change,
  the user should delete + re-create the location, separate brief)
- `site`, `area_manager`, `regional_manager`, `am_email`, `rm_email`,
  `site_email`, `address` - all denormalized from locations; tell the
  user "Edit via Update Location" with a small link/note.
- `updated_at` (read-only timestamp)

**Search shape**: `ilike` substring match against `location_code`,
`location_pretty`, and `site`. Returns up to 50 rows (a location can
have ~10 packages, so 50 covers ~5 locations of results - reasonable
typeahead bandwidth).

## Scope

### Part A - Worker side

A.1 Add **GET `/sysadmin/api/pricing-simple/search?q=<substring>`** to
`apps/sysadmin-worker/src/index.ts`:

  - super_admin gate (top-level fetch).
  - No isOriginAllowed gate on the GET (browsers omit Origin on
    same-origin GETs; per Brief 11b convention).
  - Query Supabase REST:
    `GET {SUPABASE_URL}/rest/v1/pricing_simple
       ?or=(location_code.ilike.%{q}%,location_pretty.ilike.%{q}%,site.ilike.%{q}%)
       &order=location_code.asc,sort.asc,pkg.asc
       &limit=50`
    with service-role headers.
  - Empty `q` (or whitespace-only): return `[]` (don't dump table).
  - Sanitize `q` against PostgREST `or()` separators: drop `,`, `(`,
    `)`, `*`, `%`, `_` (mirror UserPicker's escaping in Brief 18).
  - Returns array of rows with all displayed fields:
    ```ts
    interface PricingSimpleSearchRow {
      location_code: string;
      location_pretty: string | null;
      site: string | null;
      pkg: string;
      "pkg$": number;
      single: number | null;
      flash2: number | null;
      flash5: number | null;
      sort: number | null;
      pricing: string | null;
      // Read-only context fields (denormalized):
      area_manager: string | null;
      regional_manager: string | null;
      am_email: string | null;
      rm_email: string | null;
      site_email: string | null;
      address: string | null;
      updated_at: string | null;
    }
    ```

A.2 Add **PATCH `/sysadmin/api/pricing-simple/package`** to update one
row by composite PK:

  - super_admin gate + isOriginAllowed (POST/PATCH is state-changing).
  - JSON body shape:
    ```ts
    interface UpdatePackageBody {
      // Composite PK selectors (required):
      location_code: string;
      pkg: string;
      // Editable fields - all optional; only fields included in the
      // payload are updated. Send the entire form's values; Brief 26
      // doesn't bother with field-level dirty tracking.
      "pkg$"?: number;
      single?: number | null;
      flash2?: number | null;
      flash5?: number | null;
      sort?: number | null;
      pricing?: string;          // "full", "same", etc - existing pricing modes
      location_pretty?: string;  // affects display; per-row update
      pkg_new?: string;          // OPTIONAL: rename the pkg (composite PK change)
    }
    ```
  - Validation:
    1. `location_code` non-empty + matches `/^[a-z0-9_]+$/`.
    2. `pkg` non-empty.
    3. Numeric fields if present must be non-negative numbers (or
       null where nullable).
    4. `sort` if present must be positive integer or null.
    5. **Reject denormalized fields** with 400 if present in body:
       `area_manager`, `regional_manager`, `am_email`, `rm_email`,
       `site_email`, `address`. Error message: "Edit these via Update
       Location (Brief 27 endpoint). Trigger reverts changes here."
    6. Pre-check existence: `SELECT 1 FROM pricing_simple WHERE
       location_code = $1 AND pkg = $2 LIMIT 1`. Return 404 "Package
       not found" if no row.
    7. If `pkg_new` is present and differs from `pkg`: pre-check that
       `(location_code, pkg_new)` is not already taken. Return 409
       "Target package name already exists" otherwise.
  - On valid: build the PATCH payload (only the editable fields, NOT
    pkg_new). If `pkg_new` is present, do TWO operations atomically:
    - Issue the rename via Supabase REST PATCH on the (location_code,
      pkg) composite PK with `pkg = pkg_new` AND any other field
      changes in the same payload. Supabase REST supports composite
      PK matching via `?location_code=eq.X&pkg=eq.Y`.
    - Single atomic PATCH covers both the rename and any other field
      changes; no separate operations needed.
  - Send PATCH to Supabase REST:
    `PATCH {SUPABASE_URL}/rest/v1/pricing_simple?location_code=eq.{location_code}&pkg=eq.{pkg}`
    with service-role headers, `Content-Type: application/json`,
    `Prefer: return=representation`. Body is the editable fields only
    (mapping `pkg_new` -> `pkg` in the payload when renaming).
  - On Supabase 2xx: return `{ ok: true, location_code, pkg: <new
    or unchanged>, updated_at }`.
  - On Supabase non-2xx: surface the error.

A.3 Audit log entry for each PATCH:
  ```ts
  await logAudit({
    actor: session.email,
    action: "update_package",
    target_type: "pricing_simple",
    target_id: `${location_code}/${pkg}`,
    before: { ...the read-back row before the PATCH },
    after: { ...the new row from Prefer: return=representation },
  });
  ```
  Read the existing row pre-PATCH (one extra GET) to populate the
  before snapshot. If the existing logAudit signature differs, adjust
  to match (mirror Brief 24's pattern).

A.4 Cache invalidation TODO comment - same as Brief 24. signup-worker
caches the pricing_simple_resolved view; cross-worker bust isn't
wired. Flag in BRIEFS/INDEX.md as a future item.

### Part B - apps/web side

B.1 Add `searchPackages(q)` and `updatePackage(body)` to
`apps/web/app/admin/sysadmin/_lib/worker-fetch.ts`. Mirror the Brief
17/18 service-binding-with-URL-fallback pattern.

B.2 Add **PackageSearchPicker** client component at
`apps/web/app/admin/sysadmin/_components/PackageSearchPicker.tsx`.
Mirror UserPicker's contract (Brief 18):
  - Debounced 250ms typeahead → fetch `/sysadmin/api/pricing-simple/search?q=...`
  - Dropdown shows matching rows. Each row's row text:
    ```
    {location_code}/{pkg}  -  {location_pretty}  -  ${pkg$}/single ${single}
    ```
    Right-aligned timestamp `Updated: {YYYY-MM-DD}`.
  - Selecting a row populates a hidden `selected_row_json` field with
    the row data + sets visible state (selection chip).
  - aria-* combobox/listbox.
  - Empty query: no dropdown.
  - Failure: silent empty + small inline error.

B.3 Add a seventh card to `apps/web/app/admin/sysadmin/page.tsx`:
"**Update package**". Wraps in `<ActionForm
action={updatePackageAction}>`.

  Form layout:
    - Top: PackageSearchPicker. Until a row is selected, the rest of
      the form is hidden.
    - On selection: form inflates with the row's current values
      pre-filled. Editable inputs:
      - `pkg$` - number, step 0.01, required.
      - `single` - number, step 0.01, optional (null if blank).
      - `flash2` - number, step 0.01, default 2.00.
      - `flash5` - number, step 0.01, default 5.00.
      - `sort` - number (integer), optional (null if blank).
      - `pkg` - text, required (the composite-PK part; editing this
        renames the package). Help text: "Editing this renames the
        package row."
      - `location_pretty` - text, optional. Help text: "Display name
        on customer-facing surfaces."
      - `pricing` - select with options "full", "same", "flash5",
        "flash2", "special". Help text: "The pricing mode applied to
        this package row."
    - Read-only context block (small, below the editable section):
      Shows location_code (mono), site, area_manager, regional_manager,
      am_email, rm_email, site_email, address, updated_at. Above the
      block: small italic note "These fields are managed via Update
      Location (next card). Edits here would be reverted by the sync
      trigger."
    - Submit button: "Save changes". Cancel/Reset link: clears the
      picker, resets the form.

  Hidden inputs that travel with the submit:
    - `location_code` (from selection) - composite PK.
    - `pkg_original` (the pkg value at selection time) - so the
      worker knows what to look up before applying any pkg rename.
    - The form's editable `pkg` input maps to `pkg_new` on the
      worker side (renamed-or-unchanged).

B.4 Server action `updatePackageAction(prevState, formData)`:
  - Reads the form values, builds the JSON body, calls
    `sysadminPostJson("/sysadmin/api/pricing-simple/package", body)`.
    NOTE: the worker handles HTTP method dispatch separately
    (PATCH semantically, but if sysadminPostJson only does POST,
    expose a sysadminPatchJson helper or use POST with the worker
    treating the method-by-path).
  - On worker ok:
    ```ts
    return { ok: true, message: `Updated ${location_code}/${pkg}` };
    ```
  - On worker error: `{ ok: false, error: result.error }`.
  - revalidatePath("/admin/sysadmin").

### Part C - Updates

C.1 BRIEFS/INDEX.md: Brief 26 row marked Completed; add Brief 27 as
Not started.

C.2 BUILD_STATE.md: Last updated, Findings entry covering the new
search + update endpoints, the editable-vs-read-only field split
driven by the triggers, the cache-invalidation TODO.

C.3 CLAUDE.md: extend the sysadmin glossary entry with "Update
Package" capability + the trigger-driven read-only field rule.

## Out of scope

- Update Location (Brief 27 - separate).
- Bulk editing (multi-row update at once). Per-row v1.
- Soft-deleting a package row (DELETE not supported here).
- Adding a new package to an existing location (handled by Brief 24's
  create flow only at this point; could be a Brief 28 follow-up if
  needed).
- Renaming `location_code` (composite PK + cascading impact; separate
  brief if ever wanted).
- Cross-worker cache invalidation between sysadmin and signup
  (separate brief; flagged as TODO).
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- New worker handlers at GET /sysadmin/api/pricing-simple/search and
  PATCH /sysadmin/api/pricing-simple/package
- Worker rejects denormalized-field edits with 400
- Worker enforces composite-PK identity + new-pkg-name uniqueness
- New "Update package" card on /admin/sysadmin
- Search typeahead via PackageSearchPicker; rest of form hidden until
  selection
- Form pre-fills on selection; submits via ActionForm; success
  message includes location_code/pkg
- Read-only context block calls out trigger-managed fields
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Whether the existing sysadminPostJson supports PATCH or required a
  new helper
- Bundle-size delta on /admin/sysadmin from the new picker (likely
  +1-2 kB)
- Latent issues spotted in pricing_simple types or sysadmin-worker
- Validation results

## Outcome

### Files modified

- `apps/sysadmin-worker/src/index.ts`
  - Header comment block extended with the two new endpoints (GET search, PATCH update).
  - New `OWNED_PATCH_PATHS` set (`/sysadmin/api/pricing-simple/package`).
  - `OWNED_GET_PATHS` extended with `/sysadmin/api/pricing-simple/search`.
  - `fetch()` dispatch refactored:
    - Path validation now spans POST/PATCH/GET sets.
    - Per-category 405 method enforcement.
    - `isOriginAllowed` CSRF gate now applies to both POST and PATCH.
    - GET path → `handleSearchPricingSimple`.
    - PATCH path → `handleUpdatePackage`.
  - New `handleSearchPricingSimple` — empty/whitespace q → `[]`, sanitises against PostgREST `or()` separators (`,()*%_`), raw fetch to Supabase REST with `or=(location_code.ilike.%q%,location_pretty.ilike.%q%,site.ilike.%q%)&order=location_code.asc,sort.asc,pkg.asc&limit=50`, returns the array verbatim.
  - New `handleUpdatePackage` — composite-PK validation, denormalized-field 400-rejection, partial-PATCH payload assembly with literal `"pkg$"` key + nullable handling, optional `pkg_new` rename with collision pre-check (409), pre-PATCH SELECT for the `before` audit row + 404 on miss, single PATCH to Supabase REST with `Prefer: return=representation`, audit log `action: "update_package"` + `target_id: "${location_code}/${final_pkg}"`, response `{ ok, location_code, pkg, updated_at }`. Code-comment TODO flags the cross-worker cache invalidation gap.
- `apps/web/app/admin/sysadmin/_lib/worker-fetch.ts`
  - Header comment extended with Brief 26 paragraph on the PATCH variant.
  - `sysadminPostJson` refactored to delegate to a new private `sysadminWriteJson(method, path, body)` (avoids 70 lines of copy-paste between POST and PATCH paths).
  - New public `sysadminPatchJson` — thin wrapper that forwards method=PATCH.
  - Error-message string parameterised on the active HTTP method.
- `apps/web/app/admin/sysadmin/actions.ts`
  - Header comment lists Brief 26 + the new endpoint.
  - Import adds `sysadminPatchJson`.
  - New `updatePackageAction` — reads form fields (`location_code`, `pkg_original`, `pkg`, `location_pretty`, `pricing`, `pkg_dollar` + four nullable numeric fields), builds an `UpdatePackageBody` with literal `"pkg$"` key, sets `pkg_new` only when the editable `pkg` differs from `pkg_original`, coerces blanks to `null` for nullable columns, validates `sort` as a positive integer when present, calls `sysadminPatchJson`, returns `{ ok: true, message: "Updated <code>/<pkg>" }` on success.
- `apps/web/app/admin/sysadmin/page.tsx`
  - Header lists 7 cards + Brief 26.
  - `UpdatePackageCard` import added.
  - New `UpdatePackageOperationCard` server component wraps the client island in the existing `OperationCard` shell; rendered as the 7th card after Add Location.
- `BRIEFS/INDEX.md` — Brief 26 row marked Completed (2026-05-05) with the actual brief filename linked.
- `BUILD_STATE.md` — Last updated bumped to "Brief 26 completed"; Findings entry added; sysadmin row in apps/web pages table updated to reflect 7 cards + new bundle size; prioritized work list row 26 marked **completed** with full one-line summary.
- `CLAUDE.md` — sysadmin glossary entry rewritten: keeps the Brief 24 Add Location summary, adds the Brief 26 Update Package summary including the editable-vs-rejected field split driven by the `trg_sync_pricing_simple` trigger, points at Brief 27 (not yet started) for the denormalized-field path.

### Files created

- `apps/web/app/admin/sysadmin/_components/PackageSearchPicker.tsx` — client island. Mirrors `UserPicker` (Brief 18) shape: 250ms debounced fetch, dropdown with combobox/listbox aria roles, arrow key nav, Esc + outside-click dismiss, error banner on non-2xx. Differences from UserPicker: (1) selection state is held by the parent (UpdatePackageCard) via `selected` + `onSelect` props rather than internally, because the parent needs the full row data to inflate the form; (2) dropdown rows render `${location_code}/${pkg}` mono-bold + an "Updated YYYY-MM-DD" badge on the right + a secondary line with `${location_pretty} · $pkg$/single $single`; (3) selection chip shows the composite PK + price summary instead of an email. Exports `PricingSimpleSearchRow` interface for the parent's typing.
- `apps/web/app/admin/sysadmin/_components/UpdatePackageCard.tsx` — client island. Owns selection via `useState<PricingSimpleSearchRow | null>`. Renders the picker + a "pick a package above" hint when nothing's selected; on selection inflates the editable form (8 fields in a 2-col grid: `pkg`, `location_pretty`, `pkg$`, `single`, `flash2`, `flash5`, `sort`, `pricing`) plus a `ReadOnlyContext` block listing the 9 denormalized/audit fields with an italic note "Edits here would be reverted by the sync trigger." Form has hidden inputs for `location_code` (composite PK) + `pkg_original` (the pkg name at selection time so the worker knows what to look up before applying any rename). Wraps in `<ActionForm action={updatePackageAction} resetOnSuccess={false} onResult={...}>` — `resetOnSuccess={false}` because the form is keyed on the selection and we clear selection in `onResult` on success (the form unmounts when selection becomes null, which is simpler than relying on key-trick remount with stale defaultValues). Cancel link clears the selection without submitting. Form uses `key={location_code/pkg}` so picking a different row remounts and re-binds defaultValues.

### Decisions made on operator's behalf

1. **Worker uses PATCH semantically + a new `OWNED_PATCH_PATHS` dispatch set** rather than reusing POST. The brief listed PATCH first and offered POST only as a fallback "if sysadminPostJson only does POST". The dispatch refactor is small (~5 added lines) and matches REST convention; the downstream Supabase REST call is also PATCH, so the verbs line up end-to-end.
2. **`sysadminWriteJson(method, path, body)` extracted from sysadminPostJson** rather than duplicating the 70-line dual-mode body for sysadminPatchJson. Behaviour is identical except for the HTTP method on both transport paths and the error-message string. The public `sysadminPostJson` signature is preserved.
3. **PackageSearchPicker takes selection via props from the parent**, not held internally — the parent needs the full row to pre-fill 8+ inputs, which is impractical to thread through hidden inputs. UserPicker can hold its own selection because the surrounding form just needs a hidden user_id.
4. **Read-only context block uses `<dl>` semantics** with a 2-column grid; mono on `location_code` + `updated_at`, plain on the rest. Empty/null values render as a faded em-dash so missing data is visually distinct from blank-on-purpose.
5. **`pricing` mode select is required and pre-defaults to "full"** when the row's pricing column is null — defensive only; the schema is non-nullable.
6. **`single`, `flash2`, `flash5`, `sort` accept blank → null** because the schema permits null on these. `pkg$` and `pkg` are required.
7. **`pkg_new` is sent only when the editable `pkg` differs from `pkg_original`** — sending `pkg_new === pkg` would force the worker into the rename branch and trigger an unnecessary collision pre-check.
8. **On save success, the parent clears selection** (via `onResult` callback) rather than re-fetching the row. The picker returns to its empty state; operator picks the next package. Avoids "save shows old defaultValue" UX confusion.
9. **`OperationCard` description** mentions the editable fields directly so a super_admin sees what the card edits without expanding it.
10. **Cancel button is `type="button"` with onClick**, not an anchor — keeps scroll position stable and avoids a full page navigation.
11. **`PRICING_MODE_OPTIONS` hardcoded as a const tuple** rather than imported from `@splash/types` — importing a value (vs. type-only) into a client component pulls module exports into the bundle; the 5-string constant is cheaper inline.

### Latent issues / forward flags

- **Cross-worker cache invalidation gap (TODO)** — same as Brief 24. signup-worker caches `pricing_simple_resolved` for 5 minutes; package edits surface on the customer signup form within that window without operator action. Code-comment TODO points at the gap in `handleUpdatePackage`.
- **`pkg_original` is operator-supplied via the form**, not a server-stored token — a malicious super_admin could edit a different row by lying in the hidden input. Acceptable for v1 because a malicious super_admin can already issue any SQL via Supabase.
- **Read-only context fields show what the picker fetched at selection time** — they're not re-read during edit. Stale until the next picker pick if a parallel session updates the location.
- **Rename pre-check has a TOCTOU window** — a concurrent rename to the same target name could slip in between the collision SELECT and the PATCH. Worst case: Supabase returns a constraint violation 500 wrapped in our `Supabase update failed` shape. No data corruption. Negligible at the operator headcount.
- **`updated_at` is auto-managed by the schema's row-update trigger**; the worker doesn't set it explicitly. The PATCH response with `Prefer: return=representation` reflects whatever the trigger produced.
- **`address` column inclusion in `PricingSimpleSearchRow` is unverified** — the worker passes the row through Supabase verbatim. If `pricing_simple` doesn't have an `address` column, the field comes back as `undefined` and renders as an em-dash. No TS error because the worker boundary is `unknown`-passthrough; verify in production smoke.
- **`pkg_dollar` form-field name → `"pkg$"` JSON key mapping in the action** — same convention Brief 24 used; HTML form-name avoids the literal `$`.
- **Bundle delta within estimate.** `/admin/sysadmin` post-Brief-26: **5.6 kB / 111 kB First Load JS** (was 3.93 kB / 109 kB post-Brief-24) — **+1.67 kB / +2 kB**, in line with the brief's "+1-2 kB" estimate.

### Report (per brief's "## Report" section)

- **Q1: Did sysadminPostJson support PATCH?** No — required adding `sysadminPatchJson` plus a shared private `sysadminWriteJson(method, ...)` helper to avoid duplicating the dual-mode (service-binding + URL-fallback) body. Public sysadminPostJson signature preserved.
- **Q2: Bundle-size delta on /admin/sysadmin from the new picker?** +1.67 kB route / +2 kB First Load JS. PackageSearchPicker (~1 kB) + UpdatePackageCard form-inflate state (~0.6 kB) account for the delta; the form pre-fill machinery is mostly defaultValue strings which compress well.
- **Q3: Latent issues spotted in pricing_simple types or sysadmin-worker?**
  - `packages/types/src/pricing.ts`'s `PricingSimpleRowWithRawPrices` carries "NAME UNVERIFIED" caveats on `pkg$`/`single`/`flash5`/`flash2` that are now contradicted by Brief 24's INSERT contract and Brief 26's PATCH contract — those columns are confirmed real. A small docs-cleanup brief could remove the caveats. Not done here to keep scope tight.
  - The sysadmin-worker's top-of-`fetch()` dispatch is now spanning POST + PATCH + GET; the helper-set indirection works but a future brief could collapse the three sets into a `(method, path) → handler` map for cleaner growth.
  - The `address` column is referenced by the brief and the worker passes it through; the schema may not actually have it (see latent issues above).
- **Q4: Validation results?** `pnpm typecheck` 13/13 successful, 4.602s (11 cached + 2 fresh). `pnpm --filter @splash/web build` succeeded — Next 15.5.15 compiled in 5.8s, 12/12 static pages generated, all type checks green.
