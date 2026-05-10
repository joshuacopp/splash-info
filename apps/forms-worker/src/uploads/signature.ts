// Brief 92 — signature upload handler.
//
// `POST /forms/api/signature/{slug}` — multipart body with three parts:
//   pending_submission_id   (UUID; matches Brief 90's renderer hidden input)
//   field_key               (the SignatureField.key)
//   signature               (PNG blob or SVG text blob, per field.format)
//
// Returns JSON { r2_key, format, size_bytes } on success.
//
// Format is read from the field config rather than from the request — the
// client-side `signature_pad` library outputs PNG via `toDataURL` or SVG
// via `toSVG` based on the explicit method call (Brief 95's inspector
// chooses which). MIME is derived from `field.format` for the same reason.

import { isOriginAllowed, jsonError } from "@splash/http";
import type { SignatureField } from "@splash/forms-schema";
import type { Env } from "../index.js";
import { HARD_LIMITS } from "../limits.js";
import { getFormBySlug, getCurrentVersion } from "../db/forms.js";

const PENDING_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SignatureResult {
  r2_key: string;
  format: "png" | "svg";
  size_bytes: number;
}

export async function handleSignatureUpload(
  env: Env,
  req: Request,
  slug: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const form = await getFormBySlug(env, slug);
  if (!form) return jsonError(404, "form_not_found");
  if (form.status !== "published") {
    return jsonError(410, "form_not_accepting_submissions");
  }
  if (!form.currentVersionId) {
    return jsonError(410, "form_has_no_published_version");
  }

  const version = await getCurrentVersion(env, form.id, form.currentVersionId);
  if (!version) return jsonError(500, "form_version_missing");

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    console.error("[forms] handleSignatureUpload: formData parse failed", err);
    return jsonError(400, "invalid_form_data");
  }

  const pendingSubmissionId = String(formData.get("pending_submission_id") ?? "");
  const fieldKey = String(formData.get("field_key") ?? "");
  const sigEntry = formData.get("signature");

  if (!pendingSubmissionId || !PENDING_ID_RE.test(pendingSubmissionId)) {
    return jsonError(400, "invalid_pending_id");
  }
  if (!fieldKey) return jsonError(400, "missing_field_key");
  if (!(sigEntry instanceof Blob)) return jsonError(400, "no_signature");

  const field = version.schema.fields.find(
    (f) => f.key === fieldKey && f.type === "signature"
  ) as SignatureField | undefined;
  if (!field) {
    return jsonError(400, `unknown_field: "${fieldKey}" is not a signature field on this form`);
  }

  const blob = sigEntry;
  if (blob.size === 0) return jsonError(400, "empty_signature");
  if (blob.size > HARD_LIMITS.SIGNATURE_MAX_BYTES) {
    return jsonError(413, "signature_too_large: signature exceeds 1 MB");
  }

  const format = field.format;
  const filename = `signature.${format}`;
  const mime = format === "png" ? "image/png" : "image/svg+xml";
  const r2_key = `form-submission-files/${form.id}/${pendingSubmissionId}/${fieldKey}/${filename}`;

  try {
    await env.FORMS_FILES.put(r2_key, blob.stream(), {
      httpMetadata: { contentType: mime },
      customMetadata: {
        formId: form.id,
        pendingSubmissionId,
        fieldKey,
        originalFilename: filename
      }
    });
  } catch (err) {
    console.error("[forms] handleSignatureUpload: R2 put failed", err);
    return jsonError(500, "r2_write_failed: please try again");
  }

  const result: SignatureResult = { r2_key, format, size_bytes: blob.size };
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
