// MaintainX -> Supabase ingest driver.
//
// Reads pages with `@splash/maintainx` (sync.ts), maps them with `./mx-map.ts`,
// writes them with `@splash/db-supabase` (maintainx-ingest.ts). This module is
// the only place that knows about passes, budgets and checkpoints.
//
// ---------------------------------------------------------------------------
// Why chunked, and what the budget actually protects
// ---------------------------------------------------------------------------
//
// The backfill is roughly 20,000 work orders and 10,243 work requests. At 200
// rows per page — the API's hard maximum, verified — that is ~100 work-order
// pages and ~52 request pages. A Cloudflare cron invocation cannot do that in
// one go, so every pass is resumable: the cursor is checkpointed to
// `mx_sync_state` after EVERY page, and the next tick picks up exactly where
// the last one stopped. A cursor walk keeps its filters applied across pages
// with zero row overlap, which is what makes resuming safe rather than a
// silent widening of the window.
//
// On the Workers Paid plan the subrequest ceiling is 1,000 per invocation and
// CPU is effectively free at our volume (820k of 30M ms used). So the real
// governor is wall-clock: `TIME_BUDGET_MS`. `PAGE_BUDGET` and
// `SUBREQUEST_BUDGET` are safety rails, not the intended stopping condition.
//
// ---------------------------------------------------------------------------
// Pass order, and why it is an order rather than a set
// ---------------------------------------------------------------------------
//
//   1. work_orders_live    — OPEN/IN_PROGRESS/ON_HOLD, NO date bound.
//        The live queue reaches back about three years: a six-month walk finds
//        1,270 live work orders where an unbounded one finds 3,920. Bounding
//        this pass by date would silently drop two thirds of the live queue,
//        which is the one thing the operator page actually renders.
//
//   2. work_orders_history — DONE/CANCELED/SKIPPED, createdAt >= 6 months.
//        Closed work is 18,657 rows and only matters for reporting, so it is
//        bounded and runs second. If a backfill only ever gets halfway, the
//        half that landed is the half that matters.
//
//   3. work_requests_full  — every request, no filter.
//        Runs last because `mx_work_request.work_order_id` is a foreign key
//        into `mx_work_order`. 8,800 of 10,243 requests carry a work-order id,
//        and requests predate the six-month history window, so some of those
//        ids will never exist locally. See `resolveWorkOrderIds`.
//
// Once all three are complete the dispatcher switches to the incremental
// sweep, permanently.

import {
  fetchWorkOrderPage,
  fetchWorkRequestPage,
  INGEST_PAGE_LIMIT,
  LIVE_WORK_ORDER_STATUSES,
  fetchWorkOrderComments,
  type RawWorkOrderComment
} from "@splash/maintainx";
import {
  fetchMxLocationMap,
  getMxSyncState,
  writeMxSyncState,
  upsertMxWorkOrders,
  upsertMxWorkRequests,
  replaceMxWorkOrderPartsForPage,
  replaceMxWorkOrderExpendituresForPage,
  replaceMxWorkOrderTimeItemsForPage,
  upsertMxWorkOrderComments,
  selectMxCommentBacklog,
  stampMxCommentsSynced,
  type MxCommentStampRow,
  type MxSyncStateRow,
  type MxWorkOrderCommentRow,
  type MxWorkOrderRow,
  type MxWorkRequestRow,
  type MxWorkOrderPartRow,
  type MxWorkOrderExpenditureRow,
  type MxWorkOrderTimeItemRow,
  type SupabaseWriteEnv
} from "@splash/db-supabase";
import {
  mapComment,
  mapWorkOrder,
  mapWorkRequest,
  type MxLocationMap
} from "./mx-map.js";

export interface MxIngestEnv extends SupabaseWriteEnv {
  MAINTAINX_API_KEY?: string;
  MAINTAINX_BASE_URL: string;
}

export const MX_PASS_LIVE = "work_orders_live";
export const MX_PASS_HISTORY = "work_orders_history";
export const MX_PASS_REQUESTS = "work_requests_full";
export const MX_PASS_INCREMENTAL = "work_orders_incremental";

/** Bookkeeping key for the comment pass. Deliberately NOT a member of
 *  MX_BACKFILL_PASSES: the dispatcher treats those as things that finish, and
 *  the comment pass never does -- it drains a work set that refills every time
 *  somebody posts. Putting it in the list would wedge the dispatcher there and
 *  the incremental sweep would never run again. */
export const MX_PASS_COMMENTS = "work_order_comments";

