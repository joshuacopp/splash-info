// Money mapping, pinned to real MaintainX values.
//
// These numbers come from live payloads on 2026-09-14, not from the docs:
//
//   work order 118477847, part "Test part for cost"  unitCost    12300  = $123.00
//   work order 118477847, expenditure line           costPerUnit   350  = $3.50
//
// The original mapper multiplied any key not ending in `Cents` by 100, so
// $123.00 was stored as 1230000 and every cost in the corpus was 100x too
// large. The assertions below are the guard against that returning.

import { describe, expect, it } from "vitest";
import { mapWorkOrder } from "./mx-map";

const NO_LOCATIONS = new Map();
const SYNCED = "2026-09-14T13:20:22.635Z";

/** The real part line, verbatim from mx_work_order.raw. */
const REAL_PART = {
  id: 19251543,
  area: null,
  name: "Test part for cost",
  barcode: "1HU4XQ6YOA0MG",
  unitCost: 12300,
  locationId: 1787258,
  description: null,
  quantityUsed: 1,
  copyOnRecurring: "NoCopy",
  minimumQuantity: 1,
  availableQuantity: 0
};

function workOrder(extra: Record<string, unknown>) {
  return mapWorkOrder(
    { id: 118477847, status: "DONE", ...extra } as never,
    NO_LOCATIONS,
    SYNCED
  );
}

describe("part cost", () => {
  it("stores unitCost as sent -- 12300 cents is $123.00, not $12,300", () => {
    const mapped = workOrder({ parts: [REAL_PART] });
    expect(mapped?.parts[0]?.unit_cost_cents).toBe(12300);
    expect(mapped?.parts[0]?.unit_cost_cents).not.toBe(1230000);
  });

  it("rolls the line into part_cost_cents at quantity", () => {
    const mapped = workOrder({ parts: [{ ...REAL_PART, quantityUsed: 2 }] });
    expect(mapped?.row.part_cost_cents).toBe(24600);
  });

  it("honours an explicit unitCostCents key identically", () => {
    // Both spellings mean cents now, so they must agree.
    const mapped = workOrder({
      parts: [{ ...REAL_PART, unitCost: undefined, unitCostCents: 12300 }]
    });
    expect(mapped?.parts[0]?.unit_cost_cents).toBe(12300);
  });
});

describe("expenditure cost", () => {
  it("stores costPerUnit as sent -- 350 cents is $3.50", () => {
    const mapped = workOrder({
      expenditures: [{ costPerUnit: 350, rowTotal: 350, quantity: 1 }]
    });
    expect(mapped?.expenditures[0]?.cost_per_unit_cents).toBe(350);
    expect(mapped?.expenditures[0]?.row_total_cents).toBe(350);
    expect(mapped?.expenditures[0]?.cost_per_unit_cents).not.toBe(35000);
  });

  it("feeds expenditure_cents and total_cost_cents un-inflated", () => {
    const mapped = workOrder({
      parts: [REAL_PART],
      expenditures: [{ costPerUnit: 350, rowTotal: 350, quantity: 1 }]
    });
    expect(mapped?.row.expenditure_cents).toBe(350);
    // 12300 (part) + 350 (expenditure) = $126.50
    expect(mapped?.row.total_cost_cents).toBe(12650);
  });
});

describe("money edge cases", () => {
  it("treats a missing cost as zero rather than null", () => {
    const mapped = workOrder({ parts: [{ ...REAL_PART, unitCost: undefined }] });
    expect(mapped?.parts[0]?.unit_cost_cents).toBe(0);
  });

  it("rounds a fractional value instead of truncating it", () => {
    // A fraction would mean the cents assumption has broken again; rounding
    // keeps the error to a cent rather than a dollar.
    const mapped = workOrder({ parts: [{ ...REAL_PART, unitCost: 12300.6 }] });
    expect(mapped?.parts[0]?.unit_cost_cents).toBe(12301);
  });
});

