// Server-side fetch helpers for the forms-worker admin endpoints (Brief 94).
//
// Mirrors apps/web/app/admin/fleet/_lib/worker-fetch.ts (Brief 83/87) —
// service-binding-first, URL-fallback for `next dev`. Brief 95's admin
// builder pages are the consumer; the helpers throw on hard failures
// (non-2xx that aren't 401/403/404) so server actions can surface a
// typed ActionResult error via the Brief 19 <ActionForm> pattern.
//
// Bindings live in apps/web/wrangler.toml (`FORMS_WORKER`); the dev
// fallback URL comes from `NEXT_PUBLIC_FORMS_WORKER_URL` when set,
// otherwise the request host (apps/web staging is on the same zone via
// next.config.mjs rewrites — same posture as fleet, signups, etc.).

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type {
  FormMeta,
  FormSchema,
  LookupSource,
  WorkflowHistoryEntry
} from "@splash/forms-schema";

// =============================================================================
// Brief 96 — submission + version response shapes
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
  // Brief 119 — populated when listSubmissionsAdmin is called with
  // `include: "payload"`. Wide-table view reads these to render every
  // answer as a column without a per-row detail fetch.
  payload?: Record<string, unknown>;
  splash_notes?: string | null;
  form_version_id?: string;
  version?: SubmissionListVersion;
}

export interface SubmissionListResponse {
  items: SubmissionListItem[];
  limit_hit: boolean;
  from: string;
  to: string;
}

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

export interface TransitionPatchBody {
  to: string;
  note?: string;
  typed_name?: string;
  signature_r2_key?: string;
}

export interface TransitionResponse {
  ok: true;
  id: string;
  from: string;
  to: string;
  workflow_stage: string;
  workflow_history: WorkflowHistoryEntry[];
  current_approver_emails: string[];
}

export interface SubmissionDetailResponse {
  submission: SubmissionDetail;
}

export interface VersionListItem {
  id: string;
  version_number: number;
  is_draft: boolean;
  published_at: string | null;
  published_by: string | null;
  field_count: number;
  submission_count: number;
}

export interface VersionListResponse {
  items: VersionListItem[];
}

// =============================================================================
// Response shapes — mirror apps/forms-worker/src/db/admin-forms.ts
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

export interface FormListResponse {
  items: FormListItem[];
}

export interface FormVersionSummary {
  id: string;
  versionNumber: number;
  publishedAt: string | null;
  publishedBy: string | null;
  isDraft: boolean;
}

export interface FormDetail {
  form: FormMeta;
  draftSchema: FormSchema;
  currentVersionNumber: number | null;
  versions: FormVersionSummary[];
}

export interface CreateFormArgs {
  slug: string;
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
}

export interface CreateFormResponse {
  form_id: string;
  draft_version_id: string;
}

export interface PublishResponse {
  published_version_number: number;
  new_draft_id: string;
}

export interface AssetUploadResponse {
  asset_id: string;
  r2_key: string;
  mime: string;
  size_bytes: number;
  alt_text: string;
}

export interface LookupSourcesResponse {
  sources: readonly LookupSource[];
}

// =============================================================================
// Internal: dispatch via service binding, fall back to URL fetch in dev
// =============================================================================

const FORMS_BINDING = "FORMS_WORKER" as const;

async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_FORMS_WORKER_URL;
  if (base) return `${base}${trimmed}`;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${trimmed}`;
}

interface CallOptions {
  method?: string;
  jsonBody?: unknown;
  formData?: FormData;
}

async function callForms(path: string, opts: CallOptions = {}): Promise<Response> {
  const method = opts.method ?? "GET";
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const reqInit: RequestInit & { duplex?: "half" } = { method };
  const reqHeaders = new Headers();
  reqHeaders.set("Cookie", cookieHeader);

  if (opts.jsonBody !== undefined) {
    reqHeaders.set("Content-Type", "application/json");
    reqInit.body = JSON.stringify(opts.jsonBody);
  } else if (opts.formData) {
    // Don't set Content-Type — fetch will populate it with the multipart
    // boundary parameter. Setting it manually breaks multipart parsing.
    reqInit.body = opts.formData;
  }

  // Service-binding path (production / preview / staging).
  try {
    const { env } = await getCloudflareContext({ async: true });
    const binding = env[FORMS_BINDING];
    if (binding) {
      const internalUrl = `https://internal${path.startsWith("/") ? path : `/${path}`}`;
      if (method !== "GET" && method !== "HEAD") {
        reqHeaders.set("Origin", new URL(internalUrl).origin);
      }
      const internalReq = new Request(internalUrl, {
        ...reqInit,
        headers: reqHeaders
      });
      return await binding.fetch(internalReq);
    }
  } catch {
    // fall through to URL fallback
  }

  // URL fallback (next dev, where the binding isn't available).
  const url = await workerUrl(path);
  if (method !== "GET" && method !== "HEAD") {
    reqHeaders.set("Origin", new URL(url).origin);
  }
  return await fetch(url, {
    ...reqInit,
    headers: reqHeaders,
    cache: "no-store"
  });
}

