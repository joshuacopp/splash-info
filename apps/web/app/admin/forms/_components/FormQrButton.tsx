"use client";

// Share dialog for a published form's public URL (/forms/{slug}): QR code
// (download / print) plus "Send by email" (ShareByEmail).
//
// Shown next to "Copy link" on /admin/forms and in the builder top bar. The
// code is drawn from the module matrix as SVG (on screen and on the print
// sheet) and onto a canvas for the PNG download, so nothing is injected as
// raw HTML and nothing leaves the browser -- no QR web service is called.
//
// The URL is built from window.location.origin, the same as CopyLinkButton,
// so a code made on staging points at staging. Make codes for posting at
// sites from production.

import { useCallback, useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import ShareByEmail from "./ShareByEmail";

interface Props {
  formId: string;
  slug: string;
  title: string;
  audience: string;
  /** "sm" matches the Copy link pill on the list; "md" matches the builder's buttons. */
  size?: "sm" | "md";
}

/** Blank modules around the code. 4 is the QR spec minimum; scanners need it. */
const QUIET_ZONE = 4;
const PNG_SIZE_PX = 1200;

interface Matrix {
  count: number;
  path: string;
  isDark: (row: number, col: number) => boolean;
}

function buildMatrix(text: string): Matrix {
  // Type 0 = smallest version that fits. Level M survives a scuffed or
  // partly-glared print without making the code needlessly dense.
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  let path = "";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) path += `M${c + QUIET_ZONE} ${r + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return { count, path, isDark: (r, c) => qr.isDark(r, c) };
}

function svgMarkup(m: Matrix, px: number): string {
  const dim = m.count + QUIET_ZONE * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `width="${px}" height="${px}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#fff"/>` +
    `<path d="${m.path}" fill="#000"/></svg>`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default function FormQrButton({ formId, slug, title, audience, size = "sm" }: Props) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (open) setUrl(`${window.location.origin}/forms/${slug}`);
  }, [open, slug]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const matrix = useMemo(() => (url ? buildMatrix(url) : null), [url]);
  const displayTitle = title.trim() || slug;

  const downloadPng = useCallback(() => {
    if (!matrix) return;
    const dim = matrix.count + QUIET_ZONE * 2;
    const cell = Math.floor(PNG_SIZE_PX / dim);
    const side = cell * dim;
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, side, side);
    ctx.fillStyle = "#000";
    for (let r = 0; r < matrix.count; r++) {
      for (let c = 0; c < matrix.count; c++) {
        if (matrix.isDark(r, c)) {
          ctx.fillRect((c + QUIET_ZONE) * cell, (r + QUIET_ZONE) * cell, cell, cell);
        }
      }
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `form-${slug}-qr.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    }, "image/png");
  }, [matrix, slug]);

  const printSheet = useCallback(() => {
    if (!matrix) return;
    const w = window.open("", "_blank", "width=800,height=1000");
    if (!w) {
      window.alert("Your browser blocked the print window. Allow pop-ups for this site, or use Download PNG.");
      return;
    }
    const t = escapeHtml(displayTitle);
    w.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>${t} - QR code</title>` +
        `<style>body{font-family:Arial,Helvetica,sans-serif;text-align:center;color:#0b1f3a;margin:48px}` +
        `h1{font-size:32px;margin:0 0 8px}p{margin:0 0 28px;font-size:18px}` +
        `.u{margin-top:24px;font-size:13px;color:#555;word-break:break-all}` +
        `@media print{body{margin:24px}}</style></head><body>` +
        `<h1>${t}</h1><p>Scan with your phone camera to open the form</p>` +
        svgMarkup(matrix, 420) +
        `<div class="u">${escapeHtml(url)}</div>` +
        `<script>window.onload=function(){window.print()}</script>` +
        `</body></html>`
    );
    w.document.close();
  }, [matrix, displayTitle, url]);

  const buttonCls =
    size === "md"
      ? "inline-flex items-center rounded-splash-sm border border-splash-blue bg-white px-4 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
      : "inline-flex items-center rounded-splash-sm border border-splash-blue bg-white px-2 py-0.5 text-xs font-semibold text-splash-blue hover:bg-splash-blue/5";

  const dim = matrix ? matrix.count + QUIET_ZONE * 2 : 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonCls}
        aria-label={`Share form ${slug} by QR code or email`}
      >
        Share
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Share ${displayTitle}`}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-splash-md bg-white p-6 text-center shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-splash-navy">{displayTitle}</h2>
            <p className="mt-1 text-xs text-splash-navy/60">
              Scan with a phone camera to open the form.
            </p>
            <div className="mx-auto mt-4 w-full max-w-[220px]">
              {matrix && (
                <svg
                  viewBox={`0 0 ${dim} ${dim}`}
                  className="h-auto w-full"
                  shapeRendering="crispEdges"
                  role="img"
                  aria-label={`QR code linking to ${url}`}
                >
                  <rect width={dim} height={dim} fill="#fff" />
                  <path d={matrix.path} fill="#000" />
                </svg>
              )}
            </div>
            <p className="mt-3 break-all font-mono text-xs text-splash-navy/70">{url}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={downloadPng}
                className="inline-flex items-center rounded-splash-sm bg-splash-blue px-4 py-1.5 text-sm font-bold text-white hover:bg-splash-blue-dark"
              >
                Download PNG
              </button>
              <button
                type="button"
                onClick={printSheet}
                className="inline-flex items-center rounded-splash-sm border border-splash-blue bg-white px-4 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
              >
                Print
              </button>
            </div>
            <ShareByEmail formId={formId} audience={audience} />
            <div className="mt-5 flex justify-center">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex items-center rounded-splash-sm border border-gray-light bg-white px-4 py-1.5 text-sm font-semibold text-splash-navy hover:bg-gray-light/40"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
