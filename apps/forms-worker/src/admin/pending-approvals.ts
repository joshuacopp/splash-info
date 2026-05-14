// Brief 121 — Pending Approvals cross-form query.
//
// Endpoint: GET /forms/admin/api/pending-approvals
//
// Auth: any authenticated session. The caller's email is matched against
// `form_submissions.current_approver_emails` (Brief 120's denormalized
// GIN-indexed column) to surface "items waiting on me" across every form
// in one query.
//
// `?all=1` widens the result set to every pending approval in the org,
// gated to admin-tier (super_admin / dcRole admin / dcRole super_admin).
// Used by the Pending Approvals page's "All Approvals" toggle for ops
// oversight.
//
// The stage label is resolved server-side from the submission's version
// schema (`workflow.stages[*].label` keyed on `workflow_stage`) so apps/web
// doesn't have to walk the schema for every row.
//
// 500-row safety cap matches the brief — a single user with more pending
// than that has bigger problems and the dashboard prompts them to filter.

import { authenticate } from "@splash/auth";
import { jsonError } from "@splash/http";
import type { FormSchema } from "@splash/forms-schema";
import { requireServiceKey } from "./auth.js";
import type { Env } from "../index.js";

const PENDING_LIMIT = 500;

export interface PendingApprovalItem {
  submission_id: string;
  form_id: string;
  form_title: string;
  workflow_stage: string;
  stage_label: string;
  current_approver_emails: string[];
  submitter_email: string | null;
  submitter_kind: "authenticated" | "anonymous";
  submitted_at: string;
  /** Best-effort: the submission's Location field value (slug) when present. */
  location_code: string | null;
  /** Direct link target for the Review button. */
  review_path: string;
  /**
   * Brief 131 — set to "empty" when the row's `approver_source` exists
   * but resolution produced no emails (a misconfigured picker, mid-form
   * data drift, etc.). The All Approvals admin view surfaces a
   * "No approver resolved" warning pill on these so admins can spot
   * stuck workflows. Always "resolved" for `scope === "me"` because
   * empty-approver rows can't match the caller's email anyway.
   */
  approver_resolution_status: "resolved" | "empty";
}

interface PendingApprovalDbRow {
  id: string;
  form_id: string;
  workflow_stage: string | null;
  submitter_email: string | null;
  submitter_kind: "authenticated" | "anonymous";
  submitted_at: string;
  current_approver_emails: string[] | null;
  payload: Record<string, unknown>;
  form: { id: string; title: string } | null;
  version: { id: string; schema: unknown } | null;
}

