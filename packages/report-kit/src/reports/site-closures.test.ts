import { describe, expect, it } from "vitest";
import { summarizeClosures, toClosureRows, type SiteClosureRecord } from "./site-closures";

const base = (over: Partial<SiteClosureRecord>): SiteClosureRecord => ({
  id: Math.random().toString(36).slice(2),
  site_number: 122,
  site_name: "Binghamton",
  rd_name: "Rita",
  rm_name: "Mike",
  reason: "power",
  reason_detail: null,
  closed_at: "2026-11-10T14:00:00Z",
  closed_by: "rm@x",
  original_est_reopen_at: "2026-11-10T16:00:00Z",
  est_reopen_at: "2026-11-10T16:00:00Z",
  estimate_changes: [],
  reopened_at: "2026-11-10T17:00:00Z",
  reopened_by: "Pat",
  reopened_via: "link",
  ...over
});

describe("site closures report", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  const rows = toClosureRows(
    [
      base({}), // 3h, 1h over its 2h estimate
      base({ closed_at: "2026-11-12T14:00:00Z", original_est_reopen_at: "2026-11-12T18:00:00Z", reopened_at: "2026-11-12T15:30:00Z", reason: "weather" }), // 1.5h, early
      base({ site_number: 127, site_name: "Vestal", closed_at: "2026-11-15T10:00:00Z", original_est_reopen_at: "2026-11-15T20:00:00Z", reopened_at: null }) // still closed, 2h so far
    ],
    now
  );

  it("works out hours closed, counting an open closure up to now", () => {
    expect(rows.map((r) => r.hours_closed)).toEqual([3, 1.5, 2]);
    expect(rows[0]?.hours_over_estimate).toBe(1);
    expect(rows[2]?.still_closed).toBe(true);
  });

  it("carries the reopen note and lists only the estimate changes that had a note", () => {
    const [r] = toClosureRows(
      [
        base({
          reopen_note: "Power back on",
          estimate_changes: [
            { at: "2026-11-10T15:00:00Z", by: "rm@x", from: "2026-11-10T16:00:00Z", to: "2026-11-10T18:00:00Z", note: "Parts late" },
            { at: "2026-11-10T15:30:00Z", by: "rm@x", from: "2026-11-10T18:00:00Z", to: "2026-11-10T17:00:00Z", note: null }
          ]
        })
      ],
      now
    );
    expect(r?.reopen_note).toBe("Power back on");
    expect(r?.estimate_change_count).toBe(2);
    expect(r?.estimate_notes.split("\n")).toHaveLength(1);
    expect(r?.estimate_notes).toContain("rm@x");
    expect(r?.estimate_notes).toMatch(/: Parts late$/);
  });

  it("summarises by site, reason and week, with every week present", () => {
    const s = summarizeClosures(rows, { fromYmd: "2026-11-01", toYmd: "2026-11-15" });
    expect(s.kpis).toMatchObject({ closures: 3, sites: 2, hours: 6.5, still_closed: 1 });
    // Of the two FINISHED closures, one ran past its estimate.
    expect(s.kpis.over_estimate_rate).toBe(0.5);
    expect(s.by_site[0]).toMatchObject({ label: "Binghamton (122)", closures: 2, hours: 4.5, longest_hours: 3 });
    expect(s.by_reason.map((g) => g.key).sort()).toEqual(["power", "weather"]);
    // Weeks of 10/26, 11/2, 11/9 (all three closures fall in the 11/9 week).
    expect(s.by_week.map((w) => [w.week, w.closures])).toEqual([
      ["2026-10-26", 0],
      ["2026-11-02", 0],
      ["2026-11-09", 3]
    ]);
  });
});
