// Brief 129 — footer on every page of the completed-form PDF.
//
// Splash branding line on the left, "Page N of M" on the right. Drawn
// after all body content is laid out so we know the final page count.

import type { PDFDocument } from "pdf-lib";

import {
  COLORS,
  MARGIN,
  PAGE_WIDTH,
  type Fonts
} from "./layout-utils.js";

const FOOTER_Y = 30;
const BRAND_LINE = "Splash Car Wash — splashcarwashes.info";

export function drawFooters(doc: PDFDocument, fonts: Fonts): void {
  const pages = doc.getPages();
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    const page = pages[i];
    if (!page) continue;
    page.drawText(BRAND_LINE, {
      x: MARGIN,
      y: FOOTER_Y,
      size: 9,
      font: fonts.regular,
      color: COLORS.muted
    });
    const pageText = `Page ${i + 1} of ${total}`;
    const pageW = fonts.bold.widthOfTextAtSize(pageText, 9);
    page.drawText(pageText, {
      x: PAGE_WIDTH - MARGIN - pageW,
      y: FOOTER_Y,
      size: 9,
      font: fonts.bold,
      color: COLORS.navy
    });
  }
}
