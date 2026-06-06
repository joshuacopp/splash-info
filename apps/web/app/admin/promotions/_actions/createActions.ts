// Brief 158b — create-promo server action.
//
// Reads the FormData out of the create form, validates client-side
// defenses-in-depth, calls the worker POST /promo/api/promos, and on
// success returns the new promoId in the ActionResult's `data` field so
// the client component can router.push to the new promo's live view.
// Brief 158b widened ActionResult to carry an optional `data` payload —
// avoids the Brief 95 saveDraftAction "OK:{slug}" sentinel hack and
// keeps redirect-on-success type-safe.

"use server";

import { createPromo } from "../_lib/worker-fetch";
import {
  toActionResult,
  revalidatePromoPaths
} from "../_lib/action-helpers";
import type { ActionResult } from "../../_components/ActionForm";
import type {
  PromoPriority,
  PromoType
} from "../_lib/types";

const PROMO_TYPES = ["Same", "BOGO", "Add-ons", "Discount", "Other"] as const;
const PRIORITIES = ["High", "Medium", "Low"] as const;
// `Same` is self-explanatory (today's pricing, no kiosk behavior change).
// Everything else needs operator copy explaining what the kiosk / POS should
// do — `Other` especially, since the type name alone tells reviewers nothing.
// Keep in sync with PROMO_TYPES_REQUIRING_POS_BEHAVIOR in
// apps/promo-worker/src/handlers/promos.ts.
const REQUIRES_POS_BEHAVIOR = new Set<string>([
  "BOGO",
  "Add-ons",
  "Discount",
  "Other"
]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asString(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

export async function createPromoAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const title = asString(formData.get("title")).trim();
  const promoType = asString(formData.get("promoType")).trim();
  const posBehaviorRaw = asString(formData.get("posBehavior")).trim();
  const proposedStartDate = asString(formData.get("proposedStartDate")).trim();
  const proposedEndDate = asString(formData.get("proposedEndDate")).trim();
  const requestedGoLiveDate = asString(
    formData.get("requestedGoLiveDate")
  ).trim();
  const priority = asString(formData.get("priority")).trim();
  const locationsRaw = asString(formData.get("locationCodes"));

  if (!title) {
    return { ok: false, error: "Promotion title is required." };
  }
  if (!(PROMO_TYPES as readonly string[]).includes(promoType)) {
    return { ok: false, error: "Pick a promo type." };
  }
  if (!(PRIORITIES as readonly string[]).includes(priority)) {
    return { ok: false, error: "Pick a priority." };
  }
  if (!ISO_DATE_RE.test(proposedStartDate)) {
    return { ok: false, error: "Proposed start date is required." };
  }
  if (!ISO_DATE_RE.test(proposedEndDate)) {
    return { ok: false, error: "Proposed end date is required." };
  }
  if (proposedStartDate > proposedEndDate) {
    return {
      ok: false,
      error: "Proposed end date must be on or after the start date."
    };
  }
  if (!ISO_DATE_RE.test(requestedGoLiveDate)) {
    return { ok: false, error: "Requested go-live date is required." };
  }

  let posBehavior: string | null = null;
  if (posBehaviorRaw) posBehavior = posBehaviorRaw;
  if (REQUIRES_POS_BEHAVIOR.has(promoType) && !posBehavior) {
    return {
      ok: false,
      error: `POS behavior is required for ${promoType} promotions.`
    };
  }

  const locationCodes = locationsRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (locationCodes.length === 0) {
    return { ok: false, error: "Select at least one location." };
  }

  const result = await createPromo({
    title,
    promoType: promoType as PromoType,
    posBehavior,
    proposedStartDate,
    proposedEndDate,
    requestedGoLiveDate,
    priority: priority as PromoPriority,
    locationCodes
  });

  if (!result.ok) {
    return toActionResult(result, "");
  }

  // Invalidate the list + queue caches so the new promo shows up.
  revalidatePromoPaths({
    promoId: result.data.promo.id,
    includeList: true,
    includeQueue: true
  });

  return {
    ok: true,
    message: "Promo created",
    data: { promoId: result.data.promo.id }
  };
}
