// Brief 158b — shared helpers for promo server actions.
//
// `toActionResult` collapses a WorkerWriteResult into the ActionResult shape
// <ActionForm> expects, surfacing field-level errors as a human-readable
// summary so the inline error banner makes sense even before per-field
// rendering lands. `revalidatePromoPaths` covers the common case of
// invalidating both the live view and (optionally) the ticket page.

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../../_components/ActionForm";
import type { WorkerWriteResult } from "./worker-fetch";

const ERROR_CODE_LABELS: Record<string, string> = {
  bad_request: "The form contains invalid values.",
  bad_origin: "Browser security check failed. Reload and try again.",
  unauthorized: "Sign in again — your session expired.",
  forbidden: "You don't have permission to perform that action.",
  promo_not_found: "This promotion was deleted or moved.",
  material_not_found: "That material was already removed.",
  material_not_on_promo: "One or more selected materials are no longer attached.",
  not_assigned: "That user wasn't assigned to this promotion.",
  already_assigned: "That user is already assigned.",
  target_no_promo_role: "That user can't be assigned (no promo_role set in sysadmin).",
  invalid_recipients: "One or more recipient emails are invalid.",
  ticket_missing: "Internal: the ticket row is missing.",
  unsupported_mime: "That file type is not allowed.",
  file_too_large: "File exceeds the 50 MB limit.",
  material_limit_reached: "This promotion has hit the material count cap.",
  ptp_save_failed: "PTP save failed. Try again.",
  announcement_create_failed: "Announcement snapshot failed. Try again.",
  material_create_failed: "Material upload failed. Try again.",
  patch_failed: "Save failed. Try again.",
  delete_failed: "Delete failed. Try again.",
  serve_failed: "File serve failed.",
  service_key_unbound: "Promo worker not fully configured. Contact an admin.",
  location_not_on_promo: "That location isn't attached to this promotion."
};

function humanize(error: string): string {
  if (ERROR_CODE_LABELS[error]) return ERROR_CODE_LABELS[error];
  // pass through non-mapped error strings — they may be PA/network errors
  // (e.g., `HTTP 500`) that are useful for debug.
  return error;
}

function fieldsSummary(fields: Record<string, string>): string {
  const parts = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return parts.join("; ");
}

/**
 * Collapse a worker write result into an ActionResult. On failure, the
 * `fields` map (when present) is rendered as a summary string inside the
 * `error` field for legibility.
 */
export function toActionResult<T>(
  result: WorkerWriteResult<T>,
  successMessage: string
): ActionResult {
  if (result.ok) return { ok: true, message: successMessage };
  let error = humanize(result.error);
  if (result.fields && Object.keys(result.fields).length > 0) {
    error = `${error} (${fieldsSummary(result.fields)})`;
  }
  return { ok: false, error };
}

const LIVE_VIEW = "/admin/promotions/[id]" as const;
const TICKET = "/admin/promotions/[id]/ticket" as const;
const LIST = "/admin/promotions" as const;
const QUEUE = "/admin/promotions/queue" as const;

/**
 * Invalidate Next's segment cache for every promo page that might display
 * the post-mutation state. `router.refresh()` on the client side then
 * re-fetches against the invalidated cache.
 */
export function revalidatePromoPaths(opts: {
  includeList?: boolean;
  includeQueue?: boolean;
  promoId?: string;
} = {}) {
  if (opts.promoId) {
    revalidatePath(LIVE_VIEW, "page");
    revalidatePath(TICKET, "page");
  }
  if (opts.includeList ?? true) revalidatePath(LIST, "page");
  if (opts.includeQueue ?? true) revalidatePath(QUEUE, "page");
}
