// Time-item sweep: pull latent labor out of MaintainX.
//
// THE PROBLEM, MEASURED
//
//   MaintainX fires no webhook of any kind for a time entry. Not for the
//   mobile timer, not for an entry typed in by hand. The documented escape
//   hatch does not exist either -- MaintainX documents a
//   `newWorkOrder.costs.rows[]` block on WORK_ORDER_CHANGE and zero of 1,338
//   stored deliveries contained it. Every webhook this org receives is a bare
//   "something changed, go refetch" ping and none of them concerns labor.
//
//   So hours are captured only when something ELSE about the work order
//   happens to fire a webhook. A mechanic who runs the timer and never flips
//   the status -- and 74% of reactive work orders reach DONE without ever
//   passing through IN_PROGRESS -- has hours that sit in MaintainX invisibly.
//
//   They are LATENT, not lost: when any event finally forces a refetch, the
//   whole backlog flushes at once. Observed on work order 118834534 on
//   2026-09-16, labor_seconds 4145 -> 11372 in a single operation.
//
// WHY THE EXISTING SWEEPS CANNOT DO THIS
//
//   `mx_updated_at` DOES NOT ADVANCE for time or cost edits. Measured on the
//   same work order: after a timer run, a hand-added two-hour entry, an
//   expense row and the backlog flush, updated_at still read the status change
//   from three quarters of an hour earlier.
//
//   That is the whole reason this module exists and the one thing to hold on
//   to when changing it. The 5-minute incremental pass asks MaintainX for work
//   orders whose updatedAt moved. Rows with labor waiting on them are exactly
//   the rows whose updatedAt did not move. An incremental sweep is not merely
//   inefficient here, it is STRUCTURALLY BLIND to precisely the data it would
//   exist to capture -- it would re-examine the work orders with nothing new
//   and skip the ones with hours waiting.
//
//   So: select candidates by a rule that does not ask the source whether
//   anything changed, and refetch them unconditionally.
//
// THE SELECTOR
//
//   Reactive work orders (PLAN.md §2.1 -- preventive work belongs to site
//   staff, not the maintenance team, and is 88% of the table) that are either
//   still live, or completed recently enough that hours could still be being
//   added after the fact. Roughly 530 rows as of 2026-09-16.
//
//   Ordered by `synced_at` ascending, which makes the rotation self-managing
//   with no extra state: refetching a work order stamps its synced_at, which
//   sends it to the back of the queue. The 5-minute incremental pass stamps
//   the same column on anything it touches, which is also correct -- those
//   rows are already current and should go to the back too.
//
//   At WORK_ORDERS_PER_PASS every 5 minutes the whole candidate set turns over
//   in about two hours, so the worst-case age of latent labor goes from
//   unbounded to roughly one rotation.

import { getMxSyncState, writeMxSyncState } from "@splash/db-supabase";
import type { SupabaseEnv } from "@splash/db-supabase";
import { MX_PASS_LIVE } from "./mx-ingest.js";
import { processWorkOrder, type MxWebhookProcessEnv } from "./mx-webhook-process.js";

/** Bookkeeping key in mx_sync_state. Not a member of MX_BACKFILL_PASSES --
 *  this pass never completes, it rotates. */
export const MX_PASS_TIMESWEEP = "work_orders_timesweep";

/** Wall-clock ceiling for one pass. The 5-minute tick already carries the
 *  webhook drain, the incremental ingest and the attachment mirror; this must
 *  leave room for all three rather than racing them. */
const BUDGET_MS = 15_000;

/** Work orders refetched per pass. One MaintainX GET each.
 *
 *  Sized against the candidate set rather than against the budget: ~530 rows
 *  at 20 per 5-minute tick is a full rotation every ~2.2 hours, which is the
 *  number that actually matters -- it is the worst-case age of an unsynced
 *  time entry. Raising it shortens that at the cost of API calls the account
 *  shares with the ingest. */
const WORK_ORDERS_PER_PASS = 20;

/** How long after completion a work order stays a candidate.
 *
 *  Not zero, because labor is routinely added AFTER the job is closed out --
 *  which is the same behaviour that makes this sweep necessary in the first
 *  place. Not unbounded, because every extra day of window dilutes the
 *  rotation and pushes the worst-case latency on live work orders up. */
