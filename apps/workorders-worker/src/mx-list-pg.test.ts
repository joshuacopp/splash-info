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

/**
 * Answer with `rows`, recording the URL that asked for them.
 *
 * `total` models PostgREST's Content-Range: the count of ALL matching rows,
 * which is not the same as how many were sent. Pass it to reproduce the
 * db-max-rows ceiling -- 1000 rows returned out of 1046 matching.
 */
function stub(
  rows: unknown[],
  init?: { status?: number; body?: string; total?: number | null }
) {
  lastUrl = "";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    lastUrl = String(input);
    if (init?.status && init.status >= 400) {
      return new Response(init.body ?? "err", { status: init.status });
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const total = init && "total" in init ? init.total : rows.length;
    if (total !== null && total !== undefined) {
      headers["Content-Range"] = `0-${Math.max(rows.length - 1, 0)}/${total}`;
    }
    return new Response(JSON.stringify(rows), { status: 200, headers });
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
  it("asks PostgREST for an exact count", async () => {
    // Without this the truncation flag is a guess -- see the regression below.
    let sentPrefer: string | null = null;
    vi.stubGlobal("fetch", async (_i: RequestInfo | URL, init?: RequestInit) => {
      sentPrefer = new Headers(init?.headers).get("Prefer");
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json", "Content-Range": "*/0" }
      });
    });
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(sentPrefer).toContain("count=exact");
  });

  it("reports truncated from the COUNT, not the rows returned", async () => {
    // THE REGRESSION. PostgREST caps responses at db-max-rows (1000 here) on
    // top of our `limit`, so at a cap of 1000 the 1001st row -- the one the
    // old length check needed -- can never arrive. Measured against a real
    // operator: 1046 matching rows, 1000 sent, truncated reported false, and
    // the page silently dropped 46 rows with no banner.
    stub(rawRows(1000), { total: 1046 });
    const res = await fetchWorkOrdersFromPg({
      env: ENV,
      maintainxLocationIds: [1],
      maxWorkOrders: 1000
    });
    expect(res.truncated).toBe(true);
    expect(res.workOrders).toHaveLength(1000);
  });

  it("is not truncated when the count equals the cap exactly", async () => {
    stub(rawRows(1000), { total: 1000 });
    const res = await fetchWorkOrdersFromPg({
      env: ENV,
      maintainxLocationIds: [1],
      maxWorkOrders: 1000
    });
    expect(res.truncated).toBe(false);
  });

  it("falls back to row length when Content-Range is absent", async () => {
    // Still correct for any cap below db-max-rows, which is every cap the
    // caller actually passes except the 1000 case above.
    stub(rawRows(11), { total: null });
    const res = await fetchWorkOrdersFromPg({
      env: ENV,
      maintainxLocationIds: [1],
      maxWorkOrders: 10
    });
    expect(res.truncated).toBe(true);
  });

  it("pages at PostgREST's db-max-rows, not at a product cap", async () => {
    // The old code asked for cap+1 and treated the extra row as proof of more.
    // PostgREST refuses to send it, so that check could not fire at a cap of
    // 1000 -- which is exactly the bug ee618c4 fixed. Paging removes the cap
    // instead of detecting it.
    stub(rawRows(5));
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("limit=1000");
    expect(lastUrl).toContain("offset=0");
  });

  it("fetches a second page when the first comes back full", async () => {
    // A short page is the end signal; a full one is not.
    const pages = [rawRows(1000), rawRows(7)];
    let n = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      lastUrl = String(input);
      const body = pages[Math.min(n, pages.length - 1)]!;
      n += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Range": `0-${body.length - 1}/1007`
        }
      });
    });

    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.pageCount).toBe(2);
    expect(res.workOrders).toHaveLength(1007);
    expect(res.truncated).toBe(false);
    expect(lastUrl).toContain("offset=1000");
  });

  it("is NOT truncated once it has read everything", async () => {
    // 1,046 rows used to trip the banner because the cap was 1000. Now it just
    // reads them.
    stub(rawRows(500), { total: 500 });
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.truncated).toBe(false);
  });

  it("orders by a TOTAL sort so paging cannot repeat or skip a row", async () => {
    // mx_updated_at is not unique; without the id tiebreak two pages taken
    // under different orderings can return the same row twice and miss
    // another. Silent, and impossible to spot from the rendered page.
    stub(rawRows(1));
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("order=mx_updated_at.desc.nullslast,id.asc");
  });

  it("stops at the safety ceiling and reports truncation", async () => {
    stub(rawRows(50), { total: 10_000 });
    const res = await fetchWorkOrdersFromPg({
      env: ENV,
      maintainxLocationIds: [1],
      maxWorkOrders: 50
    });
    expect(res.truncated).toBe(true);
  });
});

