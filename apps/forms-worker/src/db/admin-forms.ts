// Brief 94 — admin-side DB helpers for form CRUD + draft/publish lifecycle.
//
// Pattern matches `./forms.ts` (Brief 89/90/91/92): direct fetch() against
// PostgREST with the SUPABASE_SERVICE_KEY apikey + Bearer header pair.
// Stays consistent with the rest of forms-worker DB code.
//
// Lifecycle (B-classic, planning Decision 1+7) — see Brief 94 for the
// full state machine:
//
//   On Create:
//     - INSERT forms (status='draft')
//     - INSERT form_versions (version_number=1, schema={fields:[]}, is_draft=true)
//     - UPDATE forms.draft_version_id ← that new version
//
//   On Save Draft:
//     - UPDATE form_versions SET schema = <new> WHERE id = forms.draft_version_id
//
//   On Publish:
//     - UPDATE form_versions SET is_draft=false, published_at=now(), published_by=<user>
//       WHERE id = forms.draft_version_id
//     - UPDATE forms.current_version_id, status='published'
//     - INSERT new form_versions (version_number=N+1, schema=<clone>, is_draft=true)
//     - UPDATE forms.draft_version_id ← new draft
//
//   On Unpublish/Republish:
//     - UPDATE forms.status (archived / published)
//
// Atomicity (planning Decision Report.atomic-create): create is 3 sequential
// PostgREST calls. Brief 89 declared `forms_current_version_fk` and
// `forms_draft_version_fk` as DEFERRABLE INITIALLY DEFERRED, so the FK
// from forms→form_versions doesn't fire until commit; the sequence is
// safe within a single transaction. We don't have a single Postgres
// function and we don't run these inside a transaction — so a partial
// failure case exists: form row inserted, version insert fails. The
// resulting form row has draft_version_id NULL and won't render publicly
// (it has status='draft' but no version). Cleanup is via SQL — operator
// can DELETE the orphan form by id. publish() is similarly sequential
// and could leak in the same way; a publish failure mid-sequence is
// flagged by the next admin GET (current_version_id pointing at a row
// that's now is_draft=false but no new draft exists). Acceptable for v1.

import type {
  FormMeta,
  FormSchema
} from "@splash/forms-schema";

interface SupabaseEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

const headers = (env: SupabaseEnv) => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
});

// =============================================================================
// listForms
// =============================================================================

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

interface FormListRow {
  id: string;
  slug: string;
  title: string;
  audience: "public" | "internal" | "link-only";
  status: "draft" | "published" | "archived";
  current_version_id: string | null;
  last_edited_at: string;
  created_at: string;
  // Embedded counts via FK column hint — form_versions.form_id /
  // form_submissions.form_id back-references:
  versions: Array<{ count: number }> | null;
  submissions: Array<{ count: number }> | null;
}

interface VersionPublishedAtRow {
  id: string;
  published_at: string | null;
}

export interface ListFormsFilter {
  status?: string;
  search?: string;
  audience?: string;
  // Location scoping for the SUBMISSIONS index. When set, the embedded
  // submission `count` is filtered to these location_codes so a location admin
  // sees per-site counts (not org-wide totals). Undefined = unscoped totals
  // (super_admin / dc-admin). Only affects the count, not which forms return.
  submissionLocationScope?: string[];
}

/**
 * List forms for the admin builder. Single PostgREST call with embedded
 * counts via the form_id FK column hint:
 *
 *     /rest/v1/forms?select=...,versions:form_versions!form_id(count),submissions:form_submissions!form_id(count)
 *
 * `lastPublishedAt` is filled in by a follow-up call against
 * `form_versions?id=in.(<current_version_ids>)`. Cheap — one extra round-trip
 * per list page; rows count is bounded by the number of published forms.
 */
