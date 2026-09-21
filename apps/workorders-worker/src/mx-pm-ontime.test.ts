// Tests for the current-week preventive on-time figure.
//
// The point of most of these is that the failure they guard against is a
// WRONG PERCENTAGE rather than an error. A number still appears either way,
// which is what makes it dangerous: the page would quietly disagree with the
// MaintainX report the operator checks it against.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPmOnTime } from "./mx-pm-ontime";

const ENV = {
  SUPABASE_URL: "https://db.example.com",
  SUPABASE_SERVICE_KEY: "service-key"
};

/** Captures the URLs requested and replies with `rows` once, then empty. */
function stubFetch(rows: unknown[]) {
  const urls: string[] = [];
  let served = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      const body = served ? [] : rows;
      served = true;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    })
  );
  return urls;
}

function row(over: Record<string, unknown> = {}) {
  return {
    mx_location_id: 1187635,
    due_date: "2026-09-15T01:00:00Z", // Mon 9 PM Eastern
    completed_at: "2026-09-15T01:00:00Z",
    status: "DONE",
    ...over
  };
}

// Wednesday 2026-09-16, midday Eastern. The week began Monday the 14th.
const WEDNESDAY = new Date("2026-09-16T16:00:00Z");

afterEach(() => vi.unstubAllGlobals());

describe("the query window", () => {
  it("spans the whole Mon-Sun week, including work not yet due", async () => {
    // Under MaintainX's definition future work BELONGS in the denominator:
    // being not-yet-due is what makes a row score as on time. Stopping at
    // today would drop rows the reference report counts.
    const urls = stubFetch([]);
    await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    const url = decodeURIComponent(urls[0]!);
    expect(url).toContain("due_date=gte.2026-09-14T04:00:00.000Z");
    expect(url).toContain("due_date=lt.2026-09-21T04:00:00.000Z");
  });

  it("ends the week correctly when the week contains a DST change", async () => {
    // The week of Mon 2026-10-26 is 169 hours long: DST ends on the Sunday.
    // Adding a flat seven days would land an hour short of Monday midnight.
    const urls = stubFetch([]);
    await fetchPmOnTime({
      env: ENV,
      mxLocationIds: [1],
      now: new Date("2026-10-28T16:00:00Z")
    });
    const url = decodeURIComponent(urls[0]!);
    expect(url).toContain("due_date=gte.2026-10-26T04:00:00.000Z");
    expect(url).toContain("due_date=lt.2026-11-02T05:00:00.000Z");
  });

  it("asks only for preventive, undeleted work at the caller's locations", async () => {
    // The location filter is the permission boundary. Dropping it would widen
    // the figure to the whole company with no visible symptom.
    const urls = stubFetch([]);
    await fetchPmOnTime({ env: ENV, mxLocationIds: [111, 222], now: WEDNESDAY });
    const url = decodeURIComponent(urls[0]!);
    expect(url).toContain("type=eq.PREVENTIVE");
    expect(url).toContain("deleted_at=is.null");
    expect(url).toContain("mx_location_id=in.(111,222)");
  });

  it("returns null without querying when the caller has no locations", async () => {
    const urls = stubFetch([]);
    expect(await fetchPmOnTime({ env: ENV, mxLocationIds: [], now: WEDNESDAY })).toBeNull();
    expect(urls).toHaveLength(0);
  });
});

describe("the MaintainX week, reproduced", () => {
  // The anchor case. These seven rows are Binghamton's real week of
  // 2026-09-14, and the MaintainX UI reported 5 on time / 2 overdue / 71.4%
  // for exactly this set. If this test fails, the page and the report the
  // operator cross-checks it against no longer agree.
  const BINGHAMTON_WEEK = [
    // Due Mon 2 PM, still open -> overdue
    row({ due_date: "2026-09-14T18:00:00Z", status: "OPEN", completed_at: null }),
    // Due Mon 11 PM, done Mon morning -> on time
    row({ due_date: "2026-09-15T03:00:00Z", completed_at: "2026-09-14T13:20:45Z" }),
    // Due Tue 11 PM, still open -> overdue
    row({ due_date: "2026-09-16T03:00:00Z", status: "OPEN", completed_at: null }),
    // Due Wed noon, done Mon -> on time
    row({ due_date: "2026-09-16T16:00:00Z", completed_at: "2026-09-14T18:48:37Z" }),
    // Due THU 10 AM, open, nothing done -> MaintainX says ON TIME
    row({ due_date: "2026-09-17T14:00:00Z", status: "OPEN", completed_at: null }),
    // Due Fri 9 PM, done Mon -> on time
    row({ due_date: "2026-09-19T01:00:00Z", completed_at: "2026-09-14T13:22:05Z" }),
    // Due SUN 9 PM, in progress, nothing done -> MaintainX says ON TIME
    row({ due_date: "2026-09-21T01:00:00Z", status: "IN_PROGRESS", completed_at: null })
  ];

  it("reports the headline preventative percentage as completed over due", async () => {
    // WHAT THE PAGE ACTUALLY SHOWS since 2026-09-21. The maintenance
    // department's preventative percentage is completion, with no reference
    // to due dates in the numerator: three of these seven are DONE, so this
    // same verified week reads 42.9% -- NOT the 71.4% on-time figure the
    // sibling test pins. Both are correct answers to different questions,
    // and confusing them is the whole reason this test exists.
    stubFetch(BINGHAMTON_WEEK);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall.due).toBe(7);
    expect(res?.overall.completed).toBe(3);
    const pct = Math.round((res!.overall.completed / res!.overall.due) * 1000) / 10;
    expect(pct).toBe(42.9);
  });

  it("reports 5 on time and 2 overdue out of 7", async () => {
    stubFetch(BINGHAMTON_WEEK);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall.due).toBe(7);
    expect(res?.overall.onTime).toBe(5);
    expect(res?.overall.overdue).toBe(2);
    const pct = Math.round((res!.overall.onTime / res!.overall.due) * 1000) / 10;
    expect(pct).toBe(71.4);
  });

  it("carries the stricter completed-by-due-date figure alongside it", async () => {
    // Only three of the seven were actually finished on time. The headline
    // says 5 because MaintainX counts not-yet-due work as on time; this is
    // the number that says what was really done.
    stubFetch(BINGHAMTON_WEEK);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall.completedOnTime).toBe(3);
    expect(res?.overall.completed).toBe(3);
  });
});

