import { describe, expect, it } from "vitest";

import {
  csvField,
  defineReport,
  exportFilename,
  parseReportParams,
  resolveRange,
  toCsv,
  easternStartOfDay,
  easternYmd
} from "./index";

// 2026-10-31 00:30 UTC is still Oct 30 in Eastern (EDT, UTC-4). A UTC "today"
// says Oct 31 here -- the exact bug class this kit exists to remove.
const LATE_EVENING_ET = new Date("2026-10-31T00:30:00Z");

describe("Eastern calendar", () => {
  it("uses the Eastern date, not the UTC date, late in the evening", () => {
    expect(easternYmd(LATE_EVENING_ET)).toEqual({ y: 2026, m: 10, d: 30 });
  });

  it("puts midnight at UTC-4 in summer and UTC-5 in winter", () => {
    expect(easternStartOfDay({ y: 2026, m: 7, d: 1 }).toISOString()).toBe("2026-07-01T04:00:00.000Z");
    expect(easternStartOfDay({ y: 2026, m: 1, d: 15 }).toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  it("handles both DST changeover days (23- and 25-hour days)", () => {
    // 2026-03-08 spring forward: midnight is still EST.
    const spring = resolveRange({ from: "2026-03-08", to: "2026-03-08" }, "today");
    expect(spring.fromIso).toBe("2026-03-08T05:00:00.000Z");
    expect(spring.toIso).toBe("2026-03-09T03:59:59.999Z"); // 23 hours later
    // 2026-11-01 fall back: midnight is still EDT.
    const fall = resolveRange({ from: "2026-11-01", to: "2026-11-01" }, "today");
    expect(fall.fromIso).toBe("2026-11-01T04:00:00.000Z");
    expect(fall.toIso).toBe("2026-11-02T04:59:59.999Z"); // 25 hours later
  });
});

describe("resolveRange presets", () => {
  const at = (p: string) => resolveRange({ range: p }, "today", LATE_EVENING_ET);

  it.each([
    ["today", "2026-10-30", "2026-10-30"],
    ["yesterday", "2026-10-29", "2026-10-29"],
    ["last_7", "2026-10-24", "2026-10-30"],
    ["last_30", "2026-10-01", "2026-10-30"],
    ["mtd", "2026-10-01", "2026-10-30"],
    ["past_month", "2026-09-01", "2026-09-30"],
    ["qtd", "2026-10-01", "2026-10-30"],
    ["past_quarter", "2026-07-01", "2026-09-30"],
    ["ytd", "2026-01-01", "2026-10-30"]
  ])("%s", (preset, from, to) => {
    const r = at(preset);
    expect([r.preset, r.fromYmd, r.toYmd]).toEqual([preset, from, to]);
  });

  it("past_quarter crosses the year boundary in Q1", () => {
    const r = resolveRange({ range: "past_quarter" }, "today", new Date("2026-02-10T15:00:00Z"));
    expect([r.fromYmd, r.toYmd]).toEqual(["2025-10-01", "2025-12-31"]);
  });
});

describe("resolveRange explicit and bad input", () => {
  it("takes explicit from/to as a custom range", () => {
    const r = resolveRange({ from: "2026-10-01", to: "2026-10-15" }, "last_30", LATE_EVENING_ET);
    expect([r.preset, r.fromYmd, r.toYmd, r.invalidInput]).toEqual(["custom", "2026-10-01", "2026-10-15", false]);
  });

  it("a preset beats from/to", () => {
    const r = resolveRange({ range: "yesterday", from: "2020-01-01" }, "last_30", LATE_EVENING_ET);
    expect(r.preset).toBe("yesterday");
  });

  it.each([
    [{ from: "2026-13-01" }],
    [{ from: "2026-02-30" }],
    [{ from: "not-a-date" }],
    [{ from: "2026-10-20", to: "2026-10-01" }]
  ])("falls back to the default on %j, and says so", (input) => {
    const r = resolveRange(input, "last_30", LATE_EVENING_ET);
    expect([r.preset, r.fromYmd, r.toYmd, r.invalidInput]).toEqual(["last_30", "2026-10-01", "2026-10-30", true]);
  });
});

describe("csv", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });

  it("guards text cells that Excel would run as formulas", () => {
    expect(csvField("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvField("+15551234567")).toBe("'+15551234567");
    expect(csvField("@cmd")).toBe("'@cmd");
    expect(csvField("-x")).toBe("'-x");
  });

  it("never prefixes real numbers", () => {
    expect(csvField(-5)).toBe("-5");
    expect(csvField(0)).toBe("0");
  });

  it("writes a BOM, CRLF, export columns only, ids as headers", () => {
    const def = defineReport<{ id: string; n: number; note: string }>({
      id: "t",
      title: "T",
      defaultRange: "today",
      presets: [],
      filters: [],
      rowKey: (r) => r.id,
      columns: [
        { id: "id", label: "ID", kind: "text" },
        { id: "n", label: "N", kind: "number" },
        { id: "note", label: "Note", kind: "text", in: ["table"] }
      ]
    });
    expect(toCsv(def, [{ id: "a", n: -2, note: "hidden" }])).toBe("﻿id,n\r\na,-2\r\n");
  });
});

describe("parseReportParams", () => {
  const def = defineReport<{ id: string }>({
    id: "fleet-submissions",
    title: "F",
    defaultRange: "last_30",
    presets: [],
    filters: [{ id: "status", label: "Status", options: [{ value: "new", label: "New" }] }],
    rowKey: (r) => r.id,
    columns: [{ id: "id", label: "ID", kind: "text" }]
  });

  it("reads Next-style records and URLSearchParams the same way", () => {
    const a = parseReportParams(def, { from: "2026-10-01", to: ["2026-10-02"], status: "new" }, LATE_EVENING_ET);
    const b = parseReportParams(def, new URLSearchParams("from=2026-10-01&to=2026-10-02&status=new"), LATE_EVENING_ET);
    expect(a).toEqual(b);
    expect(a.filters).toEqual({ status: "new" });
  });

  it("drops a filter value the report does not declare", () => {
    expect(parseReportParams(def, { status: "drop table" }).filters).toEqual({});
  });

  it("names exports from the Eastern range", () => {
    const { range } = parseReportParams(def, {}, LATE_EVENING_ET);
    expect(exportFilename(def, range, "csv")).toBe("fleet-submissions-2026-10-01-to-2026-10-30.csv");
  });

  it("maps a legacy days=N bookmark to N days ago through today (Eastern)", () => {
    const legacy = defineReport<{ id: string }>({ ...def, legacyDays: [1, 7, 30] });
    const { range } = parseReportParams(legacy, { days: "7" }, LATE_EVENING_ET);
    expect([range.fromYmd, range.toYmd]).toEqual(["2026-10-23", "2026-10-30"]);
    expect(range.preset).toBe("custom");
  });

  it("ignores days when the report has no legacy list, the value is not listed, or range/from/to is present", () => {
    const legacy = defineReport<{ id: string }>({ ...def, legacyDays: [1, 7, 30] });
    const dflt = parseReportParams(def, {}, LATE_EVENING_ET).range;
    expect(parseReportParams(def, { days: "7" }, LATE_EVENING_ET).range).toEqual(dflt);
    expect(parseReportParams(legacy, { days: "5" }, LATE_EVENING_ET).range).toEqual(dflt);
    expect(parseReportParams(legacy, { days: "7", range: "ytd" }, LATE_EVENING_ET).range.preset).toBe("ytd");
    expect(parseReportParams(legacy, { days: "7", from: "2026-10-01", to: "2026-10-02" }, LATE_EVENING_ET).range.fromYmd).toBe("2026-10-01");
  });

  it("rejects duplicate column ids at definition time", () => {
    expect(() =>
      defineReport<{ a: string }>({
        id: "x",
        title: "x",
        defaultRange: "today",
        presets: [],
        filters: [],
        rowKey: (r) => r.a,
        columns: [
          { id: "a", label: "A", kind: "text" },
          { id: "a", label: "A2", kind: "text" }
        ]
      })
    ).toThrow(/duplicate/);
  });
});

describe("signups report", () => {
  it("keeps the pre-kit CSV header order, with the Brief 142 columns appended", async () => {
    const { signupsReport } = await import("./reports/signups");
    const header = toCsv(signupsReport, []).replace(/^﻿/, "").split("\r\n")[0];
    expect(header).toBe(
      "id,submitted_at,name,email,phone,phone_formatted,location_code,location_pretty," +
        "package,package_pretty,today_price,monthly_price,terms_text,country,city,region," +
        "user_agent,confirmation_token,is_bogo,recurring_start_date"
    );
  });

  it("fills `package` from package_code and leaves `name` blank", async () => {
    const { signupsReport } = await import("./reports/signups");
    const csv = toCsv(signupsReport, [
      { id: 7, submitted_at: "2026-10-30T14:00:00Z", email: "a@b.co", phone_formatted: "(607) 555-0100",
        package_code: "ultimate", package_pretty: "Ultimate", today_price: 29.99, city: null, region: null }
    ]);
    const row = csv.split("\r\n")[1].split(",");
    expect(row[2]).toBe("");
    expect(row[8]).toBe("ultimate");
    expect(row[10]).toBe("29.99");
  });
});
