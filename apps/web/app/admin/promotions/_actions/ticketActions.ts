// Brief 158b — IT ticket page server actions: ticket field patch,
// assignee add/remove, per-location completion toggle.
//
// Each action returns `data.promoStatus` (when present) so the client
// can show an auto-flip echo ("Status auto-advanced to Scoped") without
// a second round-trip. Brief 155's worker emits a `status_changed`
// activity row with `auto: true` when this fires.

"use server";

import {
  patchPromoTicket,
  addPromoAssignee,
  removePromoAssignee,
  patchPromoLocationProgress,
  patchPromoLocationRemoval,
  notifyCompletedSites,
  notifyRemovedSites
} from "../_lib/worker-fetch";
import {
  toActionResult,
  revalidatePromoPaths
} from "../_lib/action-helpers";
import type { ActionResult } from "../../_components/ActionForm";
import type { PatchTicketBody } from "../_lib/worker-fetch";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_MAX_LEN = 10_000;
const UUID_V4_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_CODE_RE = /^[a-z0-9_-]+$/;

function asString(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

/**
 * Diff the form values against the initial values so only changed fields
 * ship to the worker. Reduces no-op activity-log noise (the worker emits
 * `ticket_updated` only when at least one field actually changed).
 */
export async function patchTicketAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const promoId = asString(formData.get("promoId")).trim();
  if (!promoId) return { ok: false, error: "Missing promo id." };

  const initReadyBy = asString(formData.get("initialReadyByDate"));
  const initRoadblocks = asString(formData.get("initialRoadblocks"));
  const initInternalNote = asString(formData.get("initialInternalNote"));

  const newReadyBy = asString(formData.get("readyByDate")).trim();
  const newRoadblocks = asString(formData.get("roadblocks"));
  const newInternalNote = asString(formData.get("internalNote"));

  const patch: PatchTicketBody = {};

  if (newReadyBy !== initReadyBy) {
    if (newReadyBy === "") {
      patch.readyByDate = null;
    } else if (ISO_DATE_RE.test(newReadyBy)) {
      patch.readyByDate = newReadyBy;
    } else {
      return { ok: false, error: "Ready-by date must be YYYY-MM-DD." };
    }
  }

  if (newRoadblocks !== initRoadblocks) {
    if (newRoadblocks.length > FIELD_MAX_LEN) {
      return { ok: false, error: "Roadblocks field is too long." };
    }
    patch.roadblocks = newRoadblocks.trim() === "" ? null : newRoadblocks.trim();
  }

  if (newInternalNote !== initInternalNote) {
    if (newInternalNote.length > FIELD_MAX_LEN) {
      return { ok: false, error: "Internal note field is too long." };
    }
    patch.internalNote =
      newInternalNote.trim() === "" ? null : newInternalNote.trim();
  }

  if (Object.keys(patch).length === 0) {
    return { ok: true, message: "No changes to save." };
  }

  const result = await patchPromoTicket(promoId, patch);
  if (!result.ok) return toActionResult(result, "");

  revalidatePromoPaths({ promoId, includeList: true, includeQueue: true });
  const autoFlipped =
    result.data.promoStatus && result.data.promoStatus !== "Submitted";
  return {
    ok: true,
    message: autoFlipped
      ? `Saved — status auto-advanced to ${result.data.promoStatus}.`
      : "Saved."
  };
}

export async function addAssigneeAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const promoId = asString(formData.get("promoId")).trim();
  const userId = asString(formData.get("userId")).trim();
  if (!promoId) return { ok: false, error: "Missing promo id." };
  if (!UUID_V4_SHAPE.test(userId)) {
    return { ok: false, error: "Pick a user from the suggestions." };
  }

  const result = await addPromoAssignee(promoId, userId);
  if (!result.ok) return toActionResult(result, "");

  revalidatePromoPaths({ promoId, includeList: true, includeQueue: true });
  const autoFlipped =
    result.data.promoStatus && result.data.promoStatus !== "Submitted";
  return {
    ok: true,
    message: autoFlipped
      ? `Added — status auto-advanced to ${result.data.promoStatus}.`
      : "Assignee added."
  };
}

export async function removeAssigneeAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const promoId = asString(formData.get("promoId")).trim();
  const userId = asString(formData.get("userId")).trim();
  if (!promoId) return { ok: false, error: "Missing promo id." };
  if (!userId) return { ok: false, error: "Missing user id." };

  const result = await removePromoAssignee(promoId, userId);
  if (!result.ok) return toActionResult(result, "");

  revalidatePromoPaths({ promoId, includeList: true, includeQueue: true });
  return { ok: true, message: "Assignee removed." };
}

export async function toggleLocationProgressAction(
  promoId: string,
  locationCode: string,
  isComplete: boolean
): Promise<ActionResult> {
  if (!promoId) return { ok: false, error: "Missing promo id." };
  if (!LOCATION_CODE_RE.test(locationCode)) {
    return { ok: false, error: "Invalid location code." };
  }

  const result = await patchPromoLocationProgress(
    promoId,
    locationCode,
    isComplete
  );
  if (!result.ok) return toActionResult(result, "");

  revalidatePromoPaths({ promoId, includeList: true, includeQueue: true });
  return {
    ok: true,
    message: isComplete
      ? `Marked ${locationCode} complete.`
      : `Marked ${locationCode} incomplete.`
  };
}

