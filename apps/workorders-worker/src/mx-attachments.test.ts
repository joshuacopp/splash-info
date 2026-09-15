// Tests for the attachment mirror.
//
// The first of these exists because of a bug that unit tests could not have
// caught on their own and production surfaced in one tick: the cursor was
// written to `watermark`, which is timestamptz, so PostgREST answered 400 and
// the id never advanced. The pass then re-did the same 12 work orders every
// five minutes -- real MaintainX calls each time -- and never reached the
// 13th. Nothing threw, nothing logged an error, and the only visible symptom
// was an mx_sync_state row that never appeared.
//
// A test cannot know a column's type, so it asserts the COLUMN CHOICE instead.
// That is the decision that was wrong, and it is checkable.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachmentR2Key,
  runMxAttachmentMirror,
  type MxAttachmentEnv
} from "./mx-attachments";

const BASE_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_KEY: "service-key",
  MAINTAINX_BASE_URL: "https://api.getmaintainx.com/v1",
  MAINTAINX_API_KEY: "mx-key"
};

/** A bucket that records puts without storing anything. */
function fakeBucket() {
  const puts: Array<{ key: string; bytes: number }> = [];
  return {
    puts,
    bucket: {
      put: async (key: string, body: ArrayBuffer) => {
        puts.push({ key, bytes: body.byteLength });
        return {};
      },
      get: async () => null
    } as unknown as R2Bucket
  };
}

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

let calls: Captured[] = [];

/** Serve the Supabase reads the pass makes; record every write. */
function stub(opts: { scope?: Array<{ id: number }>; syncState?: unknown } = {}) {
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });

    if (url.includes("mx_sync_state") && method === "GET") {
      return json(opts.syncState ? [opts.syncState] : []);
    }
    if (url.includes("mx_work_order?select=id")) {
      return json(opts.scope ?? []);
    }
    if (url.includes("mx_work_order_attachment") && method === "GET") {
      return json([]);
    }
    if (url.includes("locations")) {
      return json([]);
    }
    return new Response(null, { status: 204 });
  });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/** The write the pass makes to its own bookkeeping row. */
function syncWrite(): Record<string, unknown> | null {
  const c = calls.find(
    (x) => x.url.includes("mx_sync_state") && x.method === "POST"
  );
  const rows = c?.body as Array<Record<string, unknown>> | undefined;
  return rows?.[0] ?? null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cursor persistence", () => {
  it("writes the cursor to `cursor`, NEVER to `watermark`", async () => {
    // THE REGRESSION. `watermark` is timestamptz; a work-order id in it is a
    // 400, the cursor never moves, and the pass loops on the same slice
    // forever while looking healthy.
    const { bucket } = fakeBucket();
    stub({ scope: [{ id: 101 }] });
    await runMxAttachmentMirror({ ...BASE_ENV, WORKORDER_FILES: bucket } as MxAttachmentEnv);

    const write = syncWrite();
    expect(write).not.toBeNull();
    expect(write).toHaveProperty("cursor");
    expect(write).not.toHaveProperty("watermark");
  });

  it("advances the cursor to the last id it looked at", async () => {
    const { bucket } = fakeBucket();
    stub({ scope: [{ id: 101 }, { id: 202 }, { id: 303 }] });
    await runMxAttachmentMirror({ ...BASE_ENV, WORKORDER_FILES: bucket } as MxAttachmentEnv);
    expect(syncWrite()?.cursor).toBe("303");
  });

  it("reads the cursor back from `cursor`", async () => {
    // Round-trips with the write above. Reading `watermark` here would make
    // the pass restart from 0 on every tick even once the write was fixed.
    const { bucket } = fakeBucket();
    stub({ scope: [], syncState: { key: "work_order_attachments", cursor: "555" } });
    await runMxAttachmentMirror({ ...BASE_ENV, WORKORDER_FILES: bucket } as MxAttachmentEnv);
    const scopeCall = calls.find((c) => c.url.includes("mx_work_order?select=id"));
    expect(scopeCall?.url).toContain("id=gt.555");
  });

  it("resets the cursor when the scope is exhausted", async () => {
    // So a later sweep picks up attachments added to work orders already
    // visited -- the webhook records their metadata, but only this pass can
    // copy bytes.
    const { bucket } = fakeBucket();
    stub({ scope: [], syncState: { key: "work_order_attachments", cursor: "999" } });
    const res = await runMxAttachmentMirror({
      ...BASE_ENV,
      WORKORDER_FILES: bucket
    } as MxAttachmentEnv);
    expect(res.backfillComplete).toBe(true);
    expect(syncWrite()?.cursor).toBe("0");
  });
});

