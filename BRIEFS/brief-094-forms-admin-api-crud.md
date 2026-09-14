# Brief 94: Forms — admin API (CRUD, draft/publish lifecycle, assets, lookup-sources)

**Status:** Completed (2026-05-10)
**Started:** 2026-05-10
**Completed:** 2026-05-10
**Blocks:** Brief 95 (admin builder UI consumes every endpoint in this brief). Brief 96 (submissions admin UI — depends on this brief's auth gate posture and `apps/web/app/admin/forms/_lib/worker-fetch.ts` helper introduced here).
**Dependencies:** Brief 89 (foundation — schema, R2 binding), Brief 92 (R2 upload + serve patterns), Brief 93 (lookup helper — exposed via lookup-sources endpoint).

## Read first

- BUILD_STATE.md.
- CLAUDE.md.
- BRIEFS/brief-083-fleet-submissions-admin-viewer.md (admin gate posture — `session.role === "super_admin"` OR `session.dcRole === "admin"|"super_admin"`; this brief mirrors).
- BRIEFS/brief-087-fleet-detail-splash-notes-editor.md (PATCH endpoint shape; 503-when-service-key-unbound posture).
- BRIEFS/brief-024-sysadmin-add-location.md (atomic multi-row insert pattern via Supabase REST).
- packages/auth/src/index.ts (`authenticate` + `Session` type — same as fleet's admin endpoints).
- packages/forms-schema/src/types.ts + lookup-sources.ts (the contracts this API exposes).
- apps/forms-worker/src/db/forms.ts (Brief 90/91/92 helpers — extend for admin reads/writes).

## Architecture context

Per planning Decision 7, only `super_admin` and `admin` access the form builder. Same gate posture as fleet (Brief 83): allow `session.role === "super_admin"` OR `session.dcRole === "admin"` OR `session.dcRole === "super_admin"`. Per-location scoping deferred to v2.

Per planning Decisions 1 + 7, the lifecycle is **B-classic** (draft mutates in place; publish creates an immutable version). Concretely:

```
On Create:
  - INSERT forms (status='draft')
  - INSERT form_versions (form_id, version_number=1, schema={fields:[]}, is_draft=true)
  - UPDATE forms SET draft_version_id = <new version's id>
  (Single transaction via Supabase RPC OR sequence with deferrable FK from Brief 89.)

On Save Draft:
  - UPDATE form_versions SET schema = <new schema> WHERE id = forms.draft_version_id

On Publish:
  - UPDATE form_versions SET is_draft=false, published_at=now(), published_by=<user>
    WHERE id = forms.draft_version_id
  - UPDATE forms SET current_version_id = <that same version_id>, status='published'
  - INSERT form_versions (form_id, version_number=N+1, schema=<copy of just-published schema>, is_draft=true)
  - UPDATE forms SET draft_version_id = <new draft's id>

On Unpublish:
  - UPDATE forms SET status='archived'

On Republish (from archived):
  - UPDATE forms SET status='published'
```

The "spawn new draft after publish" is critical: it means the operator can immediately start editing the next version without losing the published-current state. The new draft starts as a clone of just-published; operator mutates it via Save Draft.

Per Decision 8, no formal admin audit log. `form_versions` rows ARE the audit (every publish writes `published_at` + `published_by`). Brief 96's `/admin/forms/[id]/versions` page surfaces this.

Per Decision 6, no Delete endpoint. Hard-delete is destructive (cascades to submissions, R2 files). Operator does it via SQL on a case-by-case basis with sysadmin help. The CASCADE FKs from Brief 89's schema make manual SQL safe.

Per Decision 4, in-form display images (Image field type) live on the form's schema as `assetId` references. The asset itself uploads via `POST /forms/admin/api/forms/{id}/assets`, returns `{asset_id, r2_key, width, height}`. Builder UI (Brief 95) wires the upload widget. Asset deletion via `DELETE /forms/admin/api/forms/{id}/assets/{assetId}` removes the row + R2 object; daily cron (Brief 97) is the safety net for any orphans.

## Context

Sixth of 10 briefs. After this brief the worker has its complete admin-side API surface. Brief 95 builds the UI; Brief 96 adds submission-viewer endpoints + UI; Brief 97 wires webhook + cron; Brief 98 polishes. From this point forward operator can poke at the form builder with curl/Postman to verify everything works before the UI lands.

This brief introduces no new bindings or new packages. All scope lives in `apps/forms-worker/src/admin/` (NEW directory).

## Scope

### Phase 1 — Admin auth gate helper

**File:** `apps/forms-worker/src/admin/auth.ts` (NEW). Mirrors fleet's admin gate pattern from Brief 83.

```ts
import { authenticate, type Session } from "@splash/auth";
import type { Env } from "../index";

export async function adminGate(env: Env, req: Request): Promise<{ ok: true; session: Session } | { ok: false; status: number; body: string }> {
  const cookieHeader = req.headers.get("Cookie") ?? "";
  const session = await authenticate(env, cookieHeader);
  if (!session) {
    return { ok: false, status: 401, body: JSON.stringify({ error: "unauthenticated" }) };
  }
  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (!allowed) {
    return { ok: false, status: 403, body: JSON.stringify({ error: "forbidden", reason: "Form builder access requires super_admin or dc_role admin." }) };
  }
  return { ok: true, session };
}

export function requireServiceKey(env: Env): Response | null {
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response(JSON.stringify({ error: "service_key_unbound" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  }
  return null;
}
```

### Phase 2 — DB helpers for form CRUD

**File:** `apps/forms-worker/src/db/admin-forms.ts` (NEW).

```ts
import type { FormMeta, FormVersion, FormSchema } from "@splash/forms-schema";
import type { Env } from "../index";
import { createServiceClient } from "./forms";

export interface FormListItem {
  id: string;
  slug: string;
  title: string;
  audience: "public" | "internal" | "link-only";
  status: "draft" | "published" | "archived";
  versionCount: number;
  lastPublishedAt: string | null;
  submissionCount: number;
  lastEditedAt: string;
  createdAt: string;
}

export async function listForms(env: Env, filter?: { status?: string; search?: string }): Promise<FormListItem[]> {
  const client = createServiceClient(env);
  let query = client
    .from("forms")
    .select(`
      id, slug, title, audience, status, last_edited_at, created_at,
      versions:form_versions(count),
      latest_version:form_versions!current_version_id(published_at),
      submissions:form_submissions(count)
    `)
    .order("last_edited_at", { ascending: false });

  if (filter?.status && filter.status !== "all") {
    query = query.eq("status", filter.status);
  }
  if (filter?.search) {
    const escaped = filter.search.replace(/[%_]/g, "\\$&");
    query = query.or(`title.ilike.%${escaped}%,slug.ilike.%${escaped}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  // Map rows → FormListItem (executor handles the embedded count shape).
  // ...
  return [];   // placeholder — executor fills in
}

export async function createForm(env: Env, args: {
  slug: string;
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
  createdBy: string;
}): Promise<{ formId: string; draftVersionId: string }> {
  const client = createServiceClient(env);

  // Enforce slug uniqueness (Postgres will too, but better error message)
  const { data: existing } = await client.from("forms").select("id").eq("slug", args.slug).maybeSingle();
  if (existing) throw new Error("slug_taken");

  // Insert form, then version, then update form's draft_version_id.
  // (Could be a single Postgres function; for v1 we use 3 sequential calls
  // and rely on the deferrable FK from Brief 89's schema for safety.)
  const { data: formRow, error: formErr } = await client
    .from("forms")
    .insert({
      slug: args.slug,
      title: args.title,
      description: args.description,
      audience: args.audience,
      status: "draft",
      notify_webhook: true,
      turnstile_required: args.audience === "public",
      created_by: args.createdBy,
      last_edited_by: args.createdBy
    })
    .select("id")
    .single();
  if (formErr || !formRow) throw formErr ?? new Error("form_insert_failed");

  const { data: versionRow, error: versionErr } = await client
    .from("form_versions")
    .insert({
      form_id: formRow.id,
      version_number: 1,
      schema: { fields: [] },
      is_draft: true
    })
    .select("id")
    .single();
  if (versionErr || !versionRow) throw versionErr ?? new Error("version_insert_failed");

  const { error: linkErr } = await client
    .from("forms")
    .update({ draft_version_id: versionRow.id })
    .eq("id", formRow.id);
  if (linkErr) throw linkErr;

  return { formId: formRow.id, draftVersionId: versionRow.id };
}

export async function getFormDetail(env: Env, formId: string): Promise<{
  form: FormMeta;
  draftSchema: FormSchema;
  currentVersionNumber: number | null;
  versions: Array<{ id: string; versionNumber: number; publishedAt: string | null; publishedBy: string | null; isDraft: boolean }>;
} | null> {
  const client = createServiceClient(env);
  const { data: form, error } = await client
    .from("forms")
    .select("id,slug,title,description,audience,status,current_version_id,draft_version_id,notify_webhook,success_message,turnstile_required")
    .eq("id", formId)
    .maybeSingle();
  if (error || !form) return null;

  const { data: versions, error: versionsErr } = await client
    .from("form_versions")
    .select("id,version_number,published_at,published_by,is_draft,schema")
    .eq("form_id", formId)
    .order("version_number", { ascending: false });
  if (versionsErr) throw versionsErr;

  const draft = versions.find((v) => v.id === form.draft_version_id);
  const current = versions.find((v) => v.id === form.current_version_id);

  return {
    form: rowToFormMeta(form),
    draftSchema: (draft?.schema as FormSchema) ?? { fields: [] },
    currentVersionNumber: current?.version_number ?? null,
    versions: versions.map((v) => ({
      id: v.id,
      versionNumber: v.version_number,
      publishedAt: v.published_at,
      publishedBy: v.published_by,
      isDraft: v.is_draft
    }))
  };
}

export async function updateDraft(env: Env, formId: string, schema: FormSchema, editedBy: string): Promise<void> {
  const client = createServiceClient(env);
  // Read draft_version_id, then UPDATE form_versions.schema
  const { data: form, error: formErr } = await client
    .from("forms")
    .select("draft_version_id")
    .eq("id", formId)
    .single();
  if (formErr || !form?.draft_version_id) throw new Error("no_draft");

  const { error: versionErr } = await client
    .from("form_versions")
    .update({ schema })
    .eq("id", form.draft_version_id)
    .eq("is_draft", true);   // safety: don't accidentally write to a published version
  if (versionErr) throw versionErr;

  const { error: editErr } = await client
    .from("forms")
    .update({ last_edited_at: new Date().toISOString(), last_edited_by: editedBy })
    .eq("id", formId);
  if (editErr) throw editErr;
}

export async function publishDraft(env: Env, formId: string, publishedBy: string): Promise<{ versionNumber: number; newDraftId: string }> {
  const client = createServiceClient(env);
  const { data: form, error: formErr } = await client
    .from("forms")
    .select("id,draft_version_id,status")
    .eq("id", formId)
    .single();
  if (formErr || !form?.draft_version_id) throw new Error("no_draft");

  // Read the draft schema (we'll clone it for the new draft)
  const { data: draftRow, error: draftErr } = await client
    .from("form_versions")
    .select("id,version_number,schema,is_draft")
    .eq("id", form.draft_version_id)
    .single();
  if (draftErr || !draftRow || !draftRow.is_draft) throw new Error("draft_invalid");

  const publishedAt = new Date().toISOString();

  // 1. Promote draft → published
  const { error: promoteErr } = await client
    .from("form_versions")
    .update({ is_draft: false, published_at: publishedAt, published_by: publishedBy })
    .eq("id", draftRow.id);
  if (promoteErr) throw promoteErr;

  // 2. Update form: current_version_id, status=published
  const { error: formUpdateErr } = await client
    .from("forms")
    .update({ current_version_id: draftRow.id, status: "published", last_edited_at: publishedAt, last_edited_by: publishedBy })
    .eq("id", formId);
  if (formUpdateErr) throw formUpdateErr;

  // 3. Spawn new draft (clone of just-published)
  const newVersionNumber = draftRow.version_number + 1;
  const { data: newDraft, error: newDraftErr } = await client
    .from("form_versions")
    .insert({
      form_id: formId,
      version_number: newVersionNumber,
      schema: draftRow.schema,
      is_draft: true
    })
    .select("id")
    .single();
  if (newDraftErr || !newDraft) throw newDraftErr ?? new Error("new_draft_insert_failed");

  // 4. Point form's draft_version_id at the new draft
  const { error: linkErr } = await client
    .from("forms")
    .update({ draft_version_id: newDraft.id })
    .eq("id", formId);
  if (linkErr) throw linkErr;

  return { versionNumber: draftRow.version_number, newDraftId: newDraft.id };
}

export async function setFormStatus(env: Env, formId: string, status: "published" | "archived", editedBy: string): Promise<void> {
  const client = createServiceClient(env);
  const { error } = await client
    .from("forms")
    .update({ status, last_edited_at: new Date().toISOString(), last_edited_by: editedBy })
    .eq("id", formId);
  if (error) throw error;
}

function rowToFormMeta(r: Record<string, unknown>): FormMeta {
  return {
    id: r.id as string,
    slug: r.slug as string,
    title: r.title as string,
    description: (r.description as string) ?? null,
    audience: r.audience as "public" | "internal" | "link-only",
    status: r.status as "draft" | "published" | "archived",
    currentVersionId: (r.current_version_id as string) ?? null,
    draftVersionId: (r.draft_version_id as string) ?? null,
    notifyWebhook: r.notify_webhook as boolean,
    successMessage: (r.success_message as string) ?? null,
    turnstileRequired: r.turnstile_required as boolean
  };
}
```

### Phase 3 — Asset upload/delete helpers

**File:** `apps/forms-worker/src/admin/assets.ts` (NEW).

```ts
import { fileTypeFromBuffer } from "file-type";
import { adminGate, requireServiceKey } from "./auth";
import { jsonError } from "@splash/http";
import type { Env } from "../index";
import { createServiceClient } from "../db/forms";

const ASSET_HARD_LIMIT_BYTES = 10 * 1024 * 1024;   // 10 MB per in-form image
const ASSET_ALLOWED_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export async function handleAssetUpload(env: Env, req: Request, formId: string): Promise<Response> {
  const sk = requireServiceKey(env); if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  const formData = await req.formData();
  const fileEntry = formData.get("file");
  const altText = String(formData.get("alt_text") ?? "");
  if (!(fileEntry instanceof File)) return jsonError(400, "no_file", "No file in upload body.");

  const file = fileEntry as File;
  if (file.size === 0) return jsonError(400, "empty_file", "File is empty.");
  if (file.size > ASSET_HARD_LIMIT_BYTES) return jsonError(413, "file_too_large", "Asset exceeds 10 MB limit.");

  const headerBuf = await file.slice(0, 4100).arrayBuffer();
  const sniffed = await fileTypeFromBuffer(new Uint8Array(headerBuf));
  if (!sniffed || !ASSET_ALLOWED_MIMES.includes(sniffed.mime)) {
    return jsonError(415, "mime_not_allowed", "Asset must be JPEG, PNG, GIF, or WebP.");
  }

  const assetId = crypto.randomUUID();
  const r2_key = `form-assets/${formId}/${assetId}.${sniffed.ext}`;

  await env.FORMS_FILES.put(r2_key, file.stream(), {
    httpMetadata: { contentType: sniffed.mime },
    customMetadata: { formId, assetId, originalFilename: file.name }
  });

  // Extract dimensions — use a small img-decoder lib OR skip dimensions in v1.
  // For brief 94, leave width/height as null; can be filled in via Brief 95
  // with a client-side <img> probe before upload.
  const client = createServiceClient(env);
  const { error } = await client.from("form_assets").insert({
    id: assetId,
    form_id: formId,
    r2_key,
    mime: sniffed.mime,
    size_bytes: file.size,
    width: null,
    height: null,
    uploaded_by: gate.session.userId
  });
  if (error) {
    // Best-effort R2 rollback
    await env.FORMS_FILES.delete(r2_key).catch(() => undefined);
    return jsonError(500, "asset_insert_failed", "Could not record asset.");
  }

  return new Response(JSON.stringify({
    asset_id: assetId,
    r2_key,
    mime: sniffed.mime,
    size_bytes: file.size,
    alt_text: altText
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

export async function handleAssetDelete(env: Env, req: Request, formId: string, assetId: string): Promise<Response> {
  const sk = requireServiceKey(env); if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  const client = createServiceClient(env);
  const { data: asset, error: readErr } = await client
    .from("form_assets")
    .select("r2_key,form_id")
    .eq("id", assetId)
    .maybeSingle();
  if (readErr) return jsonError(500, "read_failed", "Could not read asset.");
  if (!asset) return jsonError(404, "not_found", "Asset not found.");
  if (asset.form_id !== formId) return jsonError(400, "form_mismatch", "Asset does not belong to this form.");

  // Delete row first; then R2. (Cron is safety net if R2 delete fails.)
  const { error: delErr } = await client.from("form_assets").delete().eq("id", assetId);
  if (delErr) return jsonError(500, "delete_failed", "Could not delete asset.");

  await env.FORMS_FILES.delete(asset.r2_key).catch((e) => {
    console.error("[forms.assets] R2 delete failed; cron will pick up", { r2_key: asset.r2_key, e });
  });

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}
```

### Phase 4 — Admin handlers (form CRUD)

**File:** `apps/forms-worker/src/admin/forms.ts` (NEW).

```ts
import { adminGate, requireServiceKey } from "./auth";
import { isOriginAllowed, jsonError } from "@splash/http";
import { formSchemaSchema } from "@splash/forms-schema";
import type { Env } from "../index";
import { listForms, createForm, getFormDetail, updateDraft, publishDraft, setFormStatus } from "../db/admin-forms";

export async function handleListForms(env: Env, req: Request): Promise<Response> {
  const sk = requireServiceKey(env); if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;

  try {
    const items = await listForms(env, { status, search });
    return new Response(JSON.stringify({ items }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[forms.admin] list failed", e);
    return jsonError(500, "list_failed", "Could not list forms.");
  }
}

export async function handleCreateForm(env: Env, req: Request): Promise<Response> {
  const sk = requireServiceKey(env); if (sk) return sk;
  if (!isOriginAllowed(req)) return new Response("Bad origin", { status: 403 });
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  let body: { slug?: string; title?: string; description?: string | null; audience?: string };
  try { body = await req.json(); } catch { return jsonError(400, "bad_json", "Body must be JSON."); }

  const slug = (body.slug ?? "").trim();
  const title = (body.title ?? "").trim();
  const audience = body.audience as "public" | "internal" | "link-only" | undefined;

  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(slug)) return jsonError(400, "invalid_slug", "Slug must be 3–80 chars, lowercase alphanum + hyphen, leading non-hyphen.");
  if (!title) return jsonError(400, "title_required", "Title required.");
  if (!audience || !["public", "internal", "link-only"].includes(audience)) return jsonError(400, "audience_required", "Audience must be public, internal, or link-only.");

  try {
    const created = await createForm(env, {
      slug,
      title,
      description: body.description ?? null,
      audience,
      createdBy: gate.session.userId
    });
    return new Response(JSON.stringify({ form_id: created.formId, draft_version_id: created.draftVersionId }), { status: 201, headers: { "Content-Type": "application/json" } });
  } catch (e: unknown) {
    if (e instanceof Error && e.message === "slug_taken") {
      return jsonError(409, "slug_taken", "A form with that slug already exists.");
    }
    console.error("[forms.admin] create failed", e);
    return jsonError(500, "create_failed", "Could not create form.");
  }
}

export async function handleGetForm(env: Env, req: Request, formId: string): Promise<Response> {
  const sk = requireServiceKey(env); if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(formId)) {
    return jsonError(400, "bad_id", "Invalid form id.");
  }

  try {
    const detail = await getFormDetail(env, formId);
    if (!detail) return jsonError(404, "not_found", "Form not found.");
    return new Response(JSON.stringify(detail), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[forms.admin] get failed", e);
    return jsonError(500, "get_failed", "Could not load form.");
  }
}

export async function handleUpdateDraft(env: Env, req: Request, formId: string): Promise<Response> {
  const sk = requireServiceKey(env); if (sk) return sk;
  if (!isOriginAllowed(req)) return new Response("Bad origin", { status: 403 });
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  let body: { schema?: unknown };
  try { body = await req.json(); } catch { return jsonError(400, "bad_json", "Body must be JSON."); }

  // Validate schema shape via Zod
  const result = formSchemaSchema.safeParse(body.schema);
  if (!result.success) {
    return new Response(JSON.stringify({ error: "schema_invalid", issues: result.error.errors }), {
      status: 422, headers: { "Content-Type": "application/json" }
    });
  }

  try {
    await updateDraft(env, formId, result.data, gate.session.userId);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e: unknown) {
    if (e instanceof Error && e.message === "no_draft") return jsonError(404, "no_draft", "Form has no draft to update.");
    console.error("[forms.admin] update draft failed", e);
    return jsonError(500, "update_failed", "Could not save draft.");
  }
}

export async function handlePublish(env: Env, req: Request, formId: string): Promise<Response> {
  const sk = requireServiceKey(env); if (sk) return sk;
  if (!isOriginAllowed(req)) return new Response("Bad origin", { status: 403 });
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  try {
    const result = await publishDraft(env, formId, gate.session.userId);
    return new Response(JSON.stringify({ published_version_number: result.versionNumber, new_draft_id: result.newDraftId }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  } catch (e: unknown) {
    if (e instanceof Error && (e.message === "no_draft" || e.message === "draft_invalid")) {
      return jsonError(404, e.message, "Form draft is missing or invalid.");
    }
    console.error("[forms.admin] publish failed", e);
    return jsonError(500, "publish_failed", "Could not publish.");
  }
}

export async function handleStatusChange(env: Env, req: Request, formId: string, target: "published" | "archived"): Promise<Response> {
  const sk = requireServiceKey(env); if (sk) return sk;
  if (!isOriginAllowed(req)) return new Response("Bad origin", { status: 403 });
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  try {
    await setFormStatus(env, formId, target, gate.session.userId);
    return new Response(JSON.stringify({ ok: true, status: target }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[forms.admin] status change failed", e);
    return jsonError(500, "status_change_failed", "Could not change status.");
  }
}
```

### Phase 5 — Lookup-sources endpoint

**File:** `apps/forms-worker/src/admin/lookup-sources.ts` (NEW).

```ts
import { LOOKUP_SOURCES } from "@splash/forms-schema";
import { adminGate } from "./auth";
import type { Env } from "../index";

export async function handleLookupSources(env: Env, req: Request): Promise<Response> {
  const gate = await adminGate(env, req);
  if (!gate.ok) return new Response(gate.body, { status: gate.status, headers: { "Content-Type": "application/json" } });

  return new Response(JSON.stringify({ sources: LOOKUP_SOURCES }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=300" }
  });
}
```

### Phase 6 — Wire routes

**File:** `apps/forms-worker/src/index.ts` (MODIFY).

```ts
import {
  handleListForms, handleCreateForm, handleGetForm, handleUpdateDraft,
  handlePublish, handleStatusChange
} from "./admin/forms";
import { handleAssetUpload, handleAssetDelete } from "./admin/assets";
import { handleLookupSources } from "./admin/lookup-sources";

// In fetch():

// /forms/admin/api/lookup-sources
if (url.pathname === "/forms/admin/api/lookup-sources" && req.method === "GET") {
  return handleLookupSources(env, req);
}

// /forms/admin/api/forms
if (url.pathname === "/forms/admin/api/forms") {
  if (req.method === "GET") return handleListForms(env, req);
  if (req.method === "POST") return handleCreateForm(env, req);
}

// /forms/admin/api/forms/{id}
const detailMatch = url.pathname.match(/^\/forms\/admin\/api\/forms\/([0-9a-f-]+)$/i);
if (detailMatch && req.method === "GET") return handleGetForm(env, req, detailMatch[1]);

// /forms/admin/api/forms/{id}/draft
const draftMatch = url.pathname.match(/^\/forms\/admin\/api\/forms\/([0-9a-f-]+)\/draft$/i);
if (draftMatch && req.method === "PATCH") return handleUpdateDraft(env, req, draftMatch[1]);

// /forms/admin/api/forms/{id}/publish
const publishMatch = url.pathname.match(/^\/forms\/admin\/api\/forms\/([0-9a-f-]+)\/publish$/i);
if (publishMatch && req.method === "POST") return handlePublish(env, req, publishMatch[1]);

// /forms/admin/api/forms/{id}/unpublish
const unpubMatch = url.pathname.match(/^\/forms\/admin\/api\/forms\/([0-9a-f-]+)\/unpublish$/i);
if (unpubMatch && req.method === "POST") return handleStatusChange(env, req, unpubMatch[1], "archived");

// /forms/admin/api/forms/{id}/republish
const repubMatch = url.pathname.match(/^\/forms\/admin\/api\/forms\/([0-9a-f-]+)\/republish$/i);
if (repubMatch && req.method === "POST") return handleStatusChange(env, req, repubMatch[1], "published");

// /forms/admin/api/forms/{id}/assets
const assetUploadMatch = url.pathname.match(/^\/forms\/admin\/api\/forms\/([0-9a-f-]+)\/assets$/i);
if (assetUploadMatch && req.method === "POST") return handleAssetUpload(env, req, assetUploadMatch[1]);

// /forms/admin/api/forms/{id}/assets/{assetId}
const assetDelMatch = url.pathname.match(/^\/forms\/admin\/api\/forms\/([0-9a-f-]+)\/assets\/([0-9a-f-]+)$/i);
if (assetDelMatch && req.method === "DELETE") return handleAssetDelete(env, req, assetDelMatch[1], assetDelMatch[2]);
```

Add `OPTIONS` preflight responses for the PATCH/POST/DELETE routes if apps/web ever calls cross-origin (not needed for service-binding calls).

### Phase 7 — apps/web fetch helpers

**File:** `apps/web/app/admin/forms/_lib/worker-fetch.ts` (NEW). Mirror the binding-first / URL-fallback pattern from Brief 17 / Brief 87.

```ts
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";
import type { FormMeta, FormSchema } from "@splash/forms-schema";

export interface FormListItem { /* mirror admin-forms.ts shape */ }

export interface FormDetail {
  form: FormMeta;
  draftSchema: FormSchema;
  currentVersionNumber: number | null;
  versions: Array<{ id: string; versionNumber: number; publishedAt: string | null; publishedBy: string | null; isDraft: boolean }>;
}

const FORMS_BINDING = "FORMS_WORKER";

async function callForms(path: string, init: RequestInit = {}): Promise<Response> {
  const cookieHeader = (await cookies()).toString();
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookieHeader);
  if (init.method && init.method !== "GET" && init.method !== "HEAD") {
    headers.set("Origin", "https://internal");
  }

  // Binding-first
  try {
    const ctx = await getCloudflareContext({ async: true });
    const binding = ctx?.env?.[FORMS_BINDING];
    if (binding) {
      const internalReq = new Request(`https://internal${path}`, { ...init, headers });
      return await binding.fetch(internalReq);
    }
  } catch {
    // fall through to URL fallback
  }

  // URL fallback (next dev)
  const base = process.env.NEXT_PUBLIC_FORMS_WORKER_URL;
  if (!base) throw new Error("FORMS_WORKER unbound and NEXT_PUBLIC_FORMS_WORKER_URL unset");
  return await fetch(`${base}${path}`, { ...init, headers });
}

export async function listFormsAdmin(filter: { status?: string; search?: string } = {}): Promise<{ items: FormListItem[] }> {
  const qs = new URLSearchParams();
  if (filter.status) qs.set("status", filter.status);
  if (filter.search) qs.set("search", filter.search);
  const path = `/forms/admin/api/forms${qs.toString() ? "?" + qs : ""}`;
  const r = await callForms(path);
  if (!r.ok) throw new Error(`listForms ${r.status}`);
  return r.json();
}

export async function createFormAdmin(args: { slug: string; title: string; description: string | null; audience: "public" | "internal" | "link-only" }): Promise<{ form_id: string }> {
  const r = await callForms("/forms/admin/api/forms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });
  if (!r.ok) throw new Error(`createForm ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function getFormAdmin(formId: string): Promise<FormDetail> {
  const r = await callForms(`/forms/admin/api/forms/${formId}`);
  if (!r.ok) throw new Error(`getForm ${r.status}`);
  return r.json();
}

export async function updateDraftAdmin(formId: string, schema: FormSchema): Promise<void> {
  const r = await callForms(`/forms/admin/api/forms/${formId}/draft`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema })
  });
  if (!r.ok) throw new Error(`updateDraft ${r.status}: ${await r.text()}`);
}

export async function publishFormAdmin(formId: string): Promise<{ published_version_number: number }> {
  const r = await callForms(`/forms/admin/api/forms/${formId}/publish`, { method: "POST" });
  if (!r.ok) throw new Error(`publish ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function setFormStatusAdmin(formId: string, target: "unpublish" | "republish"): Promise<void> {
  const r = await callForms(`/forms/admin/api/forms/${formId}/${target}`, { method: "POST" });
  if (!r.ok) throw new Error(`${target} ${r.status}: ${await r.text()}`);
}

export async function uploadAssetAdmin(formId: string, file: File, altText: string): Promise<{ asset_id: string; r2_key: string }> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("alt_text", altText);
  const r = await callForms(`/forms/admin/api/forms/${formId}/assets`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`asset upload ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function deleteAssetAdmin(formId: string, assetId: string): Promise<void> {
  const r = await callForms(`/forms/admin/api/forms/${formId}/assets/${assetId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`asset delete ${r.status}`);
}

export async function getLookupSourcesAdmin(): Promise<{ sources: typeof import("@splash/forms-schema").LOOKUP_SOURCES }> {
  const r = await callForms(`/forms/admin/api/lookup-sources`);
  if (!r.ok) throw new Error(`lookup sources ${r.status}`);
  return r.json();
}
```

### Phase 8 — Documentation

**File:** `PRE_DEPLOY_FORMS.md`. Section 2 (Bindings) + Section 5 (Smoke tests):

> ### Brief 94 — admin API
>
> Admin endpoints (cookie-gated, super_admin OR dcRole admin/super_admin):
>
> - `GET /forms/admin/api/forms` (list; query: `status`, `search`)
> - `POST /forms/admin/api/forms` (create; body: `{slug, title, description, audience}`)
> - `GET /forms/admin/api/forms/{id}` (detail incl. draft schema + version history)
> - `PATCH /forms/admin/api/forms/{id}/draft` (body: `{schema}`)
> - `POST /forms/admin/api/forms/{id}/publish`
> - `POST /forms/admin/api/forms/{id}/unpublish`
> - `POST /forms/admin/api/forms/{id}/republish`
> - `POST /forms/admin/api/forms/{id}/assets` (multipart; returns `{asset_id, r2_key}`)
> - `DELETE /forms/admin/api/forms/{id}/assets/{assetId}`
> - `GET /forms/admin/api/lookup-sources`
>
> Smoke tests (curl, while logged in as super_admin):
>
> 1. `curl /forms/admin/api/forms?status=draft` → 200, JSON `{items: []}` (empty until create).
> 2. `curl -X POST /forms/admin/api/forms -d '{"slug":"smoke-1","title":"Smoke 1","audience":"public"}' -H 'Content-Type: application/json'` → 201, returns `{form_id, draft_version_id}`.
> 3. `curl /forms/admin/api/forms/{form_id}` → 200; verify `draftSchema = {fields:[]}`, `versions = [{versionNumber:1, isDraft:true, publishedAt:null}]`.
> 4. `curl -X PATCH /forms/admin/api/forms/{form_id}/draft -d '{"schema":{"fields":[{"id":"f1","type":"name","key":"name","label":"Name","required":true}]}}' -H 'Content-Type: application/json'` → 200.
> 5. `curl -X POST /forms/admin/api/forms/{form_id}/publish` → 200; verify a new draft version (number=2) exists.
> 6. Visit `/forms/smoke-1` (Brief 90 path) → form renders with the Name field. Submit (Brief 91) → row inserted.
> 7. `curl -X POST /forms/admin/api/forms/{form_id}/unpublish` → 200. Visit `/forms/smoke-1` → 404.
> 8. Try the same calls with NO cookie → 401. With a non-admin cookie → 403.
> 9. `curl /forms/admin/api/lookup-sources` → 200; verify the array contains the 11 entries from Brief 89's registry.

**File:** `CLAUDE.md`. Append to forms-worker glossary:

> Brief 94 wired the admin API. Endpoint inventory at `/forms/admin/api/*`. Auth gate (in `apps/forms-worker/src/admin/auth.ts`): `session.role === "super_admin"` OR `session.dcRole === "admin"|"super_admin"` — same posture as fleet (Brief 83). Per-location scoping deferred v2 (planning Decision 7). Lifecycle: draft (mutable) → published (immutable, current_version_id pinned) → archived (no public render, submissions retained). Publish creates new immutable version row + spawns a fresh editable draft (clone of just-published). No Delete endpoint — destructive ops via SQL only (planning Decision 7). The `apps/web/app/admin/forms/_lib/worker-fetch.ts` helper centralizes all SSR calls into `splash-forms` via the `FORMS_WORKER` service binding with URL fallback for `next dev` (Brief 17 pattern).

**File:** `BUILD_STATE.md` + `BRIEFS/INDEX.md` — update entries.

### Phase 9 — Validation

```sh
pnpm --filter @splash/forms-worker typecheck
pnpm --filter @splash/web typecheck
pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run
pnpm typecheck
```

## Configuration

No new env vars. Operator must have:

- `SUPABASE_SERVICE_KEY` already bound (Brief 89).
- `FORMS_WORKER` service binding declared on apps/web (Brief 89).

## Out of scope

- Submissions admin endpoints (`/forms/admin/api/forms/{id}/submissions*`) — Brief 96.
- Builder UI itself — Brief 95.
- Webhook fire on publish events — out of scope (planning didn't ask for publish webhooks; submission webhook lands in Brief 97).
- Bulk operations (publish-many, archive-many) — v2.
- Form Delete via API — explicitly out of scope per Decision 7.
- Per-location scoping for non-super-admin — v2.
- Don't deploy to Cloudflare automatically.
- Don't bind production routes — staging only.
- Don't add to QUEUE.md until operator decides.
- Don't commit to git or push.

## Definition of done

- `apps/forms-worker/src/admin/{auth,forms,assets,lookup-sources}.ts` exist.
- `apps/forms-worker/src/db/admin-forms.ts` exists with all CRUD helpers.
- `apps/forms-worker/src/index.ts` routes all admin endpoints.
- `apps/web/app/admin/forms/_lib/worker-fetch.ts` exists with all binding-first helpers.
- All curl smoke tests pass at the operator level.
- `pnpm typecheck` green.
- `wrangler deploy --dry-run` green.
- Brief Status flips to Completed.

## Report

- **Atomic create.** Did the executor implement the create path as 3 sequential calls (relying on Brief 89's deferrable FK) OR via a Postgres function for true atomicity? If sequential, surface any error case where partial state might leak (form created, version insert failed → form has no draft).
- **`authenticate()` signature.** The brief assumes `authenticate(env, cookieHeader)` returns `Session | null`. Verify against `@splash/auth`'s actual export — fleet uses the same shape, but if it's diverged note it.
- **Embedded counts in listForms.** PostgREST embedded counts have a specific syntax; the brief sketched it but executor should verify the actual JSON shape and adjust the row → FormListItem mapping accordingly.
- **Validation results.**

## Outcome

### Files created

- `apps/forms-worker/src/admin/auth.ts` — `adminGate(env, req)` returning the typed result discriminated union, `requireServiceKey(env)` returning a 503 Response or null. Mirrors fleet's Brief 83 helper, adapted to the canonical `authenticate(req, env)` surface from `@splash/auth`.
- `apps/forms-worker/src/admin/forms.ts` — six handlers (`handleListForms`, `handleCreateForm`, `handleGetForm`, `handleUpdateDraft`, `handlePublish`, `handleStatusChange`) with structured JSON errors, `isOriginAllowed` CSRF gate on every mutation, FORM_ID_RE / SLUG_RE input validators, and Zod boundary check on the draft schema body.
- `apps/forms-worker/src/admin/assets.ts` — `handleAssetUpload` (multipart parse, `file-type` MIME sniff, JPEG/PNG/GIF/WebP allow-list, 10 MB hard cap, R2 put + form_assets row insert with best-effort R2 rollback) + `handleAssetDelete` (form_id ownership check + row delete + R2 delete).
- `apps/forms-worker/src/admin/lookup-sources.ts` — single GET handler returning Brief 89's `LOOKUP_SOURCES` registry with `Cache-Control: private, max-age=300`.
- `apps/forms-worker/src/db/admin-forms.ts` — worker-side DB helpers using direct PostgREST `fetch()` matching the existing `db/forms.ts` pattern: `listForms` (embedded-counts + follow-up published_at lookup), `createForm` (3-call sequence), `getFormDetail`, `updateDraft`, `publishDraft` (4-call sequence), `setFormStatus`, plus `insertFormAsset` / `getFormAsset` / `deleteFormAsset`.
- `apps/web/app/admin/forms/_lib/worker-fetch.ts` — binding-first / URL-fallback helper exposing typed wrappers for every Brief 94 endpoint plus shared response interfaces (`FormListItem`, `FormDetail`, `FormVersionSummary`, etc.). Returns `null` on 401/403/404 from list/detail/lookup-sources so server components branch cleanly without try/catch.

### Files modified

- `apps/forms-worker/src/index.ts` — extended router with 9 new admin route matchers; new admin imports; header docblock updated to enumerate every admin endpoint.
- `apps/web/package.json` — added `@splash/forms-schema: workspace:*` so apps/web can import `FormMeta` / `FormSchema` / `LookupSource` types. `pnpm install` ran to relink workspace symlinks (no transitive package additions; `Already up to date` summary).
- `PRE_DEPLOY_FORMS.md` — Section 5 gains 15 Brief-94 smoke tests covering full lifecycle (list → create → save draft → publish → public render → unpublish → republish), auth gating (401 / 403 / 503), slug + schema validation, CSRF defense, asset upload + delete, and lookup-sources.
- `CLAUDE.md` — forms-worker glossary entry extended with the Brief 94 paragraph (endpoint inventory, auth posture, lifecycle state machine, atomicity caveats, no Delete endpoint, apps/web helper).
- `BUILD_STATE.md` — Last-updated bump, new prioritized work list row 94, new Findings & decisions log entry.
- `BRIEFS/INDEX.md` — Brief 94 row added between Brief 91 and Folded items.
- `BRIEFS/QUEUE.md` — `brief-094-forms-admin-api-crud.md` line moved into the completed-comment block.

### Decisions made on operator's behalf

- **`authenticate()` signature.** The brief's stub assumed `authenticate(env, cookieHeader)` returning `Session | null`. The actual export is `authenticate(req, env)` returning an `AuthOutcome` discriminated union (`{ status: "authenticated"; session } | { status: "unauthenticated" }`). Used the canonical surface — matches `apps/forms-worker/src/uploads/serve.ts:24` (Brief 92) and `apps/fleet-inquiry-worker/src/admin.js:148` (Brief 83). Same outcome, no behavior change.
- **DB layer uses direct PostgREST `fetch()` not `createServiceClient`.** The brief's draft sketch imported `createServiceClient` from `./forms`, but `db/forms.ts` doesn't export that helper — it uses direct PostgREST fetch with a service-key headers helper, matching Brief 89's `maintainx-users.ts` pattern. Followed the existing convention so the new file is consistent with its sibling. Going through `@supabase/supabase-js` would have meant heavier types for embedded count selects (its `from(...).select(...)` returns `any` for embedded relations, requiring more casting anyway).
- **PostgREST FK column hint syntax for `listForms` embeds.** `form_versions` has BOTH a back-reference (`form_versions.form_id → forms.id`) AND two forward references (`forms.current_version_id`, `forms.draft_version_id` → `form_versions.id`). Without disambiguation PostgREST returns `400: "Could not embed because more than one relationship was found"`. Used the FK column hint syntax `versions:form_versions!form_id(count)` to pin the embed to the back-reference — most readable and least brittle.
- **`lastPublishedAt` resolved via a follow-up call** rather than a deeper embed. Keeps the embed expression simple and avoids the FK-constraint-name brittleness that another forward-FK embed would introduce.
- **Atomicity caveats.** 3-call create + 4-call publish are sequential PostgREST writes (no transaction wrapper). Brief 89 declared the forward-ref FKs `forms_current_version_fk` / `forms_draft_version_fk` as `DEFERRABLE INITIALLY DEFERRED` so a transaction-wrapped sequence would commit atomically — but PostgREST doesn't support multi-statement transactions over a single REST call, so we don't get that benefit at v1. Partial-failure surface: form row inserted but version insert fails → form has NULL draft_version_id (won't render publicly, status stays "draft", admin GET surfaces the orphan). Recovery is manual SQL — operator can DELETE the orphan form by id (CASCADE FKs make this safe). Acceptable for v1; surfaced in this Outcome's atomic-create note.
- **Slug regex `^[a-z0-9][a-z0-9-]{2,80}$`.** 3–81 chars total (one leading non-hyphen + 2–80 alphanum/hyphen). Mirrors the brief's spec.
- **`description` null-coalesced when blank.** JSONB column allows NULL; treating empty string as null keeps the detail-page display logic simpler.
- **Asset upload accepts any form_id without cross-checking the form exists.** DELETE rejects on form_mismatch and the R2 rollback covers row-insert failures, with cron sweeping orphans. Adding a pre-check would add a round-trip with limited value (still racy with concurrent form deletion).
- **`apps/web/package.json` gains `@splash/forms-schema` as a runtime dep** (workspace ref). Brief 95's builder UI will consume the full type contract; adding here saves Brief 95 a `pnpm install` round-trip.
- **Cache headers.** Admin endpoints emit `Cache-Control: no-store` on list + detail (admin views must reflect just-published edits immediately); `lookup-sources` caches `private, max-age=300` (registry is hardcoded; 5-minute drift acceptable for builder UI inspector dropdowns).
- **Apps/web helper return shape.** `listFormsAdmin` / `getFormAdmin` / `getLookupSourcesAdmin` return `null` on 401/403/404 (matches fleet's helper) so server components branch cleanly without try/catch on auth failures. Mutation helpers throw on non-2xx so server actions can surface a typed `ActionResult` error via the Brief 19 `<ActionForm>` pattern.

### Latent issues found

1. `noUncheckedIndexedAccess: true` requires `versions[0]?.count ?? 0` in `listForms`'s row mapping rather than `versions[0].count`. Caught at typecheck.
2. PostgREST embedded count + FK disambiguation depends on the FK relationship metadata being present in Postgres. Brief 89's schema has the explicit `forms_current_version_fk` constraint plus the implicit form_versions/form_submissions FKs, so embedding works. If the schema were ever altered to drop these FKs (drift), `listForms` would 400; logged via the existing error path.
3. Image dimension capture (`width` / `height` on `form_assets`) is deferred to Brief 95's client-side `<img>` probe before upload. Extracting from worker code requires either a binary image decoder (heavy) or a parser sniff (PNG IHDR / JPEG SOF) we don't have. Inserted as `null` for now.
4. The brief's draft sketch had a few inaccuracies that surfaced during execution: `authenticate` signature, `createServiceClient` import path from `./forms`. Both flagged in CLAUDE.md so the next executor doesn't trip on the same.
5. Wrangler dry-run reported a bundle of 1019.24 KiB / 195.28 KiB gzip — up from Brief 93's 989.26 KiB / 190.44 KiB gzip (+30 KiB / +5 KiB gzip from the new admin module + db/admin-forms.ts). Still well inside CF's 3 MiB compressed limit.

### Validation results

- `pnpm install` — green (`Already up to date`; relinked workspace symlinks for the new `@splash/forms-schema` apps/web dep).
- `pnpm --filter @splash/forms-worker typecheck` — green.
- `pnpm --filter @splash/web typecheck` — green.
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run` — green (1019.24 KiB / 195.28 KiB gzip; bindings: FORMS_FILES R2 bucket, SUPABASE_URL, TURNSTILE_SITE_KEY).
- `pnpm typecheck` (root, via Turbo) — 17/17 successful, 15 cached, 2 cache misses (`@splash/forms-worker`, `@splash/web`) re-ran green.

Smoke tests deferred to operator post-deploy per the brief's "Don't deploy" guardrail.

### Report (per Brief)

- **Atomic create.** Implemented as 3 sequential PostgREST calls relying on Brief 89's deferrable FK declarations. Partial-failure case: form row inserted, version insert fails → form has NULL draft_version_id and status='draft' (won't render publicly, surfaces as an orphan on next admin GET). Recovery is via SQL — operator DELETE by id (CASCADE FKs make this safe). Same posture for publish (4 calls): a step-3 failure leaves the form pointing at a now-published version with no new draft; recovery is to insert a new draft row by SQL. No Postgres function wrapper at v1.
- **`authenticate()` signature.** Verified against `packages/auth/src/session.ts`. Actual signature is `authenticate(request, env)` returning `AuthOutcome`. Used canonical surface throughout the new code; same as `apps/forms-worker/src/uploads/serve.ts` (Brief 92) and `apps/fleet-inquiry-worker/src/admin.js` (Brief 83).
- **Embedded counts in `listForms`.** Verified the PostgREST FK column hint syntax (`form_versions!form_id(count)`) returns rows shaped `versions: [{count: N}]`. Mapped into `FormListItem.versionCount` via `r.versions?.[0]?.count ?? 0`. Same pattern for `submissions`.
- **Validation results.** Captured above — all green.
