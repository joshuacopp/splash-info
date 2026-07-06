// Brief 146 — out-of-band per-photo upload handler for the customer claim
// form. Mirrors the Brief 92 forms-worker pattern.
//
// `POST /claims-api/upload` — multipart body with:
//   pending_submission_id   (UUID v4; same value the client appends as
//                            `idempotency_key` on final submit. Becomes the
//                            R2 key prefix so the daily cleanup cron can
//                            find orphans without a DB join — same shape as
//                            Brief 92.)
//   field                   (optional; the photo category on the form —
//                            fourCornersPhotos / vinPhoto / damagePhotos /
//                            platePhoto. Stored in customMetadata only; the
//                            submit handler is the authoritative category
//                            mapper.)
//   file                    (the actual file blob, post-client-resize)
//
// Returns JSON `{ ok: true, r2_key, mime, size_bytes, original_filename }`
// on success.
//
// Limits:
//   - 8 MB hard cap per file. Post-client-resize files are typically
//     200-800 KB; the cap is a safety net for clients that skip resize.
//   - MIME sniffed from the first ~4 KB via `file-type`; client
//     Content-Type is ignored. Accepts image/jpeg, image/png, image/heic,
//     image/heif (+ -sequence variants).
//
// R2 key shape: claim-uploads/{pendingSubmissionId}/{nanoid}.{ext}
//   `nanoid` is a 12-char URL-safe random string. Original filename is
//   preserved on the response (and in customMetadata) so the final submit
//   payload + admin viewer can surface it.

import { fileTypeFromBuffer } from "file-type";
import { isOriginAllowed, json, jsonError } from "@splash/http";
import { type ImagesBinding, isHeicContentType } from "@splash/storage-r2";

const PENDING_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence"
]);

const EXT_FOR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/heic-sequence": "heic",
  "image/heif-sequence": "heif"
};

const ALLOWED_FIELDS = new Set([
  "fourCornersPhotos",
  "vinPhoto",
  "damagePhotos",
  "platePhoto"
]);

interface UploadEnv {
  R2_BUCKET: R2Bucket;
  /** Optional Cloudflare Images binding for HEIC->JPEG conversion at
   *  ingest. When unbound, HEIC files are stored as-is (the serve path
   *  still transcodes them on the fly). */
  IMAGES?: ImagesBinding;
}

