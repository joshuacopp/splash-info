// The work-order event log: fold each verified delivery into an observation
// that survives the work order changing again.
//
// WHY THIS IS NOT REDUNDANT WITH THE MIRROR
//
//   mx_work_order holds current state. It answers "what is this work order
//   now" and is rebuildable at any time by re-fetching. It cannot answer "when
//   did this work order enter IN_PROGRESS, for how long, and who moved it" --
//   the moment a second transition lands, the first is overwritten and gone.
//
//   MaintainX exposes NO retroactive event history. There is no endpoint that
//   hands back yesterday's transitions. So an observation not written when it
//   is observed is not merely stale, it is unrecoverable at any price, which
//   is a different kind of loss from everything else this worker handles and
//   is why the rules below are stricter than they look worth being.
//
//   apps/maintenance-tracker/PLAN.md needs exactly these intervals for its
//   Layer C (was the mechanic's punch backed by work actually in progress),
//   and names this the highest-value task in the plan per hour spent.
//
// THE PAYLOAD IS READ HERE, AND ONLY HERE
//
//   mx-webhook.ts states the rule the rest of this worker lives by: a webhook
//   is a "re-fetch this id" signal and no field from the payload is ever
//   written. That rule protects the MIRROR, where a partial payload would
//   blank a column the poller had filled correctly.
//
//   This module is the deliberate exception, and it is safe for the reason the
//   rule exists: nothing here writes mirror state. oldStatus/newStatus/userId
//   describe an EVENT -- a thing that happened once, at a stated time, to
//   which "absent means cleared" does not apply. They are also not obtainable
//   any other way: a re-fetch returns the work order's status now, never the
//   status it moved out of. Reading them here is the only way the observation
//   exists at all.
//
//   Do not let that exception travel. Anything in this file that starts
//   writing to mx_work_order has crossed back into the rule.

import type { MxWorkOrderEventRow } from "@splash/db-supabase";
import type { ParsedDelivery } from "./mx-webhook.js";

/**
 * MaintainX event type -> our taxonomy.
 *
 * The taxonomy is the column comment in maintainx-ingest-01-tables.sql
 * section 9, with one addition. WORK_ORDER_CHANGE is a bare "something
 * changed" ping on most deliveries and carries an assignee diff on some; only
 * the diff form can be classified, so the bare form is recorded as 'CHANGE'
 * rather than guessed at. COST_CHANGE, which the original comment anticipated,
 * is NOT emitted by anything: MaintainX documents a costs block on
 * WORK_ORDER_CHANGE and does not send it to this org (PLAN.md §5, measured
 * across 1,338 deliveries). Naming a cost change we cannot see would be an
 * invention.
 */
const EVENT_TYPE: Record<string, string> = {
  NEW_WORK_ORDER: "CREATED",
  WORK_ORDER_STATUS_CHANGE: "STATUS_CHANGE",
  WORK_ORDER_DELETE: "DELETED",
  NEW_COMMENT_ON_WORK_ORDER: "COMMENT"
  // WORK_ORDER_CHANGE is resolved below -- it depends on the payload.
};

/** Assignee-diff keys. Their presence is what separates an ASSIGNEE_CHANGE
 *  from a bare CHANGE, so this list is the classifier and not decoration. */
const DIFF_KEYS = [
  "addedAssigneeIds",
  "removedAssigneeIds",
  "addedTeamIds",
  "removedTeamIds"
] as const;