export async function listForms(
  env: SupabaseEnv,
  filter?: ListFormsFilter
): Promise<FormListItem[]> {
  const url = new URL("/rest/v1/forms", env.SUPABASE_URL);
  url.searchParams.set(
    "select",
    "id,slug,title,audience,status,current_version_id,last_edited_at,created_at,versions:form_versions!form_id(count),submissions:form_submissions!form_id(count)"
  );
  url.searchParams.set("order", "last_edited_at.desc");

  // Scoped submission counts — filter the embedded `submissions` aggregate by
  // location_code. PostgREST filters an embedded resource via `<alias>.<col>`;
  // the parent form still returns (with count 0 when nothing matches). Guarded
  // against an empty array with a sentinel that matches no real code.
  if (filter?.submissionLocationScope) {
    const codes =
      filter.submissionLocationScope.length > 0
        ? filter.submissionLocationScope
        : ["__no_location__"];
    const list = codes.map((c) => `"${c.replace(/"/g, '""')}"`).join(",");
    url.searchParams.set("submissions.location_code", `in.(${list})`);
    // A location admin should only see location-scoped forms. An unscoped form
    // (scope_location_field_key IS NULL) has only NULL-location submissions —
    // super_admin / dc-admin visibility — so for a scoped caller it would
    // always show a 0 count and drill into an empty list. Hide it entirely.
    url.searchParams.set("scope_location_field_key", "not.is.null");
  }

  if (filter?.status && filter.status !== "all") {
    url.searchParams.set("status", `eq.${filter.status}`);
  }
  if (filter?.audience && filter.audience !== "all") {
    url.searchParams.set("audience", `eq.${filter.audience}`);
  }
  if (filter?.search) {
    // PostgREST `or` syntax with ilike — escape % and _ in the user input
    // so they're treated as literals, not wildcards.
    const escaped = filter.search.replace(/[%_\\]/g, (m) => `\\${m}`);
    url.searchParams.set(
      "or",
      `(title.ilike.*${escaped}*,slug.ilike.*${escaped}*)`
    );
  }

  const response = await fetch(url.toString(), { headers: headers(env) });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`listForms: PostgREST returned ${response.status}: ${errText}`);
  }
  const rows = (await response.json().catch(() => [])) as FormListRow[];
  if (rows.length === 0) return [];

  // Resolve lastPublishedAt for forms with a current_version_id.
  const versionIds = rows
    .map((r) => r.current_version_id)
    .filter((v): v is string => typeof v === "string");

  const publishedAtById = new Map<string, string | null>();
  if (versionIds.length > 0) {
    const versionUrl = new URL("/rest/v1/form_versions", env.SUPABASE_URL);
    versionUrl.searchParams.set("id", `in.(${versionIds.join(",")})`);
    versionUrl.searchParams.set("select", "id,published_at");
    const versionResp = await fetch(versionUrl.toString(), { headers: headers(env) });
    if (versionResp.ok) {
      const versionRows = (await versionResp.json().catch(() => [])) as VersionPublishedAtRow[];
      for (const v of versionRows) {
        publishedAtById.set(v.id, v.published_at);
      }
    } else {
      // Non-fatal — published_at columns will fall back to null for rows
      // we couldn't resolve. Logged for observability.
      console.error(
        "[forms.admin] listForms: published_at lookup returned",
        versionResp.status
      );
    }
  }

  return rows.map((r) => {
    const verEntry = r.versions?.[0];
    const subEntry = r.submissions?.[0];
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      audience: r.audience,
      status: r.status,
      versionCount: verEntry?.count ?? 0,
      submissionCount: subEntry?.count ?? 0,
      lastPublishedAt: r.current_version_id
        ? publishedAtById.get(r.current_version_id) ?? null
        : null,
      lastEditedAt: r.last_edited_at,
      createdAt: r.created_at
    };
  });
}

// =============================================================================
// Scoping context + designation (submission location scoping)
// =============================================================================
//
// `scope_location_field_key` is a `forms`-table column (not part of the version
// schema — field keys are stable across versions and it isn't in the
// unmodifiable @splash/forms-schema `FormMeta` type). These helpers read the
// scoping context and stamp the designated field key at publish time. See
// project memory "Forms submission scoping to location admins".

export interface FormScopingContext {
  audience: "public" | "internal" | "link-only";
  scopeFieldKey: string | null;
}

/**
 * Read a form's audience + current scope field designation in one call.
 * Returns null when the form id doesn't exist. Used by handlePublish to decide
 * whether to auto-inject / designate a site-number scope field.
 */
