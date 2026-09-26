// The safety data sheets themselves: upload, serve one, print the whole binder.
//
// STORED, NOT LINKED. The manufacturer's URL is kept on the row as provenance,
// but the artifact is the copy in R2. A binder has to work when the
// manufacturer's site has been reorganised, is down, or the network is -- and
// link rot is silent: nobody discovers a dead SDS link until they need the
// sheet, which is during a spill or an inspection. A stored copy plus the
// revision date printed on the sheet also makes "is this current?" a question
// with an answer, which a URL never does.
//
// PDF ONLY. Manufacturers publish SDSs as PDFs, so this covers the real case,
// merging is reliable, and a wrong file is refused at upload rather than
// discovered when the binder fails to print. Sniffed from the bytes -- a
// client-supplied Content-Type is a claim, not evidence.

import { PDFDocument } from "pdf-lib";

import { isOriginAllowed, jsonError } from "@splash/http";
import type { Env } from "../index.js";
import { renderSdsPdf } from "./pdf.js";
import type { SdsItemRow } from "./handlers.js";

/** A generous ceiling for one sheet. Real SDSs are well under a megabyte;
 *  scanned ones run larger. Anything past this is not a safety data sheet. */
const SHEET_MAX_BYTES = 10 * 1024 * 1024;
/** Ceiling for one merged binder. Workers have finite memory and a print job
 *  nobody can open is not a feature; over this the caller is told to print in
 *  parts rather than handed a broken file. */
const BINDER_MAX_BYTES = 45 * 1024 * 1024;

/** Keyed by CATALOGUE row: one sheet per product, not per site. Keys written
 *  before the catalogue existed are site-scoped and were adopted as-is rather
 *  than copied, so both shapes exist in the bucket and both are read by key. */
export function sheetKey(catalogId: string): string {
  return `sds-sheets/catalog/${catalogId}.pdf`;
}

/** Imported lazily: file-type is ESM-only, and a static import makes this
 *  whole module unloadable outside the worker -- including from a test that
 *  only wants the merge. It is also only needed when somebody uploads. */
async function isPdf(bytes: Uint8Array): Promise<boolean> {
  const { fileTypeFromBuffer } = await import("file-type");
  const sniffed = await fileTypeFromBuffer(bytes.slice(0, 4100));
  return sniffed?.mime === "application/pdf";
}

/**
 * POST /forms/api/sds/{id}/sheet — attach the sheet to a row.
 *
 * The R2 key is derived from the row, not supplied, so a caller cannot write
 * outside their own site's namespace by posting a path. Re-uploading overwrites
 * deliberately: a revised sheet replaces the old one, and keeping both would
 * leave two answers to "which sheet is in the binder".
 */
export async function handleUploadSheet(
  env: Env,
  req: Request,
  id: string,
  ctx: {
    readItem: (id: string) => Promise<SdsItemRow | null>;
    canRead: (locationCode: string) => boolean;
    email: string;
    isAdmin: boolean;
    patch: (id: string, body: Record<string, unknown>) => Promise<Response>;
  }
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const item = await ctx.readItem(id);
  // Not-found and not-yours give the same answer, so an id cannot be probed.
  if (!item || !ctx.canRead(item.location_code)) return jsonError(404, "not_found");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, "invalid_form_data");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return jsonError(400, "no_file");
  if (file.size > SHEET_MAX_BYTES) return jsonError(413, "file_too_large");

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!(await isPdf(bytes))) return jsonError(415, "not_a_pdf");

  if (!item.catalog_id) return jsonError(409, "item_has_no_catalog_entry");
  // Same rule as editing the identity: replacing the sheet on a VERIFIED entry
  // is an admin act. The badge says somebody accountable checked that this file
  // is this chemical's; letting anyone swap the file would retract that
  // judgement by a route that never required it.
  if (item.catalog?.verified_at && !ctx.isAdmin) {
    return jsonError(403, "verified_entry_is_admin_only");
  }
  const key = sheetKey(item.catalog_id);
  try {
    await env.FORMS_FILES.put(key, bytes, {
      httpMetadata: { contentType: "application/pdf" }
    });
  } catch (err) {
    console.error("[forms.sds] sheet upload failed", err);
    return jsonError(502, "upload_failed");
  }

  // R2 first, row second. The reverse would leave a row pointing at a sheet
  // that does not exist -- a dangling pointer the print path would 404 on --
  // whereas this order's worst case is an orphan object nobody references.
  // Stamped on the CATALOGUE: this sheet is now the sheet for this chemical at
  // every site holding it. That is the point of the feature, and the caller was
  // told the site count before they picked the file.
  const resp = await ctx.patch(item.catalog_id, {
    sds_r2_key: key,
    sds_filename: file.name.slice(0, 200),
    sds_size_bytes: bytes.length,
    sds_uploaded_at: new Date().toISOString(),
    sds_uploaded_by: ctx.email
  });
  if (!resp.ok) {
    console.error(
      `[forms.sds] sheet stored at ${key} but the row patch failed -- orphan until re-upload`
    );
  }
  return resp;
}

/**
 * GET /forms/api/sds/{id}/sheet — serve one sheet.
 *
 * Inline, so clicking a row opens the sheet rather than downloading it. Named
 * after the product so a saved copy is identifiable on disk.
 */
