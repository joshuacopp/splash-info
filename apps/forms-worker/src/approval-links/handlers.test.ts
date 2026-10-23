// Emailed approval links, end to end through the real handlers and the real
// applyTransition. Only the network (PostgREST) and R2 are stubbed.
//
// The cases are the ones the operator cares about:
//   - opening the page twice does NOT spend the link
//   - a forgotten signature is a "fix it", not a spent link
//   - an approval lands, is recorded as via the emailed link, and is
//     conditional on the submission still being at the link's stage
//   - a link for a stage the submission has left is refused
//   - a used link is refused

import { afterEach, describe, expect, it } from "vitest";
import { handleApprovalLinkPage, handleApprovalLinkSubmit } from "./handlers.js";

const FORM = "13c8b3ca-1411-4d99-9e97-01397e3e3a12";
const SUB = "6ecafdce-8a68-46fe-84ba-4409c84abf5b";
const DAN = "dpetrelle@splashcarwashes.com";
const TOKEN = "A".repeat(43);
const HOST = "https://splashcarwashes.info";

const puts: string[] = [];
const ENV = {
  SUPABASE_URL: "https://sb.test",
  SUPABASE_SERVICE_KEY: "k",
  FORMS_FILES: {
    put: async (key: string) => {
      puts.push(key);
    }
  }
} as never;

function linkRow(over: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    form_id: FORM,
    submission_id: SUB,
    stage_id: "dan_review",
    recipient_email: DAN,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    open_count: 0,
    used_at: null,
    ...over
  };
}

function submissionRow(stage = "dan_review") {
  return {
    id: SUB,
    form_id: FORM,
    form_version_id: "v1",
    payload: {
      site: "019",
      packages: [
        {
          pkg: "Ultimate",
          current_single: "24.00",
          current_monthly: "39.99",
          new_single: "26.00",
          new_monthly: "39.99"
        }
      ]
    },
    submitter_kind: "authenticated",
    submitter_user_id: null,
    submitter_email: "marketing@splashcarwashes.com",
    submitter_ip: null,
    submitted_at: "2026-10-23T12:00:00Z",
    status: "new",
    status_updated_at: null,
    status_updated_by: null,
    splash_notes: null,
    splash_notes_updated_at: null,
    splash_notes_updated_by: null,
    workflow_stage: stage,
    workflow_history: [],
    current_approver_emails: [DAN],
    version: {
      id: "v1",
      version_number: 1,
      published_at: null,
      published_by: null,
      schema: {
        fields: [
          { id: "f1", key: "site", type: "short_text", label: "Site #", required: true },
          {
            id: "f2",
            key: "packages",
            type: "package_price_grid",
            label: "Packages affected",
            required: true,
            keyFieldKey: "site",
            keyColumn: "pricing_simple.site"
          }
        ],
        workflow: {
          default_stage: "dan_review",
          stages: [
            {
              id: "dan_review",
              label: "Dan's approval",
              kind: "approval",
              approver_source: { type: "static_emails", emails: [DAN] },
              transitions: [
                { to: "approved", label: "Approve", requires: { signature: true } },
                { to: "denied", label: "Deny", requires: { note: true } }
              ]
            },
            { id: "approved", label: "Approved", kind: "outcome", transitions: [] },
            { id: "denied", label: "Denied", kind: "outcome", transitions: [] }
          ]
        }
      }
    },
    files: []
  };
}

interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: unknown;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function stub(opts: { link?: unknown; stage?: string; claimWins?: boolean } = {}) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname, params: url.searchParams, body });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

    if (url.pathname === "/rest/v1/form_approval_links") {
      if (method === "GET") return json(opts.link === undefined ? [linkRow()] : [opts.link].filter(Boolean));
      // PATCH: a claim carries used_at=is.null; an open-count bump does not.
      if (url.searchParams.get("used_at") === "is.null") {
        return json(opts.claimWins === false ? [] : [{ id: "link-1" }]);
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/rest/v1/form_submissions") {
      if (method === "GET") return json([submissionRow(opts.stage)]);
      return json([{ id: SUB }]);
    }
    throw new Error(`unexpected fetch ${method} ${url.pathname}`);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  puts.length = 0;
});

const PNG = `data:image/png;base64,${btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3))}`;

