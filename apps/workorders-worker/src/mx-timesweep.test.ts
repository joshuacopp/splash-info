// Tests for the time-item sweep.
//
// These are almost entirely about the CANDIDATE QUERY, which is unusual for a
// sweep test and is the point. The sweep's behaviour once it has a list is
// trivial -- it calls processWorkOrder, which has its own tests. What is easy
// to get wrong, and what would fail silently if it were, is WHICH rows it
// asks for.
//
// The specific failure to guard against: someone reads this module, sees a
// sweep that refetches every row on every rotation, reasonably concludes it is
// wasteful, and adds `mx_updated_at=gte.<last run>` to make it incremental.
// That change looks like an optimisation, passes any test that only checks
// "rows were refetched", and silently disables the entire module -- MaintainX
// does not advance updatedAt for time or cost edits, so the rows carrying
// unsynced labor are exactly the rows such a filter excludes.
//
// So the assertions below pin the query string itself.

import { afterEach, describe, expect, it, vi } from "vitest";

const processWorkOrder = vi.fn();
vi.mock("./mx-webhook-process.js", () => ({
  processWorkOrder: (...args: unknown[]) => processWorkOrder(...args)
}));

const { MX_PASS_TIMESWEEP, runMxTimeSweep } = await import("./mx-timesweep");
type Env = Parameters<typeof runMxTimeSweep>[0];

const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_KEY: "service-key",
  MAINTAINX_BASE_URL: "https://api.getmaintainx.com/v1",
  MAINTAINX_API_KEY: "mx-key"
} as Env;

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

/** Answers the sync-state read, the candidate select, and the sync-state
 *  write. `syncState` is what the live-pass read returns. */
