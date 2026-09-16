// Webhook processing: turn a "this id changed" signal into a re-fetch + upsert.
//
// Runs in ctx.waitUntil() after the 202 has already gone back to MaintainX, so
// nothing here is on the ack path and nothing here may throw into the response.
//
// THE ONE RULE: no field from the webhook payload is ever written. The payload
// supplies an id and nothing else. Everything stored comes from a fresh GET
// against MaintainX, mapped by the same mappers the cron ingest uses, so the
// webhook and the poller cannot disagree about shape.
//
// CATEGORIES ARE DELIBERATELY NOT WRITTEN HERE.
//
//   `GET /workorders/{id}` has no `categories` expand -- the LIST endpoint the
//   cron uses does. mapWorkOrder() reads an absent categories as `[]`, not as
//   "unknown", so upserting a mapped single-entity fetch would blank a
//   populated column on every webhook. The column is dropped from the payload
//   instead, and PostgREST then leaves it untouched: it builds its column list
//   from the keys present, so an absent key is never written.
//
//   That is the same mechanism behind 71ccb83 ("emit first_seen_at
//   unconditionally -- PGRST102 on mixed pages"), and that commit is also the
//   warning: rows in ONE batch must share a key set. A webhook upserts a single
//   row, so the hazard does not apply -- but do not extend this to batches
//   without re-reading that fix.
//
//   The 5-minute cron re-reads categories from the list endpoint, so the column
//   is stale for at most one tick. This is the clearest single argument for why
//   the polling pass stays.

import {
  SINGLE_WORK_ORDER_EXPAND,
  SINGLE_WORK_REQUEST_EXPAND,
  fetchMaintainXWorkOrder,
  fetchMaintainXWorkRequest,
  fetchWorkOrderComments
} from "@splash/maintainx";
import {
  fetchMxLocationMap,
  insertMxWorkOrderEvents,
  replaceMxWorkOrderExpenditures,
  replaceMxWorkOrderParts,
  replaceMxWorkOrderTimeItems,
  upsertMxWorkOrderAttachments,
  upsertMxWorkOrderComments,
  upsertMxWorkOrders,
  upsertMxWorkRequests,
  type MxWorkOrderCommentRow
} from "@splash/db-supabase";
import { deriveWorkOrderEvent } from "./mx-event-log.js";
import { mapComment, mapWorkOrder, mapWorkRequest } from "./mx-map.js";
import type { ParsedDelivery } from "./mx-webhook.js";

export interface MxWebhookProcessEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  MAINTAINX_API_KEY?: string;
  MAINTAINX_BASE_URL: string;
}

/** Per-delivery ceiling. Webhook processing is not the backfill -- if a single
 *  entity cannot be reconciled in this long, leaving the row unprocessed for
 *  the cron drain is the better outcome. */
const PROCESS_TIMEOUT_MS = 20_000;

/**
 * How many times a retryable failure is retried before the row is given up on
 * and stamped terminal.
 *
 * The drain runs every 5 minutes, so five attempts spans ~25 minutes. Past
 * that the failure is not transient and retrying forever would hide it: a row
 * that stops being pending is a row that shows up in the stamped-with-error
 * query someone actually reads. The incremental poller remains the backstop
 * for anything whose updatedAt moves.
 */
export const MAX_PROCESS_ATTEMPTS = 5;

/** Comment pages to walk for one work order. Comments arrive newest-first and
 *  a webhook fires per comment, so the first page is almost always enough; the
 *  cap exists so a pathological thread cannot run the budget out. */
const MAX_COMMENT_PAGES = 3;

export type ProcessOutcome =
  | { ok: true; detail: string }
  /**
   * `retryable` decides whether the delivery stays in the drain's work queue.
   *
   * TRUE means the input was fine and the world was not: MaintainX 5xx, a
   * network abort, a Supabase write that lost a race, a secret not yet bound.
   * Reading the same id again later can succeed, so the row stays pending.
   *
   * FALSE means re-reading changes nothing: a payload with no entity id, an
   * event we do not route, a record the mapper deterministically rejects. The
   * row is stamped terminal with its error so it is visible without clogging
   * the queue. Getting this wrong in the FALSE direction silently drops real
   * data; in the TRUE direction it burns attempts on something hopeless, which
   * MAX_PROCESS_ATTEMPTS then caps. The asymmetry is why the default for
   * anything unrecognised (the catch-all below) is TRUE.
   */
  | { ok: false; error: string; retryable: boolean };

