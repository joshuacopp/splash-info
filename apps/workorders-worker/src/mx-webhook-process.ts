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
  replaceMxWorkOrderExpenditures,
  replaceMxWorkOrderParts,
  replaceMxWorkOrderTimeItems,
  upsertMxWorkOrderComments,
  upsertMxWorkOrders,
  upsertMxWorkRequests,
  type MxWorkOrderCommentRow
} from "@splash/db-supabase";
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

/** Comment pages to walk for one work order. Comments arrive newest-first and
 *  a webhook fires per comment, so the first page is almost always enough; the
 *  cap exists so a pathological thread cannot run the budget out. */
const MAX_COMMENT_PAGES = 3;

export type ProcessOutcome =
  | { ok: true; detail: string }
  | { ok: false; error: string };

/* ============================================================
 * Delivery-log bookkeeping
 * ============================================================ */

/** Stamp the mx_webhook_event row terminal. Best-effort: losing the stamp
 *  means the cron drain reprocesses, which is harmless because every write
 *  here is an upsert. */
async function stampEvent(
  env: MxWebhookProcessEnv,
  eventRowId: string | null,
  outcome: ProcessOutcome
): Promise<void> {
  if (!eventRowId) return;
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
        body: JSON.stringify({
          processed_at: new Date().toISOString(),
          process_error: outcome.ok ? null : outcome.error.slice(0, 2000)
        })
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

async function processWorkOrder(
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
    return { ok: false, error: `fetch work order ${workOrderId}: ${fetched.error ?? fetched.status}` };
  }

  const locations = await fetchMxLocationMap(env);
  const syncedAt = new Date().toISOString();
  const mapped = mapWorkOrder(fetched.workOrder, locations.map, syncedAt);
  if (!mapped) return { ok: false, error: `work order ${workOrderId} did not map` };

  // See the header: categories has no single-entity expand, and an absent key
  // is left untouched by PostgREST. Sending `categories: []` would blank it.
  const { categories: _dropped, ...row } = mapped.row;

  const parentWrite = await upsertMxWorkOrders(env, [row as typeof mapped.row]);
  if (!parentWrite.ok) {
    return { ok: false, error: `upsert work order ${workOrderId}: ${parentWrite.error ?? "unknown"}` };
  }

  // Children only after the parent: every child table has an ON DELETE CASCADE
  // FK into mx_work_order, so a child written first is a 409.
  const children = await Promise.all([
    replaceMxWorkOrderParts(env, workOrderId, mapped.parts),
    replaceMxWorkOrderExpenditures(env, workOrderId, mapped.expenditures),
    replaceMxWorkOrderTimeItems(env, workOrderId, mapped.timeItems)
  ]);
  const failed = children.find((c) => !c.ok);
  if (failed) {
    return { ok: false, error: `child write for ${workOrderId}: ${failed.error ?? "unknown"}` };
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
      error: `soft delete ${workOrderId}: ${res.status} ${(await res.text()).slice(0, 300)}`
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
      error: `fetch work request ${workRequestId}: ${fetched.error ?? fetched.status}`
    };
  }

  const locations = await fetchMxLocationMap(env);
  const row = mapWorkRequest(fetched.workRequest, locations.map, new Date().toISOString());
  if (!row) return { ok: false, error: `work request ${workRequestId} did not map` };

  // No expand asymmetry on this resource -- the single and list endpoints
  // offer the same tokens -- so the full row is safe to write.
  const write = await upsertMxWorkRequests(env, [row]);
  if (!write.ok) {
    return { ok: false, error: `upsert work request ${workRequestId}: ${write.error ?? "unknown"}` };
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
      return { ok: false, error: `fetch comments ${workOrderId}: ${res.error ?? res.status}` };
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
    return { ok: false, error: `upsert comments ${workOrderId}: ${write.error ?? "unknown"}` };
  }
  return { ok: true, detail: `${rows.length} comment(s) on ${workOrderId} refreshed` };
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
  eventRowId: string | null
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROCESS_TIMEOUT_MS);

  let outcome: ProcessOutcome;
  try {
    if (!env.MAINTAINX_API_KEY) {
      // Deployment state, not a delivery problem -- but the row must still be
      // stamped so it is visible rather than silently pending forever.
      outcome = { ok: false, error: "MAINTAINX_API_KEY not bound" };
    } else if (delivery.entityId === null) {
      outcome = { ok: false, error: `${delivery.eventType} carried no entity id` };
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
      outcome = { ok: false, error: `unrouted event ${delivery.eventType}` };
    }
  } catch (err) {
    outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }

  if (outcome.ok) {
    console.log(`[mx-webhook] ${delivery.eventType}: ${outcome.detail}`);
  } else {
    console.error(`[mx-webhook] ${delivery.eventType} failed: ${outcome.error}`);
  }

  await stampEvent(env, eventRowId, outcome);
  await stampSubscription(env, delivery.eventType);
}