export async function getFormScopingContext(
  env: SupabaseEnv,
  formId: string
): Promise<FormScopingContext | null> {
  const url = new URL("/rest/v1/forms", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${formId}`);
  url.searchParams.set("select", "audience,scope_location_field_key");
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: headers(env) });
  if (!resp.ok) {
    throw new Error(`getFormScopingContext: ${resp.status}`);
  }
  const rows = (await resp.json().catch(() => [])) as Array<{
    audience: "public" | "internal" | "link-only";
    scope_location_field_key: string | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    audience: row.audience,
    scopeFieldKey:
      typeof row.scope_location_field_key === "string" &&
      row.scope_location_field_key.trim()
        ? row.scope_location_field_key.trim()
        : null
  };
}

/** Stamp the designated scope field key on a form. */
export async function setFormScopeFieldKey(
  env: SupabaseEnv,
  formId: string,
  fieldKey: string
): Promise<void> {
  const url = new URL("/rest/v1/forms", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${formId}`);
  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ scope_location_field_key: fieldKey })
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`setFormScopeFieldKey: ${resp.status}: ${errText}`);
  }
}

// =============================================================================
// createForm
// =============================================================================

export interface CreateFormArgs {
  slug: string;
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
  createdBy: string;
}

export interface CreateFormResult {
  formId: string;
  draftVersionId: string;
}

/**
 * Insert a new form + initial draft version + back-link. 3 sequential
 * PostgREST calls; relies on the deferrable FK from Brief 89's schema.
 *
 * Throws `Error("slug_taken")` when the slug is already in use. The
 * unique constraint on `forms.slug` enforces this server-side too — the
 * pre-check is for a cleaner error message.
 *
 * `notify_webhook` defaults true; `turnstile_required` defaults to true
 * for public audience and false for internal/link-only (planning
 * Decision 7 — Turnstile is for unauthenticated public submissions).
 */
export async function createForm(
  env: SupabaseEnv,
  args: CreateFormArgs
): Promise<CreateFormResult> {
  // Slug uniqueness pre-check.
  const existingUrl = new URL("/rest/v1/forms", env.SUPABASE_URL);
  existingUrl.searchParams.set("slug", `eq.${args.slug}`);
  existingUrl.searchParams.set("select", "id");
  existingUrl.searchParams.set("limit", "1");
  const existingResp = await fetch(existingUrl.toString(), { headers: headers(env) });
  if (!existingResp.ok) {
    throw new Error(`createForm: slug check failed ${existingResp.status}`);
  }
  const existingRows = (await existingResp.json().catch(() => [])) as Array<{ id: string }>;
  if (existingRows.length > 0) throw new Error("slug_taken");

  // Insert form row.
  const formUrl = new URL("/rest/v1/forms", env.SUPABASE_URL);
  const formInsertResp = await fetch(formUrl.toString(), {
    method: "POST",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({
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
  });
  if (!formInsertResp.ok) {
    const errText = await formInsertResp.text().catch(() => "");
    throw new Error(`createForm: form insert failed ${formInsertResp.status}: ${errText}`);
  }
  const formRows = (await formInsertResp.json().catch(() => [])) as Array<{ id: string }>;
  const formRow = formRows[0];
  if (!formRow) throw new Error("createForm: form insert returned no row");
  const formId = formRow.id;

  // Insert initial draft form_version row.
  const versionUrl = new URL("/rest/v1/form_versions", env.SUPABASE_URL);
  const versionInsertResp = await fetch(versionUrl.toString(), {
    method: "POST",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      form_id: formId,
      version_number: 1,
      schema: { fields: [] },
      is_draft: true
    })
  });
  if (!versionInsertResp.ok) {
    const errText = await versionInsertResp.text().catch(() => "");
    throw new Error(`createForm: version insert failed ${versionInsertResp.status}: ${errText}`);
  }
  const versionRows = (await versionInsertResp.json().catch(() => [])) as Array<{ id: string }>;
  const versionRow = versionRows[0];
  if (!versionRow) throw new Error("createForm: version insert returned no row");
  const draftVersionId = versionRow.id;

  // Back-link forms.draft_version_id → new version.
  const linkUrl = new URL("/rest/v1/forms", env.SUPABASE_URL);
  linkUrl.searchParams.set("id", `eq.${formId}`);
  const linkResp = await fetch(linkUrl.toString(), {
    method: "PATCH",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ draft_version_id: draftVersionId })
  });
  if (!linkResp.ok) {
    const errText = await linkResp.text().catch(() => "");
    throw new Error(`createForm: back-link failed ${linkResp.status}: ${errText}`);
  }

  return { formId, draftVersionId };
}

