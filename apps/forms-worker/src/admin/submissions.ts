// Brief 96 — admin submission handlers (read list / read one / patch
// splash_notes + status / CSV export).
//
// Routes (mounted in src/index.ts):
//
//   GET   /forms/admin/api/forms/{id}/submissions
//   GET   /forms/admin/api/forms/{id}/submissions.csv
//   GET   /forms/admin/api/forms/{id}/submissions/{subId}
//   PATCH /forms/admin/api/forms/{id}/submissions/{subId}
//
// Auth gate (super_admin OR dcRole admin/super_admin) lives in ./auth.ts;
// service-key-unbound 503 returned uniformly. PATCH also gates on
// `isOriginAllowed` (CSRF defense-in-depth).
//
// CSV is "schema-union across all versions in the date range" — the header
// row is the union of every field key ever used, and rows have empty cells
// where a key doesn't exist on a given submission's version. Schema-union
// is the right call for a multi-version form because per-version columns
// would diverge across submissions and break the wide-table shape.

import { authenticate } from "@splash/auth";
import { isOriginAllowed, jsonError } from "@splash/http";
import type {
  FormSchema,
  WorkflowHistoryEntry,
  WorkflowStage
} from "@splash/forms-schema";
import { adminGate, adminGateResponse, requireServiceKey } from "./auth.js";
import {
  listSubmissions,
  getSubmission,
  updateSubmission,
  listSubmissionsForCsv,
  transitionSubmission,
  type SubmissionStatus
} from "../db/admin-submissions.js";
import { resolveApproverEmails } from "../workflow-resolution.js";
import {
  fireAssignmentNotification,
  fireOutcomeNotification,
  getWorkflowNotifications,
  workflowStageIsOutcome,
  buildReviewUrl,
  buildActorHistory
} from "../notifications.js";
import type { Env } from "../index.js";

const FORM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUB_ID_RE = FORM_ID_RE;

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 200;
const CSV_ROW_CAP = 10000;

const STATUS_VALUES: readonly SubmissionStatus[] = [
  "new",
  "in_progress",
  "closed"
];

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface DateRange {
  fromDate: string;
  toDate: string;
  fromIso: string;
  toIso: string;
}

function resolveDateRange(url: URL): DateRange {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromDate = from ?? ymd(defaultFrom);
  const toDate = to ?? ymd(today);
  return {
    fromDate,
    toDate,
    fromIso: `${fromDate}T00:00:00Z`,
    toIso: `${toDate}T23:59:59Z`
  };
}

// =============================================================================
// GET /forms/admin/api/forms/{id}/submissions
// =============================================================================

