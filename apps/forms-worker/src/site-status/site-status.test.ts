// Site status: estimate parsing, Eastern time entry, who gets which email,
// test mode, the RD/RM-only close rule and the overdue reminder -- against a
// fake PostgREST that records every write.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../admin/auth.js", () => ({
  authenticate: vi.fn()
}));

import { authenticate } from "../admin/auth.js";
import type { Env } from "../index.js";
import { parseEstimate, runOverdueCheck } from "./actions.js";
import { handleSiteStatusAdmin } from "./admin.js";
import { renderEmail } from "./emails.js";
import { easternLocalToIso, handleSiteLinkPost } from "./public.js";
import type { Closure } from "./data.js";

// ---- fake database -------------------------------------------------------------------

interface Db {
  sites: Record<string, unknown>[];
  supervisors: string[];
  closures: Closure[];
  settings: { open_token: string; test_email_to: string | null; updated_at: string; updated_by: string | null };
  emails: Array<{ source_kind: string; source_id: string; recipient: string; subject: string; body_text: string }>;
  links: Array<{ closure_id: string; recipient: string }>;
}

let db: Db;

function site(n: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    site_number: n,
    site: name,
    area_manager: "Rita Director",
    am_email: "rd@splash.test",
    regional_manager: "Mike Manager",
    rm_email: "rm@splash.test",
    hrt_email: "hrt@splash.test",
    site_email: `site${n}@splash.test`,
    crd_email: "agent@splash.test",
    crd_supervisor_email: "sup1@splash.test",
    crd_region: "R1",
    ...extra
  };
}

function closureRow(over: Partial<Closure>): Closure {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    site_number: 122,
    site_name: "Binghamton",
    rd_name: "Rita Director",
    rd_email: "rd@splash.test",
    rm_name: "Mike Manager",
    rm_email: "rm@splash.test",
    reason: "power",
    reason_detail: null,
    closed_at: "2026-11-15T14:00:00+00:00",
    closed_by: "rm@splash.test",
    original_est_reopen_at: "2026-11-15T16:00:00+00:00",
    est_reopen_at: "2026-11-15T16:00:00+00:00",
    estimate_changes: [],
    reopened_at: null,
    reopened_by: null,
    reopened_via: null,
    reopen_note: null,
    overdue_notified_for: null,
    ...over
  };
}

function matches(row: Record<string, unknown>, params: URLSearchParams): boolean {
  for (const [k, v] of params.entries()) {
    if (["select", "order", "limit", "on_conflict"].includes(k)) continue;
    if (k === "or") {
      // only the overdue claim uses or=: (notified is null, or != est)
      const est = /neq\.(.+)\)$/.exec(v)?.[1];
      if (row.overdue_notified_for !== null && row.overdue_notified_for === est) return false;
      continue;
    }
    const cur = row[k];
    if (v === "is.null") { if (cur !== null && cur !== undefined) return false; continue; }
    if (v === "not.is.null") { if (cur === null || cur === undefined) return false; continue; }
    if (v.startsWith("eq.")) { if (String(cur) !== v.slice(3)) return false; continue; }
  }
  return true;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const table = url.pathname.replace("/rest/v1/", "");
  const method = req.method;
  const body = method === "GET" ? null : await req.json().catch(() => null);

  if (table === "jotform_site_lookup") return json(200, db.sites);
  if (table === "crd_regions") return json(200, db.supervisors.map((e) => ({ supervisor_email: e })));
  if (table === "site_status_settings") {
    if (method === "PATCH") Object.assign(db.settings, body);
    return json(200, [db.settings]);
  }
  if (table === "site_down_items") return json(200, []);
  if (table === "site_closure_links") {
    db.links.push(body as Db["links"][number]);
    return json(201, []);
  }
  if (table === "outbound_emails") {
    db.emails.push(body as Db["emails"][number]);
    return json(201, [{ id: crypto.randomUUID(), created_at: new Date().toISOString() }]);
  }
  if (table === "site_closures") {
    if (method === "GET") return json(200, db.closures.filter((c) => matches(c as unknown as Record<string, unknown>, url.searchParams)));
    if (method === "POST") {
      const b = body as Closure;
      if (db.closures.some((c) => c.site_number === b.site_number && !c.reopened_at)) {
        return json(409, { code: "23505" });
      }
      const row = closureRow({ ...b, id: crypto.randomUUID() });
      db.closures.push(row);
      return json(201, [row]);
    }
    if (method === "PATCH") {
      const hit = db.closures.filter((c) => matches(c as unknown as Record<string, unknown>, url.searchParams));
      for (const c of hit) Object.assign(c, body);
      return json(200, hit);
    }
  }
  throw new Error(`unexpected ${method} ${url.pathname}`);
}

