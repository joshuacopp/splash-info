// Server action for /admin/fleet/[id] — Splash Notes save (Brief 87).
//
// Brief 19 pattern: action returns ActionResult and lets <ActionForm>
// drive the post-action UX (inline banner + router.refresh()), instead
// of redirect()-based feedback that doesn't reliably propagate through
// OpenNext-on-Cloudflare-Workers.
//
// The fleet-inquiry-worker enforces auth + length cap server-side; this
// action's only job is to forward the textarea value and translate the
// helper's throw/return into an ActionResult.

"use server";

import { revalidatePath } from "next/cache";
import { updateFleetSubmissionNotes } from "../_lib/worker-fetch";
import type { ActionResult } from "../../_components/ActionForm";

export async function updateSplashNotesAction(
  id: string,
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  if (!id) {
    return { ok: false, error: "Missing submission id." };
  }
  const raw = formData.get("splash_notes");
  if (typeof raw !== "string") {
    return { ok: false, error: "Invalid notes payload." };
  }

  try {
    await updateFleetSubmissionNotes(id, raw);
    revalidatePath(`/admin/fleet/${id}`);
    return { ok: true, message: "Notes saved." };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Save failed";
    return { ok: false, error: message };
  }
}