describe("classification", () => {
  it("counts untouched work that is not due yet as on time", async () => {
    // The defining oddity of the MaintainX definition, pinned deliberately so
    // nobody "fixes" it back into disagreeing with the report.
    stubFetch([row({ due_date: "2026-09-19T01:00:00Z", status: "OPEN", completed_at: null })]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall).toMatchObject({ due: 1, onTime: 1, overdue: 0, completedOnTime: 0 });
  });

  it("counts untouched work that IS past due as overdue", async () => {
    stubFetch([row({ due_date: "2026-09-14T18:00:00Z", status: "OPEN", completed_at: null })]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall).toMatchObject({ due: 1, onTime: 0, overdue: 1 });
  });

  it("treats work due TODAY as not yet overdue", async () => {
    // Due today at 9 PM, nothing done, and it is midday. Nobody is late yet.
    stubFetch([row({ due_date: "2026-09-17T01:00:00Z", status: "OPEN", completed_at: null })]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall).toMatchObject({ due: 1, onTime: 1, overdue: 0 });
  });

  it("counts a LATE completion as overdue", async () => {
    // The case that broke production. Scoring late completions as on time
    // meant closing a work order late moved it OUT of the red bucket, so
    // finishing late improved the score -- and every site pinned at 100%.
    stubFetch([row({ due_date: "2026-09-14T18:00:00Z", completed_at: "2026-09-16T14:00:00Z" })]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall).toMatchObject({
      due: 1,
      onTime: 0,
      overdue: 1,
      completedOnTime: 0,
      completed: 1
    });
  });

  it("cannot be improved by closing something late", async () => {
    // Stated as an invariant because it is the property that actually failed,
    // and it is easy to reintroduce while chasing agreement with the report.
    const overdueUndone = { due_date: "2026-09-14T18:00:00Z", status: "OPEN", completed_at: null };

    stubFetch([row(overdueUndone)]);
    const before = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });

    vi.unstubAllGlobals();
    // Same work order, now closed -- two days after it was due.
    stubFetch([row({ due_date: "2026-09-14T18:00:00Z", completed_at: "2026-09-16T14:00:00Z" })]);
    const after = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });

    expect(after!.overall.onTime).toBe(before!.overall.onTime);
    expect(after!.overall.overdue).toBe(before!.overall.overdue);
  });

  it("reads the due day in Eastern when UTC has already rolled over", async () => {
    // Due 9 PM WEDNESDAY Eastern = Thursday 01:00 UTC. In Eastern it is due
    // today and nobody is late; a UTC reading would place it on Thursday and,
    // at other hours of the day, on the wrong side of the line entirely.
    stubFetch([row({ due_date: "2026-09-17T01:00:00Z", status: "OPEN", completed_at: null })]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall).toMatchObject({ onTime: 1, overdue: 0 });
  });

  it("scores completion on the due day as completedOnTime", async () => {
    // Due 9 PM Monday, closed out 10 PM Monday. Late by the clock, on time by
    // the day -- and the due-date pills beside this figure work in days.
    stubFetch([row({ due_date: "2026-09-15T01:00:00Z", completed_at: "2026-09-15T02:00:00Z" })]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall).toMatchObject({ completedOnTime: 1 });
  });
});

describe("grouping", () => {
  it("splits by location and totals across them", async () => {
    stubFetch([
      row({ mx_location_id: 1, completed_at: "2026-09-14T13:00:00Z" }),
      row({
        mx_location_id: 1,
        due_date: "2026-09-14T18:00:00Z",
        status: "OPEN",
        completed_at: null
      }),
      row({ mx_location_id: 2, completed_at: "2026-09-14T13:00:00Z" })
    ]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1, 2], now: WEDNESDAY });
    expect(res?.byLocation[1]).toMatchObject({ due: 2, onTime: 1, overdue: 1 });
    expect(res?.byLocation[2]).toMatchObject({ due: 1, onTime: 1, overdue: 0 });
    expect(res?.overall).toMatchObject({ due: 3, onTime: 2, overdue: 1 });
  });

  it("omits a location with nothing due rather than reporting it as zero", async () => {
    // "No PM was due" and "PM was due and none of it was on time" are opposite
    // facts. Rendering both as 0% would be a lie about one of them.
    stubFetch([row({ mx_location_id: 1 })]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1, 2], now: WEDNESDAY });
    expect(res?.byLocation[2]).toBeUndefined();
  });
});

describe("failure", () => {
  it("returns null on a non-2xx rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    expect(await fetchPmOnTime({ env: ENV, mxLocationIds: [1], now: WEDNESDAY })).toBeNull();
  });

  it("returns null when the fetch throws rather than failing the page", async () => {
    // This figure rides along with the work-order list. Losing the percentage
    // is a nuisance; losing the list is an outage.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    expect(await fetchPmOnTime({ env: ENV, mxLocationIds: [1], now: WEDNESDAY })).toBeNull();
  });
});
