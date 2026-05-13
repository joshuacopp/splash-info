// Brief 96 — admin-side DB helpers for submission read / patch + version
// listing. Direct PostgREST `fetch()` (matches Brief 89/94 pattern — no
// `@supabase/supabase-js` client in worker code).
//
// All reads use the SUPABASE_SERVICE_KEY so admin-side queries see every
// submission regardless of RLS, mirroring the fleet admin gate (Brief 83).
// Mutations are scoped to the (form_id, submission_id) tuple so a
// caller can't update a submission belonging to another form by guessing
// just the submission UUID.

import type { FormSchema, WorkflowHistoryEntry } from "@splash/forms-schema";

interface SupabaseEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

const headers = (env: SupabaseEnv) => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
});

// =============================================================================
// listSubmissions
// =============================================================================

export type SubmissionStatus = "new" | "in_progress" | "closed";
export type SubmitterKind = "authenticated" | "anonymous";

export interface SubmissionListVersion {
  id: string;
  version_number: number;
  schema: FormSchema;
}

export interface SubmissionListItem {
  id: string;
  submitted_at: string;
  status: SubmissionStatus;
  submitter_kind: SubmitterKind;
  submitter_email: string | null;
  version_number: number | null;
  splash_notes_preview: string | null;
  splash_notes_truncated: boolean;
  // Optional, populated when listSubmissions is called with includePayload=true
  // (Brief 119 wide-table view). Apps/web reads these to render every answer
  // as a column without round-tripping the per-submission detail endpoint.
  payload?: Record<string, unknown>;
  splash_notes?: string | null;
  form_version_id?: string;
  version?: SubmissionListVersion;
}

export interface ListSubmissionsArgs {
  formId: string;
  fromIso: string;
  toIso: string;
  status?: string;
  submitterKind?: string;
  limit: number;
  includePayload?: boolean;
}

interface ListSubmissionDbRow {
  id: string;
  submitted_at: string;
  status: SubmissionStatus;
  submitter_kind: SubmitterKind;
  submitter_email: string | null;
  splash_notes: string | null;
  // PostgREST embeds the parent row as an object via the FK relationship.
  version: { version_number: number } | null;
}

interface ListSubmissionWithPayloadDbRow {
  id: string;
  submitted_at: string;
  status: SubmissionStatus;
  submitter_kind: SubmitterKind;
  submitter_email: string | null;
  splash_notes: string | null;
  payload: Record<string, unknown>;
  form_version_id: string;
  version: {
    id: string;
    version_number: number;
    schema: unknown;
  } | null;
}

/**
 * List submissions for a form within a date range. Returns up to `limit + 1`
 * rows so the caller can detect overflow without an extra COUNT call.
 *
 * The `version:form_versions!inner(version_number)` embed uses the
 * `form_submissions.form_version_id → form_versions.id` FK. PostgREST returns
 * the embedded row as a single object (not array) because the FK is many-to-one
 * — that shape is the source of truth for the row mapping below.
 */
