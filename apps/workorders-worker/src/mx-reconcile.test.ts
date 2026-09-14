// Tests for the daily reconciliation trigger.
//
// The whole module is one conditional write, so the tests are about WHEN it
// declines. Re-arming at the wrong moment is worse than not re-arming: the
// live pass is resumable through a cursor checkpoint, and clearing state under
// a walk in progress is how that cursor gets lost and the walk restarts from
// the beginning every day without ever finishing.
//
// The positive case asserts the exact field that matters. `isComplete` in
// mx-ingest.ts is `cursor IS NULL AND last_success_at IS NOT NULL`, so
// last_success_at: null IS the re-arm. A test that only checked "a write
// happened" would pass against a version that wrote the wrong column and
// silently never reconciled again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MX_PASS_RECONCILE, runMxReconcile, type MxReconcileEnv } from "./mx-reconcile";

const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_KEY: "service-key"
} as MxReconcileEnv;

interface Write {
  key: string;
  row: Record<string, unknown>;
}

let writes: Write[] = [];

/** Serve one mx_sync_state row for work_orders_live; capture every write. */
function stub(liveRow: Record<string, unknown> | null, opts?: { readFails?: boolean }) {
  writes = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "GET") {
      if (opts?.readFails) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify(liveRow ? [liveRow] : []), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (typeof init?.body === "string") {
      const parsed = JSON.parse(init.body) as Array<Record<string, unknown>>;
      for (const row of parsed) writes.push({ key: String(row.key), row });
    }
    return new Response(null, { status: 204 });
  });
}

function liveWrite(): Record<string, unknown> | undefined {
  return writes.find((w) => w.key === "work_orders_live")?.row;
}

const COMPLETE = {
  key: "work_orders_live",
  cursor: null,
  last_success_at: "2026-09-12T21:45:58.992Z",
  last_run_at: "2026-09-12T21:45:58.992Z",
  last_status: "OK",
  watermark: null,
  stats: {}
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runMxReconcile re-arms a completed pass", () => {
  it("reports that it re-armed", async () => {
    stub(COMPLETE);
    expect(await runMxReconcile(ENV)).toEqual({ rearmed: true, skipped: null });
  });

  it("clears last_success_at -- that field IS the re-arm", async () => {
    stub(COMPLETE);
    await runMxReconcile(ENV);
    expect(liveWrite()).toMatchObject({ last_success_at: null });
  });

  it("records its own run so the repair is observable", async () => {
    // Without a row of its own, "when did reconciliation last run" has to be
    // inferred from the live pass -- whose timestamps the walk overwrites
    // minutes later.
    stub(COMPLETE);
    await runMxReconcile(ENV);
    const own = writes.find((w) => w.key === MX_PASS_RECONCILE);
    expect(own).toBeDefined();
    expect(own?.row).toMatchObject({ last_status: "OK" });
  });

  it("keeps the previous success time in its stats for comparison", async () => {
    stub(COMPLETE);
    await runMxReconcile(ENV);
    const own = writes.find((w) => w.key === MX_PASS_RECONCILE);
    expect((own?.row.stats as Record<string, unknown>)?.previous_live_success_at).toBe(
      COMPLETE.last_success_at
    );
  });
});

describe("runMxReconcile declines when re-arming would do harm", () => {
  it("does not touch a walk that is mid-cursor", async () => {
    // The cursor is the resume point. Clearing state under a running walk
    // restarts it, and a daily restart means it never finishes.
    stub({ ...COMPLETE, cursor: "abc123", last_success_at: null });
    const res = await runMxReconcile(ENV);
    expect(res.rearmed).toBe(false);
    expect(res.skipped).toContain("mid-walk");
    expect(liveWrite()).toBeUndefined();
  });

  it("does not re-arm a pass still doing its first backfill", async () => {
    // Nothing to reconcile against yet, and the backfill is already reading
    // everything this would ask for.
    stub({ ...COMPLETE, cursor: null, last_success_at: null });
    const res = await runMxReconcile(ENV);
    expect(res.rearmed).toBe(false);
    expect(res.skipped).toContain("not completed once");
    expect(liveWrite()).toBeUndefined();
  });

  it("does nothing when the pass has never run", async () => {
    stub(null);
    const res = await runMxReconcile(ENV);
    expect(res.rearmed).toBe(false);
    expect(res.skipped).toContain("never run");
    expect(liveWrite()).toBeUndefined();
  });

  it("declines rather than guessing when the state cannot be read", async () => {
    // A failed read must never be treated as "not mid-walk".
    stub(null, { readFails: true });
    const res = await runMxReconcile(ENV);
    expect(res.rearmed).toBe(false);
    expect(res.skipped).toContain("could not read");
    expect(liveWrite()).toBeUndefined();
  });

  it("never throws into the scheduled handler", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network gone");
    });
    await expect(runMxReconcile(ENV)).resolves.toMatchObject({ rearmed: false });
  });
});

describe("runMxReconcile write shape", () => {
  it("leaves the cursor null rather than omitting it", async () => {
    // Explicit: a stale cursor surviving the re-arm would make the dispatcher
    // resume a walk that no longer matches the state it is resuming into.
    stub(COMPLETE);
    await runMxReconcile(ENV);
    expect(liveWrite()).toHaveProperty("cursor", null);
  });

  it("does not disturb the watermark", async () => {
    // The incremental sweep's watermark belongs to a different pass and must
    // survive: resetting it would re-read months of history every day.
    stub(COMPLETE);
    await runMxReconcile(ENV);
    expect(liveWrite()).not.toHaveProperty("watermark");
  });
});
