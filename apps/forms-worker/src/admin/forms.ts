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
import {
  draftFormSchemaSchema,
  formSchemaSchema,
  type FormSchema
} from "@splash/forms-schema";
import {
  adminGate,
  adminGateResponse,
  submissionGate,
  requireServiceKey
} from "./auth.js";
import {
  listForms,
  createForm,
  getFormDetail,
  getDraftSchema,
  updateDraft,
  publishDraft,
  setFormStatus,
  getFormScopingContext,
  setFormScopeFieldKey,
  type ListFormsFilter
} from "../db/admin-forms.js";
import type { Env } from "../index.js";

const FORM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,80}$/;

// Key used for the auto-injected location-scoping field. Matches the field-key
// grammar (/^[a-z][a-z0-9_]*$/) and is stable/predictable so operators can
// recognise it. See handlePublish's scope-injection step.
const SCOPE_FIELD_KEY = "site_number";

/** 8-char lowercase-alphanumeric id, matching the builder's `nanoid(8)` shape. */
function randomFieldId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

export async function handleListForms(env: Env, req: Request): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  // submissionGate (not adminGate): this endpoint backs the submissions index,
  // which location admins may read. Full admins get scope "all" (unchanged
  // behaviour). Location admins get their location set, which scopes the
  // embedded submission counts AND hides unscoped forms (db listForms). The
  // form BUILDER list is a separate web page that keeps its own super_admin /
  // dc-admin role gate, so widening this endpoint doesn't expose the builder.
  const gate = await submissionGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  const url = new URL(req.url);
  const filter: ListFormsFilter = {};
  const status = url.searchParams.get("status");
  const search = url.searchParams.get("search");
  const audience = url.searchParams.get("audience");
  if (status) filter.status = status;
  if (search) filter.search = search;
  const ALLOWED_AUDIENCE = ["public", "internal", "link-only", "all"];
  if (audience) {
    if (!ALLOWED_AUDIENCE.includes(audience)) {
      return jsonError(400, "bad_audience");
    }
    if (audience !== "all") filter.audience = audience;
  }
  if (gate.scope !== "all") {
    filter.submissionLocationScope = gate.scope.locations;
  }

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
  // submissionGate (not adminGate): the per-form submissions page reads form
  // meta (title / slug) through this endpoint, and location admins may view it.
  // Returns form detail for any authorized caller; the mutating draft / publish
  // handlers below stay on adminGate so location admins can't edit forms.
  const gate = await submissionGate(env, req);
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

  // ---------------------------------------------------------------------------
  // Location-scoping: auto-inject / designate the site-number field.
  //
  // Internal + link-only forms are reused across every site, so a submission
  // needs a site number to know which location it belongs to. On the first
  // publish of such a form (scope_location_field_key still NULL) we designate a
  // `site_number` field — reusing one the operator already added, or appending
  // a plain short-text field mirroring the builder's default shape. The submit
  // path resolves that field's value to a canonical location_code and stamps it
  // (db/forms.ts resolveSubmissionLocationCode); location admins then see only
  // their sites' submissions.
  //
  // FAIL-SAFE: if the augmented schema fails strict validation for any reason
  // (e.g. the injected field shape drifts from @splash/forms-schema), we log
  // and publish the form UNSCOPED rather than block the publish. A missed
  // scope is recoverable on a later publish; a blocked publish is not.
  // Public forms are never scoped (anonymous fillers don't know site numbers).
  let scopeKeyToSet: string | null = null;
  try {
    const ctx = await getFormScopingContext(env, formId);
    if (
      ctx &&
      ctx.scopeFieldKey === null &&
      (ctx.audience === "internal" || ctx.audience === "link-only")
    ) {
      const base = strictResult.data as FormSchema;
      const existing = base.fields.find((f) => f.key === SCOPE_FIELD_KEY);
      if (existing) {
        // Operator already added a `site_number` field — designate it, don't
        // duplicate. No schema change; just stamp the key after publish.
        scopeKeyToSet = SCOPE_FIELD_KEY;
      } else {
        const siteField = {
          type: "short_text",
          label: "Site number",
          required: true,
          maxLength: 500,
          id: randomFieldId(),
          key: SCOPE_FIELD_KEY
        };
        const augmented = { ...base, fields: [...base.fields, siteField] };
        const augCheck = formSchemaSchema.safeParse(augmented);
        if (augCheck.success) {
          await updateDraft(
            env,
            formId,
            augCheck.data as FormSchema,
            gate.session.userId
          );
          scopeKeyToSet = SCOPE_FIELD_KEY;
        } else {
          console.error(
            "[forms.admin] publish: site-number injection failed strict validation; publishing unscoped",
            augCheck.error.issues
          );
        }
      }
    }
  } catch (err) {
    console.error(
      "[forms.admin] publish: scope-injection step threw; publishing unscoped",
      err
    );
  }

  try {
    const result = await publishDraft(env, formId, gate.session.userId);
    if (scopeKeyToSet) {
      try {
        await setFormScopeFieldKey(env, formId, scopeKeyToSet);
      } catch (err) {
        // Form is published; the scope key just didn't stamp. Recoverable on
        // the next publish (scopeFieldKey is still NULL, so we retry).
        console.error(
          "[forms.admin] publish: setFormScopeFieldKey failed; form published but unscoped",
          err
        );
      }
    }
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
