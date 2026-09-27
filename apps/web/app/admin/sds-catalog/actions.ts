"use server";

// Catalogue curation. Every one of these is admin-tier and the WORKER enforces
// it -- nothing here decides who may write.

import { revalidatePath } from "next/cache";

import {
  createCatalogFromInventory,
  deleteSdsCatalogEntry,
  mergeSdsCatalogEntry,
  linkCatalogAlias,
  unlinkCatalogAlias,
  createSdsCatalogEntry,
  patchSdsCatalogEntry,
  setCatalogVerified
} from "../../sds/_lib/worker-fetch";
import type { MergeSummary } from "../../sds/_lib/worker-fetch";

export type SdsActionResult = { ok: true } | { ok: false; error: string };

function humanise(error: string): string {
  if (error.includes("admin_only") || error.includes("verified_entry_is_admin_only")) {
    return "Only a super admin or DC admin can change the shared catalogue.";
  }
  if (error.includes("source_verified")) {
    return "Withdraw the verified mark on this entry before merging it away.";
  }
  if (error.includes("same_entry")) {
    return "That's the same entry.";
  }
  if (error.includes("catalog_entry_in_use")) {
    return "A site still has this on its list, so it can't be deleted. Remove it from that site first, or edit this entry instead.";
  }
  if (error.includes("withdraw_verification_first")) {
    return "Withdraw the verified mark before deleting — deleting a verified entry should be a deliberate second step.";
  }
  if (error.includes("already_linked")) {
    return "That purchasing code is already linked to a chemical. Unlink it there first.";
  }
  if (error.includes("inventory_product_not_found")) {
    return "Inventory no longer has that product.";
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

/** Say that an inventory product is this chemical.
 *
 *  Deliberately one product at a time and never inferred: DS-FWW-CS and Flash
 *  Wax White share no characters, so only a person knows they are the same jug,
 *  and a wrong link hands somebody the wrong safety data sheet. */
export async function linkAliasAction(
  catalogId: string,
  sourceProductId: string
): Promise<SdsActionResult> {
  const res = await linkCatalogAlias(catalogId, sourceProductId);
  if (!res.ok) return { ok: false, error: humanise(res.error) };
  revalidateBoth();
  return { ok: true };
}

export async function unlinkAliasAction(
  catalogId: string,
  sourceProductId: string
): Promise<SdsActionResult> {
  const res = await unlinkCatalogAlias(catalogId, sourceProductId);
  if (!res.ok) return { ok: false, error: humanise(res.error) };
  revalidateBoth();
  return { ok: true };
}

export async function deleteCatalogEntryAction(
  id: string
): Promise<SdsActionResult> {
  const res = await deleteSdsCatalogEntry(id);
  if (!res.ok) return { ok: false, error: humanise(res.error) };
  revalidateBoth();
  return { ok: true };
}

/**
 * Fold a duplicate entry into the correct one.
 *
 * Returns the counts because a merge moves things the operator cannot see from
 * the row -- "2 codes and 1 site moved" is how they confirm they merged the
 * pair they meant to.
 */
export async function mergeCatalogAction(
  sourceId: string,
  targetId: string
): Promise<
  | { ok: true; summary: MergeSummary }
  | { ok: false; error: string }
> {
  const res = await mergeSdsCatalogEntry(sourceId, targetId);
  if (!res.ok) return { ok: false, error: humanise(res.error) };
  revalidateBoth();
  return { ok: true, summary: res.data };
}
