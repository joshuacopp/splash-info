# Brief 39: Sysadmin Set Role — replace free-text location_code with searchable picker

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Set Role card on /admin/sysadmin currently has a
plain text input for `location_code` — operator has to remember
or guess the exact slug (e.g., `batavia_veterans`,
`whiteplainscentral`) and type it. Operator wants a typeahead
picker that searches by site number, location pretty name, OR
location_code substring, and writes the canonical
`location_code` value into the hidden form field on selection.
Mirrors the UserPicker pattern from Brief 18.
**Dependencies:** Brief 7 (the original Set Role card),
Brief 18 (UserPicker pattern this mirrors), Brief 26 (the
existing `GET /sysadmin/api/pricing-simple/search` endpoint
that's the closest existing data source), Brief 27 (the
`LocationsSearchPicker` component for cosmetic parity).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-018-damage-and-sysadmin-fixes.md (Outcome -
  UserPicker pattern: debounced 250ms typeahead, hidden
  `selected_value_json` input, chip + clear UX)
- BRIEFS/brief-026-sysadmin-update-package.md (Outcome -
  `PackageSearchPicker` similar pattern, plus the
  `GET /sysadmin/api/pricing-simple/search?q=` worker endpoint)
- BRIEFS/brief-027-sysadmin-update-location.md (Outcome -
  `LocationsSearchPicker` and `GET /sysadmin/api/locations/search`)
- BRIEFS/brief-036-test-batch-pdf-humanize-mobile-upload-multi-pkg.md
  (Part C may have added a thinner location-only search endpoint
  — check if it landed)
