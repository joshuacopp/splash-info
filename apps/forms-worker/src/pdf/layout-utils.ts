// Brief 129 — shared PDF layout helpers for the completed-form generator.
//
// pdf-lib's coordinate system has y growing upward from the bottom of the
// page. Callers track a `cursor.y` value (in pt from page bottom) and
// decrement it as they draw rows downward. When the cursor would dip below
// the bottom margin, we push a fresh page.
//
// Standard fonts only (Helvetica + Helvetica-Bold) — no custom font
// embedding overhead. Splash brand palette mirrors the damage-worker
// claim-summary PDF.

import {
  PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  StandardFonts,
  rgb
} from "pdf-lib";

export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;
export const MARGIN = 54;
export const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

export const COLORS = {
  navy: rgb(30 / 255, 58 / 255, 138 / 255),     // #1e3a8a
  blue: rgb(59 / 255, 130 / 255, 246 / 255),     // #3b82f6
  text: rgb(15 / 255, 23 / 255, 42 / 255),       // slate-900
  muted: rgb(100 / 255, 116 / 255, 139 / 255),   // slate-500
  subtle: rgb(226 / 255, 232 / 255, 240 / 255),  // slate-200
  white: rgb(1, 1, 1),
  amberFill: rgb(254 / 255, 243 / 255, 199 / 255),   // amber-100
  amberBorder: rgb(217 / 255, 119 / 255, 6 / 255),   // amber-600
  successFill: rgb(220 / 255, 252 / 255, 231 / 255), // green-100
  dangerFill: rgb(254 / 255, 226 / 255, 226 / 255)   // red-100
} as const;

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

export interface Cursor {
  /** Current PDF page being drawn on. Pushed forward by `addPageIfNeeded`. */
  page: PDFPage;
  /** y coordinate (in pt from page bottom) where the NEXT line of content
   *  starts. Decreases as content flows downward. */
  y: number;
}

export async function loadFonts(doc: PDFDocument): Promise<Fonts> {
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { regular, bold };
}

/**
 * If `neededHeight` won't fit before the bottom margin, push a fresh page
 * and reset the cursor. Returns the cursor (mutated in place + returned for
 * chaining convenience).
 */
export function addPageIfNeeded(
  doc: PDFDocument,
  cursor: Cursor,
  neededHeight: number
): Cursor {
  if (cursor.y - neededHeight < MARGIN) {
    cursor.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    cursor.y = PAGE_HEIGHT - MARGIN;
  }
  return cursor;
}

/**
 * Wrap text to a max width at the given font/size, preserving hard newlines.
 * Returns an array of lines ready to draw one-per-row.
 */
export function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] {
  if (!text) return [];
  const paragraphs = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Approximate height a wrapped text block will consume. Used by
 * `addPageIfNeeded` callers to pre-check space.
 */
export function measureTextHeight(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  lineHeightMultiplier = 1.35
): number {
  const lines = wrapText(text, font, size, maxWidth);
  return Math.max(1, lines.length) * size * lineHeightMultiplier;
}

/**
 * Draw a small uppercase label + a wrapped value below it. Both elements
 * span the full content width unless `maxWidth` is overridden. Cursor
 * advances past both.
 */
export function drawLabelValue(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  label: string,
  value: string,
  opts: { maxWidth?: number; valueSize?: number } = {}
): void {
  const maxWidth = opts.maxWidth ?? CONTENT_WIDTH;
  const valueSize = opts.valueSize ?? 11;
  const lineHeight = valueSize * 1.35;
  const valueLines = wrapText(value || "—", fonts.regular, valueSize, maxWidth);
  const needed = 12 + valueLines.length * lineHeight + 6;
  addPageIfNeeded(doc, cursor, needed);

  cursor.page.drawText(label.toUpperCase(), {
    x: MARGIN,
    y: cursor.y,
    size: 7,
    font: fonts.bold,
    color: COLORS.muted
  });
  cursor.y -= 12;

  for (const line of valueLines) {
    cursor.page.drawText(line, {
      x: MARGIN,
      y: cursor.y,
      size: valueSize,
      font: fonts.regular,
      color: COLORS.text
    });
    cursor.y -= lineHeight;
  }
  cursor.y -= 6;
}

/**
 * Draw a section heading: small splash-blue bar + bold navy label + thin
 * subtle rule beneath. Cursor advances past all three.
 */
export function drawSectionHeading(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  label: string
): void {
  addPageIfNeeded(doc, cursor, 40);
  cursor.page.drawRectangle({
    x: MARGIN,
    y: cursor.y - 2,
    width: 24,
    height: 3,
    color: COLORS.blue
  });
  cursor.y -= 18;
  cursor.page.drawText(label, {
    x: MARGIN,
    y: cursor.y,
    size: 13,
    font: fonts.bold,
    color: COLORS.navy
  });
  cursor.y -= 8;
  cursor.page.drawRectangle({
    x: MARGIN,
    y: cursor.y,
    width: CONTENT_WIDTH,
    height: 0.75,
    color: COLORS.subtle
  });
  cursor.y -= 14;
}

/**
 * Bold inline heading used for in-form `heading` fields. Sizes differ by
 * level; the operator-set `text` is the body.
 */
export function drawFieldHeading(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  text: string,
  level: "h1" | "h2" | "h3" | "h4"
): void {
  const size =
    level === "h1" ? 16 : level === "h2" ? 14 : level === "h3" ? 12 : 11;
  const lineHeight = size * 1.4;
  const lines = wrapText(text, fonts.bold, size, CONTENT_WIDTH);
  addPageIfNeeded(doc, cursor, lineHeight * lines.length + 10);
  for (const line of lines) {
    cursor.page.drawText(line, {
      x: MARGIN,
      y: cursor.y,
      size,
      font: fonts.bold,
      color: COLORS.navy
    });
    cursor.y -= lineHeight;
  }
  cursor.y -= 6;
}

export function drawSpacer(cursor: Cursor, h: number): void {
  cursor.y -= h;
}

export function drawDivider(
  doc: PDFDocument,
  cursor: Cursor,
  opts: { dashed?: boolean } = {}
): void {
  addPageIfNeeded(doc, cursor, 10);
  cursor.page.drawRectangle({
    x: MARGIN,
    y: cursor.y,
    width: CONTENT_WIDTH,
    height: opts.dashed ? 0.5 : 0.75,
    color: COLORS.subtle
  });
  cursor.y -= 10;
}

/**
 * Truncate `text` so it fits in `maxWidth` at the given font/size, with an
 * ellipsis suffix when truncated.
 */
export function truncateToWidth(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  const ellipsis = "…";
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = text.slice(0, mid) + ellipsis;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

/**
 * Two-column key/value grid. Each pair becomes one cell: tiny uppercase
 * label on top, single-line value beneath. Useful for the metadata block
 * at the top of the PDF.
 */
export function drawKeyValueGrid(
  doc: PDFDocument,
  cursor: Cursor,
  fonts: Fonts,
  pairs: Array<[string, string]>
): void {
  const COLS = 2;
  const COL_GAP = 16;
  const colWidth = (CONTENT_WIDTH - COL_GAP * (COLS - 1)) / COLS;
  const rows = Math.ceil(pairs.length / COLS);
  const ROW_HEIGHT = 30;

  addPageIfNeeded(doc, cursor, rows * ROW_HEIGHT + 4);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLS; c++) {
      const pair = pairs[r * COLS + c];
      if (!pair) continue;
      const [label, value] = pair;
      const x = MARGIN + c * (colWidth + COL_GAP);
      cursor.page.drawText(label.toUpperCase(), {
        x,
        y: cursor.y,
        size: 7,
        font: fonts.bold,
        color: COLORS.muted
      });
      const valueText = value || "—";
      const truncated = truncateToWidth(valueText, fonts.regular, 11, colWidth);
      cursor.page.drawText(truncated, {
        x,
        y: cursor.y - 12,
        size: 11,
        font: fonts.regular,
        color: COLORS.text
      });
    }
    cursor.y -= ROW_HEIGHT;
  }
}

