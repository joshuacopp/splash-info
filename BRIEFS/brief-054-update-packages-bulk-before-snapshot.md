# Brief 54: `update_packages_bulk` audit log captures `before` snapshot

**Status:** Completed (2026-05-06)
**Started:** 2026-05-06
**Completed:** 2026-05-06
**Blocks:** Operator can see *what changed* on bulk-edit audit-log
rows. Right now Brief 53's expanded diff renders only AFTER for every
`update_packages_bulk` entry — confirmed 2026-05-06 against the
williamsville bulk-edit row.
**Dependencies:** None.

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-026-sysadmin-update-package.md (single-row sibling
  endpoint — captures before+after correctly; this brief makes bulk
  match)
- BRIEFS/brief-036-test-batch-pdf-humanize-mobile-upload-multi-pkg.md
  (Part C — the bulk endpoint this brief patches)
- BRIEFS/brief-053-audit-log-diff-full-width-expansion.md (the panel
  that surfaces the gap)
- apps/sysadmin-worker/src/index.ts (`handleUpdatePackagesBulk`
  ~L1333; the `before: null` write is at L1502)

## Context

`handleUpdatePackagesBulk` writes its audit-log entry with
`before: null`:

```ts
await logSysadminAudit(sb, {
  actor,
  action: "update_packages_bulk",
  target_type: "pricing_simple",
  target_id: locationCode,
  before: null,
  after: {
    location_code: locationCode,
    updates: entries.map((e) => ({ pkg: e.pkg, ...e.patch })),
    updated,
    failed
  }
});
```

The single-row sibling `handleUpdatePackage` (~L1244) does it right —
it fetches the row before patching and stores both snapshots. Bulk
just skipped it. The cost looked higher (N round-trips one-per-row),
but PostgREST `pkg=in.(p1,p2,…)` returns all rows in a single GET, so
the actual cost is ONE extra request regardless of `entries.length`.

Operator confirmed 2026-05-06 (after Brief 53 landed) that the
expanded diff on a recent williamsville `update_packages_bulk` row
shows only the AFTER block. The rendering is correct — there is
literally no `before` data. Fix is worker-side.

## Scope

### Phase 1 — Capture before-snapshot in `handleUpdatePackagesBulk`

1.1 In `apps/sysadmin-worker/src/index.ts`, locate
`handleUpdatePackagesBulk` (~L1333). After the per-entry validation
loop (the one that builds the `entries: BulkUpdateEntry[]` array,
ending around L1439) and BEFORE the per-row PATCH loop (starting
~L1448), insert a single PostgREST GET that fetches the current state
of every row about to be patched.

  - URL pattern:
    ```
    ${env.SUPABASE_URL}/rest/v1/pricing_simple
      ?location_code=eq.${encodeURIComponent(locationCode)}
      &pkg=in.(${entries.map(e => encodeURIComponent(e.pkg)).join(",")})
      &select=pkg,"pkg$",single,sort
    ```
  - Request a focused select list (`pkg`, `pkg$`, `single`, `sort`) —
    only the fields the bulk endpoint can touch. No need for the full
    row; the audit diff only needs the fields that change.
  - Note: `pkg$` requires double-quoting in PostgREST select lists
    (the column name contains `$`). Use the raw string `"pkg$"` (with
    the quotes embedded) inside the select expression, URL-encoded.
    The single-row endpoint already does this kind of select; copy
    its pattern if simpler.
  - Use the same `apikey` + `Authorization: Bearer ...` headers as the
    existing PATCH calls.
  - Wrap the GET in a try/catch. The catch branch must not 500 the
    whole request — bulk update should still proceed even if the
    before-snapshot fetch fails. On failure, set `beforeSnapshots`
    to `null` and let Phase 1.3 fall back to the legacy `before:
    null` shape. This preserves the prior behavior as a safety
    net.

1.2 Type the result. Sketch:

```ts
interface BulkBeforeRow {
  pkg: string;
  "pkg$": number | null;
  single: number | null;
  sort: number | null;
}

let beforeSnapshots: BulkBeforeRow[] | null = null;
try {
  const beforeUrl =
    `${env.SUPABASE_URL}/rest/v1/pricing_simple` +
    `?location_code=eq.${encodeURIComponent(locationCode)}` +
    `&pkg=in.(${entries.map((e) => encodeURIComponent(e.pkg)).join(",")})` +
    `&select=pkg,%22pkg%24%22,single,sort`;
  const beforeResp = await fetch(beforeUrl, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (beforeResp.ok) {
    const rows = (await beforeResp.json()) as BulkBeforeRow[];
    if (Array.isArray(rows)) beforeSnapshots = rows;
  }
} catch {
  // Fail-soft: leave beforeSnapshots as null. The audit-log entry
  // will record before:null in this rare path; the bulk update
  // itself proceeds normally.
}
```

