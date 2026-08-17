// Paper-claim seed — the 21 workbook-only 2026 claims that never had a
// JotForm submission behind them.
//
// WHY THIS EXISTS: the reconciliation CSV
// (Desktop/Guides/Damage/damage-2026-reconciliation.csv) keys 1,116 of its
// 1,140 rows on a JOT number and 24 on a workbook incident number. Only the
// jot-keyed rows reach D1 — gen_phase2.py:109 skips `key_source != "jot"`
// outright, and handleJotformSeed reads from `jotform_submissions`, which by
// definition has no row for a claim that was filed on paper. So those 24 are
// in no table anywhere in the new system: not `claims`, not the phase-2
// scratch tables. Three are excluded by operator call (see EXCLUDED below),
// leaving the 21 in PAPER_CLAIMS.
//
// WHY AN ENDPOINT AND NOT SQL: the money only reaches reporting through a
// `claim_photos` row, and `claim_photos` requires an R2 object (`r2_key` +
// `filename` are NOT NULL). Only the worker holds the R2_BUCKET binding, so
// the document has to be created here. The original paperwork lives in Box
// and neither the operator nor this worker can read those files, so we
// synthesize a one-page placeholder PDF per claim carrying the amount and a
// link back to the Box original.
//
// WHY THE PLACEHOLDER IS TYPED `Receipt`: every cost query in index.ts sums
// `claim_photos.amount WHERE photo_type IN ('Quote','Receipt')`. A
// 'Check Request' row's amount is deliberately excluded from those sums (it
// is a copy of the approved quote's amount — counting both double-counts the
// claim). So `Receipt` is the only type that makes an imported dollar figure
// visible in reporting. The PDF body says in plain language that it is an
// import placeholder and not a real receipt, so nobody opening it is misled.
//
// IDEMPOTENCY: `idempotency_key = 'workbook:' + incidentNo`, pre-checked per
// row via getClaimByIdempotencyKey and backed by the partial unique index on
// claims.idempotency_key. Safe to re-run.
//
// NOTE on incident numbers: `402026003` also appears in the CSV as a
// *jot-keyed* row (2026-01-15, Rufino Sagastisado, $692.52, Greenwich Ext).
// That one is already in D1 from the JotForm seed and is NOT in this list —
// the workbook reused the number. It does not collide with our idempotency
// key because only these 21 rows get a 'workbook:' prefix, but it is the
// reason incident_no alone must never be treated as a global claim key.

import { getClaimByIdempotencyKey, lifecycleForStatus } from "@splash/db-d1";
import type { SupabaseEnv } from "@splash/db-supabase";
import { json, jsonError } from "@splash/http";
import { generateClaimIdAt } from "@splash/storage-r2";
import type { ClaimStatus } from "@splash/types/claims";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { fetchSiteMap } from "./seed-jotform.js";

/* ============================================================
 * The rows
 * ============================================================ */

interface PaperClaim {
  /** Workbook incident number. Encodes site + year + sequence
   *  (1252026001 = site 125, 2026, #001) but `site` is stated explicitly
   *  below rather than parsed — see the 402026003 note in the header. */
  incidentNo: string;
  /** Site number as it appears in pricing_simple / the overlay. */
  site: string;
  /** 'YYYY-MM-DD' from the workbook. Doubles as the submitted_at date, which
   *  is what every KPI query filters on. */
  incidentDate: string;
  customerName: string;
  customerEmail: string | null;
  /** The workbook's free-text assessment → damage_description. */
  assessment: string;
  /** Total paid. Null on the no-cost rows. */
  cost: number | null;
  status: ClaimStatus;
  /** claims.determination slug, or null where the workbook value has no slug. */
  determination: string | null;
  /** Box file id; the placeholder PDF links to it. Four rows have no
   *  paperwork on file — the PDF says so instead of linking. */
  boxFileId: string | null;
  /** Extra workbook remark folded into staff_notes. */
  note?: string;
}

