# Brief 172: Damage — "Awaiting Payment" lifecycle bucket, claims CSV export, and a Cause/fault-attribution field

**Status:** Completed (2026-06-13)
**Drafted:** 2026-06-13
**Blocks:** Neither
**Dependencies:** Brief 59 (reporting endpoint + apps/web reporting page),
Brief 68 (`age_days` projection + `AgePill`), Brief 83/88 (shared
`<CsvExportButton>` / `<DateRangePicker>` + the fleet CSV proxy-route
pattern), Brief 101 (`StatusActionPill` precedent), Brief 138/140
(the D1 "column-missing tolerance" pattern — copy it verbatim).

## Why (operator request)

Three related changes to the damage worker + claim management UI, all
driven by operator feedback on 2026-06-13:

1. **"Open" is too coarse.** Lifecycle is a binary derived from
   `claim_status` (`status.startsWith("Closed") ? "Closed" : "Open"` —
   `packages/db-d1/src/claims.ts:36`). A claim whose check request has
   been submitted still shows **Open** even though the ops team (GM/RM)
   has nothing left to do — it's sitting with finance/AP. Add a third
   **"Awaiting Payment"** bucket so the ops queue (default `lifecycle=Open`)
   stops showing finance-stage claims.

2. **No CSV export on the claims list.** `/admin/damage` has full
   filters (search / location / status / lifecycle / RD / RM / date
   range) but no export. Other workers (fleet, signups, jotform) all
   have `.csv` endpoints — copy that pattern.

3. **No cause/fault attribution.** Operator wants each claim tagged with
   why it happened — **Employee Error**, **Equipment Malfunction**, or
   **Not Employee/Equipment** ("no one did anything wrong, the equipment
   didn't malfunction, the thing just broke — it happens"). Settable by
   any damage role (gm/rm/admin/super_admin), surfaced in the reporting
   dash as KPI pills, and included in the CSV export.

## Decisions already made by the operator (do not re-litigate)

- **Awaiting Payment label** = the literal string `"Awaiting Payment"`.
- **Awaiting Payment membership** = all three post-approval payment
  statuses: `Approved — Check Request Submitted`,
  `Approved — Submitted for Payment`, `Approved — Check Issued`.
  (Everything else stays Open; the three `Closed — *` stay Closed.)
  This was the recommended default; flip to "first two only" is a
  one-line change to the `AWAITING_PAYMENT_STATUSES` array if the
  operator revisits.
- **Cause values** = exactly three: `Employee Error`,
  `Equipment Malfunction`, `Not Employee/Equipment`. NULL =
  unset/"Undetermined" (the default for every existing + new claim).
- **Cause is D1-only for v1** — no Power Automate / SharePoint sync.
  Log the change to the claim activity timeline; that's the audit trail.

## Key architectural decisions (made while drafting — implement as written)

- **Awaiting Payment is DERIVED at read time, NOT a new stored
  `lifecycle_state` value.** The `claims` table has
  `CHECK (lifecycle_state IN ('Open','Closed'))` (backup line 472).
  SQLite can't ALTER a CHECK constraint — adding a third value would
  require rebuilding a production table. Avoid that entirely: keep the
  stored column binary (Open/Closed, written unchanged by
  `lifecycleForStatus`), and derive the 3-way display/filter bucket from
  `claim_status` everywhere it's rendered or filtered. Zero schema change
  for item 1.
- **Cause IS a new column, added via `ALTER TABLE ... ADD COLUMN` with
  an inline CHECK** — that's allowed in SQLite (existing rows are NULL,
  which the `IS NULL OR ...` CHECK permits), so no table rebuild. The
  worker must tolerate the column being absent during the window between
  code deploy and the operator running the ALTER (copy the Brief 138/140
  `/no such column.*fault_category/i` try/catch pattern).

## Read first

