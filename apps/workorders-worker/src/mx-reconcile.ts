// Daily reconciliation: make the local mirror converge on MaintainX's active
// set without anyone having to notice it has drifted.
//
// WHY THIS EXISTS
//
//   On 2026-09-14 the mirror was short 51 active work orders. Nothing was
//   broken at the time -- the bug that caused it (an empty 200 advancing the
//   incremental watermark across a window it had never read, fixed in 27d8083)
//   was already gone. But fixing the bug does not undo the damage, and that is
//   the point worth internalising:
//
//     The incremental sweep asks for work orders whose updatedAt is newer than
//     the watermark. A row skipped while the watermark ran ahead now has an
//     updatedAt PERMANENTLY behind it. The sweep will never ask for it again.
//     It is not stale, it is invisible, and nothing in the system would ever
//     have reported it.
//
//   Those 51 rows were found by hand, by walking MaintainX and diffing. The
//   fix was applied by hand too -- re-arming the live pass so it re-walked.
//   This module is that repair turned into something that happens on its own,
//   because the next hole will be found the same way if it is not.
//
// WHAT IT DOES, AND WHY IT IS THIS SMALL
//
//   Once a day it re-arms the unbounded live pass. That is all. The existing
//   dispatcher then re-walks every active work order over the following ticks
//   and upserts each one, which fills anything missing.
//
//   It is deliberately NOT a second walker. `runWorkOrderPass` is already
//   resumable, budget-bounded, cursor-checkpointed and proven; a reconciler
//   with its own walk would be a second implementation of the hard part, and
//   the hard part is what the 5-minute budget makes hard. Re-arming reuses all
//   of it and adds one write.
//
// WHAT IT DOES NOT DO
//
//   It heals rows MISSING locally. It does not remove rows that are active
//   locally but no longer active upstream. Three things already cover most of
//   that -- a status change moves updatedAt so the incremental sweep sees it, a
//   delete fires a webhook, and a 404 on re-fetch takes the soft-delete path --
//   but "most" is not "all", and the residue is a real gap: see the sweep note
//   at the bottom of this file.
//
//   Doing it here would need care rather than effort. A row absent from a walk
//   is not proof it is gone: MaintainX's LIST endpoint lags its own writes by
//   an hour or two (measured 2026-09-14 -- work orders created minutes earlier
//   are readable by id and absent from the list), so "not in the walk" and
//   "deleted" are indistinguishable without a per-id confirmation. A sweep
//   that assumed otherwise would delete live work.

import { getMxSyncState, writeMxSyncState } from "@splash/db-supabase";
import type { SupabaseEnv } from "@splash/db-supabase";
import { MX_PASS_LIVE } from "./mx-ingest.js";

/** Bookkeeping key. Not a member of MX_BACKFILL_PASSES -- the dispatcher
 *  treats those as passes that finish, and this one only ever schedules work
 *  for another pass to do. */
export const MX_PASS_RECONCILE = "work_orders_reconcile";

export interface ReconcileResult {
  /** True when the live pass was re-armed on this run. */
  rearmed: boolean;
  /** Why not, when it was not. Present for the log line, which is the only
   *  place anyone will look when the mirror drifts again. */
  skipped: string | null;
}

export interface MxReconcileEnv extends SupabaseEnv {}

/**
 * Re-arm the live walk, if it is safe to.
 *
 * `isComplete` in mx-ingest.ts is `cursor IS NULL AND last_success_at IS NOT
 * NULL`, so clearing last_success_at is what makes the dispatcher pick the
 * pass up again. Nothing else is touched -- in particular the cursor is left
 * alone, because clearing it mid-walk would restart a walk already in
 * progress rather than schedule a new one.
 *
 * Runs on the daily cron rather than the 5-minute one. The walk it schedules
 * costs ~41 pages spread over a handful of ticks; doing that hourly would be
 * pure waste, and doing it weekly would leave a hole sitting in front of
 * operators for days. Once a day means a gap is at most a day old, and the
 * webhooks plus the incremental sweep cover the interval.
 */
export async function runMxReconcile(env: MxReconcileEnv): Promise<ReconcileResult> {
  const live = await getMxSyncState(env, MX_PASS_LIVE);
  if (!live.ok) {
    return { rearmed: false, skipped: `could not read ${MX_PASS_LIVE}: ${live.error}` };
  }

  // Mid-walk: the pass is already doing exactly what re-arming would ask for.
  // Re-arming now would be a no-op at best; clearing state under a running
  // walk is the kind of thing that loses a cursor.
  if (live.state?.cursor) {
    return { rearmed: false, skipped: "live pass is mid-walk" };
  }

  // Never run: the backfill has not finished its first pass yet. Re-arming a
  // pass that has not completed once would be meaningless, and the initial
  // backfill is already reading everything.
  if (live.state !== null && live.state.last_success_at === null) {
    return { rearmed: false, skipped: "live pass has not completed once yet" };
  }
  if (live.state === null) {
    return { rearmed: false, skipped: "live pass has never run" };
  }

  const startedAt = new Date().toISOString();

  const rearm = await writeMxSyncState(env, MX_PASS_LIVE, {
    last_success_at: null,
    cursor: null
  });
  if (!rearm.ok) {
    return { rearmed: false, skipped: `re-arm write failed: ${rearm.error}` };
  }

  // Own bookkeeping row, so "when did reconciliation last run" is answerable
  // without inferring it from the live pass -- whose timestamps the walk
  // itself overwrites moments later.
  await writeMxSyncState(env, MX_PASS_RECONCILE, {
    last_run_at: startedAt,
    last_success_at: startedAt,
    last_status: "OK",
    last_error: null,
    stats: {
      rearmed_pass: MX_PASS_LIVE,
      previous_live_success_at: live.state.last_success_at
    }
  }).catch(() => {
    // Telemetry about the repair, not the repair. A failure here must not
    // make the caller think the re-arm did not happen -- it did.
  });

  return { rearmed: true, skipped: null };
}

// ---------------------------------------------------------------------------
// STILL MISSING: the other direction.
//
// Nothing here removes a row that is active locally and no longer active
// upstream. The shape of the fix, for whoever picks it up:
//
//   1. Record the reconcile start time before the walk is scheduled.
//   2. Let the walk run to completion across its ticks -- every row it sees is
//      upserted, and the upsert stamps `synced_at`.
//   3. Afterwards, `synced_at < started_at` on an active row means the walk did
//      not see it. That is the candidate set, and it needs no extra storage to
//      compute, which is the whole appeal.
//   4. Confirm each candidate with a single GET before touching it. This step
//      is not optional: absence from a list walk is not evidence of deletion
//      while the list endpoint lags its own writes, and a sweep that skipped
//      the confirmation would delete work orders created in the last hour.
//
// The reason it is not here is step 2: "afterwards" spans invocations, so the
// sweep needs its own resumable state machine rather than a flag. That is a
// brief of its own, and shipping the heal without it is worth more than
// shipping neither -- missing rows were the measured problem, and this is the
// direction that fixes them.
// ---------------------------------------------------------------------------
