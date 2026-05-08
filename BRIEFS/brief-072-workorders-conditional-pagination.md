# Brief 72: Work Orders — conditional pagination for multi-location users (Reactive WOs being drowned by Preventive at the 200-cap)

**Status:** Completed (2026-05-07)
**Started:** 2026-05-07
**Completed:** 2026-05-07
**Blocks:** Operator visibility into Reactive work orders for users
covering multiple locations. Today (post-Brief 71) `/workorders`
fetches a single page of 200 WOs from MaintainX sorted by
`-updatedAt`, then buckets into Reactive vs Preventive tabs. With
the operator's current queue mix (~145 Preventive + 45 Reactive in
the first 200 fetched), older Reactive WOs fall off the end of the
single-page response and never reach the page — operators see only
the most-recently-updated 45 Reactive WOs even though more exist
upstream.
**Dependencies:**
- Brief 71 (the email-on-locations gating, Reactive/Preventive tab
  split, and `fetchMaintainXWorkOrders` helper this brief extends).
- Brief 70 (the underlying worker scaffold + `truncated` response
  field this brief actually populates correctly for the first time).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-071-workorders-v2-gating-grouping-assignees-types.md
  (the Reactive/Preventive split + email-on-locations gating this
  brief layers on top of)
- BRIEFS/brief-070-workorders-worker-and-page.md (the original
  `truncated: boolean` response field this brief now actually
  populates correctly)
- apps/workorders-worker/src/maintainx.ts (the upstream client this
  brief converts from single-call to cursor-pagination)