/**
 * Brief 167 — toggle the per-location removal flag. Mirrors
 * `toggleLocationProgressAction` (free function — used by the optimistic
 * UI in `LocationRemovalToggleable`, NOT a `(prev, formData)` form action).
 *
 * Un-marking a site removed ALSO clears the worker-side
 * `removal_notified_at` so the FAB re-treats the site as eligible after a
 * future re-mark. The dedup index in `outbound_emails` still suppresses
 * dup queue rows unless the operator also deletes the prior queue row.
 */
export async function toggleLocationRemovalAction(
  promoId: string,
  locationCode: string,
  isRemoved: boolean
): Promise<ActionResult> {
  if (!promoId) return { ok: false, error: "Missing promo id." };
  if (!LOCATION_CODE_RE.test(locationCode)) {
    return { ok: false, error: "Invalid location code." };
  }

  const result = await patchPromoLocationRemoval(
    promoId,
    locationCode,
    isRemoved
  );
  if (!result.ok) return toActionResult(result, "");

  revalidatePromoPaths({ promoId, includeList: true, includeQueue: true });
  return {
    ok: true,
    message: isRemoved
      ? `Marked ${locationCode} removed.`
      : `Unmarked ${locationCode} removed.`
  };
}

const NOTE_MAX_LEN = 500;

/**
 * Brief 164 — "Notify completed sites" FAB action. Fires one branded
 * email per recipient per eligible site (sites with `is_complete = true
 * AND notifiedAt === null`). Optional operator note prepends to every
 * per-site body.
 *
 * Returns ActionResult with `data: {notifiedCount, sites, skippedCount,
 * failedLocations, message?}` so the modal can render the breakdown and
 * surface partial failures as an amber sub-banner.
 */
export async function notifyCompletedSitesAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const promoId = asString(formData.get("promoId")).trim();
  if (!promoId) return { ok: false, error: "Missing promo id." };

  const noteRaw = asString(formData.get("note"));
  const note = noteRaw.trim();
  if (note.length > NOTE_MAX_LEN) {
    return {
      ok: false,
      error: `Note is too long (max ${NOTE_MAX_LEN} chars).`
    };
  }

  // Brief 166 item 7 — RM/RD opt-in checkboxes on the modal arrive as
  // present-with-value-"on" / absent. Convert to booleans for the worker.
  const includeRm = asString(formData.get("includeRm")) === "on";
  const includeRd = asString(formData.get("includeRd")) === "on";

  const body: { note?: string; includeRm?: boolean; includeRd?: boolean } = {};
  if (note) body.note = note;
  if (includeRm) body.includeRm = true;
  if (includeRd) body.includeRd = true;

  const result = await notifyCompletedSites(promoId, body);
  if (!result.ok) return toActionResult(result, "");

  revalidatePromoPaths({ promoId, includeList: true, includeQueue: true });
  const data = result.data;
  const failed = data.failedLocations.length;
  const skipped = data.skippedCount;
  let message: string;
  if (data.notifiedCount === 0 && failed === 0 && skipped === 0) {
    message = data.message || "No new sites to notify.";
  } else {
    const parts: string[] = [
      `Notified ${data.notifiedCount} site${data.notifiedCount === 1 ? "" : "s"}.`
    ];
    if (skipped > 0) {
      parts.push(`Skipped ${skipped} (no contact email on file).`);
    }
    if (failed > 0) {
      parts.push(`Failed ${failed}: ${data.failedLocations.join(", ")}.`);
    }
    message = parts.join(" ");
  }
  return { ok: true, message, data };
}

/**
 * Brief 167 — "Notify removed sites" FAB action. Symmetric twin of
 * `notifyCompletedSitesAction`. Fires one branded email per recipient per
 * eligible removed-site (sites with `is_removed = true AND
 * removalNotifiedAt === null`). Same Brief 166 RM/RD opt-in pattern as the
 * build-phase notify.
 *
 * Returns ActionResult with `data: {notifiedCount, sites, skippedCount,
 * failedLocations, message?}` so the modal can render the breakdown and
 * surface partial failures as an amber sub-banner.
 */
export async function notifyRemovedSitesAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const promoId = asString(formData.get("promoId")).trim();
  if (!promoId) return { ok: false, error: "Missing promo id." };

  const noteRaw = asString(formData.get("note"));
  const note = noteRaw.trim();
  if (note.length > NOTE_MAX_LEN) {
    return {
      ok: false,
      error: `Note is too long (max ${NOTE_MAX_LEN} chars).`
    };
  }

  const includeRm = asString(formData.get("includeRm")) === "on";
  const includeRd = asString(formData.get("includeRd")) === "on";

  const body: { note?: string; includeRm?: boolean; includeRd?: boolean } = {};
  if (note) body.note = note;
  if (includeRm) body.includeRm = true;
  if (includeRd) body.includeRd = true;

  const result = await notifyRemovedSites(promoId, body);
  if (!result.ok) return toActionResult(result, "");

  revalidatePromoPaths({ promoId, includeList: true, includeQueue: true });
  const data = result.data;
  const failed = data.failedLocations.length;
  const skipped = data.skippedCount;
  let message: string;
  if (data.notifiedCount === 0 && failed === 0 && skipped === 0) {
    message = data.message || "No new sites to notify.";
  } else {
    const parts: string[] = [
      `Notified ${data.notifiedCount} site${data.notifiedCount === 1 ? "" : "s"} of removal.`
    ];
    if (skipped > 0) {
      parts.push(`Skipped ${skipped} (no contact email on file).`);
    }
    if (failed > 0) {
      parts.push(`Failed ${failed}: ${data.failedLocations.join(", ")}.`);
    }
    message = parts.join(" ");
  }
  return { ok: true, message, data };
}
