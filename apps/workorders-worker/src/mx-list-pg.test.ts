// Tests for the Postgres-backed read source.
//
// The thing worth protecting here is the FILTER. This module is what decides
// which work orders an operator sees, and every predicate in the query is
// load-bearing in a way that fails silently if dropped:
//
//   status=in.(...)      without it, closed work floods the page
//   deleted_at=is.null   without it, deleted work orders come back from the
//                        dead -- the webhook soft-deletes by setting this
//                        column and does NOT change status
//   mx_location_id=in.() without it, every operator sees every site
//
// The last one is a permission boundary, so it is asserted explicitly rather
// than left implied by a row count.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWorkOrdersFromPg, fetchWorkRequestsFromPg, type PgListEnv } from "./mx-list-pg";

const ENV: PgListEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_KEY: "service-key"
};

let lastUrl = "";

/** Answer with `rows`, recording the URL that asked for them. */
function stub(rows: unknown[], init?: { status?: number; body?: string }) {
  lastUrl = "";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    lastUrl = String(input);
    if (init?.status && init.status >= 400) {
      return new Response(init.body ?? "err", { status: init.status });
    }
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });
}

/** n rows of minimally-valid raw payload. */
function rawRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ raw: { id: 1000 + i, title: `wo ${i}` } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWorkOrdersFromPg query", () => {
  it("filters to active statuses only", async () => {
    stub(rawRows(1));
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1187635] });
    expect(lastUrl).toContain("status=in.(OPEN,IN_PROGRESS,ON_HOLD)");
  });

  it("excludes soft-deleted rows", async () => {
    // The webhook records a delete by stamping deleted_at and leaves status
    // alone, so a row deleted while OPEN is still OPEN. Without this predicate
    // it reappears on the page.
    stub(rawRows(1));
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1187635] });
    expect(lastUrl).toContain("deleted_at=is.null");
  });

  it("scopes to the caller's locations -- the permission boundary", async () => {
    stub(rawRows(1));
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1187635, 1187688] });
    expect(lastUrl).toContain("mx_location_id=in.(1187635,1187688)");
  });

  it("never queries at all when the caller has no locations", async () => {
    // An empty list must mean "nothing", never "no filter". A bare
    // `in.()` would be a syntax error at best and an unscoped read at worst.
    stub(rawRows(5));
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [] });
    expect(res).toMatchObject({ ok: true, workOrders: [], truncated: false });
    expect(lastUrl).toBe("");
  });

  it("drops a non-numeric location id rather than interpolating it", async () => {
    stub(rawRows(1));
    await fetchWorkOrdersFromPg({
      env: ENV,
      maintainxLocationIds: [1187635, Number.NaN, 1187688]
    });
    expect(lastUrl).toContain("mx_location_id=in.(1187635,1187688)");
    expect(lastUrl).not.toContain("NaN");
  });

  it("orders newest-touched first so a truncated page keeps the useful rows", async () => {
    stub(rawRows(1));
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("order=mx_updated_at.desc");
  });
});

describe("fetchWorkOrdersFromPg truncation", () => {
  it("asks for one more row than the cap", async () => {
    stub(rawRows(1));
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1], maxWorkOrders: 200 });
    expect(lastUrl).toContain("limit=201");
  });

  it("reports truncated and trims to the cap when the extra row comes back", async () => {
    stub(rawRows(11));
    const res = await fetchWorkOrdersFromPg({
      env: ENV,
      maintainxLocationIds: [1],
      maxWorkOrders: 10
    });
    expect(res.truncated).toBe(true);
    expect(res.workOrders).toHaveLength(10);
  });

  it("is not truncated when the result exactly fills the cap", async () => {
    // The off-by-one that would show a truncation banner on a full-but-
    // complete page.
    stub(rawRows(10));
    const res = await fetchWorkOrdersFromPg({
      env: ENV,
      maintainxLocationIds: [1],
      maxWorkOrders: 10
    });
    expect(res.truncated).toBe(false);
    expect(res.workOrders).toHaveLength(10);
  });
});

describe("fetchWorkOrdersFromPg payloads", () => {
  it("returns the raw payload untouched, so the projection is unchanged", async () => {
    const raw = {
      id: 118831473,
      title: "Pump seal",
      status: "OPEN",
      location: { id: 1187635, name: "Oswego" },
      assignees: [{ id: 409112, type: "USER" }],
      categories: ["Unplanned Repair"]
    };
    stub([{ raw }]);
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1187635] });
    expect(res.workOrders[0]).toEqual(raw);
  });

  it.each([
    ["null", null],
    ["an array", [1, 2]],
    ["a string", "nope"]
  ])("drops a row whose raw is %s", async (_label, bad) => {
    stub([{ raw: bad }, { raw: { id: 7 } }]);
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.ok).toBe(true);
    expect(res.workOrders).toHaveLength(1);
    expect(res.workOrders[0]).toMatchObject({ id: 7 });
  });
});

describe("fetchWorkOrdersFromPg failures", () => {
  it("surfaces a non-2xx as not-ok with its status", async () => {
    stub([], { status: 500, body: "boom" });
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.workOrders).toEqual([]);
  });

  it("reports status 0 when the request never completes", async () => {
    // handleList maps 0 to a 504, matching the MaintainX client's convention.
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res).toMatchObject({ ok: false, status: 0 });
  });

  it("never returns rows alongside a failure", async () => {
    stub([], { status: 503 });
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.workOrders).toEqual([]);
    expect(res.truncated).toBe(false);
  });
});

describe("fetchWorkRequestsFromPg", () => {
  it("filters to the two statuses the Requests tab surfaces", async () => {
    stub(rawRows(1));
    await fetchWorkRequestsFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("request_status=in.(PENDING,REJECTED)");
  });

  it("scopes to the caller's locations", async () => {
    stub(rawRows(1));
    await fetchWorkRequestsFromPg({ env: ENV, maintainxLocationIds: [42] });
    expect(lastUrl).toContain("mx_location_id=in.(42)");
  });

  it("reads the work_request table, not work_order", async () => {
    stub(rawRows(1));
    await fetchWorkRequestsFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("/mx_work_request?");
  });

  it("returns nothing for a caller with no locations", async () => {
    stub(rawRows(3));
    const res = await fetchWorkRequestsFromPg({ env: ENV, maintainxLocationIds: [] });
    expect(res.workRequests).toEqual([]);
    expect(lastUrl).toBe("");
  });

  it("degrades to not-ok rather than throwing, so the WO tabs still render", async () => {
    stub([], { status: 500 });
    const res = await fetchWorkRequestsFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res).toMatchObject({ ok: false, workRequests: [] });
  });
});
