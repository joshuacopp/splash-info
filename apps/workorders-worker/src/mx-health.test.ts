// Tests for the ingest health check.
//
// These are about WHAT IT DOES NOT FIRE ON as much as what it does. An alert
// that cries wolf gets filtered into a folder, and then it is worse than no
// alert at all because it also convinces everyone something is watching.
//
// The specific false positive to guard against: work_orders_history and
// work_requests_full complete exactly once and are then never run again -- the
// dispatcher switches to the incremental sweep permanently -- so their
// last_success_at is legitimately weeks old. Any "has not succeeded lately"
// rule flags both of them every morning, forever.

import { afterEach, describe, expect, it, vi } from "vitest";
import { runMxIngestHealth, type MxHealthEnv } from "./mx-health";

const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_KEY: "service-key",
  INGEST_ALERT_EMAIL: "ops@example.com"
} as MxHealthEnv;

const NOW = new Date("2026-09-17T05:00:00.000Z");

interface Captured {
  url: string;
  body: unknown;
}

function stub(rows: unknown[]): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (url.includes("mx_sync_state")) {
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("[]", { status: 201, headers: { "Content-Type": "application/json" } });
  });
  return calls;
}

function pass(over: Record<string, unknown> = {}) {
  return {
    key: "work_orders_incremental",
    cursor: null,
    last_run_at: "2026-09-17T04:55:00Z",
    last_success_at: "2026-09-17T04:55:00Z",
    last_status: "OK",
    last_error: null,
    ...over
  };
}

const enqueued = (calls: Captured[]) =>
  calls.find((c) => c.url.includes("outbound_emails"));

afterEach(() => vi.unstubAllGlobals());

describe("runMxIngestHealth — what it flags", () => {
  it("flags a pass whose last run errored", async () => {
    const calls = stub([pass({ key: "work_orders_live", last_status: "ERROR", last_error: "attachments: 500" })]);
    const r = await runMxIngestHealth(ENV, NOW);

    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.problem).toBe("last run failed");
    expect(r.emailed).toBe(true);
    expect(enqueued(calls)).toBeDefined();
  });

  it("flags a pass that has run and never once succeeded", async () => {
    // This is the exact shape of the bug that motivated the check:
    // work_orders_live, cursor set, last_success_at NULL, running every five
    // minutes since the mirror went live.
    stub([
      pass({
        key: "work_orders_live",
        cursor: "2026-08-31T18:00:05.998Z|x|160886",
        last_success_at: null,
        last_status: "PARTIAL"
      })
    ]);
    const r = await runMxIngestHealth(ENV, NOW);

    expect(r.problems[0]!.problem).toBe("has never completed successfully");
  });

  it("flags a walk that has been mid-cursor for over a day", async () => {
    stub([
      pass({
        key: "work_orders_live",
        cursor: "abc",
        last_success_at: "2026-09-15T04:00:00Z", // ~2 days before NOW
        last_status: "PARTIAL"
      })
    ]);
    const r = await runMxIngestHealth(ENV, NOW);

    expect(r.problems[0]!.problem).toMatch(/mid-walk/);
  });
});

describe("runMxIngestHealth — what it leaves alone", () => {
  it("does NOT flag a completed backfill pass that will never run again", async () => {
    // work_orders_history finished on 2026-09-13 and is done forever. A
    // staleness rule would flag this every morning for the life of the system.
    stub([
      pass({
        key: "work_orders_history",
        cursor: null,
        last_run_at: "2026-09-13T10:45:46Z",
        last_success_at: "2026-09-13T10:45:46Z",
        last_status: "OK"
      })
    ]);
    const r = await runMxIngestHealth(ENV, NOW);

    expect(r.problems).toEqual([]);
    expect(r.emailed).toBe(false);
  });

  it("does NOT flag a pass that has never run at all", async () => {
    // Not yet reached is a normal state, distinct from tried and failed.
    stub([pass({ key: "work_orders_timesweep", last_run_at: null, last_success_at: null })]);
    const r = await runMxIngestHealth(ENV, NOW);
    expect(r.problems).toEqual([]);
  });

  it("does NOT flag a healthy mid-walk that is making progress", async () => {
    // A cursor is how resumability works. Only a cursor that has outlived any
    // real walk is a problem.
    stub([pass({ key: "work_orders_live", cursor: "abc", last_success_at: "2026-09-17T02:00:00Z" })]);
    const r = await runMxIngestHealth(ENV, NOW);
    expect(r.problems).toEqual([]);
  });

  it("sends nothing when every pass is healthy", async () => {
    const calls = stub([pass(), pass({ key: "work_order_comments" })]);
    const r = await runMxIngestHealth(ENV, NOW);

    expect(r.checked).toBe(2);
    expect(r.problems).toEqual([]);
    expect(enqueued(calls)).toBeUndefined();
  });
});

describe("runMxIngestHealth — delivery", () => {
  it("still reports problems when no alert address is configured", async () => {
    const calls = stub([pass({ last_status: "ERROR" })]);
    const r = await runMxIngestHealth({ ...ENV, INGEST_ALERT_EMAIL: undefined } as MxHealthEnv, NOW);

    expect(r.problems).toHaveLength(1);
    expect(r.emailed).toBe(false);
    expect(r.skipped).toMatch(/INGEST_ALERT_EMAIL/);
    expect(enqueued(calls)).toBeUndefined();
  });

  it("keys the alert on the day and the failing passes, so it re-nags daily but not hourly", async () => {
    const calls = stub([
      pass({ key: "work_orders_live", last_status: "ERROR" }),
      pass({ key: "work_order_comments", last_status: "ERROR" })
    ]);
    await runMxIngestHealth(ENV, NOW);

    // enqueueOutboundEmail posts ONE object, not a batch array.
    const body = enqueued(calls)!.body as { source_id: string; source_kind: string };
    expect(body.source_kind).toBe("workorders-ingest-health");
    // Date first, then the failing keys sorted -- so a second run today is a
    // no-op via the queue's dedup index, and tomorrow is a fresh alert.
    expect(body.source_id).toBe("2026-09-17:work_order_comments,work_orders_live");
  });

  it("survives a sync-state read failure without throwing", async () => {
    // It shares a cron tick with the digest; a rejection here takes that down.
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    const r = await runMxIngestHealth(ENV, NOW);
    expect(r.skipped).toMatch(/sync-state read failed/);
    expect(r.problems).toEqual([]);
  });
});
