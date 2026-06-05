// Brief 158b — announcement send server action.
//
// Reads the compose modal's FormData (recipients are CSV via a hidden
// field; selected materials are an array of checkbox values), validates
// shape, calls the worker. On success the result's `data` field carries
// the failedRecipients[] list so the client modal can show an amber
// "delivered with N failures" sub-banner.

"use server";

import { sendPromoAnnouncement } from "../_lib/worker-fetch";
import {
  toActionResult,
  revalidatePromoPaths
} from "../_lib/action-helpers";
import { isValidEmail } from "@splash/types/email-validate";
import type { ActionResult } from "../../_components/ActionForm";

const SUBJECT_MAX_LEN = 500;
const BODY_MAX_LEN = 50_000;

function asString(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

export async function sendAnnouncementAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const promoId = asString(formData.get("promoId")).trim();
  if (!promoId) return { ok: false, error: "Missing promo id." };

  const subject = asString(formData.get("subject")).trim();
  const bodyText = asString(formData.get("bodyText"));
  const recipientsRaw = asString(formData.get("recipientEmails")); // comma-separated
  const includePtp = formData.get("includePtp") === "1";

  if (!subject) return { ok: false, error: "Subject is required." };
  if (subject.length > SUBJECT_MAX_LEN) {
    return { ok: false, error: "Subject is too long." };
  }
  if (!bodyText || bodyText.trim().length === 0) {
    return { ok: false, error: "Body is required." };
  }
  if (bodyText.length > BODY_MAX_LEN) {
    return { ok: false, error: "Body exceeds the 50,000-character limit." };
  }

  const recipientList = recipientsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (recipientList.length === 0) {
    return { ok: false, error: "Add at least one recipient." };
  }
  const invalid = recipientList.filter((r) => !isValidEmail(r));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Invalid email${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`
    };
  }

  // selectedMaterialIds — every form field with name="selectedMaterialId"
  const selectedMaterialIds = formData
    .getAll("selectedMaterialId")
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((s) => s.length > 0);

  const result = await sendPromoAnnouncement(promoId, {
    subject,
    bodyText,
    recipientEmails: recipientList,
    selectedMaterialIds:
      selectedMaterialIds.length > 0 ? selectedMaterialIds : undefined,
    includePtp
  });

  if (!result.ok) {
    return toActionResult(result, "");
  }

  revalidatePromoPaths({ promoId, includeList: false, includeQueue: false });

  const { enqueuedCount, failedRecipients } = result.data;
  return {
    ok: true,
    message: `Announcement enqueued to ${enqueuedCount} recipient${enqueuedCount === 1 ? "" : "s"}.`,
    data: { failedRecipients }
  };
}
