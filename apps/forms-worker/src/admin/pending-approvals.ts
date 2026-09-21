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
  /**
   * Brief 173 — the fields this form flagged `show_in_queue`, resolved against
   * THIS submission's own version schema, in schema order, capped at
   * QUEUE_FIELD_LIMIT.
   *
   * Exists so someone working a queue can tell tickets apart without opening
   * each one. Empty array for forms that flag nothing, which is every form
   * that existed before this brief — the queue renders exactly as it did.
   *
   * Resolved per-submission rather than per-form on purpose: a submission
   * against v2 must show v2's flagged fields even after v3 changes them, the
   * same way the detail page renders against the submission's own version.
   */
  queue_fields: { key: string; label: string; value: string }[];
  /**
   * Brief 175 — which of the three lists this row belongs in.
   *
   * Before this the endpoint returned ONLY rows where the caller was the
   * current approver, so a ticket you handed to somebody else vanished
   * completely -- there was no way to see what you were waiting on, and a
   * ticket parked at a site looked identical to one that never existed.
   */
  bucket: QueueBucket;
}

/** `needs_action` is yours now. `waiting_on_others` is yours but parked with
 *  somebody else. `completed` has reached a terminal outcome. */
export type QueueBucket = "needs_action" | "waiting_on_others" | "completed";

interface PendingApprovalDbRow {
  id: string;
  form_id: string;
  workflow_stage: string | null;
  submitter_email: string | null;
  submitter_kind: "authenticated" | "anonymous";
  submitted_at: string;
  current_approver_emails: string[] | null;
  payload: Record<string, unknown>;
  /** Brief 175 — read to decide whether the caller has already acted. */
  workflow_history: unknown;
  // Denormalized location scoping column (stamped at submit). Authoritative
  // for the row's Site value — preferred over the payload heuristic below.
  location_code: string | null;
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

  // THREE QUERIES, MERGED -- deliberately not one clever one.
  //
  // "Everything I am involved in" spans three unrelated predicates: the
  // GIN-indexed `current_approver_emails` array, jsonb containment on
  // `workflow_history`, and a plain equality on `submitter_email`. PostgREST
  // can express that as a single `or=(...)`, but the jsonb literal carries
  // commas and quotes that have to survive `or()` parsing, and getting that
  // subtly wrong returns FEWER rows rather than an error. Three unambiguous
  // requests merged in memory cannot fail that way, and at this volume the two
  // extra round trips are free.
  //
  // NOTE for when it stops being free: there is no index on workflow_history,
  // so query 2 is a sequential scan. Irrelevant at hundreds of rows; the first
  // thing to fix at tens of thousands, with a GIN index on that column.
  const baseSelect = [
    "id",
    "form_id",
    "workflow_stage",
    "submitter_email",
    "submitter_kind",
    "submitted_at",
    "current_approver_emails",
    "payload",
    "workflow_history",
    "location_code",
    "form:forms!inner(id,title)",
    "version:form_versions!inner(id,schema)"
  ].join(",");

  function baseUrl(): URL {
    const u = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
    u.searchParams.set("select", baseSelect);
    // Excludes legacy / no-workflow rows.
    u.searchParams.set("workflow_stage", "not.is.null");
    u.searchParams.set("order", "submitted_at.desc");
    u.searchParams.set("limit", String(PENDING_LIMIT));
    return u;
  }

  async function run(u: URL): Promise<PendingApprovalDbRow[] | null> {
    try {
      const r = await fetch(u.toString(), {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
        }
      });
      if (!r.ok) {
        console.error(
          "[forms.pending-approvals] supabase returned",
          r.status,
          await r.text().catch(() => "")
        );
        return null;
      }
      return (await r.json().catch(() => [])) as PendingApprovalDbRow[];
    } catch (err) {
      console.error("[forms.pending-approvals] fetch threw", err);
      return null;
    }
  }

  const queries: URL[] = [];
  if (scope === "all") {
    // Brief 131 — admin oversight sees every pending row, including ones whose
    // approver resolution failed. Unchanged.
    queries.push(baseUrl());
  } else {
    // 1. Waiting on me right now.
    const q1 = baseUrl();
    q1.searchParams.set(
      "current_approver_emails",
      `cs.{${escapePgrstArrayLiteral(callerEmail)}}`
    );
    queries.push(q1);

    // 2. I have acted on it at some point. jsonb containment: the history is
    //    an array of entries, and @> matches on any one of them.
    const q2 = baseUrl();
    q2.searchParams.set(
      "workflow_history",
      `cs.[{"actor_email":"${callerEmail.replace(/"/g, '\\"')}"}]`
    );
    queries.push(q2);

    // 3. I raised it. Operator-chosen: site staff who submit but never act
    //    still get a view of what they are waiting on.
    const q3 = baseUrl();
    q3.searchParams.set("submitter_email", `eq.${callerEmail}`);
    queries.push(q3);
  }

  const results = await Promise.all(queries.map(run));
  // A failure on ANY leg fails the request rather than silently returning a
  // partial queue. A queue that quietly omits your work is worse than one that
  // says it is broken.
  if (results.some((r) => r === null)) return jsonError(500, "list_failed");

  const seen = new Set<string>();
  const rows: PendingApprovalDbRow[] = [];
  for (const batch of results) {
    for (const r of batch ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
    }
  }
  rows.sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1));

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
      // Prefer the denormalized column (stamped at submit, correct for
      // site-number-scoped forms); fall back to the payload heuristic for
      // legacy rows submitted before the column existed / was backfilled.
      location_code:
        (typeof r.location_code === "string" && r.location_code.trim()
          ? r.location_code.trim()
          : null) ?? extractLocationCode(schema, r.payload),
      review_path: `/admin/forms/${r.form_id}/submissions/${r.id}`,
      approver_resolution_status:
        approverEmails.length === 0 && expectsApprover ? "empty" : "resolved",
      queue_fields: resolveQueueFields(schema, r.payload),
      bucket: bucketFor({
        scope,
        expectsApprover,
        approverEmails,
        callerEmail
      })
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

