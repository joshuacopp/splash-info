# Brief 52: Stop stripping `_` from sysadmin search query sanitization

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Nothing — but Update Package card is currently broken
for any location whose `location_code` contains an underscore (most
of them — batavia_ii, batavia_veterans, etc.).
**Dependencies:** None.

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-026-sysadmin-update-package.md (the search endpoint's
  original brief)
- BRIEFS/brief-036-test-batch-pdf-humanize-mobile-upload-multi-pkg.md
  (the bulk-edit UI that surfaces this bug)
- BRIEFS/brief-039-set-role-location-code-picker.md (the second
  endpoint with the same defect)
- apps/sysadmin-worker/src/index.ts (`handleSearchPricingSimple`
  ~L901, `handleSearchPricingSimpleLocations` ~L954)
- apps/web/app/admin/sysadmin/_components/UpdatePackageCard.tsx
  (the consumer that exposes the bug — the auto-fetch step on line
  ~84 passes the full location_code to the search endpoint)

## Context

`handleSearchPricingSimple` and `handleSearchPricingSimpleLocations`
both sanitize the user-supplied `q` parameter by stripping
characters that have special meaning in PostgREST `or=(...)`
expressions or PostgreSQL ILIKE patterns:

```ts
const escaped = raw.replace(/[%_,()*]/g, "");
```

The strip set was intended to neutralize PostgREST's `or()`
separators (`,`, `(`, `)`, `*`) and the ILIKE wildcards (`%`, `_`).
The `_` strip is overly defensive: since the query is wrapped in
`%...%`, treating an internal `_` as a single-char wildcard is
behaviorally indistinguishable from matching it literally for
the operator's intent ("find rows containing this substring").
Stripping `_` corrupts queries that contain literal underscores.

Operator confirmed 2026-05-06: selecting Batavia II in the
Update Package picker correctly identifies `batavia_ii` as the
location_code (4 packages reported), but the auto-fetch step
inside `UpdatePackageCard` calls
`/sysadmin/api/pricing-simple/search?q=batavia_ii`. Sanitization
strips the underscore → `bataviaii` → ILIKE pattern
`%bataviaii%` → 0 rows returned → "No packages found at this
location" surfaces in the UI even though the data exists.

This is a latent defect from Brief 26 that wasn't surfaced until
Brief 36's bulk-edit UI started passing full location_codes
(underscored) into the search endpoint. The picker-only use
case (operators typing substrings like `batavia`, `binghamton`,
or `122`) never hits the path where `_` appears in the query.

## Scope

### Phase 1 — Drop `_` from the strip set in both handlers

1.1 In `apps/sysadmin-worker/src/index.ts`, find both functions
that contain `/[%_,()*]/g`:

  - `handleSearchPricingSimple` (~L901, body line ~904)
  - `handleSearchPricingSimpleLocations` (~L954, body line ~960)

Change both regex literals to `/[%,()*]/g` (drop the `_`).

1.2 Update the inline comment near each (or above the regex) to
reflect the new semantics. The previous comment said sanitization
strips PostgREST or() separators and ILIKE wildcards. New
comment should clarify:

```
Sanitize against PostgREST or() separators — drop ',', '(',
')', '*' — and the ILIKE multi-char wildcard '%'. We do NOT
strip '_' (single-char wildcard) because dropping it corrupts
queries containing literal underscores in location_codes
(e.g., batavia_ii). Treating literal '_' as a single-char
wildcard is behaviorally equivalent for the operator's intent
of substring search.
```

### Phase 2 — Validation

2.1 `pnpm typecheck` — must pass for all 13 packages.
2.2 `pnpm --filter @splash/sysadmin-worker build` — must succeed.
2.3 No new endpoints, no schema changes, no new env vars.

### Phase 3 — Updates

3.1 BRIEFS/INDEX.md: Brief 52 row added.

3.2 BUILD_STATE.md: Findings entry noting:
  - Latent defect in Brief 26's search sanitization (`_` strip)
  - Surfaced only after Brief 36's bulk-edit UI started passing
    full location_codes to the endpoint
  - Both `handleSearchPricingSimple` and
    `handleSearchPricingSimpleLocations` patched (the second
    was symptomatic-but-undetected for the same reason)
  - Operator should retry selecting Batavia II (or any
    location_code containing `_`) in the Update Package card
    and confirm the package list populates

