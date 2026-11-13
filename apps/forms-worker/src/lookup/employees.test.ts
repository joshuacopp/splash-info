// resolveEmployees -- the server's half of the Employee field.
//
// These pin the rules that stop the field from being used to dodge the
// confidential-form level check (PLAN_FORMS_PERSONNEL.md phase 3): a picked
// person's details come from the roster, never from the page; a typed name
// that resembles a real employee is refused; and a form can forbid typing.
// The network is the only stub.

import { afterEach, describe, expect, it } from "vitest";
import type { FormSchema } from "@splash/forms-schema";
import { resolveEmployees } from "./employees.js";

const ENV = { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_KEY: "k" } as never;
const PERSON_ID = "11111111-2222-4333-8444-555555555555";

function schema(allowTyped?: boolean): FormSchema {
  return {
    fields: [
      { id: "f1", key: "site", type: "short_text", label: "Site #", required: true },
      {
        id: "f2",
        key: "subject",
        type: "employee",
        label: "Employee",
        required: true,
        keyFieldKey: "site",
        keyColumn: "pricing_simple.site",
        ...(allowTyped === undefined ? {} : { allowTyped })
      }
    ]
  };
}

const realFetch = globalThis.fetch;
const calls: string[] = [];

/** Answers the three things resolveEmployees asks for. */
function stub(opts: {
  person?: Record<string, unknown> | null;
  near?: Array<Record<string, unknown>>;
  label?: string | null;
}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push(url.pathname);
    if (url.pathname.endsWith("/personnel_effective")) {
      return new Response(JSON.stringify(opts.person ? [opts.person] : []), { status: 200 });
    }
    if (url.pathname.endsWith("/rpc/employee_location_label")) {
      return new Response(JSON.stringify(opts.label ?? null), { status: 200 });
    }
    if (url.pathname.endsWith("/rpc/employee_near_matches")) {
      return new Response(JSON.stringify(opts.near ?? []), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

describe("resolveEmployees", () => {
  it("rewrites a picked person from the roster, ignoring what the page sent", async () => {
    stub({
      person: {
        beekeeper_user_id: PERSON_ID,
        display_name: "Jane Smith",
        position: "General Manager",
        org_unit_ids: [],
        works_at: "site",
        suspended: false
      },
      label: "Greenwich (040)"
    });
    const payload: Record<string, unknown> = {
      subject: { id: PERSON_ID, name: "Someone Else", title: "CEO" }
    };
    const r = await resolveEmployees(ENV, schema(), payload);
    expect(r.ok).toBe(true);
    expect(payload.subject).toEqual({
      id: PERSON_ID,
      name: "Jane Smith",
      title: "General Manager",
      site: "Greenwich (040)",
      unverified: false
    });
  });

  it("refuses a picked id that is not a current employee", async () => {
    stub({ person: null });
    const payload: Record<string, unknown> = { subject: { id: PERSON_ID, name: "Jane" } };
    const r = await resolveEmployees(ENV, schema(), payload);
    expect(r.ok).toBe(false);
  });

  it("refuses a typed name that closely matches a real employee", async () => {
    stub({ near: [{ display_name: "Jane Smith", location_label: "Greenwich (040)" }] });
    const payload: Record<string, unknown> = { subject: { id: null, name: "Jane Smyth" } };
    const r = await resolveEmployees(ENV, schema(), payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields.subject).toContain("Jane Smith");
  });

  it("stores an unmatched typed name as unverified", async () => {
    stub({ near: [] });
    const payload: Record<string, unknown> = { subject: { id: null, name: "  New   Hire " } };
    const r = await resolveEmployees(ENV, schema(), payload);
    expect(r.ok).toBe(true);
    expect(payload.subject).toEqual({
      id: null,
      name: "New Hire",
      title: null,
      site: null,
      unverified: true
    });
  });

  it("refuses any typed name when the form does not allow typing", async () => {
    stub({ near: [] });
    const payload: Record<string, unknown> = { subject: { id: null, name: "New Hire" } };
    const r = await resolveEmployees(ENV, schema(false), payload);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("drops a blank value so the required check decides", async () => {
    stub({});
    const payload: Record<string, unknown> = { subject: "" };
    const r = await resolveEmployees(ENV, schema(), payload);
    expect(r.ok).toBe(true);
    expect("subject" in payload).toBe(false);
  });
});
