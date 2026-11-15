// Brief 92 — vendored static-asset serve route.
//
// Two assets are bundled into the worker via wrangler's `[[rules]] type =
// "Text"` block (see wrangler.toml). The Text rule turns each .js file
// under `static/` into a default-exported string at import time, which
// we serve verbatim with long-cache headers.
//
// Why bundle instead of read from R2 at runtime: zero round-trip latency,
// no R2 read cost on every form load, and the assets ship/version with
// the worker (re-deploy → fresh assets, no separate operator step). Total
// inlined bytes are ~25 KB — well within Cloudflare's 1 MB free worker
// bundle limit.
//
// Per CLAUDE.md supply-chain posture, signature_pad.min.js is vendored
// once at brief execution time (committed to the repo) and never fetched
// from a CDN at runtime.

// `*.js` Text imports are declared in static-assets.d.ts so TypeScript
// resolves them as strings rather than failing on "module not found".
import signaturePadJs from "../../static/signature-pad.min.js";
import formsPublicJs from "../../static/forms-public.js";
// pdf.js 4.10.38 (Apache-2.0), vendored 2026-11-14 for the builder's Documents
// tab (drawing a PDF template's pages to place boxes on). Files are the npm
// package's build/pdf.min.mjs + build/pdf.worker.min.mjs, renamed .js so the
// Text rule picks them up. SHA-256:
//   pdfjs.min.js         27fc2a057a00f92a4334ad06e17dbd7259912954e9fb7f76400bcca5fd190a9c
//   pdfjs.worker.min.js  1baa1844c89c80a5b2797c916e75ab29254be46d8e9cb53cb6364d7aad84be36
// The version is in the URL, so a long cache is always correct.
import pdfjsLib from "../../static/pdfjs.min.js";
import pdfjsWorker from "../../static/pdfjs.worker.min.js";

import type { Env } from "../index.js";

interface Asset {
  body: string;
  contentType: string;
}

/**
 * Content hash, used as a cache-busting query on the script tags.
 *
 * WHY THIS EXISTS. These assets are served with `max-age=86400`, and the URL
 * never changed, so for up to 24 hours after a deploy a returning visitor ran
 * YESTERDAY'S JavaScript against TODAY'S HTML. That is not a stale-cosmetics
 * problem: conditional fields rendered by the new markup were never wired up
 * by the old script, so they stayed hidden AND required, and the browser
 * refused to submit the form without being able to say why -- a dead submit
 * button, no error, no console message a non-developer would find. It cost a
 * debugging session, and it would have hit every RM in the field the next time
 * this file changed.
 *
 * Hashing the content means the URL changes exactly when the file does: the
 * long cache is kept for visitors whose copy is still correct, and invalidated
 * the moment it is not. djb2 rather than SHA -- this is a cache key, not a
 * security boundary, and it must be computable synchronously at module load.
 */
function contentHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export const SIGNATURE_PAD_JS_VERSION = contentHash(signaturePadJs);
export const FORMS_PUBLIC_JS_VERSION = contentHash(formsPublicJs);

const ASSETS: Record<string, Asset> = {
  "/forms/api/static/signature-pad.min.js": {
    body: signaturePadJs,
    contentType: "application/javascript"
  },
  "/forms/api/static/forms-public.js": {
    body: formsPublicJs,
    contentType: "application/javascript"
  },
  "/forms/api/static/pdfjs-4.10.38.min.js": {
    body: pdfjsLib,
    contentType: "text/javascript"
  },
  "/forms/api/static/pdfjs-4.10.38.worker.min.js": {
    body: pdfjsWorker,
    contentType: "text/javascript"
  }
};

export function handleStaticAsset(
  _env: Env,
  _req: Request,
  path: string
): Response | null {
  const asset = ASSETS[path];
  if (!asset) return null;
  return new Response(asset.body, {
    status: 200,
    headers: {
      "Content-Type": asset.contentType + "; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