/* ============================================================
 * Delivery-log bookkeeping
 * ============================================================ */

/**
 * Record the result of one processing attempt on the mx_webhook_event row.
 *
 * THIS FUNCTION DECIDES WHETHER A DELIVERY IS RETRIED. `processed_at` is the
 * queue predicate -- mx_webhook_event_pending_idx is `where processed_at is
 * null` -- so stamping it is the act of removing the row from the drain's work
 * queue. Three outcomes:
 *
 *   success            -> processed_at set, error cleared. Done.
 *   terminal failure   -> processed_at set, error recorded. Never retried,
 *                         because retrying cannot change the answer.
 *   retryable failure  -> processed_at LEFT NULL, attempts incremented, error
 *                         recorded. The drain picks it up again.
 *
 * Until 2026-09-14 this stamped processed_at unconditionally, which meant a
 * MaintainX 502 was recorded as "done, with an error" and the delivery was
 * lost -- the pending index could only ever catch rows whose waitUntil died
 * before reaching this function. Retryable failures now stay in the queue,
 * which is what makes the drain worth running.
 *
 * `attempt` is this attempt's number, 1-based: the inline waitUntil path is
 * always attempt 1, and the drain passes the row's stored attempts + 1. Once
 * it reaches MAX_PROCESS_ATTEMPTS a retryable failure is given up on and
 * stamped terminal, so a permanently broken row cannot occupy the queue
 * forever.
 *
 * Best-effort: if the PATCH itself fails the row simply stays pending and the
 * drain reprocesses it, which is harmless because every write is an upsert.
 */
async function stampEvent(
  env: MxWebhookProcessEnv,
  eventRowId: string | null,
  outcome: ProcessOutcome,
  attempt: number
): Promise<void> {
  if (!eventRowId) return;

  const exhausted = !outcome.ok && outcome.retryable && attempt >= MAX_PROCESS_ATTEMPTS;
  const keepPending = !outcome.ok && outcome.retryable && !exhausted;

  const patch: Record<string, unknown> = {
    attempts: attempt,
    process_error: outcome.ok
      ? null
      : (exhausted
          ? `gave up after ${attempt} attempt(s): ${outcome.error}`
          : outcome.error
        ).slice(0, 2000)
  };
  // Only stamped when the row is leaving the queue. Left absent -- not set to
  // null -- so a retry never clears a stamp written by a concurrent attempt.
  if (!keepPending) patch.processed_at = new Date().toISOString();

  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/mx_webhook_event?id=eq.${encodeURIComponent(eventRowId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify(patch)
      }
    );
    if (!res.ok) {
      console.error(`[mx-webhook] stamp failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  } catch (err) {
    console.error("[mx-webhook] stamp threw:", err);
  }
}

/** Record that this subscription is still delivering. The health signal:
 *  MaintainX silently deletes endpoints that keep failing, so a subscription
 *  gone quiet while the cron still finds changed rows has been dropped. */
async function stampSubscription(
  env: MxWebhookProcessEnv,
  eventType: string
): Promise<void> {
  try {
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/mx_webhook_subscription` +
        `?event_type=eq.${encodeURIComponent(eventType)}&archived_at=is.null`,
      {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ last_delivery_at: new Date().toISOString() })
      }
    );
  } catch (err) {
    // Never fatal: this is telemetry about the subscription, not the data.
    console.error("[mx-webhook] subscription stamp threw:", err);
  }
}

/* ============================================================
 * Entity handlers
 * ============================================================ */

/**
 * Re-read one work order from MaintainX and write it, children and all.
 *
 * EXPORTED for mx-timesweep.ts, which needs exactly this and must not be a
 * second implementation of it. The sweep's whole job is to refetch work orders
 * unconditionally; if it wrote its own fetch-map-upsert it would be a second
 * place for the categories trap (see the file header) and the child-ordering
 * rule to be got wrong, and the two would drift.
 */
