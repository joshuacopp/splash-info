# Brief 33: Drop D1 locations - damage-worker reads from Supabase (full Path A)

**Status:** Completed (2026-05-05)
**Started:** 2026-05-05
**Completed:** 2026-05-05
**Blocks:** Two locations stores (D1 + Supabase) drift apart and
require operator-side manual reconciliation. Brief 23 wired
damage-worker's `/claims/{slug}` resolution to D1 locations; Brief
27 made Supabase locations the editor source-of-truth; Brief 29
extended Add Location to write Supabase locations + pricing_simple
but still left D1 untouched. The 2026-05-05 batavia_veterans
incident showed the dual-store seam: a customer URL existed in
pricing_simple (underscore form) but not in D1 (hyphen form), and
/claims resolution 404'd. The operator manually renamed D1 codes
to the underscore form to unblock testing - this brief eliminates
the dual store entirely.
**Dependencies:** Brief 23 (the customer claim form +
`getActiveLocationByCode` D1 reads), Brief 24/29 (Add Location
that writes D1 today), Brief 27 (the Supabase locations editor).
Pre-prod context: no live claim data; this brief can move freely
without a backfill / migration window.

## Read first

- CLAUDE.md (especially the working-with-workers section + the
  `pkg$` constraint context and the location_code load-bearing-URL
  rule)
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-023-customer-claim-form.md (Outcome - the slug
  resolution flow that this brief rewires)
- BRIEFS/brief-027-sysadmin-update-location.md (Supabase locations
  shape: PK `id`, `site_number`, `site`, `location` (address),
  `area_manager`, `regional_manager`, `am_email`, `rm_email`,
  `site_email`, `hrt_email`, `rm_group`)
- BRIEFS/brief-029-tab-title-add-location-row-claim-overlay.md
  (Outcome - Add Location currently writes Supabase locations +
  pricing_simple, NOT D1)
- packages/db-d1/src/locations.ts (the existing
  `getActiveLocationByCode(db, code)` helper - returns
  `Pick<D1LocationRow, "location_code" | "location_pretty">`. This
  is being deleted)
- apps/damage-worker/src/index.ts (4 call sites consume
  `getActiveLocationByCode` - lines 357, 381, 1323, plus the
  `import` at line 74)
