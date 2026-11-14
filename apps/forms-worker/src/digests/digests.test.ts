import { describe, expect, it } from "vitest";

import type { Field } from "@splash/forms-schema";
import { digestConfigSchema, defaultDigestConfig } from "@splash/forms-schema";
import { chartData, tableData, OTHER_KEY, type AggregateContext, type DigestSubmission } from "./aggregate.js";
import { duePeriod, easternMidnightUtc, easternNow, periodFor } from "./period.js";
import { resolveAudiences } from "./audience.js";
import type { SiteContacts } from "./data.js";

describe("periods (Eastern)", () => {
  it("daily covers yesterday, weekly the 7 days ending yesterday, monthly last month", () => {
    expect(periodFor("daily", "2026-11-17")).toMatchObject({ key: "D:2026-11-16", from: "2026-11-16", to: "2026-11-16" });
    expect(periodFor("weekly", "2026-11-16")).toMatchObject({ key: "W:2026-11-09", from: "2026-11-09", to: "2026-11-15" });
    expect(periodFor("monthly", "2026-03-01")).toMatchObject({ key: "M:2026-02", from: "2026-02-01", to: "2026-02-28" });
  });

  it("bounds are Eastern midnights in UTC, across DST", () => {
    expect(easternMidnightUtc("2026-01-15").toISOString()).toBe("2026-01-15T05:00:00.000Z"); // EST
    expect(easternMidnightUtc("2026-07-15").toISOString()).toBe("2026-07-15T04:00:00.000Z"); // EDT
    // The week containing the November change: Sunday's midnight is still EDT.
    expect(easternMidnightUtc("2026-11-01").toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(easternMidnightUtc("2026-11-02").toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("is due from the send hour on the send day, not before, and not on other days", () => {
    const weekly = { frequency: "weekly" as const, hour: 7, weekday: 1 };
    // Mon 2026-11-16 06:59 EST = 11:59Z -> not yet; 07:05 EST -> due; Tue -> not due.
    expect(duePeriod(weekly, easternNow(new Date("2026-11-16T11:59:00Z")))).toBeNull();
    expect(duePeriod(weekly, easternNow(new Date("2026-11-16T12:05:00Z")))?.key).toBe("W:2026-11-09");
    expect(duePeriod(weekly, easternNow(new Date("2026-11-16T22:00:00Z")))?.key).toBe("W:2026-11-09"); // late same day still sends
    expect(duePeriod(weekly, easternNow(new Date("2026-11-17T12:05:00Z")))).toBeNull();
  });

  it("uses the Eastern day, not the UTC day, in the evening", () => {
    // 2026-11-16 23:30 EST is already 2026-11-17 in UTC.
    expect(easternNow(new Date("2026-11-17T04:30:00Z")).ymd).toBe("2026-11-16");
  });
});

const fields = [
  { id: "a", key: "pounds", type: "short_text", label: "Pounds of ice melt used", required: true, numeric: { integer: true } },
  {
    id: "b",
    key: "areas",
    type: "multi",
    label: "Areas",
    required: true,
    options: [
      { label: "Exit pad", value: "exit_pad" },
      { label: "Vacuums", value: "vacuums" }
    ]
  }
] as unknown as Field[];

const sites = new Map<string, SiteContacts>([
  ["vestal", { code: "vestal", name: "Vestal", number: "127", emails: { site_email: "vestal@x.com", rm_email: "rm1@x.com", am_email: "rd@x.com", hrt_email: null } }],
  ["binghamton", { code: "binghamton", name: "Binghamton", number: "122", emails: { site_email: "bing@x.com", rm_email: "rm1@x.com", am_email: "rd@x.com", hrt_email: null } }],
  ["oswego", { code: "oswego", name: "Oswego", number: "140", emails: { site_email: "osw@x.com", rm_email: "rm2@x.com", am_email: "rd@x.com", hrt_email: null } }]
]);

const ctx: AggregateContext = { fields, sites, period: periodFor("weekly", "2026-11-16") };

// Mon 11-09 and Tue 11-10 at 13:00 EST.
const sub = (id: string, day: string, site: string, pounds: string, areas: string[] = ["exit_pad"]): DigestSubmission => ({
  id,
  submitted_at: `${day}T18:00:00Z`,
  location_code: site,
  payload: { pounds, areas }
});
const subs = [
  sub("1", "2026-11-09", "vestal", "50"),
  sub("2", "2026-11-09", "vestal", "100", ["exit_pad", "vacuums"]),
  sub("3", "2026-11-10", "binghamton", "25"),
  sub("4", "2026-11-10", "oswego", "abc") // not a number: counted, not summed
];

describe("aggregation", () => {
  it("lists every day of the period, zero-filled, and sums by site", () => {
    const d = chartData(ctx, subs, { type: "bar", x: "day", y: { agg: "sum", field_key: "pounds" }, split: "site" });
    expect(d.x).toHaveLength(7);
    expect(d.series.map((s) => s.label)).toEqual(["Binghamton", "Oswego", "Vestal"]);
    const vestal = d.series.find((s) => s.key === "vestal")!;
    expect(vestal.values.slice(0, 3)).toEqual([150, 0, 0]);
  });

  it("counts a multi answer in each bucket it ticks", () => {
    const d = chartData(ctx, subs, { type: "pie", x: "field:areas", y: { agg: "count" } });
    expect(Object.fromEntries(d.x.map((b, i) => [b.label, d.series[0]!.values[i]]))).toEqual({ "Exit pad": 4, Vacuums: 1 });
  });

  it("folds series past seven into Other, computed from submissions", () => {
    const many: DigestSubmission[] = Array.from({ length: 10 }, (_, i) => sub(String(i), "2026-11-09", `s${i}`, String(10 + i)));
    const d = chartData(ctx, many, { type: "bar", x: "day", y: { agg: "sum", field_key: "pounds" }, split: "site" });
    expect(d.series).toHaveLength(8);
    const other = d.series.find((s) => s.key === OTHER_KEY)!;
    expect(other.values[0]).toBe(10 + 11 + 12); // the three smallest
  });

  it("summary table: site, then day, with site totals", () => {
    const t = tableData(ctx, subs, { kind: "summary", group: "site_day", metrics: [{ agg: "count" }, { agg: "sum", field_key: "pounds" }] })!;
    const vestal = t.sections.find((s) => s.title === "Vestal")!;
    expect(vestal.rows).toEqual([["Mon Nov 9", "2", "150"]]);
    expect(vestal.total).toEqual(["Site total", "2", "150"]);
    expect(t.grandTotal).toEqual(["All sites", "4", "175"]);
  });
});

describe("audiences", () => {
  it("scopes each role holder to their own sites and merges duplicates", () => {
    const c = { ...defaultDigestConfig(), recipients: [{ type: "site_role" as const, role: "rm_email" as const }, { type: "static" as const, emails: ["Boss@x.com"] }] };
    const a = Object.fromEntries(resolveAudiences(c, sites).map((x) => [x.email, x.sites === "all" ? "all" : [...x.sites].sort()]));
    expect(a).toEqual({ "rm1@x.com": ["binghamton", "vestal"], "rm2@x.com": ["oswego"], "boss@x.com": "all" });
  });
});

describe("config validation", () => {
  it("rejects a split pie and an empty email", () => {
    const base = defaultDigestConfig();
    expect(digestConfigSchema.safeParse(base).success).toBe(true);
    expect(digestConfigSchema.safeParse({ ...base, charts: [{ type: "pie", x: "site", y: { agg: "count" }, split: "day" }] }).success).toBe(false);
    expect(digestConfigSchema.safeParse({ ...base, charts: [], table: { kind: "none" } }).success).toBe(false);
  });
});
