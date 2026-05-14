// Brief 126 — My Requests cross-form query.
//
// Endpoint: GET /forms/admin/api/my-requests
//
// Auth: any authenticated session. The caller's email is matched against
// `form_submissions.submitter_email` (Brief 120 normalizes the column at
// insert time — lower-cased + trimmed — so an `eq` filter is sufficient).
// Surfaces submissions the caller submitted, with their current workflow
// status — companion to Brief 121's Pending Approvals, which shows
// submissions waiting on the caller.
//
// Query params:
//   status=waiting|done|all  (default: all)
//   limit=N                  (default 200, max 500)
//   offset=N                 (default 0)
//
// `waiting` = stage with approver_source (still in flight).
// `done`    = stage is an outcome (no approver_source AND no transitions out
//             OR explicit Brief 125 `kind === "outcome"` hint).
// `all`     = both buckets.
//
// Submissions without a workflow (`workflow_stage IS NULL`) are filtered
// out at the SQL layer — they have no status to display in this view.
//
// 500-row safety cap matches Brief 121 — a submitter with more than that
// has bigger problems and the UI prompts them to narrow.

import { authenticate } from "@splash/auth";
import { jsonError } from "@splash/http";
import type {
  FormSchema,
  WorkflowHistoryEntry,
  WorkflowStage
} from "@splash/forms-schema";
import { requireServiceKey } from "./auth.js";
import type { Env } from "../index.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export type StatusFilter = "waiting" | "done" | "all";
export type StatusKind = "waiting" | "outcome";
export type StatusTint = "info" | "success" | "danger" | "warning" | "neutral";

export interface MyRequestItem {
  submission_id: string;
  form_id: string;
  form_title: string;
  workflow_stage: string;
  stage_label: string;
  status_kind: StatusKind;
  status_tint: StatusTint;
  current_approver_emails: string[];
  submitted_at: string;
  outcome_reached_at: string | null;
  detail_path: string;
}

interface MyRequestDbRow {
  id: string;
  form_id: string;
  workflow_stage: string | null;
  workflow_history: WorkflowHistoryEntry[] | null;
  current_approver_emails: string[] | null;
  submitted_at: string;
  form: { id: string; title: string } | null;
  version: { id: string; schema: unknown } | null;
}

export async function handleMyRequests(
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
  const callerEmail = session.email.trim().toLowerCase();

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const status: StatusFilter =
    statusParam === "waiting" || statusParam === "done" ? statusParam : "all";

  const requestedLimit = parseIntParam(url.searchParams.get("limit"), DEFAULT_LIMIT);
  const limit = Math.min(Math.max(1, requestedLimit), MAX_LIMIT);
  const offset = Math.max(0, parseIntParam(url.searchParams.get("offset"), 0));

  // PostgREST query — submitter_email is normalized at insert time
  // (Brief 120), so `eq` against the lowercased caller is correct.
  // workflow_stage IS NOT NULL filters out submissions made against a
  // version with no workflow — Brief 126 v1 only surfaces workflow-
  // enabled submissions.
  const pgUrl = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
  pgUrl.searchParams.set(
    "select",
    [
      "id",
      "form_id",
      "workflow_stage",
      "workflow_history",
      "current_approver_emails",
      "submitted_at",
      "form:forms!inner(id,title)",
      "version:form_versions!inner(id,schema)"
    ].join(",")
  );
  pgUrl.searchParams.set("submitter_email", `eq.${callerEmail}`);
  pgUrl.searchParams.set("workflow_stage", "not.is.null");
  pgUrl.searchParams.set("order", "submitted_at.desc");
  pgUrl.searchParams.set("limit", String(limit));
  pgUrl.searchParams.set("offset", String(offset));

  let resp: Response;
  try {
    resp = await fetch(pgUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("[forms.my-requests] fetch threw", err);
    return jsonError(500, "list_failed");
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error(
      "[forms.my-requests] supabase returned",
      resp.status,
      errText
    );
    return jsonError(500, "list_failed");
  }

  const rows = (await resp.json().catch(() => [])) as MyRequestDbRow[];
  const limitHit = rows.length >= limit;

  const items: MyRequestItem[] = [];
  for (const r of rows) {
    if (!r.workflow_stage || !r.form || !r.version) continue;
    const schema =
      r.version.schema && typeof r.version.schema === "object"
        ? (r.version.schema as FormSchema)
        : ({ fields: [] } as FormSchema);
    const stage = schema.workflow?.stages.find((s) => s.id === r.workflow_stage);
    const statusKind: StatusKind = stage
      ? stageIsOutcome(stage)
        ? "outcome"
        : "waiting"
      : // Stage referenced by workflow_stage isn't in the row's version
        // schema (rare — typically only via hand-edited form_versions
        // JSONB). Surface as neutral.
        "outcome";
    if (status === "waiting" && statusKind !== "waiting") continue;
    if (status === "done" && statusKind !== "outcome") continue;

    const statusTint: StatusTint =
      statusKind === "waiting"
        ? "info"
        : resolveOutcomeTint(stage, r.workflow_stage);

    items.push({
      submission_id: r.id,
      form_id: r.form_id,
      form_title: r.form.title,
      workflow_stage: r.workflow_stage,
      stage_label: stage?.label ?? r.workflow_stage,
      status_kind: statusKind,
      status_tint: statusTint,
      current_approver_emails:
        statusKind === "waiting" ? r.current_approver_emails ?? [] : [],
      submitted_at: r.submitted_at,
      outcome_reached_at:
        statusKind === "outcome"
          ? resolveOutcomeReachedAt(r.workflow_history, schema, r.workflow_stage)
          : null,
      detail_path: `/admin/forms/${r.form_id}/submissions/${r.id}`
    });
  }

  return new Response(
    JSON.stringify({
      items,
      total: items.length,
      scope: status,
      caller_email: callerEmail,
      limit_hit: limitHit
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
 * Brief 125 predicate — a stage is an outcome iff `kind === "outcome"` OR
 * (no approver_source AND no transitions out). Mirrors
 * `workflowStageIsOutcome` in `apps/forms-worker/src/notifications.ts`
 * (kept as a private duplicate so the my-requests endpoint doesn't pull
 * the notifications module into a path that doesn't need it).
 */
function stageIsOutcome(stage: WorkflowStage): boolean {
  if (stage.kind === "outcome") return true;
  if (stage.kind === "step") return false;
  return stage.transitions.length === 0 && !stage.approver_source;
}

/**
 * Tint resolution per Brief 126: prefer Brief 125's `stage.tint` when set,
 * fall back to a label-keyword heuristic ("approv*" → success, "den*" →
 * danger), else neutral. Unknown / missing stage collapses to neutral.
 */
function resolveOutcomeTint(
  stage: WorkflowStage | undefined,
  stageId: string
): StatusTint {
  if (stage?.tint) return stage.tint;
  const label = (stage?.label ?? stageId).toLowerCase();
  if (/\bapprov/.test(label)) return "success";
  if (/\bden/.test(label)) return "danger";
  return "neutral";
}

/**
 * Walk `workflow_history` from newest entry backward; return the first
 * entry whose `to` matches the current outcome stage id. That's when the
 * submission landed in its current outcome. Null when no matching entry
 * exists (e.g., the schema was hand-edited or the submission predates
 * the current stage configuration).
 */
function resolveOutcomeReachedAt(
  history: WorkflowHistoryEntry[] | null,
  _schema: FormSchema,
  currentStageId: string
): string | null {
  if (!history || history.length === 0) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry && entry.to === currentStageId) return entry.at;
  }
  return null;
}

function parseIntParam(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}