`encodeURIComponent("pkg$")` → `pkg%24`; the surrounding double quotes
need URL-encoding too (`%22pkg%24%22`).

1.3 Update the audit-log call (~L1497) to use the snapshot:

```ts
await logSysadminAudit(sb, {
  actor,
  action: "update_packages_bulk",
  target_type: "pricing_simple",
  target_id: locationCode,
  before:
    beforeSnapshots !== null
      ? {
          location_code: locationCode,
          rows: beforeSnapshots
        }
      : null,
  after: {
    location_code: locationCode,
    updates: entries.map((e) => ({ pkg: e.pkg, ...e.patch })),
    updated,
    failed
  }
});
```

The `before` shape mirrors the `after` shape's `location_code` +
list-of-rows pattern, but uses `rows` (current full state of the
fields the operator can edit) rather than `updates` (the patches
about to apply). Side-by-side rendering will show:

- BEFORE: `{ location_code, rows: [{ pkg, "pkg$", single, sort }, …] }`
- AFTER:  `{ location_code, updates: [{ pkg, …patch }, …], updated, failed }`

The keys differ intentionally — the BEFORE side captures the row
state pre-edit; the AFTER side captures the patch intent + outcome
counts. Together they answer "what did that bulk edit change?" and
"did any rows fail?" in the same expanded diff.

1.4 Update the docblock above `handleUpdatePackagesBulk`
(~L1268-L1303) to reflect the new behavior. The current comment
says:

```
Audit log: ONE entry per bulk request (action = "update_packages_bulk")
with target_id = location_code and after = { updates: [...] }.
Per-row entries would spam the log; the bulk entry preserves
provenance.
```

Replace with:

```
Audit log: ONE entry per bulk request (action = "update_packages_bulk")
with target_id = location_code. before = { location_code, rows: [...] }
captures the pre-edit state of the fields the bulk endpoint can touch
(pkg, pkg$, single, sort) via a single pkg=in.(...) GET issued before
the patch loop. after = { location_code, updates: [...], updated,
failed } captures the patch intent + per-row outcome counts. The
before-snapshot fetch is fail-soft (catch + before:null fallback) so
audit-log degradation never blocks the bulk update itself. Per-row
audit entries would spam the log; the bulk entry preserves provenance
without flooding.
```

### Phase 2 — Validation

2.1 `pnpm typecheck` — must pass for all 13 packages.
2.2 `pnpm --filter @splash/sysadmin-worker exec wrangler deploy
   --dry-run --outdir=.tmp-build` — bundle must succeed (worker
   has no `build` script; Brief 52 documented this substitute).
   Clean up `.tmp-build` afterward.
2.3 No new endpoints. No schema changes. No new env vars. The
   audit-log column shape is unchanged — `before` was already
   `jsonb` (or equivalent) and accepting `null`; this brief just
   makes it actually populated.

### Phase 3 — Updates

3.1 BRIEFS/INDEX.md: Brief 54 row added (matching the table
schema used by Briefs 51-53).

3.2 BUILD_STATE.md: Findings entry noting:
  - `update_packages_bulk` audit log was writing `before: null`,
    leaving Brief 53's expanded diff with only an AFTER column for
    bulk edits
  - Brief 54 adds a single `pkg=in.(...)` GET before the patch
    loop and uses the result as the `before` payload
  - `before` payload shape: `{ location_code, rows: [{pkg,"pkg$",
    single,sort}, …] }` — only the fields the bulk endpoint can
    touch, so the diff is focused on what changed
  - Fail-soft: if the before-fetch errors, audit-log entry falls
    back to `before: null` (legacy shape), bulk update still
    proceeds normally
  - Operator follow-up: re-run a small bulk edit (any underscored
    location_code from Brief 52's fix) and confirm Brief 53's
    expanded diff now shows BEFORE and AFTER side-by-side on
    desktop viewports

3.3 No CLAUDE.md change needed — the audit-log shape is documented
inline in `handleUpdatePackagesBulk`'s docblock (Phase 1.4 updates
it).

## Out of scope

