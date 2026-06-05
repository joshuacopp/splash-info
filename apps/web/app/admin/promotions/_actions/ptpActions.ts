// Brief 158b — PTP (Purpose / Tools / Process) upsert server action.
//
// Three textareas → PUT /promo/api/promos/{id}/ptp. Worker upserts (insert
// on first save, update on subsequent), stamps updated_by, and emits the
// `ptp_updated` activity with a `details.fields = [...]` summary listing
// whichever of {purpose, tools, process} changed.

"use server";

import { putPromoPtp } from "../_lib/worker-fetch";
import {
  toActionResult,
  revalidatePromoPaths
} from "../_lib/action-helpers";
import type { ActionResult } from "../../_components/ActionForm";

const FIELD_MAX_LEN = 10_000;

function asString(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

export async function putPtpAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const promoId = asString(formData.get("promoId")).trim();
  if (!promoId) return { ok: false, error: "Missing promo id." };

  const purpose = asString(formData.get("purpose"));
  const tools = asString(formData.get("tools"));
  const process = asString(formData.get("process"));

  if (
    purpose.length > FIELD_MAX_LEN ||
    tools.length > FIELD_MAX_LEN ||
    process.length > FIELD_MAX_LEN
  ) {
    return { ok: false, error: "Each field is limited to 10,000 characters." };
  }

  const result = await putPromoPtp(promoId, {
    purpose: purpose.trim(),
    tools: tools.trim(),
    process: process.trim()
  });
  if (!result.ok) {
    return toActionResult(result, "");
  }

  revalidatePromoPaths({ promoId, includeList: false, includeQueue: false });
  return { ok: true, message: "PTP saved." };
}