/** Backfill passes, in the order they must run. */
export const MX_BACKFILL_PASSES = [
  MX_PASS_LIVE,
  MX_PASS_HISTORY,
  MX_PASS_REQUESTS
] as const;

export type MxPassKey = (typeof MX_BACKFILL_PASSES)[number] | typeof MX_PASS_INCREMENTAL;

/** Wall clock is the real stopping condition. 20s leaves generous room inside
 *  a cron invocation for the final checkpoint write to land. */
export const TIME_BUDGET_MS = 20_000;
/** Safety rail. ~100 pages of work orders exist in total, so 50 means a cold
 *  backfill finishes in a handful of ticks if nothing else binds first. */
export const PAGE_BUDGET = 50;
/** Safety rail against the 1,000-subrequest platform ceiling. */
export const SUBREQUEST_BUDGET = 900;

/** Closed-work history window. */
export const HISTORY_WINDOW_DAYS = 183;

/** The incremental sweep re-reads a little of what it already has. MaintainX
 *  timestamps and our clock are not the same clock, and re-upserting a row is
 *  free; missing one is not. */
export const INCREMENTAL_OVERLAP_MS = 5 * 60_000;

/** Work orders pulled off the comment backlog per tick. The cold backlog is
 *  ~1,851 threads, so 100 a tick against a five-minute cron drains it in about
 *  an hour and a half; after that the real backlog is whatever moved in the
 *  last five minutes, which is nearly always nothing. */
export const COMMENT_WORK_SET = 100;

/** Work orders per write cycle. The unit of durability: everything in a chunk
 *  is fetched, then written, then stamped together, so a chunk is also the most
 *  work a crash can cost. Small enough that the budget check between chunks is
 *  frequent, large enough that the two writes amortise over 25 threads. */
export const COMMENT_CHUNK = 25;

/** Pages per thread before the walk gives up. Measured thread length is a mean
 *  of 2.5 comments and a maximum of 6, against a 200-row page -- so one page is
 *  the norm and five is an absurd allowance that exists only to bound the loop
 *  if the API ever returns a cursor that does not terminate. */
export const COMMENT_PAGE_CAP = 5;

export interface MxPassResult {
  key: MxPassKey;
  ok: boolean;
  /** True when the cursor went null — the ONLY completion signal the API
   *  offers, since no endpoint returns a total count. */
  complete: boolean;
  pages: number;
  rows: number;
  /** Highest `mx_updated_at` written by this run, or null when the run wrote no
   *  dated rows. The incremental sweep's next watermark comes from HERE and
   *  nowhere else. Reading it back off the sync-state row meant reading the
   *  PREVIOUS run's value, which is how the empty-200 bug was able to drag the
   *  watermark forward across a window it had never actually read. */
  maxUpdatedAt: string | null;
  requests: number;
  elapsedMs: number;
  error: string | null;
}

export interface MxCommentPassResult {
  ok: boolean;
  /** Threads taken off the backlog this tick. */
  workOrders: number;
  /** Work orders whose watermark advanced -- fetched cleanly, or 404. */
  stamped: number;
  /** Comment rows upserted. */
  comments: number;
  /** Threads whose fetch failed. Left un-stamped, so still in the backlog. */
  failed: number;
  /** Threads that hit COMMENT_PAGE_CAP. Stamped anyway; see `fetchThread`. */
  truncated: number;
  requests: number;
  elapsedMs: number;
  error: string | null;
}

export interface MxIngestResult {
  ok: boolean;
  /** Null when there was nothing to do or the worker is not configured. */
  pass: MxPassResult | null;
  /** Null while the backfill is still running, and on every early return --
   *  the comment pass only gets whatever budget the incremental sweep leaves
   *  behind. */
  comments: MxCommentPassResult | null;
  skipped: string | null;
}

/* ============================================================
 * Budget
 * ============================================================ */

class Budget {
  readonly startedAt = Date.now();
  pages = 0;
  requests = 0;

  constructor(
    private readonly timeMs = TIME_BUDGET_MS,
    private readonly maxPages = PAGE_BUDGET,
    private readonly maxRequests = SUBREQUEST_BUDGET
  ) {}

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Checked AFTER a page is fully written and checkpointed, never mid-page:
   *  stopping between the fetch and the upsert would advance nothing and
   *  redo the work next tick. */
  exhausted(): boolean {
    return (
      this.elapsedMs >= this.timeMs ||
      this.pages >= this.maxPages ||
      this.requests >= this.maxRequests
    );
  }
}