- Capturing per-row before-snapshots inside the patch loop (i.e., one
  per entry, after each PATCH is acked). The pre-loop GET pattern is
  simpler, atomic-ish (operator's intent is bulk), and consistent
  with how Brief 26's single-row handler captures its snapshot
  before the PATCH.
- Diffing the rows server-side and only writing changed fields. The
  rendering layer (Brief 53's `DiffBlock`) handles that visually;
  storing the full snapshot is more useful for debugging.
- Backfilling `before` data for historical `update_packages_bulk`
  rows. Not possible — the data is gone. The audit log will show a
  before/after split only for entries written after Brief 54 ships.
- Touching the other handlers that legitimately write `before: null`:
  `create_user`, `create_location`, `grant_tool` (when `was_new`),
  `reset_password`. Inserts have no meaningful before state; bulk is
  the only mutation that does.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `handleUpdatePackagesBulk` issues a single
  `pkg=in.(...)` GET against `pricing_simple` before the patch loop
- The fetched rows are passed as the `before` payload on the
  `logSysadminAudit` call (mirroring the `location_code` + rows
  shape)
- The fetch is wrapped in try/catch; on failure the audit entry
  falls back to `before: null` and the bulk update still proceeds
- Docblock above the handler updated to describe the new audit
  shape
- `pnpm typecheck` passes (all 13 packages)
- `pnpm --filter @splash/sysadmin-worker exec wrangler deploy
  --dry-run --outdir=.tmp-build` bundle succeeds (clean up after)
- BUILD_STATE.md, BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (likely 30-45 lines net: new fetch block + audit-call
  reshape + docblock update)
- Confirmation that `pkg=in.(...)` URL-encodes the `$` correctly
  (the test is "the GET returns 200 and the rows have a `pkg$`
  field present, not undefined")
- Validation results
- Any decisions made on the operator's behalf

## Outcome

**Files modified:** 1 source file — `apps/sysadmin-worker/src/index.ts`. Plus
standard tracking updates to `BRIEFS/INDEX.md` (Brief 54 row appended),
`BRIEFS/QUEUE.md` (entry commented out as completed), `BUILD_STATE.md`
("Last updated" line + new Findings entry at the top of the table),
and this brief file (Status + Outcome).

**Files created:** none.

**Files deleted:** none.

**Source-file changes (`apps/sysadmin-worker/src/index.ts`):**

1. Docblock above `handleUpdatePackagesBulk` (~L1298-L1308) rewritten to
   describe the new audit shape — `before = { location_code, rows: [...] }`
   captured via single `pkg=in.(...)` GET issued before the patch loop;
   fail-soft `before:null` fallback documented.

2. New `BulkBeforeRow` interface declared at module scope (~L1339-L1344)
   alongside the existing `BulkUpdateEntry` and `BulkRowResult` interfaces:

   ```ts
   interface BulkBeforeRow {
     pkg: string;
     "pkg$": number | null;
     single: number | null;
     sort: number | null;
   }
   ```

3. New before-snapshot fetch block inserted (~L1454-L1480) between the
   per-entry validation loop (which builds the `entries[]` array) and
   the per-row PATCH loop. Issues a single GET against
   `${env.SUPABASE_URL}/rest/v1/pricing_simple?location_code=eq.<code>&pkg=in.(<pkg1>,<pkg2>,…)&select=pkg,%22pkg%24%22,single,sort`
   with the same `apikey` + `Authorization: Bearer <SUPABASE_SERVICE_KEY>`
   headers as the existing PATCH calls. Result is JSON-parsed, narrowed
   via `Array.isArray`, and assigned to `beforeSnapshots: BulkBeforeRow[] | null`.
   Wrapped in try/catch; on fetch throw or non-2xx response,
   `beforeSnapshots` stays null and the audit-log entry below falls back
   to the legacy `before:null` shape.

4. Audit-log call (~L1538-L1556) `before:` field rewritten from a
   hardcoded `null` to a conditional that emits
   `{ location_code, rows: beforeSnapshots }` when the snapshot fetch
   succeeded, or `null` when it failed. The `after:` payload is
   unchanged (still `{ location_code, updates, updated, failed }`).

**Decisions made on operator's behalf:**

1. **`BulkBeforeRow` declared at module scope** alongside the two
   existing bulk-endpoint interfaces, rather than inline in the handler.
   Keeps the three shape types colocated and grep-able; matches the
   existing pattern.

2. **`(await beforeResp.json()) as unknown` then `Array.isArray(rows)`
   narrowing** rather than a direct `as BulkBeforeRow[]` cast. Defends
   against Supabase returning a non-array shape under unexpected
   conditions (e.g., a PostgREST error object).

3. **Empty `rows: []` (Supabase responded successfully but matched
   nothing) is preserved as a non-null snapshot.** The audit log records
   `before: { location_code, rows: [] }` rather than `before: null` in
   that case. The empty array is informationally distinct from "fetch
   failed" and helps the operator distinguish "no rows existed" from
   "we couldn't read them".

4. **`encodeURIComponent` applied to each `pkg`** in the `in.()` list,
   matching the per-row PATCH URL's existing posture. Defends against
   legacy pkg names with spaces/special chars.

5. **No conditional ordering changes** — the per-entry validation loop
   still runs first, then the snapshot fetch, then the PATCH loop. A
   bad-validation request short-circuits before the GET, so we don't
   issue a Supabase round-trip for rejected requests.

6. **No new endpoint, no schema change, no new env var.** The audit-log
   column shape is unchanged — `before` was already `jsonb` accepting
   null; this brief just makes it actually populated for bulk.

**Latent issues / forward flags:**

(a) **Two-step audit cost** — bulk request now N+1 Supabase calls
instead of N. For the 20-row cap that's +5% wall-time; for the common
4-7 row request it's +14-25%. The pre-loop GET is sequential with the
loop start, so total wall-time is the GET's latency plus the existing
patch-loop latency. Acceptable for the audit-log fidelity win.

(b) **Race window** between the snapshot GET and the per-row PATCH —
another sysadmin operator PATCHing the same `(location_code, pkg)` via
the single-row endpoint would mean the audit log's `before` reflects a
state that didn't exist at PATCH time. Multi-operator concurrent edits
on the same location are rare (usually one operator per location), but
flagged for awareness.

(c) **`before` payload size** ~80-200 bytes for 20 rows × 4 fields;
well within `jsonb` row limits. No compaction/truncation needed.

(d) **`pkg$` URL-encoding correctness** — the literal
`&select=pkg,%22pkg%24%22,single,sort` decodes to
`&select=pkg,"pkg$",single,sort`, which is the PostgREST
double-quoted column-name syntax. Operator's empirical smoke test
("rows have a `pkg$` field present, not undefined") is the
confirmation; cannot be reached from headless.

(e) **No headless smoke test** — operator must redeploy and re-run a
small bulk edit, then navigate to `/admin/sysadmin?mode=tables`, find
the new `update_packages_bulk` row, and click View to confirm the
BEFORE/AFTER side-by-side render now has data on both sides.

**Validation results:**

- `pnpm typecheck` — 13/13 successful (1.714s, 12 cache hits + fresh
  `@splash/sysadmin-worker` rebuild — the one package modified).
- `pnpm --filter @splash/sysadmin-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build` — bundle succeeded. Total Upload **755.79 KiB /
  gzip 142.42 KiB** (Brief 52 baseline 755.11 / 142.30 → **+0.68 KiB
  / +0.12 KiB gzip**, expected delta from the new fetch block +
  interface + audit-call reshape + docblock). `.tmp-build` directory
  removed afterward.

**Diff size:** ~38 lines net added to `apps/sysadmin-worker/src/index.ts`
— new docblock content (8 net lines), `BulkBeforeRow` interface (6
lines including blank line), before-snapshot fetch block (24 lines
including comment + try/catch), audit-call reshape (~6 lines net,
mostly the conditional branching).

**Operator follow-up (smoke test on next CF Workers Builds redeploy):**

1. After splash-sysadmin redeploys on push to `main`, navigate to
   `/admin/sysadmin?mode=tables` → Update Package card → pick any
   underscored location_code (`batavia_ii`, `batavia_veterans`, etc.)
   → multi-select 2-3 packages → bulk-edit `pkg$` (or any other
   editable field) by a small amount → submit.
2. Navigate to the Activity log panel (still on the same page); the
   new `update_packages_bulk` row should appear at the top.
3. Click the View toggle on that row.
4. Confirm the expanded diff renders with BEFORE on the left and
   AFTER on the right (or stacked on mobile). BEFORE should show
   `{ location_code, rows: [{pkg, "pkg$", single, sort}, …] }` for
   the rows that were patched.
5. If BEFORE still shows null/empty, capture the row's raw `before`
   JSON from Supabase (`SELECT before FROM sysadmin_audit_log WHERE
   action = 'update_packages_bulk' ORDER BY occurred_at DESC LIMIT 1;`)
   to determine whether the worker wrote it or not — null in the
   column means the fetch fail-soft branch fired (network glitch
   or PostgREST error), populated means the apps/web rendering layer
   has a bug.
