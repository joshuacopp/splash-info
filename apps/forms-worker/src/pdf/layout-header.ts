// Brief 129 — top band of page 1 of the completed-form PDF.
//
// Splash navy stripe across the full page width, with the white-script
// brand logo on the left (loaded from R2 — same `assets/splash-logo-
// white.png` Brief 32 uses) and the form title + submission id +
// submitted-at on the right.

import type { PDFDocument, PDFImage } from "pdf-lib";

import {
  COLORS,
  MARGIN,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  type Cursor,
  type Fonts,
  type R2Like,
  formatEst,
  sanitizeForWinAnsi,
  shortId
} from "./layout-utils.js";

const HEADER_HEIGHT = 80;
const LOGO_R2_KEY = "assets/splash-logo-white.png";

export interface HeaderInput {
  formTitle: string;
  submissionId: string;
  submittedAt: string;
}

/**
 * Draw the header band on the CURRENT page and return a Cursor positioned
 * just beneath it. Logo failures fall back to a text-only header (matches
 * the Brief 32 fallback posture).
 */
export async function drawHeader(
  doc: PDFDocument,
  bucket: R2Like,
  fonts: Fonts,
  page: import("pdf-lib").PDFPage,
  input: HeaderInput
): Promise<Cursor> {
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - HEADER_HEIGHT,
    width: PAGE_WIDTH,
    height: HEADER_HEIGHT,
    color: COLORS.navy
  });

  let logo: PDFImage | null = null;
  try {
    const obj = await bucket.get(LOGO_R2_KEY);
    if (obj) {
      const bytes = new Uint8Array(await obj.arrayBuffer());
      logo = await doc.embedPng(bytes);
    }
  } catch {
    logo = null;
  }
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

  // Brief 133 — form title is operator-authored; sanitize before measuring
  // and drawing so a stray em-dash / curly quote doesn't crash WinAnsi.
  const titleText = sanitizeForWinAnsi(input.formTitle || "Form submission");
  const titleSize = 18;
  const titleW = fonts.bold.widthOfTextAtSize(titleText, titleSize);
  page.drawText(titleText, {
    x: PAGE_WIDTH - MARGIN - titleW,
    y: PAGE_HEIGHT - 30,
    size: titleSize,
    font: fonts.bold,
    color: COLORS.white
  });

  const subText = `${shortId(input.submissionId)}  *  ${formatEst(input.submittedAt)}`;
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

  return {
    page,
    y: PAGE_HEIGHT - HEADER_HEIGHT - 24
  };
}
