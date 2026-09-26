"use server";

// Write surface for the SDS binder index.
//
// Every one of these is re-authorised by the worker against the caller's own
// site access -- nothing here decides who may write. These exist so the page's
// client islands have something to call, and to revalidate afterwards.

import { revalidatePath } from "next/cache";

import {
  createSdsItem,
  markSdsReviewed,
  patchSdsItem,
  seedSdsFromInventory
} from "./_lib/worker-fetch";

export type SdsActionResult = { ok: true } | { ok: false; error: string };

/** Turn the worker's error codes into something a site manager can act on.
 *  An unmapped code falls through verbatim rather than becoming "Something
 *  went wrong", which tells nobody anything. */
function humanise(error: string): string {
  if (error.includes("duplicate_active_item")) {
    return "That chemical is already on this site's list for that area.";
  }
  if (error.includes("product_identifier_required")) {
    return "Enter the product name exactly as it appears on the safety data sheet.";
  }
  if (error.includes("forbidden") || error.includes("no_accessible_locations")) {
    return "You don't have access to this site.";
  }
  if (error.includes("not_found")) {
    return "That entry no longer exists — refresh the page.";
  }
  return error;
}

export async function addChemicalAction(input: {
  location_code: string;
  product_identifier: string;
  manufacturer: string | null;
  work_area: string | null;
  binder_tab: string | null;
}): Promise<SdsActionResult> {
  const res = await createSdsItem(input);
  if (!res.ok) return { ok: false, error: humanise(res.error) };
  revalidatePath("/sds");
  return { ok: true };
}

export async function updateChemicalAction(
  id: string,
  patch: {
    product_identifier?: string;
    manufacturer?: string | null;
    work_area?: string | null;
    binder_tab?: string | null;
    source_url?: string | null;
    sds_revision_date?: string | null;
  }
): Promise<SdsActionResult> {
  const res = await patchSdsItem(id, patch);
  if (!res.ok) return { ok: false, error: humanise(res.error) };
  revalidatePath("/sds");
  return { ok: true };
}

/** Soft: the row stays with the date it left. Restoring is the same call with
 *  `active: true`, which is why this is not named "delete". */
export async function setChemicalActiveAction(
  id: string,
  active: boolean
): Promise<SdsActionResult> {
  const res = await patchSdsItem(id, { is_active: active });
  if (!res.ok) return { ok: false, error: humanise(res.error) };
  revalidatePath("/sds");
  return { ok: true };
}

export async function seedFromInventoryAction(
  locationCode: string,
  productIds: string[]
): Promise<SdsActionResult> {
  const res = await seedFromInventorySafe(locationCode, productIds);
  if (!res.ok) return { ok: false, error: humanise(res.error) };
  revalidatePath("/sds");
  return { ok: true };
}

async function seedFromInventorySafe(locationCode: string, productIds: string[]) {
  if (productIds.length === 0) {
    return { ok: false as const, error: "Pick at least one chemical to add." };
  }
  return seedSdsFromInventory(locationCode, productIds);
}

export async function markReviewedAction(
  locationCode: string
): Promise<SdsActionResult> {
  const res = await markSdsReviewed(locationCode);
  if (!res.ok) return { ok: false, error: humanise(res.error) };
  revalidatePath("/sds");
  return { ok: true };
}
