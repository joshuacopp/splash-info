// Tests for the IT Issue Tracker's rules -- the parts that, if they drift,
// fail silently: an issue closed with no explanation, a reopen that keeps the
// old resolution, a renamed HTML file accepted as a "photo".

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyChange,
  buildMxDescription,
  mxBlockedReason,
  photosForMx,
  recipientsOf,
  type IssueRow,
  type ItIssuesEnv
} from "./it-issues";
import { sniffImage } from "./it-issues-photos";

const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_KEY: "k",
  MAINTAINX_BASE_URL: "https://api.example",
  APPS_WEB_BASE_URL: "https://splashcarwashes.info"
} as ItIssuesEnv;

const ACTOR = { name: "Pat", email: "site@example.com", via: "app" as const };

function issue(over: Partial<IssueRow> = {}): IssueRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ref_no: 7,
    location_id: 1,
    site_number: 122,
    site_name: "122 Binghamton",
    device: "Kiosk scanner",
    device_unit: "1",
    problem: "Won't scan",
    error_text: null,
    customer_impact: "single_customer",
    priority: "medium",
    troubleshooting: null,
    status: "open",
    reporter_name: "Pat",
    reporter_phone: "555",
    created_by_email: "site@example.com",
    it_ticket_no: null,
    mx_request_id: null,
    first_reported_at: "2026-11-04T12:00:00Z",
    last_occurred_at: "2026-11-04T12:00:00Z",
    occurrence_count: 1,
    last_escalated_at: null,
    resolved_at: null,
    resolution: null,
    resolved_by: null,
    created_at: "2026-11-04T12:00:00Z",
    updated_at: "2026-11-04T12:00:00Z",
    ...over
  };
}

/** Records every PostgREST call; PATCH echoes the patched issue back. */
function stubDb(base: IssueRow) {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ method: String(init.method), url, body });
      const row = init.method === "PATCH" ? { ...base, ...body } : { id: calls.length, ...body };
      return new Response(JSON.stringify([row]), { status: 200 });
    })
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("applyChange", () => {
  it("refuses to resolve without a resolution note, and writes nothing", async () => {
    const calls = stubDb(issue());
    const r = await applyChange(ENV, issue(), { status: "resolved" }, ACTOR);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("resolves with a note and stamps who resolved it", async () => {
    const calls = stubDb(issue());
    const r = await applyChange(ENV, issue(), { status: "resolved", resolution: "Replaced cable" }, ACTOR);
    expect(r.ok).toBe(true);
    const patch = calls.find((c) => c.method === "PATCH")!.body;
    expect(patch).toMatchObject({ status: "resolved", resolution: "Replaced cable", resolved_by: "Pat" });
    expect(calls.some((c) => c.method === "POST" && c.body.kind === "resolved")).toBe(true);
  });

  it("reopening clears the old resolution", async () => {
    const calls = stubDb(issue({ status: "resolved", resolution: "x", resolved_by: "IT" }));
    await applyChange(ENV, issue({ status: "resolved", resolution: "x" }), { status: "open" }, ACTOR);
    const patch = calls.find((c) => c.method === "PATCH")!.body;
    expect(patch).toMatchObject({ status: "open", resolution: null, resolved_at: null, resolved_by: null });
    expect(calls.some((c) => c.body.kind === "reopened")).toBe(true);
  });

  it("says so when nothing changed", async () => {
    const calls = stubDb(issue());
    const r = await applyChange(ENV, issue(), { status: "open", priority: "medium" }, ACTOR);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a photo with no words is still saved as a note", async () => {
    const calls = stubDb(issue());
    const photo = { file: "a.jpg", mime: "image/jpeg", size: 1, name: "a.jpg" };
    const r = await applyChange(ENV, issue(), { photos: [photo] }, ACTOR);
    expect(r.ok).toBe(true);
    const ev = calls.find((c) => c.method === "POST")!.body;
    expect(ev).toMatchObject({ kind: "note", note: null, details: { photos: [photo] } });
  });
});

describe("sniffImage", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

  it("recognises the image types it stores", () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff))).toBe("jpg");
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47))).toBe("png");
    expect(sniffImage(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")))).toBe("webp");
    expect(sniffImage(bytes(0, 0, 0, 0x18, ...ascii("ftypheic")))).toBe("heic");
  });

  it("rejects anything else, whatever it is called", () => {
    expect(sniffImage(bytes(...ascii("<html>")))).toBeNull();
    expect(sniffImage(bytes(...ascii("%PDF-")))).toBeNull();
  });
});

describe("mxBlockedReason", () => {
  it("allows any open issue, with no priority or repeat qualifier", () => {
    expect(mxBlockedReason(issue({ priority: "low" }))).toBeNull();
  });
  it("blocks resolved issues", () => {
    expect(mxBlockedReason(issue({ status: "resolved" }))).not.toBeNull();
  });
});

describe("recipientsOf", () => {
  it("splits, trims, lowercases and de-duplicates", () => {
    expect(recipientsOf(" A@x.com, a@x.com ,b@x.com,")).toEqual(["a@x.com", "b@x.com"]);
    expect(recipientsOf(undefined)).toEqual([]);
  });
});

describe("buildMxDescription", () => {
  it("includes first-reported date and leaves out a missing ticket number", () => {
    const d = buildMxDescription(issue());
    expect(d).toContain("First reported: Nov 4, 2026");
    expect(d).toContain("IT issue: IT-7");
    expect(d).not.toContain("IT ticket #");
  });
  it("includes the repeat history and the IT ticket number when present", () => {
    const d = buildMxDescription(
      issue({ occurrence_count: 3, last_occurred_at: "2026-11-06T15:00:00Z", it_ticket_no: "INC-99" })
    );
    expect(d).toContain("Happened 3 times (first Nov 4, 2026, last Nov 6, 2026)");
    expect(d).toContain("IT ticket #: INC-99");
  });
});

describe("photosForMx", () => {
  const p = (n: number) => ({ file: `${n}.jpg`, mime: "image/jpeg", size: 1, name: `${n}` });
  it("takes timeline photos in order, capped at 5", () => {
    const got = photosForMx([
      { details: { photos: [p(1), p(2)] } },
      { details: {} },
      { details: { photos: [p(3), p(4), p(5), p(6)] } }
    ]);
    expect(got.map((x) => x.file)).toEqual(["1.jpg", "2.jpg", "3.jpg", "4.jpg", "5.jpg"]);
  });
});