// =============================================================================
// getFormDetail
// =============================================================================

export interface FormVersionSummary {
  id: string;
  versionNumber: number;
  publishedAt: string | null;
  publishedBy: string | null;
  isDraft: boolean;
}

export interface FormDetailResult {
  form: FormMeta;
  draftSchema: FormSchema;
  currentVersionNumber: number | null;
  versions: FormVersionSummary[];
}

interface FormDetailRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
  status: "draft" | "published" | "archived";
  current_version_id: string | null;
  draft_version_id: string | null;
  notify_webhook: boolean;
  success_message: string | null;
  turnstile_required: boolean;
}

interface FormVersionDetailRow {
  id: string;
  version_number: number;
  published_at: string | null;
  published_by: string | null;
  is_draft: boolean;
  schema: unknown;
}

function rowToFormMeta(row: FormDetailRow): FormMeta {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    audience: row.audience,
    status: row.status,
    currentVersionId: row.current_version_id,
    draftVersionId: row.draft_version_id,
    notifyWebhook: row.notify_webhook,
    successMessage: row.success_message,
    turnstileRequired: row.turnstile_required
  };
}

/**
 * Read a single form's metadata + draft schema + version history. The
 * draft schema is returned as a `FormSchema` (parsed but NOT Zod-validated
 * here — admin builder is the consumer and should round-trip through the
 * Zod boundary on save). Returns null when the form id doesn't exist.
 */
export async function getFormDetail(
  env: SupabaseEnv,
  formId: string
): Promise<FormDetailResult | null> {
  const formUrl = new URL("/rest/v1/forms", env.SUPABASE_URL);
  formUrl.searchParams.set("id", `eq.${formId}`);
  formUrl.searchParams.set(
    "select",
    "id,slug,title,description,audience,status,current_version_id,draft_version_id,notify_webhook,success_message,turnstile_required"
  );
  formUrl.searchParams.set("limit", "1");

  const formResp = await fetch(formUrl.toString(), { headers: headers(env) });
  if (!formResp.ok) {
    throw new Error(`getFormDetail: form fetch ${formResp.status}`);
  }
  const formRows = (await formResp.json().catch(() => [])) as FormDetailRow[];
  const formRow = formRows[0];
  if (!formRow) return null;

  const versionsUrl = new URL("/rest/v1/form_versions", env.SUPABASE_URL);
  versionsUrl.searchParams.set("form_id", `eq.${formId}`);
  versionsUrl.searchParams.set(
    "select",
    "id,version_number,published_at,published_by,is_draft,schema"
  );
  versionsUrl.searchParams.set("order", "version_number.desc");
  const versionsResp = await fetch(versionsUrl.toString(), { headers: headers(env) });
  if (!versionsResp.ok) {
    throw new Error(`getFormDetail: versions fetch ${versionsResp.status}`);
  }
  const versionRows = (await versionsResp.json().catch(() => [])) as FormVersionDetailRow[];

  const draftRow = versionRows.find((v) => v.id === formRow.draft_version_id);
  const currentRow = formRow.current_version_id
    ? versionRows.find((v) => v.id === formRow.current_version_id)
    : undefined;

  const draftSchema: FormSchema =
    draftRow && draftRow.schema && typeof draftRow.schema === "object"
      ? (draftRow.schema as FormSchema)
      : { fields: [] };

  return {
    form: rowToFormMeta(formRow),
    draftSchema,
    currentVersionNumber: currentRow?.version_number ?? null,
    versions: versionRows.map((v) => ({
      id: v.id,
      versionNumber: v.version_number,
      publishedAt: v.published_at,
      publishedBy: v.published_by,
      isDraft: v.is_draft
    }))
  };
}

