# Brief 62: Fix `getMaintainXLocationId` two-step join — match `locations.site_number`, not `locations.site`

**Status:** Completed (2026-05-07)
**Started:** 2026-05-06
**Completed:** 2026-05-07
**Blocks:** Every MaintainX work order created from a damage
claim — both the customer-submission path (Brief 42) and the
GM-side equipment override modal path (Brief 43) — currently
ships without a `locationId` field. Operator screenshot
2026-05-07 shows MaintainX's Location column blank ("—") for
every recent damage-claim WO. Operations and finance lose
location attribution.
**Dependencies:** Brief 42 (the helper this brief fixes), Brief
49 (the parallel helper that hit the same bug class).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-042-maintainx-workorder-on-equipment-related.md
  (the brief that introduced the helper)
- BRIEFS/brief-043-gm-equipment-related-modal-on-approve.md
  (the second consumer of `createMaintainXWorkOrder` — same
  helper, same bug)
- BRIEFS/brief-049-getlocationcontactinfo-read-from-pricing-simple.md
  (the parallel helper that hit the same `pricing_simple.site
  → locations.site` join bug; documents the data-shape
  divergence)
- packages/db-supabase/src/locations.ts (the file with the bug;
  `getMaintainXLocationId` ~L84-L145)
- apps/damage-worker/src/maintainx.ts (the consumer; the
  `body.locationId` set at L133-L135 is conditional on
  `maintainxLocationId != null`, which is why the bug surfaces
  as a missing field rather than a 4xx)

## Context

`getMaintainXLocationId` does a two-step Supabase lookup:

1. `pricing_simple` filtered by `location_code` → returns `site` (text)
2. `locations` filtered by `site=eq.<step 1's site>` → returns `maintainx_id`