const env = {
  SUPABASE_URL: "https://db.test",
  SUPABASE_SERVICE_KEY: "svc",
  SUPABASE_ANON_KEY: "anon"
} as unknown as Env;

function signedIn(email: string, extra: Record<string, unknown> = {}) {
  vi.mocked(authenticate).mockResolvedValue({
    status: "authenticated",
    session: { email, role: "location_admin", dcRole: null, ...extra }
  } as never);
}

function post(path: string, body: unknown): Request {
  return new Request(`https://internal/forms/admin/api/site-status${path}`, {
    method: "POST",
    headers: { Origin: "https://internal", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  db = {
    sites: [
      site(122, "Binghamton"),
      site(127, "Vestal*", { crd_email: null, crd_supervisor_email: null, crd_region: null }),
      site(69, "Test")
    ],
    supervisors: ["sup1@splash.test", "sup2@splash.test"],
    closures: [],
    settings: { open_token: "a".repeat(64), test_email_to: null, updated_at: "", updated_by: null },
    emails: [],
    links: []
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeFetch as typeof fetch);
});
afterEach(() => vi.restoreAllMocks());

// ---- tests -----------------------------------------------------------------------------

describe("estimates", () => {
  const now = new Date("2026-11-15T14:00:00Z");
  it("takes minutes from now or an explicit time, in the future, within 30 days", () => {
    expect((parseEstimate({ minutes: 90 }, now) as Date).toISOString()).toBe("2026-11-15T15:30:00.000Z");
    expect((parseEstimate({ minutes: "60" }, now) as Date).toISOString()).toBe("2026-11-15T15:00:00.000Z");
    expect((parseEstimate({ reopen_at: "2026-11-16T12:00:00Z" }, now) as Date).toISOString()).toBe("2026-11-16T12:00:00.000Z");
    expect(typeof parseEstimate({ reopen_at: "2026-11-15T13:00:00Z" }, now)).toBe("string");
    expect(typeof parseEstimate({ reopen_at: "2027-01-15T13:00:00Z" }, now)).toBe("string");
    expect(typeof parseEstimate({}, now)).toBe("string");
  });

  it("reads a typed date/time as Eastern, across DST", () => {
    expect(easternLocalToIso("2026-11-15T17:00")).toBe("2026-11-15T22:00:00.000Z"); // EST
    expect(easternLocalToIso("2026-07-04T09:30")).toBe("2026-07-04T13:30:00.000Z"); // EDT
    expect(easternLocalToIso("nope")).toBeNull();
  });
});

describe("closing", () => {
  it("only the site's RD or RM may close; others are refused", async () => {
    signedIn("someone@splash.test");
    const r = await handleSiteStatusAdmin(env, post("/close", { site_number: 122, reason: "power", minutes: 60 }), new URL("https://internal/forms/admin/api/site-status/close"));
    expect(r?.status).toBe(403);
    expect(db.closures).toHaveLength(0);
  });

  it("RM closes: one closure, emails RD/RM/HRT/CRD agent+supervisor AND the site, with the reopen link", async () => {
    signedIn("RM@splash.test");
    const r = await handleSiteStatusAdmin(
      env,
      post("/close", { site_number: 122, reason: "weather", reason_detail: "Ice storm", minutes: 120 }),
      new URL("https://internal/forms/admin/api/site-status/close")
    );
    expect(r?.status).toBe(200);
    expect(db.closures).toHaveLength(1);
    expect(db.closures[0]?.closed_by).toBe("rm@splash.test");
    expect(db.emails.map((e) => e.recipient).sort()).toEqual(
      ["agent@splash.test", "hrt@splash.test", "rd@splash.test", "rm@splash.test", "site122@splash.test", "sup1@splash.test"].sort()
    );
    expect(db.emails[0]?.body_text).toContain(`/forms/site-status/${"a".repeat(64)}?site=122`);
    // A second close of the same site is refused, not doubled.
    const again = await handleSiteStatusAdmin(env, post("/close", { site_number: 122, reason: "power", minutes: 60 }), new URL("https://internal/forms/admin/api/site-status/close"));
    expect(again?.status).toBe(409);
  });

  it("'Other' needs details", async () => {
    signedIn("rd@splash.test");
    const r = await handleSiteStatusAdmin(env, post("/close", { site_number: 122, reason: "other", minutes: 60 }), new URL("https://internal/forms/admin/api/site-status/close"));
    expect(r?.status).toBe(400);
  });

  it("a site with no CRD coverage mails every supervisor; test mode sends ONE email listing everyone", async () => {
    db.settings.test_email_to = "tester@splash.test";
    signedIn("rd@splash.test");
    await handleSiteStatusAdmin(env, post("/close", { site_number: 127, reason: "water", minutes: 60 }), new URL("https://internal/forms/admin/api/site-status/close"));
    expect(db.emails).toHaveLength(1);
    expect(db.emails[0]?.recipient).toBe("tester@splash.test");
    expect(db.emails[0]?.subject).toMatch(/^\[TEST\] CLOSED: Vestal \(127\)/);
    for (const who of ["sup1@splash.test", "sup2@splash.test", "site127@splash.test", "hrt@splash.test"]) {
      expect(db.emails[0]?.body_text).toContain(who);
    }
  });
});

describe("reopening", () => {
  it("the company link reopens with a typed name; reopen email skips the site inbox; a second tap is harmless", async () => {
    db.closures.push(closureRow({}));
    const form = () => {
      const f = new FormData();
      f.set("action", "reopen");
      f.set("site", "122");
      f.set("name", "Pat at the site");
      return new Request(`https://splashcarwashes.info/forms/site-status/${"a".repeat(64)}`, {
        method: "POST",
        headers: { Origin: "https://splashcarwashes.info" },
        body: f
      });
    };
    const url = new URL(`https://splashcarwashes.info/forms/site-status/${"a".repeat(64)}`);
    const r = await handleSiteLinkPost(env, form(), url, "a".repeat(64));
    expect(r.status).toBe(303);
    expect(db.closures[0]?.reopened_by).toBe("Pat at the site (site link)");
    expect(db.closures[0]?.reopened_via).toBe("link");
    expect(db.emails.map((e) => e.recipient)).not.toContain("site122@splash.test");
    expect(db.emails.length).toBe(5);
    const again = await handleSiteLinkPost(env, form(), url, "a".repeat(64));
    expect(again.headers.get("Location")).toContain("already+open");
    expect(db.emails.length).toBe(5);
  });

  it("a wrong token is a 404 and changes nothing", async () => {
    db.closures.push(closureRow({}));
    const f = new FormData();
    f.set("action", "reopen");
    f.set("site", "122");
    f.set("name", "x");
    const r = await handleSiteLinkPost(
      env,
      new Request("https://splashcarwashes.info/forms/site-status/" + "b".repeat(64), { method: "POST", headers: { Origin: "https://splashcarwashes.info" }, body: f }),
      new URL("https://splashcarwashes.info/forms/site-status/" + "b".repeat(64)),
      "b".repeat(64)
    );
    expect(r.status).toBe(404);
    expect(db.closures[0]?.reopened_at).toBeNull();
  });
});

describe("overdue reminder", () => {
  it("mails the RD and RM once per estimate, each with their own manage link", async () => {
    db.closures.push(closureRow({}));
    const later = new Date("2026-11-15T16:05:00Z");
    expect(await runOverdueCheck(env, later)).toEqual({ sent: 2 });
    expect(db.emails.map((e) => e.recipient).sort()).toEqual(["rd@splash.test", "rm@splash.test"]);
    expect(db.emails[0]?.body_text).toContain("/forms/site-status/manage/");
    expect(db.links).toHaveLength(2);
    // Next tick: already sent for this estimate.
    expect(await runOverdueCheck(env, later)).toEqual({ sent: 0 });
    // Extending re-arms it.
    db.closures[0]!.est_reopen_at = "2026-11-15T18:00:00+00:00";
    expect(await runOverdueCheck(env, new Date("2026-11-15T17:00:00Z"))).toEqual({ sent: 0 });
    expect(await runOverdueCheck(env, new Date("2026-11-15T18:01:00Z"))).toEqual({ sent: 2 });
  });
});

describe("email text", () => {
  it("closed carries the reopen button; reopened says how long it was closed", () => {
    const c = closureRow({});
    expect(renderEmail("closed", c, { reopenUrl: "https://x/open" }).text).toContain("https://x/open");
    const done = renderEmail("reopened", closureRow({ reopened_at: "2026-11-15T17:30:00+00:00", reopened_by: "Pat" }), {});
    expect(done.subject).toBe("OPEN: Binghamton (122) is back open");
    expect(done.text).toContain("Closed for: 3 hr 30 min");
  });
});
