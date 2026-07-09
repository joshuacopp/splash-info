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
  Field,
  FormSchema,
  WorkflowHistoryEntry,
  WorkflowStage
} from "@splash/forms-schema";
import {
  adminGateResponse,
  requireServiceKey,
  submissionGate,
  type SubmissionScope
} from "./auth.js";
import {
  listSubmissions,
  getSubmission,
  updateSubmission,
  listSubmissionsForCsv,
  transitionSubmission,
  type SubmissionStatus
} from "../db/admin-submissions.js";
import { getFormDetail } from "../db/admin-forms.js";
import { getFormScopeFieldKey } from "../db/forms.js";
import {
  generateReportPdf,
  type ReportQuestion,
  type ReportRow,
  type TextQuestion,
  type TextResponse
} from "../pdf/generate-report.js";
import { resolveApproverEmails } from "../workflow-resolution.js";
import {
  cascadeThroughEmailSteps,
  buildRuntimeContext,
  isEmailStage,
  payloadWithSubmitterSynthetic
} from "../workflow-email-step.js";
import { workflowStageIsOutcome } from "../notifications.js";
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

/**
 * Convert a caller's SubmissionScope into the `locationScope` value the db
 * helpers expect: `undefined` for full-admin ("all") callers, or the location
 * code array for scoped callers.
 */
function locationScopeFor(scope: SubmissionScope): string[] | undefined {
  return scope === "all" ? undefined : scope.locations;
}

/**
 * For a scoped (location-admin) caller, a form that carries no
 * `scope_location_field_key` isn't location-scoped at all — its submissions
 * have NULL location_code and belong to super_admin / dc-admin only. Return a
 * 403 in that case so the caller gets a clear "not your surface" signal rather
 * than a confusing empty list. Full-admin ("all") callers always pass.
 */
