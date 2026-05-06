// Customer-facing claim summary PDF — auto-generated on every successful
// submission of the public claim form (Brief 32). The PDF is stored in R2
// at `claims/<claimId>/summary.pdf` and surfaced to the customer via two
// channels: (a) a "Download a copy" link in the post-submit outcome card,
// (b) a CUSTOMER_CLAIM_WEBHOOK_URL POST that hands PA the URL + base64.
//
// pdf-lib used programmatically (no AcroForm template) so no operator
// pre-work is needed beyond uploading the brand logo to R2 (see ASSETS).
//
// Layout: US Letter (612x792 pt) with 54 pt margins. Header band is a
// splash-navy stripe with the logo on the left and the title + claim ID +
// timestamp on the right. Body sections are key/value grids + wrapped
// text blocks for the free-form fields. Photos render as up to 4 inline
// thumbnails. Footer repeats the claim ID and a contact note.

import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, StandardFonts, rgb } from "pdf-lib";

export interface ClaimSummaryPdfInput {
  claimId: string;
  submittedAt: string; // ISO-8601 UTC
  locationPretty: string;
  locationCode: string;
  customer: {
    name: string;
    email: string;
    phone: string | null;
    vehicleMake: string;
    vehicleModel: string;
    vehicleYear: string;
    vehicleColor: string | null;
    licensePlate: string | null;
    licenseState: string | null;
    whatHappened: string;
  };
  /** Up to 4 thumbnails embedded inline. JPEG/PNG bytes — sniffed by header. */
  photos: Array<{ filename: string; bytes: Uint8Array }>;
  assessment: {
    staffName: string | null;
    equipmentRelated: "yes" | "no" | null;
    determination: string;
    whatCustomerWasTold: string;
  };
  /** PNG bytes for the brand logo embedded in the header band. */
  logoPng: Uint8Array;
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const HEADER_HEIGHT = 70;

// Splash brand palette (mirrors the form's gradient stops).
const NAVY = rgb(30 / 255, 58 / 255, 138 / 255); // #1e3a8a
const BLUE = rgb(59 / 255, 130 / 255, 246 / 255); // #3b82f6
const TEXT = rgb(15 / 255, 23 / 255, 42 / 255); // slate-900
const MUTED = rgb(100 / 255, 116 / 255, 139 / 255); // slate-500
const SUBTLE = rgb(226 / 255, 232 / 255, 240 / 255); // slate-200
const WHITE = rgb(1, 1, 1);
const HEADER_SUBTITLE = rgb(1, 1, 1); // 70% opacity not directly supported; using white at smaller weight

function dash(v: string | null | undefined): string {
  const s = (v ?? "").toString().trim();
  return s ? s : "—";
}

function formatTimestamp(iso: string): string {
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
    return `${date} ${time}`;
  } catch {
    return iso;
  }
}

function buildVehicle(c: ClaimSummaryPdfInput["customer"]): string {
  const parts = [c.vehicleYear, c.vehicleMake, c.vehicleModel].filter((p) => (p ?? "").toString().trim());
  const base = parts.join(" ");
  const color = (c.vehicleColor ?? "").trim();
  if (!base && !color) return "";
  if (color && base) return `${base} — ${color}`;
  return base || color;
}

function buildPlate(c: ClaimSummaryPdfInput["customer"]): string {
  const plate = (c.licensePlate ?? "").trim();
  const state = (c.licenseState ?? "").trim();
  if (plate && state) return `${plate} (${state})`;
  return plate || "";
}

// Wrap arbitrary text into lines that fit `maxWidth` at the given font/size.
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [];
  // Normalize internal whitespace but preserve hard newlines.
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

// Sniff JPEG/PNG by the first two bytes; fall back to attempting jpg then png.
async function embedImageBytes(
  doc: PDFDocument,
  bytes: Uint8Array
): Promise<PDFImage | null> {
  try {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      return await doc.embedJpg(bytes);
    }
    if (bytes.length >= 2 && bytes[0] === 0x89 && bytes[1] === 0x50) {
      return await doc.embedPng(bytes);
    }
    try {
      return await doc.embedJpg(bytes);
    } catch {
      return await doc.embedPng(bytes);
    }
  } catch {
    return null;
  }
}

// Page-state helper. y is tracked from the bottom of the page (pdf-lib's
// native coordinate). Sections that overflow the bottom margin trigger a
// fresh page; the new page starts directly at the top of the content area
// (no header band repeats — this is a single-claim summary, not a report).
class Layout {
  doc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
  y: number;

  constructor(doc: PDFDocument, page: PDFPage, font: PDFFont, fontBold: PDFFont, startY: number) {
    this.doc = doc;
    this.page = page;
    this.font = font;
    this.fontBold = fontBold;
    this.y = startY;
  }

