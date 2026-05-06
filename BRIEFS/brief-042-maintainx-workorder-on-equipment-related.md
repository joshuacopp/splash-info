# Brief 42: MaintainX work order on equipment_related=yes

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Brief 43 (GM-side modal for setting equipment_related=yes
during post-submit quote/in-house determination — that brief calls the
same `createMaintainXWorkOrder` helper this brief introduces, so the
helper signature must be stable before Brief 43 lands).
**Dependencies:**
- Brief 41 (damage_type column on claims; the MaintainX work order
  title uses it). Completed 2026-05-06.
- `MAINTAINX_API_KEY` wrangler secret bound on `splash-damage`
  (operator confirmed 2026-05-06).
- `locations.maintainx_id` column populated in Supabase (operator
  confirmed 2026-05-06).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-041-claim-form-damage-type-selector.md (the
  damage_type allow-list and column shape this brief reads from)
- BRIEFS/brief-033-drop-d1-locations-supabase-authoritative.md
  (the Supabase locations resolution path; this brief extends
  the same helper, or adds a sibling, to also return `maintainx_id`)
- apps/damage-worker/src/index.ts (`handleClaimSubmission` ~L1206;
  hook fires AFTER `writeClaimBatch` succeeds and BEFORE the
  SharePoint webhook so the WO ID can ride along)
- apps/damage-worker/wrangler.toml (add `[vars]` entries for
  MAINTAINX_MODE, MAINTAINX_BASE_URL, APPS_WEB_BASE_URL)
- packages/db-d1/src/claims.ts (`ClaimInsert` + `writeClaimBatch`
  — extend with maintainx_workorder_id; also add an
  `updateMaintainXWorkOrderId` helper for the post-insert update
  pattern)
- packages/db-supabase/src/* (find the existing
  `getActiveLocationByCode` helper from Brief 33; either extend
  it to also return `maintainx_id`, or add a sibling
  `getMaintainXLocationId(code)` — executor's call based on what
  reads cleanest)
- packages/types/src/claims.ts (extend `ClaimRow` with
  maintainx_workorder_id)

## Context

The customer claim form's employee section captures
`equipment_related` (1/0) and, as of Brief 41, `damage_type`. When
`equipment_related === 1`, operations needs a MaintainX work order
created so the maintenance team is paged. Today this is manual.

The MaintainX REST API exposes `POST
https://api.getmaintainx.com/v1/workorders` with bearer-token auth.
Reference request body the operator provided:

```json
{
  "title": "Damage Claim - Binghamton - Wiper",
  "description": "Customer claim ...",
  "priority": "HIGH",
  "categories": ["Vehicle Damage"],
  "locationId": 3774771,
  "assignees": [
    { "type": "USER", "id": 409112 },
    { "type": "USER", "id": 426577 }
  ]
}
```

> Note: every assignee object MUST include `type: "USER"`.
> Confirmed via MaintainX 400 on 2026-05-06; Brief 46 fixed
> the helper.

Production assignees: Brett Sullivan (409112,
bsullivan@splashcarwashes.com) + Scott Butler (426577,
scott.butler@splashcarwashes.com). Test assignee: Josh Copp
(443948, josh.copp@splashcarwashes.com). Mode switch is a non-secret
env var so accidental dev deploys don't page real assignees.

This brief lands the WO creation on initial customer submission only.
A separate brief (43) will add the GM-side modal for setting
equipment_related=yes during post-submit quote/in-house determination,
and will reuse the same helper.

## Scope

### Phase 1 — D1 schema

1.1 Add a column to the D1 `claims` table on `splash-damage`:

```sql
ALTER TABLE claims ADD COLUMN maintainx_workorder_id INTEGER;
```

Run REMOTE only:

```powershell
pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage --remote --command "ALTER TABLE claims ADD COLUMN maintainx_workorder_id INTEGER;"
```

Verify:

```powershell
pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage --remote --command "PRAGMA table_info(claims);" --json
```

`maintainx_workorder_id` (INTEGER, nullable) must appear.

NULL means: not yet attempted, MaintainX call failed, or not
applicable (equipment_related=0). NOT NULL means: WO created;
dedupe gate uses this to skip duplicate creation on resubmit /
GM modal re-trigger.

### Phase 2 — wrangler.toml vars

2.1 In `apps/damage-worker/wrangler.toml`, add to the top-level
`[vars]` section (create the section if it doesn't exist):

```toml
[vars]
MAINTAINX_MODE = "test"
MAINTAINX_BASE_URL = "https://api.getmaintainx.com/v1"
APPS_WEB_BASE_URL = "https://splashcarwashes.info"
```

Defaults rationale:
- `MAINTAINX_MODE = "test"` — fail-safe. Production gets flipped
  to `"production"` by the operator at cutover (manual edit +
  redeploy, OR override via the CF Workers dashboard env vars).
- `MAINTAINX_BASE_URL` — non-secret; visible in source for
  diff-ability. Doesn't include the trailing `/workorders`.
- `APPS_WEB_BASE_URL` — used to build the admin URL inside the
  WO description. Today apps/web is on workers.dev; flip to the
  prod hostname at cutover.

2.2 Mirror the env shape in
`apps/damage-worker/src/types.ts` (or wherever `Env` is declared
— search for `MAINTAINX_API_KEY` after Brief 41 added it; if
`Env` is in `index.ts`, add inline). Add:

```ts
MAINTAINX_API_KEY: string;
MAINTAINX_MODE: "production" | "test";
MAINTAINX_BASE_URL: string;
APPS_WEB_BASE_URL: string;
```

### Phase 3 — MaintainX helper module

3.1 Create `apps/damage-worker/src/maintainx.ts`. Single named
export `createMaintainXWorkOrder` plus a small private
`buildPayload` helper. Signature:

```ts
import type { ClaimRow } from "@splash/types/claims";

export interface MaintainXResult {
  ok: boolean;
  workOrderId: number | null;
  error: string | null;
  /** HTTP status (or 0 if request never sent / network error). */
  status: number;
  /** Compact payload echoed back for audit/log purposes. */
  request: Record<string, unknown>;
}

