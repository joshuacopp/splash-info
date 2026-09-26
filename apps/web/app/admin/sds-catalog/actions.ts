"use server";

// Catalogue curation. Every one of these is admin-tier and the WORKER enforces
// it -- nothing here decides who may write.

import { revalidatePath } from "next/cache";

import {
  createCatalogFromInventory,
  createSdsCatalogEntry,
  patchSdsCatalogEntry,
  setCatalogVerified
} from "../../sds/_lib/worker-fetch";

export type SdsActionResult = { ok: true } | { ok: false; error: string };

function humanise(error: string): string {
  if (error.includes("admin_only") || error.includes("verified_entry_is_admin_only")) {
    return "Only a super admin or DC admin can change the shared catalogue.";
  }
  if (error.includes("product_identifier_required")) {
    return "Enter the product name exactly as it appears on the safety data sheet.";
  }
  return error;
}

/** Both surfaces touch the catalogue, so both are stale after a write. */
function revalidateBoth() {
  revalidatePath("/admin/sds-catalog");
  revalidatePath("/sds");
}

export async function createCatalogEntryAction(input: {
  product_identifier: string;
  manufacturer: string | null;
}): Promise<SdsActionResult> {
  const res = await createSdsCatalogEntry(input);
  if (!res.ok) return { ok: false, error: humanise(res.error) };
  revalidateBoth();
  return { ok: true };
}

export async function patchCatalogEntryAction(
  id: string,
  patch: {
    product_identifier?: string;
    manufacturer?: string | null;
    source_url?: string | null;
    sds_revision_date?: string | null;
  }
): Promise<SdsActionResult> {
  const res = await patchSdsCatalogEntry(id, patch);
  if (!res.ok) return { ok: false, error: humanise(res.error) };
  revalidateBoth();
  return { ok: true };
}

export async function verifyCatalogAction(
  id: string,
  verified: boolean
): Promise<SdsActionResult> {
  const res = await setCatalogVerified(id, verified);
  if (!res.ok) return { ok: false, error: humanise(res.error) };
  revalidateBoth();
  return { ok: true };
}

/** Stock the catalogue from inventory's own product names. Returns how many
 *  entries were created so the caller can say something true -- picking five
 *  products of which three already existed creates two. */
export async function addFromInventoryAction(
  productIds: string[]
): Promise<{ ok: true; created: number } | { ok: false; error: string }> {
  const res = await createCatalogFromInventory(productIds);
  if (!res.ok) return { ok: false, error: humanise(res.error) };
  revalidateBoth();
  return { ok: true, created: res.data.created };
}