- apps/web/app/admin/sysadmin/page.tsx (Set Role card lives
  here, in the user-mode section after Brief 30's mode hub)
- apps/web/app/admin/sysadmin/_components/UserPicker.tsx (the
  reference implementation to mirror)
- apps/sysadmin-worker/src/index.ts (existing search handlers
  + audit log writes — relevant if a new endpoint is needed)

## Context

The Set Role card lets a super_admin set a user's role to
`super_admin`, `location_admin`, or clear it. When the role is
`location_admin`, a `location_code` is required so the new
permissions row knows which location the user manages.

The current input is a free-text field with a `pattern="[a-z0-9_]+"`
client-side hint and a placeholder of `binghamton`. Operator
needs to know the exact slug. With ~67 locations and the
underscore-vs-hyphen drift history (most use underscores per
Brief 33's normalization, but a few use no separator like
`coscob`/`whiteplainscentral`), this is error-prone.

Operator's request:
> location_code in set role on sysadmin needs to be searchable -
> search by 'site' varchar, and by text entry.

So the picker needs to match on:
- `site` (the varchar in pricing_simple, e.g., `"111"`,
  `"122"`) — substring or equality
- `location_code` (the canonical slug) — substring
- `location_pretty` (the display name like "Batavia Veterans")
  — substring

And on selection, the canonical `location_code` value is what
gets written to the hidden form input that the existing
`setRoleAction` reads.

## Scope

### Phase 1 — Worker side: distinct-locations search endpoint

1.1 If Brief 36 Part C already added a
`GET /sysadmin/api/pricing-simple/locations?q=` endpoint that
returns DISTINCT `(location_code, location_pretty, site)` tuples,
**reuse it**. Skip to Phase 2.

1.2 If not, add it now in
`apps/sysadmin-worker/src/index.ts`:

  - **GET `/sysadmin/api/pricing-simple/locations?q=<substring>`**
  - super_admin gate (top-level fetch).
  - No `isOriginAllowed` gate on GET (per Brief 11b convention).
  - Query Supabase REST against pricing_simple, but project to
    distinct location-level fields. PostgREST doesn't have a
    SQL `DISTINCT` directly, so the cleanest pattern is:
    ```
    GET {SUPABASE_URL}/rest/v1/pricing_simple
       ?select=location_code,location_pretty,site
       &or=(location_code.ilike.%{q}%,location_pretty.ilike.%{q}%,site.ilike.%{q}%)
       &order=site.asc
       &limit=200
    ```
    Then dedupe server-side in the worker by `location_code` (one
    row per code, keeping the first occurrence). Return up to 50
    distinct location entries.
  - Sanitize `q` per the existing pattern: drop `,`, `(`, `)`,
    `*`, `%`, `_`. Empty `q` → `[]`.
  - Response shape:
    ```ts
    interface LocationCodeSearchRow {
      location_code: string;
      location_pretty: string | null;
      site: string | null;
    }
    ```
  - 200 OK with the array; never 404.

1.3 Add the path to the OWNED_GET_PATHS allow-list and the
top-of-file URL header comment block.

### Phase 2 — apps/web side: LocationCodePicker component

2.1 Add `apps/web/app/admin/sysadmin/_components/LocationCodePicker.tsx`.
Mirror UserPicker's contract:

  ```ts
  interface LocationCodePickerProps {
    name: string;             // form field name (for hidden input)
    inputId: string;          // for the visible <input>'s id + label htmlFor
    required?: boolean;       // forwarded to the visible input
    initialValue?: string;    // pre-fill (e.g., editing case)
  }
  ```

2.2 UX behavior:
  - Visible `<input type="text">` debounced at 250ms; on each
    debounce tick, fetch
    `/sysadmin/api/pricing-simple/locations?q={typed}`.
  - Render dropdown of up to 50 rows. Each row shows
    `#{site}  ·  {location_pretty}  ·  {location_code}` (with
    `location_code` in mono font for visual distinction).
  - On row click: write `location_code` into a hidden input named
    `name`, replace the visible input with a selection chip
    (`#{site} {location_pretty}` + small "× Clear" link), close
    the dropdown.
  - "× Clear" reverts to the empty visible input + clears the
    hidden `name` value.
  - Empty query: no dropdown.
  - Keyboard nav: arrow up/down through rows, Enter to select,
    Escape to close. Mirror UserPicker exactly.
  - aria-* combobox/listbox; accessible labels.

2.3 Component is a client island (`"use client"`).

### Phase 3 — Wire into Set Role card

3.1 In `apps/web/app/admin/sysadmin/page.tsx` (or the appropriate
section file post-Brief-30 — `_sections/UserOperations.tsx`),
find the `SetRoleCard` function and replace the existing
`<input>` for location_code:

  - Old:
    ```tsx
    <input
      id="set-role-location-code"
      name="location_code"
      type="text"
      autoComplete="off"
      className={`${inputClass} font-mono`}
      placeholder="binghamton"
    />
    ```
  - New:
    ```tsx
    <LocationCodePicker
      name="location_code"
      inputId="set-role-location-code"
    />
    ```

3.2 The `setRoleAction` server action (in
`apps/web/app/admin/sysadmin/actions.ts`) already reads
`formData.get("location_code")` — no change needed there. The
picker's hidden input writes to that same name.

3.3 Help text below the picker stays the same:
> "Required for location_admin role. Ignored for super_admin
> and clear-role operations."

3.4 Don't apply this picker to the **Create User** card's
location_code input in this brief. That card has the same problem
but the fix is identical and out of scope here. Flag it as a
follow-up.

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 39 row added.

4.2 BUILD_STATE.md: Findings entry covering the picker + the
new endpoint (if added).

4.3 If a follow-up brief is needed for the Create User card +
any other location_code free-text inputs (Update Package,
Update Location editors don't apply since they have their own
search flows), file it as a TODO note in BUILD_STATE.md's
prioritized work list.

## Out of scope

- Replacing the location_code input on Create User (same fix,
  separate brief — flag in TODO).
- Adding location_code search to Grant Tool / Revoke Tool /
  Reset Password cards. Those don't take a location_code at
  all (per Brief 18, those cards use UserPicker for user_id
  selection only).
- Surfacing additional fields in the picker dropdown
  (area_manager, address, etc.). v1 is just enough to identify
  the location uniquely.
- Multi-select. v1 is single-location-per-grant.
- Don't deploy from headless. Operator pushes; CF Workers
  Builds redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- pnpm --filter @splash/sysadmin-worker build succeeds (if a
  new endpoint was added)
- New `LocationCodePicker` component exists, mirrors UserPicker
  contract + behavior
- Set Role card uses the picker instead of the free-text input
- `GET /sysadmin/api/pricing-simple/locations?q=` returns
  DISTINCT (location_code, location_pretty, site) rows with
  ilike substring search across all three fields
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Whether Brief 36 Part C already shipped the
  `pricing-simple/locations` endpoint, or if Brief 39 had to
  add it
- Bundle-size delta on /admin/sysadmin (likely +1-2 kB for the
  new picker)
- Validation results

## Outcome

**Phase 1 — Worker endpoint:** Brief 36 Part C did **not** ship a
distinct-locations endpoint (Part C reused the existing
`/pricing-simple/search` and deduped client-side in
`PackageSearchPicker`). Brief 39 added the new endpoint as specified.

**Files modified:**
- `apps/sysadmin-worker/src/index.ts` — added the
  `/sysadmin/api/pricing-simple/locations` route. URL header docblock
  extended; `OWNED_GET_PATHS` set extended; dispatch arm added in
  `fetch()`; `handleSearchPricingSimpleLocations` handler appended
  after `handleSearchPricingSimple`. Same sanitization (`%_,()*`
  stripped), same auth posture (super_admin, no `isOriginAllowed` on
  GET per Brief 11b convention), same Supabase REST shape but
  `select=location_code,location_pretty,site` and `order=site.asc`.
  PostgREST has no SQL `DISTINCT` projection, so the worker fetches up
  to 200 raw rows and dedupes server-side by `location_code` (first
  occurrence wins), capping the response at 50 distinct entries. The
  new `LocationCodeSearchRow` interface is local to the handler.
- `apps/web/app/admin/sysadmin/_sections/UserOperations.tsx` — `SetRoleCard`
  replaces the free-text `<input name="location_code">` with
  `<LocationCodePicker name="location_code" inputId="set-role-location-code" />`.
  `FieldLabel` text changed from "Location code" to "Location" with helper
  "Required for location_admin role — search by site #, name, or code".
  Help text below the picker preserved verbatim. New import added for
  `LocationCodePicker`.

**Files created:**
- `apps/web/app/admin/sysadmin/_components/LocationCodePicker.tsx` — the
  client island. Mirrors `UserPicker`'s contract: 250 ms debounce,
  hidden input named `name` carrying the canonical `location_code`,
  visible input replaced by a selection chip once a row is picked,
  combobox/listbox aria roles + arrow nav + Esc + outside-click dismiss.
  Each row in the dropdown shows `#{site} {location_pretty} {location_code}`
  with the canonical code in mono font. Empty/whitespace queries skip the
  fetch. `initialValue` prop pre-fills the selected chip with just the
  raw code (no pretty/site context — unused on the Set Role card today,
  but kept on the contract for symmetry with the brief's spec).

**Files deleted:** none.

**Decisions made on operator's behalf:**
1. **Visible input is replaced by the selection chip rather than
   sitting alongside it.** UserPicker shows both (input + chip below),
   but UserPicker's input is the primary search affordance and the chip
   is informational. For LocationCodePicker the chip *is* the resolved
   selection; leaving an empty input below it would be misleading
   (typing more would replace the resolved value). The "× Clear" link
   in the chip restores the input. This matches the operator's mental
   model better and is a cosmetic-only divergence from the UserPicker
   exact spec.
2. **`FieldLabel` text changed from "Location code" to "Location"** — the
   visible affordance is no longer a code-typed input, so "Location"
   describes what the operator is picking. The hidden form field name
   is still `location_code` (worker contract unchanged). Helper text
   adjusted to mention the search axes.
3. **Dedupe in the worker, not the client** — brief specified
   "DISTINCT location-level fields" as the response shape; doing it
   server-side keeps the client component thin and the response
   contract clean. The 200-row raw fetch / 50-row deduped cap matches
   the brief's example.

**Latent issues found:** none. The Create User card has the same
free-text `location_code` input (line 106-117 of UserOperations.tsx);
brief-040-create-user-location-code-picker.md is already queued to
fold the same picker into that card — no new follow-up needed here.

**Validation results:**
- `pnpm typecheck`: ✓ 13/13 successful (cache hit on 11, fresh build
  on `@splash/web` and `@splash/sysadmin-worker`).
- `pnpm --filter @splash/web build`: ✓ Compiled successfully in 6.7 s.
  `/admin/sysadmin` bundle: 8.14 kB / 113 kB First Load JS — delta of
  +1.08 kB / +1 kB vs. the post-Brief-30 baseline (7.06 kB / 112 kB),
  squarely in the brief's "+1-2 kB" predicted range.
- `pnpm --filter @splash/sysadmin-worker build`: package has no `build`
  script (`typecheck` is the build verification per the existing
  pattern); the typecheck pass above covers it.

## Report

- **Brief 36 Part C did not ship the endpoint** — Part C used
  client-side dedupe against the existing `/pricing-simple/search` in
  `PackageSearchPicker`. Brief 39 added the dedicated
  `/pricing-simple/locations` endpoint as specified.
- **Bundle delta on /admin/sysadmin: +1.08 kB / +1 kB First Load JS**
  (7.06 → 8.14 kB; 112 → 113 kB). Inside the brief's predicted range.
- **Validation:** typecheck 13/13 green; web build green.
