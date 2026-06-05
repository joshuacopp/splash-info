// Brief 158b — promo status PATCH server action.
//
// Lives on the live view (status pipeline card) and the IT ticket page
// header. Worker re-validates role + enum. When the worker returns
// `{ unchanged: true }` the action surfaces a quiet "Status unchanged"
// success — Phase 3 of the brief explicitly suppresses the noisy banner
// in this case.

"use server";

import { patchPromoStatus } from "../_lib/worker-fetch";
import {
  toActionResult,
  revalidatePromoPaths
} from "../_lib/action-helpers";
import type { ActionResult } from "../../_components/ActionForm";
import type { PromoStatus } from "../_lib/types";
import { PROMO_STATUSES } from "../_lib/types";

function asString(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

export async function setPromoStatusAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const promoId = asString(formData.get("promoId")).trim();
  const statusRaw = asString(formData.get("status")).trim();

  if (!promoId) {
    return { ok: false, error: "Missing promo id." };
  }
  if (!(PROMO_STATUSES as readonly string[]).includes(statusRaw)) {
    return { ok: false, error: "Pick a valid status." };
  }
  const status = statusRaw as PromoStatus;

  const result = await patchPromoStatus(promoId, status);
  if (!result.ok) {
    return toActionResult(result, "");
  }

  revalidatePromoPaths({ promoId, includeList: true, includeQueue: true });

  if (result.data.unchanged) {
    return { ok: true, message: "Status unchanged" };
  }
  return { ok: true, message: `Status set to ${result.data.status}` };
}