export async function handleClaimPhotoUpload(
  request: Request,
  env: UploadEnv
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad_origin");

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (err) {
    console.error("[claim.upload] formData parse failed", err);
    return jsonError(400, "invalid_form_data");
  }

  const pendingSubmissionId = String(
    formData.get("pending_submission_id") ?? ""
  ).trim();
  if (!pendingSubmissionId || !PENDING_ID_RE.test(pendingSubmissionId)) {
    return jsonError(400, "invalid_pending_id");
  }

  const fieldName = String(formData.get("field") ?? "").trim();
  if (fieldName && !ALLOWED_FIELDS.has(fieldName)) {
    return jsonError(400, "invalid_field");
  }

  const fileEntry = formData.get("file");
  if (!(fileEntry instanceof File)) return jsonError(400, "no_file");

  const file = fileEntry;
  if (file.size === 0) return jsonError(400, "empty_file");
  if (file.size > MAX_UPLOAD_BYTES) {
    return jsonError(
      413,
      `file_too_large: file exceeds ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`
    );
  }

  // Sniff MIME from the first ~4 KB. file-type's max useful read is ~4100.
  const headerBuf = await file.slice(0, 4100).arrayBuffer();
  const sniffed = await fileTypeFromBuffer(new Uint8Array(headerBuf));
  if (!sniffed) {
    return jsonError(415, "unknown_file_type");
  }
  if (!ALLOWED_MIME.has(sniffed.mime)) {
    return jsonError(415, `mime_not_allowed: ${sniffed.mime}`);
  }

  // HEIC/HEIF → JPEG at ingest when the Images binding is available, so the
  // stored object renders directly in non-Safari admin viewers. On failure
  // (or no binding) we store the original bytes — the serve path transcodes
  // HEIC on the fly as a safety net.
  let storedMime = sniffed.mime;
  let ext = EXT_FOR_MIME[sniffed.mime] ?? sniffed.ext ?? "bin";
  let body: ReadableStream | ArrayBuffer = file.stream();

  if (env.IMAGES && isHeicContentType(sniffed.mime, file.name)) {
    try {
      const converted = await env.IMAGES.input(file.stream()).output({
        format: "image/jpeg"
      });
      body = await converted.response().arrayBuffer();
      storedMime = "image/jpeg";
      ext = "jpg";
    } catch (convErr) {
      console.error("[claim.upload] HEIC->JPEG conversion failed", convErr);
      body = file.stream();
    }
  }

  const nano = generateNanoid(12);
  const r2Key = `claim-uploads/${pendingSubmissionId}/${nano}.${ext}`;
  const originalFilename = sanitizeFilename(file.name) || `upload.${ext}`;

  try {
    await env.R2_BUCKET.put(r2Key, body, {
      httpMetadata: { contentType: storedMime },
      customMetadata: {
        pendingSubmissionId,
        field: fieldName || "unknown",
        originalFilename,
        uploadedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error("[claim.upload] R2 put failed", err);
    return jsonError(503, "r2_write_failed");
  }

  return json({
    ok: true,
    r2_key: r2Key,
    mime: storedMime,
    size_bytes: file.size,
    original_filename: originalFilename
  });
}

/** 12-char URL-safe random ID — local nanoid-equivalent without the dep. */
function generateNanoid(len: number): string {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 200);
}

/* ============================================================
 * Daily R2 orphan cleanup (Brief 146 / runs alongside Brief 65).
 *
 * Lists objects under `claim-uploads/{pendingId}/...`, groups by
 * pendingId (path index 1), and deletes any whose pendingId doesn't
 * match an existing `claims.idempotency_key`. 24h grace window so the
 * gap between OOB upload and final submit doesn't sweep in-progress
 * uploads.
 *
 * Mirrors Brief 97's forms-worker orphan sweep (apps/forms-worker/src/
 * cron/cleanup.ts) pass 1.
 * ============================================================ */

const UPLOAD_ORPHAN_TTL_HOURS = 24;
const UPLOAD_HARD_PAGE_CAP = 50;

interface CleanupEnv {
  R2_BUCKET: R2Bucket;
  DB: D1Database;
}

export interface ClaimUploadsCleanupResult {
  deleted: number;
  pagesScanned: number;
  errors: string[];
}

export async function runClaimUploadsCleanup(
  env: CleanupEnv
): Promise<ClaimUploadsCleanupResult> {
  const errors: string[] = [];
  const cutoff = new Date(Date.now() - UPLOAD_ORPHAN_TTL_HOURS * 60 * 60 * 1000);

  let deleted = 0;
  let pagesScanned = 0;

  try {
    let cursor: string | undefined;

    do {
      const list = await env.R2_BUCKET.list({
        prefix: "claim-uploads/",
        cursor,
        limit: 1000
      });
      pagesScanned++;

      // Group objects by pendingId. Path shape:
      //   claim-uploads/{pendingId}/{nanoid}.{ext}
      // index 0           1            2
      const idToKeys: Map<string, string[]> = new Map();
      for (const obj of list.objects) {
        if (obj.uploaded > cutoff) continue; // too recent
        const parts = obj.key.split("/");
        if (parts.length < 3 || !parts[1]) continue; // malformed
        const pendingId = parts[1];
        let bucket = idToKeys.get(pendingId);
        if (!bucket) {
          bucket = [];
          idToKeys.set(pendingId, bucket);
        }
        bucket.push(obj.key);
      }

      if (idToKeys.size > 0) {
        const ids = Array.from(idToKeys.keys());
        // Query D1 for claims whose idempotency_key matches any pendingId.
        // Build a parameterized IN clause. SQLite caps placeholders at ~999
        // but a single R2 list page returns ≤1000 objects, so worst case
        // matches that and we're safely under the limit (R2 dedups via the
        // map already, so ids.length ≤ list.objects.length ≤ 1000).
        const placeholders = ids.map(() => "?").join(",");
        let knownIds: Set<string>;
        try {
          const result = await env.DB.prepare(
            `SELECT idempotency_key FROM claims WHERE idempotency_key IN (${placeholders})`
          )
            .bind(...ids)
            .all<{ idempotency_key: string }>();
          knownIds = new Set(
            (result.results ?? [])
              .map((r) => r.idempotency_key)
              .filter((v): v is string => typeof v === "string")
          );
        } catch (queryErr) {
          // If the column doesn't exist yet (migration not applied), treat
          // every pendingId as "unknown" and DON'T delete — orphan sweep is
          // safe to defer.
          const msg =
            queryErr instanceof Error ? queryErr.message : String(queryErr);
          if (/no such column.*idempotency_key/i.test(msg)) {
            console.warn(
              "[claim.cleanup] idempotency_key column missing — skipping sweep (apply migration)"
            );
            return { deleted, pagesScanned, errors };
          }
          errors.push(`D1 idempotency_key query failed: ${msg}`);
          break;
        }

        for (const [pendingId, keys] of idToKeys.entries()) {
          if (knownIds.has(pendingId)) continue;
          for (const key of keys) {
            try {
              await env.R2_BUCKET.delete(key);
              deleted++;
            } catch (e) {
              errors.push(`R2 delete ${key} failed: ${String(e)}`);
            }
          }
        }
      }

      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor && pagesScanned < UPLOAD_HARD_PAGE_CAP);

    if (pagesScanned >= UPLOAD_HARD_PAGE_CAP && cursor) {
      errors.push(
        `Claim-uploads pagination cap hit (${UPLOAD_HARD_PAGE_CAP} pages); cron will catch survivors next run.`
      );
    }
  } catch (e) {
    errors.push(`Claim-uploads cleanup crashed: ${String(e)}`);
  }

  console.log("[claim.cleanup] uploads orphans deleted:", deleted, {
    pagesScanned,
    errorCount: errors.length
  });
  if (errors.length > 0) {
    console.warn("[claim.cleanup] errors", errors);
  }

  return { deleted, pagesScanned, errors };
}