export async function listSubmissions(
  env: SupabaseEnv,
  args: ListSubmissionsArgs
): Promise<SubmissionListItem[]> {
  const url = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
  if (args.includePayload) {
    url.searchParams.set(
      "select",
      "id,submitted_at,status,submitter_kind,submitter_email,splash_notes,payload,form_version_id,version:form_versions!inner(id,version_number,schema)"
    );
  } else {
    url.searchParams.set(
      "select",
      "id,submitted_at,status,submitter_kind,submitter_email,splash_notes,version:form_versions!inner(version_number)"
    );
  }
  url.searchParams.set("form_id", `eq.${args.formId}`);
  url.searchParams.set("submitted_at", `gte.${args.fromIso}`);
  url.searchParams.append("submitted_at", `lte.${args.toIso}`);
  url.searchParams.set("order", "submitted_at.desc");
  url.searchParams.set("limit", String(args.limit));
  if (args.status && args.status !== "all") {
    url.searchParams.set("status", `eq.${args.status}`);
  }
  if (args.submitterKind && args.submitterKind !== "all") {
    url.searchParams.set("submitter_kind", `eq.${args.submitterKind}`);
  }

  const resp = await fetch(url.toString(), { headers: headers(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`listSubmissions: ${resp.status}: ${errText}`);
  }

  if (args.includePayload) {
    const rows = (await resp
      .json()
      .catch(() => [])) as ListSubmissionWithPayloadDbRow[];
    return rows.map((r) => {
      const splash = r.splash_notes ?? null;
      const schema =
        r.version?.schema && typeof r.version.schema === "object"
          ? (r.version.schema as FormSchema)
          : ({ fields: [] } as FormSchema);
      return {
        id: r.id,
        submitted_at: r.submitted_at,
        status: r.status,
        submitter_kind: r.submitter_kind,
        submitter_email: r.submitter_email,
        version_number: r.version?.version_number ?? null,
        splash_notes_preview: splash ? splash.slice(0, 80) : null,
        splash_notes_truncated: splash ? splash.length > 80 : false,
        payload: r.payload ?? {},
        splash_notes: splash,
        form_version_id: r.form_version_id,
        version: r.version
          ? {
              id: r.version.id,
              version_number: r.version.version_number,
              schema
            }
          : undefined
      };
    });
  }

  const rows = (await resp.json().catch(() => [])) as ListSubmissionDbRow[];
  return rows.map((r) => {
    const splash = r.splash_notes ?? null;
    return {
      id: r.id,
      submitted_at: r.submitted_at,
      status: r.status,
      submitter_kind: r.submitter_kind,
      submitter_email: r.submitter_email,
      version_number: r.version?.version_number ?? null,
      splash_notes_preview: splash ? splash.slice(0, 80) : null,
      splash_notes_truncated: splash ? splash.length > 80 : false
    };
  });
}

// =============================================================================
// getSubmission
// =============================================================================

export interface SubmissionFile {
  id: string;
  field_key: string;
  r2_key: string;
  mime: string;
  size_bytes: number;
  original_filename: string | null;
}

export interface SubmissionVersionDetail {
  id: string;
  version_number: number;
  schema: FormSchema;
  published_at: string | null;
  published_by: string | null;
}

export interface SubmissionDetail {
  id: string;
  form_id: string;
  form_version_id: string;
  payload: Record<string, unknown>;
  submitter_kind: SubmitterKind;
  submitter_user_id: string | null;
  submitter_email: string | null;
  submitter_ip: string | null;
  submitted_at: string;
  status: SubmissionStatus;
  status_updated_at: string | null;
  status_updated_by: string | null;
  splash_notes: string | null;
  splash_notes_updated_at: string | null;
  splash_notes_updated_by: string | null;
  // Brief 120 — null when the submission's version had no workflow.
  workflow_stage: string | null;
  workflow_history: WorkflowHistoryEntry[];
  current_approver_emails: string[];
  version: SubmissionVersionDetail;
  files: SubmissionFile[];
}

interface SubmissionDetailDbRow {
  id: string;
  form_id: string;
  form_version_id: string;
  payload: Record<string, unknown>;
  submitter_kind: SubmitterKind;
  submitter_user_id: string | null;
  submitter_email: string | null;
  submitter_ip: string | null;
  submitted_at: string;
  status: SubmissionStatus;
  status_updated_at: string | null;
  status_updated_by: string | null;
  splash_notes: string | null;
  splash_notes_updated_at: string | null;
  splash_notes_updated_by: string | null;
  workflow_stage: string | null;
  workflow_history: WorkflowHistoryEntry[] | null;
  current_approver_emails: string[] | null;
  version: {
    id: string;
    version_number: number;
    schema: unknown;
    published_at: string | null;
    published_by: string | null;
  } | null;
  files: SubmissionFile[] | null;
}

/**
 * Read a single submission with its version's schema + every uploaded file
 * row. Returns null when the (formId, subId) pair doesn't exist — the caller
 * 404s.
 */
export async function getSubmission(
  env: SupabaseEnv,
  formId: string,
  subId: string
): Promise<SubmissionDetail | null> {
  const url = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
  url.searchParams.set(
    "select",
    [
      "id",
      "form_id",
      "form_version_id",
      "payload",
      "submitter_kind",
      "submitter_user_id",
      "submitter_email",
      "submitter_ip",
      "submitted_at",
      "status",
      "status_updated_at",
      "status_updated_by",
      "splash_notes",
      "splash_notes_updated_at",
      "splash_notes_updated_by",
      "workflow_stage",
      "workflow_history",
      "current_approver_emails",
      "version:form_versions!inner(id,version_number,schema,published_at,published_by)",
      "files:form_submission_files(id,field_key,r2_key,mime,size_bytes,original_filename)"
    ].join(",")
  );
  url.searchParams.set("id", `eq.${subId}`);
  url.searchParams.set("form_id", `eq.${formId}`);
  url.searchParams.set("limit", "1");

  const resp = await fetch(url.toString(), { headers: headers(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`getSubmission: ${resp.status}: ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as SubmissionDetailDbRow[];
  const row = rows[0];
  if (!row || !row.version) return null;

  const schema =
    row.version.schema && typeof row.version.schema === "object"
      ? (row.version.schema as FormSchema)
      : ({ fields: [] } as FormSchema);

  return {
    id: row.id,
    form_id: row.form_id,
    form_version_id: row.form_version_id,
    payload: row.payload,
    submitter_kind: row.submitter_kind,
    submitter_user_id: row.submitter_user_id,
    submitter_email: row.submitter_email,
    submitter_ip: row.submitter_ip,
    submitted_at: row.submitted_at,
    status: row.status,
    status_updated_at: row.status_updated_at,
    status_updated_by: row.status_updated_by,
    splash_notes: row.splash_notes,
    splash_notes_updated_at: row.splash_notes_updated_at,
    splash_notes_updated_by: row.splash_notes_updated_by,
    workflow_stage: row.workflow_stage,
    workflow_history: row.workflow_history ?? [],
    current_approver_emails: row.current_approver_emails ?? [],
    version: {
      id: row.version.id,
      version_number: row.version.version_number,
      schema,
      published_at: row.version.published_at,
      published_by: row.version.published_by
    },
    files: row.files ?? []
  };
}

// =============================================================================
// transitionSubmission (Brief 120 — workflow stage flip + history append)
// =============================================================================

export interface TransitionPatch {
  workflow_stage: string;
  workflow_history: WorkflowHistoryEntry[];
  current_approver_emails: string[];
}

/**
 * Brief 120 — single PATCH writes the new stage id, the appended history
 * array, and the recomputed approver-emails list atomically. The handler
 * computes the appended `workflow_history` value locally (reads current,
 * appends, writes the whole array back); PostgREST has no native
 * `array_append` over JSONB so the read-modify-write here is the
 * idiomatic shape. Returns the row on success or null when no row
 * matched the (formId, subId) pair.
 */
export async function transitionSubmission(
  env: SupabaseEnv,
  formId: string,
  subId: string,
  patch: TransitionPatch
): Promise<{ id: string } | null> {
  const url = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${subId}`);
  url.searchParams.set("form_id", `eq.${formId}`);
  url.searchParams.set("select", "id");

  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      workflow_stage: patch.workflow_stage,
      workflow_history: patch.workflow_history,
      current_approver_emails: patch.current_approver_emails
    })
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`transitionSubmission: ${resp.status}: ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as Array<{ id: string }>;
  return rows[0] ?? null;
}

// =============================================================================
// updateSubmission (splash_notes + status, last-write-wins)
// =============================================================================

export interface UpdateSubmissionPatch {
  splash_notes?: string;
  status?: SubmissionStatus;
}

/**
 * Update splash_notes and/or status on one submission. Both fields are
 * optional; passing neither throws a precondition error from the caller
 * (handler validates before invoking). Audit columns
 * (`{splash_notes,status}_updated_{at,by}`) are stamped automatically when
 * the matching field is in the patch.
 *
 * Returns the row the PATCH yielded, or null when no row matched the
 * (formId, subId) pair.
 */
export async function updateSubmission(
  env: SupabaseEnv,
  formId: string,
  subId: string,
  userId: string,
  patch: UpdateSubmissionPatch
): Promise<{ id: string } | null> {
  const body: Record<string, unknown> = {};
  const now = new Date().toISOString();
  if (patch.splash_notes !== undefined) {
    body.splash_notes = patch.splash_notes;
    body.splash_notes_updated_at = now;
    body.splash_notes_updated_by = userId;
  }
  if (patch.status !== undefined) {
    body.status = patch.status;
    body.status_updated_at = now;
    body.status_updated_by = userId;
  }

  const url = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${subId}`);
  url.searchParams.set("form_id", `eq.${formId}`);
  url.searchParams.set("select", "id");

  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`updateSubmission: ${resp.status}: ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as Array<{ id: string }>;
  return rows[0] ?? null;
}

// =============================================================================
// listSubmissionsForCsv
// =============================================================================

export interface SubmissionCsvRow {
  id: string;
  payload: Record<string, unknown>;
  submitter_kind: SubmitterKind;
  submitter_email: string | null;
  submitted_at: string;
  status: SubmissionStatus;
  splash_notes: string | null;
  version_number: number;
  schema: FormSchema;
}

interface SubmissionCsvDbRow {
  id: string;
  payload: Record<string, unknown>;
  submitter_kind: SubmitterKind;
  submitter_email: string | null;
  submitted_at: string;
  status: SubmissionStatus;
  splash_notes: string | null;
  version: { version_number: number; schema: unknown } | null;
}

/**
 * Wide-table read for the CSV export. Pulls every submission in the date
 * range plus its version's schema (so the caller can compute the column-key
 * union — see admin/submissions.ts:handleSubmissionsCsv).
 *
 * Capped at 10000 rows. The handler returns a 416 when the cap trips — the
 * operator must then narrow the date range (matches Brief 84's signups CSV
 * posture).
 */
export async function listSubmissionsForCsv(
  env: SupabaseEnv,
  formId: string,
  fromIso: string,
  toIso: string,
  limit: number
): Promise<SubmissionCsvRow[]> {
  const url = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
  url.searchParams.set(
    "select",
    "id,payload,submitter_kind,submitter_email,submitted_at,status,splash_notes,version:form_versions!inner(version_number,schema)"
  );
  url.searchParams.set("form_id", `eq.${formId}`);
  url.searchParams.set("submitted_at", `gte.${fromIso}`);
  url.searchParams.append("submitted_at", `lte.${toIso}`);
  url.searchParams.set("order", "submitted_at.desc");
  url.searchParams.set("limit", String(limit));

  const resp = await fetch(url.toString(), { headers: headers(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`listSubmissionsForCsv: ${resp.status}: ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as SubmissionCsvDbRow[];
  return rows
    .filter((r): r is SubmissionCsvDbRow & { version: NonNullable<SubmissionCsvDbRow["version"]> } => r.version != null)
    .map((r) => ({
      id: r.id,
      payload: r.payload,
      submitter_kind: r.submitter_kind,
      submitter_email: r.submitter_email,
      submitted_at: r.submitted_at,
      status: r.status,
      splash_notes: r.splash_notes,
      version_number: r.version.version_number,
      schema:
        r.version.schema && typeof r.version.schema === "object"
          ? (r.version.schema as FormSchema)
          : ({ fields: [] } as FormSchema)
    }));
}