function pick(
  payload: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = payload[k];
    // undefined AND null are both dropped: MaintainX omits null fields rather
    // than sending them, so an explicit null carries no more information than
    // an absence and storing it would imply it did.
    if (v !== undefined && v !== null) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** `{oldStatus, oldSubStatus}` -> `{status, subStatus}`. Side-neutral keys, so
 *  old_value and new_value read identically and a query cannot ask the wrong
 *  side of the pair and silently get null. */
function renameStatus(
  picked: Record<string, unknown> | null,
  side: "old" | "new"
): Record<string, unknown> | null {
  if (!picked) return null;
  const out: Record<string, unknown> = {};
  const status = picked[`${side}Status`];
  const subStatus = picked[`${side}SubStatus`];
  if (status !== undefined) out.status = status;
  if (subStatus !== undefined) out.subStatus = subStatus;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Build the observation for one delivery, or null when there is nothing to
 * observe.
 *
 * Null means "correctly nothing", not "failed": work-request events (this
 * table is work-order-scoped and work_order_id is NOT NULL), unrouted event
 * types, and deliveries with no entity id all land here legitimately. Callers
 * must not treat null as an error -- doing so would put every work-request
 * delivery into a retry loop.
 *
 * Pure. No I/O, no clock beyond the caller's `observedAt`, so the mapping is
 * testable without a network or a database.
 */
export function deriveWorkOrderEvent(
  delivery: ParsedDelivery,
  webhookEventId: string | null,
  observedAt: string
): MxWorkOrderEventRow | null {
  const payload = delivery.payload;

  // The EVENT TYPE decides scope, not entityKind. That is not a stylistic
  // choice: parseDelivery classifies NEW_COMMENT_ON_WORK_ORDER as
  // entityKind "COMMENT" -- correctly, since the comment is what is new --
  // while its entityId is the WORK ORDER the comment is on. Gating on
  // `entityKind === "WORK_ORDER"` reads as obviously right and silently drops
  // every comment event, which is 105 of the first 1,408 deliveries.
  //
  // EVENT_TYPE's keys are exactly the work-order-scoped events, so an
  // unmapped type is both "not ours" and "not classifiable" in one check.
  let eventType = EVENT_TYPE[delivery.eventType];
  if (!eventType && delivery.eventType === "WORK_ORDER_CHANGE") {
    eventType = DIFF_KEYS.some((k) => k in payload) ? "ASSIGNEE_CHANGE" : "CHANGE";
  }
  // An event we do not classify is not written. Subscribing to a new event
  // should be a code change here, not a row that silently means nothing.
  if (!eventType) return null;

  // Belt and braces. Nothing should reach here with a work-request kind -- the
  // event-type check above already excludes both work-request events -- but
  // work_order_id is NOT NULL and writing a request id into it would corrupt
  // the log with rows that join to the wrong entity.
  if (delivery.entityKind === "WORK_REQUEST") return null;
  if (delivery.entityId === null) return null;

  let oldValue: unknown = null;
  let newValue: unknown = null;

  if (eventType === "STATUS_CHANGE") {
    // Renamed on the way in: `oldStatus` -> `{status}`. The side is already
    // carried by the column it lands in, so keeping it in the key as well
    // would mean every reader writes `old_value ->> 'oldStatus'` and one of
    // them eventually writes `old_value ->> 'newStatus'` and gets null.
    //
    // subStatus rides along on some transitions (ON_HOLD reasons) and is
    // absent on most. Kept because it is the only place a hold's reason is
    // recorded, and that is what separates "waiting on a part" from
    // "abandoned".
    oldValue = renameStatus(pick(payload, ["oldStatus", "oldSubStatus"]), "old");
    newValue = renameStatus(pick(payload, ["newStatus", "newSubStatus"]), "new");
  } else if (eventType === "ASSIGNEE_CHANGE") {
    oldValue = pick(payload, ["removedAssigneeIds", "removedTeamIds"]);
    newValue = pick(payload, ["addedAssigneeIds", "addedTeamIds"]);
  } else if (eventType === "COMMENT") {
    // Metadata only. The comment BODY is already mirrored in
    // mx_work_order_comment; copying employee-authored text into a second,
    // append-only table that nothing prunes spreads the content further and
    // buys nothing.
    //
    // Renamed `type` -> `commentType` for the same reason the status keys are
    // renamed, and for one more: `type` is overloaded on this payload.
    // mx-webhook.ts records that reading it as the EVENT type produced rows
    // logged as event_type=TEXT before anyone measured it.
    //
    // MUST MATCH the backfill in supabase/maintainx-event-log-01.sql. The two
    // write the same column from the same payload at different times; if they
    // disagree on a key name, the column silently means one thing before the
    // ship date and another after, and every query gets half an answer.
    const type = payload.type;
    newValue = type === undefined || type === null ? null : { commentType: type };
  }

  const actor = payload.userId;

  return {
    work_order_id: delivery.entityId,
    event_type: eventType,
    source: "WEBHOOK",
    occurred_at: delivery.occurredAt,
    observed_at: observedAt,
    old_value: oldValue,
    new_value: newValue,
    actor_user_id: typeof actor === "number" && Number.isFinite(actor) ? actor : null,
    webhook_event_id: webhookEventId
  };
}
