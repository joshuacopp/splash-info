// Task #15 — reconstruct the missing paperwork for paid 2026 claims that have
// no document at all.
//
// WHY THIS IS NEEDED AND WHY IT IS NOT "INVENTING" DOCUMENTS: the dashboard's
// cost figures sum `claim_photos.amount` for photo_type IN ('Quote','Receipt').
// They never read `claims.approved_amount`. So a claim can be Closed — Paid
// with a correct amount on the claim row and still contribute nothing to
// reported cost, because no document carries the money. 105 paid 2026 claims
// were in exactly that state after the workbook backfill — 104 inserted by the
// JotForm seed and 1 hand-migrated from a Copp-region spreadsheet. Those 105
// are the whole of the $68k gap between the workbook total and the reported
// total. Claims raised live in the damage worker are out of scope; see
// fetchClaimsNeedingReceipts for why that is a different problem.
//
// Nothing is paid from the documents this endpoint writes — the cheques cleared
// months ago and the signed paperwork sits in Box. This is a placeholder that
// carries the amount into reporting and points at where the real document
// lives.
//
// WHY THE PLACEHOLDER STYLE AND NOT A RECONSTRUCTED CHECK REQUEST (operator
// decision, 2026-08-20): an earlier cut of this file rendered the check-request
// template with the claim's data poured into it. That produces a document that
// *looks* like a real request to cut a cheque, which it is not, and it buries
// the Box link in the explanation field. The paper-claim seeder had already
// solved the same problem the honest way — a blunt one-page notice that says on
// its face it is an import placeholder, with the Box URL printed as its own
// field. This file now uses that style, so the two families of migrated
// placeholder look alike and neither can be mistaken for vendor paperwork.
//
// WHY TYPED `Receipt`: 'Check Request' is excluded from the cost sums (a claim
// normally has both an estimate and a check request for the same money, and
// counting both would double the cost). 'Receipt' is the only type that makes
// the figure visible. The PDF body is explicit that no vendor issued it.
//
// AMOUNT SOURCE: `claims.approved_amount`, which for 2026 came from the master
// workbook Cost column. A claim with no amount is skipped, not guessed at —
// there is nothing in D1 to reconstruct the figure from, and a receipt for the
// wrong number is worse than no receipt.
//
// NO ACTIVITY ROW ON PURPOSE: these claims are closed, and 105 timeline entries
// announcing a migration step would bury the real history. Provenance lives on
// the document row instead — `uploaded_by = 'migration:generated'` plus a note
// — which is also exactly how you'd find these rows to replace them if the Box
// files are ever imported.
//
// IDEMPOTENT: the r2 key is deterministic (`Req_{claim_id}_migration-generated`),
// and a claim whose key is already in claim_photos is reported `already_present`
// without a rebuild. Safe to re-run and safe to page in any order.

import { json, jsonError } from "@splash/http";
import type { ClaimRow } from "@splash/types/claims";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/** Page size ceiling. Each claim costs a PDF render, an R2 put and a couple of
 *  D1 statements, so the page stays small — much heavier per row than the claim
 *  seed. */
const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;

/** Stamped on every row this endpoint writes, so the reconstructions can be
 *  told apart from imported paperwork later — if the Box files ever land, these
 *  are exactly the rows to replace. */
const UPLOADED_BY = "migration:generated";

/** Printed as the document title and stored as the photo note. */
const IMPORT_LABEL = "Reconstructed claim record — 2026 migration";

/** Filename stem. Fixed, not sequenced: a re-run must land on the same R2 key
 *  so it overwrites rather than appending "_2". */
const FILENAME_STEM = "migration-generated";

interface ClaimOutcome {
  claim_id: string;
  customer_name: string;
  amount: number | null;
  outcome: "generated" | "already_present" | "skipped" | "failed" | "dry_run";
  reason?: string;
  r2_key?: string;
  /** Whether the original Box paperwork could be linked on the PDF. A dry run
   *  reports this per claim so the coverage gap is visible before 96 documents
   *  are built without links and have to be built again. */
  box_link?: boolean;
}