describe("fetchWorkOrdersFromPg overdue-preventive filter", () => {
  it("excludes >90-day-overdue preventives IN SQL", async () => {
    // They were fetched and then discarded in JS: a 9-location operator pulled
    // 1,066 rows to display 173, and tripped a truncation banner on rows
    // nobody would ever see. 71% waste account-wide.
    stub(rawRows(1));
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("or=(type.is.null,type.neq.PREVENTIVE,due_date.is.null,due_date.gte.");
  });

  it("keeps null-typed work orders, which `neq` alone would drop", async () => {
    // PostgREST `neq` does not match NULLs, so without the explicit
    // `type.is.null` arm a null-typed work order vanishes from the page.
    stub(rawRows(1));
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("type.is.null");
  });

  it("keeps preventives that have no due date", async () => {
    // Matches bucketByType: only a PARSEABLE due date older than the cutoff
    // drops a preventive.
    stub(rawRows(1));
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("due_date.is.null");
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

describe("fetchWorkOrdersFromPg extras (comments + cost)", () => {
  /** A row shaped like the widened select returns, modelled on work order
   *  118834534 -- a real one carrying a part, an expenditure and a comment. */
  function rowWithExtras(over: Record<string, unknown> = {}) {
    return {
      raw: { id: 118834534, title: "test request - copp" },
      part_cost_cents: 12300,
      expenditure_cents: 123400,
      total_cost_cents: 135700,
      labor_seconds: 3600,
      mx_work_order_comment: [
        { id: 1, author_id: 443948, content: "adding a test comment", mx_created_at: "2026-09-14T13:04:34.512Z" }
      ],
      mx_work_order_part: [
        { name: "Test part for cost", quantity_used: 1, unit_cost_cents: 12300, line_total_cents: 12300 }
      ],
      mx_work_order_expenditure: [
        { description: "Other: Parts", type: "OTHER", quantity: 1, cost_per_unit_cents: 123400, row_total_cents: 123400 }
      ],
      ...over
    };
  }

  it("asks for comments, parts and expenditures in ONE query", async () => {
    // The point of reading from the mirror. On the MaintainX path comments are
    // a separate endpoint -- one call per work order -- so a 150-row page
    // could not show them at all.
    stub([]);
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("mx_work_order_comment(");
    expect(lastUrl).toContain("mx_work_order_part(");
    expect(lastUrl).toContain("mx_work_order_expenditure(");
  });

  it("caps comments per work order and takes the newest", async () => {
    // One work order carries 174 comments; an expanded row must not dump them.
    stub([]);
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("mx_work_order_comment.limit=20");
    expect(lastUrl).toContain("mx_work_order_comment.order=mx_created_at.desc");
  });

  it("keys extras by work order id", async () => {
    stub([rowWithExtras()]);
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.extrasById.get(118834534)).toBeDefined();
  });

  it("carries cost through as CENTS, unconverted", async () => {
    // 123400 is $1,234.00. Any division here would reintroduce the 100x class
    // of bug that had these columns wrong until 9a920d1 -- formatting belongs
    // at the render site.
    stub([rowWithExtras()]);
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.extrasById.get(118834534)).toMatchObject({
      partCostCents: 12300,
      expenditureCents: 123400,
      totalCostCents: 135700
    });
  });

  it("projects comment author id without resolving a name", async () => {
    // Name resolution belongs to the caller, against the shared users cache.
    stub([rowWithExtras()]);
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    const c = res.extrasById.get(118834534)!.comments[0]!;
    expect(c).toMatchObject({ authorId: 443948, content: "adding a test comment" });
  });

  it("drops empty and whitespace-only comments", async () => {
    // They render as an empty bubble attributed to someone, which reads as a
    // bug rather than as an empty comment.
    stub([rowWithExtras({
      mx_work_order_comment: [
        { id: 1, author_id: 1, content: "   ", mx_created_at: null },
        { id: 2, author_id: 1, content: "", mx_created_at: null },
        { id: 3, author_id: 1, content: "real", mx_created_at: null }
      ]
    })]);
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    const comments = res.extrasById.get(118834534)!.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.content).toBe("real");
  });

  it("flags truncation when the comment cap is hit exactly", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: i, author_id: 1, content: `c${i}`, mx_created_at: null
    }));
    stub([rowWithExtras({ mx_work_order_comment: many })]);
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.extrasById.get(118834534)!.commentsTruncated).toBe(true);
  });

  it("does not flag truncation below the cap", async () => {
    stub([rowWithExtras()]);
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.extrasById.get(118834534)!.commentsTruncated).toBe(false);
  });

  it("handles a work order with no extras at all", async () => {
    // The overwhelmingly common case: no comments, no cost. Embedded
    // resources come back absent, not as empty arrays.
    stub([{ raw: { id: 999 } }]);
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.extrasById.get(999)).toMatchObject({
      comments: [],
      parts: [],
      expenditures: [],
      totalCostCents: null
    });
  });
});

