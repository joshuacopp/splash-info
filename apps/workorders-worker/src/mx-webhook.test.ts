// Payload parsing, tested against REAL MaintainX deliveries.
//
// Every fixture below is copied verbatim from mx_webhook_event after the first
// 128 live deliveries on 2026-09-14. They are not invented, and that matters:
// the first version of this parser was written from the documented shape and
// got two things wrong that only real traffic revealed.
//
//   1. The event field is `eventType`, not `type`. On a comment payload `type`
//      is the COMMENT's type ("TEXT"), so reading it produced a delivery
//      logged as event_type=TEXT that carried no entity id.
//
//   2. WORK_REQUEST_STATUS_CHANGE names the entity `requestId` while
//      NEW_WORK_REQUEST names it `workRequestId`. MaintainX is inconsistent
//      between its own two work-request events.
//
// If MaintainX changes a shape, these fail loudly rather than silently routing
// deliveries to OTHER.

import { describe, expect, it } from "vitest";
import { parseDelivery } from "./mx-webhook";

const REAL = {
  newWorkOrder:
    '{"eventType":"NEW_WORK_ORDER","occurredAt":"2026-09-14T13:03:18.971Z","orgId":152169,"workOrderId":118831473,"customerId":null,"userId":1441557}',
  workOrderStatusChange:
    '{"eventType":"WORK_ORDER_STATUS_CHANGE","occurredAt":"2026-09-14T13:03:19.905Z","orgId":152169,"workOrderId":118831473,"oldStatus":"OPEN","newStatus":"IN_PROGRESS","customerId":null,"userId":1441557}',
  newComment:
    '{"type":"TEXT","orgId":152169,"comment":"adding a test comment","eventType":"NEW_COMMENT_ON_WORK_ORDER","occurredAt":"2026-09-14T13:04:34.512Z","workOrderId":118477847}',
  newWorkRequest:
    '{"eventType":"NEW_WORK_REQUEST","occurredAt":"2026-09-14T13:02:00.000Z","orgId":152169,"workRequestId":13912546}',
  workRequestStatusChange:
    '{"newStatus":"APPROVED","oldStatus":"PENDING","occurredAt":"2026-09-14T13:03:19.905Z","orgId":152169,"requestId":13912546,"eventType":"WORK_REQUEST_STATUS_CHANGE"}'
};

describe("parseDelivery on real payloads", () => {
  it("routes NEW_WORK_ORDER", () => {
    expect(parseDelivery(REAL.newWorkOrder)).toMatchObject({
      eventType: "NEW_WORK_ORDER",
      entityKind: "WORK_ORDER",
      entityId: 118831473
    });
  });

  it("routes WORK_ORDER_STATUS_CHANGE", () => {
    expect(parseDelivery(REAL.workOrderStatusChange)).toMatchObject({
      eventType: "WORK_ORDER_STATUS_CHANGE",
      entityKind: "WORK_ORDER",
      entityId: 118831473
    });
  });

  it("routes NEW_WORK_REQUEST via workRequestId", () => {
    expect(parseDelivery(REAL.newWorkRequest)).toMatchObject({
      eventType: "NEW_WORK_REQUEST",
      entityKind: "WORK_REQUEST",
      entityId: 13912546
    });
  });

  it("routes WORK_REQUEST_STATUS_CHANGE via requestId, not workRequestId", () => {
    // The inconsistency that broke the first version.
    expect(parseDelivery(REAL.workRequestStatusChange)).toMatchObject({
      eventType: "WORK_REQUEST_STATUS_CHANGE",
      entityKind: "WORK_REQUEST",
      entityId: 13912546
    });
  });

  it("reads eventType on a comment, NOT its type field", () => {
    // The regression that produced event_type=TEXT in production.
    const parsed = parseDelivery(REAL.newComment);
    expect(parsed?.eventType).toBe("NEW_COMMENT_ON_WORK_ORDER");
    expect(parsed?.eventType).not.toBe("TEXT");
    expect(parsed).toMatchObject({ entityKind: "COMMENT", entityId: 118477847 });
  });

  it("carries occurredAt through", () => {
    expect(parseDelivery(REAL.newWorkOrder)?.occurredAt).toBe(
      "2026-09-14T13:03:18.971Z"
    );
  });

  it("keeps the whole payload for forensics", () => {
    expect(parseDelivery(REAL.newComment)?.payload).toMatchObject({
      comment: "adding a test comment",
      orgId: 152169
    });
  });
});

describe("parseDelivery edge cases", () => {
  it("records an unrouted event rather than dropping it", () => {
    // Subscribing to something new should surface in the table as OTHER, not
    // vanish -- that is how an unexpected subscription gets noticed.
    expect(parseDelivery('{"eventType":"NEW_PART","partId":5}')).toMatchObject({
      eventType: "NEW_PART",
      entityKind: "OTHER",
      entityId: null
    });
  });

  it("does not mistake a bare type field for an event", () => {
    // `type` only wins when its value is an event we route.
    expect(parseDelivery('{"type":"TEXT","comment":"hi"}')).toBeNull();
  });

  it("accepts type when it does name a routed event", () => {
    expect(parseDelivery('{"type":"NEW_WORK_ORDER","workOrderId":7}')).toMatchObject({
      eventType: "NEW_WORK_ORDER",
      entityId: 7
    });
  });

  it("reads a numeric id sent as a string", () => {
    // Not observed live -- every sample sent a number -- but cheap insurance:
    // a string id would otherwise route as "carried no entity id".
    const parsed = parseDelivery(
      '{"eventType":"NEW_WORK_ORDER","workOrderId":"118831473"}'
    );
    expect(parsed?.entityId).toBe(118831473);
  });

  it.each([
    ["not JSON", "not json at all"],
    ["an array", "[1,2,3]"],
    ["null", "null"],
    ["no event field", '{"workOrderId":1}']
  ])("returns null for %s", (_label, body) => {
    expect(parseDelivery(body)).toBeNull();
  });
});