/**
 * Paid 2026 claims with no Quote / Receipt / Check Request document at all.
 *
 * The NOT EXISTS covers every document type on purpose. A claim that already
 * has a check request is handled by the retype SQL, not here — generating a
 * second document for the same payment would leave two records of one cheque.
 *
 * MIGRATED CLAIMS ONLY (operator decision, 2026-08-20). A claim raised directly
 * in the damage worker that is paid with no document is a different problem
 * entirely: its paperwork is missing from a live workflow, and someone should
 * go find it. Reconstructing a document for it would paper over a gap that is
 * still fixable for real.
 *
 * "Migrated" is two populations, not one, and the second is easy to miss:
 *   - `idempotency_key LIKE 'jotform:%'` — the ~1,100 rows the JotForm seed
 *     inserted.
 *   - `idempotency_key IS NULL AND staff_notes LIKE '%JOT#%'` — the nine
 *     Copp-region sites, hand-migrated from their own spreadsheets before the
 *     seed existed. Same origin, no key, and the staff_notes JOT# is the only
 *     marker they carry (it is what fetchMigratedJotNumbers dedups on).
 *
 * An earlier cut filtered on `jotform:%` alone and silently dropped the second
 * group. That looked harmless because only one of them is paid-with-no-document
 * (1262026006, Cortland, $42.13) — but "one claim" was the wrong reason to be
 * comfortable, since the same filter would drop the whole group if the Copp
 * sites' paperwork ever went missing in bulk.
 *
 * A NULL key with no JOT# is a genuinely live claim and stays out, which is the
 * distinction the old filter was reaching for and got wrong.
 */
async function fetchClaimsNeedingReceipts(
  db: D1Database,
  opts: { from: string; to: string; limit: number; offset: number }
): Promise<ClaimRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM claims c
        WHERE c.deleted_at IS NULL
          AND c.claim_status = 'Closed — Paid'
          AND c.submitted_at >= ?1
          AND c.submitted_at < ?2
          AND (
            c.idempotency_key LIKE 'jotform:%'
            OR (c.idempotency_key IS NULL AND c.staff_notes LIKE '%JOT#%')
          )
          AND NOT EXISTS (
            SELECT 1 FROM claim_photos p
             WHERE p.claim_id = c.claim_id
               AND p.deleted_at IS NULL
               AND p.photo_type IN ('Quote', 'Receipt', 'Check Request')
          )
        ORDER BY c.claim_id
        LIMIT ?3 OFFSET ?4`
    )
    .bind(opts.from, opts.to, opts.limit, opts.offset)
    .all<ClaimRow>();
  return rows.results ?? [];
}

/**
 * The Box link to the original signed paperwork, pulled out of staff_notes.
 *
 * WHY staff_notes: the hand-migrated Copp claims already carry it there in a
 * fixed shape — `Legacy backfill — JOT# 202600026 · Paperwork: https://...` —
 * and the workbook Box column is being loaded into the same place rather than a
 * new column, so there is one convention and the link is legible on the claim
 * record itself, not only inside a PDF.
 *
 * Returns "" when there is no link, and the PDF prints a plain "none on file"
 * line rather than an empty label.
 */
function boxLinkFrom(staffNotes: string | null): string {
  const match = (staffNotes ?? "").match(/https:\/\/\S*box\.com\/\S+/i);
  // Trailing punctuation from prose — "…/file/123." — would 404 if clicked.
  return (match?.[0] ?? "").replace(/[).,;]+$/, "");
}

/** YYYY-MM-DD in eastern time, from the claim's submitted_at. Printing the run
 *  date instead would date every reconstruction to the day of the migration. */
