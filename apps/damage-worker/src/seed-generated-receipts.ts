// Task #15 — reconstruct the missing paperwork for paid 2026 claims that have
// no document at all.
//
// WHY THIS IS NEEDED AND WHY IT IS NOT "INVENTING" DOCUMENTS: the dashboard's
// cost figures sum `claim_photos.amount` for photo_type IN ('Quote','Receipt').
// They never read `claims.approved_amount`. So a claim can be Closed — Paid
// with a correct amount on the claim row and still contribute nothing to
// reported cost, because no document carries the money. 105 paid 2026 claims
// were in exactly that state after the workbook backfill — 104 migrated from
// JotForm, and 1 raised in the damage worker itself, which is deliberately out
// of scope (see fetchClaimsNeedingReceipts).
//
// These are historic records. Nothing is paid from the documents this endpoint
// writes — the cheques cleared months ago, and the real paperwork sits in Box.
// The generated PDF is a reconstruction of what was filed, from the claim data
// we do hold, so that the new dashboard can report the year accurately. That is
// also why the row is stored as 'Receipt' rather than 'Check Request': a check
// request means "please cut a cheque", which would be false, and 'Check Request'
// is excluded from the cost sums anyway.
//
// AMOUNT SOURCE: `claims.approved_amount`, which for 2026 came from the master
// workbook Cost column. A claim with no amount is skipped, not guessed at —
// there is nothing in D1 to reconstruct the figure from, and a receipt for the
// wrong number is worse than no receipt.
//
// IDEMPOTENT: the r2 key is deterministic (`Req_{claim_id}_migration-generated`),
// and a claim whose key is already in claim_photos is reported `already_present`
// without a rebuild. Safe to re-run and safe to page in any order.

import { json, jsonError } from "@splash/http";
import type { ClaimPhotoRow, ClaimRow } from "@splash/types/claims";
import { storeCheckRequestPdf } from "./pdf.js";

/** Page size ceiling. Each claim costs a handful of subrequests plus an R2 put
 *  and a PDF render, so the page stays small — this is much heavier per row
 *  than the claim seed. */
const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;

/** Stamped on every row this endpoint writes, so the reconstructions can be
 *  told apart from imported paperwork later — if the Box files ever land, these
 *  are exactly the rows to replace. */
const UPLOADED_BY = "migration:generated";

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
 * MIGRATED CLAIMS ONLY (operator decision, 2026-08-20). `idempotency_key LIKE
 * 'jotform:%'` is the marker for a claim that came out of the old JotForm
 * process. A claim raised directly in the damage worker that is paid with no
 * document is a different problem entirely: its paperwork is missing from a
 * live workflow, and someone should go find it. Reconstructing a document for
 * it would paper over a gap that is still fixable for real. Exactly one paid
 * 2026 claim is in that state today, and it stays out.
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
          AND c.idempotency_key LIKE 'jotform:%'
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
 * Returns "" when there is no link, and the caller prints nothing rather than
 * an empty label.
 */
function boxLinkFrom(staffNotes: string | null): string {
  const match = (staffNotes ?? "").match(/https:\/\/\S*box\.com\/\S+/i);
  // Trailing punctuation from prose — "…/file/123." — would 404 if clicked.
  return (match?.[0] ?? "").replace(/[).,;]+$/, "");
}

/** MM/DD/YYYY in eastern time, from the claim's submitted_at. The live path
 *  stamps today, which would date every reconstruction to the day we ran the
 *  migration. */
function claimDate(submittedAt: string): string {
  const d = new Date(submittedAt.replace(" ", "T") + (submittedAt.includes("Z") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "numeric"
  });
}

/**
 * POST /manage/api/seed/generated-receipts?from=&to=&limit=&offset=&dry_run=1
 *
 * super_admin only. Loop on `has_more`, bumping `offset` by `page_size`.
 *
 * NOTE ON PAGING: rows leave the result set as they are processed (they gain a
 * document and stop matching), so on a live run `offset` should stay at 0 and
 * the loop should simply repeat until `fetched` is 0. Paging forward on a live
 * run steps over claims. `dry_run=1` does not write, so there the offset paging
 * is correct.
 */
export async function handleGeneratedReceiptSeed(
  request: Request,
  env: { DB: D1Database; R2_BUCKET: R2Bucket; IMAGES?: unknown },
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
    const amount = (claim as ClaimRow & { approved_amount: number | null }).approved_amount;
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

    // The quote row the PDF builder reads. Synthesised, never inserted on its
    // own: storeCheckRequestPdf inserts the document row, and that row is what
    // carries the amount into reporting.
    const quote: ClaimPhotoRow = {
      id: 0,
      claim_id: claim.claim_id,
      photo_type: "Quote",
      filename: "",
      r2_key: "",
      content_type: null,
      size_bytes: null,
      uploaded_by: UPLOADED_BY,
      vendor: null,
      amount,
      notes: null,
      pay_to_type: "customer",
      vendor_address: null,
      deleted_at: null
    };

    try {
      const stored = await storeCheckRequestPdf(
        env.DB,
        env.R2_BUCKET,
        claim,
        quote,
        // No signature was ever captured for these — the original signed copy
        // is the Box paperwork. Saying so on the face of the document is better
        // than a blank line that reads like an oversight.
        "Reconstructed from claim record",
        "Reconstructed from claim record",
        "Historic reconstruction",
        env.IMAGES as never,
        null,
        {
          date: claimDate(claim.submitted_at),
          // The explanation field is the only free-text block on the template
          // big enough to carry a URL, and the link to the original signed
          // paperwork is the single most useful thing this reconstruction can
          // point at. Precedent: the paper-claim placeholder PDFs print the Box
          // link on their face for the same reason.
          explanation: [
            claim.damage_description?.trim() || "Reconstructed from the claim record.",
            boxLink ? `Original paperwork: ${boxLink}` : ""
          ]
            .filter(Boolean)
            .join("\n\n")
        },
        null,
        `Req_${claim.claim_id}_${FILENAME_STEM}`
      );

      // storeCheckRequestPdf hardcodes photo_type 'Check Request' and stamps
      // the requestor as uploader. Both are wrong for a reconstruction, and
      // 'Check Request' is excluded from the cost sums — which would leave this
      // claim reporting $0, i.e. exactly the bug we are here to fix. Corrected
      // in place rather than by forking the shared generator.
      if (stored.id !== null) {
        await env.DB.prepare(
          `UPDATE claim_photos
              SET photo_type = 'Receipt',
                  uploaded_by = ?2,
                  notes = ?3
            WHERE id = ?1`
        )
          .bind(
            stored.id,
            UPLOADED_BY,
            "Reconstructed during the 2026 migration from the claim record. " +
              "The original signed paperwork is in Box; replace this row if it is imported."
          )
          .run();
      }

      generated += 1;
      withBoxLink += boxLink ? 1 : 0;
      outcomes.push({
        ...base,
        outcome: "generated",
        r2_key: stored.r2Key,
        box_link: Boolean(boxLink)
      });
    } catch (err) {
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
