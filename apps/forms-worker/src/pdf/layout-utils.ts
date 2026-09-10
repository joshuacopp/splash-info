// Brief 129 — PDF layout helpers for the completed-form generator.
//
// The environment-agnostic majority of this file now lives in
// @splash/pdf-report, so the inventory SPA can generate PDFs in the browser
// from the same code. This module re-exports all of it, which is why the seven
// callers in this directory import from here unchanged.
//
// What stayed: the R2-coupled image loaders below. They need a bucket binding
// or a `fetch` of a brand asset, neither of which exists in a browser, and
// putting them in the shared package would break its browser callers at bundle
// time. New helpers belong in @splash/pdf-report unless they touch R2.

export * from "@splash/pdf-report";

import { PDFDocument, type PDFImage } from "pdf-lib";
import { ASSETS } from "@splash/storage-r2";

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

/** R2 key the branded white-script logo was uploaded under (Brief 32). */
const LOGO_R2_KEY = "assets/splash-logo-white.png";

/**
 * Load the white-script Splash logo for a PDF header and embed it as a
 * PDFImage. Tries the FORMS_FILES R2 object first, then falls back to the
 * public brand asset URL (`ASSETS.logoWhite`) — mirrors the damage-worker
 * `loadSummaryLogoBytes` fallback posture. The R2 key isn't present in the
 * forms bucket, so in practice the HTTPS fallback is what actually renders.
 * Returns `null` on total failure so callers degrade to a text-only header.
 */
export async function loadHeaderLogo(
  doc: PDFDocument,
  bucket: R2Like
): Promise<PDFImage | null> {
  // 1) R2 object (present in some buckets; absent in FORMS_FILES).
  try {
    const obj = await bucket.get(LOGO_R2_KEY);
    if (obj) {
      const bytes = new Uint8Array(await obj.arrayBuffer());
      return await doc.embedPng(bytes);
    }
  } catch {
    // fall through to HTTPS fallback
  }
  // 2) Public brand asset over HTTPS.
  try {
    const res = await fetch(ASSETS.logoWhite);
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      return await doc.embedPng(bytes);
    }
  } catch {
    // fall through to null
  }
  return null;
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
