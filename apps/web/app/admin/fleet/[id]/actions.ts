// Server action for /admin/fleet/[id] — Splash Notes + Status save
// (Brief 87 → widened in Brief 105).
//
// Brief 19 pattern: action returns ActionResult and lets <ActionForm>
// drive the post-action UX (inline banner + router.refresh()), instead
// of redirect()-based feedback that doesn't reliably propagate through
// OpenNext-on-Cloudflare-Workers.
//
// The fleet-inquiry-worker enforces auth + status-enum + length cap
// server-side. This action validates the status against the shared
// FLEET_STATUS_OPTIONS allow-list as defense-in-depth (so a malformed
// submission doesn't even reach the worker) and forwards both fields.

"use server";

import { revalidatePath } from "next/cache";
import { updateFleetSubmission } from "../_lib/worker-fetch";
import { isFleetStatus } from "../_lib/constants";
import type { ActionResult } from "../../_components/ActionForm";

export async function updateSubmissionAction(
  id: string,
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  if (!id) {
    return { ok: false, error: "Missing submission id." };
  }

  const rawNotes = formData.get("splash_notes");
  const rawStatus = formData.get("status");

  if (typeof rawNotes !== "string") {
    return { ok: false, error: "Invalid notes payload." };
  }
  if (typeof rawStatus !== "string" || !isFleetStatus(rawStatus)) {
    return { ok: false, error: "Invalid status value." };
  }

  try {
    await updateFleetSubmission(id, {
      splashNotes: rawNotes,
      status: rawStatus
    });
    revalidatePath(`/admin/fleet/${id}`);
    return { ok: true, message: "Saved." };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Save failed";
    return { ok: false, error: message };
  }
}
