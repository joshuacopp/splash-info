// Check Request PDF generation + storage + email pipeline.
//
// Source: legacy/damagemanager.js:2186-2408. Field-by-field port — drift
// in the AcroForm field names or the webhook payload shape breaks
// downstream Power Automate / SharePoint integrations.
//
// PDF library: pdf-lib (pure JS, ArrayBuffer-based, Workers-compatible).
// Confirmed compatible with the Workers runtime under nodejs_compat — no
// native deps, no fs.
//
// Template: env.R2_BUCKET object at key "templates/check-request.pdf".
// The operator MUST upload the AcroForm template to that key before any
// transition that triggers PDF generation can succeed. When the template
// is missing, the worker logs an activity row noting the failure and
// continues — the status transition itself is never rolled back.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { fileTypeFromBuffer } from "file-type";
import type { ClaimPhotoRow, ClaimRow } from "@splash/types/claims";
import type { ImagesBinding } from "@splash/storage-r2";

const CHECK_REQUEST_TEMPLATE_KEY = "templates/check-request.pdf";

/**
 * Brief 171 — quote-append size guard. Quotes larger than this are NOT
 * embedded into the check-request PDF (the bundled PDF rides Power
 * Automate's base64-in-webhook payload; an oversized quote would push the
 * total past PA's ~4 MB inbound ceiling). Oversized quotes fall back to
 * a link in the webhook instead of being bundled.
 */
const QUOTE_BUNDLE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB raw quote file

interface CheckRequestFields {
  date: string;
  location: string;
  email: string;
  phone: string;
  amount: string;
  makeOutTo: string;
  addressLines: string[];
  explanation: string;
  incidentNumber: string;
  requestorSignature: string;
  approvalSignature: string;
}

/**
 * Fill the AcroForm template and return the resulting PDF bytes.
 * Source: legacy/damagemanager.js:2205 generateCheckRequestPdf.
 *
 * AcroForm field names match the template exactly — do not rename without
 * updating the template (or vice versa).
 *
 * Brief 171 — also appends the approved quote (when supplied) as extra
 * page(s) AFTER the form fill but BEFORE `form.flatten()` / `save()`.
 * `quoteBundled` reports whether the append succeeded; callers thread it
 * through to the webhook payload so PA can decide whether to surface the
 * "View Quote" link. The quote-append step is fully fail-soft — any
 * failure logs and returns `quoteBundled: false`; the check-request PDF
 * itself always saves.
 */
export async function generateCheckRequestPdf(
  bucket: R2Bucket,
  fields: CheckRequestFields,
  quote?: ClaimPhotoRow,
  images?: ImagesBinding
): Promise<{ pdfBytes: Uint8Array; quoteBundled: boolean }> {
  const templateObj = await bucket.get(CHECK_REQUEST_TEMPLATE_KEY);
  if (!templateObj) {
    throw new Error(
      `Check request template not found in R2 at ${CHECK_REQUEST_TEMPLATE_KEY}`
    );
  }
  const templateBytes = await templateObj.arrayBuffer();

  const pdfDoc = await PDFDocument.load(templateBytes);
  const form = pdfDoc.getForm();

  const setIf = (name: string, value: string | null | undefined) => {
    if (value === null || value === undefined) return;
    try {
      form.getTextField(name).setText(String(value));
    } catch (err) {
      console.warn(
        `generateCheckRequestPdf: could not set field "${name}":`,
        err instanceof Error ? err.message : err
      );
    }
  };

  setIf("Date", fields.date);
  setIf("Location", fields.location);
  setIf("Email", fields.email);
  setIf("Phone Number", fields.phone);
  setIf("Dollar Amount", fields.amount);
  setIf("Check Made out to", fields.makeOutTo);
  setIf("Address Line 1", fields.addressLines[0] ?? "");
  setIf("Address Line 2", fields.addressLines[1] ?? "");
  setIf("Address Line 3", fields.addressLines[2] ?? "");
  setIf("Address Line 4", fields.addressLines[3] ?? "");
  setIf("Explanation", fields.explanation);
  setIf("Incident Number", fields.incidentNumber);
  setIf("Signature of Requestor", fields.requestorSignature);
  setIf("Approval", fields.approvalSignature);

  // Brief 171 — append the approved quote pages BEFORE flatten/save.
  // `appendQuoteToPdf` never throws; on failure it just returns false and
  // we fall back to the link in the webhook payload.
  let quoteBundled = false;
  if (quote) {
    quoteBundled = await appendQuoteToPdf(pdfDoc, bucket, images, quote);
  }

  // Flatten the form so AP receives a non-editable PDF. Failures here are
  // non-fatal — better an unflattened PDF than no PDF. The appended quote
  // pages have no form fields (PDF branch) or are drawn-content images,
  // so flatten remains safe.
  try {
    form.flatten();
  } catch (err) {
    console.warn(
      "generateCheckRequestPdf: flatten failed (continuing unflattened):",
      err instanceof Error ? err.message : err
    );
  }

  const pdfBytes = await pdfDoc.save();
  return { pdfBytes, quoteBundled };
}

