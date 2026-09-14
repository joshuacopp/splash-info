// Cron drain for webhook deliveries that the inline path did not finish.
//
// WHY THIS EXISTS
//
//   mx-webhook.ts acks a delivery in 202 and does the real work in
//   ctx.waitUntil(). That is the right shape -- MaintainX gives the endpoint
//   ten seconds and documents no retry schedule, so an unacked delivery is
//   gone forever -- but it means the work happens after the response, outside
//   anything that can report a failure to the sender. Two ways it is lost:
//
//     1. waitUntil never completes. The isolate is evicted, the invocation is
//        killed, the process dies mid-flight. Nothing stamps the row.
//     2. The work runs and fails transiently -- MaintainX 502, a timeout, a
//        Supabase blip. Retrying the same id later would succeed.
//
//   Both leave an mx_webhook_event row with processed_at null, which is
//   precisely mx_webhook_event_pending_idx. This module is what reads it.
//
//   Until 2026-09-14 case (2) did NOT land in that index: stampEvent wrote
//   processed_at on every outcome including failures, so a transient error was
//   recorded as "done, with an error" and the delivery was silently dropped.
//   The index existed and was almost always empty, which looked like health
//   and was actually the bug. That is fixed in mx-webhook-process.ts; this
//   module is the half that consumes the result.
//
// WHY A RE-FETCH MAKES THIS SAFE
//
//   A webhook is a "re-fetch this id" signal and never a data source, so
//   reprocessing is not a compensating action that has to be got right -- it
//   is the same read performed again. Draining a row the inline path is
//   concurrently working on produces two identical reads of current state.
//   That is wasteful, not wrong, and DRAIN_GRACE_MS makes it rare.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
//   No locking. Two overlapping drains would both claim the same rows, and
//   with 5-minute ticks and a budget well under that, overlap needs an
//   invocation to hang for minutes. The cost if it happens is a duplicate
//   re-fetch; the cost of a claim column is a second write per row on every
//   pass plus stale-lock recovery. Revisit if ticks start overlapping.

import {
  MAX_PROCESS_ATTEMPTS,
  processMxWebhookDelivery,
  type MxWebhookProcessEnv
} from "./mx-webhook-process.js";
import type { MxEntityKind, ParsedDelivery } from "./mx-webhook.js";

/**
 * How long a row is left alone before the drain will touch it.
 *
 * A row is written BEFORE the ack, so one that is seconds old almost
 * certainly has a healthy waitUntil still working on it. Draining it would
 * duplicate that work. Two minutes comfortably exceeds PROCESS_TIMEOUT_MS
 * (20s) plus the ack, so anything older has genuinely been abandoned or has
 * already recorded a failed attempt.
 */
const DRAIN_GRACE_MS = 2 * 60 * 1000;

/**
 * Wall-clock ceiling for one drain pass.
 *
 * The drain shares its 5-minute tick with runMxIngest, which has its own
 * budget. Taking 60s of that leaves the ingest the bulk of the window. A
 * backlog larger than one pass simply finishes on the next tick -- rows stay
 * pending, ordered oldest-first, so progress is monotonic.
 */
const DRAIN_BUDGET_MS = 60_000;

/** Rows read per pass. A bound on the query, not on the work: the time budget
 *  is what actually stops the loop. Sized so the fetch itself is one small
 *  round trip even when the backlog is large. */
const DRAIN_BATCH = 25;

export interface DrainResult {
  /** Rows read from the pending index. */
  claimed: number;
  /** Attempts that completed, whatever the outcome. Compare against `claimed`
   *  to see whether the budget cut the pass short. */
  processed: number;
  /** Rows skipped because the row itself is unusable -- see the guard below. */
  skipped: number;
  /** True when the time budget ended the pass with rows still pending. */
  budgetExhausted: boolean;
}

/** The subset of mx_webhook_event the drain needs to rebuild a delivery. */
interface PendingRow {
  id: string;
  event_type: string;
  entity_kind: string | null;
  entity_id: number | string | null;
  occurred_at: string | null;
  payload: unknown;
  attempts: number | null;
}

