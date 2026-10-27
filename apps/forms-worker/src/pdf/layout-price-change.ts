// Price change request PDF -- the body used instead of the generic
// metadata / responses / history layout for any form carrying a
// package_price_grid field.
//
// WHY A DEDICATED LAYOUT. The generic PDF is an audit dump: the decision sits
// on page 2 under email-step log lines, the signature is a thumbnail, and the
// price change is one run-on line. This document is read by someone deciding
// whether a price is now allowed to change, so the order is the order of that
// question:
//
//   1. Status banner     -- APPROVED / DENIED / AWAITING APPROVAL, first thing
//   2. Request           -- site, who asked, when
//   3. Price changes     -- one row per package, current -> new, with the
//                           difference, so nobody does arithmetic
//   4. Requester's notes
//   5. Decision          -- approver, time, how they acted, and EITHER the
//                           signature in a signature box OR the denial reason
//
// System email-step entries are left out entirely: "enqueued 1 email" is
// plumbing, not part of the decision. The full trail is still on the
// submission page.
//
// Gated in generate.ts on the schema having a price grid, so every other
// form's PDF is unchanged.

import { rgb, type PDFDocument, type RGB } from "pdf-lib";

import type {
  FormSchema,
  SubmissionPayload,
  WorkflowHistoryEntry
} from "@splash/forms-schema";
import {
  isPackagePriceRows,
  isPackagePriceSites,
  packageLabel,
  priceDiff,
  serviceCategoryLabel,
  siteLabel,
  type NewPackage,
  type PackagePriceRow,
  type PackagePriceSite,
  type ServicePrice
} from "@splash/forms-schema";

import {
  CONTENT_WIDTH,
  COLORS,
  MARGIN,
  addPageIfNeeded,
  drawKeyValueGrid,
  drawSectionHeading,
  drawSpacer,
  fetchAndEmbedR2Image,
  formatEst,
  sanitizeForWinAnsi,
  shortId,
  truncateToWidth,
  wrapText,
  type Cursor,
  type Fonts,
  type R2Like
} from "./layout-utils.js";

const SYSTEM_ACTOR = "system@forms";

const GREEN_TEXT: RGB = rgb(4 / 255, 120 / 255, 87 / 255); // emerald-700
const GREEN_BORDER: RGB = rgb(16 / 255, 185 / 255, 129 / 255); // emerald-500
const RED_TEXT: RGB = rgb(185 / 255, 28 / 255, 28 / 255); // red-700
const RED_BORDER: RGB = rgb(239 / 255, 68 / 255, 68 / 255); // red-500
const AMBER_TEXT: RGB = rgb(146 / 255, 64 / 255, 14 / 255); // amber-800

type Verdict = "approved" | "denied" | "pending";

export interface PriceChangeInput {
  schema: FormSchema;
  payload: SubmissionPayload;
  submittedAt: string;
  submissionId: string;
  submitterEmail: string | null;
  workflowHistory: WorkflowHistoryEntry[];
  outcomeLabel: string | null;
  outcomeReachedAt: string | null;
  bucket: R2Like;
}

export function hasPriceGrid(schema: FormSchema): boolean {
  return schema.fields.some((f) => f.type === "package_price_grid");
}

/** Site line for the header subtitle: "Binghamton (122)", or "3 sites" for a
 *  multi-site request (each site is named over its own table below). */
export function priceChangeSubtitle(schema: FormSchema, payload: SubmissionPayload): string | null {
  const sites = multiSiteValue(schema, payload);
  if (sites) return sites.length === 1 ? siteLabel(sites[0]!) : `${sites.length} sites`;
  const { name, number } = siteOf(schema, payload);
  if (name && number) return `${name} (${number})`;
  return name || number || null;
}

/** The sites of the first multi-site grid, when there is one with a value. */
function multiSiteValue(schema: FormSchema, payload: SubmissionPayload): PackagePriceSite[] | null {
  for (const f of schema.fields) {
    if (f.type !== "package_price_grid" || !f.multiSite) continue;
    const v = payload[f.key];
    if (isPackagePriceSites(v)) return v;
  }
  return null;
}

