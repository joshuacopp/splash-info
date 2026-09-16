// Boundary arithmetic for Eastern days and weeks.
//
// These matter more than their size suggests: every one of them is a silent
// failure if wrong. A week that starts an hour late moves work orders between
// weeks with no error anywhere, and the resulting percentage still looks
// perfectly plausible.

import { describe, expect, it } from "vitest";
import {
  easternDayStartOf,
  easternDaysSinceMonday,
  easternNextDayStartOf,
  easternWeekStartOf,
  easternYmd
} from "./eastern-time";

describe("easternDayStartOf", () => {
  it("uses the offset in force at midnight, not at the given instant", () => {
    // Midday on 2026-03-08 is EDT (-04:00), but that day STARTED in EST
    // (-05:00) -- DST began at 2 AM. Reading the offset at midday and applying
    // it to midnight lands an hour into March 7.
    expect(easternDayStartOf(new Date("2026-03-08T16:00:00Z"))).toBe(
      "2026-03-08T05:00:00.000Z"
    );
  });

  it("does the same across the fall-back boundary", () => {
    // Midday 2026-11-01 is EST; the day started in EDT.
    expect(easternDayStartOf(new Date("2026-11-01T17:00:00Z"))).toBe(
      "2026-11-01T04:00:00.000Z"
    );
  });

  it("is idempotent -- the start of a day is its own day's start", () => {
    for (const at of ["2026-03-08T05:00:00Z", "2026-11-01T04:00:00Z", "2026-09-16T04:00:00Z"]) {
      const start = easternDayStartOf(new Date(at));
      expect(easternDayStartOf(new Date(start))).toBe(start);
    }
  });
});

describe("easternYmd", () => {
  it("reports the Eastern date, not the UTC one", () => {
    // 01:00 UTC Tuesday is 9 PM Monday in Eastern -- the single most common
    // preventive due time in the data (1,768 rows over eight weeks). Getting
    // this backwards misdates two thirds of preventive work by a day.
    expect(easternYmd(new Date("2026-09-15T01:00:00Z"))).toBe("2026-09-14");
    expect(easternYmd(new Date("2026-09-15T13:00:00Z"))).toBe("2026-09-15");
  });
});

describe("easternDaysSinceMonday", () => {
  it("counts Monday as 0 and Sunday as 6", () => {
    // 2026-09-14 is a Monday.
    const days = ["14", "15", "16", "17", "18", "19", "20"].map((d) =>
      easternDaysSinceMonday(new Date(`2026-09-${d}T16:00:00Z`))
    );
    expect(days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("reads the weekday in Eastern, not UTC", () => {
    // Sunday 9 PM Eastern is already Monday in UTC. The week it belongs to is
    // the one that is ending, not the one starting.
    expect(easternDaysSinceMonday(new Date("2026-09-21T01:00:00Z"))).toBe(6);
  });
});

describe("easternWeekStartOf", () => {
  it("returns Monday 00:00 Eastern for every day of that week", () => {
    const expected = "2026-09-14T04:00:00.000Z";
    for (const d of ["14", "15", "16", "17", "18", "19", "20"]) {
      expect(easternWeekStartOf(new Date(`2026-09-${d}T16:00:00Z`))).toBe(expected);
    }
  });

  it("rolls to the next week on Monday, not on Sunday evening", () => {
    // 2026-09-21T01:00Z is Sunday 9 PM Eastern -- still the old week.
    expect(easternWeekStartOf(new Date("2026-09-21T01:00:00Z"))).toBe(
      "2026-09-14T04:00:00.000Z"
    );
    // ...and 2026-09-21T16:00Z is Monday noon Eastern -- the new one.
    expect(easternWeekStartOf(new Date("2026-09-21T16:00:00Z"))).toBe(
      "2026-09-21T04:00:00.000Z"
    );
  });

  it("survives the week containing a DST change", () => {
    // DST began Sunday 2026-03-08, so the week of Monday 2026-03-02 is 167
    // hours long. Subtracting flat 24-hour blocks lands an hour off.
    for (const d of ["02", "05", "08"]) {
      expect(easternWeekStartOf(new Date(`2026-03-${d}T16:00:00Z`))).toBe(
        "2026-03-02T05:00:00.000Z"
      );
    }
  });

  it("survives the 169-hour fall-back week", () => {
    // DST ended Sunday 2026-11-01; the week of Monday 2026-10-26.
    for (const d of ["26", "29"]) {
      expect(easternWeekStartOf(new Date(`2026-10-${d}T16:00:00Z`))).toBe(
        "2026-10-26T04:00:00.000Z"
      );
    }
    expect(easternWeekStartOf(new Date("2026-11-01T17:00:00Z"))).toBe(
      "2026-10-26T04:00:00.000Z"
    );
  });
});

describe("easternNextDayStartOf", () => {
  it("is tomorrow's start, so today is fully included below it", () => {
    expect(easternNextDayStartOf(new Date("2026-09-16T16:00:00Z"))).toBe(
      "2026-09-17T04:00:00.000Z"
    );
  });

  it("advances exactly one calendar day across a DST change", () => {
    // Saturday 2026-03-07 -> Sunday 2026-03-08. A flat +24h would overshoot
    // into Monday once the clocks move.
    expect(easternNextDayStartOf(new Date("2026-03-07T16:00:00Z"))).toBe(
      "2026-03-08T05:00:00.000Z"
    );
  });
});
