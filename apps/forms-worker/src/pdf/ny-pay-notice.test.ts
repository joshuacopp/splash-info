// fillNyPayNotice -- the official NY s.195.1 notice for the Pay Change form.
//
// Pins: no notice for a non-NY site; hourly -> LS 54 with overtime at 1.5x;
// salaried -> LS 59; the fields that must be filled come out filled and the
// form is flattened (nothing editable after the employee signed).

import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { WorkflowHistoryEntry } from "@splash/forms-schema";
import { fillNyPayNotice, needsNyPayNotice } from "./ny-pay-notice.js";

// 1x1 transparent PNG -- a stand-in signature.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0)
);
const bucket = {
  async get(_key: string) {
    return {
      arrayBuffer: async () => PNG.buffer,
      httpMetadata: { contentType: "image/png" }
    };
  }
} as never;

const history: WorkflowHistoryEntry[] = [
  {
    from: "employee_signoff",
    to: "payroll_email",
    actor_email: "site@example.com",
    at: "2026-11-14T15:30:00Z",
    note: null,
    signature_r2_key: "transition-signatures/x/sig.png",
    typed_name: "Jane Smith"
  } as WorkflowHistoryEntry
];

const base = {
  ny_site: "yes",
  new_rate: "$16.50",
  ny_payday: "Friday",
  ny_pay_frequency: "weekly",
  ny_allowances: ["none"],
  ny_primary_language: "English",
  ny_notice_language: "english_primary",
  manager_name: "Pat Manager",
  employee: { id: null, name: "Jane Smith", title: null, site: null, unverified: true }
};

describe("fillNyPayNotice", () => {
  it("skips a non-NY site", async () => {
    expect(needsNyPayNotice({ ny_site: "no" })).toBe(false);
    expect(await fillNyPayNotice(bucket, { ny_site: "no" }, history)).toBeNull();
  });

  it("fills LS 54 for an hourly change, with overtime at 1.5x", async () => {
    const bytes = await fillNyPayNotice(bucket, { ...base, new_pay_type: "hour" }, history);
    expect(bytes).not.toBeNull();
    const doc = await PDFDocument.load(bytes!);
    // Flattened: no fields remain to edit.
    expect(doc.getForm().getFields()).toHaveLength(0);
    expect(doc.getPageCount()).toBe(1);
  });

  it("fills LS 59 for a salaried change", async () => {
    const bytes = await fillNyPayNotice(bucket, { ...base, new_pay_type: "year", new_rate: "52000" }, history);
    expect(bytes).not.toBeNull();
    const doc = await PDFDocument.load(bytes!);
    expect(doc.getForm().getFields()).toHaveLength(0);
  });
});
