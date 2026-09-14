# Brief 65: Daily open-claims summary cron — bolt-on damage-worker, RD/RM/location hierarchy, PA email

**Status:** Completed (2026-05-07)
**Started:** 2026-05-07
**Completed:** 2026-05-07
**Blocks:** Operator wants every gm / rm / admin / super_admin to
get a once-a-day digest of open damage claims relevant to them.
Today nobody gets one — they have to log in and check
`/admin/damage` manually.
**Dependencies:** Brief 49 (auth-context view shape), Brief 59
(`pricing_simple.area_manager` / `regional_manager` lookup
pattern), Brief 61 (`damage_claim_user_roles` + `dc_locations`
write path), Brief 64 (corrected schema for those tables).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-049-getlocationcontactinfo-read-from-pricing-simple.md
  (the pricing_simple-as-source-of-truth pattern)
- BRIEFS/brief-059-damage-am-rm-filters-and-reporting-tab.md
  (Phase 1 — `listContactRoster` helper; we'll re-use the same
  per-location field set)
- BRIEFS/brief-061-sysadmin-set-dc-role-tool.md (defines the
  dc_role / dc_locations write path; this brief reads from the
  same tables via the auth-context view)
- BRIEFS/brief-064-set-dc-role-drop-email-column.md (lesson:
  email comes from auth.users via the auth-context view, not
  from the dc_role tables)
- BRIEFS/brief-063-wrangler-observability-logs.md (the
  `[observability.logs]` block — `eventType: scheduled` will
  surface in the same dashboard as fetch invocations)
- packages/db-supabase/src/auth-context.ts (the canonical view
  contract — confirms gm/rm/admin/super_admin live in the same
  view with `email`, `dc_role`, `dc_locations[]` aggregated)
- packages/db-d1/src/claims.ts (`listClaims`,
  `ClaimsListFilters` — the existing helper this brief calls)
- apps/damage-worker/src/index.ts (existing default export's
  `fetch` handler — this brief adds a `scheduled` sibling)
- apps/damage-worker/wrangler.toml (the file gaining a
  `[triggers]` block plus the new `DAILY_SUMMARY_WEBHOOK_URL`
  doc note)

## Context

**Recipients and what they see:**

- **gm**: scoped to their `dc_locations` (typically 1 location).
  Sees only the open claims at those locations.
- **rm**: scoped to their `dc_locations` (typically 2-5
  locations). Sees only the open claims at those locations,
  grouped by location.
- **admin**, **super_admin**: unrestricted. Sees ALL open claims
  companywide, grouped hierarchically by Regional Director →
  Regional Manager → Location. Operator confirmed 2026-05-07
  that this hierarchy is what makes the firehose digestible.

The hierarchy lives in `pricing_simple` per-location:
`area_manager` (RD's name), `am_email` (RD's email),
`regional_manager` (RM's name), `rm_email` (RM's email).

**Why bolt onto damage-worker (not a new worker):**