// =============================================================================
// updateDraft
// =============================================================================

/**
 * Replace the draft schema for a form. The draft_version_id is read first
 * so we can scope the UPDATE to the draft row only — a `is_draft=true`
 * filter on the update is defense-in-depth against accidentally writing
 * to a published version even if `forms.draft_version_id` points at a
 * non-draft (which the lifecycle never produces, but the constraint
 * doesn't enforce).
 *
 * Throws `Error("no_draft")` when the form has no draft_version_id.
 */
export async function updateDraft(
  env: SupabaseEnv,
  formId: string,
  schema: FormSchema,
  editedBy: string
): Promise<void> {
  const formUrl = new URL("/rest/v1/forms", env.SUPABASE_URL);
  formUrl.searchParams.set("id", `eq.${formId}`);
  formUrl.searchParams.set("select", "draft_version_id");
  formUrl.searchParams.set("limit", "1");
  const formResp = await fetch(formUrl.toString(), { headers: headers(env) });
  if (!formResp.ok) {
    throw new Error(`updateDraft: form fetch ${formResp.status}`);
  }
  const formRows = (await formResp.json().catch(() => [])) as Array<{ draft_version_id: string | null }>;
  const formRow = formRows[0];
  if (!formRow || !formRow.draft_version_id) throw new Error("no_draft");

  const versionUrl = new URL("/rest/v1/form_versions", env.SUPABASE_URL);
  versionUrl.searchParams.set("id", `eq.${formRow.draft_version_id}`);
  versionUrl.searchParams.set("is_draft", "eq.true");
  const versionResp = await fetch(versionUrl.toString(), {
    method: "PATCH",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ schema })
  });
  if (!versionResp.ok) {
    const errText = await versionResp.text().catch(() => "");
    throw new Error(`updateDraft: version update failed ${versionResp.status}: ${errText}`);
  }

  const editUrl = new URL("/rest/v1/forms", env.SUPABASE_URL);
  editUrl.searchParams.set("id", `eq.${formId}`);
  const editResp = await fetch(editUrl.toString(), {
    method: "PATCH",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      last_edited_at: new Date().toISOString(),
      last_edited_by: editedBy
    })
  });
  if (!editResp.ok) {
    const errText = await editResp.text().catch(() => "");
    throw new Error(`updateDraft: form last_edited update failed ${editResp.status}: ${errText}`);
  }
}

// =============================================================================
// getDraftSchema — used by handlePublish to strict-validate before promoting
// =============================================================================

/**
 * Fetch the raw draft schema JSONB for a form. Returns null when the form
 * has no draft (operator hit publish on a brand-new form before saving any
 * fields, which shouldn't happen via the UI but might via direct API call).
 *
 * Used by handlePublish's pre-promote strict-validation step: drafts are
 * saved against the lenient `draftFormSchemaSchema` (allows in-progress
 * Lookup / Image fields), but publish must re-check against the strict
 * `formSchemaSchema` so a half-configured field can't reach public render.
 */
export async function getDraftSchema(
  env: SupabaseEnv,
  formId: string
): Promise<unknown | null> {
  const formUrl = new URL("/rest/v1/forms", env.SUPABASE_URL);
  formUrl.searchParams.set("id", `eq.${formId}`);
  formUrl.searchParams.set("select", "draft_version_id");
  formUrl.searchParams.set("limit", "1");
  const formResp = await fetch(formUrl.toString(), { headers: headers(env) });
  if (!formResp.ok) {
    throw new Error(`getDraftSchema: form fetch ${formResp.status}`);
  }
  const formRows = (await formResp.json().catch(() => [])) as Array<{ draft_version_id: string | null }>;
  const draftVersionId = formRows[0]?.draft_version_id;
  if (!draftVersionId) return null;

  const draftUrl = new URL("/rest/v1/form_versions", env.SUPABASE_URL);
  draftUrl.searchParams.set("id", `eq.${draftVersionId}`);
  draftUrl.searchParams.set("select", "schema");
  draftUrl.searchParams.set("limit", "1");
  const draftResp = await fetch(draftUrl.toString(), { headers: headers(env) });
  if (!draftResp.ok) {
    throw new Error(`getDraftSchema: draft fetch ${draftResp.status}`);
  }
  const draftRows = (await draftResp.json().catch(() => [])) as Array<{ schema: unknown }>;
  return draftRows[0]?.schema ?? null;
}