export interface R2Like {
  get(key: string): Promise<{
    arrayBuffer: () => Promise<ArrayBuffer>;
    httpMetadata?: { contentType?: string };
  } | null>;
}

/**
 * Fetch an R2 object by key and embed it as a PDFImage. Detects PNG vs
 * JPEG by content-type first, falling back to magic-byte sniff. Throws if
 * the MIME isn't a supported image format; callers can catch + skip the
 * field gracefully.
 */
export async function fetchAndEmbedR2Image(
  doc: PDFDocument,
  bucket: R2Like,
  r2Key: string
): Promise<PDFImage> {
  const obj = await bucket.get(r2Key);
  if (!obj) throw new Error(`R2 object not found: ${r2Key}`);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const ct = (obj.httpMetadata?.contentType ?? "").toLowerCase();
  if (ct.includes("png") || isPngMagic(bytes)) {
    return doc.embedPng(bytes);
  }
  if (
    ct.includes("jpeg") ||
    ct.includes("jpg") ||
    isJpegMagic(bytes)
  ) {
    return doc.embedJpg(bytes);
  }
  throw new Error(`Unsupported image MIME at ${r2Key}: ${ct || "unknown"}`);
}

function isPngMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function isJpegMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Embed an image scaled to fit within a max width (preserving aspect
 * ratio). Pushes a page break if needed. Returns the rendered height so
 * callers can chain content beneath.
 */
export function drawImageScaled(
  doc: PDFDocument,
  cursor: Cursor,
  image: PDFImage,
  opts: { maxWidth: number; maxHeight?: number }
): number {
  const maxW = opts.maxWidth;
  const maxH = opts.maxHeight ?? maxW;
  const ratio = image.width / image.height;
  let w = maxW;
  let h = w / ratio;
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }
  addPageIfNeeded(doc, cursor, h + 6);
  cursor.page.drawImage(image, {
    x: MARGIN,
    y: cursor.y - h,
    width: w,
    height: h
  });
  cursor.y -= h + 6;
  return h;
}

/**
 * Format a UTC ISO 8601 timestamp into an EST string matching the
 * apps/web `formatEst()` helper convention (Brief 113). Used throughout
 * the generator for "submitted at" / outcome / history timestamps.
 */
export function formatEst(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const date = d.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "long",
      day: "numeric"
    });
    const time = d.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit"
    });
    return `${date}, ${time} EST`;
  } catch {
    return iso;
  }
}

/** Short uuid prefix used in metadata grid + filenames. */
export function shortId(id: string): string {
  return id ? id.slice(0, 8) : "—";
}

/** Filename-safe slug for use in the Content-Disposition filename. */
export function filenameSafe(s: string): string {
  return (s || "form")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "form";
}