  ensureSpace(neededHeight: number): void {
    if (this.y - neededHeight < MARGIN) {
      this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      this.y = PAGE_HEIGHT - MARGIN;
    }
  }

  drawSectionHeading(label: string): void {
    this.ensureSpace(36);
    // splash-blue rule + bold label.
    this.page.drawRectangle({
      x: MARGIN,
      y: this.y - 2,
      width: 24,
      height: 3,
      color: BLUE
    });
    this.y -= 18;
    this.page.drawText(label, {
      x: MARGIN,
      y: this.y,
      size: 13,
      font: this.fontBold,
      color: NAVY
    });
    this.y -= 8;
    this.page.drawRectangle({
      x: MARGIN,
      y: this.y,
      width: CONTENT_WIDTH,
      height: 0.75,
      color: SUBTLE
    });
    this.y -= 14;
  }

  drawKeyValueGrid(pairs: Array<[string, string]>): void {
    // Two columns; key + value stacked per cell.
    const COLS = 2;
    const COL_GAP = 16;
    const colWidth = (CONTENT_WIDTH - COL_GAP * (COLS - 1)) / COLS;
    const rows = Math.ceil(pairs.length / COLS);
    const ROW_HEIGHT = 30; // 10 pt label + 14 pt value + 6 pt gap

    this.ensureSpace(rows * ROW_HEIGHT + 4);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < COLS; c++) {
        const pair = pairs[r * COLS + c];
        if (!pair) continue;
        const [label, value] = pair;
        const x = MARGIN + c * (colWidth + COL_GAP);
        const yLabel = this.y;
        const yValue = this.y - 12;
        this.page.drawText(label.toUpperCase(), {
          x,
          y: yLabel,
          size: 7,
          font: this.fontBold,
          color: MUTED
        });
        // Truncate value to a single line for the grid; full-width text uses drawTextBlock.
        const valueText = value || "—";
        const truncated = truncateToWidth(valueText, this.font, 11, colWidth);
        this.page.drawText(truncated, {
          x,
          y: yValue,
          size: 11,
          font: this.font,
          color: TEXT
        });
      }
      this.y -= ROW_HEIGHT;
    }
  }

  drawFullWidthLabel(label: string): void {
    this.ensureSpace(16);
    this.page.drawText(label.toUpperCase(), {
      x: MARGIN,
      y: this.y,
      size: 7,
      font: this.fontBold,
      color: MUTED
    });
    this.y -= 12;
  }

  drawTextBlock(text: string, size = 11): void {
    const lines = wrapText(text || "—", this.font, size, CONTENT_WIDTH);
    const lineH = size * 1.35;
    for (const line of lines) {
      this.ensureSpace(lineH);
      this.page.drawText(line, {
        x: MARGIN,
        y: this.y,
        size,
        font: this.font,
        color: TEXT
      });
      this.y -= lineH;
    }
    this.y -= 6;
  }

  drawSpacer(h: number): void {
    this.y -= h;
  }
}

function truncateToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  // Binary-trim with ellipsis.
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

