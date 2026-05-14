// Brief 128 — admin viewer endpoints for the Brief 127 outbound email queue.
//
// Routes (mounted in src/index.ts):
//
//   GET  /forms/admin/api/email-queue/list
//   GET  /forms/admin/api/email-queue/{id}
//   POST /forms/admin/api/email-queue/{id}/retry
//   POST /forms/admin/api/email-queue/{id}/abandon
//
// Auth gate is the same admin-tier check used by the rest of /forms/admin/api
// (`session.role === "super_admin"` OR `session.dcRole === "admin"` OR
// `session.dcRole === "super_admin"`); service-key-unbound returns 503 across
// the board. POST endpoints add the `isOriginAllowed` CSRF gate.
//
// Status taxonomy (derived from row state — `outbound_emails` itself has no
// `status` column):
//   pending  — sent_at IS NULL AND claimed_at IS NULL AND send_attempts < 5
//   claimed  — sent_at IS NULL AND claimed_at IS NOT NULL AND send_attempts < 5
//   sent     — sent_at IS NOT NULL
//   stuck    — sent_at IS NULL AND send_attempts >= 5
//
// `claimed` rows that have been claimed for >10 minutes are still surfaced
// as `claimed` by this viewer; the Brief 127 claim function auto-recovers
// them on the next PA poll so a stale claim shouldn't survive long anyway.

import { isOriginAllowed, jsonError } from "@splash/http";
import { adminGate, adminGateResponse, requireServiceKey } from "./auth.js";
import type { Env } from "../index.js";

const ROW_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const DEFAULT_WINDOW_DAYS = 7;
const ABANDONED_ATTEMPTS = 99;

type StatusFilter = "pending" | "claimed" | "sent" | "stuck" | "all";
type ItemStatus = "pending" | "claimed" | "sent" | "stuck";

const STATUS_FILTERS: readonly StatusFilter[] = [
  "pending",
  "claimed",
  "sent",
  "stuck",
  "all"
];

interface DbRow {
  id: string;
  source_worker: string;
  source_kind: string;
  source_id: string;
  recipient: string;
  cc?: string[] | null;
  reply_to?: string | null;
  subject: string;
  body_html?: string | null;
  body_text?: string | null;
  attachments?: unknown;
  scheduled_for: string;
  created_at: string;
  claimed_at: string | null;
  claim_id: string | null;
  sent_at: string | null;
  send_attempts: number;
  last_error: string | null;
}

interface ListItem {
  id: string;
  source_worker: string;
  source_kind: string;
  source_id: string;
  recipient: string;
  subject: string;
  status: ItemStatus;
  send_attempts: number;
  last_error: string | null;
  created_at: string;
  claimed_at: string | null;
  sent_at: string | null;
}

interface AttachmentMeta {
  filename: string;
  mime: string;
  size_bytes: number;
  has_r2_key: boolean;
  has_base64: boolean;
}

interface DetailItem extends ListItem {
  cc: string[];
  reply_to: string | null;
  body_html: string | null;
  body_text: string | null;
  attachments: AttachmentMeta[];
  scheduled_for: string;
  claim_id: string | null;
}

function rowStatus(row: DbRow): ItemStatus {
  if (row.sent_at) return "sent";
  if (row.send_attempts >= 5) return "stuck";
  if (row.claimed_at) return "claimed";
  return "pending";
}

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
  const defaultFrom = new Date(
    today.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  const fromDate = from ?? ymd(defaultFrom);
  const toDate = to ?? ymd(today);
  return {
    fromDate,
    toDate,
    fromIso: `${fromDate}T00:00:00Z`,
    toIso: `${toDate}T23:59:59Z`
  };
}

function toListItem(row: DbRow): ListItem {
  return {
    id: row.id,
    source_worker: row.source_worker,
    source_kind: row.source_kind,
    source_id: row.source_id,
    recipient: row.recipient,
    subject: row.subject,
    status: rowStatus(row),
    send_attempts: row.send_attempts,
    last_error: row.last_error,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    sent_at: row.sent_at
  };
}

function attachmentMeta(raw: unknown): AttachmentMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachmentMeta[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const filename = typeof obj.filename === "string" ? obj.filename : "";
    const mime = typeof obj.mime === "string" ? obj.mime : "";
    const size_bytes =
      typeof obj.size_bytes === "number" ? obj.size_bytes : 0;
    out.push({
      filename,
      mime,
      size_bytes,
      has_r2_key: typeof obj.r2_key === "string" && obj.r2_key.length > 0,
      has_base64: typeof obj.base64 === "string" && obj.base64.length > 0
    });
  }
  return out;
}

// =============================================================================
// GET /forms/admin/api/email-queue/list
// =============================================================================

