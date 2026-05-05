# Brief 24: Sysadmin - Add Location feature (pricing_simple bulk insert)

**Status:** Completed (2026-05-05)
**Started:** 2026-05-05
**Completed:** 2026-05-05
**Blocks:** Direct pricing_simple management from the sysadmin UI.
First of three pricing_simple/locations management features
(24=create location, 25=update package, 26=update location).
**Dependencies:** Brief 7 (sysadmin UI shell), Brief 18 (UserPicker
pattern reference for the "Add Location" form's repeated-row UX),
Brief 19 (ActionForm result pattern), Brief 20 (worker idempotency
return shape).

## Read first
- CLAUDE.md (especially the "pkg$ column name is intentional" critical
  constraint - the column literally has `$` in its name; SQL requires
  `"pkg$"` and code accesses via `row["pkg$"]` bracket notation)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-007-sysadmin-ui.md (Outcome - existing five-card layout)
- BRIEFS/brief-018-damage-and-sysadmin-fixes.md (UserPicker reference)
- BRIEFS/brief-019-action-result-refresh.md (ActionForm pattern)
- apps/sysadmin-worker/src/index.ts (existing handlers, audit log,
  super_admin gate at top of fetch())
- apps/web/app/admin/sysadmin/page.tsx (current five-card UI)
- apps/web/app/admin/sysadmin/actions.ts (existing server actions)
- apps/web/app/admin/sysadmin/_lib/worker-fetch.ts
- apps/web/app/admin/sysadmin/_components/NoAccessCard.tsx
- packages/types/src/pricing.ts (PricingSimpleRowWithRawPrices etc.)
- packages/db-supabase/src/<existing pricing_simple helper files,
  if any>

## Context

The operator wants direct pricing_simple management from the sysadmin
UI. Per the project glossary: sysadmin will house "direct
pricing_simple table editing (bypasses SQL for non-pricing-API
changes) and a manual cache-clear button." Brief 24 starts that with
the Add Location feature - inserting N rows (one per package) for a
new location in a single atomic Supabase REST POST.

The full spec including field classification, validation rules,
payload shape, SQL, and Supabase REST equivalent has been provided by
the operator and is the reference for this brief. Key callouts:

- **`pkg$` column name is load-bearing** (CLAUDE.md critical
  constraint #2). The spec confirms: SQL must double-quote it, JSON
  key is `"pkg$"`, code uses `row["pkg$"]` bracket notation. Do NOT
  rename, do NOT normalize.
- Composite primary key is `(location_code, pkg)`. Adding a location
  means inserting N rows.
- Supabase REST POST with a JSON array is atomic - either all rows
  insert or none.
- New locations default to `pricing = 'full'`. Server-side hardcoded;
  not user-selectable on creation.

This brief is Part 1 of 3:
  - **Brief 24 (this brief)**: Add Location
  - Brief 25 (deferred): Update package - search by location_code,
    edit pkg$/single primarily, also pkg/sort/other fields. ilike
    search, no SQL UI.
  - Brief 26 (deferred): Update locations table fields - triggers
    propagate am_email, area_manager, rm_email, regional_manager,
    site_email into pricing_simple and auth.

## Scope

### Part A - Worker side

A.1 Add `POST /sysadmin/api/pricing-simple/create-location` to
`apps/sysadmin-worker/src/index.ts`:

  - Owned-paths constant updated to include the new path under
    OWNED_POST_PATHS.
  - Handler `handleCreateLocation(request, env, session)`:
    - super_admin gate already at top-level fetch().
    - isOriginAllowed gate first (POST is state-changing).
    - Read JSON body shape:
      ```ts
      interface CreateLocationBody {
        location_pretty: string;
        location_code: string;
        site?: string | null;
        area_manager?: string | null;
        regional_manager?: string | null;
        site_email?: string | null;
        am_email?: string | null;
        rm_email?: string | null;
        packages: Array<{
          pkg: string;
          "pkg$": number;
          single: number;
          flash2: number;
          flash5: number;
          sort?: number | null;
        }>;
      }
      ```
    - Validation (return 400 with specific message on each):
      1. location_pretty non-empty.
      2. location_code matches `/^[a-z0-9_]+$/` (lowercase
         alphanumeric + underscores only, no spaces).
      3. Pre-check uniqueness: `SELECT 1 FROM pricing_simple WHERE
         location_code = $1 LIMIT 1`. If any row exists, return 409
         "Location code already in use".
      4. packages array length >= 1. Return 400 "At least one
         package is required" otherwise.
      5. For each package row:
         - `pkg` non-empty string.
         - `pkg$`, `single`, `flash2`, `flash5` are non-negative
           numbers.
         - `sort` if present must be a positive integer; if blank
           coerce to null.
      6. pkg names within the submission must be unique. Return 400
         "Duplicate package: {pkg}" on dup.
      7. Email fields if provided: validate format
         (`/^[^@\s]+@[^@\s]+\.[^@\s]+$/` or similar simple regex).
         Empty string -> coerce to null.
    - On valid: build the array of row objects (one per package),
      each with all the location-level fields repeated. Hardcode
      `pricing: 'full'`. Omit `todaydate` and `updated_at` (Postgres
      defaults).
    - POST to Supabase REST:
      ```
      POST {SUPABASE_URL}/rest/v1/pricing_simple
      Headers:
        apikey: {SUPABASE_SERVICE_KEY}
        Authorization: Bearer {SUPABASE_SERVICE_KEY}
        Content-Type: application/json
        Prefer: return=representation
      Body: <array of row objects>
      ```
    - On Supabase 2xx: return `{ ok: true, location_code,
      package_count }`.
    - On Supabase non-2xx: return 500 with the Supabase error text
      surfaced.

A.2 Audit log entry. Mirror the existing `logAudit` pattern from
`apiCreateUser`:
  ```ts
  await logAudit({
    actor: session.email,
    action: "create_location",
    target_type: "pricing_simple",
    target_id: location_code,
    before: null,
    after: { location_code, location_pretty, package_count: packages.length }
  });
  ```
  Verify the existing logAudit signature and field names; adjust if
  the new worker uses a different shape.

A.3 Cache invalidation - **flag as TODO follow-up**. The signup-worker
caches pricing_simple_resolved with a 5-minute TTL. Cross-worker
cache busting from sysadmin-worker isn't currently wired up. Add a
TODO comment in handleCreateLocation pointing at the gap, and
include "manual cache-clear button" as a future Brief item in
BRIEFS/INDEX.md.

### Part B - apps/web side

B.1 New sysadmin actions in `apps/web/app/admin/sysadmin/actions.ts`:

  - `createLocationAction(prevState, formData)` returning
    ActionResult (per Brief 19's pattern).
  - Reads form fields, builds the JSON body, calls
    `sysadminPostJson("/sysadmin/api/pricing-simple/create-location",
    body)`.
  - On worker ok: `{ ok: true, message: "Location created: " +
    location_code + " (" + package_count + " packages)" }`.
  - On worker error: `{ ok: false, error: result.error }`.
  - revalidatePath("/admin/sysadmin") so any future per-page state
    (e.g., a recent-creations list) refreshes.

B.2 Add a sixth card to `apps/web/app/admin/sysadmin/page.tsx`:
"**Add location**". Wraps in `<ActionForm
action={createLocationAction}>`.

  Form layout - two sections:

  **Location-level fields** (rendered once at the top of the form):
    - `location_pretty` - text input, required.
    - `location_code` - text input, required, with help text "lowercase
      letters, numbers, underscores only". Browser-side pattern
      attribute matching the regex for client-side feedback.
    - `site` - text input, optional.
    - `area_manager` - text input, optional.
    - `regional_manager` - text input, optional.
    - `site_email` - email input, optional.
    - `am_email` - email input, optional.
    - `rm_email` - email input, optional.

  **Packages section** (repeating rows). For v1, use a fixed-row
  approach with the standard package list pre-populated as 7 optional
  rows the user can toggle in/out via a checkbox column. Defaults from
  the spec:
    - bubble_bath (sort=1)
    - ultra_bath (sort=2)
    - bath (sort=3)
    - express (sort=4)
    - ext_exterior (sort empty)
    - extreme (sort empty)
    - works (sort empty)

  Each package row has columns: include checkbox, pkg name (read-only
  text), pkg$ number input, single number input, flash2 (default
  2.00), flash5 (default 5.00), sort (number or blank).

  Submit button "Create location".

  v1 trade: only the standard package list is supported. Ad-hoc
  package names beyond the 7 standard ones are deferred. If the
  operator needs a custom pkg name, they can use the (future) Update
  Package brief to add a row to an existing location, OR fall back to
  SQL once. Document this in the form's help text.

B.3 Server action wires the checked-row data into the JSON `packages`
array. Unchecked rows are excluded.

B.4 Pre-creation validation echoed client-side via HTML5 attributes
where possible:
  - `pattern="[a-z0-9_]+"` on location_code input.
  - `min="0"` on numeric inputs.
  - `step="0.01"` on price inputs.
  - `required` on the four price fields when the row's checkbox is
    checked. Use a small client component for the row to flip the
    required attrs based on the checkbox state. Mirror the
    UploadDocumentCard's conditional-required pattern from Brief 20.

B.5 Update `apps/web/app/admin/sysadmin/_lib/worker-fetch.ts` if
needed - sysadminPostJson already exists from Brief 7; no changes
expected.

### Part C - Updates

C.1 BRIEFS/INDEX.md - Brief 24 row marked Completed; add Briefs 25
and 26 as Not started in the prioritized work list (deferred but
planned per operator).

C.2 BUILD_STATE.md - bump Last updated, add Findings entry, list the
new endpoint + UI card. Note the cache-invalidation TODO and the
deferred Briefs 25/26.

C.3 CLAUDE.md - extend the sysadmin glossary entry to mention the new
direct-pricing_simple-editing capability.

## Out of scope (this brief)

- Update package values (Brief 25).
- Update locations table fields (Brief 26).
- Cross-worker cache invalidation between sysadmin and signup
  (separate brief; flagged as TODO).
- Custom (non-standard) package names beyond the 7 listed.
- Bulk import from CSV / Excel.
- Soft-deleting / archiving locations.
- Edit-after-create flow (covered by Brief 25).
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- New worker handler at POST /sysadmin/api/pricing-simple/create-location
  with super_admin + isOriginAllowed gates, full validation per spec,
  Supabase REST POST with `Prefer: return=representation`, audit log
  entry on success
- New "Add location" card on /admin/sysadmin with location-level
  fields + 7-row standard package picker + ActionForm result
  feedback
- pkg$ column accessed via bracket notation in TypeScript
  (`row["pkg$"]`); not renamed
- Validation on the worker side returns specific 400/409 messages
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Whether the existing logAudit signature matched the spec's
  `before/after` pattern or required adaptation
- Bundle-size delta on /admin/sysadmin from the new card and any
  client islands (likely +1-2 kB for the package-row conditional
  required attrs)
- Latent issues spotted in pricing_simple types or sysadmin-worker
- Whether a `getActiveLocationByCode`-equivalent helper for
  pricing_simple already exists or had to be added
- Validation results
- Anything Briefs 25 and 26 should know

## Outcome

### Files created

- `apps/web/app/admin/sysadmin/_components/AddLocationCard.tsx` — client
  island for the new sixth sysadmin card. `useState<boolean[]>` tracks
  per-row include state (default-on for the four standard-priced rows
  bubble_bath/ultra_bath/bath/express; default-off for ext_exterior/
  extreme/works). The include checkbox's `onChange` flips the corresponding
  entry, which drives both `disabled={!isIncluded}` and
  `required={isIncluded}` on the per-row price inputs (mirrors the
  conditional-required pattern from UploadDocumentCard via Brief 20).
  Renders the form via `<ActionForm action={createLocationAction}>` so
  inline success/error + router.refresh-on-ok behavior matches the
  existing five cards.

### Files modified

- `apps/sysadmin-worker/src/index.ts`
  - Header comment block now lists the new endpoint.
  - `OWNED_POST_PATHS` extended with
    `/sysadmin/api/pricing-simple/create-location`.
  - New switch arm → `handleCreateLocation`.
  - New `handleCreateLocation(env, body, actor)` function with full
    validation per spec (location_pretty non-empty, location_code regex
    `/^[a-z0-9_]+$/`, uniqueness pre-check via Supabase REST 409,
    packages array length ≥ 1, per-package non-empty `pkg` + non-negative
    `pkg$/single/flash2/flash5` + positive-integer `sort` + duplicate-pkg
    detection, optional email shape via `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`).
  - Atomic Supabase REST array POST with `Prefer: return=representation`;
    on 2xx writes a `logSysadminAudit` entry
    (`action: "create_location"`, `target_type: "pricing_simple"`,
    `target_id: location_code`, `before: null`,
    `after: { location_code, location_pretty, package_count }`) and
    returns `{ ok: true, location_code, package_count }`.
  - Cross-worker cache-invalidation TODO comment added in the docblock
    (signup-worker caches pricing_simple_resolved for 5 minutes).
  - New module-local `nonNegativeNumber` helper.
- `apps/web/app/admin/sysadmin/page.tsx`
  - Header comment lists 6 cards.
  - `AddLocationCard` import added.
  - New `AddLocationOperationCard` server component wraps the client
    island in the existing `OperationCard` shell.
- `apps/web/app/admin/sysadmin/actions.ts`
  - Header comment extended.
  - New `createLocationAction(prevState, formData)` reads location-level
    fields + iterates 7 standard package indices, skips rows whose
    include checkbox isn't checked, builds the JSON body with literal
    `"pkg$"` key, POSTs via
    `sysadminPostJson("/sysadmin/api/pricing-simple/create-location", body)`,
    surfaces `{ ok: true, message: "Location created: <code> (<count> packages)" }`
    or `{ ok: false, error }`.
  - Helpers added: `STANDARD_PACKAGES` constant, `fieldNumber`,
    `fieldOptionalNullable`.
- `BRIEFS/INDEX.md` — Brief 24 row marked Completed (2026-05-05);
  Briefs 25 + 26 added as Not started.
- `BRIEFS/QUEUE.md` — brief-024 line commented out.
- `BUILD_STATE.md` — bumped Last updated; Findings entry added; pages
  table sysadmin row updated to reflect 6 cards + new bundle size;
  prioritized work list rows added for 24/25/26.
- `CLAUDE.md` — sysadmin glossary entry extended to mention Brief 24's
  Add Location feature + the cross-worker cache-invalidation TODO.

### Decisions made on the operator's behalf

1. **Worker uses raw `fetch` to Supabase REST**, not the supabase-js
   client, for the bulk insert. Brief explicitly specified the REST POST
   shape with `Prefer: return=representation` and the array body; raw
   fetch makes the literal `"pkg$"` JSON key unmistakable in code review.
   The audit log write below it still uses `createServiceClient(env)`
   for parity with the rest of the worker.
2. **Pre-check uniqueness on `location_code` only**, not the full
   composite `(location_code, pkg)` PK. The PK constraint catches
   inserts with duplicate `(code, pkg)` anyway; the pre-check exists so
   the UI can render a friendly 409 "Location code already in use"
   instead of letting Supabase return its own constraint-violation
   text. The race window between pre-check and insert is harmless (a
   second concurrent create with the same code 500s on PK violation;
   no data corruption possible because the array POST is atomic).
3. **`nonNegativeNumber` accepts numeric strings** (e.g., "12.50") in
   addition to JS numbers — defensive coercion at the worker boundary
   is cheap.
4. **`sort` validation requires positive integer** — non-integer floats
   reject with 400.
5. **Email regex is intentionally simple** — captures common typos
   without overreach; brief allowed "or similar simple regex".
6. **Empty/whitespace optional fields coerce to null** via
   `stringOrNull` (worker) + `fieldOptionalNullable` (action).
7. **`pkg$` literal column name preserved end-to-end:** TS interface
   `PricingSimpleInsertRow["pkg$"]`, JSON body literal `"pkg$"` key,
   FormData field name `pkg_<i>_pkg_dollar` (sanitized for HTML — `$`
   is legal in form names but using `pkg_dollar` sidesteps any tooling
   that might choke on `$`). The action maps `pkg_<i>_pkg_dollar` →
   `"pkg$"` exactly once at the JSON-body step.
8. **`pricing: 'full'` is hardcoded server-side**; never reads from
   body — operator has no way to create a location at any other
   initial mode.
9. **`createLocationAction` returns the worker's `location_code` +
   `package_count`** from the response body (falls back to inputs if
   the worker's response shape is wrong).
10. **Disabled price inputs on unchecked rows** (rather than removing
    them from the DOM) — keeps the column-aligned grid layout stable
    when toggling.
11. **No client-side row count display** — the worker reports the count
    back in the success message.

### Latent issues / forward flags

- **Cross-worker cache invalidation gap (TODO).** signup-worker caches
  `pricing_simple_resolved` for 5 minutes via `caches.default`;
  sysadmin-worker has no way to bust that cache today. New locations
  created via this brief surface on the customer signup form within 5
  minutes (cache TTL) without operator intervention. A code-comment
  TODO in `handleCreateLocation` points at the gap; "manual cache-clear
  button" was listed in the brief but is not yet added as a numbered
  brief in INDEX.md (operator decision).
- **Custom (non-standard) package names not supported in v1.** The 7
  standard packages are baked into AddLocationCard. Custom names defer
  to Brief 25 (Update Package) or a one-shot SQL.
- **Edit-after-create flow** is Brief 25's responsibility — Brief 24 is
  create-only.
- **No `getActiveLocationByCode`-equivalent helper for pricing_simple**
  exists in `@splash/db-supabase`; the worker's pre-check is inlined raw
  fetch. Adding a typed `locationExistsByCode(client, code) -> boolean`
  helper is a small follow-up and would also benefit Brief 25's
  search-by-location_code path. Not added here to keep scope tight.
- **`PricingSimpleRowWithRawPrices` in `packages/types/src/pricing.ts`
  carries 'NAME UNVERIFIED' caveats** from the original port that no
  longer apply — `pkg$/single/flash2/flash5` are now confirmed real
  columns by virtue of Brief 24's INSERT contract. A small docs
  cleanup brief could remove those caveats; not done here.
- **No CSV/Excel bulk import** — out of scope.
- **No soft-delete / archive flow** — out of scope.

### Validation results

- `pnpm typecheck` — **13/13 successful**, 5.684s (10 cached + 3 fresh:
  apps/sysadmin-worker + apps/web + propagated turbo invalidations).
- `pnpm --filter @splash/web build` — **succeeded**. Next 15.5.15
  compiled in 5.9s; 12/12 static pages generated; lint + type checks
  green.

### Report answers

- **`logSysadminAudit` signature match:** matched the spec's
  `before/after` pattern exactly. The worker's local `actor` object
  (`{ id, email }`) extracted from `auth.session` at the top-of-`fetch`
  is the same shape `logSysadminAudit` accepts via its `AuthUser`-lite
  contract; no adaptation needed.
- **Bundle-size delta on /admin/sysadmin:** 161 B → 3.93 kB on the route
  / 105 kB → 109 kB First Load JS (+3.77 kB route, +4 kB First Load).
  Driven by AddLocationCard's React-state include toggles (7 rows ×
  1 useState slot + onChange handler each; the React state machinery
  itself is the dominant cost). The brief's estimate of "+1-2 kB" was
  low; the seven independently-toggleable rows + conditional
  `required`/`disabled` propagation pushed it higher.
- **Latent issues spotted:** see "Latent issues / forward flags" above.
  Notable for Brief 25/26: the unverified `pkg$/single/flash2/flash5`
  caveats in `packages/types/src/pricing.ts` are now stale; a typed
  `locationExistsByCode(client, code)` helper would clean up the
  inlined REST pre-check in this brief and serve Brief 25's
  search-by-location_code search.
- **`getActiveLocationByCode`-equivalent for pricing_simple:** does
  NOT exist today. The worker uses an inlined raw Supabase REST
  `pricing_simple?location_code=eq.<code>&limit=1` SELECT for the
  uniqueness pre-check.
- **Anything Briefs 25 and 26 should know:**
  - The REST pre-check pattern in Brief 24 is the natural starting
    point for Brief 25's search-by-location_code; consider extracting
    a typed helper before either brief lands.
  - The `clearApprovalDetails`-style flag is unlikely to apply, but
    the per-row repeated UI pattern (PACKAGE_ROWS array + indexed
    FormData fields) is reusable for Brief 25's per-package edit.
  - Cache invalidation gap remains until a separate brief addresses
    it; Briefs 25 + 26 will inherit the 5-minute TTL window for any
    pricing_simple changes they introduce.
