// Brief 158b — material upload + delete server actions.
//
// Upload is multipart — the action streams the FormData straight to the
// worker which sniffs MIME, writes R2, inserts the row, and logs.
// Delete is JSON; row-then-R2 sequence per Brief 156.

"use server";

import {
  uploadPromoMaterial,
  deletePromoMaterial
} from "../_lib/worker-fetch";
import {
  toActionResult,
  revalidatePromoPaths
} from "../_lib/action-helpers";
import type { ActionResult } from "../../_components/ActionForm";

const MATERIAL_KINDS = [
  "image",
  "video",
  "copy_messaging",
  "signage",
  "email_asset",
  "other"
] as const;

const FILE_SIZE_MAX_BYTES = 50 * 1024 * 1024;

function asString(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

export async function uploadMaterialAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const promoId = asString(formData.get("promoId")).trim();
  if (!promoId) {
    return { ok: false, error: "Missing promo id." };
  }

  const name = asString(formData.get("name")).trim();
  const kind = asString(formData.get("kind")).trim();
  const file = formData.get("file");

  if (!name) {
    return { ok: false, error: "Material name is required." };
  }
  if (!(MATERIAL_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: "Pick a material kind." };
  }
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Pick a file to upload." };
  }
  if (file.size > FILE_SIZE_MAX_BYTES) {
    return { ok: false, error: "File exceeds the 50 MB limit." };
  }

  // Re-pack the FormData with ONLY the fields the worker reads. Keeps the
  // wire payload clean and drops any extra hidden inputs from the form
  // (e.g. promoId, which the worker reads from the URL path instead).
  const wire = new FormData();
  wire.append("name", name);
  wire.append("kind", kind);
  wire.append("file", file, file.name);

  const result = await uploadPromoMaterial(promoId, wire);
  if (!result.ok) {
    return toActionResult(result, "");
  }

  revalidatePromoPaths({ promoId, includeList: false, includeQueue: false });
  return {
    ok: true,
    message: `Uploaded "${result.data.material.name}".`,
    data: { materialId: result.data.material.id }
  };
}

export async function deleteMaterialAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const promoId = asString(formData.get("promoId")).trim();
  const materialId = asString(formData.get("materialId")).trim();
  if (!promoId) return { ok: false, error: "Missing promo id." };
  if (!materialId) return { ok: false, error: "Missing material id." };

  const result = await deletePromoMaterial(promoId, materialId);
  if (!result.ok) {
    return toActionResult(result, "");
  }
  revalidatePromoPaths({ promoId, includeList: false, includeQueue: false });
  return { ok: true, message: "Material removed." };
}
