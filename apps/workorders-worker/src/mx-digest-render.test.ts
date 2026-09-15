// Tests for the daily digest email.
//
// The renderer is pure, so these assert content rather than plumbing. Two
// things here are worth more than the rest:
//
//   - money is formatted from CENTS at the render site and nowhere else. The
//     MaintainX cost columns were 100x out for months (9a920d1) because a
//     conversion happened where nobody was looking.
//   - the plain-text body is NOT decorative. The queue's drain prefers
//     body_html but falls back to body_text, so a plain-text client receives
//     exactly what is asserted below.

import { describe, expect, it } from "vitest";
import { easternReportingDay } from "./mx-daily-digest";
import { renderDailyDigestEmail, type DigestSite } from "./mx-digest-render";

const BASE = "https://splashcarwashes.info";

function site(over: Partial<DigestSite> = {}): DigestSite {
  return {
    name: "Binghamton",
    dayLabel: "Monday, September 15",
    workOrders: [
      {
        id: 118834534,
        sequentialId: 163455,
        title: "Hydraulic line leaking in tunnel",
        description: "Leak under the wrap conveyor",
        status: "OPEN",
        priority: "HIGH",
        comments: [
          {
            author: "Josh Copp",
            content: "Shut the line down, parts ordered",
            createdAt: "2026-09-15T18:04:00.000Z"
          }
        ],
        commentsTruncated: false,
        expenses: [
          { description: "Hydraulic hose", type: "PARTS", quantity: 2, totalCents: 123400 }
        ]
      }
    ],
    ...over
  };
}

describe("subject line", () => {
  it("names the site, the count and the day", () => {
    const { subject } = renderDailyDigestEmail(site(), BASE);
    expect(subject).toBe("Binghamton: 1 work order worked on Monday, September 15");
  });

  it("pluralises correctly", () => {
    const s = site();
    const two = { ...s, workOrders: [s.workOrders[0]!, { ...s.workOrders[0]!, id: 2 }] };
    expect(renderDailyDigestEmail(two, BASE).subject).toContain("2 work orders");
  });
});

describe("money", () => {
  it("formats CENTS as dollars", () => {
    // 123400 cents is $1,234.00. Any division upstream of here would be the
    // 100x bug all over again.
    const { html, text } = renderDailyDigestEmail(site(), BASE);
    expect(html).toContain("$1,234.00");
    expect(text).toContain("$1,234.00");
  });

  it("shows a site-level total only when there is spend", () => {
    const withSpend = renderDailyDigestEmail(site(), BASE);
    expect(withSpend.html).toContain("New expenses today");

    const s = site();
    const noSpend = {
      ...s,
      workOrders: [{ ...s.workOrders[0]!, expenses: [] }]
    };
    // A "New expenses today: $0.00" line on every email is noise that trains
    // the reader to skip the section that matters on the days it is not zero.
    expect(renderDailyDigestEmail(noSpend, BASE).html).not.toContain("New expenses today");
  });
});

describe("content", () => {
  it("includes the description, comment author and comment text", () => {
    const { html, text } = renderDailyDigestEmail(site(), BASE);
    for (const body of [html, text]) {
      expect(body).toContain("Leak under the wrap conveyor");
      expect(body).toContain("Josh Copp");
      expect(body).toContain("Shut the line down, parts ordered");
    }
  });

  it("links each work order to MaintainX at /workorders/{id}", () => {
    // NOT /requests/{id} -- MaintainX's URL segments are asymmetric and that
    // asymmetry has caused a bug here before (Brief 80).
    const { html } = renderDailyDigestEmail(site(), BASE);
    expect(html).toContain("https://app.getmaintainx.com/workorders/118834534");
  });

  it("attributes an unresolved author rather than dropping the comment", () => {
    const s = site();
    const anon = {
      ...s,
      workOrders: [
        {
          ...s.workOrders[0]!,
          comments: [{ author: null, content: "no name on file", createdAt: null }]
        }
      ]
    };
    const { text } = renderDailyDigestEmail(anon, BASE);
    expect(text).toContain("Unknown");
    expect(text).toContain("no name on file");
  });

  it("points at MaintainX when the comment list was capped", () => {
    const s = site();
    const many = { ...s, workOrders: [{ ...s.workOrders[0]!, commentsTruncated: true }] };
    expect(renderDailyDigestEmail(many, BASE).html).toContain("Older comments in MaintainX");
  });

  it("says preventative work is excluded", () => {
    // Otherwise a reader reasonably assumes a quiet day meant no PM either.
    const { html, text } = renderDailyDigestEmail(site(), BASE);
    expect(html).toContain("Preventative maintenance is not included");
    expect(text).toContain("Preventative maintenance is not included");
  });
});

