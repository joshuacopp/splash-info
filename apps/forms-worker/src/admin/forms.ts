// Brief 94 — admin form CRUD handlers.
//
// Routes (mounted in src/index.ts):
//
//   GET    /forms/admin/api/forms                  → handleListForms
//   POST   /forms/admin/api/forms                  → handleCreateForm
//   GET    /forms/admin/api/forms/{id}             → handleGetForm
//   PATCH  /forms/admin/api/forms/{id}/draft       → handleUpdateDraft
//   POST   /forms/admin/api/forms/{id}/publish     → handlePublish
//   POST   /forms/admin/api/forms/{id}/unpublish   → handleStatusChange("archived")
//   POST   /forms/admin/api/forms/{id}/republish   → handleStatusChange("published")
//
// Auth gate (super_admin or dcRole admin/super_admin) lives in ./auth.ts;
// service-key-unbound 503 is returned uniformly. Mutations also gate on
// `isOriginAllowed` (CSRF defense-in-depth).
//
// Schema validation is split per planning Decision 1 (B-classic draft/published
// lifecycle). Drafts are saved against the lenient `draftFormSchemaSchema`
// from @splash/forms-schema (allows work-in-progress Lookup/Image fields whose
// default config seeds empty strings the strict schema would reject). Publish
// re-validates the same draft against the strict `formSchemaSchema` — same
// Zod boundary that protects the public render path in
// `db/forms.ts:getCurrentVersion` — and refuses to promote anything the
// renderer would reject. Net: operators can save drafts mid-build; the
// rendered public form is always strictly valid.

import { isOriginAllowed, jsonError } from "@splash/http";
import { draftFormSchemaSchema, formSchemaSchema } from "@splash/forms-schema";
import { adminGate, adminGateResponse, requireServiceKey } from "./auth.js";
import {
  listForms,
  createForm,
  getFormDetail,
  getDraftSchema,
  updateDraft,
  publishDraft,
  setFormStatus,
  type ListFormsFilter
} from "../db/admin-forms.js";
import type { Env } from "../index.js";

const FORM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,80}$/;

export async function handleListForms(env: Env, req: Request): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  const url = new URL(req.url);
  const filter: ListFormsFilter = {};
  const status = url.searchParams.get("status");
  const search = url.searchParams.get("search");
  if (status) filter.status = status;
  if (search) filter.search = search;

  try {
    const items = await listForms(env, filter);
    return new Response(JSON.stringify({ items }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    });
  } catch (err) {
    console.error("[forms.admin] list failed", err);
    return jsonError(500, "list_failed");
  }
}

export async function handleCreateForm(env: Env, req: Request): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  let body: {
    slug?: unknown;
    title?: unknown;
    description?: unknown;
    audience?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json");
  }

  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const audience = typeof body.audience === "string" ? body.audience : "";
  const description =
    typeof body.description === "string" && body.description.trim() !== ""
      ? body.description.trim()
      : null;

  if (!SLUG_RE.test(slug)) {
    return jsonError(
      400,
      "invalid_slug: must be 3–81 chars, lowercase alphanum + hyphen, leading non-hyphen"
    );
  }
  if (!title) return jsonError(400, "title_required");
  if (audience !== "public" && audience !== "internal" && audience !== "link-only") {
    return jsonError(400, "audience_required: must be public, internal, or link-only");
  }

  try {
    const created = await createForm(env, {
      slug,
      title,
      description,
      audience,
      createdBy: gate.session.userId
    });
    return new Response(
      JSON.stringify({
        form_id: created.formId,
        draft_version_id: created.draftVersionId
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (err) {
    if (err instanceof Error && err.message === "slug_taken") {
      return jsonError(409, "slug_taken");
    }
    console.error("[forms.admin] create failed", err);
    return jsonError(500, "create_failed");
  }
}

export async function handleGetForm(
  env: Env,
  req: Request,
  formId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId)) {
    return jsonError(400, "bad_id");
  }

  try {
    const detail = await getFormDetail(env, formId);
    if (!detail) return jsonError(404, "not_found");
    return new Response(JSON.stringify(detail), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    });
  } catch (err) {
    console.error("[forms.admin] get failed", err);
    return jsonError(500, "get_failed");
  }
}

export async function handleUpdateDraft(
  env: Env,
  req: Request,
  formId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId)) {
    return jsonError(400, "bad_id");
  }

  let body: { schema?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json");
  }

  const result = draftFormSchemaSchema.safeParse(body.schema);
  if (!result.success) {
    return new Response(
      JSON.stringify({ error: "schema_invalid", issues: result.error.issues }),
      {
        status: 422,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  try {
    await updateDraft(env, formId, result.data, gate.session.userId);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    if (err instanceof Error && err.message === "no_draft") {
      return jsonError(404, "no_draft");
    }
    console.error("[forms.admin] update draft failed", err);
    return jsonError(500, "update_failed");
  }
}

export async function handlePublish(
  env: Env,
  req: Request,
  formId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId)) {
    return jsonError(400, "bad_id");
  }

  // Strict re-validation gate. Drafts pass through `draftFormSchemaSchema`
  // (lenient — allows incomplete Lookup / Image fields). Public render uses
  // `formSchemaSchema` (strict). Publish must enforce the strict contract,
  // otherwise a half-configured field promoted to current_version_id would
  // 500 the renderer's `formSchemaSchema.safeParse` boundary check.
  let draftSchema: unknown;
  try {
    draftSchema = await getDraftSchema(env, formId);
  } catch (err) {
    console.error("[forms.admin] publish: draft schema fetch failed", err);
    return jsonError(500, "publish_failed");
  }
  if (draftSchema === null) {
    return jsonError(404, "no_draft");
  }
  const strictResult = formSchemaSchema.safeParse(draftSchema);
  if (!strictResult.success) {
    return new Response(
      JSON.stringify({ error: "schema_invalid", issues: strictResult.error.issues }),
      {
        status: 422,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  try {
    const result = await publishDraft(env, formId, gate.session.userId);
    return new Response(
      JSON.stringify({
        published_version_number: result.versionNumber,
        new_draft_id: result.newDraftId
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (err) {
    if (err instanceof Error && (err.message === "no_draft" || err.message === "draft_invalid")) {
      return jsonError(404, err.message);
    }
    console.error("[forms.admin] publish failed", err);
    return jsonError(500, "publish_failed");
  }
}

export async function handleStatusChange(
  env: Env,
  req: Request,
  formId: string,
  target: "published" | "archived"
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId)) {
    return jsonError(400, "bad_id");
  }

  try {
    await setFormStatus(env, formId, target, gate.session.userId);
    return new Response(JSON.stringify({ ok: true, status: target }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("[forms.admin] status change failed", err);
    return jsonError(500, "status_change_failed");
  }
}
