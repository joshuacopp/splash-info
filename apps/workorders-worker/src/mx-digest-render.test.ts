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
import { easternDayStart } from "./mx-daily-digest";
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

describe("easternDayStart", () => {
  it("returns Eastern midnight for a late-evening send", () => {
    // 02:00 UTC on the 16th is 22:00 EDT on the 15th, so the window opens at
    // Eastern midnight on the 15th -- 04:00 UTC that day.
    const { startIso } = easternDayStart(new Date("2026-09-16T02:00:00Z"));
    expect(startIso).toBe("2026-09-15T04:00:00.000Z");
  });

  it("labels the day in Eastern, not UTC", () => {
    // The naive read of that instant is the 16th. The operator's day is the
    // 15th, and the label has to agree with the window.
    const { label } = easternDayStart(new Date("2026-09-16T02:00:00Z"));
    expect(label).toContain("September 15");
  });

  it("follows DST rather than assuming an offset", () => {
    // January is EST (-05:00), so Eastern midnight is 05:00 UTC. Hardcoding
    // -04:00 would put the window an hour out for four months of the year.
    const { startIso } = easternDayStart(new Date("2027-01-16T02:00:00Z"));
    expect(startIso).toBe("2027-01-15T05:00:00.000Z");
  });
});
