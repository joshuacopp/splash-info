// Brief 127 — `POST /forms/internal/api/email-queue/claim`
//
// PA polls this endpoint every ~5 minutes. The endpoint:
//   1. Generates a fresh claim_id.
//   2. Calls the Supabase SQL function `claim_outbound_emails(claim_id,
//      limit)` via PostgREST RPC (encapsulates the FOR UPDATE SKIP
//      LOCKED pattern that PostgREST doesn't expose at the table level).
//   3. For each returned row, inlines R2-backed attachments by fetching
//      + base64-encoding them so PA can send the whole batch without
//      its own R2 credentials.
//   4. Returns `{claim_id, items}` to the caller.
//
// Auth: `X-Email-Queue-Token` HTTP header, compared constant-time to
// `FORMS_EMAIL_QUEUE_TOKEN`. When the secret is unbound the endpoint
// returns 503 — workers keep enqueueing rows safely; the queue just
// idles until PA flow + secret are wired.

import { jsonError } from "@splash/http";

import type { Env } from "../index.js";
import { inlineAttachments, type QueueAttachment } from "./attachments.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface RpcRow {
  id: string;
  source_worker: string;
  source_kind: string;
  source_id: string;
  recipient: string;
  cc: string[] | null;
  reply_to: string | null;
  subject: string;
  body_html: string | null;
  body_text: string | null;
  attachments: unknown;
  scheduled_for: string;
  send_attempts: number;
}

interface ClaimResponseItem {
  id: string;
  source_worker: string;
  source_kind: string;
  source_id: string;
  recipient: string;
  cc: string[];
  reply_to: string | null;
  subject: string;
  body_html: string | null;
  body_text: string | null;
  attachments: QueueAttachment[];
  scheduled_for: string;
  send_attempts: number;
}

export async function handleEmailQueueClaim(
  env: Env,
  req: Request
): Promise<Response> {
  const tokenGate = checkQueueAuth(env, req);
  if (tokenGate) return tokenGate;

  const url = new URL(req.url);
  const requested = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_LIMIT,
    MAX_LIMIT
  );

  const claimId = crypto.randomUUID();

  let rows: RpcRow[];
  try {
    rows = await callClaimRpc(env, claimId, limit);
  } catch (err) {
    console.error("[forms.email-queue.claim] RPC failed", err);
    return jsonError(500, "claim_failed");
  }

  const items: ClaimResponseItem[] = [];
  for (const row of rows) {
    let attachments: QueueAttachment[] = [];
    try {
      attachments = await inlineAttachments(env, row.id, row.attachments);
    } catch (err) {
      console.error(
        `[forms.email-queue.claim] attachment inline failed for row ${row.id}`,
        err
      );
      // Continue with empty attachments rather than fail the whole batch;
      // PA will still send the email body, and a confirm "sent" follows.
    }
    items.push({
      id: row.id,
      source_worker: row.source_worker,
      source_kind: row.source_kind,
      source_id: row.source_id,
      recipient: row.recipient,
      cc: row.cc ?? [],
      reply_to: row.reply_to,
      subject: row.subject,
      body_html: row.body_html,
      body_text: row.body_text,
      attachments,
      scheduled_for: row.scheduled_for,
      send_attempts: row.send_attempts
    });
  }

  return new Response(
    JSON.stringify({ claim_id: claimId, items }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}

async function callClaimRpc(
  env: Env,
  claimId: string,
  limit: number
): Promise<RpcRow[]> {
  const url = new URL("/rest/v1/rpc/claim_outbound_emails", env.SUPABASE_URL);
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ p_claim_id: claimId, p_limit: limit })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `claim_outbound_emails RPC: ${resp.status} ${resp.statusText} — ${text.slice(0, 200)}`
    );
  }
  const rows = (await resp.json().catch(() => [])) as RpcRow[];
  return Array.isArray(rows) ? rows : [];
}

/**
 * Brief 127 — shared-secret gate for the queue endpoints. PA stores the
 * token in its connection config and sends it as `X-Email-Queue-Token`.
 * Constant-time compare to defend against timing attacks. When the
 * secret is unbound, both endpoints return 503 — queueing continues to
 * work, the queue just idles until the operator binds the secret +
 * wires the PA flow.
 */
export function checkQueueAuth(env: Env, req: Request): Response | null {
  if (!env.FORMS_EMAIL_QUEUE_TOKEN) {
    return jsonError(503, "email_queue_token_unbound");
  }
  const supplied = req.headers.get("X-Email-Queue-Token") ?? "";
  if (!constantTimeEquals(supplied, env.FORMS_EMAIL_QUEUE_TOKEN)) {
    return jsonError(401, "bad_email_queue_token");
  }
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
