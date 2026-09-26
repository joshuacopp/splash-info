// The printed SDS binder table of contents.
//
// Built on the same @splash/pdf-report helpers as the completed-form PDFs, so
// it carries the Splash header band and footer and looks like the rest of the
// documents this system produces.
//
// WHAT THIS PAGE IS FOR. It goes in the front of the physical binder so anyone
// -- an employee looking for a sheet, an inspector asking what is on site --
// can find a chemical by tab number. OSHA's HazCom standard (1910.1200(e)(1)(i))
// wants a list of the hazardous chemicals present, identified the same way they
// are identified on their safety data sheets. So `product_identifier` is
// printed VERBATIM: not title-cased, not tidied, not shortened. If it disagrees
// with the sheet in the binder, that disagreement is the finding, and hiding it
// behind nicer typography would defeat the point of printing it at all.

import { PDFDocument } from "pdf-lib";

import {
  CONTENT_WIDTH,
  COLORS,
  MARGIN,
  addPageIfNeeded,
  drawFooters,
  drawTable,
  formatEst,
  loadFonts,
  sanitizeForWinAnsi,
  truncateToWidth,
  type Cursor
} from "../pdf/layout-utils.js";
import { drawHeader } from "../pdf/layout-header.js";
import type { R2Like } from "../pdf/layout-utils.js";
import type { SdsItemRow } from "./handlers.js";

export interface SdsPdfInput {
  siteName: string;
  locationCode: string;
  items: SdsItemRow[];
  lastReviewedAt: string | null;
  lastReviewedBy: string | null;
  bucket: R2Like;
}

/** A cell is one line; a stray newline in a manufacturer or work area would
 *  throw on draw, because WinAnsi cannot encode one. */
function oneLine(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

export async function renderSdsPdf(input: SdsPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts = await loadFonts(doc);
  const page = doc.addPage([612, 792]);

  const cursor: Cursor = await drawHeader(doc, input.bucket, fonts, page, {
    formTitle: "Safety Data Sheet Index",
    submissionId: input.locationCode,
    subtitle: input.siteName,
    submittedAt: new Date().toISOString()
  });

  // Site and review line. The review date is on the printed page on purpose:
  // a binder index with no date cannot be told from one three years stale, and
  // "is the binder current" is exactly what an inspection asks.
  addPageIfNeeded(doc, cursor, 40);

  const reviewed = input.lastReviewedAt
    ? `Last reviewed ${formatEst(input.lastReviewedAt)}` +
      (input.lastReviewedBy ? ` by ${input.lastReviewedBy}` : "")
    : "Not yet marked reviewed";
  cursor.page.drawText(
    truncateToWidth(
      sanitizeForWinAnsi(`${input.items.length} chemicals on site  |  ${reviewed}`),
      fonts.regular,
      9,
      CONTENT_WIDTH
    ),
    { x: MARGIN, y: cursor.y, size: 9, font: fonts.regular, color: COLORS.muted }
  );
  cursor.y -= 20;

  if (input.items.length === 0) {
    cursor.page.drawText("No chemicals recorded for this site yet.", {
      x: MARGIN,
      y: cursor.y,
      size: 11,
      font: fonts.regular,
      color: COLORS.muted
    });
    cursor.y -= 16;
  } else {
    drawTable(
      doc,
      cursor,
      fonts,
      [
        { header: "Tab", width: 46 },
        { header: "Product identifier (as shown on the SDS)", width: 214 },
        { header: "Manufacturer", width: 130 },
        { header: "Where used / stored", width: CONTENT_WIDTH - 390 }
      ],
      input.items.map((i) => [
        oneLine(i.binder_tab),
        oneLine(i.catalog?.product_identifier),
        oneLine(i.catalog?.manufacturer),
        oneLine(i.work_area)
      ]),
      { fontSize: 9, rowHeight: 17 }
    );
  }

  // Says what the document is and, as importantly, what it is not. Somebody
  // will eventually hold this page up as evidence of compliance; it should be
  // honest on its face about being an index rather than the programme.
  cursor.y -= 10;
  addPageIfNeeded(doc, cursor, 30);
  for (const line of [
    "This index lists the hazardous chemicals known to be present at this site and is kept with the",
    "SDS binder. A safety data sheet for every chemical listed must be in the binder and available to",
    "employees during each work shift. Add or remove entries as chemicals change on site."
  ]) {
    cursor.page.drawText(sanitizeForWinAnsi(line), {
      x: MARGIN,
      y: cursor.y,
      size: 8,
      font: fonts.regular,
      color: COLORS.muted
    });
    cursor.y -= 11;
  }

  drawFooters(doc, fonts);
  return doc.save();
}