export async function handleListSubmissions(
  env: Env,
  req: Request,
  formId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId)) return jsonError(400, "bad_id");

  const url = new URL(req.url);
  const range = resolveDateRange(url);
  const status = url.searchParams.get("status") ?? undefined;
  const submitterKind = url.searchParams.get("submitter_kind") ?? undefined;
  const requestedLimit = parseInt(
    url.searchParams.get("limit") ?? `${DEFAULT_LIST_LIMIT}`,
    10
  );
  const limit = Math.min(
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? requestedLimit
      : DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT
  );
  // Brief 119 — wide-table view asks for the full payload + per-row version
  // schema in one round-trip. Default shape stays back-compat: callers that
  // don't pass include=payload see the Brief 96 metadata-only response.
  const includePayload = url.searchParams.get("include") === "payload";

  try {
    const items = await listSubmissions(env, {
      formId,
      fromIso: range.fromIso,
      toIso: range.toIso,
      status,
      submitterKind,
      limit: limit + 1,
      includePayload
    });
    const limitHit = items.length > limit;
    const trimmed = limitHit ? items.slice(0, limit) : items;
    return new Response(
      JSON.stringify({
        items: trimmed,
        limit_hit: limitHit,
        from: range.fromDate,
        to: range.toDate
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (err) {
    console.error("[forms.admin] list submissions failed", err);
    return jsonError(500, "list_failed");
  }
}

// =============================================================================
// GET /forms/admin/api/forms/{id}/submissions/{subId}
// =============================================================================

export async function handleGetSubmission(
  env: Env,
  req: Request,
  formId: string,
  subId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId) || !SUB_ID_RE.test(subId)) {
    return jsonError(400, "bad_id");
  }

  try {
    const submission = await getSubmission(env, formId, subId);
    if (!submission) return jsonError(404, "not_found");
    return new Response(JSON.stringify({ submission }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    });
  } catch (err) {
    console.error("[forms.admin] get submission failed", err);
    return jsonError(500, "get_failed");
  }
}

// =============================================================================
// PATCH /forms/admin/api/forms/{id}/submissions/{subId}
// =============================================================================

export async function handlePatchSubmission(
  env: Env,
  req: Request,
  formId: string,
  subId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId) || !SUB_ID_RE.test(subId)) {
    return jsonError(400, "bad_id");
  }

  let body: { splash_notes?: unknown; status?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json");
  }

  const patch: { splash_notes?: string; status?: SubmissionStatus } = {};

  if (body.splash_notes !== undefined) {
    if (typeof body.splash_notes !== "string") {
      return jsonError(400, "bad_notes");
    }
    const trimmed = body.splash_notes.trim();
    if (trimmed.length > 10000) {
      return jsonError(400, "notes_too_long");
    }
    patch.splash_notes = trimmed;
  }

  if (body.status !== undefined) {
    if (
      typeof body.status !== "string" ||
      !STATUS_VALUES.includes(body.status as SubmissionStatus)
    ) {
      return jsonError(400, "bad_status");
    }
    patch.status = body.status as SubmissionStatus;
  }

  if (patch.splash_notes === undefined && patch.status === undefined) {
    return jsonError(400, "nothing_to_update");
  }

  try {
    const row = await updateSubmission(
      env,
      formId,
      subId,
      gate.session.userId,
      patch
    );
    if (!row) return jsonError(404, "not_found");
    return new Response(JSON.stringify({ ok: true, id: row.id }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("[forms.admin] patch submission failed", err);
    return jsonError(500, "patch_failed");
  }
}

// =============================================================================
// GET /forms/admin/api/forms/{id}/submissions.csv
// =============================================================================

export async function handleSubmissionsCsv(
  env: Env,
  req: Request,
  formId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId)) return jsonError(400, "bad_id");

  const url = new URL(req.url);
  const range = resolveDateRange(url);

  let submissions: Awaited<ReturnType<typeof listSubmissionsForCsv>>;
  try {
    submissions = await listSubmissionsForCsv(
      env,
      formId,
      range.fromIso,
      range.toIso,
      CSV_ROW_CAP
    );
  } catch (err) {
    console.error("[forms.admin] csv export failed", err);
    return new Response("Could not export submissions.", { status: 500 });
  }

  if (submissions.length >= CSV_ROW_CAP) {
    return new Response(
      "Result set too large; narrow the date range and try again.",
      { status: 416 }
    );
  }

  // Schema-union — every field key ever used in any version present.
  // heading + image are display-only, no payload.
  const fieldKeys = new Set<string>();
  for (const sub of submissions) {
    for (const f of sub.schema.fields) {
      if (f.type === "heading" || f.type === "image") continue;
      fieldKeys.add(f.key);
    }
  }
  const sortedKeys = Array.from(fieldKeys).sort();

  const headerCols = [
    "submission_id",
    "submitted_at",
    "status",
    "submitter_kind",
    "submitter_email",
    "version_number",
    "splash_notes",
    ...sortedKeys
  ];
  const lines: string[] = [headerCols.map(csvEscape).join(",")];

  for (const sub of submissions) {
    const row = [
      sub.id,
      sub.submitted_at,
      sub.status,
      sub.submitter_kind,
      sub.submitter_email ?? "",
      String(sub.version_number),
      sub.splash_notes ?? "",
      ...sortedKeys.map((k) =>
        Object.prototype.hasOwnProperty.call(sub.payload, k)
          ? stringifyPayloadValue(sub.payload[k])
          : ""
      )
    ];
    lines.push(row.map(csvEscape).join(","));
  }

  const filename = `form-${formId}-submissions-${range.fromDate}-to-${range.toDate}.csv`;
  return new Response(lines.join("\r\n") + "\r\n", {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}

function stringifyPayloadValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => stringifyPayloadValue(x)).join("; ");
  if (typeof v === "object") {
    // file/signature payloads — render r2_key when present, else JSON
    const obj = v as Record<string, unknown>;
    if (typeof obj.r2_key === "string") return obj.r2_key;
    return JSON.stringify(v);
  }
  return String(v);
}