describe("fetchWorkOrdersFromPg attachments", () => {
  it("asks only for attachments that have bytes in R2", async () => {
    // An un-mirrored attachment has NO servable source -- its MaintainX URL is
    // presigned and expired within the hour -- so surfacing it renders a
    // broken image. The filter is the whole safety property.
    stub([]);
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("mx_work_order_attachment.r2_key=not.is.null");
  });

  it("orders the thumbnail first", async () => {
    stub([]);
    await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("mx_work_order_attachment.order=is_thumbnail.desc");
  });

  it("projects a mirrored attachment", async () => {
    stub([{
      raw: { id: 5 },
      mx_work_order_attachment: [
        { id: 272727625, file_name: "camera2.jpg", mime_type: "image/jpeg",
          width: 960, height: 1280, is_thumbnail: true, r2_key: "work-orders/5/272727625.jpg" }
      ]
    }]);
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.extrasById.get(5)?.attachments[0]).toMatchObject({
      id: 272727625,
      fileName: "camera2.jpg",
      mimeType: "image/jpeg",
      isThumbnail: true
    });
  });

  it("drops a row whose r2_key is null even if the query returned it", async () => {
    // Defence in depth: "servable" means "has bytes", and nothing else gets to
    // decide that. If the query filter is ever edited away, this still holds.
    stub([{
      raw: { id: 5 },
      mx_work_order_attachment: [
        { id: 1, file_name: "a.jpg", mime_type: "image/jpeg", width: null,
          height: null, is_thumbnail: false, r2_key: null },
        { id: 2, file_name: "b.jpg", mime_type: "image/jpeg", width: null,
          height: null, is_thumbnail: false, r2_key: "work-orders/5/2.jpg" }
      ]
    }]);
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    const atts = res.extrasById.get(5)!.attachments;
    expect(atts).toHaveLength(1);
    expect(atts[0]!.id).toBe(2);
  });

  it("never exposes the r2 key to the client", async () => {
    // The key is internal addressing. The client gets an id and asks the
    // permission-checked route; handing out keys would invite direct access.
    stub([{
      raw: { id: 5 },
      mx_work_order_attachment: [
        { id: 2, file_name: "b.jpg", mime_type: "image/jpeg", width: null,
          height: null, is_thumbnail: false, r2_key: "work-orders/5/2.jpg" }
      ]
    }]);
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(JSON.stringify(res.extrasById.get(5)?.attachments)).not.toContain("work-orders/");
  });

  it("yields an empty list when the work order has none", async () => {
    stub([{ raw: { id: 9 } }]);
    const res = await fetchWorkOrdersFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.extrasById.get(9)?.attachments).toEqual([]);
  });
});

describe("fetchWorkRequestsFromPg attachments", () => {
  it("embeds only attachments that have bytes in R2", async () => {
    stub([]);
    await fetchWorkRequestsFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("mx_work_order_attachment.r2_key=not.is.null");
  });

  it("orders the thumbnail first", async () => {
    stub([]);
    await fetchWorkRequestsFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(lastUrl).toContain("mx_work_order_attachment.order=is_thumbnail.desc");
  });

  it("keys photos by work-request id", async () => {
    stub([{
      raw: { id: 13921023, title: "Hydraulic line leaking in tunnel" },
      mx_work_order_attachment: [
        { id: 272725230, file_name: "photo.jpeg", mime_type: "image/jpeg",
          width: 960, height: 1280, is_thumbnail: true, r2_key: "work-requests/13921023/272725230.jpg" }
      ]
    }]);
    const res = await fetchWorkRequestsFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.attachmentsById.get(13921023)?.[0]).toMatchObject({
      id: 272725230,
      isThumbnail: true
    });
  });

  it("never exposes the r2 key", async () => {
    stub([{
      raw: { id: 7 },
      mx_work_order_attachment: [
        { id: 1, file_name: "a.jpg", mime_type: "image/jpeg", width: null,
          height: null, is_thumbnail: false, r2_key: "work-requests/7/1.jpg" }
      ]
    }]);
    const res = await fetchWorkRequestsFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(JSON.stringify([...res.attachmentsById.values()])).not.toContain("work-requests/");
  });

  it("omits requests with no mirrored photos from the map", async () => {
    // Absence keeps the map small and lets the caller default to [] without a
    // second "is it empty" check at every render site.
    stub([{ raw: { id: 9 } }]);
    const res = await fetchWorkRequestsFromPg({ env: ENV, maintainxLocationIds: [1] });
    expect(res.attachmentsById.has(9)).toBe(false);
  });

  it("returns an empty map for a caller with no locations", async () => {
    stub([]);
    const res = await fetchWorkRequestsFromPg({ env: ENV, maintainxLocationIds: [] });
    expect(res.attachmentsById.size).toBe(0);
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