describe("deleted_at is cleared on every successful map", () => {
  // Work order 118834534 was soft-deleted at 13:18 on 2026-09-14 while
  // testing the delete webhook, restored in MaintainX minutes later, and
  // re-synced every few minutes after that -- and stayed invisible to
  // operators for hours, because nothing but the delete paths ever wrote the
  // column. Reaching the mapper means a fetch SUCCEEDED, which is proof the
  // entity exists, so the map must contradict a stale delete.

  it("emits deleted_at: null", () => {
    const mapped = workOrder({});
    expect(mapped?.row.deleted_at).toBeNull();
  });

  it("emits the KEY, not merely a nullish value", () => {
    // PostgREST leaves an absent column untouched on upsert, so omitting the
    // key would leave a stale delete in place -- which is exactly the bug.
    // `toBeNull` alone passes against a mapper that drops the key entirely.
    const mapped = workOrder({});
    expect(Object.keys(mapped?.row ?? {})).toContain("deleted_at");
  });

  it("still omits the columns that are genuinely owned elsewhere", () => {
    // first_seen_at is a DB default that an upsert would reset; the two count
    // columns belong to the comment and attachment passes. Clearing
    // deleted_at must not be read as licence to emit those too.
    const keys = Object.keys(workOrder({})?.row ?? {});
    expect(keys).not.toContain("first_seen_at");
    expect(keys).not.toContain("comment_count");
    expect(keys).not.toContain("attachment_count");
  });
});

describe("attachment metadata", () => {
  // Shape copied from a live payload on work order 118918502, which carries
  // 25 of these. The url is ~2 KB of presigned S3 query string.
  const REAL_ATTACHMENT = {
    id: 272727625,
    url: "https://maintainx-uploads-production.s3.us-west-2.amazonaws.com/x_camera2.jpg?X-Amz-Expires=3600&X-Amz-Signature=abc",
    width: 960,
    height: 1280,
    fileName: "camera2.jpg",
    mimeType: "image/jpeg",
    createdAt: "2026-09-14T17:36:40.988Z"
  };

  it("maps the metadata fields", () => {
    const mapped = workOrder({ attachments: [REAL_ATTACHMENT] });
    expect(mapped?.attachments[0]).toMatchObject({
      id: 272727625,
      file_name: "camera2.jpg",
      mime_type: "image/jpeg",
      width: 960,
      height: 1280
    });
  });

  it("NEVER stores the url", () => {
    // The presigned link carries X-Amz-Expires=3600 and is dead an hour after
    // the sync that fetched it. Persisting it would create a column that looks
    // usable, works in every test, and fails in production an hour later.
    const mapped = workOrder({ attachments: [REAL_ATTACHMENT] });
    const keys = Object.keys(mapped?.attachments[0] ?? {});
    expect(keys).not.toContain("url");
    expect(JSON.stringify(mapped?.attachments)).not.toContain("X-Amz-Signature");
  });

  it("never emits the mirror columns, which the mirror pass owns", () => {
    // Emitting r2_key from a work-order sweep would blank a copy already made
    // and the mirror would re-download it on every sync, forever.
    const keys = Object.keys(workOrder({ attachments: [REAL_ATTACHMENT] })?.attachments[0] ?? {});
    for (const owned of ["r2_key", "r2_bytes", "mirrored_at", "mirror_error", "mirror_attempts"]) {
      expect(keys).not.toContain(owned);
    }
  });

  it("drops an attachment with no id and de-duplicates repeats", () => {
    const mapped = workOrder({
      attachments: [
        REAL_ATTACHMENT,
        { ...REAL_ATTACHMENT },
        { fileName: "no-id.jpg" }
      ]
    });
    expect(mapped?.attachments).toHaveLength(1);
  });

  it("returns [] when the payload has no attachments key at all", () => {
    // Indistinguishable from "has none" -- which is exactly why callers must
    // never treat [] as licence to prune existing rows.
    expect(workOrder({})?.attachments).toEqual([]);
  });
});
