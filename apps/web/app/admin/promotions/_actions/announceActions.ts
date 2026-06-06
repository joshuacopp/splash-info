// Brief 158b — announcement send server action.
// Brief 160 — extended with per-material inline-vs-attachment toggle
// (`materialMode[{id}]=inline|attachment` FormData entries) and a sibling
// `previewAnnouncementAction` that calls the preview endpoint without
// snapshotting or fanning out.
//
// Reads the compose modal's FormData (recipients are CSV via a hidden
// field; selected materials are an array of checkbox values), validates
// shape, calls the worker. On success the result's `data` field carries
// the failedRecipients[] list so the client modal can show an amber
// "delivered with N failures" sub-banner.

"use server";

import {
  sendPromoAnnouncement,
  previewPromoAnnouncement
} from "../_lib/worker-fetch";
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

interface ParsedComposeForm {
  promoId: string;
  subject: string;
  bodyText: string;
  recipientList: string[];
  selectedMaterialIds: string[];
  materialModes: Record<string, "inline" | "attachment">;
  includePtp: boolean;
}

interface ParseOk {
  ok: true;
  parsed: ParsedComposeForm;
}
interface ParseErr {
  ok: false;
  error: string;
}

function parseComposeForm(
  formData: FormData,
  opts: { recipientsRequired: boolean }
): ParseOk | ParseErr {
  const promoId = asString(formData.get("promoId")).trim();
  if (!promoId) return { ok: false, error: "Missing promo id." };

  const subject = asString(formData.get("subject")).trim();
  const bodyText = asString(formData.get("bodyText"));
  const recipientsRaw = asString(formData.get("recipientEmails"));
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
  if (opts.recipientsRequired && recipientList.length === 0) {
    return { ok: false, error: "Add at least one recipient." };
  }
  const invalid = recipientList.filter((r) => !isValidEmail(r));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Invalid email${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`
    };
  }

  const selectedMaterialIds = formData
    .getAll("selectedMaterialId")
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((s) => s.length > 0);

  // Brief 160 — per-material inline-vs-attachment toggle. FormData entries
  // come through as `materialMode[{materialId}]` with value "inline" or
  // "attachment". Only entries whose materialId is in selectedMaterialIds
  // get passed through (avoids the worker tolerating stale entries).
  const materialModes: Record<string, "inline" | "attachment"> = {};
  const selected = new Set(selectedMaterialIds);
  for (const [key, value] of formData.entries()) {
    const m = key.match(/^materialMode\[(.+)\]$/);
    if (!m || !m[1]) continue;
    const id = m[1];
    if (!selected.has(id)) continue;
    if (value === "inline" || value === "attachment") {
      materialModes[id] = value;
    }
  }

  return {
    ok: true,
    parsed: {
      promoId,
      subject,
      bodyText,
      recipientList,
      selectedMaterialIds,
      materialModes,
      includePtp
    }
  };
}

export async function sendAnnouncementAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const parsed = parseComposeForm(formData, { recipientsRequired: true });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const p = parsed.parsed;

  const result = await sendPromoAnnouncement(p.promoId, {
    subject: p.subject,
    bodyText: p.bodyText,
    recipientEmails: p.recipientList,
    selectedMaterialIds:
      p.selectedMaterialIds.length > 0 ? p.selectedMaterialIds : undefined,
    includePtp: p.includePtp,
    materialModes: Object.keys(p.materialModes).length > 0 ? p.materialModes : undefined
  });

  if (!result.ok) {
    return toActionResult(result, "");
  }

  revalidatePromoPaths({ promoId: p.promoId, includeList: false, includeQueue: false });

  const { enqueuedCount, failedRecipients } = result.data;
  return {
    ok: true,
    message: `Announcement enqueued to ${enqueuedCount} recipient${enqueuedCount === 1 ? "" : "s"}.`,
    data: { failedRecipients }
  };
}

/**
 * Brief 160 — preview server action.
 *
 * Calls `/announce/preview` instead of `/announce`. No snapshot, no
 * fan-out, no activity log. Returns the rendered HTML + plain text +
 * attachment summary in `data` so the modal can open a sub-modal with
 * the iframe.
 */
export async function previewAnnouncementAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const parsed = parseComposeForm(formData, { recipientsRequired: false });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const p = parsed.parsed;

  const result = await previewPromoAnnouncement(p.promoId, {
    subject: p.subject,
    bodyText: p.bodyText,
    recipientEmails: p.recipientList.length > 0 ? p.recipientList : undefined,
    selectedMaterialIds:
      p.selectedMaterialIds.length > 0 ? p.selectedMaterialIds : undefined,
    includePtp: p.includePtp,
    materialModes: Object.keys(p.materialModes).length > 0 ? p.materialModes : undefined
  });

  if (!result.ok) {
    return toActionResult(result, "");
  }

  return {
    ok: true,
    message: "Preview rendered.",
    data: {
      html: result.data.html,
      plainText: result.data.plain_text,
      attachmentSummary: result.data.attachment_summary
    }
  };
}