export async function drawPriceChange(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  input: PriceChangeInput
): Promise<void> {
  const decision = lastHumanDecision(input.workflowHistory);
  const verdict = verdictOf(input.schema, input.outcomeLabel);

  drawStatusBanner(cursor, fonts, verdict, input.outcomeLabel, decision, input.outcomeReachedAt);

  // --- Request ------------------------------------------------------------
  drawSectionHeading(doc, cursor, fonts, "Request");
  // Four cells = two rows. A fifth cell costs a whole row, and that row is the
  // difference between the signature landing on page 1 or alone on page 2.
  const multi = multiSiteValue(input.schema, input.payload);
  drawKeyValueGrid(doc, cursor, fonts, [
    [multi && multi.length > 1 ? "Sites" : "Site", priceChangeSubtitle(input.schema, input.payload) ?? "-"],
    ["Requested by", input.submitterEmail ?? "-"],
    ["Submitted", formatEst(input.submittedAt)],
    ["Request ID", shortId(input.submissionId)]
  ]);
  drawSpacer(cursor, 6);

  // --- Price changes -------------------------------------------------------
  for (const field of input.schema.fields) {
    if (field.type !== "package_price_grid") continue;
    const rows = input.payload[field.key];
    drawSectionHeading(doc, cursor, fonts, field.label || "Price changes");
    if (isPackagePriceSites(rows)) {
      for (const s of rows) {
        drawSiteHeading(doc, cursor, fonts, siteLabel(s));
        drawPriceTable(doc, cursor, fonts, s.rows, s.new_packages ?? []);
        drawServicesTable(doc, cursor, fonts, s.services ?? []);
        drawSpacer(cursor, 12);
      }
      drawSpacer(cursor, 4);
      continue;
    }
    if (isPackagePriceRows(rows)) drawPriceTable(doc, cursor, fonts, rows);
    else drawMuted(doc, cursor, fonts, "No packages selected.");
    drawSpacer(cursor, 16);
  }

  // --- Requester's notes ---------------------------------------------------
  // Every answered field the sections above did not already show: today that
  // is the notes box, but a field added to the form later still prints.
  const shownKeys = new Set(
    input.schema.fields
      .filter((f) => f.type === "package_price_grid" || f.type === "lookup" || f.key === "site_number")
      .map((f) => f.key)
  );
  for (const field of input.schema.fields) {
    if (shownKeys.has(field.key)) continue;
    if (field.type === "heading" || field.type === "image") continue;
    if ((field as { exclude_from_pdf?: boolean }).exclude_from_pdf) continue;
    const v = input.payload[field.key];
    if (field.type === "file") {
      // Signage / graphics: thumbnails, so the signed record shows what was
      // approved, not just that something was attached.
      const list = Array.isArray(v) ? v : v ? [v] : [];
      const entries = list
        .map((e) => (e ?? {}) as Record<string, unknown>)
        .filter((o) => typeof o.r2_key === "string")
        .map((o) => ({
          r2_key: o.r2_key as string,
          name:
            typeof o.original_filename === "string" && o.original_filename
              ? o.original_filename
              : String(o.r2_key).split("/").pop() ?? "file",
          mime: typeof o.mime === "string" ? o.mime : ""
        }));
      await drawAttachments(doc, cursor, fonts, field.label, entries, input.bucket);
      continue;
    }
    if (typeof v !== "string" || !v.trim()) continue;
    drawSectionHeading(doc, cursor, fonts, field.label);
    drawBox(doc, cursor, fonts, v, { fill: rgb(248 / 255, 250 / 255, 252 / 255), border: COLORS.subtle, text: COLORS.text });
    drawSpacer(cursor, 8);
  }

  // --- Decision ------------------------------------------------------------
  drawSectionHeading(doc, cursor, fonts, "Decision");
  if (!decision || verdict === "pending") {
    drawMuted(doc, cursor, fonts, "Awaiting approval. No decision has been recorded yet.");
    return;
  }
  await drawDecision(doc, cursor, fonts, decision, verdict, input.bucket);
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function siteOf(schema: FormSchema, payload: SubmissionPayload): { name: string; number: string } {
  const lookup = schema.fields.find((f) => f.type === "lookup");
  const numberField =
    schema.fields.find((f) => f.key === "site_number") ??
    schema.fields.find((f) => f.type === "location");
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    name: lookup ? str(payload[lookup.key]) : "",
    number: numberField ? str(payload[numberField.key]) : ""
  };
}

