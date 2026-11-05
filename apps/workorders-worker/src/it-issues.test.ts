// Tests for the IT Issue Tracker's rules -- the parts that, if they drift,
// fail silently: an issue closed with no explanation, a reopen that keeps the
// old resolution, a renamed HTML file accepted as a "photo".

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyChange,
  buildMxDescription,
  easternLocalToIso,
  mxApproverTeamId,
  mxBlockedReason,
  mxEnabled,
  occurredAt,
  occurrenceSpan,
  photosForMx,
  providerContact,
  providerPatch,
  recipientsOf,
  type IssueRow,
  type ItIssuesEnv
} from "./it-issues";
import { customerRefsText, digestBucket, escalationReplyTo, eventLine, providerSummary } from "./it-issues-email";
import { sniffImage } from "./it-issues-photos";

const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_KEY: "k",
  MAINTAINX_BASE_URL: "https://api.example",
  APPS_WEB_BASE_URL: "https://splashcarwashes.info"
} as ItIssuesEnv;

const ACTOR = { name: "Pat", email: "site@example.com", via: "app" as const, it: false };

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
    customer_ticket_no: null,
    customer_account_no: null,
    mx_request_id: null,
    first_reported_at: "2026-11-04T12:00:00Z",
    last_occurred_at: "2026-11-04T12:00:00Z",
    occurrence_count: 1,
    last_escalated_at: null,
    first_escalated_at: null,
    last_it_action_at: null,
    pos_provider_opened: null,
    pos_provider: null,
    pos_provider_ticket_no: null,
    pos_provider_first_contact_at: null,
    pos_provider_last_contact_at: null,
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
    // Left-out optional lines must not leave blank lines behind.
    expect(d).toContain("IT issue: IT-7\nSubmitted via");
    expect(d.split("\n").filter((l) => l === "")).toHaveLength(1);
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

describe("mxApproverTeamId", () => {
  it("reads a positive integer and ignores anything else", () => {
    expect(mxApproverTeamId({ IT_ISSUES_MX_APPROVER_TEAM_ID: " 74229 " })).toBe(74229);
    expect(mxApproverTeamId({ IT_ISSUES_MX_APPROVER_TEAM_ID: "" })).toBeUndefined();
    expect(mxApproverTeamId({ IT_ISSUES_MX_APPROVER_TEAM_ID: "IT Team" })).toBeUndefined();
    expect(mxApproverTeamId({})).toBeUndefined();
  });
});

describe("mxEnabled", () => {
  it("is on only for an explicit true", () => {
    expect(mxEnabled({ IT_ISSUES_MX_ENABLED: " TRUE " })).toBe(true);
    expect(mxEnabled({ IT_ISSUES_MX_ENABLED: "false" })).toBe(false);
    expect(mxEnabled({ IT_ISSUES_MX_ENABLED: "yes" })).toBe(false);
    expect(mxEnabled({})).toBe(false);
  });
});

describe("escalationReplyTo", () => {
  it("uses the escalating user's address and drops anything doubtful", () => {
    expect(escalationReplyTo(" Site@SplashCarWashes.com ")).toBe("site@splashcarwashes.com");
    expect(escalationReplyTo(null)).toBeUndefined();
    expect(escalationReplyTo("not an email")).toBeUndefined();
    expect(escalationReplyTo('a"b@x.com')).toBeUndefined();
    expect(escalationReplyTo("a\\b@x.com")).toBeUndefined();
  });
});

describe("easternLocalToIso", () => {
  it("reads the typed time as Eastern, on both sides of daylight saving", () => {
    expect(easternLocalToIso("2026-07-04T15:30")).toBe("2026-07-04T19:30:00.000Z"); // EDT, UTC-4
    expect(easternLocalToIso("2026-11-05T09:00")).toBe("2026-11-05T14:00:00.000Z"); // EST, UTC-5
  });
  it("rejects shapes and dates that do not exist", () => {
    expect(easternLocalToIso("2026-02-30T10:00")).toBeNull();
    expect(easternLocalToIso("11/05/2026 9:00")).toBeNull();
    expect(easternLocalToIso("2026-11-05T25:00")).toBeNull();
  });
});

describe("occurredAt", () => {
  const now = Date.parse("2026-11-05T15:00:00Z"); // 10:00 AM Eastern
  it("blank means now", () => {
    expect(occurredAt({}, now)).toBe(new Date(now).toISOString());
    expect(occurredAt({ occurred_at: "" }, now)).toBe(new Date(now).toISOString());
  });
  it("accepts an earlier time and refuses the future or a year-old typo", () => {
    expect(occurredAt({ occurred_at: "2026-11-05T08:15" }, now)).toBe("2026-11-05T13:15:00.000Z");
    expect(() => occurredAt({ occurred_at: "2026-11-05T11:00" }, now)).toThrow(/future/);
    expect(() => occurredAt({ occurred_at: "2025-10-01T08:00" }, now)).toThrow(/year/);
    expect(() => occurredAt({ occurred_at: "yesterday" }, now)).toThrow(/valid/);
  });
});

describe("occurrenceSpan", () => {
  const i = { first_reported_at: "2026-11-04T12:00:00.000Z", last_occurred_at: "2026-11-05T12:00:00.000Z" };
  it("a backdated occurrence does not pull 'last happened' backwards", () => {
    expect(occurrenceSpan(i, "2026-11-04T20:00:00.000Z")).toEqual(i);
  });
  it("moves first or last outward", () => {
    expect(occurrenceSpan(i, "2026-11-03T08:00:00.000Z").first_reported_at).toBe("2026-11-03T08:00:00.000Z");
    expect(occurrenceSpan(i, "2026-11-05T14:00:00.000Z").last_occurred_at).toBe("2026-11-05T14:00:00.000Z");
  });
});

