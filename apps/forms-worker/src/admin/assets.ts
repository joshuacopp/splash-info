// Brief 94 — admin asset upload/delete handlers.
//
// In-form display images (Image field type — planning Decision 4) live as
// `assetId` references on `form_versions.schema`. The asset itself is a row
// in `form_assets` + an R2 object at `form-assets/{form_id}/{asset_id}.{ext}`.
// Builder UI (Brief 95) wires the upload widget; this module is the worker-
// side endpoint pair.
//
//   POST   /forms/admin/api/forms/{formId}/assets
//   DELETE /forms/admin/api/forms/{formId}/assets/{assetId}
//
// MIME sniffing via `file-type` (Brief 92 pattern — first ~4 KB of the
// upload, client Content-Type is ignored). 10 MB hard ceiling chosen lower
// than the 25 MB submission-file ceiling because in-form display images are
// renderer-shipped to every form view; 10 MB is generous for image assets
// while keeping the form HTML reasonable. JPEG/PNG/GIF/WebP only — no SVG
// (XSS risk) and no PDF (in-form preview not designed for PDFs). Width /
// height capture deferred to Brief 95's client-side <img> probe before
// upload — extracting from worker code requires either a binary image
// decoder (heavy) or a parser sniff (PNG IHDR / JPEG SOF) we don't have.

import { fileTypeFromBuffer } from "file-type";
import { jsonError } from "@splash/http";
import { adminGate, adminGateResponse, requireServiceKey } from "./auth.js";
import {
  insertFormAsset,
  getFormAsset,
  deleteFormAsset
} from "../db/admin-forms.js";
import type { Env } from "../index.js";

const ASSET_HARD_LIMIT_BYTES = 10 * 1024 * 1024;
const ASSET_ALLOWED_MIMES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
];
const FORM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleAssetUpload(
  env: Env,
  req: Request,
  formId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId)) {
    return jsonError(400, "bad_form_id");
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return jsonError(400, "invalid_form_data");
  }

  const fileEntry = formData.get("file");
  const altText = String(formData.get("alt_text") ?? "");
  if (!(fileEntry instanceof File)) {
    return jsonError(400, "no_file");
  }

  const file = fileEntry;
  if (file.size === 0) {
    return jsonError(400, "empty_file");
  }
  if (file.size > ASSET_HARD_LIMIT_BYTES) {
    return jsonError(413, "file_too_large: asset exceeds 10 MB limit");
  }

  const headerBuf = await file.slice(0, 4100).arrayBuffer();
  const sniffed = await fileTypeFromBuffer(new Uint8Array(headerBuf));
  if (!sniffed || !ASSET_ALLOWED_MIMES.includes(sniffed.mime)) {
    return jsonError(415, "mime_not_allowed: asset must be JPEG, PNG, GIF, or WebP");
  }

  const assetId = crypto.randomUUID();
  const r2Key = `form-assets/${formId}/${assetId}.${sniffed.ext}`;

  try {
    await env.FORMS_FILES.put(r2Key, file.stream(), {
      httpMetadata: { contentType: sniffed.mime },
      customMetadata: {
        formId,
        assetId,
        originalFilename: file.name
      }
    });
  } catch (err) {
    console.error("[forms.admin] asset R2 put failed", err);
    return jsonError(500, "r2_write_failed");
  }

  try {
    await insertFormAsset(env, {
      id: assetId,
      formId,
      r2Key,
      mime: sniffed.mime,
      sizeBytes: file.size,
      width: null,
      height: null,
      uploadedBy: gate.session.userId
    });
  } catch (err) {
    console.error("[forms.admin] asset row insert failed", err);
    // Best-effort R2 rollback — leave the cron's daily orphan sweep as
    // the safety net if the rollback also fails.
    await env.FORMS_FILES.delete(r2Key).catch(() => undefined);
    return jsonError(500, "asset_insert_failed");
  }

  return new Response(
    JSON.stringify({
      asset_id: assetId,
      r2_key: r2Key,
      mime: sniffed.mime,
      size_bytes: file.size,
      alt_text: altText
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
}

export async function handleAssetDelete(
  env: Env,
  req: Request,
  formId: string,
  assetId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId) || !FORM_ID_RE.test(assetId)) {
    return jsonError(400, "bad_id");
  }

  let asset;
  try {
    asset = await getFormAsset(env, assetId);
  } catch (err) {
    console.error("[forms.admin] asset read failed", err);
    return jsonError(500, "read_failed");
  }
  if (!asset) {
    return jsonError(404, "not_found");
  }
  if (asset.formId !== formId) {
    return jsonError(400, "form_mismatch: asset does not belong to this form");
  }

  // Delete row first — cron is the safety net if R2 delete fails.
  try {
    await deleteFormAsset(env, assetId);
  } catch (err) {
    console.error("[forms.admin] asset row delete failed", err);
    return jsonError(500, "delete_failed");
  }

  await env.FORMS_FILES.delete(asset.r2Key).catch((err) => {
    console.error(
      "[forms.admin] R2 delete failed; cron will pick up",
      { r2_key: asset.r2Key, err }
    );
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