- apps/workorders-worker/src/index.ts (the handler that decides
  pagination vs single-call based on the user's location count)
- apps/web/app/workorders/_lib/worker-fetch.ts (the response shape
  type — adds `pageCount` field)
- apps/web/app/workorders/page.tsx (or whichever page file
  surfaces `truncated` — adds the banner copy)
- apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx
  (the client island Brief 71 introduced; truncation banner sits
  above the tab nav)

## Context

MaintainX's `GET /v1/workorders` endpoint has two relevant
constraints:

1. `limit=200` per call (their max). Brief 70 / 71 both use this.
2. No `type=REACTIVE` filter parameter. The worker over-fetches
   and buckets post-response by `wo.type === "PREVENTIVE"`.
3. No `notAssignees` filter, so we can't exclude Preventive's
   sole creator (Avery Frank, id 395844) at the API layer either.

These three together mean: for a multi-location user, when the
aggregate open-WO count across their locations exceeds 200, the
single-call response is sorted by `-updatedAt` and oldest WOs fall
off the end. Brief 71's response includes a `truncated` flag —
operator confirmed 2026-05-07 that today's data is hitting it
(145 Preventive + 45 Reactive = 190 in the first 200, leaving an
unknown number of older WOs invisible to the page). The page
renders a "truncated" banner today but doesn't actually capture the
missing rows.

**Pagination as the fix:** MaintainX's response includes
`nextCursor` (string or null). Iterating `cursor=<nextCursor>` on
each follow-up call walks the full open queue. With Splash's scale
(~67 sites), even a worst-case 1500 open WOs paginates in 8 pages
or fewer.

**Conditional pagination** (operator decision 2026-05-07): a user
with exactly one accessible location cannot realistically have
more than 200 open WOs at that single site. Skipping pagination for
single-location users avoids the extra API calls + latency for the
common case (most operators are gm/site-level — they cover one
location). Multi-location users (regional managers, area managers,
admins linked to multiple locations via am_email/rm_email) get the
pagination loop with a cap.

**Cap rationale:** 1000 WOs (= 5 pages × 200). Generous headroom
over current ~190, well below any plausible runaway. Past the cap
the page surfaces the existing `truncated: true` banner — operator
knows they're not seeing everything and follows the link to
MaintainX for the full list. The cap is a flat constant; not
scaled by location count, because operators with 50+ locations
(future national admin role) genuinely don't need more than 1000
items in a single browser-tab view.

## Scope

### Phase 1 — Pagination loop in workorders-worker

1.1 Modify `apps/workorders-worker/src/maintainx.ts`:

  - Extend the existing input shape (Brief 71's
    `FetchInput` / `FetchResult` per Brief 70's Phase 4):

    ```ts
    interface FetchInput {
      apiKey: string;
      baseUrl: string;
      maintainxLocationIds?: number[];
      signal?: AbortSignal;
      // Brief 72 additions:
      paginate: boolean;          // false → single call (today's behavior)
      maxWorkOrders: number;      // cap when paginate=true. Helper stops
                                   // when accumulated WOs ≥ this value
                                   // OR nextCursor === null.
    }

    interface FetchResult {
      ok: boolean;
      workOrders: RawWorkOrder[];
      truncated: boolean;
      // Brief 72 addition:
      pageCount: number;          // number of MaintainX API calls made.
                                   // 1 for the single-call path. Useful
                                   // for log + debug surfaces.
      error: string | null;
      status: number;
    }
    ```

  - When `paginate === false`: existing single-call behavior.
    `pageCount = 1`, `truncated = body.nextCursor != null`.

  - When `paginate === true`: loop. On each iteration:
    1. Build URL with `?cursor=<lastCursor>` appended (other
       params unchanged: statuses, expand, locations, sort,
       limit=200).
    2. First iteration omits `cursor=` to get the first page.
    3. Fetch with the same `signal` (respects the caller's
       aggregate timeout).
    4. Append `body.workOrders` to the accumulator.
    5. Increment `pageCount`.
    6. If `accumulator.length >= maxWorkOrders`, set
       `truncated = true` and break — slice the accumulator to
       exactly `maxWorkOrders` before returning.
    7. If `body.nextCursor == null`, set `truncated = false` and
       break — we've reached the end of the queue cleanly.
    8. Otherwise, set `lastCursor = body.nextCursor` and continue.

  - Defense-in-depth: hard ceiling of 10 iterations regardless of
    `maxWorkOrders` so a buggy MaintainX response (cursor that
    keeps returning) can't hang the worker. Iteration 10 force-
    breaks with `truncated = true` and the helper logs a warning
    so we'd see it in Workers Logs.

  - Per-page timeout still 8s via the caller's `AbortSignal`. The
    aggregate timeout for paginated calls is governed by the
    caller passing a long-enough signal — see Phase 2.3.

  - Network/non-2xx on any page → return what we have so far with
    `ok: false`, `error: <details>`, `pageCount: <pages-done>`.
    Partial result acceptable per the existing fail-soft posture.

1.2 Update `RawWorkOrder` type if needed (no change expected —
shape is per-WO and already complete from Brief 71).

### Phase 2 — Handler decision logic

2.1 In `apps/workorders-worker/src/index.ts`'s `getWorkOrdersList`
handler (the one Brief 71 rewrote), after computing
`mappedMxIds.length`:

```ts
const shouldPaginate = mappedMxIds.length > 1;
const result = await fetchMaintainXWorkOrders({
  apiKey: env.MAINTAINX_API_KEY,
  baseUrl: env.MAINTAINX_BASE_URL,
  maintainxLocationIds: mappedMxIds,
  paginate: shouldPaginate,
  maxWorkOrders: shouldPaginate ? 1000 : 200,
  signal: AbortSignal.timeout(shouldPaginate ? 30000 : 8000)
});
```

  - Single-location user (`mappedMxIds.length === 1`): no
    pagination, 200 cap, 8s timeout. Identical to Brief 71's
    behavior.
  - Multi-location user (`mappedMxIds.length > 1`): paginated,
    1000 cap, 30s aggregate timeout (5 pages × ~5s worst case
    leaves headroom).
  - Edge case `mappedMxIds.length === 0`: existing early-return
    branch from Brief 71 stays — no MX call, empty buckets, no
    pagination decision needed.

2.2 The `MAX_WORK_ORDERS_MULTI` and `MAX_WORK_ORDERS_SINGLE`
constants should live as module-local consts at the top of
`index.ts` so future tuning is one-edit-one-place. Comment them:

```ts
// Brief 72: pagination limits.
//   - Single-location users: skip pagination; MaintainX's 200-per-call
//     cap is enough headroom for any one site's open queue.
//   - Multi-location users: paginate up to MAX_WORK_ORDERS_MULTI total.
//     Past the cap, the page renders a truncation banner.
const MAX_WORK_ORDERS_SINGLE = 200;
const MAX_WORK_ORDERS_MULTI = 1000;
const TIMEOUT_SINGLE_MS = 8_000;
const TIMEOUT_MULTI_MS = 30_000;
```

2.3 The aggregate timeout (30s for multi-location) is well under
Cloudflare Workers' default 30s CPU/wall-time limit for scheduled
events but well within the limits for fetch handlers. If 30s ever
turns out to be too short for a real user with many locations and
heavy WO volume, the cap of 5 pages itself bounds total calls; the
pagination is breadth-first cursor walking, not concurrent.

2.4 Response shape additions (the worker's `getWorkOrdersList`
JSON):

  - `pageCount: number` — propagated from `fetchMaintainXWorkOrders`'s
    result. 1 for single-call path. Useful in the page footer for
    debug visibility ("Fetched 4 pages from MaintainX, 837 work
    orders").
  - `truncated: boolean` — already in the shape (Brief 70 / 71);
    now it actually means something for multi-location users.

### Phase 3 — apps/web response type + truncation banner

3.1 In `apps/web/app/workorders/_lib/worker-fetch.ts`, extend the
`WorkOrdersListResponse` type to include `pageCount: number`.

3.2 In `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`:

  - Brief 71 already declared a truncation banner pathway
    (Phase 7.3 mentioned showing one when `truncated === true`).
    Confirm it exists; if not, add it now. Copy:

    ```
    "Showing first 1000 work orders. Older items aren't visible
     here — log into MaintainX directly for the full list."
    ```

  - Position: above the tab nav, full-width, soft amber
    background (`bg-amber-50 text-amber-900 border border-amber-200
    rounded-md px-4 py-2 text-sm`). Matches the visual posture of
    the missing-maintainx_id warning Brief 71 added.

  - Optionally surface `pageCount` in muted small text in the
    page footer (next to the existing "As of {fetchedAt}"
    timestamp): `Fetched {pageCount} page{s} from MaintainX`.
    Useful for ops debugging; not load-bearing UX. Executor
    decides — if it adds noise, skip it.

### Phase 4 — Validation

4.1 `pnpm typecheck` — must pass for all 14 packages.

4.2 `pnpm --filter @splash/web build` — must succeed.

4.3 `pnpm --filter @splash/workorders-worker exec wrangler deploy
--dry-run` — must succeed; no new bindings, no new env vars, no
new secrets.

4.4 No D1 schema change. No Supabase schema change.

4.5 Post-deploy smoke test (operator):
  - (a) Log in as a multi-location user — confirm Reactive tab
    count is materially higher than the pre-Brief-72 ~45.
  - (b) `pnpm --filter @splash/workorders-worker exec wrangler
    tail` — watch for the per-call log line during a page load;
    confirm `pageCount` matches `truncated` semantics (3 pages +
    truncated=false → ~600 WOs total; 5 pages + truncated=true →
    ≥1000).
  - (c) Log in as a single-location user (operator picks one) —
    confirm only ONE MaintainX call fires (`pageCount === 1`,
    `truncated === false` unless that single site really has 200+
    open WOs which is implausible).
  - (d) Reload `/workorders` — page-load wall-time should still
    be under 5s for the multi-location case (4 pages × ~500-800ms
    each plus Supabase joins is typically 3-4s).

### Phase 5 — Documentation updates

5.1 CLAUDE.md — under the "Work Orders" glossary entry (added in
Brief 70, refined in Brief 71), append:

```
- Pagination (Brief 72): single-location users get one MaintainX
  call (200-cap); multi-location users paginate cursor-by-cursor
  up to 1000 total WOs (5 pages × 200). Hard ceiling of 10 page
  iterations as defense-in-depth. Page renders a truncation
  banner when the 1000 cap is hit.
```

5.2 BUILD_STATE.md:
  - Bump "Last updated".
  - New row in "Open work — prioritized" for Brief 72.
  - Findings entry covering: the diagnosis (Preventives drowning
    Reactives at the 200-cap), the conditional-pagination decision,
    the 1000 cap rationale.

5.3 BRIEFS/INDEX.md — append Brief 72 row.

5.4 BRIEFS/QUEUE.md — append Brief 72 filename so the orchestrator
picks it up.

## Out of scope

- Pre-fetching / caching. Page hits MaintainX live every load.
  Acceptable cost; revisit if operators complain about page-load
  wall-time.
- A page-level "Load more" button to fetch beyond the 1000 cap.
  Operators follow the link to MaintainX for the long tail; the
  page is for triage at a glance, not exhaustive scanning.
- Restructuring how Preventive vs Reactive bucketing works.
  Brief 71 nailed it (post-fetch `wo.type` check). This brief
  just feeds it more upstream data so all the Reactives appear.
- Adding a `notAssignees` workaround (e.g., explicit positive
  assignee filter listing every non-Avery user). Brief 71's
  approach + this brief's pagination is cleaner.
- Changes to the MaintainX user/team daily sync cron from
  Brief 71. Independent surface.
- Don't deploy from headless. Push triggers CF Workers Builds
  auto-deploy on splash-workorders.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/workorders-worker/src/maintainx.ts` — `fetchMaintainXWorkOrders`
  accepts `paginate` + `maxWorkOrders`; iterates cursor when
  paginate=true; hard ceiling of 10 iterations as defense-in-depth;
  returns `pageCount` and accurate `truncated`
- `apps/workorders-worker/src/index.ts` — handler computes
  `shouldPaginate = mappedMxIds.length > 1` and passes the
  appropriate cap + timeout
- Module-local constants `MAX_WORK_ORDERS_SINGLE = 200`,
  `MAX_WORK_ORDERS_MULTI = 1000`, `TIMEOUT_SINGLE_MS = 8000`,
  `TIMEOUT_MULTI_MS = 30000` exist with the inline comment
  documenting their rationale
- Response shape gains `pageCount: number` field; `truncated`
  remains accurate
- `apps/web/app/workorders/_lib/worker-fetch.ts` type updated
- `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx`
  renders the truncation banner above the tab nav when
  `truncated === true`
- `pnpm typecheck` passes for all 14 packages
- `pnpm --filter @splash/web build` succeeds
- `pnpm --filter @splash/workorders-worker exec wrangler deploy
  --dry-run` succeeds
- BRIEFS/INDEX.md, BRIEFS/QUEUE.md, BUILD_STATE.md, CLAUDE.md
  updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Files modified (~4-5: maintainx.ts, index.ts (worker),
  worker-fetch.ts, WorkOrdersTabsClient.tsx, plus CLAUDE.md +
  BUILD_STATE.md)
- Bundle delta on workorders-worker (uncompressed + gzip)
- Bundle delta on apps/web `/workorders` route
- Validation results
- Decisions made on the operator's behalf
- Empirical observations: any test fetches the executor ran
  against the live MaintainX API to verify the cursor pattern
  works as documented (especially the `nextCursor` field name
  and value semantics — the Brief 70 sample showed it but the
  helper is now load-bearing on it)
- Latent issues / forward flags — e.g., if the executor finds
  that pagination via cursor returns duplicate WOs across
  pages (shouldn't happen but flag if observed), or if the
  10-iteration ceiling is hit during testing

## Outcome

**Files modified:**

- `apps/workorders-worker/src/maintainx.ts` — refactored to a
  `fetchOnePage` inner helper plus a top-level
  `fetchMaintainXWorkOrders` that branches on `paginate`. New
  `MAX_PAGE_ITERATIONS = 10` defense-in-depth ceiling with
  `console.warn` on hit. `nextCursor` extraction tightened to require
  a non-empty string before being treated as a cursor (was: any
  truthy non-null value); MaintainX's documented field is a string,
  so this is conservative correctness, not a behavior change.
  `FetchInput` gains `paginate: boolean` + `maxWorkOrders: number`;
  `FetchResult` gains `pageCount: number`. Per-page fetch errors /
  non-2xx / non-JSON return what we have so far with `ok: false`,
  `error`, `pageCount: <pages-done>`.
- `apps/workorders-worker/src/index.ts` — replaced the single
  `MAINTAINX_TIMEOUT_MS` const with the four Brief-72 module-locals
  (`MAX_WORK_ORDERS_SINGLE = 200`, `MAX_WORK_ORDERS_MULTI = 1000`,
  `TIMEOUT_SINGLE_MS = 8_000`, `TIMEOUT_MULTI_MS = 30_000`) with the
  inline rationale comment from the brief. `handleList` computes
  `shouldPaginate = mappedMxIds.length > 1` and passes the
  corresponding cap + timeout. One-line `console.log` of email /
  mappedMxIds / paginate / pageCount / workOrders / truncated added
  for ops visibility (covered by Brief 63's `[observability.logs]`
  block). `ListResponse` shape gains `pageCount: number` and the
  early-return path for `mappedMxIds.length === 0` returns
  `pageCount: 0`.
- `apps/web/app/workorders/_lib/worker-fetch.ts` —
  `WorkOrdersListResponse` type extended with `pageCount: number`.
- `apps/web/app/workorders/_components/WorkOrdersTabsClient.tsx` —
  `TruncatedNotice` copy reworded verbatim per the brief: "Showing
  first 1000 work orders. Older items aren't visible here — log into
  MaintainX directly for the full list." with the soft amber styling
  per the brief (`bg-amber-50 text-amber-900 border border-amber-200
  rounded-md px-4 py-2 text-sm`), replacing the former Brief 71
  sudsy-blue treatment that read "Showing the first 200 work
  orders.…".
- `CLAUDE.md` — appended the Brief 72 pagination paragraph under
  the existing Work Orders glossary entry.
- `BUILD_STATE.md` — bumped "Last updated" to call out Brief 72; new
  row in the Open work table (Brief 72 with full description); new
  Findings entry on 2026-05-07 with diagnosis, files modified,
  decisions, latent issues, and validation.
- `BRIEFS/INDEX.md` — appended Brief 72 row.
- `BRIEFS/QUEUE.md` — Brief 72 line commented out as completed.

**Decisions made on the operator's behalf:**

1. Followed the brief's exact banner copy verbatim including the
   "1000" figure even though single-location truncation (implausible
   — would require >200 open WOs at one site) would still surface
   that copy. The alternative of parameterizing the figure on
   `pageCount`/cap added code without operator-visible benefit.
2. Skipped the optional Phase 3.2 footer surface ("Fetched
   {pageCount} pages from MaintainX"). The value is on the response
   shape and Workers Logs has the same data; surfacing it under the
   "As of …" timestamp would be operator noise on the dominant
   single-call path. The brief explicitly left this to executor
   judgment.
3. Page handler still passes only `truncated` (not `pageCount`) into
   `WorkOrdersTabsClient` props — the type was extended on the
   response shape per the brief (Phase 3.1) but no UI consumes it.
   Future visibility addition is one line in `Body` plus one prop on
   `WorkOrdersTabsClient`.
4. Tightened `nextCursor` extraction in `extractWorkOrders` to
   require a non-empty string. Previously any truthy non-null value
   was treated as a cursor — fine for the v1 single-call path
   (Brief 71's "is there more?" check) but load-bearing for v2's
   pagination loop, where a non-string cursor would cause the URL
   builder to coerce-and-pass garbage. Conservative correctness.

**Latent issues / forward flags:**

1. The `truncated=true` case where pagination ran but didn't reach
   1000 (i.e., `MAX_PAGE_ITERATIONS=10` was hit while cursor remained
   non-null) is technically possible if MaintainX returns a buggy
   cursor that loops or the queue exceeds 2000 WOs. The helper
   `console.warn`s and force-breaks but the page can't distinguish
   "hit the 1000 cap" from "hit the 10-iteration ceiling" — both
   render the same banner. Acceptable per the brief's
   defense-in-depth posture; the warn surfaces in Workers Logs for
   forward debugging.
2. **No live MaintainX API calls were made from headless** to
   validate the cursor contract. The brief's Report section asks for
   empirical observation but Phase 4.5's smoke test is the
   operator-side validation gate. The cursor field name
   (`nextCursor`) and its null/string semantics are taken from the
   Brief 70 sample plus the existing `extractWorkOrders` envelope-
   shape detection. If MaintainX's actual response uses a different
   field name (e.g., `next_cursor` or `nextPageCursor`), the helper
   will treat the response as cursor=null and stop after page 1 —
   the same behavior as today, with `truncated: false`. Forward flag
   for the operator: during the Phase 4.5 smoke test, watch the
   `wrangler tail` log for `pageCount` matching `truncated` semantics
   (3 pages + truncated=false → ~600 WOs total; 5 pages +
   truncated=true → ≥1000). If `pageCount === 1` AND truncated=false
   on a known-multi-location user, the cursor field name has
   changed.
3. The `console.log` line adds one log entry per `/workorders` page
   load. At expected scale (a handful of operators, a handful of
   loads/day) this is fine, but if `/workorders` ever gains a
   polling client this should drop to `console.debug` or sample.
4. Per-page timeout is governed by the caller's `AbortSignal` (a
   single timer covering the whole pagination loop). For the
   30s multi-location case this is breadth-first cursor walking,
   not concurrent — each MaintainX call must complete before the
   next starts. The 30s budget allows ~6s/page for 5 pages, which
   leaves headroom but is tighter than the single-call 8s/page
   budget. Forward flag if MaintainX latency degrades.

**Validation:**

- `pnpm typecheck` — passes 14/14 packages (12 cached, 2 fresh:
  workorders-worker, web).
- `pnpm --filter @splash/web build` — succeeds. `/workorders` route
  bundle is **3.12 kB / 105 kB** First Load JS (no observable delta
  from Brief 71's baseline; the type extension and copy change are
  both negligible).
- `pnpm --filter @splash/workorders-worker exec wrangler deploy
  --dry-run` — succeeds. Total Upload **732.31 KiB / 139.37 KiB
  gzip** (well within Cloudflare's 3 MiB compressed limit). No new
  bindings, no new env vars, no new secrets. (The pnpm wrapper
  reports a non-zero exit on Windows due to wrangler's process
  termination behavior on `--dry-run: exiting now.`; running
  `npx wrangler deploy --dry-run` directly returns exit 0.)

**Empirical observations:** none — no live MaintainX API calls were
made from headless. See latent issue #2 for the operator-side
validation path.

**Bundle deltas:**

- workorders-worker: 732.31 KiB / 139.37 KiB gzip (up from Brief
  71's baseline by an estimated few hundred bytes for the pagination
  branch + new const block; operator can confirm via `git stash`
  + dry-run if a precise delta is needed).
- apps/web `/workorders` route: 3.12 kB / 105 kB First Load JS, no
  observable delta vs. Brief 71.
