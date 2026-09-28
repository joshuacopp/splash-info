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
  /**
   * Set on the BINDER only, to print the instruction on the page being printed.
   *
   * A button on a web page cannot set anybody's printer, and by the time the
   * print dialog is open that page is gone. Somebody pressing "double-sided"
   * and then printing 300 pages one-sided has wasted a ream and produced a
   * binder full of blanks. The instruction therefore travels WITH the file, and
   * is read at the moment the decision is actually made.
   */
  binderMode?: "duplex" | "simplex";
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

  // THE LIST IS THE HAZARDOUS ONES. 1910.1200(e)(1)(i) asks for the hazardous
  // chemicals known to be present; a product whose sheet classifies it as not
  // hazardous is not required, and padding the list with it does not make the
  // list truer.
  const listed = input.items.filter((i) => !i.catalog?.not_hazardous);
  const excluded = input.items.filter((i) => i.catalog?.not_hazardous);

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
      sanitizeForWinAnsi(
      `${listed.length} hazardous chemicals on site` +
        (excluded.length > 0
          ? `  |  ${excluded.length} non-hazardous (listed separately, sheets in the binder)`
          : "") +
        `  |  ${reviewed}`
    ),
      fonts.regular,
      9,
      CONTENT_WIDTH
    ),
    { x: MARGIN, y: cursor.y, size: 9, font: fonts.regular, color: COLORS.muted }
  );
  cursor.y -= 20;

  // Loud, because the cost of missing it is a ream of paper and a binder that
  // cannot be filed.
  if (input.binderMode) {
    const duplex = input.binderMode === "duplex";
    cursor.page.drawText(
      sanitizeForWinAnsi(
        duplex
          ? "PRINT THIS FILE DOUBLE-SIDED (2-sided / duplex)."
          : "PRINT THIS FILE SINGLE-SIDED (1-sided)."
      ),
      { x: MARGIN, y: cursor.y, size: 10, font: fonts.bold, color: COLORS.navy }
    );
    cursor.y -= 13;
    cursor.page.drawText(
      sanitizeForWinAnsi(
        duplex
          ? "Blank backs are deliberate: they keep every chemical starting on a front page. Printing"
          : "This copy has no padding. Printing it double-sided puts each chemical on the back of the"
      ),
      { x: MARGIN, y: cursor.y, size: 8.5, font: fonts.regular, color: COLORS.muted }
    );
    cursor.y -= 11;
    cursor.page.drawText(
      sanitizeForWinAnsi(
        duplex
          ? "this copy single-sided wastes one sheet per blank -- use the single-sided version instead."
          : "one before it, so it cannot be filed behind its divider -- use the double-sided version."
      ),
      { x: MARGIN, y: cursor.y, size: 8.5, font: fonts.regular, color: COLORS.muted }
    );
    cursor.y -= 16;
  }

  if (listed.length === 0) {
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
      // Widths measured against real data rather than guessed. At 9pt Helvetica
      // the longest identifier in use needs 306pt and the longest manufacturer
      // 126pt, against a 504pt content width that also has to carry a tab
      // number and a work area -- so no split fits everything on one line, and
      // the two columns carrying real text WRAP. Truncating an identifier is
      // not a cosmetic loss: the column's whole job is to match the sheet.
      //
      // Tab is sized for "50", not for its own header. Work area is last and
      // narrowest because it is the only optional one -- and is empty at every
      // site today, so giving it room the identifiers need would be spending
      // space on nothing.
      // Every width below is measured at 9pt, not guessed. The work-area column
      // was 92pt: its HEADER needs 86pt and "Backroom/Backroom" needs 83pt
      // against 80pt of usable space, so both were being clipped. The 12pt it
      // needed comes out of the product column, which wraps and can afford it.
      [
        { header: "Tab", width: 36 },
        { header: "Product identifier (as shown on the SDS)", width: 226, wrap: true },
        { header: "Manufacturer", width: 140, wrap: true },
        { header: "Where used / stored", width: CONTENT_WIDTH - 402, wrap: true }
      ],
      listed.map((i) => [
        oneLine(i.binder_tab),
        oneLine(i.catalog?.product_identifier),
        oneLine(i.catalog?.manufacturer),
        oneLine(i.work_area)
      ]),
      { fontSize: 9, rowHeight: 17 }
    );
  }

  // The excluded ones are PRINTED, not merely absent -- and their sheets are in
  // the binder, after the numbered tabs.
  //
  // Two reasons, and the second one outranks the first. A chemical on the shelf
  // and missing from the index reads as an oversight, so the next person adds it
  // back. And an employee who has just splashed something in their eyes must not
  // have to conclude it is harmless because it is not in the book -- an absence
  // is not an answer, least of all then.
  if (excluded.length > 0) {
    cursor.y -= 14;
    addPageIfNeeded(doc, cursor, 60);
    cursor.page.drawText(
      sanitizeForWinAnsi("Non-hazardous chemicals"),
      { x: MARGIN, y: cursor.y, size: 9, font: fonts.bold, color: COLORS.navy }
    );
    cursor.y -= 11;
    cursor.page.drawText(
      sanitizeForWinAnsi(
        "Their safety data sheets are in this binder, behind the tabs below. They are"
      ),
      { x: MARGIN, y: cursor.y, size: 8.5, font: fonts.regular, color: COLORS.muted }
    );
    cursor.y -= 11;
    cursor.page.drawText(
      sanitizeForWinAnsi(
        "listed separately because the sheet records no hazard classification, so they are"
      ),
      { x: MARGIN, y: cursor.y, size: 8.5, font: fonts.regular, color: COLORS.muted }
    );
    cursor.y -= 11;
    cursor.page.drawText(
      sanitizeForWinAnsi("not required on the hazardous chemical list above."),
      { x: MARGIN, y: cursor.y, size: 8.5, font: fonts.regular, color: COLORS.muted }
    );
    cursor.y -= 16;
    drawTable(
      doc,
      cursor,
      fonts,
      [
        { header: "Tab", width: 36 },
        { header: "Product identifier (as shown on the SDS)", width: 226, wrap: true },
        { header: "Manufacturer", width: 140, wrap: true },
        { header: "Where used / stored", width: CONTENT_WIDTH - 402, wrap: true }
      ],
      excluded.map((i) => [
        oneLine(i.binder_tab),
        oneLine(i.catalog?.product_identifier),
        oneLine(i.catalog?.manufacturer),
        oneLine(i.work_area)
      ]),
      { fontSize: 9, rowHeight: 17 }
    );
    cursor.y -= 4;
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