/**
 * Status assignment (operator, 2026-08-17):
 *   - 12 cost-bearing rows → 'Closed — Paid'. Responsibility was accepted and
 *     the money went out.
 *   - 7 zero-cost rows whose workbook `responsibility` reads "no" →
 *     'Closed — Denied'. Deliberately NOT Paid: marking a $0 no-responsibility
 *     claim as approved inflates the approved-claims KPI with claims we never
 *     approved.
 *   - 2 still-open rows → 'Pending RM Review', which is where the workbook
 *     leaves them.
 * Elmira 1272026010 reads "open / waiting on Dan & Jay's approval" in the
 * workbook; operator directed it to be imported as Paid.
 */
const PAPER_CLAIMS: readonly PaperClaim[] = [
  {
    incidentNo: "1252026001",
    site: "125",
    incidentDate: "2026-01-28",
    customerName: "Fran Coudriet",
    customerEmail: null,
    assessment: "vehicle in front of jumped roller and was hit",
    cost: 1812.99,
    status: "Closed — Paid",
    determination: null,
    boxFileId: "2126741233322"
  },
  {
    incidentNo: "1862026001",
    site: "186",
    incidentDate: "2026-02-10",
    customerName: "Denise Hannaoui",
    customerEmail: null,
    assessment: "drivers front tire flat",
    cost: 479.32,
    status: "Closed — Paid",
    determination: null,
    boxFileId: "2131552475984"
  },
  {
    incidentNo: "772026001",
    site: "77",
    incidentDate: "2026-02-21",
    customerName: "Carlos Pena",
    customerEmail: null,
    assessment: "Customer turned wheel and scratched truck",
    cost: null,
    status: "Closed — Denied",
    determination: "no_responsibility",
    boxFileId: "2143453262145"
  },
  {
    incidentNo: "752026001",
    site: "75",
    incidentDate: "2026-02-26",
    customerName: "Victor Olivo",
    customerEmail: null,
    assessment: "vehicle was hit from behind",
    cost: 2532.36,
    status: "Closed — Paid",
    determination: null,
    boxFileId: "2152992551776"
  },
  {
    incidentNo: "762026004",
    site: "76",
    incidentDate: "2026-02-26",
    customerName: "Angelo Troiani",
    customerEmail: null,
    assessment: "Antenna broke off and damaged fender",
    cost: null,
    status: "Closed — Denied",
    determination: "no_responsibility",
    boxFileId: "2147841037850"
  },
  {
    incidentNo: "752026002",
    site: "75",
    incidentDate: "2026-03-09",
    customerName: "Julio Ramirez",
    customerEmail: null,
    assessment: "several scratches",
    cost: null,
    status: "Closed — Denied",
    determination: "no_responsibility",
    boxFileId: "2212593361820"
  },
  {
    incidentNo: "762026015",
    site: "76",
    incidentDate: "2026-03-16",
    customerName: "Daniel Piderman",
    customerEmail: null,
    assessment: "rear wiper came off",
    cost: 120.04,
    status: "Closed — Paid",
    determination: null,
    boxFileId: null
  },
  {
    incidentNo: "772026002",
    site: "77",
    incidentDate: "2026-04-01",
    customerName: "Nick Ujkic",
    customerEmail: null,
    assessment: "windows scratched",
    cost: null,
    status: "Closed — Denied",
    determination: "no_responsibility",
    boxFileId: "2184365526137"
  },
  {
    incidentNo: "2312026001",
    site: "231",
    incidentDate: "2026-05-17",
    customerName: "Jillian Heier",
    customerEmail: null,
    assessment: "vehicle was hit from behind when placed in drive",
    cost: 1839.07,
    status: "Closed — Paid",
    determination: null,
    boxFileId: null
  },
  {
    incidentNo: "2522026001",
    site: "252",
    incidentDate: "2026-05-29",
    customerName: "Shalonda McKnight",
    customerEmail: null,
    assessment: "passenger mirror damaged",
    cost: 1169.67,
    status: "Closed — Paid",
    determination: null,
    boxFileId: "2296794926006"
  },
  {
    incidentNo: "2412026001",
    site: "241",
    incidentDate: "2026-05-31",
    customerName: "Doris Kubicki",
    customerEmail: null,
    assessment: "gas door and hinge pulled out and broke",
    cost: 1362.62,
    status: "Closed — Paid",
    determination: null,
    boxFileId: "2289149898597"
  },
  {
    incidentNo: "2412026002",
    site: "241",
    incidentDate: "2026-06-06",
    customerName: "Tanner Steinborn",
    customerEmail: null,
    assessment: "wrap around stuck on taillight and tore it off",
    cost: 533.38,
    status: "Closed — Paid",
    determination: null,
    boxFileId: null
  },
  {
    incidentNo: "2312026002",
    site: "231",
    incidentDate: "2026-06-12",
    customerName: "Michael Milam",
    customerEmail: null,
    assessment: "employee error/collision",
    cost: 3746.06,
    status: "Closed — Paid",
    determination: null,
    boxFileId: "2319029766512"
  },
  {
    incidentNo: "402026003",
    site: "40",
    incidentDate: "2026-06-23",
    customerName: "Mildred Alvarez",
    customerEmail: null,
    assessment: "lost keys",
    cost: 60.32,
    status: "Closed — Paid",
    determination: null,
    boxFileId: null,
    note: "Workbook sheet: Greenwich Hand."
  },
  {
    incidentNo: "1562026023",
    site: "156",
    incidentDate: "2026-07-10",
    customerName: "Rocco Fortunato",
    customerEmail: null,
    assessment: "passenger mirror cap came off",
    cost: null,
    status: "Closed — Denied",
    determination: "no_responsibility",
    boxFileId: "2344754972437"
  },
  {
    incidentNo: "2412026003",
    site: "241",
    incidentDate: "2026-07-13",
    customerName: "Marisa Pereyra",
    customerEmail: null,
    assessment: "rear bumper cover pulled off and broke",
    cost: 2084.15,
    status: "Closed — Paid",
    determination: null,
    boxFileId: "2358110805411"
  },
  {
    incidentNo: "2522026002",
    site: "252",
    incidentDate: "2026-07-14",
    customerName: "Dashawn Gardner",
    customerEmail: null,
    assessment:
      "cloth got stuck under wiper causing progressive damage to wiper motor - customer left auto wipers on",
    cost: null,
    status: "Pending RM Review",
    determination: null,
    boxFileId: "2366473511696"
  },
  {
    incidentNo: "1222026025",
    site: "122",
    incidentDate: "2026-07-22",
    customerName: "Pat Martin",
    customerEmail: null,
    assessment: "door scratched",
    cost: null,
    status: "Closed — Denied",
    determination: "no_responsibility",
    boxFileId: "2361948807602"
  },
  {
    incidentNo: "1272026008",
    site: "127",
    incidentDate: "2026-07-22",
    customerName: "Jack Wright",
    customerEmail: null,
    assessment: "rim damaged",
    cost: null,
    status: "Closed — Denied",
    determination: "no_responsibility",
    boxFileId: "2364055676852"
  },
  {
    incidentNo: "1272026010",
    site: "127",
    incidentDate: "2026-08-07",
    customerName: "Tammy Woodard",
    customerEmail: "indigglow@gmail.com",
    assessment: "exit gate came down on vehicle",
    cost: 731.95,
    status: "Closed — Paid",
    determination: null,
    boxFileId: "2395014256494",
    note: "Workbook remark: waiting on Dan & Jay's approval. Operator directed import as Closed — Paid."
  },
  {
    incidentNo: "1602026002",
    site: "160",
    incidentDate: "2026-08-07",
    customerName: "Alicia Falkey-Ignacio",
    customerEmail: null,
    assessment: "passengers side of hood lifted",
    cost: null,
    status: "Pending RM Review",
    determination: null,
    boxFileId: "2395246190183"
  }
];