async function readJson<T>(resp: Response, label: string): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${label} failed: ${resp.status}${text ? ` — ${text}` : ""}`);
  }
  return (await resp.json()) as T;
}

// =============================================================================
// Public helpers
// =============================================================================

export interface ListFormsParams {
  status?: string;
  search?: string;
  audience?: string;
}

export async function listFormsAdmin(
  params: ListFormsParams = {}
): Promise<FormListResponse | null> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.search) qs.set("search", params.search);
  if (params.audience) qs.set("audience", params.audience);
  const path = `/forms/admin/api/forms${qs.toString() ? `?${qs}` : ""}`;
  const resp = await callForms(path);
  if (resp.status === 401 || resp.status === 403) return null;
  return readJson<FormListResponse>(resp, "listFormsAdmin");
}

export async function createFormAdmin(args: CreateFormArgs): Promise<CreateFormResponse> {
  const resp = await callForms("/forms/admin/api/forms", {
    method: "POST",
    jsonBody: args
  });
  return readJson<CreateFormResponse>(resp, "createFormAdmin");
}

export async function getFormAdmin(formId: string): Promise<FormDetail | null> {
  const resp = await callForms(`/forms/admin/api/forms/${encodeURIComponent(formId)}`);
  if (resp.status === 401 || resp.status === 403 || resp.status === 404) return null;
  return readJson<FormDetail>(resp, "getFormAdmin");
}

export async function updateDraftAdmin(
  formId: string,
  schema: FormSchema
): Promise<void> {
  const resp = await callForms(
    `/forms/admin/api/forms/${encodeURIComponent(formId)}/draft`,
    {
      method: "PATCH",
      jsonBody: { schema }
    }
  );
  await readJson<{ ok: true }>(resp, "updateDraftAdmin");
}

export async function publishFormAdmin(formId: string): Promise<PublishResponse> {
  const resp = await callForms(
    `/forms/admin/api/forms/${encodeURIComponent(formId)}/publish`,
    { method: "POST" }
  );
  return readJson<PublishResponse>(resp, "publishFormAdmin");
}

export async function unpublishFormAdmin(formId: string): Promise<void> {
  const resp = await callForms(
    `/forms/admin/api/forms/${encodeURIComponent(formId)}/unpublish`,
    { method: "POST" }
  );
  await readJson<{ ok: true; status: "archived" }>(resp, "unpublishFormAdmin");
}

export async function republishFormAdmin(formId: string): Promise<void> {
  const resp = await callForms(
    `/forms/admin/api/forms/${encodeURIComponent(formId)}/republish`,
    { method: "POST" }
  );
  await readJson<{ ok: true; status: "published" }>(resp, "republishFormAdmin");
}

export async function uploadFormAssetAdmin(
  formId: string,
  file: File,
  altText: string
): Promise<AssetUploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("alt_text", altText);
  const resp = await callForms(
    `/forms/admin/api/forms/${encodeURIComponent(formId)}/assets`,
    { method: "POST", formData }
  );
  return readJson<AssetUploadResponse>(resp, "uploadFormAssetAdmin");
}

export async function deleteFormAssetAdmin(formId: string, assetId: string): Promise<void> {
  const resp = await callForms(
    `/forms/admin/api/forms/${encodeURIComponent(formId)}/assets/${encodeURIComponent(assetId)}`,
    { method: "DELETE" }
  );
  await readJson<{ ok: true }>(resp, "deleteFormAssetAdmin");
}

export async function getLookupSourcesAdmin(): Promise<LookupSourcesResponse | null> {
  const resp = await callForms("/forms/admin/api/lookup-sources");
  if (resp.status === 401 || resp.status === 403) return null;
  return readJson<LookupSourcesResponse>(resp, "getLookupSourcesAdmin");
}

// =============================================================================
// Brief 96 — submissions admin helpers
// =============================================================================

export interface ListSubmissionsParams {
  from?: string;
  to?: string;
  status?: string;
  submitter_kind?: string;
  limit?: number;
  include?: "payload";
}

export async function listSubmissionsAdmin(
  formId: string,
  params: ListSubmissionsParams = {}
): Promise<SubmissionListResponse | null> {
  const qs = new URLSearchParams();
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.status) qs.set("status", params.status);
  if (params.submitter_kind) qs.set("submitter_kind", params.submitter_kind);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.include) qs.set("include", params.include);
  const path = `/forms/admin/api/forms/${encodeURIComponent(formId)}/submissions${
    qs.toString() ? `?${qs}` : ""
  }`;
  const resp = await callForms(path);
  if (resp.status === 401 || resp.status === 403) return null;
  return readJson<SubmissionListResponse>(resp, "listSubmissionsAdmin");
}

export async function getSubmissionAdmin(
  formId: string,
  subId: string
): Promise<SubmissionDetail | null> {
  const resp = await callForms(
    `/forms/admin/api/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(subId)}`
  );
  if (resp.status === 401 || resp.status === 403 || resp.status === 404) return null;
  const data = await readJson<SubmissionDetailResponse>(resp, "getSubmissionAdmin");
  return data.submission;
}

export async function updateSubmissionAdmin(
  formId: string,
  subId: string,
  patch: { splash_notes?: string; status?: SubmissionStatus }
): Promise<void> {
  const resp = await callForms(
    `/forms/admin/api/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(subId)}`,
    {
      method: "PATCH",
      jsonBody: patch
    }
  );
  await readJson<{ ok: true; id: string }>(resp, "updateSubmissionAdmin");
}

/**
 * Build the same-origin URL for the CSV export. Forms is path-carved
 * (Brief 89 / planning Decision 2), so the apps/web Worker and splash-forms
 * share a hostname — the browser can hit `/forms/admin/api/...` directly
 * with no Brief 88-style proxy route. Cookies travel along same-origin and
 * the splash-forms worker handles auth + CSV streaming.
 */
export function getSubmissionsCsvUrl(
  formId: string,
  params: { from?: string; to?: string } = {}
): string {
  const qs = new URLSearchParams();
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  return `/forms/admin/api/forms/${encodeURIComponent(formId)}/submissions.csv${
    qs.toString() ? `?${qs}` : ""
  }`;
}

export async function listVersionsAdmin(
  formId: string
): Promise<VersionListResponse | null> {
  const resp = await callForms(
    `/forms/admin/api/forms/${encodeURIComponent(formId)}/versions`
  );
  if (resp.status === 401 || resp.status === 403) return null;
  return readJson<VersionListResponse>(resp, "listVersionsAdmin");
}

// =============================================================================
// Brief 120 — workflow transition
// =============================================================================
//
// The forms-worker transition endpoint accepts any-session auth (per-stage
// authority is gated against `current_approver_emails` server-side; admin
// tier bypasses). 403 with `{error:"not_approver", allowed_emails}` is
// re-surfaced verbatim so the caller can render a "not your stage" hint.

export type TransitionResult =
  | TransitionResponse
  | { ok: false; error: string; allowed_emails?: string[]; missing?: string[] };

export async function transitionSubmissionAdmin(
  formId: string,
  subId: string,
  body: TransitionPatchBody
): Promise<TransitionResult> {
  const resp = await callForms(
    `/forms/admin/api/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(subId)}/transition`,
    { method: "POST", jsonBody: body }
  );
  if (!resp.ok) {
    let parsed: {
      error?: string;
      allowed_emails?: string[];
      missing?: string[];
    } = {};
    try {
      parsed = (await resp.json()) as typeof parsed;
    } catch {
      // body wasn't JSON
    }
    return {
      ok: false,
      error: parsed.error ?? `HTTP ${resp.status}`,
      allowed_emails: parsed.allowed_emails,
      missing: parsed.missing
    };
  }
  return (await resp.json()) as TransitionResponse;
}

// =============================================================================
// Brief 121 — Pending Approvals cross-form list
// =============================================================================

export interface PendingApprovalItem {
  submission_id: string;
  form_id: string;
  form_title: string;
  workflow_stage: string;
  stage_label: string;
  current_approver_emails: string[];
  submitter_email: string | null;
  submitter_kind: SubmitterKind;
  submitted_at: string;
  location_code: string | null;
  review_path: string;
}

export interface PendingApprovalsResponse {
  items: PendingApprovalItem[];
  total: number;
  scope: "me" | "all";
  caller_email: string;
  limit_hit: boolean;
}

export async function listPendingApprovalsAdmin(
  params: { all?: boolean } = {}
): Promise<PendingApprovalsResponse | null> {
  const qs = new URLSearchParams();
  if (params.all) qs.set("all", "1");
  const path = `/forms/admin/api/pending-approvals${
    qs.toString() ? `?${qs}` : ""
  }`;
  const resp = await callForms(path);
  if (resp.status === 401 || resp.status === 403) return null;
  return readJson<PendingApprovalsResponse>(resp, "listPendingApprovalsAdmin");
}

// =============================================================================
// Brief 126 — My Requests cross-form list
// =============================================================================

export type MyRequestStatusFilter = "waiting" | "done" | "all";
export type MyRequestStatusKind = "waiting" | "outcome";
export type MyRequestStatusTint =
  | "info"
  | "success"
  | "danger"
  | "warning"
  | "neutral";

export interface MyRequestItem {
  submission_id: string;
  form_id: string;
  form_title: string;
  workflow_stage: string;
  stage_label: string;
  status_kind: MyRequestStatusKind;
  status_tint: MyRequestStatusTint;
  current_approver_emails: string[];
  submitted_at: string;
  outcome_reached_at: string | null;
  detail_path: string;
}

export interface MyRequestsResponse {
  items: MyRequestItem[];
  total: number;
  scope: MyRequestStatusFilter;
  caller_email: string;
  limit_hit: boolean;
}

export async function listMyRequestsAdmin(
  params: {
    status?: MyRequestStatusFilter;
    limit?: number;
    offset?: number;
  } = {}
): Promise<MyRequestsResponse | null> {
  const qs = new URLSearchParams();
  if (params.status && params.status !== "all") qs.set("status", params.status);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  const path = `/forms/admin/api/my-requests${
    qs.toString() ? `?${qs}` : ""
  }`;
  const resp = await callForms(path);
  if (resp.status === 401 || resp.status === 403) return null;
  return readJson<MyRequestsResponse>(resp, "listMyRequestsAdmin");
}

// =============================================================================
// Brief 128 — Email queue admin viewer
// =============================================================================

export type EmailQueueStatus = "pending" | "claimed" | "sent" | "stuck";
export type EmailQueueStatusFilter = EmailQueueStatus | "all";

export interface EmailQueueListItem {
  id: string;
  source_worker: string;
  source_kind: string;
  source_id: string;
  recipient: string;
  subject: string;
  status: EmailQueueStatus;
  send_attempts: number;
  last_error: string | null;
  created_at: string;
  claimed_at: string | null;
  sent_at: string | null;
}

export interface EmailQueueAttachmentMeta {
  filename: string;
  mime: string;
  size_bytes: number;
  has_r2_key: boolean;
  has_base64: boolean;
}

export interface EmailQueueDetail extends EmailQueueListItem {
  cc: string[];
  reply_to: string | null;
  body_html: string | null;
  body_text: string | null;
  attachments: EmailQueueAttachmentMeta[];
  scheduled_for: string;
  claim_id: string | null;
}

export interface EmailQueueListResponse {
  items: EmailQueueListItem[];
  total: number | null;
  limit_hit: boolean;
  from: string;
  to: string;
}

export interface EmailQueueDetailResponse {
  item: EmailQueueDetail;
}

export interface ListEmailQueueParams {
  status?: EmailQueueStatusFilter;
  source_worker?: string;
  source_kind?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function listEmailQueueAdmin(
  params: ListEmailQueueParams = {}
): Promise<EmailQueueListResponse | null> {
  const qs = new URLSearchParams();
  if (params.status && params.status !== "all") qs.set("status", params.status);
  if (params.source_worker) qs.set("source_worker", params.source_worker);
  if (params.source_kind) qs.set("source_kind", params.source_kind);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  const path = `/forms/admin/api/email-queue/list${
    qs.toString() ? `?${qs}` : ""
  }`;
  const resp = await callForms(path);
  if (resp.status === 401 || resp.status === 403) return null;
  return readJson<EmailQueueListResponse>(resp, "listEmailQueueAdmin");
}

export async function getEmailQueueAdmin(
  id: string
): Promise<EmailQueueDetail | null> {
  const resp = await callForms(
    `/forms/admin/api/email-queue/${encodeURIComponent(id)}`
  );
  if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
    return null;
  }
  const data = await readJson<EmailQueueDetailResponse>(
    resp,
    "getEmailQueueAdmin"
  );
  return data.item;
}

export async function retryEmailQueueAdmin(id: string): Promise<void> {
  const resp = await callForms(
    `/forms/admin/api/email-queue/${encodeURIComponent(id)}/retry`,
    { method: "POST" }
  );
  await readJson<{ ok: true; id: string }>(resp, "retryEmailQueueAdmin");
}

export async function abandonEmailQueueAdmin(id: string): Promise<void> {
  const resp = await callForms(
    `/forms/admin/api/email-queue/${encodeURIComponent(id)}/abandon`,
    { method: "POST" }
  );
  await readJson<{ ok: true; id: string }>(resp, "abandonEmailQueueAdmin");
}