function post(fields: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request(`${HOST}/forms/approve/${TOKEN}`, {
    method: "POST",
    headers: { Origin: HOST, "CF-Connecting-IP": "203.0.113.9", "User-Agent": "TestMail/1.0" },
    body: fd
  });
}

const page = () => handleApprovalLinkPage(ENV, new Request(`${HOST}/forms/approve/${TOKEN}`), TOKEN);
const ctx = {} as ExecutionContext;

describe("GET /forms/approve/{token}", () => {
  it("shows the request, and opening it does not spend the link", async () => {
    stub();
    const first = await page();
    const second = await page();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const html = await first.text();
    expect(html).toContain("Ultimate");
    expect(html).toContain("$26.00");
    expect(html).toContain("(no change)");
    // Neither open was a claim.
    expect(calls.some((c) => c.params.get("used_at") === "is.null")).toBe(false);
  });

  it("refuses a link whose stage the submission has left", async () => {
    stub({ stage: "approved" });
    const res = await page();
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("moved on");
  });

  it("refuses a used link", async () => {
    stub({ link: linkRow({ used_at: "2026-10-23T13:00:00Z" }) });
    const res = await page();
    expect(res.status).toBe(410);
  });

  it("refuses an expired link", async () => {
    stub({ link: linkRow({ expires_at: "2026-01-01T00:00:00Z" }) });
    expect((await page()).status).toBe(410);
  });

  it("gives an unknown token the same 404 as a malformed one", async () => {
    stub({ link: null });
    expect((await page()).status).toBe(404);
  });
});

describe("POST /forms/approve/{token}", () => {
  it("does not spend the link when the signature is missing", async () => {
    stub();
    const res = await handleApprovalLinkSubmit(ENV, post({ to: "approved" }), TOKEN, ctx);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("needs a signature");
    expect(calls.some((c) => c.params.get("used_at") === "is.null")).toBe(false);
  });

  it("records an approval as via the emailed link, conditional on the stage", async () => {
    stub();
    const res = await handleApprovalLinkSubmit(
      ENV,
      post({ to: "approved", signature_png: PNG }),
      TOKEN,
      ctx
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Recorded: Approve");

    const write = calls.find((c) => c.method === "PATCH" && c.path === "/rest/v1/form_submissions");
    expect(write).toBeDefined();
    // Compare-and-set on the stage the link was minted for.
    expect(write!.params.get("workflow_stage")).toBe("eq.dan_review");
    const body = write!.body as {
      workflow_stage: string;
      status: string;
      workflow_history: Array<Record<string, unknown>>;
    };
    expect(body.workflow_stage).toBe("approved");
    expect(body.status).toBe("closed");
    const entry = body.workflow_history.at(-1)!;
    expect(entry.actor_email).toBe(DAN);
    expect(entry.via).toBe("email_link");
    expect(entry.actor_ip).toBe("203.0.113.9");
    expect(String(entry.signature_r2_key)).toMatch(/^transition-signatures\//);
    expect(puts).toHaveLength(1);
  });

  it("records a denial with its note", async () => {
    stub();
    const res = await handleApprovalLinkSubmit(
      ENV,
      post({ to: "denied", note: "Too soon after the last increase" }),
      TOKEN,
      ctx
    );
    expect(res.status).toBe(200);
    const write = calls.find((c) => c.method === "PATCH" && c.path === "/rest/v1/form_submissions");
    const body = write!.body as { workflow_history: Array<Record<string, unknown>> };
    expect(body.workflow_history.at(-1)!.note).toBe("Too soon after the last increase");
  });

  it("loses cleanly to a second click that claimed the link first", async () => {
    stub({ claimWins: false });
    const res = await handleApprovalLinkSubmit(
      ENV,
      post({ to: "denied", note: "x" }),
      TOKEN,
      ctx
    );
    expect(res.status).toBe(410);
    expect(calls.some((c) => c.method === "PATCH" && c.path === "/rest/v1/form_submissions")).toBe(false);
  });

  it("rejects a cross-site POST", async () => {
    stub();
    const req = new Request(`${HOST}/forms/approve/${TOKEN}`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: new FormData()
    });
    expect((await handleApprovalLinkSubmit(ENV, req, TOKEN, ctx)).status).toBe(403);
  });
});