interface CreateInput {
  claim: ClaimRow;
  locationPretty: string;
  maintainxLocationId: number | null;
  apiKey: string;
  mode: "production" | "test";
  baseUrl: string;
  appsWebBaseUrl: string;
  /** AbortSignal so the caller can enforce a timeout. */
  signal?: AbortSignal;
}

export async function createMaintainXWorkOrder(
  input: CreateInput
): Promise<MaintainXResult>;
```

3.2 Inside the helper:

  - **Assignee selection by mode:**
    - `production`: `[{ type: "USER", id: 409112 }, { type: "USER", id: 426577 }]`
    - `test`: `[{ type: "USER", id: 443948 }]`
    - Encode these as module-level `const` arrays so they're
      grep-able when an assignee leaves the company.
    - Note: every assignee object MUST include `type: "USER"`.
      Confirmed via MaintainX 400 on 2026-05-06; Brief 46 fixed
      the helper.

  - **Title:** `Damage Claim - {locationPretty} - {damageTypeOrFallback}`
    where `damageTypeOrFallback = claim.damage_type ?? "Unspecified"`.
    For damage_type === "Other", append the description:
    `Damage Claim - {locationPretty} - Other ({claim.damage_other})`.

  - **Description** (multi-line, plain text — MaintainX renders
    it as preformatted in the WO view):
    ```
    Claim ID: {claim.claim_id}
    Submitted: {claim.submitted_at}
    Submitted by: {claim.submitted_by}

    Customer:
      Name: {claim.customer_name}
      Phone: {claim.customer_phone ?? "—"}
      Email: {claim.customer_email ?? "—"}

    Vehicle:
      {year} {make} {model} {color} — Plate: {plate}
      (any null fields rendered as "—")

    Damage type: {claim.damage_type ?? "—"}{ + " (Other: " + damage_other + ")" if applicable}
    Damage description: {claim.damage_description ?? "—"}
    Equipment involved: {claim.equipment_piece ?? "—"}
    Pre-existing damage: {claim.preexisting_damage ?? "—"}
    Determination: {claim.determination ?? "—"}

    Admin link: {appsWebBaseUrl}/admin/damage/{claim.claim_id}
    ```
    No photo URLs in v1 (out of scope; the admin link surfaces
    them). If operations asks for photos in v2, the public
    `/claims-api/photo/<key>` route from Brief 35 makes that a
    one-line addition.

  - **Body shape posted to MaintainX:**
    ```ts
    {
      title,
      description,
      priority: "HIGH",
      categories: ["Vehicle Damage"],
      ...(maintainxLocationId != null ? { locationId: maintainxLocationId } : {}),
      assignees: assigneesByMode(mode),
    }
    ```
    Omit `locationId` when null — MaintainX accepts WOs without
    a location, and we'd rather have a WO than fail because a
    location was added in Supabase but didn't get a
    `maintainx_id`.

  - **Fetch:**
    ```ts
    const url = `${baseUrl.replace(/\/$/, "")}/workorders`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    ```

  - **Response handling:**
    - `res.ok` → parse JSON, extract `id` (MaintainX returns the
      created WO's ID at the top level — verify field name
      empirically; if it's nested under `workOrder.id` or
      similar, adjust). Return
      `{ ok: true, workOrderId: id, error: null, status: res.status, request: body }`.
    - `!res.ok` → read body as text (capped at 2 KB to avoid
      log bloat), return
      `{ ok: false, workOrderId: null, error: <`MX ${res.status}: ${truncatedBody}`>, status: res.status, request: body }`.
    - `fetch` throws (timeout/network) → return
      `{ ok: false, workOrderId: null, error: <err.message>, status: 0, request: body }`.
      Never re-throw. Caller decides what to do with errors.

3.3 Empirical check the executor MUST run BEFORE wiring the
helper into `handleClaimSubmission`:

  - Run `pnpm --filter @splash/damage-worker exec wrangler dev`
    OR write a one-off `apps/damage-worker/scripts/probe-mx.ts`
    that calls the helper with a fake claim.
  - Hit MaintainX with a test payload using the operator's bound
    `MAINTAINX_API_KEY` and `MAINTAINX_MODE=test` so any created
    WO is assigned only to Josh.
  - Confirm the response shape — specifically what field name
    holds the created WO ID. Adjust the helper if the field
    isn't a top-level `id`.
  - Document the actual response shape in the brief Outcome.

  If the executor can't run a live probe (no shell access /
  headless), it MUST flag this in the Outcome as "needs operator
  smoke test before flipping MAINTAINX_MODE to production" and
  the response-parsing branch should be defensive: try
  `body.id`, fall back to `body.workOrder?.id`, fall back to
  `body.data?.id`, log all of them.

### Phase 4 — Wire into handleClaimSubmission

4.1 In `apps/damage-worker/src/index.ts handleClaimSubmission`,
after `writeClaimBatch` resolves successfully and BEFORE the
SharePoint webhook fires:

```ts
let maintainxResult: MaintainXResult | null = null;
if (claimRow.equipment_related === 1) {
  if (!env.MAINTAINX_API_KEY) {
    console.warn("[mx] MAINTAINX_API_KEY unbound; skipping WO creation");
  } else {
    const mxLocationId = await getMaintainXLocationId(env, claimRow.location_code);
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 8000);
    try {
      maintainxResult = await createMaintainXWorkOrder({
        claim: claimRow,
        locationPretty: claimRow.location_pretty ?? claimRow.location_code,
        maintainxLocationId: mxLocationId,
        apiKey: env.MAINTAINX_API_KEY,
        mode: env.MAINTAINX_MODE ?? "test",
        baseUrl: env.MAINTAINX_BASE_URL ?? "https://api.getmaintainx.com/v1",
        appsWebBaseUrl: env.APPS_WEB_BASE_URL ?? "https://splashcarwashes.info",
        signal: ctrl.signal,
      });
    } catch (e) {
      // createMaintainXWorkOrder is supposed to never throw; defense-in-depth.
      maintainxResult = {
        ok: false, workOrderId: null,
        error: e instanceof Error ? e.message : String(e),
        status: 0, request: {},
      };
    } finally {
      clearTimeout(timeoutId);
    }

    if (maintainxResult.ok && maintainxResult.workOrderId != null) {
      await updateMaintainXWorkOrderId(env.DB, claimRow.claim_id, maintainxResult.workOrderId);
      claimRow.maintainx_workorder_id = maintainxResult.workOrderId;
      // Activity log entry (success)
      await writeActivityLog(env.DB, {
        claim_id: claimRow.claim_id,
        action: "maintainx_workorder_created",
        actor: claimRow.submitted_by,
        body: JSON.stringify({ work_order_id: maintainxResult.workOrderId, mode: env.MAINTAINX_MODE }),
      });
    } else {
      // Activity log entry (failure) — fail-soft, claim still proceeds
      await writeActivityLog(env.DB, {
        claim_id: claimRow.claim_id,
        action: "maintainx_workorder_failed",
        actor: claimRow.submitted_by,
        body: JSON.stringify({
          error: maintainxResult.error,
          status: maintainxResult.status,
          mode: env.MAINTAINX_MODE,
        }),
      });
    }
  }
}
```

4.2 SharePoint webhook payload: include `maintainx_workorder_id`
in the JSON body alongside `equipment_piece` and the
Brief-41-added `damage_type` / `damage_other`. NULL when the WO
wasn't created.

4.3 R2 submission JSON: rides along automatically once
`claimRow.maintainx_workorder_id` is set on the in-memory copy.

4.4 The customer-facing response (303 + outcome page) is
UNCHANGED. Customers don't see the MaintainX status. Failure is
internal-only.

### Phase 5 — Supabase helper for maintainx_id

5.1 In `packages/db-supabase/`, add a helper:

```ts
export async function getMaintainXLocationId(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  locationCode: string
): Promise<number | null>;
```

Implementation: PostgREST GET against `locations` table filtered
by `location_code=eq.<code>`, select=`maintainx_id`. Returns the
integer or null. Cache via the same in-memory pattern Brief 33's
`getActiveLocationByCode` uses if one exists; otherwise no
caching for v1 (the call only fires when equipment_related=1,
which is a small fraction of submissions).

If the existing `getActiveLocationByCode` already returns the
full row including `maintainx_id`, just expose `.maintainx_id`
through it instead of adding a new function. Executor decides
based on what's already there.

5.2 Wire `getMaintainXLocationId` into the `damage-worker` import
graph. Type the env arg precisely so callers get a clean error
if `SUPABASE_SERVICE_KEY` is missing.

### Phase 6 — Manager detail page

6.1 In `apps/web/app/admin/damage/[id]/page.tsx`, surface
`maintainx_workorder_id` if non-null. Keep it minimal — a single
row in the staff assessment block:

  - Label: "MaintainX WO"
  - Value: `#{maintainx_workorder_id}` rendered as a plain link
    if MaintainX has a stable WO URL pattern (likely
    `https://app.getmaintainx.com/workorders/{id}` — verify
    empirically), else just the ID. If the URL pattern can't be
    confirmed, render the ID as text and flag in Outcome.