export async function handleEmailQueueList(
  env: Env,
  req: Request
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  const url = new URL(req.url);
  const statusRaw = url.searchParams.get("status") ?? "all";
  const status = STATUS_FILTERS.includes(statusRaw as StatusFilter)
    ? (statusRaw as StatusFilter)
    : ("all" as StatusFilter);

  const sourceWorker = url.searchParams.get("source_worker") ?? undefined;
  const sourceKind = url.searchParams.get("source_kind") ?? undefined;
  const range = resolveDateRange(url);

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

  const requestedOffset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const offset =
    Number.isFinite(requestedOffset) && requestedOffset > 0
      ? requestedOffset
      : 0;

  const pgrest = new URL("/rest/v1/outbound_emails", env.SUPABASE_URL);
  pgrest.searchParams.set(
    "select",
    [
      "id",
      "source_worker",
      "source_kind",
      "source_id",
      "recipient",
      "subject",
      "claimed_at",
      "sent_at",
      "send_attempts",
      "last_error",
      "created_at"
    ].join(",")
  );
  pgrest.searchParams.append("created_at", `gte.${range.fromIso}`);
  pgrest.searchParams.append("created_at", `lte.${range.toIso}`);
  if (sourceWorker) pgrest.searchParams.set("source_worker", `eq.${sourceWorker}`);
  if (sourceKind) pgrest.searchParams.set("source_kind", `eq.${sourceKind}`);

  applyStatusFilter(pgrest, status);

  pgrest.searchParams.set("order", "created_at.desc");
  pgrest.searchParams.set("limit", String(limit + 1));
  if (offset > 0) pgrest.searchParams.set("offset", String(offset));

  let resp: Response;
  try {
    resp = await fetch(pgrest.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Accept: "application/json",
        Prefer: "count=estimated"
      }
    });
  } catch (err) {
    console.error("[forms.email-queue.list] fetch failed", err);
    return jsonError(500, "list_failed");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(
      `[forms.email-queue.list] PostgREST ${resp.status}: ${text.slice(0, 200)}`
    );
    return jsonError(500, "list_failed");
  }
  const rows = (await resp.json().catch(() => [])) as DbRow[];
  const limitHit = rows.length > limit;
  const trimmed = limitHit ? rows.slice(0, limit) : rows;

  // Parse Content-Range estimated total for paginator display.
  const contentRange = resp.headers.get("Content-Range") ?? "";
  const total = parseTotalFromContentRange(contentRange);

  const items: ListItem[] = trimmed.map(toListItem);

  return new Response(
    JSON.stringify({
      items,
      total,
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
}

function applyStatusFilter(url: URL, status: StatusFilter): void {
  switch (status) {
    case "pending":
      url.searchParams.set("sent_at", "is.null");
      url.searchParams.set("claimed_at", "is.null");
      url.searchParams.set("send_attempts", "lt.5");
      return;
    case "claimed":
      url.searchParams.set("sent_at", "is.null");
      url.searchParams.set("claimed_at", "not.is.null");
      url.searchParams.set("send_attempts", "lt.5");
      return;
    case "sent":
      url.searchParams.set("sent_at", "not.is.null");
      return;
    case "stuck":
      url.searchParams.set("sent_at", "is.null");
      url.searchParams.set("send_attempts", "gte.5");
      return;
    case "all":
    default:
      return;
  }
}

function parseTotalFromContentRange(header: string): number | null {
  // Header shape: "0-9/123" or "*/0" — total is after the "/".
  const slash = header.indexOf("/");
  if (slash < 0) return null;
  const tail = header.slice(slash + 1);
  if (tail === "*") return null;
  const n = parseInt(tail, 10);
  return Number.isFinite(n) ? n : null;
}

// =============================================================================
// GET /forms/admin/api/email-queue/{id}
// =============================================================================

export async function handleEmailQueueGet(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);
  if (!ROW_ID_RE.test(id)) return jsonError(400, "bad_id");

  const row = await fetchRow(env, id);
  if (!row) return jsonError(404, "not_found");

  const detail: DetailItem = {
    ...toListItem(row),
    cc: row.cc ?? [],
    reply_to: row.reply_to ?? null,
    body_html: row.body_html ?? null,
    body_text: row.body_text ?? null,
    attachments: attachmentMeta(row.attachments),
    scheduled_for: row.scheduled_for,
    claim_id: row.claim_id
  };

  return new Response(JSON.stringify({ item: detail }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

async function fetchRow(env: Env, id: string): Promise<DbRow | null> {
  const url = new URL("/rest/v1/outbound_emails", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Accept: "application/json"
    }
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(
      `[forms.email-queue.get] PostgREST ${resp.status}: ${text.slice(0, 200)}`
    );
    return null;
  }
  const rows = (await resp.json().catch(() => [])) as DbRow[];
  return rows[0] ?? null;
}

// =============================================================================
// POST /forms/admin/api/email-queue/{id}/retry
// =============================================================================

export async function handleEmailQueueRetry(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);
  if (!ROW_ID_RE.test(id)) return jsonError(400, "bad_id");

  const patch = {
    claimed_at: null,
    claim_id: null,
    send_attempts: 0,
    last_error: null
  };

  const updated = await patchRow(env, id, patch);
  if (!updated) return jsonError(404, "not_found");

  return new Response(JSON.stringify({ ok: true, id: updated.id }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

// =============================================================================
// POST /forms/admin/api/email-queue/{id}/abandon
// =============================================================================

export async function handleEmailQueueAbandon(
  env: Env,
  req: Request,
  id: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);
  if (!ROW_ID_RE.test(id)) return jsonError(400, "bad_id");

  const actorEmail = gate.session.email;
  const stamp = new Date().toISOString();
  const patch = {
    send_attempts: ABANDONED_ATTEMPTS,
    last_error: `Manually abandoned by ${actorEmail} at ${stamp}`
  };

  const updated = await patchRow(env, id, patch);
  if (!updated) return jsonError(404, "not_found");

  return new Response(JSON.stringify({ ok: true, id: updated.id }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function patchRow(
  env: Env,
  id: string,
  patch: Record<string, unknown>
): Promise<DbRow | null> {
  const url = new URL("/rest/v1/outbound_emails", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${id}`);
  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(patch)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(
      `[forms.email-queue.patch] PostgREST ${resp.status}: ${text.slice(0, 200)}`
    );
    return null;
  }
  const rows = (await resp.json().catch(() => [])) as DbRow[];
  return rows[0] ?? null;
}
