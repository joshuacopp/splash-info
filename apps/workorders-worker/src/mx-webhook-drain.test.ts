// Tests for the webhook drain and, more importantly, for the decision that
// makes it worth having: whether a failed delivery stays in the queue.
//
// The bug these pin was invisible in production. stampEvent wrote
// processed_at on EVERY outcome, so a MaintainX 502 was recorded as "done,
// with an error" and the delivery was dropped. mx_webhook_event_pending_idx
// was almost always empty, which read as health and was actually the symptom:
// nothing could ever be pending except a row whose waitUntil died before
// reaching the stamp.
//
// So the assertions below are mostly about the ABSENCE of processed_at. A
// test that only checked "an error was recorded" passes against the broken
// version.
//
// Every case here avoids the network: the three short-circuit outcomes in
// processMxWebhookDelivery (key unbound, no entity id, unrouted event) are
// decided before any MaintainX call, so only the Supabase PATCH is stubbed.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROCESS_ATTEMPTS,
  processMxWebhookDelivery,
  type MxWebhookProcessEnv
} from "./mx-webhook-process";
import { runMxWebhookDrain } from "./mx-webhook-drain";
import type { ParsedDelivery } from "./mx-webhook";

const SUPABASE = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_KEY: "service-key",
  MAINTAINX_BASE_URL: "https://api.getmaintainx.com/v1"
};

/**
 * No API key: the cleanest RETRYABLE failure, decided before any outbound
 * call. Note this check runs FIRST in processMxWebhookDelivery -- ahead of the
 * entity-id and routing checks -- so an unbound key makes every delivery
 * retryable regardless of its shape. That is deliberate (a missing secret is
 * deployment state that gets fixed, not a bad payload), but it means the
 * terminal cases below must bind a key to reach their own branch at all.
 */
const ENV = SUPABASE as MxWebhookProcessEnv;

/** Key bound, so the terminal branches are reachable. Both terminal outcomes
 *  short-circuit before any MaintainX call, so nothing here hits the network
 *  despite the key being present. */
const ENV_KEYED = { ...SUPABASE, MAINTAINX_API_KEY: "mx-key" } as MxWebhookProcessEnv;

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** Capture every request; answer event PATCHes and pending reads. */
function stubFetch(pendingRows: unknown[] = []): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    calls.push({ url, method, body });

    if (url.includes("mx_webhook_event") && method === "GET") {
      return new Response(JSON.stringify(pendingRows), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(null, { status: 204 });
  });
  return calls;
}

/** The PATCH the drain/inline path writes back onto the delivery row. */
function eventPatch(calls: Captured[]): Record<string, unknown> | null {
  const c = calls.find((x) => x.url.includes("mx_webhook_event?id=eq.") && x.method === "PATCH");
  return c?.body ?? null;
}

function delivery(over: Partial<ParsedDelivery> = {}): ParsedDelivery {
  return {
    eventType: "WORK_ORDER_CHANGE",
    entityKind: "WORK_ORDER",
    entityId: 118831473,
    occurredAt: "2026-09-14T13:03:18.971Z",
    payload: {},
    ...over
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a retryable failure stays in the queue", () => {
  it("does NOT stamp processed_at", async () => {
    // THE REGRESSION TEST. Before the fix this key was always present, and a
    // transient MaintainX error therefore removed the row from the drain's
    // work queue forever.
    const calls = stubFetch();
    await processMxWebhookDelivery(ENV, delivery(), "row-1", 1);

    const patch = eventPatch(calls);
    expect(patch).not.toBeNull();
    expect(patch).not.toHaveProperty("processed_at");
  });

  it("records the error and the attempt number", async () => {
    const calls = stubFetch();
    await processMxWebhookDelivery(ENV, delivery(), "row-1", 3);

    expect(eventPatch(calls)).toMatchObject({
      attempts: 3,
      process_error: "MAINTAINX_API_KEY not bound"
    });
  });

  it("leaves processed_at absent rather than explicitly null", async () => {
    // Absent, not null: a retry must never clear a stamp that a concurrent
    // attempt already wrote.
    const calls = stubFetch();
    await processMxWebhookDelivery(ENV, delivery(), "row-1", 1);
    expect(Object.keys(eventPatch(calls) ?? {})).not.toContain("processed_at");
  });
});

describe("a terminal failure leaves the queue immediately", () => {
  it("stamps processed_at when the payload carried no entity id", async () => {
    const calls = stubFetch();
    await processMxWebhookDelivery(ENV_KEYED, delivery({ entityId: null }), "row-2", 1);

    const patch = eventPatch(calls);
    expect(patch).toHaveProperty("processed_at");
    expect(patch?.process_error).toContain("carried no entity id");
  });

  it("stamps processed_at for an event we do not route", async () => {
    const calls = stubFetch();
    await processMxWebhookDelivery(
      ENV_KEYED,
      delivery({ eventType: "NEW_PART", entityKind: "OTHER", entityId: 5 }),
      "row-3",
      1
    );

    const patch = eventPatch(calls);
    expect(patch).toHaveProperty("processed_at");
    expect(patch?.process_error).toContain("unrouted event NEW_PART");
  });
});

