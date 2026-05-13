// PostgREST helpers for the forms-worker.
//
// Pattern matches `@splash/db-supabase/maintainx-users.ts` (Brief 71): direct
// `fetch()` against PostgREST with the SUPABASE_SERVICE_KEY apikey + Bearer
// header pair. No `@supabase/supabase-js` client — keeps the worker bundle
// small and avoids dragging the SDK into a path where service-key writes
// happen via plain HTTP anyway.

import type { FormMeta, FormVersion, FormSchema, LocationOption } from "@splash/forms-schema";
import { formSchemaSchema } from "@splash/forms-schema";

interface SupabaseEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

const headers = (env: SupabaseEnv) => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
});

interface FormRow {
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

function rowToFormMeta(row: FormRow): FormMeta {
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
 * Look up a form by slug. Returns null when the row doesn't exist OR the
 * PostgREST call fails — render handler decides what to do (it 404s on
 * either case).
 */
export async function getFormBySlug(env: SupabaseEnv, slug: string): Promise<FormMeta | null> {
  const url = new URL("/rest/v1/forms", env.SUPABASE_URL);
  url.searchParams.set("slug", `eq.${slug}`);
  url.searchParams.set(
    "select",
    "id,slug,title,description,audience,status,current_version_id,draft_version_id,notify_webhook,success_message,turnstile_required"
  );
  url.searchParams.set("limit", "1");

  let response: Response;
  try {
    response = await fetch(url.toString(), { headers: headers(env) });
  } catch (err) {
    console.error("[forms] getFormBySlug: fetch threw", err);
    return null;
  }
  if (!response.ok) {
    console.error("[forms] getFormBySlug: returned", response.status);
    return null;
  }
  const rows = (await response.json().catch(() => [])) as FormRow[];
  const row = rows[0];
  if (!row) return null;
  return rowToFormMeta(row);
}

interface VersionRow {
  id: string;
  form_id: string;
  version_number: number;
  schema: unknown;        // jsonb — validated via formSchemaSchema before render
  is_draft: boolean;
  published_at: string | null;
  published_by: string | null;
}

/**
 * Read the form_versions row for a given (form, current_version_id) pair
 * and return it with the schema parsed + validated against the Zod
 * `formSchemaSchema`. Returns null if the row is missing or the schema
 * fails validation — caller 404s.
 *
 * The Zod parse is the runtime boundary check that prevents a hand-edited
 * `form_versions.schema` JSONB from breaking the render path. If a future
 * brief discovers a legitimate schema shape this rejects, extend the
 * `field-config.ts` validators rather than loosening this parse.
 */
export async function getCurrentVersion(
  env: SupabaseEnv,
  formId: string,
  currentVersionId: string
): Promise<FormVersion | null> {
  const url = new URL("/rest/v1/form_versions", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${currentVersionId}`);
  url.searchParams.set("form_id", `eq.${formId}`);
  url.searchParams.set(
    "select",
    "id,form_id,version_number,schema,is_draft,published_at,published_by"
  );
  url.searchParams.set("limit", "1");

  let response: Response;
  try {
    response = await fetch(url.toString(), { headers: headers(env) });
  } catch (err) {
    console.error("[forms] getCurrentVersion: fetch threw", err);
    return null;
  }
  if (!response.ok) {
    console.error("[forms] getCurrentVersion: returned", response.status);
    return null;
  }
  const rows = (await response.json().catch(() => [])) as VersionRow[];
  const row = rows[0];
  if (!row) return null;

  const parsed = formSchemaSchema.safeParse(row.schema);
  if (!parsed.success) {
    console.error("[forms] getCurrentVersion: schema parse failed", parsed.error.issues);
    return null;
  }
  const schema: FormSchema = parsed.data as FormSchema;
  return {
    id: row.id,
    formId: row.form_id,
    versionNumber: row.version_number,
    schema,
    isDraft: row.is_draft,
    publishedAt: row.published_at,
    publishedBy: row.published_by
  };
}

// =============================================================================
// Submission writes (Brief 91)
// =============================================================================

export interface SubmissionRow {
  id: string;
  formId: string;
  formVersionId: string;
  payload: Record<string, unknown>;
  submitterKind: "authenticated" | "anonymous";
  submitterUserId: string | null;
  submitterEmail: string | null;
  submitterIp: string | null;
  submittedAt: string;
  status: "new" | "in_progress" | "closed";
}

interface SubmissionDbRow {
  id: string;
  form_id: string;
  form_version_id: string;
  payload: Record<string, unknown>;
  submitter_kind: "authenticated" | "anonymous";
  submitter_user_id: string | null;
  submitter_email: string | null;
  submitter_ip: string | null;
  submitted_at: string;
  status: "new" | "in_progress" | "closed";
}

function rowToSubmission(r: SubmissionDbRow): SubmissionRow {
  return {
    id: r.id,
    formId: r.form_id,
    formVersionId: r.form_version_id,
    payload: r.payload,
    submitterKind: r.submitter_kind,
    submitterUserId: r.submitter_user_id,
    submitterEmail: r.submitter_email,
    submitterIp: r.submitter_ip,
    submittedAt: r.submitted_at,
    status: r.status
  };
}

export interface InsertSubmissionArgs {
  pendingSubmissionId: string;
  formId: string;
  formVersionId: string;
  payload: Record<string, unknown>;
  submitterKind: "authenticated" | "anonymous";
  submitterUserId: string | null;
  submitterEmail: string | null;
  submitterIp: string | null;
  // Brief 120 — workflow seed values. Null when the form version has no
  // workflow block; otherwise the worker computes the default stage's
  // approver list before insert.
  workflowStage?: string | null;
  workflowHistory?: unknown[];
  currentApproverEmails?: string[];
}

/**
 * Insert one row into `form_submissions` keyed on the client-supplied
 * `pendingSubmissionId`. PostgREST `Prefer: resolution=ignore-duplicates`
 * gives us idempotent inserts (a network retry that POSTs the same
 * pending_submission_id is a no-op rather than a constraint violation),
 * matching planning Decision 4 / 6.
 *
 * On the conflict path PostgREST returns `[]` (or a 409 in some cases) —
 * we then SELECT the existing row by id so the caller always gets the
 * canonical submission back. The caller renders the success page either
 * way; idempotency is invisible to the user.
 *
 * Returns the row plus a `wasNew` flag for observability (Brief 97 may
 * use this to gate webhook fires — re-submits should NOT fire the webhook
 * a second time).
 */
export async function insertSubmissionIdempotent(
  env: SupabaseEnv,
  args: InsertSubmissionArgs
): Promise<{ row: SubmissionRow; wasNew: boolean }> {
  const insertUrl = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
  insertUrl.searchParams.set("on_conflict", "id");

  const body = JSON.stringify({
    id: args.pendingSubmissionId,
    form_id: args.formId,
    form_version_id: args.formVersionId,
    payload: args.payload,
    submitter_kind: args.submitterKind,
    submitter_user_id: args.submitterUserId,
    submitter_email: args.submitterEmail,
    submitter_ip: args.submitterIp,
    // Brief 120 — workflow seed. Pass-through null when the version
    // has no workflow; column default also accepts null.
    workflow_stage: args.workflowStage ?? null,
    workflow_history: args.workflowHistory ?? [],
    current_approver_emails: args.currentApproverEmails ?? []
    // submitted_at + status default server-side
  });

  const insertRes = await fetch(insertUrl.toString(), {
    method: "POST",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=representation,resolution=ignore-duplicates"
    },
    body
  });

  if (insertRes.ok) {
    const rows = (await insertRes.json().catch(() => [])) as SubmissionDbRow[];
    const inserted = rows[0];
    if (inserted) {
      return { row: rowToSubmission(inserted), wasNew: true };
    }
    // Empty array → conflict ignored. Fall through to read-back.
  } else if (insertRes.status !== 409) {
    // Anything besides 2xx or 409 is a hard failure.
    const errText = await insertRes.text().catch(() => "");
    throw new Error(`form_submissions insert failed: ${insertRes.status} ${errText}`);
  }

  // Conflict path — read the existing row.
  const selectUrl = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
  selectUrl.searchParams.set("id", `eq.${args.pendingSubmissionId}`);
  selectUrl.searchParams.set(
    "select",
    "id,form_id,form_version_id,payload,submitter_kind,submitter_user_id,submitter_email,submitter_ip,submitted_at,status"
  );
  selectUrl.searchParams.set("limit", "1");

  const selectRes = await fetch(selectUrl.toString(), { headers: headers(env) });
  if (!selectRes.ok) {
    const errText = await selectRes.text().catch(() => "");
    throw new Error(`form_submissions read-back failed: ${selectRes.status} ${errText}`);
  }
  const existingRows = (await selectRes.json().catch(() => [])) as SubmissionDbRow[];
  const existing = existingRows[0];
  if (!existing) {
    // Insert was reported as a conflict but read-back found nothing — should
    // be impossible barring a race-condition that violates the FK chain.
    throw new Error("form_submissions: conflict path returned no row");
  }
  return { row: rowToSubmission(existing), wasNew: false };
}

// =============================================================================
// Submission file rows (Brief 92)
// =============================================================================

export interface SubmissionFileRowInsert {
  submissionId: string;
  fieldKey: string;
  r2Key: string;
  mime: string;
  sizeBytes: number;
  originalFilename: string | null;
}

/**
 * Best-effort insert into `form_submission_files` for every file/signature
 * the submit handler resolved against R2. Caller invokes this AFTER the
 * canonical `form_submissions` row exists; the FK on submission_id is
 * therefore satisfied.
 *
 * Failure is intentionally non-fatal — the canonical submission row is
 * already inserted. A failed file-rows insert leaves R2 objects without a
 * matching DB row; Brief 97's daily cron picks them up as orphans (>24h,
 * no matching `form_submissions.id`). We log and move on so the submitter
 * still sees the success page.
 */
export async function insertSubmissionFiles(
  env: SupabaseEnv,
  rows: SubmissionFileRowInsert[]
): Promise<void> {
  if (rows.length === 0) return;
  const url = new URL("/rest/v1/form_submission_files", env.SUPABASE_URL);
  const body = JSON.stringify(
    rows.map((r) => ({
      submission_id: r.submissionId,
      field_key: r.fieldKey,
      r2_key: r.r2Key,
      mime: r.mime,
      size_bytes: r.sizeBytes,
      original_filename: r.originalFilename
    }))
  );
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        ...headers(env),
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body
    });
  } catch (err) {
    console.error("[forms] insertSubmissionFiles: fetch threw", err);
    return;
  }
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.error(
      "[forms] insertSubmissionFiles: returned",
      response.status,
      errText
    );
  }
}

// =============================================================================
// Pricing-simple location options (Brief 90)
// =============================================================================

interface PricingSimpleRow {
  location_code: string;
  location_pretty: string | null;
  address: string | null;
  site: string | null;
}

/**
 * Pre-bake the option list for any Location-type field in the form. Reads
 * every distinct `location_code` from `pricing_simple` and de-duplicates in
 * JS. No pricing-mode filter — matches signup-worker's admin-pricing
 * `listDistinctLocations` behavior. The operator is the source of truth on
 * which locations exist; if a location should be hidden from forms, its
 * pricing_simple rows should be removed via sysadmin.
 *
 * Brief 90 originally filtered `pricing IN ('full','partial')` — `'partial'`
 * is not a valid mode (canonical set per sysadmin's VALID_PRICING_MODES is
 * `full | same | flash5 | flash2 | special`), so the filter silently dropped
 * every non-`full` location. Removed entirely rather than enumerating the
 * valid set: matches signup admin, future-proof against new modes, and
 * defers the "is this location active?" question to the operator's data.
 *
 * Why we don't use PostgREST `distinct` — PostgREST's `distinct` requires
 * column ordering coordination and doesn't compose well with multiple
 * select columns. Cheaper to fetch ordered rows and de-dup in JS.
 */
export async function getLocationOptionsFromPricingSimple(
  env: SupabaseEnv
): Promise<LocationOption[]> {
  const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  url.searchParams.set("select", "location_code,location_pretty,address,site");
  url.searchParams.set("order", "location_code.asc,sort.asc");
  url.searchParams.set("limit", "5000");

  let response: Response;
  try {
    response = await fetch(url.toString(), { headers: headers(env) });
  } catch (err) {
    console.error("[forms] getLocationOptionsFromPricingSimple: fetch threw", err);
    return [];
  }
  if (!response.ok) {
    console.error("[forms] getLocationOptionsFromPricingSimple: returned", response.status);
    return [];
  }
  const rows = (await response.json().catch(() => [])) as PricingSimpleRow[];
  const out: LocationOption[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.location_code || seen.has(r.location_code)) continue;
    seen.add(r.location_code);
    out.push({
      code: r.location_code,
      pretty: r.location_pretty ?? r.location_code,
      address: r.address ?? "",
      site: r.site ?? ""
    });
  }
  return out;
}