describe("scope", () => {
  it("asks for active, non-preventive, non-deleted work orders", async () => {
    const { bucket } = fakeBucket();
    stub({ scope: [] });
    await runMxAttachmentMirror({ ...BASE_ENV, WORKORDER_FILES: bucket } as MxAttachmentEnv);
    const scopeCall = calls.find((c) => c.url.includes("mx_work_order?select=id"));
    expect(scopeCall?.url).toContain("status=in.(OPEN,IN_PROGRESS,ON_HOLD)");
    expect(scopeCall?.url).toContain("type=not.eq.PREVENTIVE");
    expect(scopeCall?.url).toContain("deleted_at=is.null");
  });

  it("orders by id so the cursor is monotonic", async () => {
    const { bucket } = fakeBucket();
    stub({ scope: [] });
    await runMxAttachmentMirror({ ...BASE_ENV, WORKORDER_FILES: bucket } as MxAttachmentEnv);
    const scopeCall = calls.find((c) => c.url.includes("mx_work_order?select=id"));
    expect(scopeCall?.url).toContain("order=id.asc");
  });
});

describe("guards", () => {
  it("skips without a bucket rather than throwing", async () => {
    stub({ scope: [{ id: 1 }] });
    const res = await runMxAttachmentMirror({ ...BASE_ENV } as MxAttachmentEnv);
    expect(res.mirrored).toBe(0);
    expect(res.skipped).toContain("WORKORDER_FILES");
  });

  it("skips without an API key", async () => {
    const { bucket } = fakeBucket();
    stub({ scope: [{ id: 1 }] });
    const res = await runMxAttachmentMirror({
      ...BASE_ENV,
      MAINTAINX_API_KEY: undefined,
      WORKORDER_FILES: bucket
    } as MxAttachmentEnv);
    expect(res.skipped).toContain("MAINTAINX_API_KEY");
  });

  it("never throws into the scheduled handler", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network gone");
    });
    const { bucket } = fakeBucket();
    await expect(
      runMxAttachmentMirror({ ...BASE_ENV, WORKORDER_FILES: bucket } as MxAttachmentEnv)
    ).resolves.toBeDefined();
  });
});

describe("pending work requests", () => {
  it("scopes to PENDING only, not REJECTED", async () => {
    // 15 pending against 1,443 rejected. A rejected request is work that will
    // not happen; mirroring those is ~1,443 calls and ~3 GB for photos nobody
    // opens the page to see. Widening is one constant, but deliberately so.
    const { bucket } = fakeBucket();
    stub({ scope: [] });
    await runMxAttachmentMirror({ ...BASE_ENV, WORKORDER_FILES: bucket } as MxAttachmentEnv);
    const reqCall = calls.find((c) => c.url.includes("mx_work_request?select=id"));
    expect(reqCall).toBeDefined();
    expect(reqCall!.url).toContain("request_status=in.(PENDING)");
    expect(reqCall!.url).not.toContain("REJECTED");
  });

  it("sweeps requests even when the work-order scope is exhausted", async () => {
    // Requests are not cursor-driven. If they only ran on ticks with
    // work-order scope left, they would stall the moment the backfill
    // completed -- which is most ticks.
    const { bucket } = fakeBucket();
    stub({ scope: [], syncState: { key: "work_order_attachments", cursor: "999" } });
    const res = await runMxAttachmentMirror({
      ...BASE_ENV,
      WORKORDER_FILES: bucket
    } as MxAttachmentEnv);
    expect(res.backfillComplete).toBe(true);
    expect(calls.some((c) => c.url.includes("mx_work_request?select=id"))).toBe(true);
  });

  it("reports requests scanned separately from work orders", async () => {
    const { bucket } = fakeBucket();
    stub({ scope: [] });
    const res = await runMxAttachmentMirror({
      ...BASE_ENV,
      WORKORDER_FILES: bucket
    } as MxAttachmentEnv);
    expect(res).toHaveProperty("requestsScanned");
  });
});

describe("attachmentR2Key", () => {
  it("namespaces by owner kind and id", () => {
    expect(
      attachmentR2Key({ kind: "work-orders", id: 118834534 }, 272727625, "image/jpeg")
    ).toBe("work-orders/118834534/272727625.jpg");
  });

  it("keeps work requests in their own prefix", () => {
    // Separate prefixes so an R2 listing is readable and a future cleanup can
    // scope to one kind without touching the other.
    expect(
      attachmentR2Key({ kind: "work-requests", id: 13921023 }, 272725227, "image/jpeg")
    ).toBe("work-requests/13921023/272725227.jpg");
  });

  it("maps the mime types we actually see", () => {
    const wo = { kind: "work-orders" as const, id: 1 };
    expect(attachmentR2Key(wo, 2, "image/png")).toMatch(/\.png$/);
    expect(attachmentR2Key(wo, 2, "image/heic")).toMatch(/\.heic$/);
    expect(attachmentR2Key(wo, 2, "application/pdf")).toMatch(/\.pdf$/);
  });

  it("omits the extension rather than guessing one", () => {
    // mime_type is what the serve route sets Content-Type from, so a wrong
    // suffix would be worse than none.
    const wo = { kind: "work-orders" as const, id: 1 };
    expect(attachmentR2Key(wo, 2, null)).toBe("work-orders/1/2");
    expect(attachmentR2Key(wo, 2, "application/x-weird")).toBe("work-orders/1/2");
  });
});
