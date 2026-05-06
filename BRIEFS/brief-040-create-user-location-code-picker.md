# Brief 40: Sysadmin Create User — same location_code picker as Brief 39's Set Role

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Brief 39 added a `LocationCodePicker` to the Set Role
card but explicitly left the Create User card out of scope. Both
cards have the same problem (free-text `location_code` input
that requires the operator to remember exact slugs across ~67
locations). Operator wants the picker on both. This brief is the
trivial extension.
**Dependencies:** Brief 39 (the picker component + the worker
search endpoint it relies on). Brief 40 just wires the existing
component into a second card.

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-039-set-role-location-code-picker.md (Outcome -
  the picker component this brief reuses + the search endpoint
  it relies on; mirror the wiring exactly)
- apps/web/app/admin/sysadmin/_components/LocationCodePicker.tsx
  (built by Brief 39 — confirm shape before reusing)
- apps/web/app/admin/sysadmin/page.tsx OR
  apps/web/app/admin/sysadmin/_sections/UserOperations.tsx
  (wherever Brief 30 + Brief 39 left the Create User card)
- apps/web/app/admin/sysadmin/actions.ts (`createUserAction`
  reads `location_code` from FormData; no change needed)

## Context

Brief 39 added `LocationCodePicker` and wired it into the Set
Role card, replacing the free-text `<input>` for `location_code`.
The same input exists on the Create User card with identical
semantics: required only when the new user's role is
`location_admin`, ignored otherwise. The fix is one-line wiring,
no new component or worker endpoint.

## Scope

### Phase 1 — Replace the input on Create User

1.1 Find the Create User card in
`apps/web/app/admin/sysadmin/page.tsx` (or
`_sections/UserOperations.tsx` if Brief 30's mode-hub split
moved it). Locate the existing `location_code` text input —
it'll look like:

  ```tsx
  <input
    id="create-location-code"
    name="location_code"
    type="text"
    autoComplete="off"
    className={`${inputClass} font-mono`}
    placeholder="binghamton"
  />
  ```

1.2 Replace with:

  ```tsx
  <LocationCodePicker
    name="location_code"
    inputId="create-location-code"
  />
  ```

1.3 Add the import if not already present:
`import { LocationCodePicker } from "./_components/LocationCodePicker";`
(adjust path if the card lives in `_sections/`).

1.4 The help text below the picker stays the same:
> "Required only for location_admin role. Ignored for super_admin
> and no-role."

### Phase 2 — Updates

2.1 BRIEFS/INDEX.md: Brief 40 row added.

2.2 BUILD_STATE.md: Findings entry noting the picker is now on
both Create User and Set Role. Note that any future cards adding
a `location_code` input should use the picker by default.

2.3 If the executor finds OTHER places in the sysadmin UI that
take a free-text `location_code` (Update Package, Update
Location editors don't apply since they have their own search
flows; check the seven user-mgmt cards), apply the same picker.
Update this brief's Outcome to list every site converted.

## Out of scope

- Modifying the LocationCodePicker component itself. v1 is fine.
- Surfacing additional location fields in the picker dropdown
  (manager names, address, etc.). Brief 39 set the row format;
  this brief reuses it as-is.
- Multi-select. Single-location-per-user is the right shape.
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- Create User card uses `LocationCodePicker` instead of the
  free-text input
- Any other location_code free-text inputs in the sysadmin user
  cards (if any exist beyond Set Role + Create User) also
  converted, with each listed in the Outcome
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- List of every card converted (likely just Create User unless
  the executor finds others)
- Bundle-size delta on /admin/sysadmin (likely +0.1 kB or zero
  — same component, used twice)
- Validation results

## Outcome

**Cards converted (Phase 1 + Phase 2.3 audit):**
- **Create User** (`apps/web/app/admin/sysadmin/_sections/UserOperations.tsx`,
  `CreateUserCard`) — replaced the free-text `<input id="create-location-code"
  name="location_code" ...>` with `<LocationCodePicker
  name="location_code" inputId="create-location-code" />`. `FieldLabel` text
  changed from "Location code" to "Location"; helper updated to "Required
  only for location_admin role — search by site #, name, or code". The
  "Ignored for super_admin and no-role" footnote below the picker is
  preserved verbatim.

**Audit of other free-text `location_code` inputs in the sysadmin tree
(Phase 2.3):** none in the user-mgmt cards. Beyond Set Role (Brief 39,
already converted) and Create User (this brief), the only remaining
`name="location_code"` references in `apps/web/app/admin/sysadmin/`
are:
- `_components/AddLocationCard.tsx:86` — the input that DEFINES a
  brand-new `location_code` for a location being created. Search/picker
  semantics don't apply (the operator is creating a new code, not
  selecting an existing one). Out of scope per the brief's "Update
  Package, Update Location editors don't apply since they have their
  own search flows" carve-out.
- `_components/UpdatePackageCard.tsx:198` — a hidden input wired to
  `PackageSearchPicker` (Brief 36 Part C). Already a typeahead-driven
  flow; no change needed.

So only the Create User card was converted in this brief. The brief's
prediction ("likely just Create User unless the executor finds others")
held.

**Files modified:**
- `apps/web/app/admin/sysadmin/_sections/UserOperations.tsx` — one
  block replaced inside `CreateUserCard`. Import for `LocationCodePicker`
  was already present from Brief 39's Set Role conversion (line 16); no
  new import line.

**Files created:** none.
**Files deleted:** none.

**Decisions made on operator's behalf:**
1. **Same FieldLabel relabel as Brief 39** ("Location code" → "Location",
   helper rewritten to mention the search axes). Cosmetic parity between
   the two cards matters more than minimal-edit churn — operators
   shouldn't see "Location code" on one card and "Location" on the next
   when both pickers are functionally identical.
2. **No change to `createUserAction`** — the picker writes to the same
   `location_code` form field name the action already reads. The
   underlying validation (`location_code` regex pattern in the worker)
   is unchanged because the picker's hidden input emits the canonical
   slug verbatim.
3. **AddLocationCard left alone** — the brief's "any other free-text
   location_code inputs" sweep targeted the user-mgmt cards. AddLocation
   is a table-mgmt card AND its `location_code` input is a creation
   field (not a selection field), so the picker would be the wrong tool.

**Latent issues found:** none. Both pickers (Set Role + Create User)
share the same `LocationCodePicker` component file, so any future
behavior change made to the component (debounce timing, dropdown
density, additional fields surfaced in rows) will propagate to both
cards in one shot.

**Validation results:**
- `pnpm typecheck`: ✓ 13/13 successful, 4.96 s (12 cache hits, fresh
  build on `@splash/web` — `@splash/sysadmin-worker` was a cache hit
  this run since no worker code changed).
- `pnpm --filter @splash/web build`: ✓ Compiled successfully in 5.8 s.
  `/admin/sysadmin` bundle: **8.14 kB / 113 kB First Load JS** — **zero
  delta** vs. the post-Brief-39 baseline (8.14 kB / 113 kB). Same
  component used twice; Next code-splits the `LocationCodePicker` chunk
  once and references it from both cards. Inside the brief's "+0.1 kB
  or zero" predicted range.

## Report

- **Cards converted:** 1 — Create User. Set Role was converted in
  Brief 39; the audit confirmed no other free-text `location_code`
  inputs exist in the user-mgmt cards.
- **Bundle-size delta on `/admin/sysadmin`:** 0 kB / 0 kB First Load JS
  (8.14 kB → 8.14 kB; 113 kB → 113 kB). Zero — exactly as predicted.
- **Validation:** `pnpm typecheck` 13/13 green; `pnpm --filter
  @splash/web build` green.