const RECENTLY_COMPLETED_DAYS = 14;

export interface MxTimeSweepEnv extends SupabaseEnv, MxWebhookProcessEnv {}

export interface TimeSweepResult {
  /** Candidates selected this pass. */
  selected: number;
  /** Refetched successfully. */
  refetched: number;
  /** Refetches that failed. Next pass retries them -- they keep their old
   *  synced_at, so they stay at the front of the queue. */
  failed: number;
  /** Set when the pass stopped early on the wall-clock budget. */
  budgetHit: boolean;
  /** Set when the pass did not run at all, with the reason. */
  skipped: string | null;
}

interface Candidate {
  id: number;
  synced_at: string | null;
}

/**
 * Pick the next slice of work orders to refetch.
 *
 * The `or=` filter is the "still live OR recently closed" rule.
 *
 * Spelled as three separate `status.eq.` branches rather than one
 * `status.in.(OPEN,IN_PROGRESS,ON_HOLD)`. The `in.` form is shorter and puts a
 * comma-separated list inside a comma-separated list, where the inner commas
 * are doing one job and the outer ones another. It does parse -- but the
 * failure mode if it ever did not is a 400 on a query nobody reads the text
 * of, and there is nothing to gain from being clever in a filter that runs
 * every five minutes forever.
 *
 * The built query string is included in the error on failure for the same
 * reason: a filter that is wrong should say what it was.
 */