export async function generateClaimSummaryPdf(input: ClaimSummaryPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  let logo: PDFImage | null = null;
  try {
    logo = await doc.embedPng(input.logoPng);
  } catch {
    // PNG load failed — proceed without logo. Header band renders with
    // text only on the right. Logged at the call site if needed.
    logo = null;
  }

  const embeddedPhotos: Array<{ image: PDFImage; filename: string } | null> = [];
  const photoSlice = input.photos.slice(0, 4);
  for (const p of photoSlice) {
    const img = await embedImageBytes(doc, p.bytes);
    embeddedPhotos.push(img ? { image: img, filename: p.filename } : null);
  }
  const overflowCount = Math.max(0, input.photos.length - 4);

  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  // ============================================================
  // 1. Header band — full-width navy stripe.
  // ============================================================
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - HEADER_HEIGHT,
    width: PAGE_WIDTH,
    height: HEADER_HEIGHT,
    color: NAVY
  });

  if (logo) {
    const logoH = 36;
    const ratio = logo.width / logo.height;
    const logoW = logoH * ratio;
    page.drawImage(logo, {
      x: MARGIN,
      y: PAGE_HEIGHT - HEADER_HEIGHT / 2 - logoH / 2,
      width: logoW,
      height: logoH
    });
  }

  const titleText = "Vehicle Issue Report";
  const titleSize = 18;
  const titleW = fontBold.widthOfTextAtSize(titleText, titleSize);
  page.drawText(titleText, {
    x: PAGE_WIDTH - MARGIN - titleW,
    y: PAGE_HEIGHT - 30,
    size: titleSize,
    font: fontBold,
    color: WHITE
  });

  const subText = `${input.claimId}  •  ${formatTimestamp(input.submittedAt)}`;
  const subSize = 9;
  const subW = font.widthOfTextAtSize(subText, subSize);
  page.drawText(subText, {
    x: PAGE_WIDTH - MARGIN - subW,
    y: PAGE_HEIGHT - 50,
    size: subSize,
    font,
    color: HEADER_SUBTITLE,
    opacity: 0.7
  });

  // ============================================================
  // 2. Location line — small "LOCATION" label + pretty + (#code).
  // ============================================================
  const layout = new Layout(doc, page, font, fontBold, PAGE_HEIGHT - HEADER_HEIGHT - 26);

  layout.page.drawText("LOCATION", {
    x: MARGIN,
    y: layout.y,
    size: 7,
    font: fontBold,
    color: MUTED
  });
  layout.y -= 14;
  const locText = `${input.locationPretty} (#${input.locationCode})`;
  layout.page.drawText(locText, {
    x: MARGIN,
    y: layout.y,
    size: 14,
    font: fontBold,
    color: NAVY
  });
  layout.y -= 22;

  // ============================================================
  // 3. Customer Information section.
  // ============================================================
  layout.drawSectionHeading("Customer Information");
  layout.drawKeyValueGrid([
    ["Name", dash(input.customer.name)],
    ["Email", dash(input.customer.email)],
    ["Phone", dash(input.customer.phone)],
    ["Vehicle", dash(buildVehicle(input.customer))],
    ["License Plate", dash(buildPlate(input.customer))]
  ]);

  layout.drawSpacer(4);

  // ============================================================
  // 4. What Happened — full-width wrapped text block.
  // ============================================================
  layout.drawFullWidthLabel("What Happened");
  layout.drawTextBlock(input.customer.whatHappened || "—", 11);

  // ============================================================
  // 5. Photos (if any) — up to 4 thumbnails in a row.
  // ============================================================
  const validPhotos = embeddedPhotos.filter((p): p is { image: PDFImage; filename: string } => p !== null);
  if (validPhotos.length > 0) {
    layout.drawSpacer(6);
    layout.drawFullWidthLabel("Photos");
    const THUMB_MAX_W = 120;
    const THUMB_H = 90;
    const GAP = 8;
    layout.ensureSpace(THUMB_H + 18);
    let x = MARGIN;
    for (const p of validPhotos) {
      const ratio = p.image.width / p.image.height;
      // Fit within THUMB_MAX_W x THUMB_H box, preserve aspect ratio.
      let w = THUMB_MAX_W;
      let h = w / ratio;
      if (h > THUMB_H) {
        h = THUMB_H;
        w = h * ratio;
      }
      layout.page.drawImage(p.image, {
        x,
        y: layout.y - THUMB_H + (THUMB_H - h) / 2,
        width: w,
        height: h
      });
      x += THUMB_MAX_W + GAP;
    }
    layout.y -= THUMB_H + 6;
    if (overflowCount > 0) {
      layout.page.drawText(`+${overflowCount} more`, {
        x: MARGIN,
        y: layout.y,
        size: 9,
        font,
        color: MUTED
      });
      layout.y -= 14;
    }
  }

  layout.drawSpacer(8);

  // ============================================================
  // 6 + 7. Staff Assessment.
  // ============================================================
  layout.drawSectionHeading("Staff Assessment");
  const equipmentLabel =
    input.assessment.equipmentRelated === "yes"
      ? "Yes"
      : input.assessment.equipmentRelated === "no"
        ? "No"
        : "—";
  layout.drawKeyValueGrid([
    ["Staff Name", dash(input.assessment.staffName)],
    ["Equipment-Related", equipmentLabel]
  ]);

  layout.drawSpacer(2);
  layout.drawFullWidthLabel("Determination");
  layout.drawTextBlock(input.assessment.determination || "—", 11);

  layout.drawFullWidthLabel("What the Customer Was Told");
  layout.drawTextBlock(input.assessment.whatCustomerWasTold || "—", 11);

  // ============================================================
  // 8. Footer — claim ID + contact note. Drawn at the bottom of the
  //    LAST page (which may not be page 1 if the body overflowed).
  // ============================================================
  const footerText1 = `Claim ID: ${input.claimId}`;
  const footerText2 = "This summary was generated automatically. For questions, contact the location directly.";
  // Footer is positioned at MARGIN/2 from the bottom — guaranteed to fit.
  const lastPage = layout.page;
  lastPage.drawText(footerText1, {
    x: MARGIN,
    y: 36,
    size: 9,
    font: fontBold,
    color: NAVY
  });
  lastPage.drawText(footerText2, {
    x: MARGIN,
    y: 22,
    size: 9,
    font,
    color: MUTED
  });

  return doc.save();
}