/**
 * The three incident-keyed rows deliberately left out, recorded here so a
 * future reader doesn't "discover" them and re-add them:
 *   772024025  2024-07-30  WashCo Tarrytown   $2,165.86  — out of period (2024)
 *   862025001  2025-12-15  Newburgh              $15.98  — out of period (2025)
 *   1832026003 2026-02-10  Northport                  —  — empty workbook row.
 *     Shares a customer name and Box link with 1862026001 (Commack) but the
 *     operator confirmed these are two genuinely different sites, not a
 *     duplicate; the Northport row simply has no data.
 */
const EXCLUDED_INCIDENT_NOS = ["772024025", "862025001", "1832026003"] as const;

const BOX_FILE_URL = "https://splashcarwashes.app.box.com/file/";

/** Stamped into staff_notes, the PDF, and the activity row so the provenance
 *  of these claims is legible from any of the three. */
const IMPORT_LABEL = "Historical import of non-JotForm claim";

const IMPORTED_BY = "Workbook import";

/* ============================================================
 * Placeholder PDF
 * ============================================================ */

/**
 * One page, no template, no images — a legible record that this claim came
 * from paper, what it cost, and where the original scan lives.
 *
 * It is deliberately blunt about not being a real receipt. This document is
 * typed `Receipt` in claim_photos purely so the amount reaches the cost
 * queries (see the header); anyone who opens it must not come away thinking
 * a vendor issued it.
 */