// =============================================================================
// publishDraft
// =============================================================================

export interface PublishResult {
  versionNumber: number;
  newDraftId: string;
}

interface PublishDraftRow {
  id: string;
  version_number: number;
  schema: unknown;
  is_draft: boolean;
}

/**
 * Promote the current draft to published, then spawn a new editable draft
 * (clone of just-published). Sequence:
 *
 *   1. UPDATE the existing draft row: is_draft=false, published_at=now,
 *      published_by=<user>.
 *   2. UPDATE forms.current_version_id to that just-promoted row,
 *      status='published'.
 *   3. INSERT a new form_versions row at version_number+1, schema=clone,
 *      is_draft=true.
 *   4. UPDATE forms.draft_version_id to the new draft.
 *
 * Throws `Error("no_draft")` / `Error("draft_invalid")` when the
 * preconditions don't hold. A failure in step 3 or 4 leaves the form
 * with a current_version_id but a stale draft_version_id pointing at the
 * row we just promoted (which is no longer is_draft=true). Operator
 * recovery: re-publish the form (no-op since the draft row is already
 * promoted) — actually no, re-publish needs a draft. Recovery is via
 * SQL — insert a new form_versions row manually. Acceptable for v1.
 */
export async function publishDraft(
  env: SupabaseEnv,
  formId: string,
  publishedBy: string
): Promise<PublishResult> {
  // Read form to get draft_version_id.
  const formUrl = new URL("/rest/v1/forms", env.SUPABASE_URL);
  formUrl.searchParams.set("id", `eq.${formId}`);
  formUrl.searchParams.set("select", "draft_version_id");
  formUrl.searchParams.set("limit", "1");
  const formResp = await fetch(formUrl.toString(), { headers: headers(env) });
  if (!formResp.ok) {
    throw new Error(`publishDraft: form fetch ${formResp.status}`);
  }
  const formRows = (await formResp.json().catch(() => [])) as Array<{ draft_version_id: string | null }>;
  const formRow = formRows[0];
  if (!formRow || !formRow.draft_version_id) throw new Error("no_draft");
  const draftVersionId = formRow.draft_version_id;

  // Read draft row (need version_number + schema).
  const draftUrl = new URL("/rest/v1/form_versions", env.SUPABASE_URL);
  draftUrl.searchParams.set("id", `eq.${draftVersionId}`);
  draftUrl.searchParams.set("select", "id,version_number,schema,is_draft");
  draftUrl.searchParams.set("limit", "1");
  const draftResp = await fetch(draftUrl.toString(), { headers: headers(env) });
  if (!draftResp.ok) {
    throw new Error(`publishDraft: draft fetch ${draftResp.status}`);
  }
  const draftRows = (await draftResp.json().catch(() => [])) as PublishDraftRow[];
  const draftRow = draftRows[0];
  if (!draftRow || !draftRow.is_draft) throw new Error("draft_invalid");

  const publishedAt = new Date().toISOString();

  // 1. Promote draft → published.
  const promoteUrl = new URL("/rest/v1/form_versions", env.SUPABASE_URL);
  promoteUrl.searchParams.set("id", `eq.${draftRow.id}`);
  const promoteResp = await fetch(promoteUrl.toString(), {
    method: "PATCH",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      is_draft: false,
      published_at: publishedAt,
      published_by: publishedBy
    })
  });
  if (!promoteResp.ok) {
    const errText = await promoteResp.text().catch(() => "");
    throw new Error(`publishDraft: promote failed ${promoteResp.status}: ${errText}`);
  }

  // 2. Update form: current_version_id, status=published.
  const formUpdateUrl = new URL("/rest/v1/forms", env.SUPABASE_URL);
  formUpdateUrl.searchParams.set("id", `eq.${formId}`);
  const formUpdateResp = await fetch(formUpdateUrl.toString(), {
    method: "PATCH",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      current_version_id: draftRow.id,
      status: "published",
      last_edited_at: publishedAt,
      last_edited_by: publishedBy
    })
  });
  if (!formUpdateResp.ok) {
    const errText = await formUpdateResp.text().catch(() => "");
    throw new Error(`publishDraft: form update failed ${formUpdateResp.status}: ${errText}`);
  }

  // 3. Spawn new draft (clone of just-published schema).
  const newVersionNumber = draftRow.version_number + 1;
  const newDraftUrl = new URL("/rest/v1/form_versions", env.SUPABASE_URL);
  const newDraftResp = await fetch(newDraftUrl.toString(), {
    method: "POST",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      form_id: formId,
      version_number: newVersionNumber,
      schema: draftRow.schema,
      is_draft: true
    })
  });
  if (!newDraftResp.ok) {
    const errText = await newDraftResp.text().catch(() => "");
    throw new Error(`publishDraft: new draft insert failed ${newDraftResp.status}: ${errText}`);
  }
  const newDraftRows = (await newDraftResp.json().catch(() => [])) as Array<{ id: string }>;
  const newDraftRow = newDraftRows[0];
  if (!newDraftRow) throw new Error("publishDraft: new draft insert returned no row");

  // 4. Point form.draft_version_id at the new draft.
  const linkUrl = new URL("/rest/v1/forms", env.SUPABASE_URL);
  linkUrl.searchParams.set("id", `eq.${formId}`);
  const linkResp = await fetch(linkUrl.toString(), {
    method: "PATCH",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ draft_version_id: newDraftRow.id })
  });
  if (!linkResp.ok) {
    const errText = await linkResp.text().catch(() => "");
    throw new Error(`publishDraft: back-link failed ${linkResp.status}: ${errText}`);
  }

  return { versionNumber: draftRow.version_number, newDraftId: newDraftRow.id };
}

