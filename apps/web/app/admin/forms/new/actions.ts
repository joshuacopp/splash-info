// Brief 95 — server action for creating a new form.
//
// On success, redirects directly to the builder page (`/admin/forms/{id}`)
// instead of returning ok=true. The Brief 19 redirect-vs-result caveat
// applies to actions that should give in-page feedback while staying on the
// same route — create-and-jump-to-detail is a different use case (similar to
// /admin/sysadmin Add Location's flow, which does redirect on success).

"use server";

import { redirect } from "next/navigation";

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

  // Redirect after the try/catch so Next.js's redirect throw isn't swallowed.
  redirect(`/admin/forms/${encodeURIComponent(formId)}`);
}