/**
 * Brief 171 — best-effort: append the approved quote to `pdfDoc` as extra
 * page(s). Returns true if the quote was embedded, false if it must fall
 * back to a link (unsupported / oversized / conversion-failed /
 * read-failed). NEVER throws — every failure path logs and returns false.
 *
 *  - application/pdf       → copyPages + addPage for each quote page
 *  - image/jpeg            → embedJpg → one fitted page
 *  - image/png             → embedPng → one fitted page
 *  - image/heic|heif(+seq) → convert to JPEG via env.IMAGES, then embedJpg
 *  - anything else / IMAGES unbound / decode error / size > cap → false
 *
 * Reads the quote bytes from R2 directly with `bucket.get(quote.r2_key)`.
 * `r2_key` for quote `claim_photos` rows already includes the `claims/`
 * prefix (see `uploadClaimPhoto` in `@splash/storage-r2`) — do NOT
 * double-prefix (Brief 104 footgun).
 */
export async function appendQuoteToPdf(
  pdfDoc: PDFDocument,
  bucket: R2Bucket,
  images: ImagesBinding | undefined,
  quote: ClaimPhotoRow
): Promise<boolean> {
  try {
    if (!quote.r2_key) {
      console.warn("[checkreq.quote] append skipped: quote has no r2_key");
      return false;
    }

    const obj = await bucket.get(quote.r2_key);
    if (!obj) {
      console.warn(
        `[checkreq.quote] append failed (fallback to link): R2 object not found at ${quote.r2_key}`
      );
      return false;
    }
    // Size guard — checked against `size` before pulling bytes.
    if (obj.size > QUOTE_BUNDLE_MAX_BYTES) {
      console.warn(
        `[checkreq.quote] append skipped (size ${obj.size} > ${QUOTE_BUNDLE_MAX_BYTES}): falling back to link`
      );
      return false;
    }

    const bytes = new Uint8Array(await obj.arrayBuffer());

    // Resolve MIME — prefer the stored content_type, but sniff if it's
    // empty / generic so we don't mis-dispatch on a stale value.
    let mime = (quote.content_type ?? "").toLowerCase();
    if (!mime || mime === "application/octet-stream") {
      const sniffed = await fileTypeFromBuffer(
        bytes.subarray(0, Math.min(bytes.length, 4100))
      );
      if (sniffed) mime = sniffed.mime;
    }

    if (mime === "application/pdf") {
      return await appendPdfQuotePages(pdfDoc, bytes);
    }
    if (mime === "image/jpeg") {
      return await appendImageQuotePage(pdfDoc, bytes, "jpeg", quote);
    }
    if (mime === "image/png") {
      return await appendImageQuotePage(pdfDoc, bytes, "png", quote);
    }
    if (
      mime === "image/heic" ||
      mime === "image/heif" ||
      mime === "image/heic-sequence" ||
      mime === "image/heif-sequence"
    ) {
      if (!images) {
        console.warn(
          "[checkreq.quote] append failed (fallback to link): IMAGES binding unbound, cannot convert HEIC/HEIF"
        );
        return false;
      }
      let jpegBytes: Uint8Array;
      try {
        const stream = new Blob([bytes as BlobPart]).stream();
        const result = await images.input(stream).output({ format: "image/jpeg" });
        const buf = await result.response().arrayBuffer();
        jpegBytes = new Uint8Array(buf);
      } catch (convErr) {
        console.warn(
          "[checkreq.quote] append failed (fallback to link): HEIC→JPEG conversion threw:",
          convErr instanceof Error ? convErr.message : convErr
        );
        return false;
      }
      return await appendImageQuotePage(pdfDoc, jpegBytes, "jpeg", quote);
    }

    console.warn(
      `[checkreq.quote] append skipped (unsupported MIME "${mime}"): falling back to link`
    );
    return false;
  } catch (err) {
    console.warn(
      "[checkreq.quote] append failed (fallback to link):",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

async function appendPdfQuotePages(
  pdfDoc: PDFDocument,
  bytes: Uint8Array
): Promise<boolean> {
  let q: PDFDocument;
  try {
    q = await PDFDocument.load(bytes);
  } catch (loadErr) {
    console.warn(
      "[checkreq.quote] append failed (fallback to link): PDF load threw (likely encrypted/corrupt):",
      loadErr instanceof Error ? loadErr.message : loadErr
    );
    return false;
  }
  const pages = await pdfDoc.copyPages(q, q.getPageIndices());
  for (const p of pages) pdfDoc.addPage(p);
  return true;
}

async function appendImageQuotePage(
  pdfDoc: PDFDocument,
  bytes: Uint8Array,
  format: "jpeg" | "png",
  quote: ClaimPhotoRow
): Promise<boolean> {
  let image;
  try {
    image =
      format === "jpeg"
        ? await pdfDoc.embedJpg(bytes)
        : await pdfDoc.embedPng(bytes);
  } catch (embedErr) {
    console.warn(
      `[checkreq.quote] append failed (fallback to link): embed${
        format === "jpeg" ? "Jpg" : "Png"
      } threw:`,
      embedErr instanceof Error ? embedErr.message : embedErr
    );
    return false;
  }

  // US Letter; ~0.5 in margins; small header label above the image.
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 36; // 0.5 in
  const headerHeight = 24;
  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  // Header label: "Approved Quote — {vendor}" near the top margin.
  try {
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const label = quote.vendor
      ? `Approved Quote — ${quote.vendor}`
      : "Approved Quote";
    page.drawText(label, {
      x: margin,
      y: pageHeight - margin - 12,
      size: 12,
      font,
      color: rgb(0.04, 0.16, 0.34) // splash-navy-ish
    });
  } catch {
    /* swallow — header is cosmetic, never block the image */
  }

  const availW = pageWidth - margin * 2;
  const availH = pageHeight - margin * 2 - headerHeight;
  const scale = Math.min(availW / image.width, availH / image.height, 1);
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  const drawX = margin + (availW - drawW) / 2;
  const drawY = margin + (availH - drawH) / 2; // bottom margin + center within remaining

  page.drawImage(image, {
    x: drawX,
    y: drawY,
    width: drawW,
    height: drawH
  });

  return true;
}

/**
 * Split a single-line mailing address into up to 4 lines. Source: legacy:2258.
 * Heuristic: split on newlines first, then on commas if needed.
 */
function splitAddressLines(address: string | null | undefined): string[] {
  if (!address) return [];
  const trimmed = String(address).trim();
  if (!trimmed) return [];
  let lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1) {
    lines = trimmed.split(",").map((l) => l.trim()).filter(Boolean);
  }
  return lines.slice(0, 4);
}

/**
 * Build PDF field set from a quote + claim. Source: legacy:2273
 * buildCheckRequestFields.
 *
 * Both signature parameters are strings (never null) for the preview path
 * — preview passes "(preview — not signed)" / "DRAFT — NOT FOR PAYMENT".
 * For the real generation path, requestor is the actor's email and
 * approval is either "" (RM stage) or actor's email (incidents stage).
 */
export function buildCheckRequestFields(
  claim: ClaimRow,
  quote: ClaimPhotoRow,
  requestorSignature: string,
  approvalSignature: string
): CheckRequestFields {
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "numeric"
  });

  let makeOutTo: string;
  let addressLines: string[];
  if (quote.pay_to_type === "vendor") {
    makeOutTo = quote.vendor ?? "";
    addressLines = splitAddressLines(quote.vendor_address);
  } else {
    makeOutTo = claim.customer_name ?? "";
    addressLines = splitAddressLines(claim.customer_mailing_address);
  }

  const vehicleDesc = [claim.vehicle_year, claim.vehicle_make, claim.vehicle_model]
    .filter(Boolean)
    .join(" ");
  const vendorPart = quote.vendor ? `${quote.vendor} quote` : "Quote";
  const explanation =
    `Vehicle damage claim for ${vehicleDesc || "customer vehicle"}` +
    (claim.license_plate ? ` (plate ${claim.license_plate})` : "") +
    `. ${vendorPart}: $${Number(quote.amount ?? 0).toFixed(2)}.`;

  return {
    date: dateStr,
    location: claim.location_pretty ?? "",
    email: claim.customer_email ?? "",
    phone: claim.customer_phone ?? "",
    amount:
      quote.amount !== null && quote.amount !== undefined
        ? Number(quote.amount).toFixed(2)
        : "",
    makeOutTo,
    addressLines,
    explanation,
    incidentNumber: claim.claim_id,
    requestorSignature,
    approvalSignature
  };
}