export async function handleServeSheet(
  env: Env,
  id: string,
  ctx: {
    readItem: (id: string) => Promise<SdsItemRow | null>;
    canRead: (locationCode: string) => boolean;
  }
): Promise<Response> {
  const item = await ctx.readItem(id);
  if (!item || !ctx.canRead(item.location_code)) return jsonError(404, "not_found");
  const key = item.catalog?.sds_r2_key;
  if (!key) return jsonError(404, "no_sheet");

  const obj = await env.FORMS_FILES.get(key);
  if (!obj) {
    // Row says there is a sheet and R2 disagrees. Log it: this is drift, not a
    // missing upload, and the two look identical to the caller.
    console.error(`[forms.sds] catalog row points at missing object ${key}`);
    return jsonError(404, "no_sheet");
  }

  const safe = (item.catalog?.product_identifier || "sds").replace(/[^A-Za-z0-9._-]+/g, "-");
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${safe}.pdf"`,
      "Cache-Control": "private, max-age=300"
    }
  });
}

export interface BinderInput {
  siteName: string;
  locationCode: string;
  items: SdsItemRow[];
  lastReviewedAt: string | null;
  lastReviewedBy: string | null;
}

export interface BinderResult {
  bytes: Uint8Array;
  /** Rows with no sheet on file, in binder order. Printed on the index so the
   *  gaps are visible on the page rather than only in the app. */
  missing: string[];
  /** Sheets that existed but could not be merged. Distinct from `missing`: one
   *  is work nobody has done, the other is a file that needs looking at. */
  failed: string[];
}

/**
 * The whole binder as one PDF: the index page, then every sheet in tab order.
 *
 * FAIL-SOFT PER SHEET. A corrupt or unreadable PDF skips and is reported rather
 * than failing the job -- the other fifteen sheets are still worth printing,
 * and a binder that refuses to print because one file is bad is the worst
 * possible handling of one bad file.
 */
export async function renderBinderPdf(
  env: Env,
  input: BinderInput
): Promise<BinderResult> {
  const indexBytes = await renderSdsPdf({
    siteName: input.siteName,
    locationCode: input.locationCode,
    items: input.items,
    lastReviewedAt: input.lastReviewedAt,
    lastReviewedBy: input.lastReviewedBy,
    bucket: env.FORMS_FILES
  });

  const out = await PDFDocument.load(indexBytes);
  const missing: string[] = [];
  const failed: string[] = [];
  let budget = BINDER_MAX_BYTES;

  for (const item of input.items) {
    const key = item.catalog?.sds_r2_key;
    const label = item.catalog?.product_identifier ?? "(unnamed)";
    if (!key) {
      missing.push(label);
      continue;
    }
    try {
      const obj = await env.FORMS_FILES.get(key);
      if (!obj) {
        missing.push(label);
        continue;
      }
      const raw = new Uint8Array(await obj.arrayBuffer());
      budget -= raw.length;
      if (budget < 0) {
        failed.push(`${label} (binder size limit reached)`);
        continue;
      }
      // ignoreEncryption: some manufacturers publish sheets with printing
      // permissions set. They are readable, and refusing to merge a sheet a
      // browser opens happily would be a puzzle nobody can act on.
      const src = await PDFDocument.load(raw, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
    } catch (err) {
      console.error(`[forms.sds] merge failed for ${key}`, err);
      failed.push(label);
    }
  }

  return { bytes: await out.save(), missing, failed };
}

/**
 * Attach a sheet directly to a catalogue entry, with no site row in play.
 *
 * Same validation and the same R2 key as the per-site route -- one sheet per
 * chemical, whichever door it came through. Exists so the catalogue can be
 * stocked BEFORE any site holds the chemical, which is the whole point of
 * curating it centrally rather than through forty site pages.
 */
export async function handleCatalogUpload(
  env: Env,
  req: Request,
  entry: { id: string },
  email: string
): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, "invalid_form_data");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return jsonError(400, "no_file");
  if (file.size > SHEET_MAX_BYTES) return jsonError(413, "file_too_large");

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!(await isPdf(bytes))) return jsonError(415, "not_a_pdf");

  const key = sheetKey(entry.id);
  try {
    await env.FORMS_FILES.put(key, bytes, {
      httpMetadata: { contentType: "application/pdf" }
    });
  } catch (err) {
    console.error("[forms.sds] catalog sheet upload failed", err);
    return jsonError(502, "upload_failed");
  }

  // R2 first, row second: the worst case that way is an orphan object nobody
  // references, where the reverse is a row pointing at a file that is not there.
  const { patchCatalogEntry } = await import("./catalog.js");
  const updated = await patchCatalogEntry(env, entry.id, {
    sds_r2_key: key,
    sds_filename: file.name.slice(0, 200),
    sds_size_bytes: bytes.length,
    sds_uploaded_at: new Date().toISOString(),
    sds_uploaded_by: email
  });
  if (!updated) {
    console.error(`[forms.sds] sheet stored at ${key} but the catalog patch failed`);
    return jsonError(502, "patch_failed");
  }
  return new Response(JSON.stringify({ catalog: updated }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
