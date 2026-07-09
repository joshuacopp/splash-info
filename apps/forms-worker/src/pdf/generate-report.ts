// Response report PDF — aggregate percentages for each choice question
// (dropdown + multi) across a filtered set of submissions. Reuses the
// completed-form PDF's brand palette / fonts / footer. Header carries the
// Splash logo (loaded from R2 — same `assets/splash-logo-white.png` the
// per-submission PDF uses), so the logo requirement is satisfied here too.
//
// The caller (admin/submissions.ts) does all the aggregation and hands us a
// ready-to-draw ReportContext; this module is layout-only.

import { PDFDocument, type PDFImage } from "pdf-lib";

import { drawFooters } from "./layout-footer.js";
import {
  COLORS,
  CONTENT_WIDTH,
  MARGIN,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  addPageIfNeeded,
  loadFonts,
  loadHeaderLogo,
  sanitizeForWinAnsi,
  truncateToWidth,
  type Cursor,
  type Fonts,
  type R2Like
} from "./layout-utils.js";

const HEADER_HEIGHT = 80;

export interface ReportRow {
  label: string;
  count: number;
  pct: number;
}

export interface ReportQuestion {
  label: string;
  type: "dropdown" | "multi";
  /** Small caption beneath the question heading describing the denominator
   *  (e.g. "128 submissions" or "312 selections across 128 submissions"). */
  baseCaption: string;
  rows: ReportRow[];
}

export interface ReportContext {
  formTitle: string;
  fromDate: string;
  toDate: string;
  totalSubmissions: number;
  /** When a field filter was applied, a one-line description of it. */
  filterCaption: string | null;
  questions: ReportQuestion[];
}

export async function generateReportPdf(
  bucket: R2Like,
  ctx: ReportContext
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts = await loadFonts(doc);

  const page1 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const cursor = await drawReportHeader(doc, bucket, fonts, page1, ctx);

  drawSummary(doc, cursor, fonts, ctx);

  if (ctx.questions.length === 0) {
    addPageIfNeeded(doc, cursor, 24);
    cursor.page.drawText(
      "No dropdown or multiple-choice questions to report on.",
      { x: MARGIN, y: cursor.y, size: 11, font: fonts.regular, color: COLORS.muted }
    );
    cursor.y -= 18;
  } else {
    for (const q of ctx.questions) {
      drawQuestion(doc, cursor, fonts, q);
    }
  }

  drawFooters(doc, fonts);
  return doc.save();
}

// -----------------------------------------------------------------------------
// Header — navy band + Splash logo + report title/subtext
// -----------------------------------------------------------------------------

async function drawReportHeader(
  doc: PDFDocument,
  bucket: R2Like,
  fonts: Fonts,
  page: import("pdf-lib").PDFPage,
  ctx: ReportContext
): Promise<Cursor> {
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - HEADER_HEIGHT,
    width: PAGE_WIDTH,
    height: HEADER_HEIGHT,
    color: COLORS.navy
  });

  const logo: PDFImage | null = await loadHeaderLogo(doc, bucket);
  if (logo) {
    const logoH = 36;
    const logoW = logoH * (logo.width / logo.height);
    page.drawImage(logo, {
      x: MARGIN,
      y: PAGE_HEIGHT - HEADER_HEIGHT / 2 - logoH / 2,
      width: logoW,
      height: logoH
    });
  }

  const titleText = "Response Report";
  const titleSize = 18;
  const titleW = fonts.bold.widthOfTextAtSize(titleText, titleSize);
  page.drawText(titleText, {
    x: PAGE_WIDTH - MARGIN - titleW,
    y: PAGE_HEIGHT - 30,
    size: titleSize,
    font: fonts.bold,
    color: COLORS.white
  });

  const subText = sanitizeForWinAnsi(ctx.formTitle || "Form");
  const subSize = 9;
  const subW = fonts.regular.widthOfTextAtSize(subText, subSize);
  page.drawText(subText, {
    x: PAGE_WIDTH - MARGIN - subW,
    y: PAGE_HEIGHT - 52,
    size: subSize,
    font: fonts.regular,
    color: COLORS.white,
    opacity: 0.75
  });

  return { page, y: PAGE_HEIGHT - HEADER_HEIGHT - 28 };
}

