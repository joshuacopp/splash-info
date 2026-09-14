// MaintainX webhook receiver.
//
// THE ONLY UNAUTHENTICATED ROUTE ON THIS WORKER. Everything else runs through
// authenticate() against Supabase Auth; MaintainX cannot hold a session, so the
// HMAC in ./mx-webhook-verify.ts is the entire gate. The path check in
// index.ts is exact equality, not a prefix, so this bypass cannot widen by
// accident.
//
// SHAPE OF A DELIVERY
//
//   MaintainX gives the endpoint 10 seconds and documents no retry schedule --
//   the help pages tell you to implement your own. Assume a delivery that is
//   not acked is gone forever. So: verify, write the row, return 202, and do
//   the re-fetch in ctx.waitUntil(). The ack does not wait on Postgres reads or
//   MaintainX round trips.
//
//   A Cloudflare Queue would be the textbook answer here and is deliberately
//   NOT used. It would add a binding, a consumer and a second deploy surface to
//   buy durability we already have: mx_webhook_event rows are written before
//   the ack, and mx_webhook_event_pending_idx (processed_at is null) is exactly
//   the backlog a drain would read. If waitUntil dies mid-flight the row stays
//   unprocessed and is recoverable; a queue would move that same recovery
//   somewhere more expensive. Revisit if delivery volume ever makes waitUntil
//   contention real.
//
// WHAT A WEBHOOK IS ALLOWED TO DO
//
//   It is a "re-fetch this id" signal and nothing else. No field from the
//   payload is ever written. Payloads are partial -- NEW_WORK_REQUEST is just
//   {workRequestId} -- and MaintainX omits null fields rather than sending
//   them, so "absent" and "cleared" are indistinguishable. Writing a payload
//   straight through would blank columns the poller had filled correctly.
//
// AT-LEAST-ONCE, UNORDERED
//
//   Deliveries can duplicate and can arrive out of order. The re-fetch design
//   makes that harmless: two deliveries for one id produce two identical reads
//   of current state. Nothing here may assume ordering.

import { verifyMaintainXWebhook, MX_SIGNATURE_HEADER } from "./mx-webhook-verify.js";

/** Exact path. index.ts matches on equality -- see the bypass note above. */
export const MX_WEBHOOK_PATH = "workorders/api/mx-webhook";

export interface MxWebhookEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  /** Subscription signing secret. `wrangler secret put MAINTAINX_WEBHOOK_SECRET`.
   *  Unbound means every delivery is refused -- verification returns
   *  `no_secret` rather than falling open. */
  MAINTAINX_WEBHOOK_SECRET?: string;
}

/** Body cap. MaintainX payloads are a handful of fields; anything larger is
 *  not a webhook and should not be hashed, parsed or stored. */
const MAX_BODY_BYTES = 128 * 1024;

/* ============================================================
 * Event -> entity routing
 * ============================================================ */

export type MxEntityKind = "WORK_ORDER" | "WORK_REQUEST" | "COMMENT" | "OTHER";

/**
 * Which entity an event is about, and which root-level id field carries it.
 *
 * Payloads carry `<entity>Id` at the root (plus `<entity>ExternalId`, `orgId`,
 * `occurredAt`). Embedded entity objects are thin subsets -- the embedded
 * newWorkOrder has 14 fields, no id and no status -- so the root id is the
 * only thing read here.
 *
 * Events not in this table are stored with kind OTHER and never processed:
 * subscribing to something new should be a deliberate code change, not a
 * silent no-op that looks like it worked.
 */
const EVENT_ROUTING: Record<string, { kind: MxEntityKind; idFields: string[] }> = {
  NEW_WORK_ORDER: { kind: "WORK_ORDER", idFields: ["workOrderId"] },
  WORK_ORDER_CHANGE: { kind: "WORK_ORDER", idFields: ["workOrderId"] },
  WORK_ORDER_STATUS_CHANGE: { kind: "WORK_ORDER", idFields: ["workOrderId"] },
  WORK_ORDER_DELETE: { kind: "WORK_ORDER", idFields: ["workOrderId"] },
  NEW_WORK_REQUEST: { kind: "WORK_REQUEST", idFields: ["workRequestId"] },
  WORK_REQUEST_STATUS_CHANGE: { kind: "WORK_REQUEST", idFields: ["workRequestId"] },
  // The comment payload identifies the work order it belongs to; comments are
  // fetched per work order (GET /workorders/{id}/comments), never per comment.
  NEW_COMMENT_ON_WORK_ORDER: {
    kind: "COMMENT",
    idFields: ["workOrderId", "commentWorkOrderId"]
  }
};

export interface ParsedDelivery {
  eventType: string;
  entityKind: MxEntityKind;
  entityId: number | null;
  occurredAt: string | null;
  payload: Record<string, unknown>;
}

function readNumber(bag: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = bag[key];
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === "string" && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  }
  return null;
}

/**
 * Pull the routing facts out of a verified payload.
 *
 * Returns null only when the body is not a JSON object or carries no event
 * type -- everything else is recorded, including unrecognised events, so an
 * unexpected subscription shows up in the table instead of vanishing.
 */