- BUILD_STATE.md, CLAUDE.md (the "claim summary PDF", reporting,
  Regional Director/Manager label-vs-data, and constraint #6 notes).
- `packages/types/src/claims.ts` — `LifecycleState`, `ClaimStatus`,
  `ClaimRow`. New `FaultCategory` + `DisplayLifecycleState` types land here.
- `packages/db-d1/src/claims.ts` — `lifecycleForStatus` (line 36, UNCHANGED),
  `ClaimsListFilters` (291), `CLAIMS_LIST_COLS` (314), `listClaims` (334,
  the lifecycle filter at 350-353 is what changes), `writeClaimBatch`
  (the Brief 138/140 column-missing tolerance pattern at ~192).
- `apps/damage-worker/src/index.ts` — `getClaimsList` (588), the
  `/manage/api/...` router (~360-479; add `claims.csv` + the
  `claim/{id}/fault-category` dispatch), `getClaimDetail`, the reporting
  handler `getReporting` (~900) + its totals CASE bucketing (~1114-1213)
  + `ReportingResponse` (848).
- `apps/damage-worker/src/transitions.ts` — DamageRole hierarchy (the
  fault-category gate is `session.dcRole !== null` + claim in scope; it
  is NOT a state-machine transition).
- `apps/web/app/admin/damage/page.tsx` — list page (`LIFECYCLE_OPTIONS`
  at 75, the `lifecycle` default "Open" at 103, the badge render at 491).
- `apps/web/app/admin/damage/_components/LifecycleBadge.tsx`,
  `AgePill.tsx`, `StatusActionPill.tsx`.
- `apps/web/app/admin/damage/[id]/page.tsx` + `[id]/actions.ts` — the
  `<ActionForm>` (Brief 19) server-action pattern to mirror for the
  cause editor.
- `apps/web/app/admin/damage/reporting/page.tsx` — KPI tiles + sections.
- `apps/web/app/_components/CsvExportButton.tsx` + `DateRangePicker.tsx`
  (Brief 83) and `apps/web/app/admin/fleet/export.csv/route.ts`
  (Brief 88 proxy-route pattern to copy for the CSV download).

## Scope

### 1. "Awaiting Payment" derived lifecycle bucket

- `packages/types/src/claims.ts`:
  - Add `export type DisplayLifecycleState = "Open" | "Awaiting Payment" | "Closed";`
  - Add `export const AWAITING_PAYMENT_STATUSES: readonly ClaimStatus[] =
    ["Approved — Check Request Submitted", "Approved — Submitted for Payment",
    "Approved — Check Issued"];` (em-dashes U+2014 — must match the enum).
  - Add `export function displayLifecycleForStatus(status: ClaimStatus):
    DisplayLifecycleState` → `Closed` if `startsWith("Closed")`, else
    `Awaiting Payment` if in `AWAITING_PAYMENT_STATUSES`, else `Open`.
  - Keep `LifecycleState` and (in db-d1) `lifecycleForStatus` UNCHANGED —
    the stored column stays binary.
- `packages/db-d1/src/claims.ts` — widen `ClaimsListFilters.lifecycle`
  to `LifecycleState | "Awaiting Payment" | "All"` and rewrite the filter
  block (350-353):
  - `"Open"` → `lifecycle_state = 'Open' AND claim_status NOT IN (<AWAITING_PAYMENT_STATUSES placeholders>)`
  - `"Awaiting Payment"` → `claim_status IN (<placeholders>)`
  - `"Closed"` → `lifecycle_state = 'Closed'`
  - `"All"` → no clause.
  (No new SELECT column needed — `claim_status` is already projected;
  apps/web derives the badge from it.)
- `apps/damage-worker/src/index.ts` `getClaimsList` (593) — accept
  `"Awaiting Payment"` as a valid `lifecycle` param value and pass it
  through to `ClaimsListFilters.lifecycle`.
- apps/web list page (`page.tsx`):
  - `LIFECYCLE_OPTIONS` → `["Open", "Awaiting Payment", "Closed", "All"]`.
    Default stays `"Open"`.
  - Render the badge from `displayLifecycleForStatus(c.claim_status)`
    rather than `c.lifecycle_state` (line 491).
  - Pass the derived bucket to `<AgePill>` so finance-stage claims don't
    get age-escalation coloring.
- `LifecycleBadge.tsx` — accept `DisplayLifecycleState`; add an amber/
  sudsy style for `"Awaiting Payment"` (distinct from Open's success-green
  and Closed's neutral navy).
- `AgePill.tsx` — accept the 3-way; treat `"Awaiting Payment"` like
  `"Closed"` (static muted pill, no escalation).
- Reporting (`getReporting` + `ReportingResponse` + reporting `page.tsx`):
  - Add `awaiting_payment: number` to `ReportingTotals`. In the totals
    CASE bucketing (~1114-1213) add a branch
    `WHEN claim_status IN (<AWAITING_PAYMENT_STATUSES>) THEN 'awaiting_payment'`
    placed BEFORE the `lifecycle_state = 'Open' THEN 'open'` branch so the
    open count excludes them.
  - Add an "Awaiting Payment" KPI tile to the Overview row.
  - `by_location` per-row "open" count: leave as-is for v1 (still counts
    awaiting-payment claims in its open column). Note as a known
    limitation in the Report section — splitting the per-location table is
    out of scope here.

### 2. CSV export on `/admin/damage`

- New worker endpoint `GET /manage/api/claims.csv` in
  `apps/damage-worker/src/index.ts`:
  - Same query params + dc_role scoping + filter resolution as
    `getClaimsList` (reuse `resolveLocationCodesWithFilters` +
    `ClaimsListFilters`). Accepts the new `lifecycle=Awaiting Payment`.
  - Dedicated SELECT (broader than `CLAIMS_LIST_COLS`) covering the
    export-useful columns: claim_id, location_code, location_pretty,
    customer_name, customer_phone, customer_email, vehicle_year/make/model/
    color, license_plate, damage_type, damage_other, **fault_category**
    (item 3 — `COALESCE(fault_category,'')`, wrapped in the
    column-missing tolerance), claim_status, the DERIVED lifecycle
    (compute in JS via `displayLifecycleForStatus`), submitted_at,
    status_updated_at, age_days.
  - RFC-4180 quoting; `Content-Disposition: attachment;
    filename="damage-claims-YYYY-MM-DD.csv"`. 10,000-row safety cap → 416
    on overflow (match fleet/signups/jotform).
- apps/web download path — copy the Brief 88 fleet proxy pattern:
  `apps/web/app/admin/damage/export.csv/route.ts` Route Handler that
  proxies `GET /manage/api/claims.csv?<filters>` via the `DAMAGE_WORKER`
  service binding and streams the body back with `Content-Type` +
  `Content-Disposition` preserved. (Don't link the browser straight at
  the worker — same reasoning as Brief 88.)
- Add an "Export CSV" `<CsvExportButton>` to the `/admin/damage` filter
  bar, linking to `/admin/damage/export.csv?<current searchParams>` so
  the export honors the active filters.

### 3. Cause / fault-attribution field

- **Operator-run D1 SQL** (document in the Report; the executor does NOT
  run it — no migration framework in this repo):
  `ALTER TABLE claims ADD COLUMN fault_category TEXT
   CHECK (fault_category IS NULL OR fault_category IN
   ('Employee Error','Equipment Malfunction','Not Employee/Equipment'));`
- `packages/types/src/claims.ts` — add
  `export type FaultCategory = "Employee Error" | "Equipment Malfunction" |
   "Not Employee/Equipment";`, an exported `FAULT_CATEGORIES` array, and
  `fault_category: FaultCategory | null` on `ClaimRow`.
- Worker write endpoint `POST /manage/api/claim/{id}/fault-category` in
  `index.ts` (dispatch alongside note/transition/document in the
  `tail.length === 1` block):
  - Gate: `session.dcRole !== null` AND claim in dc_role scope (reuse the
    existing per-claim scope check used by note/transition).
  - Body `fault_category`: one of the three values, or empty string → set
    NULL. Validate against `FAULT_CATEGORIES`; 400 on anything else.
  - `UPDATE claims SET fault_category = ? WHERE claim_id = ?` + INSERT a
    `claim_activity` row with `activity_type = 'note'` (reuse — the
    activity_type CHECK has no room without a rebuild) and a prefixed
    note, e.g. `[cause] {email} set cause to "Employee Error"` /
    `[cause] {email} cleared cause`.
  - Wrap the UPDATE in the Brief 138/140 `/no such column.*fault_category/i`
    tolerance: log + return a soft success/"migration pending" rather than
    a hard 500 if the column isn't there yet.
- Read projections — add `fault_category` to `getClaimDetail`'s SELECT
  (tolerant) so the detail editor can show the current value. (List
  projection doesn't need it; the CSV query selects it directly.)
- apps/web detail editor (`/admin/damage/[id]`):
  - A "Cause" card with a `<select>` (Undetermined + the three values) +
    Save, built with `<ActionForm>` + a server action in `[id]/actions.ts`
    that POSTs to the worker endpoint (mirror the existing note/transition
    actions; `revalidatePath` + `router.refresh()` on success).
  - UI-gate to `dcRole !== null`; worker re-validates.
- Reporting:
  - Worker `getReporting` — add `by_fault_category: Array<{ fault_category:
    string; count: number }>` to `ReportingResponse`, computed as
    `SELECT COALESCE(fault_category,'Undetermined') AS fault_category,
     COUNT(*) n ... GROUP BY 1` over the same window + scope. Tolerant of
    the missing column (→ empty array) so pre-migration reporting works.
  - apps/web reporting `page.tsx` — render `by_fault_category` as a row of
    KPI pills in the Overview section (one pill per category +
    Undetermined, each showing its count). Pill styling: reuse the
    `StatusActionPill` tone vocabulary (e.g. Employee Error = amber,
    Equipment Malfunction = sudsy, Not Employee/Equipment = neutral,
    Undetermined = muted).
- CSV (item 2) already includes `fault_category`.

## Out of scope

- Do NOT add a third value to the `lifecycle_state` CHECK / rebuild the
  `claims` table — Awaiting Payment is derived only.
- Do NOT add a new `claim_activity.activity_type` value — reuse `'note'`.
- Do NOT wire Power Automate / SharePoint sync for the cause field (v1
  is D1-only). Do NOT touch `CLAIM_UPDATE_WEBHOOK_URL` fire sites.
- Do NOT change the per-location reporting table's open-count semantics
  (v1 leaves awaiting-payment claims in the per-location "open" column).
- Do NOT change any customer-facing `/claims/{site}` URL or form.
- Don't deploy to Cloudflare; don't bind production routes; don't run
  the D1 ALTER; don't commit/push.

## Definition of done

- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds; damage-worker + db-d1 +
  types build.
- `/admin/damage` shows a 4th Lifecycle option "Awaiting Payment";
  default Open view excludes the three payment statuses; the badge +
  AgePill reflect the derived bucket.
- `/admin/damage` has a working "Export CSV" button that honors active
  filters and downloads a `fault_category`-bearing CSV.
- `/admin/damage/[id]` has a Cause editor (gm/rm/admin/super_admin) that
  persists and logs to the activity timeline.
- `/admin/damage/reporting` shows an "Awaiting Payment" KPI tile and a
  By-Cause KPI pill row.
- Worker tolerates the `fault_category` column being absent (no 500s
  pre-migration).
- BUILD_STATE.md updated (Last updated date, Findings entry, work-list
  status); the operator-run D1 ALTER SQL recorded in the Report section.

## Report

### Operator-run D1 SQL (required for full feature activation)

Run this once in the `splash-damage-claims` D1 database to land the
`fault_category` column. The worker tolerates the column being absent
during the brief window between code push and this ALTER, so the order
"code deploy → ALTER" is safe; reads collapse to `null`, writes log a
soft-success with `migration_pending: true`.

```sql
ALTER TABLE claims
  ADD COLUMN fault_category TEXT
  CHECK (fault_category IS NULL OR fault_category IN (
    'Employee Error',
    'Equipment Malfunction',
    'Not Employee/Equipment'
  ));
```

No backfill required — every existing claim ends up NULL ("Undetermined"),
which is the intended default per the brief.

### Decisions made on the operator's behalf

1. **Awaiting-Payment tone = amber** (`bg-amber-100 text-amber-900`).
   Distinguishes finance-stage claims from Open's success-green and
   Closed's neutral navy at a glance. Same palette key the AgePill's
   yellow tier uses.
2. **AgePill treats Awaiting Payment like Closed** (static muted pill,
   no escalation). The ops team has no remaining action on
   finance-stage claims, so urgency coloring would be actively
   misleading.
3. **`resolveLifecycleParam` unknown→"Open" fallback** rather than 400
   on unrecognised values. Keeps legacy bookmarks rendering rather than
   breaking them when a URL gains a typo.
4. **Reporting `by_fault_category` query is intentionally OUT OF the
   main D1 batch.** Pre-migration the `no such column` swallow returns
   `[]` cleanly without taking down the rest of the report.
5. **CSV column for the derived value is named just `lifecycle`** (not
   `display_lifecycle`). Stored `lifecycle_state` is omitted entirely
   from the export since the derived value is strictly more informative.
6. **Pre-migration cause writes return 200 with `migration_pending:
   true`** in the response body and a human message rather than 500 —
   mirrors the Brief 138/140 idempotency-key tolerance posture.
7. **Per-location reporting table's "open" column intentionally still
   includes awaiting-payment claims** per the brief's "Out of scope"
   note. The KPI tile carries the carve-out for now; splitting the
   per-location table is a v2 follow-up.
8. **Reuse of `activity_type='note'` for cause changes** (with `[cause]
   ...` prose prefix). Avoids a D1 CHECK rebuild — same audit-log
   annoyance the existing document-delete/edit paths carry per CLAUDE.md.

### Known limitations / forward flags

- Per-location reporting table could grow an `awaiting_payment` column
  without rebuilding the open count; v2 follow-up if operators want
  finer per-location granularity.
- CSV body holds the derived `lifecycle` but NOT the stored
  `lifecycle_state` — a future "find rows where stored != derived"
  audit would need to fetch JSON. No current ask.
- Awaiting-Payment claims pre-Brief-172 already carry
  `lifecycle_state='Open'` (the worker has always written `Open` via
  `lifecycleForStatus`), so no backfill is needed — existing rows
  surface correctly under the new bucketing the moment the code is
  deployed.
- Pre-migration window (code push before ALTER) is fully tolerated on
  every read + write path: list, CSV, detail, reporting query,
  fault-category POST.

## Outcome

### Files modified

- `packages/types/src/claims.ts` — new exports: `DisplayLifecycleState`,
  `AWAITING_PAYMENT_STATUSES`, `displayLifecycleForStatus`,
  `FaultCategory`, `FAULT_CATEGORIES`; new field
  `ClaimRow.fault_category`.
- `packages/db-d1/src/claims.ts` — widened
  `ClaimsListFilters.lifecycle` to `LifecycleState | "Awaiting Payment"
  | "All"`; rewrote the WHERE block for the 3-way bucket; imported
  `AWAITING_PAYMENT_STATUSES`.
- `apps/damage-worker/src/index.ts` — imports widened to include the
  new types/array/helper; `getClaimsList` accepts the new lifecycle
  value via tolerant `resolveLifecycleParam`; new `getClaimsCsv`
  handler with RFC-4180 quoting + 10000-row cap + column-missing
  tolerance; new `handleSetFaultCategory` POST handler; `getClaimDetail`
  normalizes `fault_category` to null pre-migration; reporting
  endpoint extended (`ReportingTotals.awaiting_payment`,
  `ReportingResponse.by_fault_category`, 3-way `lifecycleSql` CASE,
  separate `readByFaultCategory` helper); `claimRowForMx` defensive
  fill includes `fault_category: null`.
- `apps/web/app/admin/damage/page.tsx` — `LIFECYCLE_OPTIONS` widened
  to 4 values; URL parsing accepts the new value; derived badge +
  AgePill via `displayLifecycleForStatus(c.claim_status)`; new
  `<CsvExportButton>` in the filter bar's action row pointing at
  `/admin/damage/export.csv?<filters>`.
- `apps/web/app/admin/damage/[id]/page.tsx` — new `<CauseCard>`
  between summary and transitions (read-only for callers without a
  dcRole); SummaryCard's lifecycle badge derives via
  `displayLifecycleForStatus`.
- `apps/web/app/admin/damage/[id]/actions.ts` — new
  `setFaultCategoryAction` server action calling
  `POST /manage/api/claim/{id}/fault-category` via `damagePostForm`,
  surfaces the migration-pending state in its `ActionResult` message.
- `apps/web/app/admin/damage/_components/LifecycleBadge.tsx` — accepts
  `DisplayLifecycleState`; amber Awaiting-Payment tone added.
- `apps/web/app/admin/damage/_components/AgePill.tsx` — accepts
  `DisplayLifecycleState`; Awaiting Payment treated like Closed (no
  escalation).
- `apps/web/app/admin/damage/reporting/page.tsx` — added
  `awaiting_payment` + `by_fault_category` to `ReportingResponse`
  type; Awaiting Payment KPI tile inserted between Open and Closed
  (grid widened to `lg:grid-cols-6`); By-Cause pill row + new
  `CausePill` component below the tiles.

### Files created

- `apps/web/app/admin/damage/export.csv/route.ts` — Brief 88 proxy-
  route pattern; same-origin browser download proxied via the
  `DAMAGE_WORKER` service binding internally.

### Validation results

- `pnpm typecheck` — 21/21 ✓ (one regression caught and fixed:
  `claimRowForMx` in the customer-submit MaintainX hook was missing
  the new `fault_category` field after `ClaimRow` was widened; fixed
  with a defensive `fault_category: null` fill).
- `pnpm --filter @splash/web build` — ✓ (Next 15.5.15, 22.8s, 42
  routes). `/admin/damage/[id]` 4.22 kB / 111 kB First-Load (up from
  ~1 kB — Cause card + the new helper). `/admin/damage/export.csv`
  141 B (proxy route). `/admin/damage/reporting` 1.6 kB / 109 kB.
- `pnpm --filter @splash/damage-worker exec wrangler deploy --dry-run`
  — ✓; bundle 1881.84 KiB raw / 428.17 KiB gzip (+11.93 KiB raw vs
  Brief 171's 1869.91 KiB baseline; CSV handler + fault-category
  handler + reporting fault-category query).

### Latent issues found during execution

- `claimRowForMx` in `handleClaimSubmission` synthesizes a `ClaimRow`
  for the MaintainX work-order helper. The synthesis is exhaustive
  (every field listed by name), so the post-Brief-172 fix is a single-
  line add (`fault_category: null`) — but the same pattern means any
  future `ClaimRow` widening will need the same one-line add. Two
  more sites (`getClaimDetail`'s `claimWithFault` defensive spread,
  the worker's tolerant CSV SELECT) carry a similar discipline. Worth
  watching when next adding a field to `ClaimRow`.