// -----------------------------------------------------------------------------
// Summary block — date range, submission count, active filter
// -----------------------------------------------------------------------------

function drawSummary(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  ctx: ReportContext
): void {
  const lines: string[] = [
    `Date range: ${ctx.fromDate} to ${ctx.toDate}`,
    `Submissions in report: ${ctx.totalSubmissions}`
  ];
  if (ctx.filterCaption) lines.push(ctx.filterCaption);

  for (const line of lines) {
    addPageIfNeeded(doc, cursor, 16);
    cursor.page.drawText(sanitizeForWinAnsi(line), {
      x: MARGIN,
      y: cursor.y,
      size: 10,
      font: fonts.regular,
      color: COLORS.text
    });
    cursor.y -= 14;
  }
  cursor.y -= 8;
  cursor.page.drawRectangle({
    x: MARGIN,
    y: cursor.y,
    width: CONTENT_WIDTH,
    height: 0.75,
    color: COLORS.subtle
  });
  cursor.y -= 18;
}

// -----------------------------------------------------------------------------
// Question block — heading + caption + one bar row per option
// -----------------------------------------------------------------------------

const LABEL_W = 170;
const BAR_X = MARGIN + LABEL_W + 8;
const BAR_MAX_W = 190;
const STAT_X = BAR_X + BAR_MAX_W + 8;
const ROW_H = 18;

function drawQuestion(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  q: ReportQuestion
): void {
  // Keep the heading + caption + at least one row together on a page.
  addPageIfNeeded(doc, cursor, 40 + ROW_H);

  cursor.page.drawRectangle({
    x: MARGIN,
    y: cursor.y - 2,
    width: 24,
    height: 3,
    color: COLORS.blue
  });
  cursor.y -= 16;
  cursor.page.drawText(sanitizeForWinAnsi(q.label), {
    x: MARGIN,
    y: cursor.y,
    size: 13,
    font: fonts.bold,
    color: COLORS.navy
  });
  cursor.y -= 13;
  cursor.page.drawText(sanitizeForWinAnsi(q.baseCaption), {
    x: MARGIN,
    y: cursor.y,
    size: 8,
    font: fonts.regular,
    color: COLORS.muted
  });
  cursor.y -= 14;

  for (const row of q.rows) {
    drawBarRow(doc, cursor, fonts, row);
  }
  cursor.y -= 12;
}

function drawBarRow(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  row: ReportRow
): void {
  addPageIfNeeded(doc, cursor, ROW_H);
  const baselineY = cursor.y;

  const label = truncateToWidth(row.label, fonts.regular, 10, LABEL_W);
  cursor.page.drawText(label, {
    x: MARGIN,
    y: baselineY,
    size: 10,
    font: fonts.regular,
    color: COLORS.text
  });

  // Bar track + fill.
  const barH = 9;
  const barY = baselineY - 1;
  cursor.page.drawRectangle({
    x: BAR_X,
    y: barY,
    width: BAR_MAX_W,
    height: barH,
    color: COLORS.subtle
  });
  const fillW = Math.max(0, Math.min(1, row.pct / 100)) * BAR_MAX_W;
  if (fillW > 0) {
    cursor.page.drawRectangle({
      x: BAR_X,
      y: barY,
      width: fillW,
      height: barH,
      color: COLORS.blue
    });
  }

  const stat = `${row.pct.toFixed(1)}%  (${row.count})`;
  cursor.page.drawText(stat, {
    x: STAT_X,
    y: baselineY,
    size: 9,
    font: fonts.bold,
    color: COLORS.navy
  });

  cursor.y -= ROW_H;
}