async function denyUnscopedFormForScopedCaller(
  env: Env,
  formId: string,
  scope: SubmissionScope
): Promise<Response | null> {
  if (scope === "all") return null;
  const key = await getFormScopeFieldKey(env, formId);
  if (!key) return jsonError(403, "form_not_location_scoped");
  return null;
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
  const gate = await submissionGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId)) return jsonError(400, "bad_id");
  const denied = await denyUnscopedFormForScopedCaller(env, formId, gate.scope);
  if (denied) return denied;
  const locationScope = locationScopeFor(gate.scope);

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
      includePayload,
      locationScope
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
  const gate = await submissionGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId) || !SUB_ID_RE.test(subId)) {
    return jsonError(400, "bad_id");
  }
  const locationScope = locationScopeFor(gate.scope);

  try {
    const submission = await getSubmission(env, formId, subId, locationScope);
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
  const gate = await submissionGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId) || !SUB_ID_RE.test(subId)) {
    return jsonError(400, "bad_id");
  }
  const locationScope = locationScopeFor(gate.scope);

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
      patch,
      locationScope
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
  const gate = await submissionGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId)) return jsonError(400, "bad_id");
  const denied = await denyUnscopedFormForScopedCaller(env, formId, gate.scope);
  if (denied) return denied;
  const locationScope = locationScopeFor(gate.scope);

  const url = new URL(req.url);
  const range = resolveDateRange(url);

  let submissions: Awaited<ReturnType<typeof listSubmissionsForCsv>>;
  try {
    submissions = await listSubmissionsForCsv(
      env,
      formId,
      range.fromIso,
      range.toIso,
      CSV_ROW_CAP,
      locationScope
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
  // heading + image are display-only, no payload. Alongside each key we
  // collect the field's human label (for the header row) and, for
  // dropdown/multi fields, an option value→label map so cells render the
  // chosen option's label instead of its stored code (e.g. "Yes" not
  // "option_2"). Merged across versions: the last non-empty label wins;
  // option maps are unioned so a value that a newer version dropped still
  // resolves for older submissions.
  interface KeyMeta {
    label: string;
    options: Map<string, string>;
  }
  const keyMeta = new Map<string, KeyMeta>();
  for (const sub of submissions) {
    for (const f of sub.schema.fields) {
      if (f.type === "heading" || f.type === "image") continue;
      let meta = keyMeta.get(f.key);
      if (!meta) {
        meta = { label: "", options: new Map() };
        keyMeta.set(f.key, meta);
      }
      if (f.label) meta.label = f.label;
      if (f.type === "dropdown" || f.type === "multi") {
        for (const opt of f.options) meta.options.set(opt.value, opt.label);
      }
    }
  }
  const sortedKeys = Array.from(keyMeta.keys()).sort();

  // Header shows the human label; fall back to the key when a field has no
  // label. If two keys share a label, disambiguate by appending the key so
  // columns stay distinguishable.
  const labelCounts = new Map<string, number>();
  for (const k of sortedKeys) {
    const label = keyMeta.get(k)!.label || k;
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const headerLabelFor = (k: string): string => {
    const label = keyMeta.get(k)!.label || k;
    return (labelCounts.get(label) ?? 0) > 1 ? `${label} (${k})` : label;
  };

  const headerCols = [
    "submission_id",
    "submitted_at",
    "status",
    "submitter_kind",
    "submitter_email",
    "version_number",
    "splash_notes",
    ...sortedKeys.map(headerLabelFor)
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
          ? stringifyPayloadValue(sub.payload[k], keyMeta.get(k)!.options)
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

// =============================================================================
// GET /forms/admin/api/forms/{id}/submissions/report.pdf
// =============================================================================
//
// Aggregate "response report": for every dropdown / multi (multiple-choice)
// question, the percentage of responses landing on each option. Honors the
// same date range + field filter the wide-table viewer uses, so the export
// matches what the operator sees on screen.
//
//   Dropdown: denominator = every submission in the filtered set; blanks
//             roll up into a "No answer" row so the options sum to 100%.
//   Multi:    denominator = total selections + one "No answer" per blank
//             submission; each option's share is % of all selections.

// Resolve a payload value to the human-readable text the wide table shows —
// mirrors the client-side filter's toSearchText so the in-worker filter
// matches option labels, not stored codes.
function displayText(field: Field, value: unknown): string {
  if (value == null || value === "") return "";
  switch (field.type) {
    case "dropdown": {
      const opt = field.options.find((o) => o.value === String(value));
      return opt?.label ?? String(value);
    }
    case "multi": {
      if (!Array.isArray(value)) return String(value);
      return value
        .map((v) => {
          const opt = field.options.find((o) => o.value === String(v));
          return opt?.label ?? String(v);
        })
        .join(", ");
    }
    case "file":
    case "signature": {
      if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        if (typeof obj.original_filename === "string") return obj.original_filename;
        if (typeof obj.r2_key === "string") return obj.r2_key;
      }
      return "";
    }
    default:
      return String(value);
  }
}

interface ChoiceMeta {
  label: string;
  type: "dropdown" | "multi";
  /** value -> label, unioned across every version in range. */
  options: Map<string, string>;
  /** option values in first-seen order (drives row order). */
  order: string[];
}

export async function handleSubmissionsReport(
  env: Env,
  req: Request,
  formId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await submissionGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId)) return jsonError(400, "bad_id");
  const denied = await denyUnscopedFormForScopedCaller(env, formId, gate.scope);
  if (denied) return denied;
  const locationScope = locationScopeFor(gate.scope);

  const url = new URL(req.url);
  const range = resolveDateRange(url);
  const filterKey = (url.searchParams.get("filter_key") ?? "").trim();
  const filterValue = (url.searchParams.get("filter_value") ?? "").trim();

  let submissions: Awaited<ReturnType<typeof listSubmissionsForCsv>>;
  try {
    submissions = await listSubmissionsForCsv(
      env,
      formId,
      range.fromIso,
      range.toIso,
      CSV_ROW_CAP,
      locationScope
    );
  } catch (err) {
    console.error("[forms.admin] report export failed", err);
    return new Response("Could not build report.", { status: 500 });
  }

  if (submissions.length >= CSV_ROW_CAP) {
    return new Response(
      "Result set too large; narrow the date range and try again.",
      { status: 416 }
    );
  }

  // Choice-field schema union (dropdown + multi only), plus a label map for
  // every field key (used to caption an active filter on a text field).
  // `textMeta` tracks short/long text fields in first-seen order for the
  // written-responses section.
  const choiceMeta = new Map<string, ChoiceMeta>();
  const textMeta = new Map<string, { label: string }>();
  const fieldLabels = new Map<string, string>();
  for (const sub of submissions) {
    for (const f of sub.schema.fields) {
      if (f.type === "heading" || f.type === "image") continue;
      if (f.label) fieldLabels.set(f.key, f.label);
      // The `site_number` scope field is a short_text, but it's the location
      // scoping mechanism, not a survey answer — exclude it so the written-
      // responses section isn't flooded with date-stamped site numbers.
      if (
        (f.type === "short_text" || f.type === "long_text") &&
        f.key !== "site_number"
      ) {
        const tm = textMeta.get(f.key);
        if (!tm) {
          textMeta.set(f.key, { label: f.label ?? "" });
        } else if (f.label) {
          tm.label = f.label;
        }
      }
      if (f.type !== "dropdown" && f.type !== "multi") continue;
      let meta = choiceMeta.get(f.key);
      if (!meta) {
        meta = { label: "", type: f.type, options: new Map(), order: [] };
        choiceMeta.set(f.key, meta);
      }
      if (f.label) meta.label = f.label;
      for (const opt of f.options) {
        if (!meta.options.has(opt.value)) meta.order.push(opt.value);
        meta.options.set(opt.value, opt.label);
      }
    }
  }

  // Apply the field filter (contains match on displayed text), matching the
  // client wide-table filter semantics.
  let filtered = submissions;
  let filterCaption: string | null = null;
  if (filterKey && filterValue) {
    const needle = filterValue.toLowerCase();
    filtered = submissions.filter((sub) => {
      const field = sub.schema.fields.find((f) => f.key === filterKey);
      const text = field ? displayText(field, sub.payload[filterKey]) : "";
      return text.toLowerCase().includes(needle);
    });
    const label =
      choiceMeta.get(filterKey)?.label ?? fieldLabels.get(filterKey) ?? filterKey;
    filterCaption = `Filtered: ${label} contains "${filterValue}"`;
  }

  const total = filtered.length;
  const questions: ReportQuestion[] = [];

  for (const [key, meta] of choiceMeta) {
    const rows: ReportRow[] = [];
    const counts = new Map<string, number>();
    for (const val of meta.order) counts.set(meta.options.get(val) ?? val, 0);

    if (meta.type === "dropdown") {
      let noAnswer = 0;
      for (const sub of filtered) {
        const v = sub.payload[key];
        if (v == null || v === "") {
          noAnswer++;
          continue;
        }
        const label = meta.options.get(String(v)) ?? String(v);
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      for (const [label, count] of counts) {
        rows.push({ label, count, pct: total ? (count / total) * 100 : 0 });
      }
      if (noAnswer > 0) {
        rows.push({
          label: "No answer",
          count: noAnswer,
          pct: total ? (noAnswer / total) * 100 : 0
        });
      }
      questions.push({
        label: meta.label || key,
        type: "dropdown",
        baseCaption: `${total} submission${total === 1 ? "" : "s"}`,
        rows
      });
    } else {
      let totalSelections = 0;
      let noAnswer = 0;
      for (const sub of filtered) {
        const v = sub.payload[key];
        if (!Array.isArray(v) || v.length === 0) {
          noAnswer++;
          continue;
        }
        for (const item of v) {
          const label = meta.options.get(String(item)) ?? String(item);
          counts.set(label, (counts.get(label) ?? 0) + 1);
          totalSelections++;
        }
      }
      const denom = totalSelections + noAnswer;
      for (const [label, count] of counts) {
        rows.push({ label, count, pct: denom ? (count / denom) * 100 : 0 });
      }
      if (noAnswer > 0) {
        rows.push({
          label: "No answer",
          count: noAnswer,
          pct: denom ? (noAnswer / denom) * 100 : 0
        });
      }
      questions.push({
        label: meta.label || key,
        type: "multi",
        baseCaption: `${totalSelections} selection${totalSelections === 1 ? "" : "s"} across ${total} submission${total === 1 ? "" : "s"}`,
        rows
      });
    }
  }

  // Written-responses section: list each non-empty short/long text answer,
  // date-prefixed, in the same first-seen field order as the schema.
  const textQuestions: TextQuestion[] = [];
  for (const [key, meta] of textMeta) {
    const responses: TextResponse[] = [];
    for (const sub of filtered) {
      const raw = sub.payload[key];
      if (raw == null) continue;
      const text = typeof raw === "string" ? raw : String(raw);
      if (text.trim() === "") continue;
      responses.push({ date: reportDate(sub.submitted_at), text });
    }
    textQuestions.push({
      label: meta.label || key,
      baseCaption: `${responses.length} of ${total} submission${
        total === 1 ? "" : "s"
      } answered`,
      responses
    });
  }

  let formTitle = "Form";
  try {
    const detail = await getFormDetail(env, formId);
    if (detail?.form.title) formTitle = detail.form.title;
  } catch {
    /* title is cosmetic — fall back to generic */
  }

  let bytes: Uint8Array;
  try {
    bytes = await generateReportPdf(env.FORMS_FILES, {
      formTitle,
      fromDate: range.fromDate,
      toDate: range.toDate,
      totalSubmissions: total,
      filterCaption,
      questions,
      textQuestions
    });
  } catch (err) {
    console.error("[forms.admin] report pdf render failed", err);
    return new Response("Could not render report PDF.", { status: 500 });
  }

  // `?disposition=inline` opens the PDF in a browser tab (the "View report"
  // button); the default `attachment` drives the "Export report" download.
  const inline = url.searchParams.get("disposition") === "inline";
  const filename = `form-${formId}-report-${range.fromDate}-to-${range.toDate}.pdf`;
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}

// Compact date for the written-responses list, e.g. "Jan 5, 2026" (EST).
function reportDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  } catch {
    return iso;
  }
}