function claimDate(submittedAt: string): string {
  const d = new Date(submittedAt.replace(" ", "T") + (submittedAt.includes("Z") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/* ============================================================
 * Placeholder PDF
 * ============================================================ */

/** Naive word wrap — pdf-lib has no text layout, and the only long string here
 *  is the free-text damage description. Mirrors seed-paper-claims. */
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

/**
 * One page, no template, no images — a legible record of what the claim was,
 * what it cost, and where the original scan lives.
 *
 * Deliberately blunt about not being a real receipt, for the same reason as the
 * paper-claim placeholders: this document is typed `Receipt` purely so the
 * amount reaches the cost queries, and anyone who opens it must not come away
 * thinking a vendor issued it.
 */
async function buildReconstructionPdf(
  claim: ClaimRow,
  amount: number,
  boxLink: string
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const navy = rgb(0.05, 0.16, 0.31);
  const grey = rgb(0.35, 0.35, 0.35);
  const linkBlue = rgb(0.05, 0.35, 0.7);
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

  line("This claim was filed through the old JotForm process and paid before the", {
    size: 10,
    color: grey,
    gap: 14
  });
  line("damage system existed. Its signed paperwork was never migrated. This page", {
    size: 10,
    color: grey,
    gap: 14
  });
  line("is a reconstruction from the claim record, NOT a vendor receipt or an", {
    size: 10,
    color: grey,
    gap: 14
  });
  line("invoice, and no payment was made against it. The original paperwork is the", {
    size: 10,
    color: grey,
    gap: 14
  });
  line("authority for anything below.", { size: 10, color: grey, gap: 32 });

  field("Claim ID", claim.claim_id);
  field("Location", claim.location_pretty);
  field("Incident date", claim.incident_date ?? claimDate(claim.submitted_at));
  field("Customer", claim.customer_name);
  if (claim.customer_email) field("Customer email", claim.customer_email);
  field("Final status", claim.claim_status);
  field("Amount paid", `$${amount.toFixed(2)}`);

  y -= 10;
  page.drawText("Original paperwork", { x: left, y, size: 9, font: bold, color: grey });
  y -= 18;
  if (boxLink) {
    page.drawText(boxLink, { x: left, y, size: 10, font, color: linkBlue });
    y -= 16;
    page.drawText("(Box — access required)", { x: left, y, size: 9, font, color: grey });
  } else {
    page.drawText("No scanned paperwork on file for this claim.", {
      x: left,
      y,
      size: 10,
      font,
      color: grey
    });
  }

  y -= 34;
  const description = claim.damage_description?.trim();
  if (description) {
    page.drawText("Reported damage", { x: left, y, size: 9, font: bold, color: grey });
    y -= 16;
    // Bounded: a pathological description would otherwise run off the bottom
    // of the page and silently lose the footer.
    for (const chunk of wrap(description, 80).slice(0, 18)) {
      page.drawText(chunk, { x: left, y, size: 10, font, color: navy });
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

/* ============================================================
 * Handler
 * ============================================================ */

/**
 * POST /manage/api/seed/generated-receipts?from=&to=&limit=&offset=&dry_run=1
 *
 * super_admin only, same reasoning as the other seeds: the /manage/api/* gate
 * is checkToolAccess("claims"), which is too low a bar for a bulk write.
 *
 * NOTE ON PAGING: rows leave the result set as they are processed (they gain a
 * document and stop matching), so on a live run `offset` should stay at 0 and
 * the loop should simply repeat until `fetched` is 0. Paging forward on a live
 * run steps over claims. `dry_run=1` does not write, so there the offset paging
 * is correct.
 */
export async function handleGeneratedReceiptSeed(
  request: Request,
  env: { DB: D1Database; R2_BUCKET: R2Bucket },
  dcRole: string | null
): Promise<Response> {
  if (dcRole !== "super_admin") {
    return jsonError(403, "seed requires super_admin");
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "2026-01-01";
  const to = url.searchParams.get("to") ?? "2027-01-01";
  const dryRun = url.searchParams.get("dry_run") === "1";
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.min(
    MAX_LIMIT,
    Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_LIMIT
  );

  let claims: ClaimRow[];
  try {
    claims = await fetchClaimsNeedingReceipts(env.DB, { from, to, limit, offset });
  } catch (err) {
    console.error("[damage.seed.receipts] claim read failed:", err);
    return jsonError(500, err instanceof Error ? err.message : "claim read failed");
  }

  const outcomes: ClaimOutcome[] = [];
  let generated = 0;
  let alreadyPresent = 0;
  let skipped = 0;
  let failed = 0;
  // How many of the built documents could point at the original Box scan.
  // Anything short of `generated` means those PDFs are reconstructions with no
  // route back to the signed paperwork.
  let withBoxLink = 0;

  for (const claim of claims) {
    const amount = claim.approved_amount;
    const base: ClaimOutcome = {
      claim_id: claim.claim_id,
      customer_name: claim.customer_name,
      amount,
      outcome: "skipped"
    };

    // No amount, no receipt. The figure is not recoverable from D1 — it has to
    // come from the workbook or from Box — and a receipt showing $0 or a guess
    // would corrupt the reporting this whole pass exists to fix.
    if (amount === null || amount === undefined || !(amount > 0)) {
      skipped += 1;
      outcomes.push({ ...base, reason: "no approved_amount — needs the workbook or Box" });
      continue;
    }

    const boxLink = boxLinkFrom(claim.staff_notes);
    const filename = `Req_${claim.claim_id}_${FILENAME_STEM}.pdf`;
    const r2Key = `claims/${claim.claim_id}/${filename}`;

    const existing = await env.DB.prepare(
      `SELECT 1 AS hit FROM claim_photos WHERE claim_id = ?1 AND r2_key = ?2 AND deleted_at IS NULL LIMIT 1`
    )
      .bind(claim.claim_id, r2Key)
      .first<{ hit: number }>();
    if (existing) {
      alreadyPresent += 1;
      outcomes.push({ ...base, outcome: "already_present", r2_key: r2Key });
      continue;
    }

    if (dryRun) {
      outcomes.push({ ...base, outcome: "dry_run", r2_key: r2Key, box_link: Boolean(boxLink) });
      continue;
    }

    try {
      const pdfBytes = await buildReconstructionPdf(claim, amount, boxLink);

      // R2 first. An orphaned object is harmless and cheap to sweep; a
      // claim_photos row pointing at a key that was never written renders as a
      // broken document on the detail page.
      await env.R2_BUCKET.put(r2Key, pdfBytes, {
        httpMetadata: { contentType: "application/pdf" }
      });

      await env.DB.prepare(
        `INSERT INTO claim_photos (
          claim_id, photo_type, r2_key, filename, content_type,
          size_bytes, amount, notes, uploaded_by
        ) VALUES (?1, 'Receipt', ?2, ?3, 'application/pdf', ?4, ?5, ?6, ?7)`
      )
        .bind(
          claim.claim_id,
          r2Key,
          filename,
          pdfBytes.length,
          amount,
          boxLink
            ? `${IMPORT_LABEL}. Original signed paperwork: ${boxLink}`
            : `${IMPORT_LABEL}. No scanned paperwork on file.`,
          UPLOADED_BY
        )
        .run();

      generated += 1;
      withBoxLink += boxLink ? 1 : 0;
      outcomes.push({
        ...base,
        outcome: "generated",
        r2_key: r2Key,
        box_link: Boolean(boxLink)
      });
    } catch (err) {
      console.error(`[damage.seed.receipts] failed for ${claim.claim_id}:`, err);
      failed += 1;
      outcomes.push({
        ...base,
        outcome: "failed",
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return json({
    ok: true,
    dry_run: dryRun,
    from,
    to,
    offset,
    page_size: limit,
    fetched: claims.length,
    // On a live run every generated claim drops out of the query, so keep
    // calling with offset 0 until `fetched` is 0.
    has_more: claims.length === limit,
    generated,
    with_box_link: withBoxLink,
    already_present: alreadyPresent,
    skipped,
    failed,
    outcomes
  });
}