/* ============================================================
 * Dispatcher
 * ============================================================ */

/**
 * A pass is complete when its cursor is null AND it has succeeded at least
 * once. Cursor-null alone is the initial state of a pass that has never run.
 */
function isComplete(state: MxSyncStateRow | null): boolean {
  return state !== null && state.cursor === null && state.last_success_at !== null;
}

/**
 * Runs at most ONE pass per invocation. Doing more would mean sharing a single
 * time budget between passes and finishing neither cleanly, and the passes are
 * ordered precisely so that the earlier ones deserve the whole tick.
 */
export async function runMxIngest(env: MxIngestEnv): Promise<MxIngestResult> {
  const apiKey = env.MAINTAINX_API_KEY;
  if (!apiKey) {
    return { ok: true, pass: null, comments: null, skipped: "MAINTAINX_API_KEY unbound" };
  }

  const budget = new Budget();

  // One location-map read per invocation, reused by every page. Reading it per
  // work order would be 200 extra requests a page for data that changes maybe
  // twice a year.
  const locationMap = await fetchMxLocationMap(env);
  budget.requests += 1;
  if (!locationMap.ok) {
    return { ok: false, pass: null, comments: null, skipped: `location map: ${locationMap.error}` };
  }

  for (const key of MX_BACKFILL_PASSES) {
    const state = await getMxSyncState(env, key);
    budget.requests += 1;
    if (!state.ok) {
      return { ok: false, pass: null, comments: null, skipped: `sync state ${key}: ${state.error}` };
    }
    if (isComplete(state.state)) continue;

    const pass =
      key === MX_PASS_REQUESTS
        ? await runWorkRequestPass(env, apiKey, key, state.state, locationMap.map, budget)
        : await runWorkOrderPass(env, apiKey, key, state.state, locationMap.map, budget, {
            // The history pass deliberately sends NO status filter. Asking for
            // CANCELED and SKIPPED together makes GET /workorders answer 200
            // with an empty collection and a null cursor (measured; see the doc
            // comment on CLOSED_WORK_ORDER_STATUSES in packages/maintainx), and
            // the walk below correctly reads a null cursor as "finished" — so
            // this pass ingested nothing and marked itself OK. The pass is
            // partitioned by its createdAt[gte] bound, not by status, so the
            // filter was never load-bearing. Without it the pass also re-fetches
            // live work orders created inside the window, which is harmless: the
            // upsert is idempotent and the live pass already has them. `[]`
            // appends no `statuses` query param at all.
            statuses: key === MX_PASS_LIVE ? LIVE_WORK_ORDER_STATUSES : [],
            createdAtGte:
              key === MX_PASS_HISTORY
                ? new Date(Date.now() - HISTORY_WINDOW_DAYS * 86_400_000).toISOString()
                : null,
            updatedAtGte: null,
            // Newest-first. A backfill interrupted halfway has the recent half.
            sort: "-updatedAt",
            prune: false
          });

    return { ok: pass.ok, pass, comments: null, skipped: null };
  }

  const state = await getMxSyncState(env, MX_PASS_INCREMENTAL);
  budget.requests += 1;
  if (!state.ok) {
    return { ok: false, pass: null, comments: null, skipped: `sync state incremental: ${state.error}` };
  }

  const pass = await runIncrementalPass(env, apiKey, state.state, locationMap.map, budget);

  // The comment pass rides along on the same invocation instead of taking a
  // tick of its own. It is gated on the incremental sweep because the two are
  // not peers: the sweep is what makes `last_message_sent_at` current, so
  // running comments first would drain a backlog computed from stale
  // watermarks. And it is affordable because the steady-state sweep costs about
  // two requests and a fraction of a second -- it finds nothing, almost always.
  // Whatever the sweep did not spend goes here.
  //
  // Gated on `pass.ok` as well: if the sweep failed, a tick spent stamping
  // watermarks against stale `last_message_sent_at` values hides those comments
  // until the next message arrives.
  const comments =
    pass.ok && !budget.exhausted() ? await runCommentPass(env, apiKey, budget) : null;

  return { ok: pass.ok && (comments?.ok ?? true), pass, comments, skipped: null };
}

/* ============================================================
 * Work-order passes
 * ============================================================ */

interface WorkOrderPassOptions {
  statuses: readonly string[];
  createdAtGte: string | null;
  updatedAtGte: string | null;
  sort: "updatedAt" | "-updatedAt";
  /** When true, child rows are replaced for EVERY work order on the page, so
   *  lines deleted in MaintainX are cleared locally. When false (backfill),
   *  only work orders that actually returned child rows are touched — there is
   *  nothing stale to prune on a corpus being written for the first time, and
   *  skipping the delete saves two requests a page. */
  prune: boolean;
}