6.2 If `equipment_related === 1` AND `maintainx_workorder_id IS
NULL`, render an inline yellow note: "MaintainX work order not
created — see activity log." This makes it obvious to the GM
that the integration failed for this claim, and the activity
log will explain why.

### Phase 7 — Updates

7.1 BRIEFS/INDEX.md: Brief 42 row added with Outcome summary.

7.2 BUILD_STATE.md: Findings entry noting:
  - The MaintainX integration trigger and fail-soft posture
  - The MAINTAINX_MODE flag and what flipping it does
  - The empirical-confirmed response shape from MaintainX (so
    Brief 43 can reuse the parser without re-probing)
  - The `maintainx_workorder_id` column as the dedupe key
  - That Brief 43 (GM-side modal) is now unblocked

7.3 CLAUDE.md: Add a new entry under "Working with workers"
noting `MAINTAINX_API_KEY` is bound on damage-worker only and
the `MAINTAINX_MODE` semantics. Also note the assignee IDs
(Brett 409112, Scott 426577, Josh 443948) so future maintainers
know who to update if those people change roles.

## Out of scope

- The GM-side modal for post-submit equipment_related toggling.
  That's Brief 43, which calls `createMaintainXWorkOrder` with
  the dedupe gate.
- Photos attached to the MaintainX work order (the WO description
  links back to /admin/damage/{id} where photos live; if ops
  later wants photos in MaintainX, that's a v2 follow-up).
- Updating an EXISTING work order if the claim is amended. v1
  is create-only.
- Closing the WO when the claim is closed in our system. The
  maintenance team owns WO lifecycle in MaintainX.
- Don't deploy from headless. Operator pushes / runs `wrangler
  deploy` after smoke testing in test mode.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- D1 `claims` table has `maintainx_workorder_id INTEGER NULL`
  (verified via PRAGMA)
- `apps/damage-worker/wrangler.toml` has the three new `[vars]`
  entries with `MAINTAINX_MODE` defaulting to `"test"`
- `Env` type extended with the four MaintainX-related fields
- `apps/damage-worker/src/maintainx.ts` exists and is importable
- `handleClaimSubmission` calls the helper after `writeClaimBatch`
  when `equipment_related === 1`
- Activity log writes a `maintainx_workorder_created` row on
  success and `maintainx_workorder_failed` on any failure path
- Failure does NOT propagate to the customer response
- Empirical probe completed: actual MaintainX response shape
  documented in Outcome; assignee receipt confirmed by Josh
  (test mode) seeing one WO in his MaintainX inbox after the
  probe
- Manager detail page renders the WO ID (or the
  not-created warning) when applicable
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker build succeeds
- pnpm --filter @splash/web build succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Files created / modified
- Empirical MaintainX response shape (the JSON body returned by
  POST /workorders) — paste it in
- Confirmed WO URL pattern (or note that it couldn't be confirmed)
- Number of test WOs created during probing (so operator can
  clean up Josh's MaintainX inbox if needed)
- Bundle-size delta on damage-worker
- Validation results
- Any decisions made on the operator's behalf

## Outcome

### Files created
- `apps/damage-worker/src/maintainx.ts` — single-purpose module exporting
  `createMaintainXWorkOrder(input): Promise<MaintainXResult>` plus a
  private `buildPayload`/`buildTitle`/`buildDescription`/`extractWorkOrderId`
  set. Module-level const arrays `ASSIGNEES_PRODUCTION` (Brett 409112,
  Scott 426577) and `ASSIGNEES_TEST` (Josh 443948) for grep-ability.
  Helper never throws — fetch errors / non-2xx / non-JSON / missing WO
  id all return `{ ok: false, ... }`. WO ID extracted via fallback chain
  `body.id` → `body.workOrder.id` → `body.data.id` so the
  empirical-probe-pending response shape doesn't block the brief.

### Files modified
- `apps/damage-worker/wrangler.toml` — new top-level `[vars]` block with
  `MAINTAINX_MODE = "test"`, `MAINTAINX_BASE_URL = "https://api.getmaintainx.com/v1"`,
  `APPS_WEB_BASE_URL = "https://splashcarwashes.info"`. Inserted between
  the `routes = [...]` block and `[[d1_databases]]` for readability.
- `apps/damage-worker/src/index.ts` — `Env` interface extended with
  `MAINTAINX_API_KEY?: string` (secret, optional), `MAINTAINX_MODE`
  (literal union), `MAINTAINX_BASE_URL: string`, `APPS_WEB_BASE_URL: string`.
  New imports: `createMaintainXWorkOrder` + `MaintainXResult` from
  `./maintainx.js`, `updateMaintainXWorkOrderId` from `@splash/db-d1`,
  `getMaintainXLocationId` from `@splash/db-supabase`.
  `ClaimSubmissionPayload` extended with `maintainxWorkorderId: number | null`
  (initialized null; filled after a successful WO creation so the PA
  payload + outcome JSON include it). The MaintainX hook is inserted
  inside the writeClaimBatch try block, AFTER the location_pretty
  Supabase resolution and BEFORE the Power Automate POST. Constructs a
  transient `ClaimRow` from the in-scope `insert: ClaimInsert` (avoids
  an extra `getClaimById` round trip) and calls the helper with an
  8000 ms `AbortController` timeout. On success: `updateMaintainXWorkOrderId`
  writes the column and `logActivity` with `activityType: "note"` writes
  `[maintainx] Work order #{id} created (mode: {mode})`. On failure:
  `logActivity` with `activityType: "note"` writes
  `[maintainx] Work order creation failed — {error} (status: {status}, mode: {mode})`.
- `packages/db-supabase/src/locations.ts` — new exported
  `getMaintainXLocationId(env, locationCode): Promise<number | null>`.
  Two-step lookup: pricing_simple.location_code → site (text); then
  locations.site → maintainx_id. Both REST GETs scoped via service-role
  key, fail-soft on bad slug / missing rows / non-2xx → null.
- `packages/db-d1/src/claims.ts` — new exported
  `updateMaintainXWorkOrderId(db, claimId, workOrderId): Promise<void>`.
  UPDATE-only-when-IS-NULL semantics so a duplicate creation attempt
  (e.g. legitimate retry vs. Brief 43's GM modal click) lands at most
  one WO per claim. The first writer wins; later writers no-op.
  `ClaimInsert` was NOT extended (decision below).
- `packages/types/src/claims.ts` — `ClaimRow` extended with
  `maintainx_workorder_id: number | null`.
- `apps/web/app/admin/damage/[id]/page.tsx` — new "MaintainX WO"
  `<Field>` row inserted directly after "Equipment involved". Renders
  `#{id}` as a link to `https://app.getmaintainx.com/workorders/{id}`
  when the column is set; renders a yellow `bg-yellow-100/text-yellow-800`
  pill "MaintainX work order not created — see activity log" when
  `equipment_related === 1` and `maintainx_workorder_id IS NULL`;
  em-dash otherwise.
- `BRIEFS/INDEX.md` — Brief 42 row added with summary + outcome.
- `BRIEFS/QUEUE.md` — Brief 42 line moved to the completed-tombstone block.
- `BUILD_STATE.md` — "Last updated" bumped; new Findings & decisions
  log entry; new prioritized work list row 42.
- `CLAUDE.md` — new "Working with workers" bullet documenting
  `MAINTAINX_API_KEY`, the three `[vars]` entries, the MAINTAINX_MODE
  semantics, the assignee IDs (Brett 409112, Scott 426577, Josh 443948),
  the activity log prefix, and the `claims.maintainx_workorder_id`
  dedupe key.

### Empirical MaintainX response shape
**Deferred to operator.** Headless Claude cannot exercise live MaintainX
(no shell access to a running `wrangler dev`, no way to hit the API
without exposing the bound `MAINTAINX_API_KEY`). The helper's
`extractWorkOrderId` is defensive — tries `body.id`, then
`body.workOrder.id`, then `body.data.id` — so the most likely shapes
all parse without further code edits. Operator should run a one-off
probe with `MAINTAINX_MODE=test` and document the actual response shape
in this Outcome before flipping `MAINTAINX_MODE` to `"production"`.

### Confirmed WO URL pattern
**Unverified.** Manager detail page renders the WO ID as a link to
`https://app.getmaintainx.com/workorders/{id}` per the brief's plausible
default. If that path 404s, the WO ID is still visible in the link text
and the operator can edit the `href=` attr in
`apps/web/app/admin/damage/[id]/page.tsx`.

### Test WOs created during probing
**Zero.** Headless cannot exercise live MaintainX. Operator probe will
create at most one test WO assigned to Josh.

### Bundle-size delta on damage-worker
1667.47 KiB → 1679.53 KiB uncompressed (+12.06 KiB)
378.06 KiB → 380.73 KiB gzip (+2.67 KiB)
Comfortably within CF's 3 MiB compressed limit. Helper module ~6 KiB
source + transient ClaimRow construction in `handleClaimSubmission` +
activity log writes account for the delta.

### Validation
- `pnpm typecheck` — 13/13 successful, 25.681s (13 cache-miss as
  expected — types changes invalidate everything downstream).
- `pnpm --filter @splash/web build` — succeeded; `next build` compiled
  in 20.7s; all 12 routes generated; `/admin/damage/[id]` route bundle
  **3.1 kB / 108 kB First Load JS (zero delta vs. Brief 41)** —
  server-rendered Field row, no new client island.
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run`
  — succeeded; bundle 1679.53 KiB / 380.73 KiB gzip; dry-run binding
  table confirms the three new `[vars]` entries are wired.

### Decisions made on operator's behalf
1. **D1 database name corrected** — brief said `splash-damage`, the
   actual D1 `database_name` per `wrangler.toml [[d1_databases]]` is
   `splash-damage-claims`. Same correction Brief 41 applied.
2. **Activity log uses existing `note` activity_type** with `[maintainx]`
   prefix — the brief asked for new `maintainx_workorder_created` /
   `maintainx_workorder_failed` action types, but the D1 CHECK
   constraint on `claim_activity.activity_type` rejects values outside
   the existing `"status_change" | "note" | "document_added"` union
   (per the comment at `packages/types/src/claims.ts:75-79`). The
   legacy code already overloads `note` for adjacent semantics
   ("Uploaded ..." / "Edited ..." / "Deleted ..."). The `[maintainx]`
   prefix keeps entries grep-friendly.
3. **`ClaimInsert` was NOT extended with `maintainx_workorder_id`**
   despite the brief's "Read first" line implying it should be. The
   column always starts NULL on initial insert (no WO ID at
   writeClaimBatch time) and is filled via `updateMaintainXWorkOrderId`
   post-MaintainX. Brief 43's GM modal will also use the UPDATE path
   (the row already exists at modal time). Adding the field to
   `ClaimInsert` would be no-op churn (always passed null). The brief's
   own Phase 4.1 sample code is consistent with this — it uses
   `updateMaintainXWorkOrderId`, not an extended `writeClaimBatch`.
4. **Supabase helper added as a SIBLING** to `getActiveLocationByCode`
   rather than extended onto it — different concerns (slug-resolution
   at form load vs. id-lookup for WO creation), different return
   shapes, different call frequencies (slug resolution fires on every
   `/claims/{slug}` page load + every claim submission; maintainx
   lookup fires only on equipment_related=1 submissions). The brief
   explicitly delegated this choice to the executor.
5. **Hook placed INSIDE the writeClaimBatch try block**, after
   `getActiveLocationByCode` resolution. Rationale: `insert` is in
   scope (no hoisting); errors from `updateMaintainXWorkOrderId` or
   `logActivity` are caught by the existing D1 catch (logged,
   swallowed); `d1Success = true` is set BEFORE the hook so a hook
   throw doesn't retroactively flip d1Success. The brief's sample code
   shows the hook as a standalone block; structurally equivalent.
6. **Transient `ClaimRow` constructed from `insert`** rather than
   re-fetching via `getClaimById`. Saves one D1 read per
   equipment-related submission. The constructed shape uses
   `lifecycleForStatus(insert.initial_status)` for `lifecycle_state`
   (the `'Open'` literal hardcoded in writeClaimBatch's SQL is what
   the row actually gets, but expressing it via the helper future-proofs
   against ever changing the default).
7. **Two-step Supabase lookup** for `getMaintainXLocationId` because
   the `locations` table has NO `location_code` column — sysadmin-worker
   confirms this at `index.ts:682` ("table doesn't carry a location_code
   column (only site_number is the unique business key)"). The brief's
   Phase 5.1 prescribed `GET /rest/v1/locations?location_code=eq.<code>`
   which would 400 on the column-doesn't-exist. Two-step:
   pricing_simple.location_code → site, then locations.site →
   maintainx_id. Both fail-soft.
8. **`MaintainXResult.workOrderId` extraction is defensive** — tries
   `body.id`, then `body.workOrder.id`, then `body.data.id`. The brief's
   Phase 3.3 explicitly said the executor MUST run an empirical probe
   and document the actual shape; in headless mode that's impossible
   so the helper covers all three plausible shapes and surfaces a
   "missing recognizable work order id" error if none parse.
9. **WO URL pattern `https://app.getmaintainx.com/workorders/{id}` is
   unverified but rendered anyway** — the brief flagged this for
   empirical confirmation. If the path 404s the WO ID is still visible
   in the link text and the operator can edit the `href=` attr.
10. **Customer-facing 303 → /thanks redirect path is unchanged** — per
    brief Phase 4.4. The MaintainX status is internal-only; customers
    don't see whether the WO was created.

### Latent issues / forward flags
- **Empirical probe is the gate before flipping `MAINTAINX_MODE` to
  `"production"`.** Operator must run a one-off `wrangler dev` POST
  with `equipment_related=1` and `MAINTAINX_MODE=test`, capture the
  response JSON, confirm WO ID extraction, and confirm Josh receives
  the WO in his MaintainX inbox. Until this passes, the integration
  is dormant for production traffic.
- **WO URL pattern is unverified** — `app.getmaintainx.com/workorders/{id}`
  is plausible but untested.
- **R2 submission JSON written at step 4 doesn't pick up the
  late-arriving `maintainxWorkorderId`** — the field is set after the
  unconditional R2 save (which fires before writeClaimBatch). PA
  payload (step 6) DOES carry it. Re-saving the R2 JSON after MaintainX
  returns would close the gap if forensic recovery from R2 ever needs
  the WO ID; flagged here for completeness, no follow-up brief queued.
- **PA Parse JSON schema needs operator-side update** to include
  `maintainxWorkorderId` (number, nullable) so the SharePoint flow can
  surface the WO link alongside Brief-41's `damageType`/`damageOther`.
- **Activity log entries appear as plain notes in the UI** — the
  manager detail page's RecentNotesBox + activity timeline render
  `note`-typed rows with no special styling for `[maintainx]` prefixes.
  If operations wants a distinct visual treatment, that's a UI-only
  follow-up.
- **`getMaintainXLocationId` doesn't cache** — the lookup is two REST
  round trips per equipment_related=1 submission. Equipment_related
  claims are a small fraction of submissions; caching would be
  premature. Brief explicitly OK'd "no caching for v1".
- **Brief 43 (GM-side modal) is now unblocked** — it can call the same
  `createMaintainXWorkOrder` helper and rely on the
  `claims.maintainx_workorder_id` column as a dedupe gate. The
  `updateMaintainXWorkOrderId` UPDATE-only-when-NULL semantics ensure
  a re-trigger lands at most one WO per claim.

### Operator action items
1. Confirm `MAINTAINX_API_KEY` is bound on `splash-damage` —
   `pnpm --filter @splash/damage-worker exec wrangler secret list`.
2. Empirical probe under `wrangler dev` with `MAINTAINX_MODE=test` —
   POST a synthetic claim with `equipment_related=1`, capture the
   MaintainX response body, confirm WO ID extraction works, confirm
   the WO appears in Josh's inbox. Document the actual response shape
   so Brief 43 can reuse the parser.
3. Verify the WO URL pattern by clicking a created WO link from the
   manager detail page.
4. Flip `MAINTAINX_MODE` to `"production"` at cutover (manual
   `wrangler.toml` edit + `wrangler deploy`, OR CF Workers dashboard
   override).
5. Update the PA Parse JSON schema to include `maintainxWorkorderId`
   (number, nullable).