Operator confirmed 2026-05-06 (in Brief 49's context) that:
- `pricing_simple.site` is `"147"` (the 3-digit site_number text;
  populated by the `trg_sync_pricing_simple` trigger from
  `locations.site_number::text`)
- `locations.site` is `"Oswego"` (the location name — a different
  field from `site_number`)

So step 2's `site=eq."147"` returns zero rows because no
locations row has `site = "147"`. The helper falls through to its
fail-soft branch and returns `null`. The damage worker's
null-guard at `apps/damage-worker/src/maintainx.ts:133` then
omits `body.locationId` from the WO POST, and MaintainX creates
the work order without a Location attribution.

This is the same bug class Brief 49 fixed for `getLocationContactInfo`.
The patch shape mirrors Brief 49's: change the second-step query
to match against `locations.site_number` (the actual key) instead
of `locations.site` (the wrong column).

We're NOT mirroring Brief 49's "single query off pricing_simple"
fix because `pricing_simple` doesn't carry `maintainx_id` —
that column is only on `locations`. So step 2 has to stay; we
just fix the join key.

## Scope

### Phase 1 — Fix the join key

1.1 In `packages/db-supabase/src/locations.ts`, locate
`getMaintainXLocationId` (~L84). Find the step-2 query block
that builds the `locations` URL (~L122-L125):

```ts
const locUrl = new URL("/rest/v1/locations", env.SUPABASE_URL);
locUrl.searchParams.set("site", `eq.${site}`);
locUrl.searchParams.set("select", "maintainx_id");
locUrl.searchParams.set("limit", "1");
```

Change `"site"` to `"site_number"` in the searchParams set:

```ts
const locUrl = new URL("/rest/v1/locations", env.SUPABASE_URL);
locUrl.searchParams.set("site_number", `eq.${site}`);
locUrl.searchParams.set("select", "maintainx_id");
locUrl.searchParams.set("limit", "1");
```

1.2 Update the docblock above the function (~L66-L83) to reflect
the corrected join. The existing comment says:

```
We resolve the slug → `site` via `pricing_simple` first,
then look up `locations.maintainx_id` by that `site`.
```

Replace with:

```
We resolve the slug → `pricing_simple.site` (which is the
denormalized site_number text — e.g., "147" — populated by
the trg_sync_pricing_simple trigger from
locations.site_number::text), then look up
`locations.maintainx_id` by `site_number=eq.<that value>`.

The earlier (broken) version of this helper queried
`locations.site=eq.<value>` which mismatches because
`locations.site` is the location name (e.g., "Oswego") not
the site_number — Brief 62 fixed the join key after operator
confirmed every WO created since Brief 42 shipped without a
locationId. See Brief 49 for the parallel
`getLocationContactInfo` fix that hit the same data-shape
mismatch.
```

1.3 No other change in this file. The single source-of-truth
for the maintainx_id mapping stays `locations.maintainx_id`;
this brief only corrects how we look it up.

### Phase 2 — Validation

2.1 `pnpm typecheck` — must pass for all 13 packages.
2.2 `pnpm --filter @splash/damage-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed; clean
   up afterward. (`packages/db-supabase` is consumed by
   damage-worker; the dry-run validates the bundle.)
2.3 No schema changes. No new env vars. No new endpoints.

### Phase 3 — Updates

3.1 BRIEFS/INDEX.md: Brief 62 row appended.

3.2 BUILD_STATE.md: Findings entry noting:
  - Latent defect from Brief 42: `getMaintainXLocationId`'s
    step-2 query joined on `locations.site` (the location name)
    instead of `locations.site_number` (the actual integer key
    `pricing_simple.site` carries the text value of). Same bug
    class Brief 49 fixed for `getLocationContactInfo`.
  - Symptom: MaintainX work orders for damage claims have
    Location column blank for every WO created since Brief 42
    shipped. Both consumers affected: customer claim form
    submission (Brief 42) and GM-side equipment override modal
    (Brief 43).
  - Fix: change the URL search-param key from `site` to
    `site_number` in the locations-side query. One-line change.
  - Operator follow-up: submit a test claim with
    `equipment_related=1` and confirm the resulting MaintainX
    WO carries the correct Location attribution. Existing WOs
    (148490, 148492, 148496, 148512, etc.) won't backfill —
    only WOs created after the fix lands will show locations.
  - Backfill option (out of scope): operator could
    bulk-update existing WOs via the MaintainX API. Defer
    unless finance needs the historical attribution.

3.3 CLAUDE.md updates:
  - Glossary entry for `getMaintainXLocationId` (if one exists)
    or the MaintainX integration block — add a note that the
    join is `pricing_simple.site → locations.site_number` (NOT
    `locations.site`). Same as Brief 49's pattern note for
    `getLocationContactInfo`.

## Out of scope

- Backfilling Location on existing MaintainX WOs. The
  damage-worker doesn't track previously-created WOs in a way
  that lets us bulk-update them; backfill would be a manual
  operator script against the MaintainX API.
- Refactoring `getMaintainXLocationId` to mirror Brief 49's
  single-query pattern (read `maintainx_id` directly from
  `pricing_simple`). `pricing_simple` doesn't carry
  `maintainx_id` today — that'd require either a column add +
  trigger update or a schema migration. Defer; the join-key
  fix is sufficient and contained.
- Adding logging when `getMaintainXLocationId` returns null
  for a slug that DOES exist in pricing_simple. Useful
  debugging but adds log noise; defer to a follow-up if
  operator wants it.
- Touching `apps/damage-worker/src/maintainx.ts`. The consumer
  is correct as written — its null-guard is the right
  fail-soft posture for missing `maintainx_id` rows (e.g., new
  locations added before MaintainX provisioning catches up).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `getMaintainXLocationId` step-2 query uses `site_number` as
  the URL search-param key, not `site`
- Docblock updated to call out the join-key correction and
  cross-reference Brief 49
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run bundle succeeds (clean up after)
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely ~2-3 lines net for the code change + docblock
  rewrite)
- Confirmation that the searchParams key swap is the only
  functional change (the rest of the helper, including
  fail-soft branches, stays identical)
- Validation results
- Any decisions made on the operator's behalf

## Outcome

**Files modified (3):**

- `packages/db-supabase/src/locations.ts`
  - Step-2 URL search-param key changed from `"site"` to `"site_number"`
    (~L123). One functional line.
  - Inline step-2 comment rewritten from
    `// Step 2 — locations.site → maintainx_id (integer or null).` to
    `// Step 2 — locations.site_number → maintainx_id (integer or null).`
    plus a 4-line Brief-62 explainer underneath calling out the
    `pricing_simple.site → locations.site_number` join shape and the
    "earlier version returned null for every slug" gotcha.
  - Docblock above `getMaintainXLocationId` (~L66-L83) extended: the
    "two-step lookup" explainer now specifies that
    `pricing_simple.site` is the denormalized site_number text
    (populated by `trg_sync_pricing_simple` from
    `locations.site_number::text`); a new paragraph cross-references
    the broken-version-of-this-helper and Brief 49's parallel
    `getLocationContactInfo` fix. Fail-soft semantics paragraph
    preserved unchanged.
- `BRIEFS/INDEX.md` — Brief 62 row appended after Brief 61.
- `BUILD_STATE.md` — `Last updated` paragraph rewritten to lead with
  Brief 62's summary (with the previous Brief 61 summary preserved as
  "Earlier on 2026-05-07 — Brief 61 completed; …"); new findings table
  row inserted at the top of the Findings & decisions log.