function stubFetch(opts: {
  candidates?: Array<{ id: number; synced_at: string | null }>;
  syncState?: unknown[];
  candidateStatus?: number;
}): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null
    });

    if (url.includes("/mx_sync_state")) {
      return new Response(JSON.stringify(opts.syncState ?? []), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.includes("/mx_work_order")) {
      const status = opts.candidateStatus ?? 200;
      return new Response(status === 200 ? JSON.stringify(opts.candidates ?? []) : "boom", {
        status,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("[]", { status: 200 });
  });
  return calls;
}

function candidateQuery(calls: Captured[]): URL {
  const hit = calls.find((c) => c.url.includes("/mx_work_order") && c.method === "GET");
  if (!hit) throw new Error("no candidate query was issued");
  return new URL(hit.url);
}

afterEach(() => {
  vi.unstubAllGlobals();
  processWorkOrder.mockReset();
});

describe("runMxTimeSweep candidate selection", () => {
  it("never filters on mx_updated_at", async () => {
    // THE LOAD-BEARING ASSERTION. Measured on work order 118834534: after a
    // timer run, a hand-added two-hour entry, an expense row and a backlog
    // flush, mx_updated_at had not moved. Any filter on that column excludes
    // precisely the rows this sweep exists to find.
    const calls = stubFetch({ candidates: [] });
    await runMxTimeSweep(ENV);
    const q = candidateQuery(calls);
    expect(q.search).not.toContain("updated_at");
    expect(q.search).not.toContain("synced_at=");
  });

  it("scopes to live or recently-completed reactive work orders", async () => {
    const calls = stubFetch({ candidates: [] });
    await runMxTimeSweep(ENV);
    const q = candidateQuery(calls);

    // PLAN.md §2.1: preventive work orders are assigned to sites and completed
    // by site staff. They are 88% of the table and a different population.
    expect(q.searchParams.get("type")).toBe("eq.REACTIVE");
    expect(q.searchParams.get("deleted_at")).toBe("is.null");

    const or = q.searchParams.get("or") ?? "";
    expect(or).toContain("status.eq.OPEN");
    expect(or).toContain("status.eq.IN_PROGRESS");
    expect(or).toContain("status.eq.ON_HOLD");
    // Recently-closed work orders stay candidates: labor is routinely added
    // after close-out, which is the same behaviour that makes the sweep
    // necessary at all.
    expect(or).toContain("completed_at.gte.");
  });

  it("rotates oldest-synced-first, so refetching is self-managing", async () => {
    const calls = stubFetch({ candidates: [] });
    await runMxTimeSweep(ENV);
    // processWorkOrder stamps synced_at, which sends the row to the back of
    // this ordering. That is the whole rotation mechanism -- there is no
    // cursor and no extra state, so this ordering IS the queue.
    expect(candidateQuery(calls).searchParams.get("order")).toBe("synced_at.asc.nullsfirst");
  });
});

describe("runMxTimeSweep behaviour", () => {
  it("refetches every candidate and counts outcomes", async () => {
    const calls = stubFetch({
      candidates: [
        { id: 1, synced_at: "2026-09-01T00:00:00Z" },
        { id: 2, synced_at: "2026-09-02T00:00:00Z" },
        { id: 3, synced_at: null }
      ]
    });
    processWorkOrder
      .mockResolvedValueOnce({ ok: true, detail: "ok" })
      .mockResolvedValueOnce({ ok: false, error: "mx 502", retryable: true })
      .mockResolvedValueOnce({ ok: true, detail: "ok" });

    const result = await runMxTimeSweep(ENV);

    expect(result).toMatchObject({ selected: 3, refetched: 2, failed: 1, skipped: null });
    expect(processWorkOrder).toHaveBeenCalledTimes(3);
    expect(processWorkOrder.mock.calls.map((c) => c[1])).toEqual([1, 2, 3]);

    // The pass records itself, so "has the sweep run" is answerable from the
    // table rather than from log retention.
    const state = calls.find((c) => c.url.includes("/mx_sync_state") && c.method === "POST");
    expect(state).toBeDefined();
    expect((state!.body as Array<{ key: string }>)[0]?.key).toBe(MX_PASS_TIMESWEEP);
  });

  it("survives a refetch that throws rather than returning", async () => {
    stubFetch({ candidates: [{ id: 1, synced_at: null }, { id: 2, synced_at: null }] });
    processWorkOrder
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true, detail: "ok" });

    // The caller is a scheduled handler sharing a tick with three other jobs.
    // A rejection out of here takes all of them down.
    const result = await runMxTimeSweep(ENV);
    expect(result.failed).toBe(1);
    expect(result.refetched).toBe(1);
  });

  it("stands down while a HEALTHY backfill walk is mid-cursor", async () => {
    const calls = stubFetch({
      syncState: [
        { key: "work_orders_live", cursor: "abc", last_success_at: "2026-09-16T00:00:00Z", last_status: "OK" }
      ]
    });
    const result = await runMxTimeSweep(ENV);

    expect(result.skipped).toBe("live pass is mid-walk");
    expect(processWorkOrder).not.toHaveBeenCalled();
    // And it did not even ask for candidates -- the walk in progress is
    // already re-reading these rows.
    expect(calls.some((c) => c.url.includes("/mx_work_order") && c.method === "GET")).toBe(false);
  });

  it("does NOT stand down for a live pass that is stuck in ERROR", async () => {
    // The regression this pins shipped and had to be fixed the same day.
    // Measured 2026-09-16: work_orders_live had held a cursor with
    // last_success_at NULL and last_status ERROR since the mirror went live,
    // failing the same attachments 21000 every five minutes and keeping its
    // cursor. Deferring on `cursor` alone therefore meant this sweep would
    // never run -- not once, ever -- and would leave no trace saying so.
    //
    // A pass that has never succeeded must not be able to disable a different
    // pass as a side effect of its own breakage.
    stubFetch({
      syncState: [
        {
          key: "work_orders_live",
          cursor: "2026-08-31T18:00:05.998Z|x|160886",
          last_success_at: null,
          last_status: "ERROR"
        }
      ],
      candidates: [{ id: 1, synced_at: null }]
    });
    processWorkOrder.mockResolvedValue({ ok: true, detail: "ok" });

    const result = await runMxTimeSweep(ENV);

    expect(result.skipped).toBeNull();
    expect(result.refetched).toBe(1);
  });

  it("records every stand-down, so 'skipping forever' cannot look like 'never deployed'", async () => {
    // Both produce a sweep that does nothing. Without a row they are
    // indistinguishable from mx_sync_state, which is exactly how the
    // permanent stand-down above went unnoticed until someone went looking
    // for a different thing.
    const calls = stubFetch({
      syncState: [
        { key: "work_orders_live", cursor: "abc", last_success_at: "2026-09-16T00:00:00Z", last_status: "OK" }
      ]
    });
    await runMxTimeSweep(ENV);

    const state = calls.find((c) => c.url.includes("/mx_sync_state") && c.method === "POST");
    expect(state).toBeDefined();
    const row = (state!.body as Array<{ key: string; stats: { skipped: string | null } }>)[0];
    expect(row?.key).toBe(MX_PASS_TIMESWEEP);
    expect(row?.stats.skipped).toBe("live pass is mid-walk");
  });

  it("stands down with a reason when the API key is unbound", async () => {
    const calls = stubFetch({ candidates: [{ id: 1, synced_at: null }] });
    const result = await runMxTimeSweep({ ...ENV, MAINTAINX_API_KEY: undefined } as Env);
    expect(result.skipped).toBe("MAINTAINX_API_KEY not bound");
    expect(processWorkOrder).not.toHaveBeenCalled();
    // Recorded, for the same reason as the stand-down above.
    expect(calls.some((c) => c.url.includes("/mx_sync_state") && c.method === "POST")).toBe(true);
  });

  it("reports a failed candidate query instead of looking like an empty pass", async () => {
    // An empty result and a broken query both refetch nothing. They must not
    // log the same way -- "selected: 0" forever is what a silently broken
    // filter looks like.
    stubFetch({ candidateStatus: 500 });
    const result = await runMxTimeSweep(ENV);
    expect(result.skipped).toContain("candidate select failed");
    expect(result.selected).toBe(0);
  });
});