export async function processWorkOrder(
  env: MxWebhookProcessEnv,
  workOrderId: number,
  signal: AbortSignal
): Promise<ProcessOutcome> {
  const fetched = await fetchMaintainXWorkOrder({
    id: workOrderId,
    apiKey: env.MAINTAINX_API_KEY!,
    baseUrl: env.MAINTAINX_BASE_URL,
    expand: SINGLE_WORK_ORDER_EXPAND,
    signal
  });

  if (!fetched.ok || !fetched.workOrder) {
    // 404 means it was deleted between the webhook firing and this read.
    // Treat it exactly like WORK_ORDER_DELETE rather than erroring: the
    // outcome we want -- the row marked gone -- is the same.
    if (fetched.status === 404) return softDeleteWorkOrder(env, workOrderId);
    return {
      ok: false,
      error: `fetch work order ${workOrderId}: ${fetched.error ?? fetched.status}`,
      retryable: true
    };
  }

  const locations = await fetchMxLocationMap(env);
  const syncedAt = new Date().toISOString();
  const mapped = mapWorkOrder(fetched.workOrder, locations.map, syncedAt);
  // Deterministic: the same payload maps the same way every time.
  if (!mapped) {
    return { ok: false, error: `work order ${workOrderId} did not map`, retryable: false };
  }

  // See the header: categories has no single-entity expand, and an absent key
  // is left untouched by PostgREST. Sending `categories: []` would blank it.
  const { categories: _dropped, ...row } = mapped.row;

  const parentWrite = await upsertMxWorkOrders(env, [row as typeof mapped.row]);
  if (!parentWrite.ok) {
    return {
      ok: false,
      error: `upsert work order ${workOrderId}: ${parentWrite.error ?? "unknown"}`,
      retryable: true
    };
  }

  // Children only after the parent: every child table has an ON DELETE CASCADE
  // FK into mx_work_order, so a child written first is a 409.
  const children = await Promise.all([
    replaceMxWorkOrderParts(env, workOrderId, mapped.parts),
    replaceMxWorkOrderExpenditures(env, workOrderId, mapped.expenditures),
    replaceMxWorkOrderTimeItems(env, workOrderId, mapped.timeItems),
    // Metadata only; the mirror pass copies the bytes later. Skipped entirely
    // when empty, because an empty list does NOT mean "no attachments" -- a
    // response whose expand omitted them looks identical, and writing on that
    // basis would be acting on absence of evidence.
    mapped.attachments.length > 0
      ? upsertMxWorkOrderAttachments(env, mapped.attachments)
      : Promise.resolve({ ok: true as const, written: 0, requests: 0, status: 200, error: null })
  ]);
  const failed = children.find((c) => !c.ok);
  if (failed) {
    return {
      ok: false,
      error: `child write for ${workOrderId}: ${failed.error ?? "unknown"}`,
      retryable: true
    };
  }

  return {
    ok: true,
    detail:
      `work order ${workOrderId} refreshed ` +
      `(parts ${mapped.parts.length}, expenditures ${mapped.expenditures.length}, ` +
      `time items ${mapped.timeItems.length}; categories left to the poller)`
  };
}

/**
 * Soft delete. `mx_work_order.deleted_at` already exists, so nothing is
 * removed: the row, its children and its `raw` payload stay readable, and the
 * serving layer filters on the column.
 *
 * A hard delete would cascade the children away and destroy the only local
 * record that the work order ever existed -- and MaintainX has no endpoint to
 * get a deleted work order back.
 */
