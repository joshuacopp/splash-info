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