describe("eventLine", () => {
  const ev = {
    id: 1,
    issue_id: "x",
    kind: "occurrence",
    at: "2026-11-05T16:00:00.000Z",
    occurred_at: "2026-11-05T13:15:00.000Z",
    actor_name: "Pat",
    actor_email: null,
    via: "app" as const,
    by_it: false,
    note: null,
    details: { customer_ticket_no: "T-9", customer_account_no: "A-1" }
  };
  it("leads with when it happened, notes a late log, and carries the customer refs", () => {
    const line = eventLine(ev);
    expect(line).toMatch(/^Nov 5, 8:15 AM|^Nov 5, 8:15 AM/);
    expect(line).toContain("(logged Nov 5, 11:00");
    expect(line).toContain("transaction ticket T-9, account A-1");
  });
});

describe("applyChange by IT", () => {
  it("marks the events as IT's and stamps last_it_action_at", async () => {
    const calls = stubDb(issue());
    await applyChange(ENV, issue(), { note: "Looking into it" }, { ...ACTOR, it: true });
    expect(calls.find((c) => c.method === "PATCH")!.body.last_it_action_at).toEqual(expect.any(String));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ kind: "note", by_it: true });
  });
  it("a site's action does not count as IT's", async () => {
    const calls = stubDb(issue());
    await applyChange(ENV, issue(), { note: "Still broken" }, ACTOR);
    expect(calls.find((c) => c.method === "PATCH")!.body).not.toHaveProperty("last_it_action_at");
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ by_it: false });
  });
});

describe("digestBucket", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const ago = (d: number) => new Date(now - d * 86_400_000).toISOString();
  const b = (over: Partial<IssueRow>) => digestBucket({ ...issue(), ...over }, now);

  it("never sent to IT is the site's to monitor, however old or quiet", () => {
    expect(b({ first_escalated_at: null })).toEqual({ bucket: "site", flag: null });
  });
  it("flags a critical issue nobody sent to IT", () => {
    expect(b({ priority: "critical" }).flag).toBe("Critical, not sent to IT");
  });
  it("needs attention only when sent 2+ days ago AND IT quiet 2+ days", () => {
    expect(b({ first_escalated_at: ago(3) })).toEqual({
      bucket: "attention",
      flag: "Sent to IT 3 days ago, no IT action yet"
    });
    expect(b({ first_escalated_at: ago(5), last_it_action_at: ago(2) }).flag).toBe("No IT action for 2 days");
  });
  it("is just 'passed to IT' when recent or IT has acted recently", () => {
    expect(b({ first_escalated_at: ago(1) }).bucket).toBe("with_it");
    expect(b({ first_escalated_at: ago(5), last_it_action_at: ago(1) }).bucket).toBe("with_it");
  });
});

describe("customerRefsText", () => {
  it("pluralises a comma-separated list of ticket numbers", () => {
    expect(customerRefsText("101", null)).toBe("transaction ticket 101");
    expect(customerRefsText("101, 102", "A-1")).toBe("transaction tickets 101, 102, account A-1");
  });
});

describe("POS provider contacts", () => {
  const NOW = Date.parse("2026-11-05T18:00:00Z");
  it("requires provider and call time", () => {
    expect(() => providerContact({ pos_provider_called_at: "2026-11-05T10:00" }, NOW)).toThrow(/POS provider is required/);
    expect(() => providerContact({ pos_provider: "DRB" }, NOW)).toThrow(/called is required/);
    expect(
      providerContact({ pos_provider: "DRB", pos_provider_called_at: "2026-11-05T10:00", pos_provider_ticket_no: "D-1" }, NOW)
    ).toEqual({ provider: "DRB", ticket_no: "D-1", contacted_at: "2026-11-05T15:00:00.000Z" });
  });
  it("never requires their ticket #", () => {
    expect(providerContact({ pos_provider: "ICS", pos_provider_called_at: "2026-11-05T10:00" }, NOW).ticket_no).toBeNull();
  });
  it("keeps the ticket on file and widens the span only outward", () => {
    const before = { pos_provider_ticket_no: "D-1", pos_provider_first_contact_at: "2026-11-05T15:00:00Z", pos_provider_last_contact_at: "2026-11-05T15:00:00Z" };
    const later = providerPatch(before, { provider: "DRB", ticket_no: null, contacted_at: "2026-11-05T17:00:00Z" });
    expect(later.pos_provider_ticket_no).toBe("D-1");
    expect(later.pos_provider_first_contact_at).toBe("2026-11-05T15:00:00Z");
    expect(later.pos_provider_last_contact_at).toBe("2026-11-05T17:00:00Z");
    const earlier = providerPatch(before, { provider: "DRB", ticket_no: "D-2", contacted_at: "2026-11-05T12:00:00Z" });
    expect(earlier.pos_provider_first_contact_at).toBe("2026-11-05T12:00:00Z");
    expect(earlier.pos_provider_last_contact_at).toBe("2026-11-05T15:00:00Z");
    expect(earlier.pos_provider_ticket_no).toBe("D-2");
  });
  it("tells IT whether it has been raised with the provider", () => {
    expect(providerSummary(issue())).toBe("");
    expect(providerSummary(issue({ pos_provider_opened: false }))).toBe("No ticket opened with the POS provider");
    expect(
      providerSummary(
        issue({ pos_provider_opened: true, pos_provider: "DRB", pos_provider_ticket_no: "D-1", pos_provider_first_contact_at: "2026-11-05T15:00:00Z", pos_provider_last_contact_at: "2026-11-05T15:00:00Z" })
      )
    ).toBe("DRB, ticket D-1, called Nov 5, 10:00 AM");
  });
});