// =============================================================================
// Brief 173 — queue columns
// =============================================================================

/**
 * How many `show_in_queue` fields a form may actually surface.
 *
 * A form maker who ticks every box would otherwise make the queue wider than
 * the screen and harder to scan than the thing it replaced. Over the cap we
 * take schema order and drop the rest rather than erroring: a too-eager flag
 * is a cosmetic mistake, and failing a queue load over it would be worse than
 * the mistake.
 */
const QUEUE_FIELD_LIMIT = 5;

/** Display-only types carry no payload value, so they can never be columns. */
const DISPLAY_ONLY_TYPES = new Set(["heading", "image"]);

/**
 * Render one payload value as a short string for a queue cell.
 *
 * Returns null for anything with no sensible one-line form — file and
 * signature entries are objects, and a column reading "[object Object]" is
 * worse than no column. Options are mapped value -> label where the field
 * declares them, because a dropdown's stored value is frequently a slug the
 * operator never sees anywhere else.
 */
function queueCellValue(field: unknown, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  const options = (field as { options?: { value: string; label: string }[] }).options;
  const label = (v: unknown): string => {
    const s = typeof v === "string" ? v : String(v);
    const hit = options?.find((o) => o.value === s);
    return hit ? hit.label : s;
  };

  if (Array.isArray(raw)) {
    const parts = raw
      .filter((v) => v !== null && v !== undefined && typeof v !== "object")
      .map(label);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof raw === "object") return null;
  if (typeof raw === "boolean") return raw ? "Yes" : "No";

  const s = label(raw).trim();
  return s === "" ? null : s;
}

/**
 * The flagged fields for one submission, read against its OWN version schema.
 *
 * Payload values are keyed by `field.key`, never `field.id` — Brief 131
 * established that empirically in three places, and getting it wrong yields
 * silently empty columns rather than an error.
 */
export function resolveQueueFields(
  schema: FormSchema,
  payload: unknown
): { key: string; label: string; value: string }[] {
  const fields = Array.isArray(schema?.fields) ? schema.fields : [];
  const bag = (payload ?? {}) as Record<string, unknown>;
  const out: { key: string; label: string; value: string }[] = [];

  for (const f of fields) {
    if (out.length >= QUEUE_FIELD_LIMIT) break;
    if (!(f as { show_in_queue?: boolean }).show_in_queue) continue;
    if (DISPLAY_ONLY_TYPES.has((f as { type?: string }).type ?? "")) continue;

    const key = (f as { key?: string }).key;
    if (typeof key !== "string" || key === "") continue;

    const value = queueCellValue(f, bag[key]);
    // A flagged field the submitter left blank still earns its column -- the
    // blank IS the information ("no barcode given"). An unrenderable value
    // does not, so it collapses to an em-dash rather than being dropped, which
    // would misalign every column after it.
    out.push({
      key,
      label: (f as { label?: string }).label ?? key,
      value: value ?? "—"
    });
  }
  return out;
}

/**
 * Which list a row belongs in.
 *
 * "Completed" is derived from the stage having NO approver_source, which is
 * what a terminal outcome looks like -- rather than from
 * `form_submissions.status`, which an admin can set by hand and which says
 * nothing about where the workflow actually is.
 *
 * For an admin viewing ?all=1 the caller has no relationship to most rows, so
 * "waiting on others" would swallow the entire list and say nothing. That view
 * stays a flat pending feed: terminal rows aside, everything reads as needing
 * action by somebody.
 */
function bucketFor(input: {
  scope: "me" | "all";
  expectsApprover: boolean;
  approverEmails: string[];
  callerEmail: string;
}): QueueBucket {
  if (!input.expectsApprover) return "completed";
  if (input.scope === "all") return "needs_action";
  const mine = input.approverEmails.some(
    (e) => e.trim().toLowerCase() === input.callerEmail
  );
  return mine ? "needs_action" : "waiting_on_others";
}