/** The most recent transition a PERSON made -- the approval or denial. */
function lastHumanDecision(history: WorkflowHistoryEntry[]): WorkflowHistoryEntry | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h && h.actor_email !== SYSTEM_ACTOR) return h;
  }
  return null;
}

function verdictOf(schema: FormSchema, outcomeLabel: string | null): Verdict {
  if (!outcomeLabel) return "pending";
  // The outcome's own tint is the operator's statement of what it means;
  // the label keyword is the fallback, matching the email + web renderers.
  const stage = schema.workflow?.stages.find((s) => s.label === outcomeLabel);
  if (stage?.tint === "success") return "approved";
  if (stage?.tint === "danger") return "denied";
  const l = outcomeLabel.toLowerCase();
  if (/approv/.test(l)) return "approved";
  if (/(den|reject)/.test(l)) return "denied";
  return "pending";
}

function drawStatusBanner(
  cursor: Cursor,
  fonts: Fonts,
  verdict: Verdict,
  outcomeLabel: string | null,
  decision: WorkflowHistoryEntry | null,
  reachedAt: string | null
): void {
  const h = 54;
  const palette =
    verdict === "approved"
      ? { fill: COLORS.successFill, border: GREEN_BORDER, text: GREEN_TEXT }
      : verdict === "denied"
        ? { fill: COLORS.dangerFill, border: RED_BORDER, text: RED_TEXT }
        : { fill: COLORS.amberFill, border: COLORS.amberBorder, text: AMBER_TEXT };
  const top = cursor.y + 6;
  cursor.page.drawRectangle({
    x: MARGIN,
    y: top - h,
    width: CONTENT_WIDTH,
    height: h,
    color: palette.fill,
    borderColor: palette.border,
    borderWidth: 1.5
  });
  // Thick left rule, the same accent the section headings use.
  cursor.page.drawRectangle({ x: MARGIN, y: top - h, width: 6, height: h, color: palette.border });

  const word =
    verdict === "approved" ? "APPROVED" : verdict === "denied" ? "DENIED" : "AWAITING APPROVAL";
  cursor.page.drawText(word, {
    x: MARGIN + 20,
    y: top - 34,
    size: 22,
    font: fonts.bold,
    color: palette.text
  });

  const detail =
    verdict === "pending"
      ? "Not yet decided"
      : `${outcomeLabel ?? ""}${decision ? ` by ${decision.actor_email}` : ""}`;
  const when = verdict === "pending" ? "" : formatEst(reachedAt ?? decision?.at ?? null);
  const rightX = MARGIN + 20 + fonts.bold.widthOfTextAtSize(word, 22) + 24;
  const rightW = MARGIN + CONTENT_WIDTH - 14 - rightX;
  cursor.page.drawText(truncateToWidth(detail, fonts.bold, 10, rightW), {
    x: rightX,
    y: top - 24,
    size: 10,
    font: fonts.bold,
    color: palette.text
  });
  if (when) {
    cursor.page.drawText(truncateToWidth(when, fonts.regular, 9, rightW), {
      x: rightX,
      y: top - 38,
      size: 9,
      font: fonts.regular,
      color: palette.text
    });
  }
  cursor.y = top - h - 22;
}

/**
 * Package | Single | Monthly, each price cell reading "$24.00 -> $26.00" with
 * the difference beneath. A custom table rather than drawTable: the new price
 * and the difference carry colour, which is the whole point of the table.
 */