async function buildImportPdf(
  row: PaperClaim,
  claimId: string,
  locationPretty: string
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const navy = rgb(0.05, 0.16, 0.31);
  const grey = rgb(0.35, 0.35, 0.35);
  const left = 60;
  let y = 720;

  const line = (
    text: string,
    opts: { size?: number; font?: typeof font; color?: typeof navy; gap?: number } = {}
  ) => {
    page.drawText(text, {
      x: left,
      y,
      size: opts.size ?? 11,
      font: opts.font ?? font,
      color: opts.color ?? navy
    });
    y -= opts.gap ?? 18;
  };

  const field = (label: string, value: string) => {
    page.drawText(label, { x: left, y, size: 9, font: bold, color: grey });
    page.drawText(value, { x: left + 150, y, size: 11, font, color: navy });
    y -= 22;
  };

  line(IMPORT_LABEL, { size: 18, font: bold, gap: 12 });
  page.drawLine({
    start: { x: left, y },
    end: { x: 552, y },
    thickness: 1,
    color: navy
  });
  y -= 28;

  line(
    "This claim predates the damage system and was never filed through JotForm.",
    { size: 10, color: grey, gap: 14 }
  );
  line(
    "It was recorded on paper and tracked in the 2026 damage workbook. This page",
    { size: 10, color: grey, gap: 14 }
  );
  line(
    "is an import placeholder, NOT a vendor receipt or an invoice. The original",
    { size: 10, color: grey, gap: 14 }
  );
  line("paperwork is the authority for anything below.", {
    size: 10,
    color: grey,
    gap: 32
  });

  field("Claim ID", claimId);
  field("Workbook incident #", row.incidentNo);
  field("Location", `${locationPretty} (site ${row.site})`);
  field("Incident date", row.incidentDate);
  field("Customer", row.customerName);
  if (row.customerEmail) field("Customer email", row.customerEmail);
  field("Final status", row.status);
  field(
    "Amount paid",
    row.cost === null ? "$0.00 (no cost incurred)" : `$${row.cost.toFixed(2)}`
  );

  y -= 10;
  page.drawText("Original paperwork", { x: left, y, size: 9, font: bold, color: grey });
  y -= 18;
  if (row.boxFileId) {
    const url = `${BOX_FILE_URL}${row.boxFileId}`;
    page.drawText(url, { x: left, y, size: 10, font, color: rgb(0.05, 0.35, 0.7) });
    y -= 16;
    page.drawText("(Box — access required)", { x: left, y, size: 9, font, color: grey });
  } else {
    page.drawText("No scanned paperwork on file for this incident.", {
      x: left,
      y,
      size: 10,
      font,
      color: grey
    });
  }

  y -= 34;
  if (row.assessment) {
    page.drawText("Workbook assessment", { x: left, y, size: 9, font: bold, color: grey });
    y -= 16;
    for (const chunk of wrap(row.assessment, 80)) {
      page.drawText(chunk, { x: left, y, size: 10, font, color: navy });
      y -= 14;
    }
  }
  if (row.note) {
    y -= 10;
    for (const chunk of wrap(row.note, 80)) {
      page.drawText(chunk, { x: left, y, size: 10, font, color: grey });
      y -= 14;
    }
  }

  page.drawText(`Generated ${new Date().toISOString().slice(0, 10)}`, {
    x: left,
    y: 60,
    size: 8,
    font,
    color: grey
  });

  return doc.save();
}