async function runWorkOrderPass(
  env: MxIngestEnv,
  apiKey: string,
  key: MxPassKey,
  state: MxSyncStateRow | null,
  locations: MxLocationMap,
  budget: Budget,
  options: WorkOrderPassOptions
): Promise<MxPassResult> {
  let cursor = state?.cursor ?? null;
  let rows = 0;
  let pages = 0;
  /** Highest `updatedAt` seen this run — the incremental pass's next watermark.
   *  Only committed when the walk completes; advancing it mid-pass would
   *  permanently skip whatever the interrupted pass had not reached. */
  let maxUpdatedAt: string | null = null;

  const fail = async (error: string): Promise<MxPassResult> => {
    await writeMxSyncState(env, key, {
      cursor,
      last_run_at: new Date().toISOString(),
      last_status: "ERROR",
      last_error: error.slice(0, 2000),
      stats: { pages, rows }
    });
    return {
      key,
      ok: false,
      complete: false,
      pages,
      rows,
      maxUpdatedAt,
      requests: budget.requests,
      elapsedMs: budget.elapsedMs,
      error
    };
  };

  for (;;) {
    const page = await fetchWorkOrderPage({
      apiKey,
      baseUrl: env.MAINTAINX_BASE_URL,
      cursor,
      limit: INGEST_PAGE_LIMIT,
      statuses: options.statuses,
      sort: options.sort,
      createdAtGte: options.createdAtGte,
      updatedAtGte: options.updatedAtGte
    });
    budget.requests += 1;
    if (!page.ok) return fail(`fetch: ${page.error ?? "unknown"}`);

    const syncedAt = new Date().toISOString();
    const workOrders: MxWorkOrderRow[] = [];
    const parts: MxWorkOrderPartRow[] = [];
    const expenditures: MxWorkOrderExpenditureRow[] = [];
    const timeItems: MxWorkOrderTimeItemRow[] = [];

    for (const raw of page.workOrders) {
      const mapped = mapWorkOrder(raw, locations, syncedAt);
      if (!mapped) continue;
      workOrders.push(mapped.row);
      parts.push(...mapped.parts);
      expenditures.push(...mapped.expenditures);
      timeItems.push(...mapped.timeItems);
      if (mapped.row.mx_updated_at && (!maxUpdatedAt || mapped.row.mx_updated_at > maxUpdatedAt)) {
        maxUpdatedAt = mapped.row.mx_updated_at;
      }
    }

    // Parent first: every child table has an ON DELETE CASCADE FK into
    // mx_work_order, so writing a child before its parent is a 409.
    const parentWrite = await upsertMxWorkOrders(env, workOrders);
    budget.requests += parentWrite.requests;
    if (!parentWrite.ok) return fail(`upsert work orders: ${parentWrite.error ?? "unknown"}`);

    const pageIds = workOrders.map((w) => w.id);
    const childWrite = await writeChildren(env, pageIds, options.prune, {
      parts,
      expenditures,
      timeItems
    });
    budget.requests += childWrite.requests;
    if (!childWrite.ok) return fail(childWrite.error ?? "child write failed");

    rows += workOrders.length;
    pages += 1;
    budget.pages += 1;
    cursor = page.nextCursor;

    const complete = cursor === null;
    const now = new Date().toISOString();
    const checkpoint = await writeMxSyncState(env, key, {
      cursor,
      last_run_at: now,
      // A one-page walk that returned zero rows and a null cursor is
      // indistinguishable from a legitimately finished walk — that is exactly
      // how the CANCELED+SKIPPED empty-200 bug hid for six hours. EMPTY makes
      // that shape visible in mx_sync_state. It is deliberately NOT a failure
      // and NOT a retry trigger: control flow is unchanged, the pass still
      // counts as complete and still stamps last_success_at, because an
      // incremental sweep that finds no updates is routine and common.
      last_status: complete && pages === 1 && rows === 0 ? "EMPTY" : complete ? "OK" : "PARTIAL",
      last_error: null,
      ...(complete ? { last_success_at: now } : {}),
      stats: { pages, rows, max_updated_at: maxUpdatedAt }
    });
    budget.requests += 1;
    if (!checkpoint.ok) return fail(`checkpoint: ${checkpoint.error ?? "unknown"}`);

    if (complete || budget.exhausted()) {
      return {
        key,
        ok: true,
        complete,
        pages,
        rows,
        maxUpdatedAt,
        requests: budget.requests,
        elapsedMs: budget.elapsedMs,
        error: null
      };
    }
  }
}