const COL_NAME = 164;
const COL_PRICE = (CONTENT_WIDTH - COL_NAME) / 2;
const TABLE_ROW_H = 34;

/**
 * Header band + zebra rows that break across pages with the header repeated.
 * `paint(i)` draws row i's contents at the current cursor.
 */
function drawTableShell(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  headers: { text: string; x: number }[],
  count: number,
  paint: (i: number) => void
): void {
  const headerH = 20;
  const header = () => {
    addPageIfNeeded(doc, cursor, headerH + TABLE_ROW_H);
    cursor.page.drawRectangle({
      x: MARGIN,
      y: cursor.y - headerH + 4,
      width: CONTENT_WIDTH,
      height: headerH,
      color: COLORS.navy
    });
    const hy = cursor.y - headerH + 10;
    for (const h of headers) {
      cursor.page.drawText(h.text, { x: h.x, y: hy, size: 9, font: fonts.bold, color: COLORS.white });
    }
    cursor.y -= headerH;
  };
  header();
  for (let i = 0; i < count; i++) {
    if (cursor.y - TABLE_ROW_H < 60) {
      cursor.page = doc.addPage([cursor.page.getWidth(), cursor.page.getHeight()]);
      cursor.y = cursor.page.getHeight() - MARGIN;
      header();
    }
    if (i % 2 === 1) {
      cursor.page.drawRectangle({
        x: MARGIN,
        y: cursor.y - TABLE_ROW_H + 4,
        width: CONTENT_WIDTH,
        height: TABLE_ROW_H,
        color: rgb(248 / 255, 250 / 255, 252 / 255)
      });
    }
    paint(i);
    cursor.y -= TABLE_ROW_H;
    cursor.page.drawRectangle({ x: MARGIN, y: cursor.y + 4, width: CONTENT_WIDTH, height: 0.5, color: COLORS.subtle });
  }
}

/** Bold name, with an optional coloured second line ("-> Bath (renamed)"). */
function drawNameCell(
  cursor: Cursor,
  fonts: Fonts,
  name: string,
  sub?: { text: string; color: RGB }
): void {
  cursor.page.drawText(truncateToWidth(name, fonts.bold, 11, COL_NAME - 16), {
    x: MARGIN + 8,
    y: cursor.y - 16,
    size: 11,
    font: fonts.bold,
    color: COLORS.navy
  });
  if (sub) {
    cursor.page.drawText(truncateToWidth(sub.text, fonts.bold, 8, COL_NAME - 16), {
      x: MARGIN + 8,
      y: cursor.y - 28,
      size: 8,
      font: fonts.bold,
      color: sub.color
    });
  }
}

/**
 * Package | Single | Monthly, each price cell reading "$24.00 -> $26.00" with
 * the difference beneath; renamed packages carry "-> New name (renamed)"
 * under the old name, discontinued ones a red DISCONTINUED across the price
 * columns, and new packages follow the existing ones tagged NEW PACKAGE.
 * A custom table rather than drawTable: the new price, the difference and the
 * change tags carry colour, which is the whole point of the table.
 */
