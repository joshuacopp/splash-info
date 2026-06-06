// Brief 160 — renderer fixtures.
//
// Inline snapshots for `renderAnnouncement`. No test runner today; these
// snapshots are for human read review and as a regression-lock target —
// if a future brief changes the renderer in a way that's not deliberate,
// running this file (via `tsx test/render-html.snap.ts`) will diff
// against the strings below and surface the unexpected change.
//
// Three fixtures cover the matrix:
//   1. Subject + body only (no PTP, no materials).
//   2. Subject + body + PTP + 1 inline image + 1 attachment doc.
//   3. Subject + body + 2 inline images + 0 attachments.

import { renderAnnouncement } from "../src/announce/render-html.js";

const FIXTURE_1 = {
  subject: "Summer Wash Special — June kickoff",
  bodyText: "Hi team,\n\nWe're launching the June Summer Wash Special on Monday. Make sure your washes are stocked on the materials below.\n\nThanks,\nMarketing",
  promoTitle: "June Summer Wash Special",
  includePtp: false,
  ptp: null,
  inlineMaterials: [],
  attachmentMaterials: []
};

const FIXTURE_2 = {
  subject: "August Family Plan promo — please share with sites",
  bodyText: "Team,\n\nAttached is the August Family Plan promo material. Please share with all sites by EOD Friday.",
  promoTitle: "August Family Plan",
  includePtp: true,
  ptp: {
    purpose: "Drive Family Plan signups during back-to-school season.",
    tools: "POS landing page, in-bay signage, email blast.",
    process: "1. Print signage by Aug 1.\n2. Send email blast Aug 5.\n3. Track signups weekly."
  },
  inlineMaterials: [
    {
      materialId: "11111111-1111-4111-8111-111111111111",
      name: "family-plan-hero.jpg",
      contentId: "material-11111111-1111-4111-8111-111111111111"
    }
  ],
  attachmentMaterials: [
    {
      materialId: "22222222-2222-4222-8222-222222222222",
      name: "family-plan-talking-points.pdf"
    }
  ]
};

const FIXTURE_3 = {
  subject: "Two-image promo — image-only push",
  bodyText: "Posters for the lobby. Print as needed.",
  promoTitle: "Lobby Posters Refresh",
  includePtp: false,
  ptp: null,
  inlineMaterials: [
    {
      materialId: "33333333-3333-4333-8333-333333333333",
      name: "poster-front.jpg",
      contentId: "material-33333333-3333-4333-8333-333333333333"
    },
    {
      materialId: "44444444-4444-4444-8444-444444444444",
      name: "poster-back.jpg",
      contentId: "material-44444444-4444-4444-8444-444444444444"
    }
  ],
  attachmentMaterials: []
};

function dump(label: string, input: Parameters<typeof renderAnnouncement>[0]) {
  const out = renderAnnouncement(input);
  console.log("=".repeat(80));
  console.log(label);
  console.log("=".repeat(80));
  console.log("--- HTML ---");
  console.log(out.html);
  console.log("");
  console.log("--- PLAIN TEXT ---");
  console.log(out.plainText);
  console.log("");
}

dump("FIXTURE 1: subject + body only", FIXTURE_1);
dump("FIXTURE 2: subject + body + PTP + 1 inline image + 1 attachment", FIXTURE_2);
dump("FIXTURE 3: subject + body + 2 inline images + 0 attachments", FIXTURE_3);