interface StoredCheckRequestPdf {
  id: number | null;
  r2Key: string;
  filename: string;
  pdfBytes: Uint8Array;
  /** Brief 171 — true when the approved quote was embedded into the
   *  generated PDF (extra page[s] after the check-request form). When
   *  false the caller should include the quote link in the webhook
   *  payload so PA can surface the "View Quote" link. */
  quoteBundled: boolean;
}

/**
 * Generate the PDF, write to R2, insert a claim_photos row of type
 * "Check Request". Source: legacy:2316 storeCheckRequestPdf.
 *
 * Filename: Req_{claim_id}_{stage-slug}.pdf — with a sequence suffix only
 * if the same claim+stage was generated more than once (admin re-fire).
 */
export async function storeCheckRequestPdf(
  db: D1Database,
  bucket: R2Bucket,
  claim: ClaimRow,
  quote: ClaimPhotoRow,
  requestorEmail: string,
  approvalEmail: string,
  stageLabel: string,
  images: ImagesBinding | undefined
): Promise<StoredCheckRequestPdf> {
  const fields = buildCheckRequestFields(claim, quote, requestorEmail, approvalEmail);
  const { pdfBytes, quoteBundled } = await generateCheckRequestPdf(
    bucket,
    fields,
    quote,
    images
  );

  const stageSlug = stageLabel
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const baseFilename = `Req_${claim.claim_id}_${stageSlug}`;

  // Check existing files with this base — append sequence suffix if any.
  const existingResult = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM claim_photos
       WHERE claim_id = ? AND photo_type = 'Check Request' AND filename LIKE ?
       AND deleted_at IS NULL`
    )
    .bind(claim.claim_id, baseFilename + "%")
    .first<{ n: number }>();
  const existingCount = existingResult?.n ?? 0;
  const filename =
    existingCount > 0 ? `${baseFilename}_${existingCount + 1}.pdf` : `${baseFilename}.pdf`;
  const r2Key = `claims/${claim.claim_id}/${filename}`;

  await bucket.put(r2Key, pdfBytes, {
    httpMetadata: { contentType: "application/pdf" }
  });

  const insertResult = await db
    .prepare(
      `INSERT INTO claim_photos (
        claim_id, photo_type, r2_key, filename, content_type,
        vendor, amount, notes, uploaded_by
      ) VALUES (?, 'Check Request', ?, ?, 'application/pdf', NULL, ?, ?, ?)`
    )
    .bind(claim.claim_id, r2Key, filename, quote.amount, stageLabel, requestorEmail || "system")
    .run();

  return {
    id: insertResult.meta?.last_row_id ?? null,
    r2Key,
    filename,
    pdfBytes,
    quoteBundled
  };
}

/**
 * Encode bytes to base64. Source: legacy:2375-2379 (manual loop pattern —
 * works for arbitrary binary input where btoa() alone would corrupt UTF-8
 * surrogates).
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Loop bound guarantees `bytes[i]` is in range; the `!` asserts that for
  // tsconfig's noUncheckedIndexedAccess. Workers runtime supports btoa().
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Brief 171 — build the public `/claims-api/photo/...` URL for a quote's
 * R2 key. Mirrors the strip-`claims/`-prefix-and-URL-encode-segments
 * shape used by `apps/web`'s `damagePhotoUrl` and the internal new-claim
 * webhook builder in `notifications.ts` (Brief 104 fix). Returns null when
 * the r2_key is empty/missing so the webhook surfaces an explicit null
 * (PA can branch on that vs. a stale empty string).
 */
function buildQuoteUrl(r2Key: string | null | undefined): string | null {
  if (!r2Key) return null;
  const stripped = r2Key.startsWith("claims/")
    ? r2Key.slice("claims/".length)
    : r2Key;
  const segments = stripped.split("/").map(encodeURIComponent).join("/");
  return `https://splashcarwashes.info/claims-api/photo/${segments}`;
}

