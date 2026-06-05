// Brief 156 — shared MIME helpers for promo material uploads.
//
// Single source of truth for two cross-cutting decisions:
//
//   1. Sniffed MIME → file extension lookup. Used by `materials.ts` to
//      append a sensible extension on the R2 key
//      (`promo-materials/{promoId}/{materialId}.{ext}`) so an operator
//      eyeballing the bucket can tell file kinds apart. Unknown sniffed
//      MIMEs fall back to no extension; the row's `file_mime` column
//      stays authoritative either way.
//
//   2. Deny-list. Sniffed MIMEs that we refuse to store regardless of
//      caller role. Mirrors forms-worker's posture (Brief 92) — bare
//      `text/html`, Windows executables, shell scripts. The deny-list
//      pairs with the worker's "sniff is authoritative; client
//      Content-Type is ignored" policy.
//
// Adding a new accepted type: append to MIME_EXTENSION_MAP. Adding a
// new denied type: append to MIME_DENY_LIST. No worker code change
// needed beyond the lookup.

export const MIME_EXTENSION_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
  "text/csv": "csv"
};

export const MIME_DENY_LIST: ReadonlySet<string> = new Set([
  "text/html",
  "application/x-msdownload",
  "application/x-msi",
  "application/x-sh",
  "application/x-executable"
]);

export function extensionFor(mime: string): string | null {
  return MIME_EXTENSION_MAP[mime] ?? null;
}

export function isDeniedMime(mime: string): boolean {
  return MIME_DENY_LIST.has(mime);
}