export function parseDelivery(rawBody: string): ParsedDelivery | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const bag = parsed as Record<string, unknown>;

  // MaintainX sends the event under `type`; `event` is accepted as a fallback
  // because the payload schema is documented less precisely than the
  // subscription schema.
  const eventType =
    (typeof bag.type === "string" && bag.type) ||
    (typeof bag.event === "string" && bag.event) ||
    "";
  if (!eventType) return null;

  const route = EVENT_ROUTING[eventType];
  const occurredAt = typeof bag.occurredAt === "string" ? bag.occurredAt : null;

  return {
    eventType,
    entityKind: route?.kind ?? "OTHER",
    entityId: route ? readNumber(bag, route.idFields) : null,
    occurredAt,
    payload: bag
  };
}

/* ============================================================
 * Delivery log (mx_webhook_event, created by
 * supabase/maintainx-ingest-01-tables.sql section 11)
 * ============================================================ */

/**
 * Record a verified delivery and return its row id.
 *
 * Only VERIFIED deliveries are persisted. The table has a signature_verified
 * column defaulting to false, and it is tempting to log rejects too -- but this
 * route is unauthenticated and reachable by anyone, so persisting unverified
 * bodies hands the internet an unbounded INSERT. Rejects go to Workers Logs
 * (observability is on for this worker) where they are rate-limited by the
 * platform and cost us no storage. The column stays as the schema defines it.
 */
async function recordDelivery(
  env: MxWebhookEnv,
  delivery: ParsedDelivery
): Promise<string | null> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/mx_webhook_event`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify([
      {
        event_type: delivery.eventType,
        entity_kind: delivery.entityKind,
        entity_id: delivery.entityId,
        occurred_at: delivery.occurredAt,
        signature_verified: true,
        payload: delivery.payload
      }
    ])
  });

  if (!res.ok) {
    console.error(
      `[mx-webhook] delivery log insert failed: ${res.status} ${(await res.text()).slice(0, 512)}`
    );
    return null;
  }
  const rows = (await res.json()) as Array<{ id?: string }>;
  return rows[0]?.id ?? null;
}

/* ============================================================
 * Route
 * ============================================================ */

export interface HandleWebhookDeps {
  /** Runs the re-fetch + upsert for one delivery. Injected so the route can be
   *  wired and proven with live deliveries before the write path exists, and
   *  so it is testable without Postgres. */
  process?: (delivery: ParsedDelivery, eventRowId: string | null) => Promise<void>;
}

/**
 * Handle one webhook delivery.
 *
 * Always returns fast. 401 on any verification failure with no detail in the
 * body: a prober that can tell "expired" from "mismatch" learns the shape of
 * the gate. The reason is logged, not returned.
 */
export async function handleMxWebhook(
  request: Request,
  env: MxWebhookEnv,
  ctx: ExecutionContext,
  deps: HandleWebhookDeps = {}
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    console.warn(`[mx-webhook] rejected oversize body: ${declared} bytes`);
    return new Response("payload too large", { status: 413 });
  }

  // RAW bytes, read exactly once, before any parsing. The signature covers
  // these bytes; a re-serialised body will not match. See mx-webhook-verify.ts.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (err) {
    console.error("[mx-webhook] could not read body:", err);
    return new Response("bad request", { status: 400 });
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    console.warn(`[mx-webhook] rejected oversize body after read: ${rawBody.length}`);
    return new Response("payload too large", { status: 413 });
  }

  const verified = await verifyMaintainXWebhook({
    signatureHeader: request.headers.get(MX_SIGNATURE_HEADER),
    rawBody,
    secret: env.MAINTAINX_WEBHOOK_SECRET
  });

  if (!verified.ok) {
    // Logged, never returned. `no_secret` is the one worth alerting on: it
    // means the worker is deployed without its secret and is refusing real
    // traffic, which looks identical to an attack from the outside.
    console.warn(`[mx-webhook] rejected: ${verified.reason}`);
    return new Response("unauthorized", { status: 401 });
  }

  const delivery = parseDelivery(rawBody);
  if (!delivery) {
    // Signed by MaintainX but not a shape we understand. Ack it -- retrying
    // would not make it parseable -- and log loudly.
    console.error(
      `[mx-webhook] verified but unparseable body: ${rawBody.slice(0, 512)}`
    );
    return new Response(null, { status: 202 });
  }

  const eventRowId = await recordDelivery(env, delivery);

  // Ack BEFORE the work. Ten seconds is the budget and a re-fetch plus upsert
  // can exceed it under load.
  if (deps.process) {
    ctx.waitUntil(
      deps.process(delivery, eventRowId).catch((err) => {
        // Swallowed on purpose: the row is already written with processed_at
        // null, so the pending index is the retry surface. Throwing here would
        // only produce an unhandled rejection after the response has gone.
        console.error(
          `[mx-webhook] processing failed for ${delivery.eventType} ${delivery.entityId}:`,
          err
        );
      })
    );
  }

  return new Response(null, { status: 202 });
}