interface ChildRows {
  parts: MxWorkOrderPartRow[];
  expenditures: MxWorkOrderExpenditureRow[];
  timeItems: MxWorkOrderTimeItemRow[];
}

async function writeChildren(
  env: MxIngestEnv,
  pageIds: number[],
  prune: boolean,
  child: ChildRows
): Promise<{ ok: boolean; requests: number; error: string | null }> {
  const scope = (rows: Array<{ work_order_id: number }>): number[] =>
    prune ? pageIds : Array.from(new Set(rows.map((r) => r.work_order_id)));

  let requests = 0;

  const partsWrite = await replaceMxWorkOrderPartsForPage(env, scope(child.parts), child.parts);
  requests += partsWrite.requests;
  if (!partsWrite.ok) return { ok: false, requests, error: `parts: ${partsWrite.error}` };

  const expWrite = await replaceMxWorkOrderExpendituresForPage(
    env,
    scope(child.expenditures),
    child.expenditures
  );
  requests += expWrite.requests;
  if (!expWrite.ok) return { ok: false, requests, error: `expenditures: ${expWrite.error}` };

  const timeWrite = await replaceMxWorkOrderTimeItemsForPage(
    env,
    scope(child.timeItems),
    child.timeItems
  );
  requests += timeWrite.requests;
  if (!timeWrite.ok) return { ok: false, requests, error: `time items: ${timeWrite.error}` };

  return { ok: true, requests, error: null };
}

/* ============================================================
 * Incremental sweep
 * ============================================================ */

/**
 * Re-reads everything touched since the watermark, across ALL statuses so that
 * a work order closing is seen as an update rather than as a disappearance.
 *
 * Sorted ASCENDING on purpose. The watermark can only advance to a timestamp
 * whose entire prefix has been written, and ascending order means an
 * interrupted walk has written exactly that prefix.
 *
 * This sweep does NOT see comment activity: MaintainX explicitly excludes
 * comments from `updatedAt`. Comments are driven off `lastMessageSentAt`,
 * which this pass does store on every row it touches — that is the input the
 * comment pass will consume once `comments_synced_at` exists.
 */
async function runIncrementalPass(
  env: MxIngestEnv,
  apiKey: string,
  state: MxSyncStateRow | null,
  locations: MxLocationMap,
  budget: Budget
): Promise<MxPassResult> {
  const watermark = state?.watermark
    ? new Date(Date.parse(state.watermark) - INCREMENTAL_OVERLAP_MS).toISOString()
    : new Date(Date.now() - 3_600_000).toISOString();

  const result = await runWorkOrderPass(
    env,
    apiKey,
    MX_PASS_INCREMENTAL,
    state,
    locations,
    budget,
    {
      // Asking for all six statuses is semantically identical to asking for
      // none, and the six-value set contains the poisoned CANCELED+SKIPPED
      // pair that makes GET /workorders return an empty 200. Omitting the
      // filter is behavior-preserving and dodges the bug. `[]` appends no
      // `statuses` query param at all.
      statuses: [],
      createdAtGte: null,
      updatedAtGte: watermark,
      sort: "updatedAt",
      prune: true
    }
  );

  if (result.ok && result.complete) {
    // Commit the watermark only now. `runWorkOrderPass` has already cleared
    // the cursor and stamped last_success_at; this is a second small write
    // rather than a field on the checkpoint precisely because it must not
    // happen on a PARTIAL page.
    //
    // The value comes from THIS run's result. It used to be read back off the
    // sync-state row, which returned whatever the PREVIOUS run had left there,
    // with `?? new Date().toISOString()` when that was missing -- and that
    // fallback is precisely what let the empty-200 bug advance the watermark
    // every five minutes across a window it had never read. The watermark is
    // now written only when this run actually saw a dated row.
    //
    // A completed-but-EMPTY walk deliberately leaves the watermark ALONE.
    // Advancing it would be sound against a trustworthy API -- an unbounded
    // window returning nothing really does mean nothing changed -- but "empty"
    // and "lying" are the same wire shape on this endpoint, so the window is
    // allowed to widen instead. Cost of widening: one slightly larger query
    // next tick, walked ascending and cursor-resumable. Cost of the old
    // behaviour: silent, permanent data loss.
    //
    // Monotonic on purpose. The read bound above subtracts
    // INCREMENTAL_OVERLAP_MS, so a run whose only rows fall inside that overlap
    // can observe a max BELOW the stored watermark; without the comparison the
    // watermark would ratchet backwards five minutes at a time. Compared as
    // parsed instants, never as strings: `state.watermark` comes back from
    // Postgres as `2026-09-13 09:30:44.07+00` while `maxUpdatedAt` is ISO with
    // a `T`, and lexicographic order on those two shapes is wrong.
    const observed = result.maxUpdatedAt;
    const observedMs = observed === null ? NaN : Date.parse(observed);
    const priorMs = state?.watermark ? Date.parse(state.watermark) : NaN;

    // `!(priorMs >= observedMs)` rather than `<`: a NaN prior (no watermark
    // yet, or an unparseable one) must ADVANCE, and every NaN comparison is
    // false, so the negated form gives the right answer where `<` would not.
    if (observed !== null && Number.isFinite(observedMs) && !(priorMs >= observedMs)) {
      await writeMxSyncState(env, MX_PASS_INCREMENTAL, { watermark: observed });
      budget.requests += 1;
    }
  }

  return result;
}