export async function handlePendingApprovals(
  env: Env,
  req: Request
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;

  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return jsonError(401, "unauthenticated");
  }
  const { session } = auth;
  const isAdminTier =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";

  const url = new URL(req.url);
  const wantsAll = url.searchParams.get("all") === "1";
  const scope: "me" | "all" = wantsAll && isAdminTier ? "all" : "me";

  const callerEmail = session.email.trim().toLowerCase();

  // PostgREST query against form_submissions with the GIN-indexed
  // `current_approver_emails` column. `cs` ({email}) = "contains" — the
  // GIN index from Brief 120 covers this operator. `not.eq.is.null` on
  // workflow_stage excludes legacy / no-workflow rows. Embed form title
  // + version schema for stage label resolution.
  const pgUrl = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
  pgUrl.searchParams.set(
    "select",
    [
      "id",
      "form_id",
      "workflow_stage",
      "submitter_email",
      "submitter_kind",
      "submitted_at",
      "current_approver_emails",
      "payload",
      "form:forms!inner(id,title)",
      "version:form_versions!inner(id,schema)"
    ].join(",")
  );
  pgUrl.searchParams.set("workflow_stage", "not.is.null");
  if (scope === "me") {
    // PostgREST array-contains: column.cs.{value}
    pgUrl.searchParams.set(
      "current_approver_emails",
      `cs.{${escapePgrstArrayLiteral(callerEmail)}}`
    );
  }
  // Brief 131 — All Approvals (scope === "all") drops the
  // `current_approver_emails != {}` filter so admin oversight can spot
  // rows whose approver resolution failed (stuck workflow diagnostic).
  // The per-row `approver_resolution_status` field below tells the
  // apps/web caller which rows need the "No approver resolved" pill.
  // Rows are still filtered to `workflow_stage IS NOT NULL` above, so
  // legacy non-workflow submissions are excluded.
  pgUrl.searchParams.set("order", "submitted_at.desc");
  pgUrl.searchParams.set("limit", String(PENDING_LIMIT));

  let resp: Response;
  try {
    resp = await fetch(pgUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("[forms.pending-approvals] fetch threw", err);
    return jsonError(500, "list_failed");
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error(
      "[forms.pending-approvals] supabase returned",
      resp.status,
      errText
    );
    return jsonError(500, "list_failed");
  }

  const rows = (await resp.json().catch(() => [])) as PendingApprovalDbRow[];
  const items: PendingApprovalItem[] = [];
  for (const r of rows) {
    if (!r.workflow_stage || !r.form || !r.version) continue;
    const schema =
      r.version.schema && typeof r.version.schema === "object"
        ? (r.version.schema as FormSchema)
        : ({ fields: [] } as FormSchema);
    const stage = schema.workflow?.stages.find((s) => s.id === r.workflow_stage);
    // Brief 131 — when scope=all and approver list is empty, the row is
    // only meaningful as a diagnostic surface if the stage actually
    // EXPECTS an approver (i.e., has an approver_source). Rows without
    // approver_source are terminal/email-step stages that shouldn't
    // appear in a "pending approval" feed; skip them.
    const approverEmails = r.current_approver_emails ?? [];
    const expectsApprover = Boolean(stage?.approver_source);
    if (scope === "all" && approverEmails.length === 0 && !expectsApprover) {
      continue;
    }
    items.push({
      submission_id: r.id,
      form_id: r.form_id,
      form_title: r.form.title,
      workflow_stage: r.workflow_stage,
      stage_label: stage?.label ?? r.workflow_stage,
      current_approver_emails: approverEmails,
      submitter_email: r.submitter_email,
      submitter_kind: r.submitter_kind,
      submitted_at: r.submitted_at,
      location_code: extractLocationCode(schema, r.payload),
      review_path: `/admin/forms/${r.form_id}/submissions/${r.id}`,
      approver_resolution_status:
        approverEmails.length === 0 && expectsApprover ? "empty" : "resolved"
    });
  }

  return new Response(
    JSON.stringify({
      items,
      total: items.length,
      scope,
      caller_email: callerEmail,
      limit_hit: items.length >= PENDING_LIMIT
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}

/**
 * Best-effort lookup: walk the version's schema for the first `location`
 * field (or `lookup` keyed on `pricing_simple.location_code`) and return
 * its payload value. Used by the apps/web list to render a "Site" column
 * without round-tripping the per-submission detail endpoint.
 *
 * Returns null when no candidate field is present or its payload entry is
 * missing. Mirrors `extractLocationCode` in `workflow-resolution.ts` —
 * kept as a private duplicate here so the list endpoint doesn't pull the
 * resolution module's helpers into a path that doesn't need them.
 */
function extractLocationCode(
  schema: FormSchema,
  payload: Record<string, unknown>
): string | null {
  for (const f of schema.fields) {
    const candidate =
      f.type === "location" ||
      (f.type === "lookup" && f.keyColumn === "pricing_simple.location_code");
    if (!candidate) continue;
    const v = payload[f.key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Escape an email for inclusion in a PostgREST text[] literal. PostgREST
 * uses `{a,b,c}` array syntax inside the `cs` operator argument; values
 * containing commas, braces, or double-quotes must be double-quoted and
 * inner quotes / backslashes escaped. Emails won't normally contain those
 * characters, but we defend against pathological inputs anyway.
 */
function escapePgrstArrayLiteral(value: string): string {
  if (/[,{}"\\\s]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}