describe("escaping", () => {
  it("escapes operator-written text in the HTML body", () => {
    const s = site();
    const nasty = {
      ...s,
      workOrders: [
        {
          ...s.workOrders[0]!,
          title: 'Pump <script>alert("x")</script> failed',
          comments: [{ author: "A & B", content: "5 < 6 & 7 > 6", createdAt: null }]
        }
      ]
    };
    const { html } = renderDailyDigestEmail(nasty, BASE);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B");
  });
});

describe("easternReportingDay", () => {
  // The cron fires at 05:00 UTC so the previous Eastern day is always
  // complete. These pin the boundary arithmetic, which is the part that would
  // silently report the wrong 24 hours.

  it("reports the full previous Eastern day in summer (EDT)", () => {
    // 05:00 UTC on the 16th is 1 AM EDT, so the day that just ended is the
    // 15th: midnight-to-midnight Eastern = 04:00 UTC to 04:00 UTC.
    const { startIso, endIso, label } = easternReportingDay(
      new Date("2026-09-16T05:00:00Z")
    );
    expect(startIso).toBe("2026-09-15T04:00:00.000Z");
    expect(endIso).toBe("2026-09-16T04:00:00.000Z");
    expect(label).toContain("September 15");
  });

  it("reports the full previous Eastern day in winter (EST)", () => {
    // 05:00 UTC in January is EXACTLY Eastern midnight -- the boundary case
    // that makes a current-day window empty, and the reason the window is the
    // previous day rather than the day so far.
    const { startIso, endIso, label } = easternReportingDay(
      new Date("2027-01-16T05:00:00Z")
    );
    expect(startIso).toBe("2027-01-15T05:00:00.000Z");
    expect(endIso).toBe("2027-01-16T05:00:00.000Z");
    expect(label).toContain("January 15");
  });

  it("covers a whole day, never a partial one", () => {
    // The tail gap this replaced was real: a 10 PM send left 10 PM-midnight
    // reported by nobody, that night or ever.
    for (const at of ["2026-09-16T05:00:00Z", "2027-01-16T05:00:00Z"]) {
      const { startIso, endIso } = easternReportingDay(new Date(at));
      const hours = (Date.parse(endIso) - Date.parse(startIso)) / 3_600_000;
      expect(hours).toBe(24);
    }
  });

  it("handles the 23-hour spring-forward day", () => {
    // DST began 2026-03-08, so that Eastern day is 23 hours: midnight EST
    // (05:00 UTC) to midnight EDT (04:00 UTC the next day). Reading the offset
    // at midday instead of at midnight -- which is what the first version of
    // this did -- puts the start an hour early and double-reports that hour.
    const { startIso, endIso, label } = easternReportingDay(
      new Date("2026-03-09T05:00:00Z")
    );
    expect(startIso).toBe("2026-03-08T05:00:00.000Z");
    expect(endIso).toBe("2026-03-09T04:00:00.000Z");
    expect(label).toContain("March 8");
    expect((Date.parse(endIso) - Date.parse(startIso)) / 3_600_000).toBe(23);
  });

  it("handles the 25-hour fall-back day", () => {
    // The mirror image: DST ended 2026-11-01, so that day runs midnight EDT
    // (04:00 UTC) to midnight EST (05:00 UTC the next day) and the hour from
    // 1 to 2 AM happens twice. Both of them belong in this day's digest.
    const { startIso, endIso, label } = easternReportingDay(
      new Date("2026-11-02T05:00:00Z")
    );
    expect(startIso).toBe("2026-11-01T04:00:00.000Z");
    expect(endIso).toBe("2026-11-02T05:00:00.000Z");
    expect(label).toContain("November 1");
    expect((Date.parse(endIso) - Date.parse(startIso)) / 3_600_000).toBe(25);
  });

  it("leaves no gap between one day's window and the next", () => {
    // Each day's end must be the next day's start, or activity in between is
    // reported by nobody -- the failure mode the 10 PM send had, silently.
    for (const [first, second] of [
      ["2026-03-08T05:00:00Z", "2026-03-09T05:00:00Z"],
      ["2026-11-01T05:00:00Z", "2026-11-02T05:00:00Z"],
      ["2026-09-15T05:00:00Z", "2026-09-16T05:00:00Z"]
    ] as const) {
      expect(easternReportingDay(new Date(first)).endIso).toBe(
        easternReportingDay(new Date(second)).startIso
      );
    }
  });
});