async function selectCandidates(
  env: MxTimeSweepEnv,
  limit: number
): Promise<{ ok: boolean; rows: Candidate[]; error: string | null }> {
  const cutoff = new Date(Date.now() - RECENTLY_COMPLETED_DAYS * 86_400_000).toISOString();

  const url = new URL("/rest/v1/mx_work_order", env.SUPABASE_URL);
  url.searchParams.set("select", "id,synced_at");
  url.searchParams.set("type", "eq.REACTIVE");
  url.searchParams.set("deleted_at", "is.null");
  url.searchParams.set(
    "or",
    "(status.eq.OPEN,status.eq.IN_PROGRESS,status.eq.ON_HOLD," +
      `completed_at.gte.${cutoff})`
  );
  // NULLs first is deliberate: a row that has never been stamped is the most
  // likely to be carrying something we have never seen.
  url.searchParams.set("order", "synced_at.asc.nullsfirst");
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!res.ok) {
      return {
        ok: false,
        rows: [],
        error: `${res.status}: ${(await res.text()).slice(0, 300)} [query ${url.search}]`
      };
    }
    return { ok: true, rows: (await res.json()) as Candidate[], error: null };
  } catch (err) {
    return {
      ok: false,
      rows: [],
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Run one pass.
 *
 * Never throws -- the caller is a scheduled handler sharing a tick with three
 * other jobs, and a rejection there takes all of them down.
 *
 * Work orders are refetched SEQUENTIALLY. Concurrency would finish sooner and
 * is not worth it: this pass has no deadline anyone feels, the budget stops it
 * cleanly either way, and the MaintainX API quota is shared with the ingest
 * running on the same tick.
 */
export async function runMxTimeSweep(env: MxTimeSweepEnv): Promise<TimeSweepResult> {
  const startedAt = Date.now();
  const empty: TimeSweepResult = {
    selected: 0,
    refetched: 0,
    failed: 0,
    budgetHit: false,
    skipped: null
  };

  if (!env.MAINTAINX_API_KEY) {
    return stoodDown(env, empty, startedAt, "MAINTAINX_API_KEY not bound");
  }

  // Stand behind a backfill that is actually getting somewhere. While a real
  // initial walk is running it is already re-reading the rows this would pick,
  // and competing for the tick's budget would slow the pass that finishes for
  // the benefit of the one that never does.
  //
  // "ACTUALLY GETTING SOMEWHERE" IS THE WHOLE OF IT, and the first version of
  // this check left it out. It deferred on `cursor` alone, which read as
  // ordinary politeness and was a permanent shutdown: measured 2026-09-16,
  // work_orders_live has held cursor "2026-08-31T18:00:05.998Z|..." with
  // last_success_at NULL and last_status ERROR since the mirror went live,
  // failing the same attachments 21000 every five minutes and keeping its
  // cursor each time. A pass that has never once succeeded would have held
  // this one down forever, silently, and the only symptom would have been a
  // table that never filled.
  //
  // (The same condition in mx-reconcile.ts is doing exactly that to the daily
  // reconciliation right now. That one is not ours to fix here, but it is the
  // same trap and it is worth knowing the shape of it.)
  //
  // So: defer only to a mid-walk pass that is not currently failing. A pass in
  // ERROR is not making progress and must not be able to disable a different
  // pass as a side effect of its own breakage.
  const live = await getMxSyncState(env, MX_PASS_LIVE);
  if (live.ok && live.state?.cursor && live.state.last_status !== "ERROR") {
    return stoodDown(env, empty, startedAt, "live pass is mid-walk");
  }

  const candidates = await selectCandidates(env, WORK_ORDERS_PER_PASS);
  if (!candidates.ok) {
    await recordPass(env, { ...empty, skipped: candidates.error }, startedAt, candidates.error);
    return { ...empty, skipped: `candidate select failed: ${candidates.error}` };
  }

  const result: TimeSweepResult = { ...empty, selected: candidates.rows.length };

  for (const row of candidates.rows) {
    if (Date.now() - startedAt > BUDGET_MS) {
      result.budgetHit = true;
      break;
    }

    // Its own controller per work order, so one slow response cannot consume
    // the whole pass's budget while still letting the pass-level check above
    // stop the loop.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const outcome = await processWorkOrder(env, row.id, controller.signal);
      if (outcome.ok) result.refetched += 1;
      else {
        result.failed += 1;
        console.error(`[mx-timesweep] ${row.id}: ${outcome.error}`);
      }
    } catch (err) {
      result.failed += 1;
      console.error(`[mx-timesweep] ${row.id} threw:`, err);
    } finally {
      clearTimeout(timer);
    }
  }

  await recordPass(env, result, startedAt, null);
  return result;
}

/**
 * Record a pass that declined to run, and return the result.
 *
 * EVERY exit path goes through recordPass, including the ones that do nothing.
 * The first version returned early on the stand-down branches without writing,
 * which meant a sweep that stood down forever left NO row in mx_sync_state at
 * all -- and "no row" is what a sweep that was never deployed looks like too.
 * The two were indistinguishable from the table, which is how the permanent
 * stand-down above nearly went unnoticed.
 *
 * A skip is not a failure, so last_status stays OK and last_error stays null;
 * the reason lives in stats.skipped, where a human reading the row can see
 * both that it ran and why it did nothing.
 */
function stoodDown(
  env: MxTimeSweepEnv,
  empty: TimeSweepResult,
  startedAt: number,
  reason: string
): Promise<TimeSweepResult> {
  const result = { ...empty, skipped: reason };
  return recordPass(env, result, startedAt, null).then(() => result);
}

/** Bookkeeping, so "is the sweep running, and is it getting anywhere" is
 *  answerable from the table rather than from log retention. Best-effort:
 *  a failed write here must not make a completed pass look like it failed. */
async function recordPass(
  env: MxTimeSweepEnv,
  result: TimeSweepResult,
  startedAt: number,
  error: string | null
): Promise<void> {
  const now = new Date(startedAt).toISOString();
  await writeMxSyncState(env, MX_PASS_TIMESWEEP, {
    last_run_at: now,
    last_success_at: error === null ? now : undefined,
    last_status: error === null ? "OK" : "ERROR",
    last_error: error,
    stats: {
      selected: result.selected,
      refetched: result.refetched,
      failed: result.failed,
      budget_hit: result.budgetHit,
      // Present and null on a normal pass, so a stand-down is a value change
      // rather than an absent key someone has to notice is missing.
      skipped: result.skipped,
      elapsed_ms: Date.now() - startedAt
    }
  }).catch(() => {
    // Telemetry about the sweep, not the sweep.
  });
}