// =============================================================================
// listVersionsWithCounts
// =============================================================================

export interface VersionListItem {
  id: string;
  version_number: number;
  is_draft: boolean;
  published_at: string | null;
  published_by: string | null;
  field_count: number;
  submission_count: number;
}

interface VersionListDbRow {
  id: string;
  version_number: number;
  is_draft: boolean;
  published_at: string | null;
  published_by: string | null;
  schema: unknown;
  submissions: Array<{ count: number }> | null;
}

/**
 * List every form_versions row for a form, descending by version_number,
 * with embedded submission counts via the FK column hint
 * `form_submissions!form_version_id(count)` (Brief 94's listForms pattern).
 *
 * `field_count` is computed off the schema JSONB locally — Postgres has no
 * built-in JSONB array length aggregator we'd want to call from PostgREST,
 * and the schema is small (≤ ~50 fields per form in practice).
 */
export async function listVersionsWithCounts(
  env: SupabaseEnv,
  formId: string
): Promise<VersionListItem[]> {
  const url = new URL("/rest/v1/form_versions", env.SUPABASE_URL);
  url.searchParams.set(
    "select",
    "id,version_number,is_draft,published_at,published_by,schema,submissions:form_submissions!form_version_id(count)"
  );
  url.searchParams.set("form_id", `eq.${formId}`);
  url.searchParams.set("order", "version_number.desc");

  const resp = await fetch(url.toString(), { headers: headers(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`listVersionsWithCounts: ${resp.status}: ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as VersionListDbRow[];
  return rows.map((r) => {
    const fields = (r.schema as { fields?: unknown[] } | null)?.fields ?? [];
    return {
      id: r.id,
      version_number: r.version_number,
      is_draft: r.is_draft,
      published_at: r.published_at,
      published_by: r.published_by,
      field_count: Array.isArray(fields) ? fields.length : 0,
      submission_count: r.submissions?.[0]?.count ?? 0
    };
  });
}