/* ============================================================
 * Work-request pass
 * ============================================================ */

/**
 * `/workrequests` has no date filter and no sort, so "incremental" is not
 * available: the only option is to re-walk all ~52 pages and let the upsert
 * absorb the no-ops. Fine hourly, not fine every few minutes — which is why
 * this pass is not part of the recurring sweep.
 */
async function runWorkRequestPass(
  env: MxIngestEnv,
  apiKey: string,
  key: MxPassKey,
  state: MxSyncStateRow | null,
  locations: MxLocationMap,
  budget: Budget
): Promise<MxPassResult> {
  let cursor = state?.cursor ?? null;
  let rows = 0;
  let pages = 0;

  const fail = async (error: string): Promise<MxPassResult> => {
    await writeMxSyncState(env, key, {
      cursor,
      last_run_at: new Date().toISOString(),
      last_status: "ERROR",
      last_error: error.slice(0, 2000),
      stats: { pages, rows }
    });
    return {
      key,
      ok: false,
      complete: false,
      pages,
      rows,
      maxUpdatedAt: null,
      requests: budget.requests,
      elapsedMs: budget.elapsedMs,
      error
    };
  };

  for (;;) {
    const page = await fetchWorkRequestPage({
      apiKey,
      baseUrl: env.MAINTAINX_BASE_URL,
      cursor,
      limit: INGEST_PAGE_LIMIT
    });
    budget.requests += 1;
    if (!page.ok) return fail(`fetch: ${page.error ?? "unknown"}`);

    const syncedAt = new Date().toISOString();
    const mapped: MxWorkRequestRow[] = [];
    for (const raw of page.workRequests) {
      const row = mapWorkRequest(raw, locations, syncedAt);
      if (row) mapped.push(row);
    }

    const resolved = await resolveWorkOrderIds(env, mapped);
    budget.requests += resolved.requests;
    if (!resolved.ok) return fail(resolved.error ?? "work-order id resolution failed");

    const write = await upsertMxWorkRequests(env, mapped);
    budget.requests += write.requests;
    if (!write.ok) return fail(`upsert work requests: ${write.error ?? "unknown"}`);

    rows += mapped.length;
    pages += 1;
    budget.pages += 1;
    cursor = page.nextCursor;

    const complete = cursor === null;
    const now = new Date().toISOString();
    const checkpoint = await writeMxSyncState(env, key, {
      cursor,
      last_run_at: now,
      // Same zero-row honesty guard as runWorkOrderPass: one page, zero rows,
      // null cursor looks identical to a finished walk. EMPTY surfaces it in
      // mx_sync_state without changing control flow — the pass still completes
      // and still stamps last_success_at, because a legitimately empty result
      // is routine and must never become a retry trigger.
      last_status: complete && pages === 1 && rows === 0 ? "EMPTY" : complete ? "OK" : "PARTIAL",
      last_error: null,
      ...(complete ? { last_success_at: now } : {}),
      stats: { pages, rows }
    });
    budget.requests += 1;
    if (!checkpoint.ok) return fail(`checkpoint: ${checkpoint.error ?? "unknown"}`);

    if (complete || budget.exhausted()) {
      return {
        key,
        ok: true,
        complete,
        pages,
        rows,
        maxUpdatedAt: null,
        requests: budget.requests,
        elapsedMs: budget.elapsedMs,
        error: null
      };
    }
  }
}

