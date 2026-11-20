import { describe, expect, it } from "vitest";
import {
  attendanceSignatureKey,
  parseAttendanceSignatureKey,
  formatAttendanceValue,
  type FormSchema
} from "@splash/forms-schema";
import { parseSubmitFormData } from "./parse.js";
import { monthOf } from "../required-topics/index.js";

const schema = {
  fields: [
    { id: "a", key: "site_number", type: "short_text", label: "Site", required: true },
    { id: "b", key: "meeting_date", type: "date", label: "Date", required: true },
    {
      id: "c", key: "attendees", type: "attendance", label: "Sheet", required: true,
      keyFieldKey: "site_number", keyColumn: "pricing_simple.site"
    },
    {
      id: "d", key: "required_topics", type: "required_topics", label: "Topics", required: true,
      listKey: "safety_meeting", dateFieldKey: "meeting_date"
    }
  ]
} as unknown as FormSchema;

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("pending_submission_id", "11111111-1111-4111-8111-111111111111");
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("attendance parse", () => {
  it("drops fully blank rows and keeps half-filled ones for checkAttendance to refuse", () => {
    const rows = [
      { employee: { id: null, name: "Jane Smith" }, sig: "form-submission-files/f/p/attendees__sig_0/signature.png" },
      { employee: null, sig: "" },
      { employee: { id: null, name: "Bob Jones" }, sig: "" },
      { employee: null, sig: "form-submission-files/f/p/attendees__sig_3/signature.png" }
    ];
    const { payload } = parseSubmitFormData(form({ attendees: JSON.stringify(rows) }), schema);
    const got = payload.attendees as Array<{ employee: unknown; signature: unknown }>;
    expect(got).toHaveLength(3);
    expect(got[1]).toEqual({ employee: { id: null, name: "Bob Jones" }, signature: null });
    expect(got[2]!.employee).toBeNull();
  });

  it("an empty or garbled sheet parses to no rows", () => {
    expect(parseSubmitFormData(form({ attendees: "not json" }), schema).payload.attendees).toEqual([]);
    expect(parseSubmitFormData(form({}), schema).payload.attendees).toEqual([]);
  });

  it("carries required-topic ticks forward as given (the server re-reads the list)", () => {
    const { payload } = parseSubmitFormData(form({ required_topics: '["Salt logs", 5]' }), schema);
    expect(payload.required_topics).toEqual({ ticked: ["Salt logs"] });
  });
});

describe("attendance signature keys", () => {
  it("round-trips and rejects out-of-range or foreign keys", () => {
    expect(parseAttendanceSignatureKey(attendanceSignatureKey("attendees", 12))).toEqual({ fieldKey: "attendees", row: 12 });
    expect(parseAttendanceSignatureKey("attendees__sig_80")).toBeNull();
    expect(parseAttendanceSignatureKey("attendees")).toBeNull();
    expect(parseAttendanceSignatureKey("../x__sig_1")).toBeNull();
  });

  it("formats a sheet as a count and names", () => {
    const sig = { r2_key: "k", format: "png" as const };
    expect(
      formatAttendanceValue([
        { employee: { id: "x", name: "Jane", title: null, site: null, unverified: false }, signature: sig },
        { employee: { id: null, name: "Bob", title: null, site: null, unverified: true }, signature: sig }
      ])
    ).toBe("2 signed: Jane, Bob (typed)");
  });
});

describe("monthOf", () => {
  it("takes the month of a date", () => {
    expect(monthOf("2026-12-03")).toBe("2026-12");
    expect(monthOf("2026-13-01")).toBeNull();
    expect(monthOf("")).toBeNull();
  });
});