// `options` (when supplied) maps a dropdown/multi option's stored value to
// its display label; string values are looked up through it so cells show
// "Yes" instead of "option_2". Unknown values (and non-choice fields) pass
// through unchanged.
function stringifyPayloadValue(
  v: unknown,
  options?: Map<string, string>
): string {
  if (v == null) return "";
  if (typeof v === "string") return options?.get(v) ?? v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v))
    return v.map((x) => stringifyPayloadValue(x, options)).join("; ");
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
  // resolved against the submission payload below. Location scoping is
  // intentionally NOT applied here: transition authority is approver-email
  // membership (admin-tier bypasses). A location admin is not admin-tier, so
  // they can only advance stages where they're the resolved approver — already
  // narrower than location scope. Scoping getSubmission here would instead
  // break legitimate non-location approvers (RM/RD/GM) who hold no locations.
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

  // Brief 127 — if the destination is an email step, cascade through
  // it (render + enqueue + advance) before the PATCH. The cascade
  // produces the FINAL workflow_stage, history additions, and approver
  // list — all written in one transitionSubmission call below. Email
  // steps auto-advance; the destStage we landed on isn't where we
  // stop, just where we start the cascade.
  let finalStageId: string = toStageId;
  let finalHistory: WorkflowHistoryEntry[] = [
    ...submission.workflow_history,
    historyEntry
  ];
  let finalApproverEmails: string[] = [];

  if (isEmailStage(destStage)) {
    try {
      // Fetch the form metadata we need for placeholder substitution.
      // Slug + title are not on the submission detail; one tiny extra
      // read keeps the cascade self-contained.
      const formMeta = await fetchFormMetaForCascade(env, formId);
      const runtimeBase = buildRuntimeContext({
        form: { id: formId, slug: formMeta.slug, title: formMeta.title },
        submissionId: subId,
        submitterEmail: submission.submitter_email
      });
      const cascade = await cascadeThroughEmailSteps(env, {
        form: { id: formId, slug: formMeta.slug, title: formMeta.title },
        // The cascade reads `version.versionNumber` for the Brief 129
        // PDF metadata grid (when attach_pdf fires). Other version
        // fields aren't used by the cascade itself.
        version: {
          id: submission.version.id,
          versionNumber: submission.version.version_number
        },
        schema,
        payload: payloadWithSubmitterSynthetic(
          submission.payload,
          submission.submitter_email
        ),
        runtime: runtimeBase,
        startStageId: toStageId,
        fromStageId: currentStageId,
        // Brief 129 — submission metadata + prior history for the PDF
        // generator's reuse check.
        submissionMeta: {
          id: subId,
          submittedAt: submission.submitted_at,
          submitterKind: submission.submitter_kind,
          submitterEmail: submission.submitter_email
        },
        priorWorkflowHistory: finalHistory.slice()
      });
      finalStageId = cascade.workflow_stage;
      finalHistory = [...finalHistory, ...cascade.appended_history];
      finalApproverEmails = cascade.current_approver_emails;
    } catch (err) {
      console.error(
        "[forms.workflow.email-step] transition-time cascade threw; landing on dest stage with empty approvers",
        err
      );
      // Fall through with destStage as the resting point + empty
      // approvers. Operator can intervene via direct SQL if needed.
    }
  } else if (destStage.approver_source) {
    try {
      finalApproverEmails = await resolveApproverEmails(
        env,
        destStage.approver_source,
        { schema, payload: submission.payload }
      );
    } catch (err) {
      console.error("[forms.admin] transition: dest approver resolve failed", err);
      finalApproverEmails = [];
    }
  }
  // Mark `ctx` as intentionally unused now that Brief 125's notification
  // fires (which were the only reason transition needed `ctx`) have
  // been removed in Brief 127. Future executors adding new
  // ctx.waitUntil-driven side effects can re-read the param at the
  // call site — it's still threaded through.
  void ctx;

  // Brief 131 — when the post-cascade resting stage is a terminal
  // outcome and the submission's Brief 96 `status` column is still
  // `new` or `in_progress`, auto-flip it to `closed`. Don't override
  // an admin who's already set `closed` (or any future enum value).
  //
  // Brief 133 — `status_updated_by` is `uuid` (supabase/forms-tables.sql
  // line 73), not `text`. Writing a string sentinel ("system@workflow")
  // 22P02s and 500s the transition. The canonical actor-audit for
  // system-initiated status flips lives in `workflow_history[-1]`
  // (captures the operator who triggered the terminal-outcome
  // transition); leaving `status_updated_by` null is the right answer.
  const finalStage = workflow.stages.find((s) => s.id === finalStageId);
  let statusPatch:
    | {
        status: "closed";
        status_updated_at: string;
      }
    | undefined;
  if (
    finalStage &&
    workflowStageIsOutcome(finalStage) &&
    (submission.status === "new" || submission.status === "in_progress")
  ) {
    statusPatch = {
      status: "closed",
      status_updated_at: new Date().toISOString()
    };
  }

  try {
    const updated = await transitionSubmission(env, formId, subId, {
      workflow_stage: finalStageId,
      workflow_history: finalHistory,
      current_approver_emails: finalApproverEmails,
      ...(statusPatch ?? {})
    });
    if (!updated) return jsonError(404, "not_found");

    return new Response(
      JSON.stringify({
        ok: true,
        id: updated.id,
        from: currentStageId,
        to: toStageId,
        workflow_stage: finalStageId,
        workflow_history: finalHistory,
        current_approver_emails: finalApproverEmails,
        status_auto_updated: statusPatch ? "closed" : null
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

// Brief 127 — tiny direct PostgREST read so the transition-time cascade
// can substitute `{form.title}` + `{form.url}` placeholders without
// adding a slug/title field to the SubmissionDetail row. Service-key
// already gates the entire admin surface.
interface FormMetaForCascade {
  slug: string;
  title: string;
}
async function fetchFormMetaForCascade(
  env: Env,
  formId: string
): Promise<FormMetaForCascade> {
  const url = new URL("/rest/v1/forms", env.SUPABASE_URL);
  url.searchParams.set("select", "slug,title");
  url.searchParams.set("id", `eq.${formId}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Accept: "application/json"
    }
  });
  if (!resp.ok) return { slug: "", title: "" };
  const rows = (await resp.json().catch(() => [])) as Array<FormMetaForCascade>;
  return rows[0] ?? { slug: "", title: "" };
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