function drawPriceTable(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  rows: PackagePriceRow[],
  newPackages: NewPackage[] = []
): void {
  if (rows.length + newPackages.length === 0) return;
  const xSingle = MARGIN + COL_NAME + 8;
  const xMonthly = MARGIN + COL_NAME + COL_PRICE + 8;
  drawTableShell(
    doc,
    cursor,
    fonts,
    [
      { text: "PACKAGE", x: MARGIN + 8 },
      { text: "SINGLE  (current -> new)", x: xSingle },
      { text: "MONTHLY  (current -> new)", x: xMonthly }
    ],
    rows.length + newPackages.length,
    (i) => {
      const r = rows[i];
      if (r) {
        if (r.discontinue) {
          drawNameCell(cursor, fonts, packageLabel(r.pkg), { text: "being removed", color: RED_TEXT });
          cursor.page.drawText("DISCONTINUED", { x: xSingle, y: cursor.y - 16, size: 11, font: fonts.bold, color: RED_TEXT });
          return;
        }
        drawNameCell(
          cursor,
          fonts,
          packageLabel(r.pkg),
          r.rename_to ? { text: `-> ${r.rename_to} (renamed)`, color: COLORS.blue } : undefined
        );
        drawPriceCell(cursor, fonts, xSingle, r.current_single, r.new_single);
        drawPriceCell(cursor, fonts, xMonthly, r.current_monthly, r.new_monthly);
        return;
      }
      const p = newPackages[i - rows.length]!;
      drawNameCell(cursor, fonts, p.name, { text: "NEW PACKAGE", color: GREEN_TEXT });
      for (const [x, v] of [[xSingle, p.single], [xMonthly, p.monthly]] as const) {
        cursor.page.drawText(`$${v}`, { x, y: cursor.y - 16, size: 11, font: fonts.bold, color: COLORS.navy });
        cursor.page.drawText("new", { x, y: cursor.y - 28, size: 8, font: fonts.regular, color: COLORS.muted });
      }
    }
  );
}

/** Lube & detail | Price: one price per service, current -> new. */
function drawServicesTable(doc: PDFDocument, cursor: Cursor, fonts: Fonts, services: ServicePrice[]): void {
  if (services.length === 0) return;
  const xPrice = MARGIN + COL_NAME + 8;
  drawSpacer(cursor, 6);
  drawTableShell(
    doc,
    cursor,
    fonts,
    [
      { text: "LUBE & DETAIL", x: MARGIN + 8 },
      { text: "PRICE  (current -> new)", x: xPrice }
    ],
    services.length,
    (i) => {
      const s = services[i]!;
      drawNameCell(cursor, fonts, s.name, { text: serviceCategoryLabel(s.category).toUpperCase(), color: COLORS.muted });
      drawPriceCell(cursor, fonts, xPrice, s.current, s.new);
    }
  );
}

/**
 * The request's uploaded graphics: images embedded as thumbnails, two per
 * row; anything pdf-lib cannot embed (PDFs, WebP, HEIC) listed by name, so
 * the record still says it was attached. Capped so a request with dozens of
 * images does not turn the approval PDF into a portfolio.
 */
