// Server actions for /admin/performance.
//
// Single write surface in v1: createSubmissionAction — POST
// /pertrack/api/submissions (JSON body). Edit / delete are out of scope
// (worker doesn't expose endpoints).
//
// Pattern mirrors the damage server actions (5c/5d):
//   1. Pull form fields from FormData. The form uses checkbox + text
//      inputs; we coerce gm_on_site / agm_on_site to explicit booleans
//      and pass numerics through as strings (the worker's
//      apiCreateSubmission re-coerces via toNumOrNull / toIntOrNull).
//   2. Forward as JSON to performancePostJson.
//   3. On worker error: return ?action_error=<encoded>.
//   4. On success: revalidatePath the list, then return ?success=1 so the
//      page renders the success banner once.
//
// NOTHING HERE CALLS redirect(), AND NOTHING HERE MAY. It returns
// `{ redirectTo }` and <RedirectForm> pushes it from the client. A redirect()
// inside a server action costs ~20 seconds of wall time under OpenNext on
// Cloudflare against ~18ms of CPU — measured 2026-08-21 across three unrelated
// features. The URLs below are byte-for-byte the ones redirect() used to be
// handed, so the page's banner handling is untouched; only the transport
// changed.

"use server";

import { revalidatePath } from "next/cache";
import { performancePostJson } from "./_lib/worker-fetch";
import type { RedirectResult } from "../_components/RedirectForm";

const LIST_PATH = "/admin/performance";

function strField(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function strOrNull(formData: FormData, name: string): string | null {
  const s = strField(formData, name);
  return s ? s : null;
}

function checkboxBool(formData: FormData, name: string): boolean {
  const v = formData.get(name);
  return v === "on" || v === "true" || v === "1";
}

export async function createSubmissionAction(
  formData: FormData
): Promise<RedirectResult> {
  const locationId = strField(formData, "location_id");
  if (!locationId) {
    // `return`, not a bare call. The old redirect() threw, so control never
    // reached the write; a returning bail-out only works if the caller
    // actually returns it.
    return {
      redirectTo: `${LIST_PATH}?action_error=${encodeURIComponent(
        "Pick a location before saving."
      )}`
    };
  }

  // Coerce visit_at: <input type="datetime-local"> emits "YYYY-MM-DDTHH:mm"
  // (no timezone). The worker's apiCreateSubmission stringOr's it directly
  // into the row; Supabase happily accepts the local timestamp string.
  // Empty visit_at falls through to the worker's `new Date().toISOString()`
  // default.
  const visitAt = strField(formData, "visit_at");

  // Numerics + free-text fields pass through to the worker, which does its
  // own coercion (toNumOrNull, toIntOrNull, trimOrNull).
  const body: Record<string, unknown> = {
    visit_at: visitAt || undefined,
    location_id: locationId,
    capture_rate: strOrNull(formData, "capture_rate"),
    opportunities: strOrNull(formData, "opportunities"),
    greeter_1_name: strOrNull(formData, "greeter_1_name"),
    greeter_2_name: strOrNull(formData, "greeter_2_name"),
    greeter_3_name: strOrNull(formData, "greeter_3_name"),
    greeter_1_shift_start: strOrNull(formData, "greeter_1_shift_start"),
    greeter_1_shift_end: strOrNull(formData, "greeter_1_shift_end"),
    greeter_2_shift_start: strOrNull(formData, "greeter_2_shift_start"),
    greeter_2_shift_end: strOrNull(formData, "greeter_2_shift_end"),
    greeter_3_shift_start: strOrNull(formData, "greeter_3_shift_start"),
    greeter_3_shift_end: strOrNull(formData, "greeter_3_shift_end"),
    gm_on_site: checkboxBool(formData, "gm_on_site"),
    gm_name: strOrNull(formData, "gm_name"),
    agm_on_site: checkboxBool(formData, "agm_on_site"),
    agm_name: strOrNull(formData, "agm_name"),
    comments: strOrNull(formData, "comments")
  };

  const result = await performancePostJson("/pertrack/api/submissions", body);

  if (!result.ok) {
    return {
      redirectTo: `${LIST_PATH}?action_error=${encodeURIComponent(result.error)}`
    };
  }

  revalidatePath(LIST_PATH);
  return { redirectTo: `${LIST_PATH}?success=1` };
}