function csvEscape(v: string): string {
  if (v == null) return "";
  const s = String(v);
  if (
    s.includes(",") ||
    s.includes("\n") ||
    s.includes("\r") ||
    s.includes('"')
  ) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// =============================================================================
// Brief 120 — POST /forms/admin/api/forms/{id}/submissions/{subId}/transition
// =============================================================================
//
// Auth: any authenticated session. The caller's authority to advance THIS
// stage is checked via approver-email membership (resolved off the
// submission payload). super_admin / admin bypass that check as a stuck-
// workflow escape hatch — same posture as the damage workflow's admin
// reverts.
//
// Lifecycle:
//   1. Auth (`authenticate` from @splash/auth — broader than the admin
//      gate; RM/RD/GM operators can take site_email transitions).
//   2. Load submission + version's schema in one PostgREST round-trip
//      (`getSubmission`).
//   3. Validate the version has a workflow + the body's `to` is a
//      defined transition from the current stage.
//   4. Resolve current stage's approver_source to email list; gate
//      `session.email` membership (super_admin / admin tier bypass).
//   5. Validate body's `requires` shape against the transition.
//   6. Append to `workflow_history`, flip `workflow_stage`, recompute
//      `current_approver_emails` for the destination stage.
//   7. Return the updated row (with `next_approver_emails` for the UI).
//
// Brief 120 deferred notification webhook fire; Brief 125 wires it in:
// assignment + outcome notification webhooks fire here. Both are
// fail-soft + ctx.waitUntil'd from the calling fetch handler. We
// re-thread ctx in via a fourth param.

export async function handleTransition(
  env: Env,
  req: Request,
  formId: string,
  subId: string,
  ctx?: ExecutionContext
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  if (!FORM_ID_RE.test(formId) || !SUB_ID_RE.test(subId)) {
    return jsonError(400, "bad_id");
  }

  // Auth: any session works at this gate; per-stage authority is
  // resolved against the submission payload below.
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  const { session } = auth;
  const isAdminTier =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";

  let body: {
    to?: unknown;
    note?: unknown;
    typed_name?: unknown;
    signature_r2_key?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json");
  }

  if (typeof body.to !== "string" || body.to.length === 0) {
    return jsonError(400, "bad_target_stage");
  }
  const toStageId = body.to.trim();
  const note =
    typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  const typedName =
    typeof body.typed_name === "string" && body.typed_name.trim()
      ? body.typed_name.trim()
      : null;
  const signatureR2Key =
    typeof body.signature_r2_key === "string" && body.signature_r2_key.trim()
      ? body.signature_r2_key.trim()
      : null;

  let submission: Awaited<ReturnType<typeof getSubmission>>;
  try {
    submission = await getSubmission(env, formId, subId);
  } catch (err) {
    console.error("[forms.admin] transition: load submission failed", err);
    return jsonError(500, "load_failed");
  }
  if (!submission) return jsonError(404, "not_found");

  const schema: FormSchema = submission.version.schema;
  const workflow = schema.workflow;
  if (!workflow) {
    return jsonError(400, "no_workflow");
  }

  const currentStageId = submission.workflow_stage ?? workflow.default_stage;
  const currentStage = workflow.stages.find((s) => s.id === currentStageId);
  if (!currentStage) {
    return jsonError(409, "current_stage_unknown");
  }

  const transition = currentStage.transitions.find((t) => t.to === toStageId);
  if (!transition) {
    return jsonError(400, "transition_not_defined");
  }
  const destStage = workflow.stages.find((s) => s.id === toStageId);
  if (!destStage) {
    return jsonError(500, "dest_stage_unknown");
  }

  // Authority gate: caller must either be admin-tier (escape hatch) OR
  // hold an email on the CURRENT stage's approver list. Brief 123 — a
  // terminal stage (no approver_source) is unreachable in normal flow
  // (no transitions defined out of it), but defensively if such a
  // submission exists, only admin-tier can act.
  if (!isAdminTier) {
    if (!currentStage.approver_source) {
      return new Response(
        JSON.stringify({
          error: "not_approver",
          allowed_emails: []
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
    let allowed: string[];
    try {
      allowed = await resolveApproverEmails(env, currentStage.approver_source, {
        schema,
        payload: submission.payload
      });
    } catch (err) {
      console.error("[forms.admin] transition: approver resolve failed", err);
      return jsonError(500, "approver_resolve_failed");
    }
    const callerEmail = session.email.trim().toLowerCase();
    if (!allowed.includes(callerEmail)) {
      return new Response(
        JSON.stringify({
          error: "not_approver",
          allowed_emails: allowed
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
  }

  // Requirements: any field marked required by the transition's
  // `requires` block must be present in the body.
  const requires = transition.requires ?? {};
  const missing: string[] = [];
  if (requires.signature && !signatureR2Key) missing.push("signature_r2_key");
  if (requires.typed_name && !typedName) missing.push("typed_name");
  if (requires.note && !note) missing.push("note");
  if (missing.length > 0) {
    return new Response(
      JSON.stringify({ error: "missing_required", missing }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  const historyEntry: WorkflowHistoryEntry = {
    from: currentStageId,
    to: toStageId,
    actor_email: session.email,
    actor_session_role: session.role ?? null,
    note,
    signature_r2_key: signatureR2Key,
    typed_name: typedName,
    at: new Date().toISOString()
  };
  const nextHistory = [...submission.workflow_history, historyEntry];

  let nextApproverEmails: string[] = [];
  // Brief 123 — terminal destination has no approver_source; emails stays [].
  if (destStage.approver_source) {
    try {
      nextApproverEmails = await resolveApproverEmails(
        env,
        destStage.approver_source,
        { schema, payload: submission.payload }
      );
    } catch (err) {
      console.error("[forms.admin] transition: dest approver resolve failed", err);
      nextApproverEmails = [];
    }
  }

  try {
    const updated = await transitionSubmission(env, formId, subId, {
      workflow_stage: toStageId,
      workflow_history: nextHistory,
      current_approver_emails: nextApproverEmails
    });
    if (!updated) return jsonError(404, "not_found");

    // -----------------------------------------------------------------
    // Brief 125 — notification fires (fail-soft, ctx.waitUntil-ed).
    //
    // (a) Per-step assignment: if the destination stage has approvers
    //     AND the workflow opted in, fire one POST per recipient.
    //     Actor-exclusion: skip the caller's own email (they ARE the
    //     approver they just forwarded to themselves — rare but
    //     observable in admin-tier bypass cases).
    // (b) Per-outcome: if the destination is an outcome, build the
    //     recipient list (submitter + acted-on approvers) per the
    //     opted-in booleans and fire one POST per recipient.
    // -----------------------------------------------------------------
    const notif = getWorkflowNotifications(workflow);
    const callerEmailLower = session.email.trim().toLowerCase();
    const reviewUrl = buildReviewUrl(formId, subId);
    const formTitle = await fetchFormTitleForNotification(env, formId).catch(
      () => ""
    );

    if (
      notif.notify_approver_on_assignment &&
      nextApproverEmails.length > 0 &&
      !workflowStageIsOutcome(destStage)
    ) {
      for (const recipientEmail of nextApproverEmails) {
        if (recipientEmail.toLowerCase() === callerEmailLower) continue;
        const fire = fireAssignmentNotification(env, {
          type: "assignment",
          submission_id: subId,
          form_id: formId,
          form_title: formTitle,
          step_label: destStage.label || destStage.id,
          recipient_email: recipientEmail,
          submitter_email: submission.submitter_email,
          submitted_at: submission.submitted_at,
          review_url: reviewUrl
        });
        if (ctx) ctx.waitUntil(fire);
        else await fire;
      }
    }

    if (workflowStageIsOutcome(destStage)) {
      const recipients = new Map<string, "submitter" | "actor">();
      if (
        notif.notify_submitter_on_outcome &&
        submission.submitter_email
      ) {
        recipients.set(
          submission.submitter_email.trim().toLowerCase(),
          "submitter"
        );
      }
      if (notif.notify_approvers_on_outcome) {
        for (const h of nextHistory) {
          if (!h.actor_email) continue;
          const lower = h.actor_email.trim().toLowerCase();
          if (!recipients.has(lower)) recipients.set(lower, "actor");
        }
      }
      const actorHistory = buildActorHistory(workflow, nextHistory);
      const outcomeKind = destStage.tint ?? "neutral";
      const outcomeReachedAt =
        nextHistory[nextHistory.length - 1]?.at ??
        new Date().toISOString();
      for (const [recipientEmail, role] of recipients.entries()) {
        const fire = fireOutcomeNotification(env, {
          type: "outcome",
          submission_id: subId,
          form_id: formId,
          form_title: formTitle,
          outcome_label: destStage.label || destStage.id,
          outcome_kind: outcomeKind,
          recipient_email: recipientEmail,
          recipient_role: role,
          submitter_email: submission.submitter_email,
          submitted_at: submission.submitted_at,
          outcome_reached_at: outcomeReachedAt,
          actor_history: actorHistory,
          review_url: reviewUrl
        });
        if (ctx) ctx.waitUntil(fire);
        else await fire;
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        id: updated.id,
        from: currentStageId,
        to: toStageId,
        workflow_stage: toStageId,
        workflow_history: nextHistory,
        current_approver_emails: nextApproverEmails
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (err) {
    console.error("[forms.admin] transition: PATCH failed", err);
    return jsonError(500, "transition_failed");
  }
}

// Brief 125 — fetch form.title for the notification payload. Tiny direct
// PostgREST read; service-key already gates the entire admin surface so
// we don't need extra auth here.
async function fetchFormTitleForNotification(
  env: Env,
  formId: string
): Promise<string> {
  const url = new URL("/rest/v1/forms", env.SUPABASE_URL);
  url.searchParams.set("select", "title");
  url.searchParams.set("id", `eq.${formId}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Accept: "application/json"
    }
  });
  if (!resp.ok) return "";
  const rows = (await resp.json().catch(() => [])) as Array<{ title?: string }>;
  return rows[0]?.title ?? "";
}

// Helper for the apps/web detail page server-action (re-exported for
// potential future use; keeps stage-shape lookup in one place).
export function findCurrentStage(
  workflow: FormSchema["workflow"],
  stageId: string
): WorkflowStage | undefined {
  if (!workflow) return undefined;
  return workflow.stages.find((s) => s.id === stageId);
}
