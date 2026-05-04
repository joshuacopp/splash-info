// R2 helpers for the Splash MaxPass system. Currently used only by the
// damage worker; exposed as a shared package so future workers (e.g., a
// receipts/voucher service) can reuse the upload primitives.
//
// Key layout in `splash-vehicle-claims` bucket:
//   claims/{claimId}/{type-slug}_{n}.{ext}   — photos + docs
//   submissions/{claimId}.json                — full claim JSON archive
//   failed_submissions/{claimId}.json         — Power Automate failure fallback
//
// Brand asset URL constants live in ./assets (already populated in Step 3
// before this package was ported).

export { ASSETS, type AssetKey } from "./assets.js";

/**
 * Minimal Cloudflare Images binding shape — only the methods we use.
 * Defined locally so the package doesn't pin to a specific
 * @cloudflare/workers-types version that may or may not export the type.
 */
export interface ImagesBinding {
  input(stream: ReadableStream): {
    output(opts: { format: string }): Promise<{
      response(): Response;
    }>;
  };
}

/* ============================================================
 * Helpers
 * ============================================================ */

/**
 * Generate a claim ID like `BIN-20260502-143055-AB12`.
 * Source: legacy/damagemanager.js:243 generateClaimId.
 */
export function generateClaimId(location: string | null | undefined): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "");
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  const locCode = (location ?? "UNK").substring(0, 3).toUpperCase();
  return `${locCode}-${dateStr}-${timeStr}-${random}`;
}

/**
 * Detect HEIC/HEIF files by extension or MIME type.
 * Source: legacy/damagemanager.js:252 isHeicFile.
 */
export function isHeicFile(file: File): boolean {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const type = (file.type ?? "").toLowerCase();
  return (
    ext === "heic" ||
    ext === "heif" ||
    type === "image/heic" ||
    type === "image/heif" ||
    type === "image/heic-sequence" ||
    type === "image/heif-sequence"
  );
}

/* ============================================================
 * Photo upload
 * ============================================================ */

export interface UploadClaimPhotoArgs {
  bucket: R2Bucket;
  file: File;
  claimId: string;
  /** Human-friendly category, e.g. "Vehicle Overview" / "VIN" / "Damage". */
  photoType: string;
  /** Index within the category (0-based on input, +1 in the key). */
  index: number;
  /** Optional Cloudflare Images binding for HEIC→JPEG conversion. When
   *  undefined, HEIC files are stored as-is. */
  images?: ImagesBinding;
}

export interface UploadClaimPhotoResult {
  key: string;
  contentType: string;
  /** Final extension after any HEIC→JPEG conversion. */
  ext: string;
}

/**
 * Upload one photo to the claims bucket. HEIC inputs are converted to JPEG
 * via the Images binding when provided; otherwise stored as-is.
 *
 * Source: legacy/damagemanager.js:260 uploadToR2.
 *
 * Returns null on failure (logged via console.error). Caller should treat
 * null as "skip this photo" — submission JSON in R2 still preserves the
 * record (per the unconditional saveSubmissionToR2 contract).
 */
export async function uploadClaimPhoto(
  args: UploadClaimPhotoArgs
): Promise<UploadClaimPhotoResult | null> {
  const { bucket, file, claimId, photoType, index, images } = args;
  try {
    let ext = (file.name.split(".").pop() ?? "jpg").toLowerCase();
    const sanitizedType = photoType.replace(/\s+/g, "_").toLowerCase();

    let body: ArrayBuffer;
    let contentType = file.type || "application/octet-stream";

    if (isHeicFile(file) && images) {
      try {
        const result = await images.input(file.stream()).output({ format: "image/jpeg" });
        body = await result.response().arrayBuffer();
        ext = "jpg";
        contentType = "image/jpeg";
      } catch (convErr) {
        console.error("HEIC->JPEG conversion failed for", file.name, convErr);
        body = await file.arrayBuffer();
      }
    } else {
      body = await file.arrayBuffer();
    }

    const key = `claims/${claimId}/${sanitizedType}_${index + 1}.${ext}`;

    await bucket.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: {
        claimId,
        photoType,
        originalName: file.name,
        uploadedAt: new Date().toISOString()
      }
    });

    return { key, contentType, ext };
  } catch (error) {
    console.error("R2 upload error:", error);
    return null;
  }
}

/* ============================================================
 * Submission JSON archives
 * ============================================================ */

/**
 * Save the full claim JSON to R2 unconditionally (canonical record even if
 * Power Automate / D1 fail downstream). Matches gotcha #287:
 * "Photos and submission JSON go to R2 unconditionally — even if Power
 * Automate fails".
 *
 * Source: legacy/damagemanager.js:318 saveSubmissionToR2.
 */
export async function saveClaimSubmission(
  bucket: R2Bucket,
  claimData: { claimId: string } & Record<string, unknown>
): Promise<void> {
  try {
    const key = `submissions/${claimData.claimId}.json`;
    await bucket.put(key, JSON.stringify(claimData, null, 2), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        savedAt: new Date().toISOString(),
        claimId: claimData.claimId
      }
    });
  } catch (error) {
    // Log but don't throw — pipeline must continue.
    console.error("Failed to save submission JSON to R2:", error);
  }
}

/**
 * Save submission JSON to the failed-submissions prefix when Power Automate
 * rejects the claim. Separate from saveClaimSubmission so the canonical
 * archive stays untouched.
 *
 * Source: legacy/damagemanager.js:301 saveFailedSubmission.
 */
export async function saveFailedSubmission(
  bucket: R2Bucket,
  claimData: { claimId: string } & Record<string, unknown>,
  reason = "Power Automate POST failed"
): Promise<void> {
  try {
    const key = `failed_submissions/${claimData.claimId}.json`;
    await bucket.put(key, JSON.stringify(claimData, null, 2), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        failedAt: new Date().toISOString(),
        reason
      }
    });
  } catch (error) {
    console.error("Failed to save submission to R2:", error);
  }
}

/* ============================================================
 * Photo serving
 * ============================================================ */

/**
 * Serve a photo by R2 key suffix (the path after `claims/`). Returns 404
 * when the object is missing. 24-hour cache control matches the legacy
 * behavior.
 *
 * Source: legacy/damagemanager.js:5666 serveR2Photo.
 *
 * The damage-worker route `/claims-api/photo/{rest}` calls this with
 * the `{rest}` portion (everything after `claims-api/photo/`). The legacy
 * prepended "claims/" before the lookup — we preserve that here.
 */
export async function serveClaimPhoto(
  bucket: R2Bucket,
  photoPathSuffix: string
): Promise<Response> {
  try {
    const key = `claims/${photoPathSuffix}`;
    const object = await bucket.get(key);
    if (!object) {
      return new Response("Photo not found", { status: 404 });
    }
    const headers = new Headers();
    headers.set("Content-Type", object.httpMetadata?.contentType ?? "image/jpeg");
    headers.set("Cache-Control", "public, max-age=86400");
    return new Response(object.body, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return new Response("Error fetching photo: " + message, { status: 500 });
  }
}
