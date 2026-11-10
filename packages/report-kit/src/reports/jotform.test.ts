import { describe, expect, it } from "vitest";

import { parseReportParams, toCsv } from "../index";
import {
  jotformAnswerText,
  jotformExportReport,
  jotformReport,
  jotformReportFor,
  sortJotformExportRows,
  type JotformReportRow
} from "./jotform";

const row = (over: Partial<JotformReportRow>): JotformReportRow => ({
  id: "1",
  site: "Binghamton",
  site_number: "122",
  jotform_created_at: "2026-11-10T14:00:00.000Z",
  answers: {},
  ...over
});

describe("jotform report", () => {
  it("defaults to today in Eastern", () => {
    const { range } = parseReportParams(jotformReport, {}, new Date("2026-11-11T03:00:00Z"));
    expect(range.fromYmd).toBe("2026-11-10");
    expect(range.toYmd).toBe("2026-11-10");
  });

  it("keeps honouring the pre-kit from/to URL", () => {
    const { range } = parseReportParams(jotformReport, { from: "2026-11-01", to: "2026-11-09" });
    expect([range.preset, range.fromYmd, range.toYmd]).toEqual(["custom", "2026-11-01", "2026-11-09"]);
  });

  it("adds a registered form's answer columns after Submitted and Site", () => {
    expect(jotformReportFor("250165655616055").columns.map((c) => c.label)).toEqual([
      "Submitted",
      "Site",
      "Rewash Reason"
    ]);
    expect(jotformReportFor("unknown").columns).toHaveLength(2);
  });

  it("reads prettyFormat before answer", () => {
    const r = row({ answers: { "4": { answer: { first: "A" }, prettyFormat: "A B" } } });
    expect(jotformAnswerText(r, "4")).toBe("A B");
  });

  it("exports the schema union with question-text headers, duplicates keyed", () => {
    const rows = sortJotformExportRows([
      row({ id: "2", site: "Vestal", answers: { "5": { text: "Name", answer: "=cmd" } } }),
      row({ id: "1", answers: { "4": { text: "Name", answer: "-5" } } })
    ]);
    const lines = toCsv(jotformExportReport(rows), rows).replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe(
      "site,id,jotform_created_at,jotform_updated_at,site_number,site_email,jotform_status,Name (4),Name (5)"
    );
    // Binghamton sorts before Vestal; a typed negative stays a number; a formula is guarded.
    expect(lines[1]?.startsWith("Binghamton,1,")).toBe(true);
    expect(lines[1]?.endsWith(",-5,")).toBe(true);
    expect(lines[2]?.endsWith(",,'=cmd")).toBe(true);
  });
});
