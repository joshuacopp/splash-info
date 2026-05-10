// Brief 92 — file upload handler.
//
// `POST /forms/api/upload/{slug}` — multipart body with three parts:
//   pending_submission_id   (UUID; matches Brief 90's renderer hidden input)
//   field_key               (the FileField.key)
//   file                    (the actual file blob)
//
// Returns JSON { r2_key, mime, size_bytes, original_filename } on success.
// Per planning Decision 6:
//   - Sniff MIME from the first ~4 KB via `file-type` (client Content-Type
//     is trivially forged, so it's ignored entirely).
//   - Reject when sniffed MIME isn't allowed by the field config (415).
//   - Clamp per-field maxSizeMb to HARD_LIMITS.PER_FILE_MAX_BYTES.
//   - Files land in R2 at form-submission-files/{form_id}/{pending_id}/{field_key}/{filename}
//     so Brief 97's daily cron can find orphans without a DB join.
//
// Submit-time enforcement (per-submission size, file count, prefix match)
// is in apps/forms-worker/src/submit/index.ts — this handler only enforces
// per-file limits.

import { fileTypeFromBuffer } from "file-type";
import { isOriginAllowed, jsonError } from "@splash/http";
import type { FileField } from "@splash/forms-schema";
import type { Env } from "../index.js";
import { HARD_LIMITS, DEFAULT_LIMITS } from "../limits.js";
import { getFormBySlug, getCurrentVersion } from "../db/forms.js";

const PENDING_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface UploadResult {
  r2_key: string;
  mime: string;
  size_bytes: number;
  original_filename: string;
}

export async function handleFileUpload(
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
    console.error("[forms] handleFileUpload: formData parse failed", err);
    return jsonError(400, "invalid_form_data");
  }

  const pendingSubmissionId = String(formData.get("pending_submission_id") ?? "");
  const fieldKey = String(formData.get("field_key") ?? "");
  const fileEntry = formData.get("file");

  if (!pendingSubmissionId || !PENDING_ID_RE.test(pendingSubmissionId)) {
    return jsonError(400, "invalid_pending_id");
  }
  if (!fieldKey) return jsonError(400, "missing_field_key");
  if (!(fileEntry instanceof File)) return jsonError(400, "no_file");

  const field = version.schema.fields.find(
    (f) => f.key === fieldKey && f.type === "file"
  ) as FileField | undefined;
  if (!field) {
    return jsonError(400, `unknown_field: "${fieldKey}" is not a file field on this form`);
  }

  const file = fileEntry;
  const fieldMaxBytes = Math.min(
    (field.maxSizeMb ?? DEFAULT_LIMITS.PER_FILE_MAX_MB) * 1024 * 1024,
    HARD_LIMITS.PER_FILE_MAX_BYTES
  );

  if (file.size === 0) return jsonError(400, "empty_file");
  if (file.size > fieldMaxBytes) {
    const limitMb = Math.floor(fieldMaxBytes / 1024 / 1024);
    return jsonError(413, `file_too_large: file exceeds ${limitMb} MB limit`);
  }

  // MIME sniff via first 4100 bytes (file-type's max useful read).
  const headerBuf = await file.slice(0, 4100).arrayBuffer();
  const sniffed = await fileTypeFromBuffer(new Uint8Array(headerBuf));
  if (!sniffed) {
    return jsonError(400, "unknown_file_type: could not determine file type from contents");
  }

  const allowedMimes = field.allowedMimeTypes ?? DEFAULT_LIMITS.ALLOWED_MIME_TYPES;
  if (!isMimeAllowed(sniffed.mime, allowedMimes)) {
    return jsonError(415, `mime_not_allowed: file type ${sniffed.mime} not permitted for this field`);
  }

  const safeFilename = sanitizeFilename(file.name) || `upload.${sniffed.ext}`;
  const r2_key = `form-submission-files/${form.id}/${pendingSubmissionId}/${fieldKey}/${safeFilename}`;

  try {
    await env.FORMS_FILES.put(r2_key, file.stream(), {
      httpMetadata: { contentType: sniffed.mime },
      customMetadata: {
        formId: form.id,
        pendingSubmissionId,
        fieldKey,
        originalFilename: file.name
      }
    });
  } catch (err) {
    console.error("[forms] handleFileUpload: R2 put failed", err);
    return jsonError(500, "r2_write_failed: please try again");
  }

  const result: UploadResult = {
    r2_key,
    mime: sniffed.mime,
    size_bytes: file.size,
    original_filename: file.name
  };
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function isMimeAllowed(mime: string, allowed: readonly string[]): boolean {
  return allowed.some((pattern) => {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      return mime.startsWith(prefix + "/");
    }
    return mime === pattern;
  });
}

/**
 * Strip path separators, control chars, leading dots; cap at 200 chars.
 * R2 doesn't care about most chars but our paths are URL segments
 * (admin serve route decodes them) — keep them safe.
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 200);
}
