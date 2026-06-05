// Brief 127 — claim-time attachment inlining.
//
// When a claim batch is returned to PA, any attachment carrying an
// `r2_key` (instead of pre-rendered `base64`) is fetched from R2,
// base64-encoded, and replaced inline. This keeps queue rows small (we
// store the r2_key, not the bytes) while still giving PA a
// self-contained payload — PA doesn't need R2 credentials.
//
// Per-attachment 5MB cap. Attachments over the cap are SKIPPED (dropped
// from the email) with a log line rather than failing the whole row —
// the email still sends, just without that attachment. Operators can
// see the skip in worker logs and re-render the source data with a
// smaller attachment if needed.

import type { Env } from "../index.js";

export interface QueueAttachment {
  filename: string;
  mime: string;
  size_bytes: number;
  r2_key?: string;
  base64?: string;
  /** Brief 157 widened from `"FORMS_FILES"` to `"FORMS_FILES" | "PROMO_FILES"`
   *  so promo-worker can enqueue announcement attachments that live in
   *  the `splash-promo-files` bucket. The dispatch below maps the string
   *  to the bound R2 binding on `env`. */
  bucket?: "FORMS_FILES" | "PROMO_FILES";
}

/** 5 MB per attachment, base64-encoded as a string. Cloudflare Worker
 *  request bodies have a 100 MB hard cap, so 50 attachments × ~5 MB =
 *  the practical ceiling on a single claim batch. PA can also choke on
 *  very large payloads, so 5 MB / attachment keeps everyone happy. */
const PER_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Inline R2-backed attachments for one queued email.
 *
 * Returns a fresh attachment array. Each `r2_key` attachment becomes a
 * `base64` attachment; existing `base64` attachments pass through; any
 * attachment that fails to fetch, exceeds the size cap, or is
 * malformed gets dropped with a log line.
 */
export async function inlineAttachments(
  env: Env,
  rowId: string,
  attachments: unknown
): Promise<QueueAttachment[]> {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const out: QueueAttachment[] = [];
  for (const raw of attachments) {
    if (!raw || typeof raw !== "object") continue;
    const att = raw as Record<string, unknown>;
    const filename = typeof att.filename === "string" ? att.filename : "";
    const mime = typeof att.mime === "string" ? att.mime : "application/octet-stream";
    const sizeBytes =
      typeof att.size_bytes === "number" && Number.isFinite(att.size_bytes)
        ? att.size_bytes
        : 0;
    if (!filename) {
      console.warn(
        `[forms.email-queue] dropping nameless attachment on row ${rowId}`
      );
      continue;
    }
    if (typeof att.base64 === "string" && att.base64.length > 0) {
      out.push({ filename, mime, size_bytes: sizeBytes, base64: att.base64 });
      continue;
    }
    if (typeof att.r2_key !== "string" || att.r2_key.length === 0) {
      console.warn(
        `[forms.email-queue] attachment for ${filename} on row ${rowId} has neither r2_key nor base64; skipping`
      );
      continue;
    }
    if (sizeBytes > PER_ATTACHMENT_MAX_BYTES) {
      console.warn(
        `[forms.email-queue] attachment ${filename} on row ${rowId} exceeds ${PER_ATTACHMENT_MAX_BYTES} bytes (size_bytes=${sizeBytes}); skipping`
      );
      continue;
    }
    // Brief 157 — dispatch on bucket name. Missing / "FORMS_FILES" → forms
    // bucket (existing behavior). "PROMO_FILES" → promo bucket (added for
    // promo announcement materials). Unknown bucket name OR an unbound
    // PROMO_FILES (forms-worker not yet redeployed with the binding) skips
    // the attachment with a log line — the email still sends without it.
    let bucket: R2Bucket | null = null;
    if (att.bucket === "PROMO_FILES") {
      bucket = env.PROMO_FILES ?? null;
    } else if (att.bucket === "FORMS_FILES" || !att.bucket) {
      bucket = env.FORMS_FILES;
    }
    if (!bucket) {
      console.warn(
        `[forms.email-queue] attachment ${filename} on row ${rowId} references unsupported or unbound bucket ${String(att.bucket)}; skipping`
      );
      continue;
    }
    let obj: R2ObjectBody | null;
    try {
      obj = await bucket.get(att.r2_key);
    } catch (err) {
      console.error(
        `[forms.email-queue] R2.get failed for ${att.r2_key} on row ${rowId}`,
        err
      );
      continue;
    }
    if (!obj) {
      console.warn(
        `[forms.email-queue] R2 miss for ${att.r2_key} on row ${rowId}; skipping`
      );
      continue;
    }
    // Defensive double-check on object size now that we have the head.
    if (obj.size > PER_ATTACHMENT_MAX_BYTES) {
      console.warn(
        `[forms.email-queue] R2 object ${att.r2_key} reports size ${obj.size} > cap; skipping`
      );
      continue;
    }
    const buffer = await obj.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    out.push({
      filename,
      mime: obj.httpMetadata?.contentType ?? mime,
      size_bytes: buffer.byteLength,
      base64
    });
  }
  return out;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  // Chunked base64 conversion — `btoa(String.fromCharCode(...))` blows
  // the JS engine's call-arg limit at ~64K, so we chunk.
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