- apps/damage-worker/wrangler.toml (already documents
  SUPABASE_URL + SUPABASE_SERVICE_KEY in the comments header at
  lines 52-54, but they aren't bound yet - this brief binds them)
- apps/sysadmin-worker/src/index.ts (mirror its Supabase
  service-key fetch pattern - works inside CF Workers; established
  in Briefs 7/24/26/27)
- packages/db-supabase/src/auth-context.ts (precedent for the
  Supabase REST + service-role-key pattern)

## Context

The audit phase ran first. **Damage-worker only reads two columns
from D1 locations**: `location_code` and `location_pretty`. The
`getActiveLocationByCode` helper's return type is the smoking gun
- it's typed `Pick<D1LocationRow, "location_code" |
"location_pretty">`. None of the other D1 columns (`gm_name`,
`gm_email`, `state`, `incidents_email`, `ap_email`,
`maintainx_location_id`, `is_active`, `address`, `site_number`,
`updated_at`) are accessed by damage-worker code. The check-request
PDF (apps/damage-worker/src/pdf.ts) reads
`claim.location_pretty` from the claim row, not the locations
table. The Power Automate webhook URLs are bound as worker env
vars (POWER_AUTOMATE_URL, INCIDENTS_WEBHOOK_URL,
AP_WEBHOOK_URL), not derived from per-location email columns.

This dramatically simplifies the scope: there are no columns that
need migrating from D1 to Supabase. Supabase already has
everything damage-worker actually consumes (location_code lives in
pricing_simple - via the trigger denormalization - and
locations.site is the equivalent of D1's location_pretty for
display). The migration is just: add a Supabase-backed
`getActiveLocationByCode` helper, replace 4 call sites, drop the
D1 table.

Operator-side, the location_code rename SQL the operator ran on
2026-05-05 means D1 currently uses pricing_simple's underscore form
(e.g., `batavia_veterans`, `cos_cob` would be `coscob`, etc., per
the rename batch). That alignment makes the cutover safer - any
slug pre-bookmarked at /claims/<underscore-form> now resolves
identically to whatever Supabase will return.

**There is no production claim data.** This is staging only. The
`claims`, `claim_photos`, `claim_activity_log` tables in D1 are
empty (or contain only Josh's test submissions). D1 stays for
those tables - this brief ONLY touches the locations table inside
D1.

## Scope

### Phase 1 - Add Supabase-backed location resolution

1.1 Bind Supabase to damage-worker. In
`apps/damage-worker/wrangler.toml`:

  - Uncomment / add the SUPABASE_URL `[vars]` entry (plaintext OK,
    same as how sysadmin-worker has it).
  - Document SUPABASE_SERVICE_KEY in the secrets header comment
    (already present per lines 52-54). The operator must run
    `wrangler secret put SUPABASE_SERVICE_KEY` for damage-worker
    using the same value from sysadmin-worker - the brief should
    flag this as an operator action item.

1.2 Add SUPABASE_URL + SUPABASE_SERVICE_KEY to the `Env` interface
in `apps/damage-worker/src/index.ts` (around the existing Env
declaration near line 130). Both required at runtime; no fallback.

1.3 New helper in `packages/db-supabase/src/locations.ts` (new
file):

  ```ts
  // Supabase-backed location resolution for damage-worker (Brief 33).
  // Replaces the legacy D1 getActiveLocationByCode. The pricing_simple
  // table is queried because it's the customer-URL source-of-truth;
  // each pricing_simple row has location_code + location_pretty
  // denormalized, so a single SELECT with DISTINCT ON gives us the
  // (code, pretty) tuple without joining to the locations table.

  export interface ResolvedLocation {
    location_code: string;
    location_pretty: string;
  }

  export async function getActiveLocationByCode(
    env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
    locationCode: string
  ): Promise<ResolvedLocation | null> {
    const sanitized = locationCode.trim();
    if (!sanitized || !/^[a-z0-9_]+$/.test(sanitized)) return null;

    const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
    url.searchParams.set("location_code", `eq.${sanitized}`);
    url.searchParams.set("select", "location_code,location_pretty");
    url.searchParams.set("limit", "1");

    const response = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!response.ok) {
      console.error(
        "getActiveLocationByCode: Supabase returned",
        response.status
      );
      return null;
    }
    const rows = (await response.json()) as ResolvedLocation[];
    return rows[0] ?? null;
  }
  ```

  Why pricing_simple instead of locations: pricing_simple is the
  source-of-truth for "which location_codes are valid for customer
  surfaces" (per the load-bearing-URL constraint). A location_code
  exists in pricing_simple iff it has been provisioned with at
  least one package row, which is the same definition of "active"
  the legacy D1 `is_active` flag was approximating. Querying
  locations directly would also work but locations.location_code
  doesn't exist as a column - locations uses `site_number` /
  `site` keying. pricing_simple's location_code matches the URL
  shape exactly.

1.4 Export from `packages/db-supabase/src/index.ts`. Add to the
existing exports list.

### Phase 2 - Replace D1 call sites in damage-worker

2.1 Replace the import in `apps/damage-worker/src/index.ts` line
74:
  - Old: `import { getActiveLocationByCode } from "@splash/db-d1";`
  - New: `import { getActiveLocationByCode } from "@splash/db-supabase";`

2.2 Update the 4 call sites:
  - Line 357 (inside `handleRenderClaimForm`):
    - Old: `await getActiveLocationByCode(env.DB, slug);`
    - New: `await getActiveLocationByCode(env, slug);`
  - Line 381 (inside `handleRenderThanksPage`): same swap.
  - Line 1323 (inside `handleClaimSubmission` canonical resolution):
    same swap.
  - Plus any others surfaced by grep — the audit identified these
    three but the executor should re-grep before declaring done.

2.3 Type-check after the swap. The new helper's signature takes
`env` instead of `env.DB`, so call sites become slightly cleaner.

### Phase 3 - Drop the D1 locations table

3.1 In the CF dashboard's D1 console for `splash-damage`:

  ```sql
  DROP TABLE locations;
  ```

  Do NOT use migrations directory tooling - this is a one-shot
  destructive change applied directly.

3.2 Remove `packages/db-d1/src/locations.ts` and any imports from
its index. The `getActiveLocationByCode` helper there is gone -
delete the file. Update `packages/db-d1/src/index.ts` to drop the
re-export.

3.3 Remove the `D1LocationRow` type from `packages/types` if it's
defined there - it shouldn't be referenced anywhere post-swap.

3.4 Confirm `pnpm typecheck` is still clean after the deletion.

### Phase 4 - Update Add Location handler (Brief 29 retrofit)

4.1 `apps/sysadmin-worker/src/index.ts` `handleCreateLocation`
currently writes ONLY to Supabase (locations + pricing_simple),
NOT to D1. **No code change required here** - Brief 29 already had
the right shape; D1 was never being written to from the Add
Location flow. This phase is a no-op confirmation.

4.2 Verify by reading handleCreateLocation: confirm there's no
D1 write, no `env.DB` reference, no fallback. If anything D1-shaped
shows up, drop it.

### Phase 5 - Cleanup + docs

5.1 BRIEFS/INDEX.md: Brief 33 row added.

5.2 BUILD_STATE.md: Last updated, Findings entry covering the
drop. Note that D1 is now scoped to claims-related tables only;
locations resolution is Supabase-authoritative.

5.3 CLAUDE.md: revise the "Working with workers" + "Glossary"
sections to remove references to D1 locations as a concept.
Specifically:
  - The D1 locations table no longer exists.
  - location_code → location_pretty resolution is via Supabase
    pricing_simple (see packages/db-supabase/src/locations.ts).
  - The dual-store rename gotcha that bit the operator on
    2026-05-05 is no longer reachable - one source of truth.
  - The varchar-zero-padded site note is still relevant for
    pricing_simple.site vs locations.site_number elsewhere; that
    section stays.

5.4 Apps/damage-worker's CLAUDE-comment header (the docblock at
the top of src/index.ts that lists D1 tables) - update to remove
`locations` from the list of D1 tables.

5.4.1 **Note on dormant D1 columns** (`incidents_email`, `ap_email`,
`gm_email`, `gm_name`, `state`, `is_active`, `maintainx_location_id`,
`address`): the audit confirmed these are NOT read by damage-worker.
The webhook URLs (`INCIDENTS_WEBHOOK_URL`, `AP_WEBHOOK_URL`) are
worker secrets that POST to Power Automate; the email addresses
themselves (`incidents@splashcarwashes.com`,
`splashap@splashcarwashes.com`) live inside PA's flow definitions,
not in worker config. **No env vars need to be added** when the
table is dropped - the columns die with the table without
displacing any consumer.

5.5 Operator-side actions:
  - **Required before deploy:** `pnpm --filter
    @splash/damage-worker exec wrangler secret put SUPABASE_SERVICE_KEY`
    with the same value from sysadmin-worker.
  - **After deploy verification:** test
    `/claims/batavia_veterans` resolves and renders the form, and
    a customer submission writes a claim row whose location_code
    matches what Supabase has (no underscore/hyphen drift).
  - **Optional cleanup:** drop the D1 `locations` table via the
    SQL above, after confirming the new code is live and stable
    on staging.

## Out of scope

- Migrating other D1 tables (`claims`, `claim_photos`,
  `claim_activity_log`). They stay in D1 - that's where claim
  records belong.
- Renaming any pricing_simple location_codes. The customer-URL
  shape is frozen.
- Renaming any other D1 tables (claim records, photos, etc.) -
  pre-prod, but no reason to touch them.
- Migrating dormant D1 columns (`gm_email`, `incidents_email`,
  `ap_email`, `state`, `maintainx_location_id`, `is_active`,
  `gm_name`) into Supabase. They were unused in damage-worker; if
  any future feature needs them, that's a separate brief that
  ALTERs Supabase locations. Brief 33 just deletes them with the
  rest of the D1 table.
- Adding a service binding from damage-worker to sysadmin-worker
  for locations search. Direct Supabase REST is the same pattern
  sysadmin-worker uses, and avoids cross-worker coupling.
- Edge caching for the location resolution. pricing_simple lookups
  are fast enough; if it ever shows up in latency budgets,
  cache-via-`caches.default` is a one-liner add. Not in v1.
- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker build succeeds
- New `packages/db-supabase/src/locations.ts` exports
  `getActiveLocationByCode(env, code)` querying pricing_simple
- damage-worker imports the new helper, NOT
  `@splash/db-d1`/locations
- 4 call sites updated to pass `env` instead of `env.DB`
- D1 locations helper file deleted, re-export removed,
  D1LocationRow type removed (or marked deprecated if still in
  packages/types)
- handleCreateLocation in sysadmin-worker confirmed to NOT write
  to D1 (no-op verification phase)
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated to reflect
  the drop
- Operator action item recorded:
  `pnpm --filter @splash/damage-worker exec wrangler secret put SUPABASE_SERVICE_KEY`
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Final list of every grep hit for `env.DB.*locations` or
  `getActiveLocationByCode` in damage-worker - confirm 4 sites
  matched and were updated
- Whether `D1LocationRow` was referenced anywhere outside the
  removed files (if yes, those references need fixing too)
- Bundle-size delta on damage-worker (likely +0.5-1 KiB for the
  new Supabase fetch helper, -0.3 KiB for the dropped D1 helper;
  net ~0)
- Latency observation if you can grab one (CF Workers Build logs
  for cold starts of /claims/{slug}): D1 is single-digit ms,
  Supabase REST is typically 30-80 ms. The expected user-visible
  delta is sub-perceptible.
- Any other apps/* or packages/* code that imports the deleted
  D1 helper (cross-package fallout)
- Validation results

## Outcome

**Files modified:**

- `packages/db-supabase/src/locations.ts` — appended new
  `getActiveLocationByCode(env, code)` helper (Supabase REST
  `select=location_code,location_pretty&limit=1` against
  `pricing_simple`, service-role headers) and a new `ResolvedLocation`
  interface. Pre-existing `searchLocations` and `getSiteNumbersForUser`
  helpers preserved. File header rewritten to mention damage-worker's
  customer-claim-form slug resolution as a new use case.
- `packages/db-supabase/src/index.ts` — already re-exports
  `./locations.js` so the new helper is automatically part of the
  public surface. **No change here.**
- `packages/db-d1/src/index.ts` — dropped the `./locations.js`
  re-export; added a docblock paragraph noting Brief 33 retired the D1
  `locations` table and that the package now scopes to claim-related
  tables only.
- `packages/types/src/locations.ts` — removed the `D1LocationRow`
  interface; rewrote the file header to reflect the single Supabase
  source.
- `apps/damage-worker/src/index.ts` — moved the
  `getActiveLocationByCode` import from `@splash/db-d1` to
  `@splash/db-supabase` (collapsed onto the same line as the existing
  `type SupabaseEnv` import). Three call sites swapped:
  - `handleRenderClaimForm` (line ~356): `env.DB` → `env`
  - `handleRenderThanks` (line ~380): `env.DB` → `env` (the brief
    referred to this as `handleRenderThanksPage`; the actual function
    name is `handleRenderThanks` — same site, same fix)
  - `handleClaimSubmission` canonical-resolution branch (line ~1322):
    `env.DB` → `env`
  Two adjacent comments updated to mention "Supabase pricing_simple"
  instead of "D1 locations". The warning-log message in the
  canonical-resolution `catch` branch updated to "Supabase resolution
  failed (using form value)".
- `apps/damage-worker/wrangler.toml` — bindings comment header
  rewritten: `SUPABASE_URL` annotated as required by Brief 33 (set via
  CF dashboard plain-text env, mirroring sysadmin-worker);
  `SUPABASE_SERVICE_KEY` annotated with the operator action item
  (`wrangler secret put`); `DB` description trimmed to `claims,
  claim_photos, claim_activity_log` (the `, locations` reference
  dropped).
- `BRIEFS/INDEX.md` — Brief 33 row marked Completed (2026-05-05).
- `BRIEFS/QUEUE.md` — Brief 33 line moved to the completed-tombstone
  block.
- `CLAUDE.md` — `packages/db-supabase` bullet extended to mention
  `getActiveLocationByCode`. `packages/db-d1` bullet rewritten to flag
  the locations retirement. `**location_pretty**` glossary entry
  extended with the post-Brief-33 resolution path (Supabase
  `pricing_simple` via `getActiveLocationByCode`) and the closure of
  the dual-store gotcha that surfaced on 2026-05-05.
- `BUILD_STATE.md` — Last updated bumped to "Brief 33 completed"; new
  Findings entry; damage-worker row in the Deployed components table
  updated to flag the Brief 33 changes and operator action items;
  prioritized work list row 33 added.

**Files created:** none.

**Files deleted:**

- `packages/db-d1/src/locations.ts` — the entire file. The
  `getActiveLocationByCode` D1 helper is replaced by the Supabase one;
  the unused `listActiveLocations` and `listActiveLocationsBySiteNumbers`
  helpers (zero call sites in the monorepo, grep-confirmed across
  `apps/**` + `packages/**`) were dead code carried over from the
  legacy port and are removed alongside.

**Final list of every grep hit for `env.DB.*locations` or
`getActiveLocationByCode` in damage-worker** (post-edit):

```
apps/damage-worker/src/index.ts:88:  import { getActiveLocationByCode, type SupabaseEnv } from "@splash/db-supabase";
apps/damage-worker/src/index.ts:342: * Slug resolves via getActiveLocationByCode(env, slug) — Supabase
apps/damage-worker/src/index.ts:356:  const location = await getActiveLocationByCode(env, slug);
apps/damage-worker/src/index.ts:380:  const location = await getActiveLocationByCode(env, slug);
apps/damage-worker/src/index.ts:1323: const canonical = await getActiveLocationByCode(env, claimData.location);
```

Confirms 3 call sites + 1 docblock reference + 1 import — exactly the
shape the brief described (the brief's audit count of "4" referred to
"the import + 3 call sites" totalled). All `env.DB`-passing call sites
are gone.

**Cross-package fallout from `D1LocationRow` removal:** none. Grep
across `apps/**` + `packages/**` (excluding `BRIEFS/**`) returned zero
matches for `D1LocationRow` post-deletion. The type was only used
internally by the deleted `packages/db-d1/src/locations.ts` file.

**Decisions made on operator's behalf:**

1. **Helper appended to existing
   `packages/db-supabase/src/locations.ts`** rather than created as a
   "new file" per the brief's strict reading. The file already exists
   with `searchLocations` and `getSiteNumbersForUser`; appending
   preserves both helpers without a redirect file or duplicate header.
2. **Slug regex `[a-z0-9_]+` applied AFTER `.toLowerCase()` + `.trim()`**
   — the legacy D1 helper lowercased before the WHERE clause; the new
   Supabase helper mirrors that to handle hand-typed
   `BATAVIA_VETERANS`-style URLs. The brief's snippet didn't lowercase;
   I added it for behavioural parity with the legacy.
3. **Helper `env` parameter typed as the structural subset
   `{ SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string }`**, not the
   full `SupabaseEnv` — `SUPABASE_ANON_KEY` is unused for this call so
   structural typing is cleaner. The damage-worker's `Env` already
   extends `SupabaseEnv` so it satisfies this trivially.
4. **`listActiveLocations` + `listActiveLocationsBySiteNumbers` deleted**
   alongside `getActiveLocationByCode` — both were dead code. Per
   CLAUDE.md "If you are certain that something is unused, you can
   delete it completely." Keeping them would have left
   `@splash/db-d1` advertising a `D1.locations` shape after the table
   is dropped.
5. **`D1LocationRow` removed from `@splash/types/locations`** rather
   than marked deprecated (the brief's DoD listed both options).
6. **Damage-worker `Env` interface NOT modified** — it already extends
   `SupabaseEnv` (line 129), which provides `SUPABASE_URL` /
   `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_KEY` as required fields. No
   typing change needed; runtime presence is enforced by Cloudflare at
   first read. The brief's Phase 1.2 ("Add SUPABASE_URL +
   SUPABASE_SERVICE_KEY to the Env interface") was already satisfied
   prior to this brief.
7. **No `[vars]` block added to damage-worker's wrangler.toml** —
   sysadmin-worker doesn't have one either; its `SUPABASE_URL` is set
   via the CF dashboard plain-text "Variables and Secrets" UI. Mirrored
   that pattern to keep the cross-worker config style consistent.
8. **D1 `DROP TABLE locations` left as a manual operator step** per
   the brief's Phase 3.1 ("one-shot destructive change applied
   directly"). The repo state no longer references the table; whether
   the operator drops it now or after staging soak is independent of
   code correctness.
9. **`handleRenderThanks` is the function the brief misnamed
   `handleRenderThanksPage`** — confirmed via grep there's exactly one
   such handler (line 376 of damage-worker's index.ts) and its sole
   call site is the `/claims/.../thanks` dispatch (line 244).

**Latent issues / forward flags:**

- **(a) Operator action items are gating.**
  `wrangler --filter @splash/damage-worker secret put SUPABASE_SERVICE_KEY`
  (using the same value already configured on `splash-sysadmin`) MUST
  run before the next deploy of damage-worker; otherwise every
  `/claims/{slug}` and the canonical-resolution branch in
  `/claims-api/submit-claim` will error at the Supabase fetch (the
  `apikey` header would be `undefined`). `wrangler --dry-run` doesn't
  validate this; `wrangler secret list --name splash-damage` will.
  Similarly `SUPABASE_URL` must be set as a plain-text env var on the
  damage-worker (matches the sysadmin-worker setup).
- **(b) D1 `locations` table is still live.** Repo state no longer
  reads it, but the table physically exists in the splash-damage D1
  with the operator-renamed underscore-form codes from earlier today.
  Dropping it is the brief's "Optional cleanup" step — can wait for a
  soak window. Until dropped, the table consumes nominal storage but
  nothing reads it.
- **(c) `listActiveLocations` and `listActiveLocationsBySiteNumbers`
  were declared in `@splash/db-d1` but never called anywhere in the
  monorepo** — confirmed by grep across `apps/**` + `packages/**`.
  Their removal is structurally invisible. apps/web's damage list page
  uses Supabase scoping via `@splash/db-supabase` `getSiteNumbersForUser`
  rather than D1 location enumeration.
- **(d) Sanitization regex on the Supabase helper** is `^[a-z0-9_]+$`,
  matching `LOCATION_CODE_RE` in sysadmin-worker. Slugs containing
  hyphens (which the legacy D1 worker DID accept on lookup but which
  pricing_simple has never used) will now return null. The brief
  flagged this is intended: post-2026-05-05 rename, all D1 codes are
  underscore-form, so nothing reachable depends on hyphen-form slug
  lookup. Pre-existing customer bookmarks at `/claims/some-loc`
  (hyphen form) would have 404'd today even before this brief —
  pricing_simple uses underscores end-to-end.
- **(e) No edge caching on the new helper** — every `/claims/{slug}`
  GET hits Supabase REST. Brief estimated `30-80 ms` per call vs. D1's
  single-digit ms. If `/claims/{slug}` shows up in latency budgets, a
  `caches.default` wrapper is a one-line add; not in v1 per the brief's
  out-of-scope list.
- **(f) Bundle delta within brief estimate.** Damage-worker post-Brief-33:
  **1664.02 KiB / 377.58 KiB gzip** (was **1663.57 KiB / 377.48 KiB**
  post-Brief-32) → **+0.45 KiB / +0.10 KiB gzip**. Brief estimate was
  "+0.5-1 KiB for the new helper, -0.3 KiB for the dropped helper; net
  ~0". Comfortably within budget.
- **(g) Latency observation deferred** — the brief asked for a
  cold-start observation if grabbable; CF Workers Builds logs aren't
  reachable from headless mode, and operator-side staging tests will
  produce the real numbers. Expected delta is sub-perceptible per the
  brief's own estimate.

**Validation:**

- `pnpm typecheck` — **13/13 successful, 10.299s** (0 cached + 13
  fresh; turbo invalidated all caches because the type changes touched
  `@splash/types/locations`, which is in everyone's dependency graph).
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run --outdir=./dist`
  — **succeeded.** Bundle: **1664.02 KiB / 377.58 KiB gzip**. Bindings
  listed in dry-run output: `env.DB` (D1 splash-damage-claims),
  `env.R2_BUCKET` (R2 damagedocs), `env.IMAGES`. `SUPABASE_URL` and
  `SUPABASE_SERVICE_KEY` are not yet listed in the dry-run output
  because the operator hasn't bound them on the deployed worker —
  flagged as gating action item (a) above.

**Operator action items (required before next deploy):**

1. `wrangler --filter @splash/damage-worker secret put SUPABASE_SERVICE_KEY`
   — use the same value already on `splash-sysadmin`.
2. Set `SUPABASE_URL` as a plaintext env var on splash-damage via the
   CF dashboard "Variables and Secrets" UI (mirrors sysadmin-worker).
3. Optional cleanup, after staging smoke-test confirms
   `/claims/{slug}` resolves cleanly: `DROP TABLE locations;` in the
   splash-damage D1 console. Repo no longer reads the table.