// =============================================================================
// setFormStatus (unpublish / republish)
// =============================================================================

export async function setFormStatus(
  env: SupabaseEnv,
  formId: string,
  status: "published" | "archived",
  editedBy: string
): Promise<void> {
  const url = new URL("/rest/v1/forms", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${formId}`);
  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      status,
      last_edited_at: new Date().toISOString(),
      last_edited_by: editedBy
    })
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`setFormStatus: update failed ${resp.status}: ${errText}`);
  }
}

// =============================================================================
// Asset helpers (used by admin/assets.ts)
// =============================================================================

export interface AssetInsertArgs {
  id: string;
  formId: string;
  r2Key: string;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  uploadedBy: string;
}

export async function insertFormAsset(env: SupabaseEnv, args: AssetInsertArgs): Promise<void> {
  const url = new URL("/rest/v1/form_assets", env.SUPABASE_URL);
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      id: args.id,
      form_id: args.formId,
      r2_key: args.r2Key,
      mime: args.mime,
      size_bytes: args.sizeBytes,
      width: args.width,
      height: args.height,
      uploaded_by: args.uploadedBy
    })
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`insertFormAsset: ${resp.status}: ${errText}`);
  }
}

export interface FormAssetRow {
  id: string;
  formId: string;
  r2Key: string;
}

interface FormAssetDbRow {
  id: string;
  form_id: string;
  r2_key: string;
}

export async function getFormAsset(
  env: SupabaseEnv,
  assetId: string
): Promise<FormAssetRow | null> {
  const url = new URL("/rest/v1/form_assets", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${assetId}`);
  url.searchParams.set("select", "id,form_id,r2_key");
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: headers(env) });
  if (!resp.ok) {
    throw new Error(`getFormAsset: ${resp.status}`);
  }
  const rows = (await resp.json().catch(() => [])) as FormAssetDbRow[];
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, formId: row.form_id, r2Key: row.r2_key };
}

export async function deleteFormAsset(env: SupabaseEnv, assetId: string): Promise<void> {
  const url = new URL("/rest/v1/form_assets", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${assetId}`);
  const resp = await fetch(url.toString(), {
    method: "DELETE",
    headers: { ...headers(env), Prefer: "return=minimal" }
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`deleteFormAsset: ${resp.status}: ${errText}`);
  }
}
