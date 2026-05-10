// Brief 92 — file + signature upload limits.
//
// Hard ceilings here are non-overridable from field config. Per-field
// caps set by the operator (Brief 95 inspector) clamp DOWN to these
// values; anything above gets trimmed at upload time.
//
// Sizing chosen to stay well inside Cloudflare Workers' free-plan
// 100 MB request-body cap and the R2 free-plan 5 GB object ceiling.
// Per-submission ceiling is enforced at submit time by summing R2
// HEAD sizes across every file/signature payload entry.

export const HARD_LIMITS = {
  /** 25 MB — single-file upload ceiling. Per-field cap can go lower
   *  but never higher; uploads above this 413. */
  PER_FILE_MAX_BYTES: 25 * 1024 * 1024,

  /** 100 MB — sum of every file in one submission. Submit handler
   *  sums R2 HEAD sizes and 413s on overflow. */
  PER_SUBMISSION_MAX_BYTES: 100 * 1024 * 1024,

  /** 20 — file+signature count cap per submission. */
  PER_SUBMISSION_MAX_FILES: 20,

  /** 1 MB — signatures are tiny. Cap is defense-in-depth against a
   *  rogue client posting a big PNG masquerading as a signature. */
  SIGNATURE_MAX_BYTES: 1 * 1024 * 1024,

  /** Brief 97's daily cleanup deletes any R2 object under
   *  `form-submission-files/` whose `pendingSubmissionId` doesn't
   *  match a `form_submissions.id` AND whose `uploaded` time is
   *  older than this. Prevents an aborted-mid-upload leaving R2
   *  bytes around forever. */
  PENDING_FILE_TTL_HOURS: 24
} as const;

export const DEFAULT_LIMITS = {
  /** Per-field default when the field config omits `maxSizeMb`. */
  PER_FILE_MAX_MB: 10,

  /** Per-field default when the field config omits `allowedMimeTypes`.
   *  Image globs + PDF cover the operator-facing common cases without
   *  opening the door to arbitrary binary uploads. */
  ALLOWED_MIME_TYPES: ["image/*", "application/pdf"] as readonly string[]
} as const;