async function drawAttachments(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  label: string,
  entries: Array<{ r2_key: string; name: string; mime: string }>,
  bucket: R2Like
): Promise<void> {
  if (entries.length === 0) return;
  const MAX_IMAGES = 8;
  const gap = 16;
  const thumbW = (CONTENT_WIDTH - gap) / 2;
  const thumbH = 150;
  // Keep the heading with the first row of thumbnails: a heading stranded at
  // the foot of a page with its images overleaf reads as an empty section.
  const anyImage = entries.some((e) => e.mime === "image/png" || e.mime === "image/jpeg");
  addPageIfNeeded(doc, cursor, 40 + (anyImage ? thumbH + 24 : 30));
  drawSectionHeading(doc, cursor, fonts, label);

  const listed: string[] = [];
  let col = 0;
  let embedded = 0;
  for (const e of entries) {
    const isImage = e.mime === "image/png" || e.mime === "image/jpeg";
    if (!isImage || embedded >= MAX_IMAGES) {
      listed.push(e.name);
      continue;
    }
    let img;
    try {
      img = await fetchAndEmbedR2Image(doc, bucket, e.r2_key);
    } catch (err) {
      console.warn(`[forms.pdf] price-change attachment failed for ${e.r2_key}`, err);
      listed.push(e.name);
      continue;
    }
    if (col === 0) addPageIfNeeded(doc, cursor, thumbH + 24);
    const x = MARGIN + col * (thumbW + gap);
    const scale = Math.min(thumbW / img.width, thumbH / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    cursor.page.drawRectangle({
      x,
      y: cursor.y - thumbH,
      width: thumbW,
      height: thumbH,
      color: rgb(248 / 255, 250 / 255, 252 / 255),
      borderColor: COLORS.subtle,
      borderWidth: 0.75
    });
    cursor.page.drawImage(img, { x: x + (thumbW - w) / 2, y: cursor.y - thumbH + (thumbH - h) / 2, width: w, height: h });
    cursor.page.drawText(truncateToWidth(e.name, fonts.regular, 8, thumbW), {
      x,
      y: cursor.y - thumbH - 11,
      size: 8,
      font: fonts.regular,
      color: COLORS.muted
    });
    embedded++;
    col = (col + 1) % 2;
    if (col === 0) cursor.y -= thumbH + 24;
  }
  if (col === 1) cursor.y -= thumbH + 24;
  if (listed.length) {
    drawLabel(cursor, fonts, embedded ? "Also attached" : "Attached files");
    for (const n of listed) drawMuted(doc, cursor, fonts, n);
  }
  drawSpacer(cursor, 6);
}

function drawPriceCell(cursor: Cursor, fonts: Fonts, x: number, current: string, next: string): void {
  const y = cursor.y - 16;
  if (current === next) {
    cursor.page.drawText(`$${current}`, { x, y, size: 11, font: fonts.regular, color: COLORS.text });
    cursor.page.drawText("no change", { x, y: y - 12, size: 8, font: fonts.regular, color: COLORS.muted });
    return;
  }
  const cur = `$${current}`;
  cursor.page.drawText(cur, { x, y, size: 11, font: fonts.regular, color: COLORS.muted });
  let cx = x + fonts.regular.widthOfTextAtSize(cur, 11) + 6;
  cursor.page.drawText("->", { x: cx, y, size: 11, font: fonts.regular, color: COLORS.muted });
  cx += fonts.regular.widthOfTextAtSize("->", 11) + 6;
  cursor.page.drawText(`$${next}`, { x: cx, y, size: 11, font: fonts.bold, color: COLORS.navy });

  // Shared with the approval page and emails (priceDiff), so the numbers an
  // approver saw on screen are the numbers on the PDF.
  const d = priceDiff(current, next);
  cursor.page.drawText(d.text, {
    x,
    y: y - 12,
    size: 8,
    font: fonts.bold,
    color: d.direction === "up" ? GREEN_TEXT : RED_TEXT
  });
}

async function drawDecision(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  d: WorkflowHistoryEntry,
  verdict: Verdict,
  bucket: R2Like
): Promise<void> {
  const how =
    d.via === "email_link"
      ? `Via emailed approval link${d.actor_ip ? `  *  from ${d.actor_ip}` : ""}`
      : "Signed in to splashcarwashes.info";

  drawKeyValueGrid(doc, cursor, fonts, [
    [verdict === "approved" ? "Approved by" : "Denied by", d.actor_email],
    ["Date", formatEst(d.at)]
  ]);
  drawMuted(doc, cursor, fonts, how);
  drawSpacer(cursor, 6);

  if (verdict === "denied") {
    drawLabel(cursor, fonts, "Reason for denial");
    drawBox(doc, cursor, fonts, d.note || "(no reason given)", {
      fill: COLORS.dangerFill,
      border: RED_BORDER,
      text: RED_TEXT
    });
  } else if (d.note) {
    drawLabel(cursor, fonts, "Approver's note");
    drawBox(doc, cursor, fonts, d.note, {
      fill: rgb(248 / 255, 250 / 255, 252 / 255),
      border: COLORS.subtle,
      text: COLORS.text
    });
  }

  if (d.signature_r2_key || d.typed_name) {
    drawSpacer(cursor, 4);
    await drawSignatureBox(doc, cursor, fonts, d, bucket);
  }
}

/** Signature in a bordered box over a rule, the way a signed form looks. */
async function drawSignatureBox(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  d: WorkflowHistoryEntry,
  bucket: R2Like
): Promise<void> {
  const boxW = 300;
  const boxH = 96;
  addPageIfNeeded(doc, cursor, boxH + 44);
  drawLabel(cursor, fonts, "Signature");
  const top = cursor.y;
  cursor.page.drawRectangle({
    x: MARGIN,
    y: top - boxH,
    width: boxW,
    height: boxH,
    color: COLORS.white,
    borderColor: COLORS.subtle,
    borderWidth: 1
  });
  if (d.signature_r2_key) {
    try {
      const img = await fetchAndEmbedR2Image(doc, bucket, d.signature_r2_key);
      const maxW = boxW - 24;
      const maxH = boxH - 24;
      const scale = Math.min(maxW / img.width, maxH / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      cursor.page.drawImage(img, {
        x: MARGIN + (boxW - w) / 2,
        y: top - boxH + (boxH - h) / 2 + 4,
        width: w,
        height: h
      });
    } catch (err) {
      console.warn(`[forms.pdf] price-change signature failed for ${d.signature_r2_key}`, err);
      cursor.page.drawText("(signature unavailable)", {
        x: MARGIN + 12,
        y: top - boxH / 2,
        size: 10,
        font: fonts.regular,
        color: COLORS.muted
      });
    }
  }
  // Signature line + caption, inside the box's bottom edge.
  cursor.page.drawRectangle({
    x: MARGIN + 12,
    y: top - boxH + 18,
    width: boxW - 24,
    height: 0.75,
    color: COLORS.muted
  });
  const caption = d.typed_name ? `${d.typed_name}  (${d.actor_email})` : d.actor_email;
  cursor.page.drawText(truncateToWidth(caption, fonts.regular, 8, boxW - 24), {
    x: MARGIN + 12,
    y: top - boxH + 6,
    size: 8,
    font: fonts.regular,
    color: COLORS.muted
  });
  cursor.y = top - boxH - 14;
}

/** Site name over its table in a multi-site request. Reserves room for the
 *  heading AND a first row, so a site heading is never stranded at the foot
 *  of a page with its table on the next. */
function drawSiteHeading(doc: PDFDocument, cursor: Cursor, fonts: Fonts, label: string): void {
  addPageIfNeeded(doc, cursor, 18 + 20 + 34);
  cursor.page.drawText(truncateToWidth(label, fonts.bold, 12, CONTENT_WIDTH), {
    x: MARGIN,
    y: cursor.y,
    size: 12,
    font: fonts.bold,
    color: COLORS.navy
  });
  cursor.y -= 10;
}

function drawLabel(cursor: Cursor, fonts: Fonts, label: string): void {
  cursor.page.drawText(sanitizeForWinAnsi(label.toUpperCase()), {
    x: MARGIN,
    y: cursor.y,
    size: 7,
    font: fonts.bold,
    color: COLORS.muted
  });
  cursor.y -= 12;
}

function drawMuted(doc: PDFDocument, cursor: Cursor, fonts: Fonts, text: string): void {
  const lines = wrapText(text, fonts.regular, 9, CONTENT_WIDTH);
  addPageIfNeeded(doc, cursor, lines.length * 12 + 4);
  for (const line of lines) {
    cursor.page.drawText(line, { x: MARGIN, y: cursor.y, size: 9, font: fonts.regular, color: COLORS.muted });
    cursor.y -= 12;
  }
  cursor.y -= 4;
}

function drawBox(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  text: string,
  palette: { fill: RGB; border: RGB; text: RGB }
): void {
  const pad = 10;
  const size = 11;
  const lh = size * 1.35;
  const lines = wrapText(text, fonts.regular, size, CONTENT_WIDTH - pad * 2);
  const h = Math.max(1, lines.length) * lh + pad * 2 - 4;
  addPageIfNeeded(doc, cursor, h + 8);
  const top = cursor.y + 4;
  cursor.page.drawRectangle({
    x: MARGIN,
    y: top - h,
    width: CONTENT_WIDTH,
    height: h,
    color: palette.fill,
    borderColor: palette.border,
    borderWidth: 1
  });
  let y = top - pad - size + 2;
  for (const line of lines) {
    cursor.page.drawText(line, { x: MARGIN + pad, y, size, font: fonts.regular, color: palette.text });
    y -= lh;
  }
  cursor.y = top - h - 10;
}
