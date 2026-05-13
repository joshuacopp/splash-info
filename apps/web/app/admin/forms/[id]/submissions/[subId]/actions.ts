// Brief 96 — server action for the submission detail page.
//
// Brief 19 pattern: action returns ActionResult and lets <ActionForm>
// drive the post-action UX. The worker enforces auth + length cap +
// status enum validation server-side; this action's only job is to
// forward both fields and translate any error into an ActionResult.
//
// last-write-wins on both splash_notes and status — same posture as
// fleet (Brief 87) extended with the status enum that's specific to
// form_submissions.

"use server";

import { revalidatePath } from "next/cache";
import {
  updateSubmissionAdmin,
  transitionSubmissionAdmin
} from "../../../_lib/worker-fetch";
import type { SubmissionStatus } from "../../../_lib/worker-fetch";
import type { ActionResult } from "../../../../_components/ActionForm";

const STATUS_VALUES: readonly SubmissionStatus[] = [
  "new",
  "in_progress",
  "closed"
];

export async function updateSubmissionAction(
  formId: string,
  subId: string,
  _prevState: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  if (!formId || !subId) {
    return { ok: false, error: "Missing form or submission id." };
  }

  const rawNotes = formData.get("splash_notes");
  const rawStatus = formData.get("status");

  const patch: { splash_notes?: string; status?: SubmissionStatus } = {};

  if (typeof rawNotes === "string") {
    patch.splash_notes = rawNotes;
  }
  if (typeof rawStatus === "string" && rawStatus !== "") {
    if (!STATUS_VALUES.includes(rawStatus as SubmissionStatus)) {
      return { ok: false, error: `Unknown status: ${rawStatus}` };
    }
    patch.status = rawStatus as SubmissionStatus;
  }

  if (patch.splash_notes === undefined && patch.status === undefined) {
    return { ok: false, error: "Nothing to save." };
  }

  try {
    await updateSubmissionAdmin(formId, subId, patch);
    revalidatePath(`/admin/forms/${formId}/submissions/${subId}`);
    return { ok: true, message: "Saved." };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Save failed";
    return { ok: false, error: message };
  }
}

// =============================================================================
// Brief 120 — workflow transition server action
// =============================================================================

export async function transitionAction(
  formId: string,
  subId: string,
  toStageId: string,
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  if (!formId || !subId || !toStageId) {
    return { ok: false, error: "Missing form / submission / stage id." };
  }
  const note = formData.get("note");
  const typed = formData.get("typed_name");
  const sig = formData.get("signature_r2_key");

  const body: {
    to: string;
    note?: string;
    typed_name?: string;
    signature_r2_key?: string;
  } = { to: toStageId };
  if (typeof note === "string" && note.trim()) body.note = note.trim();
  if (typeof typed === "string" && typed.trim()) body.typed_name = typed.trim();
  if (typeof sig === "string" && sig.trim()) body.signature_r2_key = sig.trim();

  try {
    const res = await transitionSubmissionAdmin(formId, subId, body);
    if ("ok" in res && res.ok === true) {
      revalidatePath(`/admin/forms/${formId}/submissions/${subId}`);
      return { ok: true, message: `Stage advanced to "${res.to}".` };
    }
    let msg = res.error;
    if (res.error === "not_approver" && res.allowed_emails) {
      msg = `You are not on this stage's approver list. Allowed: ${res.allowed_emails.join(
        ", "
      )}`;
    } else if (res.error === "missing_required" && res.missing) {
      msg = `Missing required fields: ${res.missing.join(", ")}`;
    }
    return { ok: false, error: msg };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transition failed";
    return { ok: false, error: message };
  }
}