/**
 * Nulls out `work_order_id` on any request whose work order is not in
 * `mx_work_order`, MUTATING the rows in place before they are written.
 *
 * This is not defensive tidiness — it is required. The column is a foreign key,
 * work requests go back further than the six-month closed-work window, and an
 * unresolvable id fails the whole 200-row statement, not just its own row.
 * Losing the link on an ancient request is the cheap outcome; losing the page
 * is not.
 *
 * One request per page: PostgREST `id=in.(...)` over at most 200 ids.
 */
async function resolveWorkOrderIds(
  env: MxIngestEnv,
  rows: MxWorkRequestRow[]
): Promise<{ ok: boolean; requests: number; error: string | null }> {
  const referenced = Array.from(
    new Set(
      rows
        .map((r) => r.work_order_id)
        .filter((id): id is number => typeof id === "number" && Number.isFinite(id))
    )
  );
  if (referenced.length === 0) return { ok: true, requests: 0, error: null };

  let url: URL;
  try {
    url = new URL("/rest/v1/mx_work_order", env.SUPABASE_URL);
  } catch (err) {
    return {
      ok: false,
      requests: 0,
      error: `bad SUPABASE_URL: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  url.searchParams.set("select", "id");
  url.searchParams.set("id", `in.(${referenced.join(",")})`);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    return {
      ok: false,
      requests: 1,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  const body = await response.text().catch(() => "");
  if (!response.ok) {
    return { ok: false, requests: 1, error: `${response.status}: ${body.slice(0, 512)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return {
      ok: false,
      requests: 1,
      error: `unparseable body: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, requests: 1, error: "expected an array" };
  }

  const present = new Set<number>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id === "number") present.add(id);
  }

  for (const row of rows) {
    if (typeof row.work_order_id === "number" && !present.has(row.work_order_id)) {
      row.work_order_id = null;
    }
  }

  return { ok: true, requests: 1, error: null };
}

/* ============================================================
 * Comment pass
 * ============================================================ */

/**
 * Drains `mx_comment_backlog`: work orders whose thread has moved since the
 * last time this pass looked at them.
 *
 * Shape differs from every other pass here, because the API does. There is no
 * collection endpoint for comments -- `/workorders/{id}/comments` is the only
 * way in -- so this is not a cursor walk that can be checkpointed mid-flight.
 * It is a work set: read a batch of ids, fetch each thread, write, stamp. The
 * stamp IS the checkpoint, and it is per work order rather than per page.
 *
 * Why it can afford one request per work order: `type = 'REACTIVE'` plus
 * `last_message_sent_at is not null` selects 1,851 work orders out of ~20,000
 * measured over six months. Preventive work orders carry comments 0.2% of the
 * time. And the backlog is self-draining -- a work order enters it when its
 * thread moves and leaves it the moment the watermark is stamped, so in steady
 * state the set is "threads that moved in the last five minutes", which is
 * usually zero and costs exactly one request to discover.
 *
 * The pass is idempotent by construction rather than by watermark: comments
 * upsert on their own MaintainX id, and MaintainX does not expose an
 * `updatedAt` on a comment. Refetching a thread rewrites the same rows. The
 * flip side, accepted: a comment EDITED in MaintainX is invisible unless
 * something else in the thread moves `last_message_sent_at`.
 */
async function runCommentPass(
  env: MxIngestEnv,
  apiKey: string,
  budget: Budget
): Promise<MxCommentPassResult> {
  const startedAt = Date.now();
  const startRequests = budget.requests;

  let workOrders = 0;
  let stamped = 0;
  let comments = 0;
  let failed = 0;
  let truncated = 0;

  const stats = (): Record<string, number> => ({
    work_orders: workOrders,
    stamped,
    comments,
    failed,
    truncated
  });

  const tally = (error: string | null): MxCommentPassResult => ({
    ok: error === null,
    workOrders,
    stamped,
    comments,
    failed,
    truncated,
    requests: budget.requests - startRequests,
    elapsedMs: Date.now() - startedAt,
    error
  });

  const fail = async (error: string): Promise<MxCommentPassResult> => {
    await writeMxSyncState(env, MX_PASS_COMMENTS, {
      last_run_at: new Date().toISOString(),
      last_status: "ERROR",
      last_error: error.slice(0, 2000),
      stats: stats()
    });
    return tally(error);
  };

  const backlog = await selectMxCommentBacklog(env, COMMENT_WORK_SET);
  budget.requests += 1;
  if (!backlog.ok) return fail(`backlog: ${backlog.error ?? "unknown"}`);

  for (let i = 0; i < backlog.rows.length; i += COMMENT_CHUNK) {
    const chunk = backlog.rows.slice(i, i + COMMENT_CHUNK);
    const syncedAt = new Date().toISOString();
    const rows: MxWorkOrderCommentRow[] = [];
    const stamps: MxCommentStampRow[] = [];

    for (const work of chunk) {
      // Checked per work order, not just per chunk: a chunk is 25 sequential
      // round trips to MaintainX, and the whole point of stopping is to stop
      // before the invocation does.
      if (budget.exhausted()) break;

      workOrders += 1;
      const thread = await fetchThread(env, apiKey, work.id, budget);
      if (!thread.ok) {
        // Left UN-stamped on purpose: it stays in the backlog and is retried
        // next tick. The backlog is ordered by recency, so a thread that fails
        // repeatedly sits at a fixed position costing one request a tick --
        // visible in `failed`, not fatal.
        failed += 1;
        continue;
      }
      if (thread.truncated) truncated += 1;

      for (const raw of thread.comments) {
        const row = mapComment(raw, work.id, syncedAt);
        if (row) rows.push(row);
      }

      // The stamp is the value the work order carried when the backlog was
      // read, never `Date.now()`. See MxCommentStampRow.
      stamps.push({ id: work.id, comments_synced_at: work.last_message_sent_at });
    }

    const write = await upsertMxWorkOrderComments(env, rows);
    budget.requests += write.requests;
    if (!write.ok) return fail(`upsert comments: ${write.error ?? "unknown"}`);
    comments += write.written;

    // Strictly after the comments are durable. Crashing between the two costs a
    // refetch of one chunk; doing it in the other order would stamp threads
    // whose comments never landed and lose them until someone posts again.
    const stamp = await stampMxCommentsSynced(env, stamps);
    budget.requests += stamp.requests;
    if (!stamp.ok) return fail(`stamp watermark: ${stamp.error ?? "unknown"}`);
    stamped += stamp.written;

    if (budget.exhausted()) break;
  }

  // Recorded even when the backlog was empty. `mx_sync_state` is the only place
  // an operator can see that this pass is alive, and "no row" would otherwise
  // be indistinguishable from "never deployed".
  const now = new Date().toISOString();
  const checkpoint = await writeMxSyncState(env, MX_PASS_COMMENTS, {
    last_run_at: now,
    last_success_at: now,
    last_status: failed > 0 ? "PARTIAL" : "OK",
    last_error: failed > 0 ? `${failed} thread fetch(es) failed, left in backlog` : null,
    stats: stats()
  });
  budget.requests += 1;
  if (!checkpoint.ok) return tally(`checkpoint: ${checkpoint.error ?? "unknown"}`);

  return tally(null);
}

interface ThreadResult {
  ok: boolean;
  comments: RawWorkOrderComment[];
  /** True when COMMENT_PAGE_CAP stopped the walk before the cursor went null.
   *  The work order is still stamped -- see below. */
  truncated: boolean;
}

/** Walks one work order's comment thread to the end of its cursor. */
async function fetchThread(
  env: MxIngestEnv,
  apiKey: string,
  workOrderId: number,
  budget: Budget
): Promise<ThreadResult> {
  const comments: RawWorkOrderComment[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < COMMENT_PAGE_CAP; page += 1) {
    const res = await fetchWorkOrderComments({
      apiKey,
      baseUrl: env.MAINTAINX_BASE_URL,
      workOrderId,
      cursor,
      limit: INGEST_PAGE_LIMIT
    });
    budget.requests += 1;

    if (!res.ok) {
      // 404 is a work order that no longer exists in MaintainX. Reporting it as
      // a failure would pin it in the backlog forever at one wasted request per
      // tick, so it is treated as an empty thread: nothing to write, watermark
      // stamped, row drains out. Every other status is retryable and is not.
      if (res.status === 404) return { ok: true, comments, truncated: false };
      return { ok: false, comments: [], truncated: false };
    }

    comments.push(...res.comments);
    cursor = res.nextCursor;
    if (cursor === null) return { ok: true, comments, truncated: false };
  }

  // Cap hit. Stamped anyway by the caller, deliberately: refusing to stamp
  // would refetch the same first COMMENT_PAGE_CAP pages every tick forever and
  // never reach the tail. Measured thread length is a mean of 2.5 comments
  // against a page size of 200, so reaching this line means something is wrong
  // in a way worth seeing in `truncated` rather than absorbing silently.
  return { ok: true, comments, truncated: true };
}
