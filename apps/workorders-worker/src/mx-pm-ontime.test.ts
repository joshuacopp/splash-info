// Tests for the current-week preventive on-time figure.
//
// The two things worth guarding are the ones that would produce a WRONG
// PERCENTAGE rather than an error: the shape of the query window, and the
// on-time comparison. Both fail silently -- a number still appears.

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
  it("runs from Monday 00:00 Eastern to the end of today, not the end of the week", () => {
    // The whole-week denominator is the trap: on a Wednesday it counts
    // Thursday-Sunday's work as failed. MEASURED, that reads 61.5% against a
    // true 77.3%.
    const urls = stubFetch([]);
    return fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY }).then(() => {
      const url = decodeURIComponent(urls[0]!);
      expect(url).toContain("due_date=gte.2026-09-14T04:00:00.000Z");
      expect(url).toContain("due_date=lt.2026-09-17T04:00:00.000Z");
    });
  });

  it("stops at the end of the week even if `now` has run past it", () => {
    // A stale clock must not pull next week's work into this week's figure.
    const urls = stubFetch([]);
    return fetchPmOnTime({
      env: ENV,
      mxLocationIds: [1187635],
      // Sunday 9 PM Eastern -- the last hours of the week.
      now: new Date("2026-09-21T01:00:00Z")
    }).then(() => {
      const url = decodeURIComponent(urls[0]!);
      expect(url).toContain("due_date=gte.2026-09-14T04:00:00.000Z");
      expect(url).toContain("due_date=lt.2026-09-21T04:00:00.000Z");
    });
  });

  it("asks only for preventive, undeleted work at the caller's locations", () => {
    // The location filter is the permission boundary. Dropping it would widen
    // the figure to the whole company with no visible symptom.
    const urls = stubFetch([]);
    return fetchPmOnTime({ env: ENV, mxLocationIds: [111, 222], now: WEDNESDAY }).then(() => {
      const url = decodeURIComponent(urls[0]!);
      expect(url).toContain("type=eq.PREVENTIVE");
      expect(url).toContain("deleted_at=is.null");
      expect(url).toContain("mx_location_id=in.(111,222)");
    });
  });

  it("returns null without querying when the caller has no locations", async () => {
    const urls = stubFetch([]);
    expect(await fetchPmOnTime({ env: ENV, mxLocationIds: [], now: WEDNESDAY })).toBeNull();
    expect(urls).toHaveLength(0);
  });
});

describe("the on-time test", () => {
  it("counts completion on the due day as on time", async () => {
    // Due 9 PM Monday, closed out 10 PM Monday. Late by the clock, on time by
    // the day -- and the due-date pills beside this figure work in days.
    stubFetch([
      row({ due_date: "2026-09-15T01:00:00Z", completed_at: "2026-09-15T02:00:00Z" })
    ]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall).toEqual({ due: 1, onTime: 1 });
  });

  it("compares days in EASTERN, not UTC", async () => {
    // Due 9 PM Monday Eastern (= Tuesday 01:00 UTC), completed 8 PM Monday
    // Eastern (= Tuesday 00:00 UTC). Both are Monday in Eastern, so this is
    // on time -- and in UTC both are Tuesday, which would ALSO read on time.
    // The discriminating case is the next one.
    stubFetch([
      row({ due_date: "2026-09-15T01:00:00Z", completed_at: "2026-09-15T00:00:00Z" })
    ]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall).toEqual({ due: 1, onTime: 1 });
  });

  it("catches the case UTC comparison would get wrong", async () => {
    // Due 11 PM Monday Eastern (Tue 03:00 UTC). Completed 6 PM TUESDAY Eastern
    // (Tue 22:00 UTC) -- a day late. In UTC both fall on Tuesday and it would
    // score as on time; in Eastern it is Monday vs Tuesday and it is late.
    stubFetch([
      row({ due_date: "2026-09-15T03:00:00Z", completed_at: "2026-09-15T22:00:00Z" })
    ]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall).toEqual({ due: 1, onTime: 0 });
  });

  it("counts an unfinished work order as due but not on time", async () => {
    stubFetch([row({ status: "OPEN", completed_at: null })]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall).toEqual({ due: 1, onTime: 0 });
  });

  it("counts a late completion as due but not on time", async () => {
    stubFetch([
      row({ due_date: "2026-09-15T01:00:00Z", completed_at: "2026-09-17T14:00:00Z" })
    ]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1187635], now: WEDNESDAY });
    expect(res?.overall).toEqual({ due: 1, onTime: 0 });
  });
});

describe("grouping", () => {
  it("splits by location and totals across them", async () => {
    stubFetch([
      row({ mx_location_id: 1, completed_at: "2026-09-15T01:00:00Z" }),
      row({ mx_location_id: 1, status: "OPEN", completed_at: null }),
      row({ mx_location_id: 2, completed_at: "2026-09-15T01:00:00Z" })
    ]);
    const res = await fetchPmOnTime({ env: ENV, mxLocationIds: [1, 2], now: WEDNESDAY });
    expect(res?.byLocation[1]).toEqual({ due: 2, onTime: 1 });
    expect(res?.byLocation[2]).toEqual({ due: 1, onTime: 1 });
    expect(res?.overall).toEqual({ due: 3, onTime: 2 });
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 }))
    );
    expect(
      await fetchPmOnTime({ env: ENV, mxLocationIds: [1], now: WEDNESDAY })
    ).toBeNull();
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
    expect(
      await fetchPmOnTime({ env: ENV, mxLocationIds: [1], now: WEDNESDAY })
    ).toBeNull();
  });
});
