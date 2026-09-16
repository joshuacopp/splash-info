// Tests for the webhook -> event log mapping.
//
// Every fixture below is a REAL payload shape, taken from the 1,408 deliveries
// stored in mx_webhook_event on 2026-09-16 by grouping on the sorted key list.
// That matters more here than in most mappers: MaintainX is not consistent
// with itself (mx-webhook.ts documents the workRequestId/requestId trap), and
// a mapper tested against invented payloads tests the invention.
//
// The twenty distinct key sets observed collapse to the seven cases below;
// the variation the others add is workOrderExternalId and customerId being
// present or absent, neither of which this mapper reads.

import { describe, expect, it } from "vitest";
import { deriveWorkOrderEvent } from "./mx-event-log";
import type { ParsedDelivery } from "./mx-webhook";

const OBSERVED = "2026-09-16T20:00:00.000Z";
const ROW_ID = "11111111-2222-3333-4444-555555555555";

function delivery(payload: Record<string, unknown>): ParsedDelivery {
  const eventType = String(payload.eventType);
  const kind =
    eventType === "NEW_COMMENT_ON_WORK_ORDER"
      ? "COMMENT"
      : eventType.startsWith("WORK_REQUEST") || eventType === "NEW_WORK_REQUEST"
        ? "WORK_REQUEST"
        : "WORK_ORDER";
  return {
    eventType,
    entityKind: kind as ParsedDelivery["entityKind"],
    entityId:
      typeof payload.workOrderId === "number"
        ? payload.workOrderId
        : typeof payload.requestId === "number"
          ? payload.requestId
          : null,
    occurredAt: typeof payload.occurredAt === "string" ? payload.occurredAt : null,
    payload
  };
}

