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

import { PDFDocument } from "pdf-lib";
import type { ClaimPhotoRow, ClaimRow } from "@splash/types/claims";

const CHECK_REQUEST_TEMPLATE_KEY = "templates/check-request.pdf";

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
 */
export async function generateCheckRequestPdf(
  bucket: R2Bucket,
  fields: CheckRequestFields
): Promise<Uint8Array> {
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

  // Flatten the form so AP receives a non-editable PDF. Failures here are
  // non-fatal — better an unflattened PDF than no PDF.
  try {
    form.flatten();
  } catch (err) {
    console.warn(
      "generateCheckRequestPdf: flatten failed (continuing unflattened):",
      err instanceof Error ? err.message : err
    );
  }

  return pdfDoc.save();
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
  stageLabel: string
): Promise<StoredCheckRequestPdf> {
  const fields = buildCheckRequestFields(claim, quote, requestorEmail, approvalEmail);
  const pdfBytes = await generateCheckRequestPdf(bucket, fields);

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
    pdfBytes
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
  requestorEmail: string
): Promise<SendEmailResult> {
  if (!webhookUrl) {
    console.warn("sendCheckRequestEmail: webhook URL not configured, skipping");
    return { ok: false, status: 0, error: "webhook URL not configured" };
  }

  const pdfBase64 = bytesToBase64(pdfBytes);

  const payload = {
    claimId: claim.claim_id,
    customerName: claim.customer_name ?? "",
    locationPretty: claim.location_pretty ?? "",
    amount: Number(quote.amount ?? 0),
    vendorName: quote.vendor ?? "",
    rmEmail: requestorEmail || "",
    claimUrl: `https://splashcarwashes.info/manage/claim/${encodeURIComponent(claim.claim_id)}`,
    pdfBase64,
    pdfFilename
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
}): Promise<void> {
  const { db, bucket, claim, quote, requestorEmail, approvalEmail, stageLabel, webhookUrl, recipientLabel } = args;

  let stored: StoredCheckRequestPdf;
  try {
    stored = await storeCheckRequestPdf(
      db,
      bucket,
      claim,
      quote,
      requestorEmail,
      approvalEmail,
      stageLabel
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
    requestorEmail
  );
  const noteText = emailResult.ok
    ? `Generated Check Request (${stageLabel}) and emailed to ${recipientLabel}.`
    : `Generated Check Request (${stageLabel}). Email to ${recipientLabel} FAILED: ${
        emailResult.error ?? "status " + emailResult.status
      }.`;
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