- All bindings already exist on damage-worker: `env.DB` (claims),
  Supabase env (auth-context view + pricing_simple), MaintainX
  env (unused but doesn't matter)
- Re-uses `listClaims` from `packages/db-d1` — no new D1 helper
  needed
- One fewer worker to provision, secret-bind, observability-toggle
- CF Workers support `{ fetch, scheduled }` on the same default
  export; logs differentiate by `eventType: scheduled` vs
  `fetch` (Brief 63's observability covers both automatically)

**Why "open" = `lifecycle_state === 'Open'` for v1:**

The operator said "open claims" so this brief mirrors the
existing Brief 59 definition (any claim_status NOT starting with
`Closed —`). That bucket includes everything from `New —
Pending Review` through `Approved — Check Issued` (paid is the
only Closed-Approved state). v2 could subdivide into
"Pending Review" (more actionable for GMs) vs "Approved
in-flight" (mostly waiting on parts/checks/etc.) — flagged
out of scope.

**Cron schedule:**

8 AM ET = 13:00 UTC. Cron expression: `0 13 * * *`. Runs every
day. Operator can change the schedule by editing the
`[triggers]` block + push.

**Skip-on-empty:** Users whose filter returns zero open claims
don't get an email at all. No "you have no open claims
today!" noise.

## Scope

### Phase 1 — `packages/db-supabase` — recipient + location-roster helpers

1.1 In `packages/db-supabase/src/auth-context.ts` (or a sibling
new file `summary.ts` if cleaner — executor's call), add:

```ts
export type DcRole = "gm" | "rm" | "admin" | "super_admin";

export interface SummaryRecipient {
  user_id: string;
  email: string;
  name: string | null;        // first/last name when auth.users carries it; null otherwise
  dc_role: DcRole;
  dc_locations: string[];     // [] for admin/super_admin (they're unrestricted)
}

export async function listSummaryRecipients(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string }
): Promise<SummaryRecipient[]>
```

  - Reads the auth-context view (whatever it's named —
    `auth_unified` per Brief 64's CLAUDE.md note; verify in
    `auth-context.ts`).
  - SELECT clause: `user_id, email, name, dc_role, dc_locations`.
  - WHERE: `dc_role IN ('gm','rm','admin','super_admin')`.
  - Ordering: `dc_role asc, email asc` (stable order so logs are
    grep-able).
  - Fail-soft: any thrown error returns `[]` and logs a console
    error so the cron still completes (vs throwing and aborting
    the whole batch).

1.2 Add a sibling helper for the location lookup table:

```ts
export interface LocationRosterEntry {
  location_code: string;
  location_pretty: string;
  rd_email: string | null;     // pricing_simple.am_email
  rd_name: string | null;      // pricing_simple.area_manager
  rm_email: string | null;     // pricing_simple.rm_email
  rm_name: string | null;      // pricing_simple.regional_manager
}

export async function fetchLocationRoster(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string }
): Promise<Map<string, LocationRosterEntry>>
```

  - One PostgREST GET against `pricing_simple` with
    `select=location_code,location_pretty,am_email,area_manager,rm_email,regional_manager`.
  - `limit=1000` (operator runs ~67 locations; plenty of room).
  - Returns a Map keyed by `location_code` for O(1) lookup
    inside the per-claim grouping loop.
  - Fail-soft: any thrown error returns an empty Map (the cron
    handler will still POST per-user but the hierarchy will
    bucket every claim under "(unassigned)" — see Phase 3.4).

1.3 Export both helpers from
`packages/db-supabase/src/index.ts`.

### Phase 2 — Damage-worker — `[triggers]` + scheduled handler

2.1 In `apps/damage-worker/wrangler.toml`, append:

```toml
# Brief 65 (2026-05-07): daily open-claims summary cron. Fires
# every day at 13:00 UTC (8 AM ET). The scheduled handler in
# src/index.ts builds per-user digests and POSTs to
# DAILY_SUMMARY_WEBHOOK_URL (Power Automate).
[triggers]
crons = ["0 13 * * *"]
```

  Position above the `[observability.logs]` block from Brief 63
  but below the existing `[[d1_databases]]` / `[vars]` /
  `[[services]]` blocks.

2.2 Bind a new secret on damage-worker:

```
pnpm --filter @splash/damage-worker exec wrangler secret put DAILY_SUMMARY_WEBHOOK_URL
```

  Operator paste-binds the URL after the brief lands. The
  scheduled handler skips POSTing if the secret is unbound (logs
  a warning and exits cleanly — same fail-soft posture as
  `CUSTOMER_CLAIM_WEBHOOK_URL` from Brief 32).

2.3 Document the new env in `apps/damage-worker/src/env.ts` (or
wherever the worker's Env interface lives) — add
`DAILY_SUMMARY_WEBHOOK_URL?: string`. Optional because the cron
fail-soft handles unbound.

2.4 In `apps/damage-worker/src/index.ts`:

  - Change the default export from `{ fetch }` to
    `{ fetch, scheduled }`.
  - The new `scheduled(event, env, ctx)` handler:
    1. If `!env.DAILY_SUMMARY_WEBHOOK_URL`, log and return.
    2. Fetch `recipients = await listSummaryRecipients(env)`.
    3. Fetch `locationsByCode = await fetchLocationRoster(env)`.
    4. Fetch `allOpenClaims = await listClaims(env.DB, {
       lifecycle: "Open" })`.
    5. For each recipient, filter + group + POST (Phase 3).
    6. Per-user errors are caught + logged; the loop continues.
       One bad user doesn't kill the batch.

2.5 Wrap the entire scheduled body in a top-level `try/catch`
that logs and re-throws so CF treats the invocation as failed
on a catastrophic error (catastrophic = listClaims itself
fails). Per-user errors stay swallowed.

### Phase 3 — Build per-user payload + POST

3.1 The configurable role allow-list lives at the top of the
scheduled handler:

```ts
// Brief 65 (2026-05-07): who gets the daily-summary email.
// Operator's 2026-05-07 decision: every gm/rm/admin/super_admin.
// Promote to a per-user opt-in column when a specific user
// requests opt-out without a role change.
const SUMMARY_DC_ROLES: DcRole[] = ["gm", "rm", "admin", "super_admin"];
```

`listSummaryRecipients` already filters to these roles per its
WHERE clause; this constant just documents the intent and gives
a single edit point if the policy ever changes.

3.2 Per-user filter:

```ts
const isUnrestricted =
  user.dc_role === "admin" || user.dc_role === "super_admin";
const userClaims = isUnrestricted
  ? allOpenClaims
  : allOpenClaims.filter((c) => user.dc_locations.includes(c.location_code));

if (userClaims.length === 0) continue; // skip empty digests
```

3.3 Per-claim enrichment:

For each claim, look up `locationsByCode.get(claim.location_code)`.
Stash the lookup result on the claim (in-memory only, not
persisted) — gives the grouping loop O(1) access to RD/RM/pretty
fields.

If the lookup misses (location was removed from pricing_simple
but claims still reference it), bucket the claim under sentinel
RD/RM names — see Phase 3.4.

3.4 Hierarchy build. The output structure:

```ts
interface DigestPayload {
  user: { user_id: string; email: string; name: string | null; dc_role: DcRole };
  as_of: string;       // ISO; cron's effective timestamp
  total_open: number;  // userClaims.length
  regional_directors: Array<{
    rd_email: string | null;
    rd_name: string;        // "(unassigned)" when null in source
    count: number;
    regional_managers: Array<{
      rm_email: string | null;
      rm_name: string;       // "(unassigned)" when null in source
      count: number;
      locations: Array<{
        location_code: string;
        location_pretty: string;  // falls back to location_code if null
        count: number;
        claims: Array<{
          claim_id: string;
          customer_name: string | null;
          vehicle: string;        // "<year> <make> <model>" assembled, "—" when fully missing
          claim_status: string;
          submitted_at: string;
          age_days: number;       // (now - submitted_at) / 86400, rounded
        }>;
      }>;
    }>;
  }>;
}
```

  - Locations whose `rd_email` is null bucket under `rd_name:
    "(unassigned)"`. Same pattern for null `rm_email`.
  - Within each level, sort by `count` desc, then by name asc
    (most-loaded RD first, alphabetical tiebreaker).
  - Within `claims`, sort by `submitted_at` asc (oldest first —
    those are the most action-needed).
  - `age_days` is rounded down (a 23-hour-old claim shows as
    0 days). Floor at 0.

3.5 POST to PA:

```ts
await fetch(env.DAILY_SUMMARY_WEBHOOK_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(15_000),
});
```

  - 15-second timeout per POST. PA flows generally respond within
    a couple seconds; 15 is generous.
  - On non-2xx, log `console.error("[daily-summary] POST failed",
    { user_email, status })` and continue with the next user.
  - On thrown (network / abort), same: log + continue.

3.6 Final batch summary log (informational, helpful for
ops verification):

```ts
console.log("[daily-summary] batch complete", {
  recipients: recipients.length,
  sent: sentCount,
  skipped_empty: skippedEmptyCount,
  failed_post: failedCount,
});
```

### Phase 4 — Power Automate flow (operator-side, out-of-code)

4.1 Operator creates a new PA flow:
  - Trigger: HTTP request received
  - Schema (paste-as-JSON to generate from sample): the `DigestPayload`
    interface from Phase 3.4 expressed as JSON Schema. Brief
    hands the operator a sample payload to use with PA's
    "use sample payload" button.
  - Action: Send an email (V2)
    - To: `triggerBody()?['user']?['email']`
    - Subject: e.g., "Daily damage-claim summary — {N} open"
    - Body: HTML with nested loops (Apply to each:
      regional_directors → regional_managers → locations →
      claims). Branch on dc_role to render `gm`/`rm` users
      without the RD/RM headers if they only have one of each.
    - Reply-To: optional — null/empty for v1; admin escalation
      goes to whatever the From mailbox is.
  - Save the trigger URL. Bind it as
    `DAILY_SUMMARY_WEBHOOK_URL` via wrangler secret per Phase 2.2.

4.2 Provide the operator with a sample payload JSON in the brief
outcome. The executor builds a stable sample (e.g., 1 RD with 2
RMs, 4 locations across them, 6 claims total) so PA's schema
parser produces a complete dynamic-content tree.

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass for all 13 packages.
5.2 `pnpm --filter @splash/damage-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed; clean
   up afterward. Confirm wrangler reports the cron trigger in
   the dry-run output.
5.3 Local smoke test of the scheduled body without scheduling:
   the handler can be exercised by calling `worker.scheduled(...)`
   from a test script, OR by issuing `wrangler dev --test-scheduled`
   and hitting `/__scheduled` (CF's local scheduler endpoint).
   Operator may defer this if the deploy is the easier
   verification path.
5.4 No schema changes. No new Supabase columns or tables. No
   wrangler binding changes besides the new secret (which is
   bound out-of-code by the operator).

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md: Brief 65 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
  - Daily 13:00 UTC cron on damage-worker emits per-user open
    claims digests via `DAILY_SUMMARY_WEBHOOK_URL` to Power
    Automate
  - gm/rm: scoped to their dc_locations, hierarchy degenerates
    to RD → RM → location(s) chain
  - admin/super_admin: unrestricted; full hierarchy across all
    locations; sorted by count desc within each level
  - Skip-on-empty: zero open claims means no email
  - In-code role filter: `SUMMARY_DC_ROLES = ["gm", "rm",
    "admin", "super_admin"]` — change + push to add/remove a
    role; per-user opt-out deferred to v2
  - Operator follow-up: bind `DAILY_SUMMARY_WEBHOOK_URL` via
    wrangler secret put after the cron deploy lands; build the
    PA flow per Phase 4 with the executor-provided sample
    payload; verify the next 13:00 UTC tick produces emails

6.3 CLAUDE.md updates:
  - "Working with workers" section: add a note that
    damage-worker now exports a `scheduled` handler (for the
    daily summary). Future cron additions to other workers
    should follow the same pattern: extend the default export
    to `{ fetch, scheduled }`, add a `[triggers]` block to
    wrangler.toml.
  - Glossary: add **Daily summary** entry — once-a-day digest
    of open claims, scoped per-user by dc_role; admin /
    super_admin gets the full RD/RM/location hierarchy

## Out of scope

- Per-user opt-in / opt-out (a `subscribe_daily_summary`
  preference flag). v2 if a specific user wants opt-out without
  a role change. Today the path is "remove their dc_role" or
  "edit `SUMMARY_DC_ROLES` to drop their role"; both are coarse.
- Subdividing "Open" into Pending-Review vs. Approved-In-Flight.
  Operator's instinct may want this for v2 once they see the
  daily volume.
- Including claim-detail links (e.g., per-claim
  `/admin/damage/{id}` link in the email body). PA can render
  these via dynamic content + `apps/web` base URL — handled in
  the PA template, not in the worker. The brief hands the
  operator the apps/web base URL pattern; no code change.
- Pagination / size limits. If a super_admin's payload exceeds
  PA's inbound JSON limit (~4 MB), the worker would 4xx — not a
  realistic problem at current claim volumes (~50/loc/year),
  but flagged. v2 would chunk by RD or page the claims list.
- Configurable per-user time of day. Single 13:00 UTC tick for
  all recipients in v1. v2 could read a `timezone` preference.
- Alternative delivery (Slack, SMS). PA could fan out to those
  from the email payload if the operator wants — handled
  PA-side, no worker change.
- Backfilling a "you missed yesterday's summary" email if the
  cron fails. CF retries scheduled invocations; if it
  catastrophically fails the day, manual replay is operator's
  call.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `listSummaryRecipients` and `fetchLocationRoster` helpers
  exported from `packages/db-supabase`
- damage-worker default export is `{ fetch, scheduled }`
- `apps/damage-worker/wrangler.toml` declares
  `[triggers] crons = ["0 13 * * *"]`
- Scheduled handler builds the Phase 3.4 hierarchy per recipient
  and POSTs to `DAILY_SUMMARY_WEBHOOK_URL` with skip-on-empty
- Per-user errors swallowed with logging; batch summary logged
  at completion
- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/damage-worker exec wrangler deploy
  --dry-run bundle succeeds (clean up after) and reports the
  cron trigger
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- Sample payload JSON included in the outcome for operator
  PA-flow setup
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely 200-300 lines net: 2 helpers in
  packages/db-supabase + scheduled handler in damage-worker +
  wrangler trigger block + types)
- Confirmation of the per-recipient flow:
  - gm/rm filtered to dc_locations
  - admin/super_admin unrestricted
  - hierarchy correctly nests RD → RM → location → claims
  - skip-on-empty works
- Sample payload JSON for both a gm user and an admin user
  (the operator pastes these into PA's "use sample payload"
  picker)
- Validation results
- Any decisions made on the operator's behalf

## Outcome

### Files created

- `packages/db-supabase/src/summary.ts` — two helpers + types:
  - `listSummaryRecipients(env)` — reads `auth_unified` via PostgREST,
    server-side filters on `dc_role IN (gm,rm,admin,super_admin)`,
    orders by `dc_role.asc,email.asc`, fail-soft returns `[]`.
  - `fetchLocationRoster(env)` — reads `pricing_simple` for
    `location_code,location_pretty,am_email,area_manager,rm_email,
    regional_manager`, collapses on first-seen by location_code (the
    location-level columns are denormalized from `locations` by
    `trg_sync_pricing_simple` and so are identical across all package
    rows for a given code), returns `Map<string, LocationRosterEntry>`
    for O(1) per-claim lookup. Fail-soft returns empty Map.
  - Exported types: `SummaryRecipient`, `LocationRosterEntry`,
    `DcRoleForSummary` (alias for `@splash/types/claims` `DamageRole`).

### Files modified

- `packages/db-supabase/src/index.ts` — re-export `./summary.js`.
- `apps/damage-worker/wrangler.toml` — append `[triggers] crons =
  ["0 13 * * *"]` block above `[observability.logs]`. Comment block
  documents the fail-soft posture and the operator's wrangler-secret
  bind step.
- `apps/damage-worker/src/index.ts`:
  - Import `listSummaryRecipients`, `fetchLocationRoster`,
    `LocationRosterEntry`, `SummaryRecipient` from `@splash/db-supabase`.
  - Import `DamageRole` type from `@splash/types/claims`.
  - Add `DAILY_SUMMARY_WEBHOOK_URL?: string` to the `Env` interface.
  - Default export becomes `{ fetch, scheduled }`. The scheduled
    handler is `async scheduled(_controller: ScheduledController, env,
    ctx)` and calls `ctx.waitUntil(runDailySummaryCron(env))`.
  - New module additions at end of file:
    - `SUMMARY_DC_ROLES = ["gm","rm","admin","super_admin"]`
      constant — single edit point for role-level opt-out.
    - `runDailySummaryCron(env)` — top-level cron entry; checks
      webhook secret, parallel-fetches recipients + locationsByCode +
      `listClaims({lifecycle:"Open", limit:5000})`; iterates
      recipients, filters per dc_role, skips empties, builds payload,
      POSTs digest, accumulates counters; logs final batch summary.
      Catastrophic load failure logs and re-throws so CF marks the
      invocation failed.
    - `buildDigestPayload(user, userClaims, locationsByCode, asOf)` —
      groups claims by RD email → RM email → location_code, materializes
      hierarchy with counts rolled up at each level, sorts by count
      desc + name asc within each level, claims sorted submitted_at
      asc, age_days computed (floor at 0). Sentinel `(unassigned)`
      for null rd_email/rm_email.
    - `assembleVehicle(year, make, model)` — `"<year> <make> <model>"`
      with `"—"` fallback when all three are null/blank.
    - `ageDays(submittedAt, nowMs)` — floor((now - submitted) /
      86_400_000), floored at 0.
    - `postDigest(webhookUrl, payload, userEmail)` — POST with 15-second
      `AbortSignal.timeout`; non-2xx and thrown both log and return
      false.

### Decisions made on operator's behalf

1. **`name` field on `SummaryRecipient` is always null today.** The
   `auth_unified` view does NOT expose a name column (verified via
   `packages/db-supabase/src/auth-context.ts`'s `AuthUnifiedRow`
   shape). The brief explicitly anticipated this with "null
   otherwise"; PA's email template can fall back to the email's
   local-part for greetings, or operator can later extend the view
   to project `auth.users.raw_user_meta_data->>'full_name'` (or
   similar) and the helper's interface stays compatible since
   `SummaryRecipient.name` is already nullable. Flagged as a forward
   v1.5 candidate.

2. **Helpers placed in a new sibling `summary.ts`** rather than
   appended to `auth-context.ts`. The brief explicitly allowed this
   ("or sibling new file `summary.ts` if cleaner — executor's
   call"), and the sibling keeps the auth-context module focused on
   session shape.

3. **`listClaims({lifecycle:"Open", limit:5000})`** — passed an
   explicit limit override. Realistic open-claims volume (~50/loc/yr
   × 67 locations × ~0.5 still-open ≈ 1675) fits well below 5000;
   single fetch covers admin/super_admin's full view. v2 candidate:
   chunk by RD or page if super_admin volume eventually exceeds PA's
   inbound JSON limit (~4 MB).

4. **`scheduled(_controller: ScheduledController, …)`** not
   `ScheduledEvent` — TypeScript's `ExportedHandlerScheduledHandler`
   types the first arg as `ScheduledController`. First typecheck
   attempt failed with TS2322 on `ScheduledEvent` (shape mismatch);
   corrected.

5. **In-code `SUMMARY_DC_ROLES` constant.** The brief's wording is
   "every gm/rm/admin/super_admin"; this constant documents the
   policy in code, gives a single edit point, and is referenced in
   CLAUDE.md's new Daily-summary glossary entry.

6. **Multi-row `pricing_simple` collapse via first-seen** in
   `fetchLocationRoster`. `pricing_simple` has multiple rows per
   `location_code` (one per package), but the columns we read are
   denormalized FROM `locations` BY `trg_sync_pricing_simple` and so
   are identical across all rows for a code. First-seen collapse is
   correct and avoids a `select=distinct` round-trip.

### Latent issues found

- **Operator must bind `DAILY_SUMMARY_WEBHOOK_URL`** via `pnpm
  --filter @splash/damage-worker exec wrangler secret put
  DAILY_SUMMARY_WEBHOOK_URL` after the next CF Workers Builds deploy
  lands; until then the cron logs `"[daily-summary]
  DAILY_SUMMARY_WEBHOOK_URL unbound — skipping"` and exits cleanly.
- **Operator must build the PA flow** per Phase 4 of the brief using
  the sample payloads below.
- **No headless smoke test possible.** `wrangler dev
  --test-scheduled` runs locally but a true E2E requires the real D1
  binding; defer to first 13:00 UTC tick post-deploy.
- **Open-claim definition is `lifecycle: "Open"` for v1** — mirrors
  Brief 59's bucket (any claim_status NOT starting with `Closed —`).
  v2 candidate: subdivide into "Pending Review" (more actionable for
  GMs) vs. "Approved in-flight" (waiting on parts/checks).
- **Single 13:00 UTC tick** — no per-user timezone preference today.
  v2 could read a `timezone` column from auth_unified or a user-prefs
  table.

### Validation

- `pnpm typecheck` — all 13 packages pass (4.071s after fixing the
  `ScheduledEvent` → `ScheduledController` shape mismatch caught on
  first attempt).
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run
  --outdir=.dryrun` — bundle succeeded at **1715.21 KiB / gzip
  388.18 KiB** (Brief 64 baseline ~1705 KiB / ~386 KiB; +~10 KiB raw
  / +~2 KiB gzip — well within budget). `.dryrun/` cleaned up after.
  Confirmed `runDailySummaryCron`, `listSummaryRecipients`, and the
  `scheduled` handler are present in the bundled output (`grep -c`
  returned 11 matches).

### Sample payloads for PA flow setup

#### Sample A — `gm` user with two open claims at one location

```json
{
  "user": {
    "user_id": "11111111-1111-4111-8111-111111111111",
    "email": "gm.binghamton@splashcarwashes.com",
    "name": null,
    "dc_role": "gm"
  },
  "as_of": "2026-05-07T13:00:00.000Z",
  "total_open": 2,
  "regional_directors": [
    {
      "rd_email": "bsullivan@splashcarwashes.com",
      "rd_name": "Brett Sullivan",
      "count": 2,
      "regional_managers": [
        {
          "rm_email": "scott.butler@splashcarwashes.com",
          "rm_name": "Scott Butler",
          "count": 2,
          "locations": [
            {
              "location_code": "binghamton",
              "location_pretty": "Binghamton",
              "count": 2,
              "claims": [
                {
                  "claim_id": "BIN-20260420-091233-K8X2",
                  "customer_name": "Maria Rodriguez",
                  "vehicle": "2019 Toyota Camry",
                  "claim_status": "Pending GM Review",
                  "submitted_at": "2026-04-20T09:12:33.000Z",
                  "age_days": 17
                },
                {
                  "claim_id": "BIN-20260503-141855-Q3R7",
                  "customer_name": "Daniel Park",
                  "vehicle": "2022 Honda Civic",
                  "claim_status": "New — Pending Review",
                  "submitted_at": "2026-05-03T14:18:55.000Z",
                  "age_days": 4
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

#### Sample B — `admin` user, full hierarchy across two RDs / three RMs / four locations / six claims

```json
{
  "user": {
    "user_id": "22222222-2222-4222-8222-222222222222",
    "email": "incidents@splashcarwashes.com",
    "name": null,
    "dc_role": "admin"
  },
  "as_of": "2026-05-07T13:00:00.000Z",
  "total_open": 6,
  "regional_directors": [
    {
      "rd_email": "bsullivan@splashcarwashes.com",
      "rd_name": "Brett Sullivan",
      "count": 4,
      "regional_managers": [
        {
          "rm_email": "scott.butler@splashcarwashes.com",
          "rm_name": "Scott Butler",
          "count": 3,
          "locations": [
            {
              "location_code": "binghamton",
              "location_pretty": "Binghamton",
              "count": 2,
              "claims": [
                {
                  "claim_id": "BIN-20260420-091233-K8X2",
                  "customer_name": "Maria Rodriguez",
                  "vehicle": "2019 Toyota Camry",
                  "claim_status": "Pending GM Review",
                  "submitted_at": "2026-04-20T09:12:33.000Z",
                  "age_days": 17
                },
                {
                  "claim_id": "BIN-20260503-141855-Q3R7",
                  "customer_name": "Daniel Park",
                  "vehicle": "2022 Honda Civic",
                  "claim_status": "New — Pending Review",
                  "submitted_at": "2026-05-03T14:18:55.000Z",
                  "age_days": 4
                }
              ]
            },
            {
              "location_code": "oswego",
              "location_pretty": "Oswego",
              "count": 1,
              "claims": [
                {
                  "claim_id": "OSW-20260428-103011-A4M9",
                  "customer_name": "Jennifer Lee",
                  "vehicle": "2020 Subaru Outback",
                  "claim_status": "Approved — Pending Quotes",
                  "submitted_at": "2026-04-28T10:30:11.000Z",
                  "age_days": 9
                }
              ]
            }
          ]
        },
        {
          "rm_email": "rm.east@splashcarwashes.com",
          "rm_name": "Pat Morgan",
          "count": 1,
          "locations": [
            {
              "location_code": "fayetteville",
              "location_pretty": "Fayetteville",
              "count": 1,
              "claims": [
                {
                  "claim_id": "FAY-20260501-160044-B7T1",
                  "customer_name": "Marcus Allen",
                  "vehicle": "2023 Ford F-150",
                  "claim_status": "Approved — Check Request Submitted",
                  "submitted_at": "2026-05-01T16:00:44.000Z",
                  "age_days": 5
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "rd_email": "rd.west@splashcarwashes.com",
      "rd_name": "Avery Chen",
      "count": 2,
      "regional_managers": [
        {
          "rm_email": "rm.west@splashcarwashes.com",
          "rm_name": "Jordan Smith",
          "count": 2,
          "locations": [
            {
              "location_code": "albany",
              "location_pretty": "Albany",
              "count": 2,
              "claims": [
                {
                  "claim_id": "ALB-20260415-073300-Z2Y8",
                  "customer_name": "Linda Carter",
                  "vehicle": "2018 Chevrolet Equinox",
                  "claim_status": "Pending RM Review",
                  "submitted_at": "2026-04-15T07:33:00.000Z",
                  "age_days": 22
                },
                {
                  "claim_id": "ALB-20260505-122212-V5N3",
                  "customer_name": "Sam Patel",
                  "vehicle": "2021 Tesla Model 3",
                  "claim_status": "New — Pending Review",
                  "submitted_at": "2026-05-05T12:22:12.000Z",
                  "age_days": 2
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

### Confirmation of per-recipient flow

- **gm/rm filtered to dc_locations** — `userClaims = allOpenClaims.filter((c) =>
  user.dc_locations.includes(c.location_code))` for any role !==
  admin && !== super_admin.
- **admin/super_admin unrestricted** — `userClaims = allOpenClaims`
  (the early-out branch).
- **Hierarchy correctly nests RD → RM → location → claims** — verified by
  reading `buildDigestPayload`'s grouping loop: per-claim lookup
  against `locationsByCode`, sentinel `(unassigned)` for null
  rd_email/rm_email, sort by count desc + name asc within each level,
  claims sorted submitted_at asc.
- **Skip-on-empty works** — `if (userClaims.length === 0) { skippedEmptyCount += 1; continue; }`
  before the payload build / POST.

### Operator follow-up

1. After the next CF Workers Builds deploy lands for damage-worker:
   `pnpm --filter @splash/damage-worker exec wrangler secret put DAILY_SUMMARY_WEBHOOK_URL`
   and paste the PA flow's HTTP-trigger URL.
2. Build the PA flow (HTTP request received → Send email V2). Use
   either Sample A or Sample B above with the "Use sample payload to
   generate schema" button to get a complete dynamic-content tree.
   Email body should branch on `dc_role` so gm/rm digests skip the
   RD/RM headers when there's only one of each.
3. Verify the next 13:00 UTC tick produces emails for currently-active
   gm/rm/admin/super_admin users with open claims. The cron's batch
   summary log line (`[daily-summary] batch complete {recipients,
   sent, skipped_empty, failed_post}`) is the easiest verification —
   scan for it in CF Workers Logs filtered to `eventType: scheduled`
   on the next firing.
4. Flag any per-user opt-out requests for v2. Today's path is
   "remove their dc_role" or "edit `SUMMARY_DC_ROLES` in
   apps/damage-worker/src/index.ts to drop their role" — both coarse.
   v2 candidate: per-user `subscribe_daily_summary` boolean column.