const ENTITY_KINDS: readonly string[] = ["WORK_ORDER", "WORK_REQUEST", "COMMENT", "OTHER"];

function toEntityKind(raw: string | null): MxEntityKind {
  return ENTITY_KINDS.includes(raw ?? "") ? (raw as MxEntityKind) : "OTHER";
}

/**
 * Read the oldest pending deliveries.
 *
 * Oldest-first is deliberate. Deliveries are unordered by nature so this is
 * not about applying them in sequence -- it is about starvation: newest-first
 * under a sustained backlog would leave the oldest rows permanently unread.
 *
 * `attempts=lt.MAX` keeps rows the ceiling has already given up on out of the
 * result. Those are stamped terminal by stampEvent anyway, so this is
 * belt-and-braces against a row whose stamp failed to write.
 */
async function readPending(
  env: MxWebhookProcessEnv,
  olderThanIso: string
): Promise<PendingRow[] | null> {
  const url =
    `${env.SUPABASE_URL}/rest/v1/mx_webhook_event` +
    `?select=id,event_type,entity_kind,entity_id,occurred_at,payload,attempts` +
    `&processed_at=is.null` +
    `&received_at=lt.${encodeURIComponent(olderThanIso)}` +
    `&attempts=lt.${MAX_PROCESS_ATTEMPTS}` +
    `&order=received_at.asc` +
    `&limit=${DRAIN_BATCH}`;

  try {
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!res.ok) {
      console.error(
        `[mx-drain] read pending failed: ${res.status} ${(await res.text()).slice(0, 300)}`
      );
      return null;
    }
    return (await res.json()) as PendingRow[];
  } catch (err) {
    console.error("[mx-drain] read pending threw:", err);
    return null;
  }
}

/**
 * Run one drain pass.
 *
 * Never throws: the caller is a scheduled handler shared with the ingest pass,
 * and a throw out of it would fail the whole invocation and take the other job
 * down with it.
 */
export async function runMxWebhookDrain(env: MxWebhookProcessEnv): Promise<DrainResult> {
  const startedAt = Date.now();
  const result: DrainResult = {
    claimed: 0,
    processed: 0,
    skipped: 0,
    budgetExhausted: false
  };

  const rows = await readPending(env, new Date(startedAt - DRAIN_GRACE_MS).toISOString());
  if (rows === null) return result;
  result.claimed = rows.length;
  if (rows.length === 0) return result;

  for (const row of rows) {
    if (Date.now() - startedAt > DRAIN_BUDGET_MS) {
      // Stop cleanly rather than risk being killed mid-write. The remaining
      // rows keep processed_at null and lead the next pass.
      result.budgetExhausted = true;
      break;
    }

    // entity_id is the whole point of the row -- it is the id to re-fetch.
    // Without it there is nothing to do, and processMxWebhookDelivery would
    // correctly classify it non-retryable. Handled here so a malformed row
    // cannot consume a slot every pass forever.
    const entityId =
      row.entity_id === null || row.entity_id === undefined ? null : Number(row.entity_id);
    if (entityId !== null && !Number.isFinite(entityId)) {
      console.error(`[mx-drain] row ${row.id} has unusable entity_id ${row.entity_id}`);
      result.skipped += 1;
      continue;
    }

    const delivery: ParsedDelivery = {
      eventType: row.event_type,
      entityKind: toEntityKind(row.entity_kind),
      entityId,
      occurredAt: row.occurred_at,
      payload:
        row.payload && typeof row.payload === "object"
          ? (row.payload as Record<string, unknown>)
          : {}
    };

    // Continue this row's attempt count rather than restarting it, so the
    // ceiling spans invocations. processMxWebhookDelivery swallows its own
    // errors and stamps the row; nothing here needs a try/catch to stay alive,
    // but one delivery must never be able to end the pass for the rest.
    const attempt = (row.attempts ?? 0) + 1;
    try {
      await processMxWebhookDelivery(env, delivery, row.id, attempt);
    } catch (err) {
      console.error(`[mx-drain] row ${row.id} threw despite the guarantee:`, err);
    }
    result.processed += 1;
  }

  return result;
}
