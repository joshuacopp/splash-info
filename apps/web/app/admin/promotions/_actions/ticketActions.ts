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
  patchPromoLocationProgress
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