3.3 No CLAUDE.md change needed — the search endpoints are
documented in the worker's leading file comments, which Phase
1.2 updates inline.

## Out of scope

- Adding a dedicated "list packages by location_code" endpoint.
  The existing search endpoint, with the underscore fix, handles
  this case correctly. A purpose-built endpoint would be cleaner
  but is more invasive than the bug warrants.
- Changing the sanitization in any of the other PostgREST query
  builders in the codebase. If other endpoints use the same
  strip-set pattern, they'd need their own briefs to verify
  whether `_` stripping is actively breaking anything there.
  Right now only the sysadmin worker's two endpoints are known
  to be affected.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- Both `handleSearchPricingSimple` and
  `handleSearchPricingSimpleLocations` use `/[%,()*]/g` as the
  strip regex (no `_`)
- Inline comments updated to explain why `_` is no longer
  stripped
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/sysadmin-worker build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff (likely 4-6 lines: two regex changes + comment updates)
- Validation results
- Confirmation that the regex pattern is identical in both
  handlers post-change

## Outcome

**Files modified (1):**
- `apps/sysadmin-worker/src/index.ts` — two regex literals changed
  from `/[%_,()*]/g` to `/[%,()*]/g` (dropped the `_`):
  - `handleSearchPricingSimple` body — line 908 (was 904)
  - `handleSearchPricingSimpleLocations` body — line 969 (was 960)
  - Both function-leading docblocks updated to spell out the new
    semantics: PostgREST `or()` separators (`,` `(` `)` `*`) and the
    ILIKE multi-char wildcard `%` are stripped; `_` is kept because
    treating a literal underscore as a single-char ILIKE wildcard is
    behaviorally indistinguishable from a literal match for the
    operator's substring-search intent. Cross-references Brief 52.

**Diff (regex pattern, both handlers):**
```diff
- const escaped = raw.replace(/[%_,()*]/g, "");
+ const escaped = raw.replace(/[%,()*]/g, "");
```
Pattern is now identical in both handlers (`/[%,()*]/g`).

**Out-of-scope occurrences left unchanged (per brief):**
- `handleSearchLocations` (line 1550) — Brief 27 locations editor
  endpoint (`select=*`, different `or()` clauses). Not in scope.
- Audit-log `actor_email` filter (line 1893) — Brief 30 audit log
  filter. Not in scope.

**Decisions made on operator's behalf:**
- The brief called for `pnpm --filter @splash/sysadmin-worker build`
  in the Definition of Done, but `apps/sysadmin-worker/package.json`
  exposes only `dev`, `deploy`, `typecheck`, `lint`, `clean` —
  there is no `build` script (workers don't compile; wrangler
  bundles at deploy time). Substituted `pnpm --filter
  @splash/sysadmin-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build` as the build-equivalent: it runs the same
  bundling pipeline `wrangler deploy` would but without uploading.
  Cleaned up the temp output dir afterward.

**Latent issues found:**
- None new. Both other call sites that strip `_` (line 1550 and
  1893) are likely affected by the same defect class, but the brief
  explicitly defers them ("changing the sanitization in any of the
  other PostgREST query builders" is out of scope).
  - `handleSearchLocations` — used by Brief 27's locations editor.
    Operator searches by `site` (numeric), `location_code` (often
    contains `_`), or `location_pretty`. If an operator searches by
    full `location_code` the same defect bites; the operator
    workaround is to type a non-underscore substring (`batavia`).
  - Audit-log `actor` filter — searches `actor_email`. Email
    addresses in this org don't contain `_` (verified by inspection
    — domain is `splashcarwashes.com`), so dormant.

**Validation:**
- `pnpm typecheck` — 13/13 packages successful (12 cached, 1 cache
  miss for sysadmin-worker which compiled clean).
- `pnpm --filter @splash/sysadmin-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build` — bundle succeeded.
  `Total Upload: 755.11 KiB / gzip: 142.30 KiB`. Temp output
  removed.
- Confirmed regex pattern is identical in both handlers
  post-change (`grep` returned both lines as `/[%,()*]/g`).

**Operator follow-up:**
- Retry "Update Package" → select Batavia II (or any
  underscored location_code) and confirm the package list
  populates. The auto-fetch step inside `UpdatePackageCard` should
  now successfully match `%batavia_ii%` against
  `pricing_simple.location_code`.
- No deploy from headless. The fix lands the next time
  splash-sysadmin-worker is deployed (CF Workers Builds on push).