interface SendEmailResult {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * POST the PDF + claim summary to a Power Automate webhook.
 * Returns a result tuple (never throws). Source: legacy:2368 sendCheckRequestEmail.
 *
 * Webhook payload shape MUST match legacy field-by-field — Power Automate's
 * Parse JSON action consumes these names downstream.
 */
export async function sendCheckRequestEmail(
  webhookUrl: string | undefined,
  claim: ClaimRow,
  quote: ClaimPhotoRow,
  pdfBytes: Uint8Array,
  pdfFilename: string,
  requestorEmail: string,
  quoteBundled: boolean
): Promise<SendEmailResult> {
  if (!webhookUrl) {
    console.warn("sendCheckRequestEmail: webhook URL not configured, skipping");
    return { ok: false, status: 0, error: "webhook URL not configured" };
  }

  const pdfBase64 = bytesToBase64(pdfBytes);

  // Brief 171 — build the link-fallback URL from quote.r2_key with the
  // same strip-and-encode shape `notifications.ts` uses for the internal
  // new-claim webhook (Brief 104). `serveClaimPhoto` prepends "claims/"
  // before the R2 .get(), so the URL path must NOT include that prefix
  // already baked into r2_key.
  const quoteUrl = buildQuoteUrl(quote.r2_key);

  const payload = {
    claimId: claim.claim_id,
    customerName: claim.customer_name ?? "",
    locationPretty: claim.location_pretty ?? "",
    amount: Number(quote.amount ?? 0),
    vendorName: quote.vendor ?? "",
    rmEmail: requestorEmail || "",
    claimUrl: `https://splashcarwashes.info/manage/claim/${encodeURIComponent(claim.claim_id)}`,
    pdfBase64,
    pdfFilename,
    // Brief 171 — additive only; existing field names unchanged.
    // `quoteUrl` is always sent (cheap, canonical reference); operator
    // wires the conditional "View Quote" link in PA on `quoteBundled === false`.
    quoteUrl,
    quoteBundled
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      console.error("sendCheckRequestEmail: webhook returned", response.status);
      return {
        ok: false,
        status: response.status,
        error: `webhook returned ${response.status}`
      };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    console.error("sendCheckRequestEmail: fetch failed:", err);
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Wrapper around storeCheckRequestPdf + sendCheckRequestEmail. Logs an
 * activity row indicating the outcome. Never throws — failures are logged
 * + swallowed so the status transition that triggered this is never rolled
 * back (R2 has the canonical archive even when SharePoint sync fails).
 *
 * Source: legacy:2089 runCheckRequestPdfStep.
 *
 * Two distinct call sites:
 *   1. RM Approve Quote        → requestorEmail = RM, approvalEmail = "",
 *                                 stageLabel = "Pending Incidents Review",
 *                                 webhookUrl = INCIDENTS_WEBHOOK_URL,
 *                                 recipientLabel = "incidents"
 *   2. Submit for Payment      → requestorEmail = original RM (from
 *                                 claim.rm_approved_by), approvalEmail =
 *                                 incidents user, stageLabel = "Submitted to AP",
 *                                 webhookUrl = AP_WEBHOOK_URL,
 *                                 recipientLabel = "AP"
 */
export async function runCheckRequestPdfStep(args: {
  db: D1Database;
  bucket: R2Bucket;
  claim: ClaimRow;
  quote: ClaimPhotoRow;
  requestorEmail: string;
  approvalEmail: string;
  stageLabel: string;
  webhookUrl: string | undefined;
  recipientLabel: string;
  /** Brief 171 — env.IMAGES, for HEIC→JPEG conversion of HEIC quotes
   *  during the bundled-quote append step. Optional; when undefined the
   *  HEIC branch falls back to the link in the webhook payload. */
  images: ImagesBinding | undefined;
}): Promise<void> {
  const {
    db,
    bucket,
    claim,
    quote,
    requestorEmail,
    approvalEmail,
    stageLabel,
    webhookUrl,
    recipientLabel,
    images
  } = args;

  let stored: StoredCheckRequestPdf;
  try {
    stored = await storeCheckRequestPdf(
      db,
      bucket,
      claim,
      quote,
      requestorEmail,
      approvalEmail,
      stageLabel,
      images
    );
  } catch (err) {
    console.error("runCheckRequestPdfStep: PDF generation/storage failed:", err);
    try {
      await db
        .prepare(
          `INSERT INTO claim_activity (
            claim_id, activity_type, notes, actor_email, actor_name
          ) VALUES (?, 'note', ?, 'system', 'system')`
        )
        .bind(
          claim.claim_id,
          `[System] Failed to generate Check Request PDF (${stageLabel}): ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        .run();
    } catch {
      /* swallow — best-effort audit */
    }
    return;
  }

  const emailResult = await sendCheckRequestEmail(
    webhookUrl,
    claim,
    quote,
    stored.pdfBytes,
    stored.filename,
    requestorEmail,
    stored.quoteBundled
  );
  // Brief 171 — surface the bundled-quote outcome in the activity-log
  // note so the claim timeline records which path fired (in-PDF vs.
  // link-fallback). Helps later audits explain why a given AP email had
  // / didn't have the quote pages attached.
  const quoteOutcome = stored.quoteBundled
    ? " Quote bundled into PDF."
    : " Quote too large/unsupported to bundle — link included.";
  const noteText = emailResult.ok
    ? `Generated Check Request (${stageLabel}) and emailed to ${recipientLabel}.${quoteOutcome}`
    : `Generated Check Request (${stageLabel}). Email to ${recipientLabel} FAILED: ${
        emailResult.error ?? "status " + emailResult.status
      }.${quoteOutcome}`;
  try {
    await db
      .prepare(
        `INSERT INTO claim_activity (
          claim_id, activity_type, notes, actor_email, actor_name
        ) VALUES (?, 'document_added', ?, 'system', 'system')`
      )
      .bind(claim.claim_id, noteText)
      .run();
  } catch (err) {
    console.error("runCheckRequestPdfStep: failed to log activity row:", err);
  }
}
