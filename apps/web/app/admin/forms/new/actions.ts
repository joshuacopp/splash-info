// Brief 95 — server action for creating a new form.
//
// On success this lands the operator on the builder page (`/admin/forms/{id}`)
// rather than reporting inline, because the form they just created has no
// fields yet and the next thing they need is the field editor.
//
// IT DOES NOT CALL redirect() TO GET THERE, AND MUST NOT. Doing so cost ~20
// SECONDS: measured 2026-08-21 on this very page — 20.31s then 19.78s, status
// 303, against ~18ms of CPU. The form row was committed almost immediately;
// the wait was entirely Next.js answering the POST after a redirect throw.
// Returning `redirectTo` on the ok result instead lets <ActionForm> push it
// client-side, which is the same destination at normal speed.
//
// Validation failures still return `{ ok: false, error }` and render inline —
// that half was already correct and is untouched.

"use server";

import { createFormAdmin } from "../_lib/worker-fetch";
import type { ActionResult } from "../../_components/ActionForm";

export async function createFormAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const slug = String(formData.get("slug") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const audienceRaw = String(formData.get("audience") ?? "");

  if (!slug) return { ok: false, error: "Slug is required." };
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(slug)) {
    return {
      ok: false,
      error:
        "Slug must be lowercase, start with a letter, contain only letters/digits/hyphens, and be 2–64 chars."
    };
  }
  if (!title) return { ok: false, error: "Title is required." };
  if (
    audienceRaw !== "public" &&
    audienceRaw !== "internal" &&
    audienceRaw !== "link-only"
  ) {
    return { ok: false, error: "Audience must be public, internal, or link-only." };
  }
  const audience = audienceRaw as "public" | "internal" | "link-only";

  let formId: string;
  try {
    const res = await createFormAdmin({ slug, title, description, audience });
    formId = res.form_id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("slug_taken")) {
      return { ok: false, error: "A form with that slug already exists." };
    }
    if (msg.includes("403") || msg.includes("forbidden")) {
      return { ok: false, error: "You don't have permission to create forms." };
    }
    return { ok: false, error: msg };
  }

  // Returned, not thrown — so unlike the old redirect() this is safe to sit
  // inside or after the try/catch without the catch swallowing it.
  return {
    ok: true,
    message: "Form created.",
    redirectTo: `/admin/forms/${encodeURIComponent(formId)}`
  };
}