describe("deriveWorkOrderEvent", () => {
  it("maps a status change, renaming old/new to side-neutral keys", () => {
    const row = deriveWorkOrderEvent(
      delivery({
        orgId: 152169,
        userId: 1021391,
        eventType: "WORK_ORDER_STATUS_CHANGE",
        newStatus: "DONE",
        oldStatus: "OPEN",
        customerId: null,
        occurredAt: "2026-09-16T14:48:23.972Z",
        workOrderId: 118791160,
        workOrderExternalId: null
      }),
      ROW_ID,
      OBSERVED
    );

    expect(row).toEqual({
      work_order_id: 118791160,
      event_type: "STATUS_CHANGE",
      source: "WEBHOOK",
      occurred_at: "2026-09-16T14:48:23.972Z",
      observed_at: OBSERVED,
      old_value: { status: "OPEN" },
      new_value: { status: "DONE" },
      actor_user_id: 1021391,
      webhook_event_id: ROW_ID
    });
  });

  it("keeps subStatus when present on one side only", () => {
    const row = deriveWorkOrderEvent(
      delivery({
        eventType: "WORK_ORDER_STATUS_CHANGE",
        oldStatus: "ON_HOLD",
        oldSubStatus: "WAITING_ON_PARTS",
        newStatus: "IN_PROGRESS",
        userId: 452445,
        occurredAt: "2026-09-16T10:00:00.000Z",
        workOrderId: 42
      }),
      ROW_ID,
      OBSERVED
    );

    // The hold REASON is the point: it is what separates "waiting on a part"
    // from "abandoned", and it exists nowhere else -- a refetch returns the
    // status the work order is in now, never the sub-status it left.
    expect(row?.old_value).toEqual({ status: "ON_HOLD", subStatus: "WAITING_ON_PARTS" });
    expect(row?.new_value).toEqual({ status: "IN_PROGRESS" });
  });

  it("classifies WORK_ORDER_CHANGE by whether it carries a diff", () => {
    const withDiff = deriveWorkOrderEvent(
      delivery({
        orgId: 152169,
        userId: 1068175,
        eventType: "WORK_ORDER_CHANGE",
        customerId: null,
        occurredAt: "2026-09-15T12:16:37.287Z",
        workOrderId: 118955183,
        addedAssigneeIds: [452449],
        removedAssigneeIds: [],
        workOrderExternalId: null
      }),
      ROW_ID,
      OBSERVED
    );

    expect(withDiff?.event_type).toBe("ASSIGNEE_CHANGE");
    expect(withDiff?.new_value).toEqual({ addedAssigneeIds: [452449] });
    // An EMPTY removed list is still a fact the payload stated, distinct from
    // the key being absent, so it is kept rather than stripped as falsy.
    expect(withDiff?.old_value).toEqual({ removedAssigneeIds: [] });

    // The bare form -- 31 of the 56 stored WORK_ORDER_CHANGE deliveries. There
    // is no indication of what changed, so it is recorded as an unclassified
    // CHANGE rather than guessed at as COST_CHANGE.
    const bare = deriveWorkOrderEvent(
      delivery({
        orgId: 152169,
        userId: 1068175,
        eventType: "WORK_ORDER_CHANGE",
        customerId: null,
        occurredAt: "2026-09-15T12:16:37.287Z",
        workOrderId: 118955183,
        workOrderExternalId: null
      }),
      ROW_ID,
      OBSERVED
    );

    expect(bare?.event_type).toBe("CHANGE");
    expect(bare?.old_value).toBeNull();
    expect(bare?.new_value).toBeNull();
  });

  it("maps creation and deletion", () => {
    expect(
      deriveWorkOrderEvent(
        delivery({
          eventType: "NEW_WORK_ORDER",
          userId: 1021391,
          occurredAt: "2026-09-16T14:48:24.132Z",
          workOrderId: 119242752
        }),
        ROW_ID,
        OBSERVED
      )?.event_type
    ).toBe("CREATED");

    expect(
      deriveWorkOrderEvent(
        delivery({
          eventType: "WORK_ORDER_DELETE",
          userId: 1441557,
          occurredAt: "2026-09-14T20:45:39.512Z",
          workOrderId: 118952689
        }),
        ROW_ID,
        OBSERVED
      )?.event_type
    ).toBe("DELETED");
  });

  it("records a comment's type but never its body", () => {
    const body = "@[Batavia Vets Wash](u|465477) please provide a list";
    const row = deriveWorkOrderEvent(
      delivery({
        type: "TEXT",
        orgId: 152169,
        comment: body,
        eventType: "NEW_COMMENT_ON_WORK_ORDER",
        occurredAt: "2026-09-15T16:56:33.050Z",
        workOrderId: 119091053
      }),
      ROW_ID,
      OBSERVED
    );

    expect(row?.event_type).toBe("COMMENT");
    expect(row?.new_value).toEqual({ commentType: "TEXT" });
    // mx_work_order_comment already holds the text. Copying employee-authored
    // content into a second append-only table that nothing prunes spreads it
    // further and buys nothing.
    expect(JSON.stringify(row)).not.toContain(body);
  });

  it("returns null for work requests rather than failing", () => {
    // mx_work_order_event.work_order_id is NOT NULL and a work request is not
    // a work order. This must read as "correctly nothing" -- the caller turns
    // a non-null return into a retryable failure, so classifying these as an
    // error would put all 195 stored work-request deliveries into a retry loop
    // that can never succeed.
    expect(
      deriveWorkOrderEvent(
        delivery({
          orgId: 152169,
          eventType: "WORK_REQUEST_STATUS_CHANGE",
          newStatus: "APPROVED",
          oldStatus: "PENDING",
          requestId: 13879087,
          occurredAt: "2026-09-14T20:59:56.597Z"
        }),
        ROW_ID,
        OBSERVED
      )
    ).toBeNull();
  });

  it("returns null for an unclassified event type", () => {
    const d = delivery({ eventType: "SOMETHING_NEW", workOrderId: 7 });
    expect(deriveWorkOrderEvent(d, ROW_ID, OBSERVED)).toBeNull();
  });

  it("returns null when the delivery carries no entity id", () => {
    const d: ParsedDelivery = {
      eventType: "WORK_ORDER_STATUS_CHANGE",
      entityKind: "WORK_ORDER",
      entityId: null,
      occurredAt: null,
      payload: { eventType: "WORK_ORDER_STATUS_CHANGE" }
    };
    expect(deriveWorkOrderEvent(d, ROW_ID, OBSERVED)).toBeNull();
  });

  it("tolerates a missing actor", () => {
    // WORK_REQUEST payloads have no userId at all, and a handful of work-order
    // deliveries have arrived without one. A null actor is a worse row than a
    // populated one and an infinitely better row than no row.
    const row = deriveWorkOrderEvent(
      delivery({
        eventType: "WORK_ORDER_STATUS_CHANGE",
        oldStatus: "OPEN",
        newStatus: "DONE",
        occurredAt: "2026-09-16T10:00:00.000Z",
        workOrderId: 99
      }),
      null,
      OBSERVED
    );
    expect(row?.actor_user_id).toBeNull();
    expect(row?.webhook_event_id).toBeNull();
  });
});
