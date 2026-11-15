import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";

import type { Field, PdfBox } from "@splash/forms-schema";
import { answerText, fillPdfTemplate, readPageSizes, sourceText, type FillContext } from "./fill.js";

const fields = [
  { id: "1", key: "employee", type: "employee", label: "Employee", required: true },
  { id: "2", key: "effective_date", type: "date", label: "Effective", required: true },
  {
    id: "3",
    key: "new_pay_type",
    type: "radio",
    label: "Type",
    required: true,
    options: [
      { label: "Hour", value: "hour" },
      { label: "Year", value: "year" }
    ]
  }
] as unknown as Field[];

const ctx: FillContext = {
  fields,
  payload: { employee: { id: "e", name: "Jordan Smith", title: "", site: "122", unverified: false }, effective_date: "2026-11-23", new_pay_type: "hour" },
  history: [
    { from: "rd_review", to: "x", actor_email: "rd@x.com", actor_session_role: null, note: null, signature_r2_key: null, typed_name: null, at: "2026-11-16T15:30:00Z" },
    { from: "rd_review", to: "x", actor_email: "system@forms", actor_session_role: null, note: null, signature_r2_key: null, typed_name: null, at: "2026-11-16T16:00:00Z" },
    { from: "employee_signoff", to: "y", actor_email: "site@x.com", actor_session_role: null, note: null, signature_r2_key: "sig", typed_name: "Jordan Smith", at: "2026-11-17T03:30:00Z" }
  ],
  submissionId: "abcd1234-ffff",
  submittedAt: "2026-11-14T16:00:00Z"
};

describe("pdf template values", () => {
  it("formats answers the way a person writes them on paper", () => {
    expect(answerText(ctx, "employee")).toBe("Jordan Smith");
    expect(answerText(ctx, "effective_date")).toBe("11/23/2026");
    expect(answerText(ctx, "new_pay_type")).toBe("Hour");
  });

  it("reads approval-step parts from the latest HUMAN action, in Eastern time", () => {
    expect(sourceText(ctx, { type: "stage", stage: "rd_review", part: "by" })).toBe("rd@x.com");
    // 03:30Z on the 17th is still the 16th in New York.
    expect(sourceText(ctx, { type: "stage", stage: "employee_signoff", part: "date" })).toBe("11/16/2026");
    expect(sourceText(ctx, { type: "stage", stage: "employee_signoff", part: "by" })).toBe("Jordan Smith");
    expect(sourceText(ctx, { type: "submission_id" })).toBe("ABCD1234");
  });
});

describe("filling", () => {
  it("fills a blank PDF without changing its pages, and skips a box it cannot fill", async () => {
    const blank = await PDFDocument.create();
    blank.addPage([612, 792]);
    const bytes = await blank.save();
    const boxes: PdfBox[] = [
      { id: "a", page: 0, x: 50, y: 50, w: 200, h: 15, source: { type: "field", key: "employee" } },
      { id: "b", page: 0, x: 50, y: 80, w: 15, h: 15, source: { type: "check", key: "new_pay_type", value: "hour" } },
      // signature that isn't in the bucket: skipped, not fatal
      { id: "c", page: 0, x: 50, y: 120, w: 200, h: 40, source: { type: "stage", stage: "employee_signoff", part: "signature" } },
      // a box on a page the PDF doesn't have: ignored
      { id: "d", page: 3, x: 0, y: 0, w: 10, h: 10, source: { type: "submitted_date" } }
    ];
    const out = await fillPdfTemplate(bytes, boxes, ctx, { get: async () => null });
    expect(await readPageSizes(out)).toEqual([{ w: 612, h: 792 }]);
  });
});
