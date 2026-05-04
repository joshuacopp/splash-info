// UI-side mirror of damage-worker mutation permission gates. Brief 5d.
//
// CANONICAL SOURCE: apps/damage-worker/src/index.ts:431 canMutateDocument.
//   The worker re-validates on POST, so this mirror only prevents dead-end
//   button clicks on the UI. Drift here doesn't open a security gap (worker
//   gates are still authoritative), but it does surface as a 403 inline on
//   submission instead of a clean "no button shown" UX.
//
// SYNC CHECKLIST (when changing the worker rule):
//   1. Update apps/damage-worker/src/index.ts:431 canMutateDocument.
//   2. Update this file to match.
//   3. Re-run pnpm typecheck.
//
// FUTURE CLEANUP: hoist into @splash/types or a new @splash/damage-shared
// alongside the transitions table (see _lib/transitions.ts §FUTURE CLEANUP).

import type { Session } from "@splash/types/session";
import type { ClaimPhotoRow } from "@splash/types/claims";

/**
 * Mirrors the worker's canMutateDocument gate. Returns true when:
 *   - admin / super_admin (always), OR
 *   - the document was uploaded by the current session's email
 *     (case-insensitive comparison).
 *
 * Returns false defensively for null session, missing uploaded_by, or
 * missing session.email.
 */
export function canMutateDocument(
  session: Session | null,
  photo: ClaimPhotoRow
): boolean {
  if (!session) return false;
  if (session.dcRole === "admin" || session.dcRole === "super_admin") return true;
  if (!photo.uploaded_by || !session.email) return false;
  return photo.uploaded_by.toLowerCase() === session.email.toLowerCase();
}
