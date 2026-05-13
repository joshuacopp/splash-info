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

import { isOriginAllowed, jsonError } from "@splash/http";
import { adminGate, adminGateResponse, requireServiceKey } from "./auth.js";
import {
  listSubmissions,
  getSubmission,
  updateSubmission,
  listSubmissionsForCsv,
  type SubmissionStatus
} from "../db/admin-submissions.js";
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