async function softDeleteWorkOrder(
  env: MxWebhookProcessEnv,
  workOrderId: number
): Promise<ProcessOutcome> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/mx_work_order?id=eq.${workOrderId}`,
    {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      // synced_at moves too: the row WAS reconciled against MaintainX just now,
      // and leaving it stale would make the delete look like a missed sync.
      body: JSON.stringify({
        deleted_at: new Date().toISOString(),
        synced_at: new Date().toISOString()
      })
    }
  );
  if (!res.ok) {
    return {
      ok: false,
      error: `soft delete ${workOrderId}: ${res.status} ${(await res.text()).slice(0, 300)}`,
      retryable: true
    };
  }
  return { ok: true, detail: `work order ${workOrderId} soft-deleted` };
}

async function processWorkRequest(
  env: MxWebhookProcessEnv,
  workRequestId: number,
  signal: AbortSignal
): Promise<ProcessOutcome> {
  const fetched = await fetchMaintainXWorkRequest({
    id: workRequestId,
    apiKey: env.MAINTAINX_API_KEY!,
    baseUrl: env.MAINTAINX_BASE_URL,
    expand: SINGLE_WORK_REQUEST_EXPAND,
    signal
  });

  if (!fetched.ok || !fetched.workRequest) {
    return {
      ok: false,
      error: `fetch work request ${workRequestId}: ${fetched.error ?? fetched.status}`,
      retryable: true
    };
  }

  const locations = await fetchMxLocationMap(env);
  const row = mapWorkRequest(fetched.workRequest, locations.map, new Date().toISOString());
  if (!row) {
    return { ok: false, error: `work request ${workRequestId} did not map`, retryable: false };
  }

  // No expand asymmetry on this resource -- the single and list endpoints
  // offer the same tokens -- so the full row is safe to write.
  const write = await upsertMxWorkRequests(env, [row]);
  if (!write.ok) {
    return {
      ok: false,
      error: `upsert work request ${workRequestId}: ${write.error ?? "unknown"}`,
      retryable: true
    };
  }
  return { ok: true, detail: `work request ${workRequestId} refreshed` };
}

async function processComments(
  env: MxWebhookProcessEnv,
  workOrderId: number,
  signal: AbortSignal
): Promise<ProcessOutcome> {
  const rows: MxWorkOrderCommentRow[] = [];
  const syncedAt = new Date().toISOString();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
    const res: Awaited<ReturnType<typeof fetchWorkOrderComments>> =
      await fetchWorkOrderComments({
        workOrderId,
        apiKey: env.MAINTAINX_API_KEY!,
        baseUrl: env.MAINTAINX_BASE_URL,
        cursor,
        signal
      });
    if (!res.ok) {
      return {
        ok: false,
        error: `fetch comments ${workOrderId}: ${res.error ?? res.status}`,
        retryable: true
      };
    }
    for (const raw of res.comments) {
      const row = mapComment(raw, workOrderId, syncedAt);
      if (row) rows.push(row);
    }
    cursor = res.nextCursor;
    if (cursor === null) break;
  }

  if (rows.length === 0) return { ok: true, detail: `no comments on ${workOrderId}` };

  // The parent must exist -- mx_work_order_comment has an FK into it. A comment
  // on a work order we have never ingested is possible during backfill, so the
  // parent is refreshed first rather than assumed.
  const parent = await processWorkOrder(env, workOrderId, signal);
  if (!parent.ok) return parent;

  const write = await upsertMxWorkOrderComments(env, rows);
  if (!write.ok) {
    return {
      ok: false,
      error: `upsert comments ${workOrderId}: ${write.error ?? "unknown"}`,
      retryable: true
    };
  }
  return { ok: true, detail: `${rows.length} comment(s) on ${workOrderId} refreshed` };
}

/* ============================================================
 * Event log
 * ============================================================ */

/**
 * Fold this delivery into mx_work_order_event.
 *
 * Returns null on success AND on "nothing to observe" -- the two are the same
 * from the caller's point of view, and a work-request delivery having no
 * work-order event is the normal case, not a failure. Returns a retryable
 * ProcessOutcome only when the write itself failed.
 *
 * See the block comment at the call site for why a failure here is allowed to
 * fail the whole delivery.
 */
async function recordObservation(
  env: MxWebhookProcessEnv,
  delivery: ParsedDelivery,
  eventRowId: string | null
): Promise<ProcessOutcome | null> {
  const row = deriveWorkOrderEvent(delivery, eventRowId, new Date().toISOString());
  if (!row) return null;

  const written = await insertMxWorkOrderEvents(env, [row]);
  if (written.ok) return null;

  return {
    ok: false,
    error: `event log write for ${row.work_order_id}: ${written.error ?? "unknown"}`,
    // Always retryable. The realistic causes are a Supabase blip or the
    // migration in supabase/maintainx-event-log-01.sql not having been applied
    // yet, and both are states the world grows out of. The insert ignores
    // duplicates, so a retry after a partial success costs nothing.
    retryable: true
  };
}

/* ============================================================
 * Entry point
 * ============================================================ */

/**
 * Process one verified delivery. Never throws -- the caller is waitUntil, and
 * a rejection there is an unhandled rejection after the response has gone.
 * Failures are stamped onto the mx_webhook_event row, where the pending index
 * leaves them visible to a cron drain.
 */
export async function processMxWebhookDelivery(
  env: MxWebhookProcessEnv,
  delivery: ParsedDelivery,
  eventRowId: string | null,
  /** This attempt's 1-based number. The inline webhook path leaves it at 1;
   *  the cron drain passes the row's stored attempts + 1 so the ceiling in
   *  stampEvent counts across invocations rather than restarting each time. */
  attempt = 1
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROCESS_TIMEOUT_MS);

  let outcome: ProcessOutcome;
  try {
    // ---- OBSERVATION FIRST, REFETCH SECOND ------------------------------
    //
    // Deliberately ahead of everything below, including the API-key check.
    //
    // The refetch is recoverable: it is idempotent, the 5-minute incremental
    // sweep re-reads changed rows, and the daily reconcile re-walks the whole
    // active queue. Three independent mechanisms will fix a work order that
    // this delivery failed to refresh.
    //
    // The observation is not recoverable by ANY of them. MaintainX serves no
    // retroactive event history, and `oldStatus` exists nowhere but in this
    // payload -- a later refetch returns the status the work order is in now,
    // never the one it left. If this write is skipped, the transition is gone.
    //
    // So it runs first and, unlike the telemetry writes at the end of this
    // file, a failure here FAILS THE DELIVERY as retryable rather than being
    // logged and swallowed. That couples the mirror to the event log, which is
    // a real cost: a persistently broken event-log write would stall each
    // delivery for ~25 minutes of retries before stamping terminal. It is the
    // right way round anyway, because the mirror has three backstops and this
    // has none, and because a terminal stamp carrying the error is visible in
    // the process_error query while a swallowed log line is not.
    //
    // A failure short-circuits the chain below rather than returning early, so
    // the single stamp path at the bottom of this function stays single.
    const observation = await recordObservation(env, delivery, eventRowId);

    if (observation) {
      outcome = observation;
    } else if (!env.MAINTAINX_API_KEY) {
      // Deployment state, not a delivery problem -- but the row must still be
      // stamped so it is visible rather than silently pending forever.
      outcome = { ok: false, error: "MAINTAINX_API_KEY not bound", retryable: true };
    } else if (delivery.entityId === null) {
      outcome = {
        ok: false,
        error: `${delivery.eventType} carried no entity id`,
        retryable: false
      };
    } else if (delivery.eventType === "WORK_ORDER_DELETE") {
      outcome = await softDeleteWorkOrder(env, delivery.entityId);
    } else if (delivery.entityKind === "WORK_ORDER") {
      outcome = await processWorkOrder(env, delivery.entityId, controller.signal);
    } else if (delivery.entityKind === "WORK_REQUEST") {
      outcome = await processWorkRequest(env, delivery.entityId, controller.signal);
    } else if (delivery.entityKind === "COMMENT") {
      outcome = await processComments(env, delivery.entityId, controller.signal);
    } else {
      // OTHER: recorded, never processed. Subscribing to a new event should be
      // a code change, not a silent no-op that looks like it worked.
      outcome = { ok: false, error: `unrouted event ${delivery.eventType}`, retryable: false };
    }
  } catch (err) {
    // Unrecognised, so retryable -- see the note on ProcessOutcome. An abort
    // from PROCESS_TIMEOUT_MS lands here and is exactly the transient case.
    outcome = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      retryable: true
    };
  } finally {
    clearTimeout(timer);
  }

  if (outcome.ok) {
    console.log(`[mx-webhook] ${delivery.eventType}: ${outcome.detail}`);
  } else {
    const fate = !outcome.retryable
      ? "terminal"
      : attempt >= MAX_PROCESS_ATTEMPTS
        ? `giving up after ${attempt}`
        : `will retry (attempt ${attempt}/${MAX_PROCESS_ATTEMPTS})`;
    console.error(`[mx-webhook] ${delivery.eventType} failed [${fate}]: ${outcome.error}`);
  }

  await stampEvent(env, eventRowId, outcome, attempt);
  await stampSubscription(env, delivery.eventType);
}