- `CLAUDE.md` — MaintainX integration block (under the
  "Working with workers" section) extended with a `getMaintainXLocationId`
  join-key callout: `pricing_simple.site → locations.site_number`,
  NOT `locations.site` (with cross-reference to Brief 49). The Brief 46
  "assignees.0.type" callout is preserved.

**Files created:** none.

**Diff size:** ~1 functional line (the searchParams key swap) plus
~14 lines of docblock + inline-comment rewrite in `locations.ts`,
plus the docs touchups (INDEX, BUILD_STATE, CLAUDE.md). Matches the
brief's "~2-3 lines net" estimate for the code change; the docblock
rewrite was somewhat larger than the brief's exemplar text but stays
faithful to the prescribed shape (acknowledge the broken version,
cross-reference Brief 49).

**Confirmation that the searchParams key swap is the only functional
change:** yes. Every fail-soft branch (regex slug guard, fetch throw
catch, non-2xx short-circuit, empty-array short-circuit on either
step, missing/null `maintainx_id`, `Number.isFinite` guard) is
preserved verbatim. The pricing_simple-side step is unchanged. No
new env vars, no new endpoints, no schema changes, no consumer-side
edits in `apps/damage-worker/src/maintainx.ts`.

**Validation results:**

- `pnpm typecheck`: 13 / 13 packages pass (6 cached, 7 fresh).
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build`: bundles cleanly. Total upload **1705.76 KiB**;
  gzipped **385.99 KiB** (well under CF's 10 MiB compressed paid limit
  / 3 MiB free limit). Bindings printed as expected (DB, R2_BUCKET,
  IMAGES, MAINTAINX_MODE="test", MAINTAINX_BASE_URL, APPS_WEB_BASE_URL).
- `.tmp-build` directory cleaned up afterward.

**Decisions made on operator's behalf:**

- The brief's Phase-1.2 docblock replacement text was followed
  faithfully (correct join shape, broken-version callout, Brief 49
  cross-reference) but reflowed slightly so it composes cleanly with
  the existing fail-soft paragraph that follows. The semantic content
  matches the brief; the line breaks differ.
- The inline step-2 comment got an additional 4-line Brief-62
  explainer (the brief mentioned only the literal join-shape change).
  Rationale: a comment that just changes `site` → `site_number`
  without explaining why would invite "wait, why isn't this `site`?"
  follow-up reads. Cheap defense against re-introducing the bug.
- CLAUDE.md's MaintainX block already had a Brief 46 callout about
  `assignees.0.type`; the new Brief 62 join-key callout was appended
  to the SAME paragraph (not a separate section). Keeps the
  "MaintainX integration gotchas" cluster together.
- BUILD_STATE.md's prioritized work list was NOT modified — Brief 62
  was a follow-up bug brief, not part of the planned roadmap, so
  there's no work-list row to flip from "Not started" to "Completed".
  The findings entry + INDEX row are the canonical record.

**Latent issues / observations:**

- The docblock above `getMaintainXLocationId` previously carried the
  comment "the unique business key is `site_number`; the
  `trg_sync_pricing_simple` trigger denormalizes into
  `pricing_simple` by `site` text" — i.e., the docblock author
  understood the trigger semantics correctly when writing Brief 42's
  helper, but the implementation joined on the WRONG `locations`
  column (`site`, the location name) anyway. The docblock and the
  code disagreed since Brief 42 shipped. This is the same divergence
  Brief 49 flagged for `getLocationContactInfo`. Both fixes were
  contained one-liners; both bugs were latent for ~24 hours
  in production-equivalent staging traffic. Worth a project memory:
  `pricing_simple.site` is the site_number-as-text, NOT the location
  name; joins from pricing_simple to locations should use `site_number`.
- Existing MaintainX WOs (148490, 148492, 148496, 148512, …) created
  during the bug window will not retroactively gain Location
  attribution. The damage-worker doesn't track previously-created WOs
  in a way that lets us bulk-update them; backfill would be a manual
  operator script against the MaintainX API. Operator follow-up flagged
  in BUILD_STATE.md and the brief's Phase-3.2 bullets.
- Defense-in-depth observation (out of scope for this brief): the
  consumer at `apps/damage-worker/src/maintainx.ts:133` is correctly
  fail-soft on `maintainxLocationId == null` (omits `body.locationId`
  rather than 4xxing). That posture is right for genuinely-missing
  `maintainx_id` rows (e.g., a location added in Supabase before its
  MaintainX record is provisioned), but it also masks the join-key
  bug. A future hardening would log a warning when the slug
  resolves to a `pricing_simple.site` value that has no matching
  `locations.site_number` row — the brief flagged this as out-of-scope
  on noise grounds; deferred unless operator asks.
- No mid-flight signal that the WO Location was missing. The
  Brief 42 `[maintainx]` activity-log entry on success records
  WO id + assignee count, but not whether `body.locationId` was
  populated. The detail page's "MaintainX work order" Field row
  links to `app.getmaintainx.com/workorders/{id}` and is the only
  surface that would have surfaced "this WO has no Location" —
  but the operator caught it via a direct MaintainX UI screenshot,
  not via the apps/web detail page. Adding a "WO has no Location"
  hint on the detail page is a reasonable follow-up but out of scope.

**Operator follow-up:**

1. Push to trigger CF Workers Builds (no manual deploy from headless
   per CLAUDE.md). Target deployment: damage-worker (`@splash/damage-worker`)
   only — no other worker consumes `getMaintainXLocationId`.
2. Submit a test claim with `equipment_related=1` against a location
   whose `locations.maintainx_id` is populated (Oswego is the
   confirmed reproducer per Brief 49's notes). Confirm the resulting
   MaintainX WO carries the correct Location attribution in the
   MaintainX UI's Location column.
3. Decide whether to backfill existing WOs (148490, 148492, 148496,
   148512, …). If finance needs the historical attribution, it's a
   manual MaintainX-API script (out of scope for this brief).
4. Optional: a future brief could add a "no-match-but-pricing-simple-row-exists"
   warning log inside `getMaintainXLocationId` to surface the next
   instance of this bug class (or a stale `maintainx_id` provisioning
   gap) without waiting on a human eyeballing the MaintainX UI. Defer
   until operator asks.