describe("the attempt ceiling", () => {
  it("keeps retrying below the ceiling", async () => {
    const calls = stubFetch();
    await processMxWebhookDelivery(ENV, delivery(), "row-4", MAX_PROCESS_ATTEMPTS - 1);
    expect(eventPatch(calls)).not.toHaveProperty("processed_at");
  });

  it("gives up AT the ceiling, so a broken row cannot occupy the queue forever", async () => {
    const calls = stubFetch();
    await processMxWebhookDelivery(ENV, delivery(), "row-5", MAX_PROCESS_ATTEMPTS);

    const patch = eventPatch(calls);
    expect(patch).toHaveProperty("processed_at");
    expect(String(patch?.process_error)).toContain(`gave up after ${MAX_PROCESS_ATTEMPTS}`);
  });

  it("still reports the underlying cause when giving up", async () => {
    // Losing the original error at the ceiling would make the give-up row
    // useless for diagnosis.
    const calls = stubFetch();
    await processMxWebhookDelivery(ENV, delivery(), "row-6", MAX_PROCESS_ATTEMPTS);
    expect(String(eventPatch(calls)?.process_error)).toContain("MAINTAINX_API_KEY not bound");
  });
});

describe("runMxWebhookDrain query", () => {
  it("asks only for unprocessed rows, oldest first, under the ceiling", async () => {
    const calls = stubFetch([]);
    await runMxWebhookDrain(ENV);

    const read = calls.find((c) => c.method === "GET");
    expect(read).toBeDefined();
    const url = read!.url;
    expect(url).toContain("processed_at=is.null");
    expect(url).toContain("order=received_at.asc");
    expect(url).toContain(`attempts=lt.${MAX_PROCESS_ATTEMPTS}`);
  });

  it("applies a grace period so it does not race the inline waitUntil", async () => {
    const calls = stubFetch([]);
    const before = Date.now();
    await runMxWebhookDrain(ENV);

    const url = calls.find((c) => c.method === "GET")!.url;
    const match = /received_at=lt\.([^&]+)/.exec(url);
    expect(match).not.toBeNull();
    const cutoff = new Date(decodeURIComponent(match![1]!)).getTime();
    // Strictly in the past -- a drain that read up to "now" would pick up
    // rows whose ack was still in flight.
    expect(cutoff).toBeLessThan(before);
  });

  it("reports an empty queue without processing anything", async () => {
    stubFetch([]);
    expect(await runMxWebhookDrain(ENV)).toMatchObject({
      claimed: 0,
      processed: 0,
      skipped: 0
    });
  });

  it("survives a failed read instead of throwing into the scheduled handler", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    expect(await runMxWebhookDrain(ENV)).toMatchObject({ claimed: 0, processed: 0 });
  });
});

describe("runMxWebhookDrain processing", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "evt-1",
    event_type: "WORK_ORDER_CHANGE",
    entity_kind: "WORK_ORDER",
    entity_id: 118831473,
    occurred_at: "2026-09-14T13:03:18.971Z",
    payload: {},
    attempts: 0,
    ...over
  });

  it("continues the stored attempt count rather than restarting it", async () => {
    // The ceiling has to span invocations; a drain that always passed 1 would
    // retry a hopeless row forever.
    const calls = stubFetch([row({ attempts: 2 })]);
    await runMxWebhookDrain(ENV);
    expect(eventPatch(calls)).toMatchObject({ attempts: 3 });
  });

  it("treats a row with no prior attempts as attempt 1", async () => {
    const calls = stubFetch([row({ attempts: null })]);
    await runMxWebhookDrain(ENV);
    expect(eventPatch(calls)).toMatchObject({ attempts: 1 });
  });

  it("processes each claimed row", async () => {
    stubFetch([row({ id: "a" }), row({ id: "b" })]);
    expect(await runMxWebhookDrain(ENV)).toMatchObject({ claimed: 2, processed: 2 });
  });

  it("skips a row whose entity_id cannot be a number", async () => {
    // Would otherwise consume a slot on every pass forever.
    const res = await (async () => {
      stubFetch([row({ entity_id: "not-a-number" })]);
      return runMxWebhookDrain(ENV);
    })();
    expect(res).toMatchObject({ claimed: 1, processed: 0, skipped: 1 });
  });

  it("reads a numeric entity_id sent as a string", async () => {
    // PostgREST renders bigint as a JSON number, but a client or a future
    // schema change could hand back a string; coercing is free.
    const calls = stubFetch([row({ entity_id: "118831473", attempts: 0 })]);
    const res = await runMxWebhookDrain(ENV);
    expect(res).toMatchObject({ processed: 1, skipped: 0 });
    expect(eventPatch(calls)).not.toBeNull();
  });

  it("routes an unknown entity_kind to OTHER rather than trusting it", async () => {
    const calls = stubFetch([row({ entity_kind: "SOMETHING_NEW" })]);
    await runMxWebhookDrain(ENV_KEYED);
    // OTHER is terminal -- an unroutable event must not be retried forever.
    expect(eventPatch(calls)).toHaveProperty("processed_at");
  });
});
