// Brief 128 — server actions for retry / abandon on the email queue.
//
// Uses the Brief 19 <ActionForm> pattern: each action returns a
// serializable ActionResult, and the client wrapper drives the post-action
// UX via router.refresh() + revalidatePath().

"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../_components/ActionForm";
import {
  abandonEmailQueueAdmin,
  retryEmailQueueAdmin
} from "../forms/_lib/worker-fetch";

export async function retryEmailQueueAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = formData.get("id");
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Missing row id." };
  }
  try {
    await retryEmailQueueAdmin(id);
    revalidatePath("/admin/email-queue");
    revalidatePath(`/admin/email-queue/${id}`);
    return {
      ok: true,
      message: "Row reset. Next PA poll will pick it up."
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function abandonEmailQueueAction(
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = formData.get("id");
  const confirm = formData.get("confirm");
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Missing row id." };
  }
  if (confirm !== "yes") {
    return {
      ok: false,
      error: "Abandon requires explicit confirmation."
    };
  }
  try {
    await abandonEmailQueueAdmin(id);
    revalidatePath("/admin/email-queue");
    revalidatePath(`/admin/email-queue/${id}`);
    return {
      ok: true,
      message: "Row abandoned. It will never send."
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