/** Naive word wrap — pdf-lib has no text layout, and every string here is
 *  short free text from a spreadsheet cell. */
function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/* ============================================================
 * Handler
 * ============================================================ */

type PaperSeedEnv = SupabaseEnv & {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  SUPABASE_SERVICE_KEY?: string;
};

interface RowOutcome {
  incident_no: string;
  outcome: "inserted" | "already_seeded" | "skipped";
  claim_id?: string;
  reason?: string;
}

/**
 * POST /manage/api/seed/paper-claims — insert the 21 workbook-only claims.
 *
 * super_admin only, same reasoning as handleJotformSeed: the /manage/api/*
 * gate is checkToolAccess("claims"), which is too low a bar for a bulk write.
 *
 * Unpaged — 21 rows costs ~85 subrequests (dedup SELECT + R2 PUT + 3-statement
 * batch + amount UPDATE per row), far inside the 1,000 limit.
 *
 * `?dry_run=1` builds every row and generates every PDF but writes nothing,
 * so a failure in PDF generation surfaces before anything is committed.
 */
export async function handlePaperClaimSeed(
  request: Request,
  env: PaperSeedEnv,
  dcRole: string | null
): Promise<Response> {
  if (dcRole !== "super_admin") {
    return jsonError(403, "seed requires super_admin");
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return jsonError(500, "seed not configured (SUPABASE_SERVICE_KEY unbound)");
  }

  const dryRun = new URL(request.url).searchParams.get("dry_run") === "1";

  let siteMap: Map<string, { code: string; pretty: string }>;
  try {
    siteMap = await fetchSiteMap(env);
  } catch (err) {
    console.error("[damage.seed.paper] site map read failed:", err);
    return jsonError(500, err instanceof Error ? err.message : "site map read failed");
  }

  const outcomes: RowOutcome[] = [];
  let inserted = 0;
  let alreadySeeded = 0;
  let skipped = 0;
  let totalAmount = 0;

  for (const row of PAPER_CLAIMS) {
    const idempotencyKey = `workbook:${row.incidentNo}`;

    const existing = await getClaimByIdempotencyKey(env.DB, idempotencyKey);
    if (existing) {
      alreadySeeded += 1;
      outcomes.push({
        incident_no: row.incidentNo,
        outcome: "already_seeded",
        claim_id: existing.claim_id
      });
      continue;
    }

    // Hard requirement, not a fallback — same rule as the JotForm seed. A
    // guessed location_code drops the claim into the wrong admin's queue.
    const location = siteMap.get(row.site);
    if (!location) {
      skipped += 1;
      outcomes.push({
        incident_no: row.incidentNo,
        outcome: "skipped",
        reason: `unknown site_number ${JSON.stringify(row.site)}`
      });
      continue;
    }

    // Noon UTC on the incident date. Every KPI query filters on submitted_at,
    // so it has to be the incident date and not the run date; noon keeps the
    // row inside the intended calendar day under any US timezone offset.
    const submittedAt = new Date(`${row.incidentDate}T12:00:00Z`).toISOString();
    const claimId = generateClaimIdAt(location.code, new Date(submittedAt));
    // writeClaimBatch hardcodes lifecycle_state='Open', which is why this
    // file uses its own INSERT rather than the shared helper: 19 of these 21
    // rows land at a Closed status and must carry the matching lifecycle.
    const lifecycle = lifecycleForStatus(row.status);

    const noteParts = [
      `${IMPORT_LABEL}. Workbook incident #${row.incidentNo}.`,
      row.boxFileId
        ? `Original paperwork: ${BOX_FILE_URL}${row.boxFileId}`
        : "No scanned paperwork on file for this incident."
    ];
    if (row.note) noteParts.push(row.note);

    const filename = `Import_${row.incidentNo}.pdf`;
    const r2Key = `claims/${claimId}/${filename}`;

    let pdfBytes: Uint8Array;
    try {
      pdfBytes = await buildImportPdf(row, claimId, location.pretty);
    } catch (err) {
      console.error(`[damage.seed.paper] pdf failed for ${row.incidentNo}:`, err);
      skipped += 1;
      outcomes.push({
        incident_no: row.incidentNo,
        outcome: "skipped",
        reason: `pdf generation failed: ${err instanceof Error ? err.message : "unknown"}`
      });
      continue;
    }

    if (dryRun) {
      inserted += 1;
      if (row.cost !== null) totalAmount += row.cost;
      outcomes.push({
        incident_no: row.incidentNo,
        outcome: "inserted",
        claim_id: `${claimId} (dry run, ${pdfBytes.length} byte pdf)`
      });
      continue;
    }

    try {
      // R2 first. An orphaned object is harmless and cheap to sweep; a
      // claim_photos row pointing at a key that was never written renders as a
      // broken document on the detail page.
      await env.R2_BUCKET.put(r2Key, pdfBytes, {
        httpMetadata: { contentType: "application/pdf" }
      });

      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO claims (
            claim_id, location_code, location_pretty,
            customer_name, customer_email,
            damage_description, staff_notes,
            determination, submitted_by, equipment_related,
            lifecycle_state, claim_status, status_updated_by, status_updated_at,
            submitted_at, incident_date, approved_amount, idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          claimId,
          location.code,
          location.pretty,
          row.customerName,
          row.customerEmail,
          row.assessment || null,
          noteParts.join("\n\n"),
          row.determination,
          IMPORTED_BY,
          lifecycle,
          row.status,
          IMPORTED_BY,
          submittedAt,
          submittedAt,
          row.incidentDate,
          // approved_amount is set here; approved_quote_id is left NULL on
          // purpose. That column is meant to point at a 'Quote' row, and the
          // only document these claims have is the Receipt-typed placeholder.
          // Reporting reads claim_photos.amount, not approved_quote_id, so
          // nothing downstream needs it.
          row.cost,
          idempotencyKey
        ),
        env.DB.prepare(
          `INSERT INTO claim_photos (
            claim_id, photo_type, r2_key, filename, content_type,
            size_bytes, amount, notes, uploaded_by
          ) VALUES (?, 'Receipt', ?, ?, 'application/pdf', ?, ?, ?, ?)`
        ).bind(
          claimId,
          r2Key,
          filename,
          pdfBytes.length,
          row.cost,
          IMPORT_LABEL,
          IMPORTED_BY
        ),
        env.DB.prepare(
          `INSERT INTO claim_activity (
            claim_id, activity_type, status_from, status_to, notes, actor_name
          ) VALUES (?, 'status_change', NULL, ?, ?, ?)`
        ).bind(
          claimId,
          row.status,
          `${IMPORT_LABEL} (workbook incident #${row.incidentNo}).`,
          IMPORTED_BY
        )
      ]);

      inserted += 1;
      if (row.cost !== null) totalAmount += row.cost;
      outcomes.push({
        incident_no: row.incidentNo,
        outcome: "inserted",
        claim_id: claimId
      });
    } catch (err) {
      console.error(`[damage.seed.paper] write failed for ${row.incidentNo}:`, err);
      skipped += 1;
      outcomes.push({
        incident_no: row.incidentNo,
        outcome: "skipped",
        reason: `d1 write failed: ${err instanceof Error ? err.message : "unknown"}`
      });
    }
  }

  return json({
    ok: true,
    dry_run: dryRun,
    rows_defined: PAPER_CLAIMS.length,
    excluded: EXCLUDED_INCIDENT_NOS,
    inserted,
    already_seeded: alreadySeeded,
    skipped,
    total_amount: Number(totalAmount.toFixed(2)),
    outcomes
  });
}
