// Cloudflare Email Service drain for outbound_emails (2026-10-28 pilot).
//
// The Power Automate flow "Splash.info - Forms Mailer" drains the queue via
// POST /forms/internal/api/email-queue/claim. This module is a SECOND drain
// for the source_kinds routed to 'cloudflare' in public.outbound_email_routes
// (supabase/outbound-email-routes-01.sql). The claim RPC partitions rows by
// route, so the two drains can never pick up the same email.
//
// It records results in the same columns PA's confirm call does (sent_at,
// send_attempts, last_error, claim release), so /admin/email-queue, the
// 5-attempt stuck rule and Retry / Abandon all behave the same for both. It
// also stamps sent_via = 'cloudflare' and the provider's message id, which is
// what the pilot is compared on.
//
// Runs from the every-minute cron in index.ts. A no-op when nothing is routed
// here, and fail-soft per row: one bad email never blocks the batch.

import type { Env } from "../index.js";
import { inlineAttachments, type QueueAttachment } from "./attachments.js";

const BATCH_LIMIT = 25;

interface ClaimedRow {
  id: string;
  source_kind: string;
  recipient: string;
  cc: string[] | null;
  reply_to: string | null;
  subject: string;
  body_html: string | null;
  body_text: string | null;
  attachments: unknown;
  send_attempts: number;
}

interface Route {
  source_kind: string;
  from_address: string | null;
}

export interface CloudflareDrainResult {
  claimed: number;
  sent: number;
  failed: number;
  skipped_reason?: string;
}

function sbHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra
  };
}

async function loadRoutes(env: Env): Promise<Map<string, Route>> {
  const url = new URL("/rest/v1/outbound_email_routes", env.SUPABASE_URL);
  url.searchParams.set("transport", "eq.cloudflare");
  url.searchParams.set("select", "source_kind,from_address");
  const res = await fetch(url, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error(`routes read ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = (await res.json()) as Route[];
  return new Map(rows.map((r) => [r.source_kind, r]));
}

async function claim(env: Env, claimId: string): Promise<ClaimedRow[]> {
  const url = new URL("/rest/v1/rpc/claim_outbound_emails", env.SUPABASE_URL);
  const res = await fetch(url, {
    method: "POST",
    headers: sbHeaders(env),
    body: JSON.stringify({ p_claim_id: claimId, p_limit: BATCH_LIMIT, p_transport: "cloudflare" })
  });
  if (!res.ok) throw new Error(`claim RPC ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = (await res.json()) as ClaimedRow[];
  return Array.isArray(rows) ? rows : [];
}

/** PATCH scoped to (id, claim_id), the same guard PA's confirm uses: if the
 *  claim went stale and someone else re-claimed the row, this writes nothing. */
async function patchRow(env: Env, id: string, claimId: string, body: Record<string, unknown>): Promise<void> {
  const url = new URL("/rest/v1/outbound_emails", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("claim_id", `eq.${claimId}`);
  const res = await fetch(url, {
    method: "PATCH",
    headers: sbHeaders(env, { Prefer: "return=minimal" }),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    console.error(`[forms.email-queue.cloudflare] PATCH ${res.status} for ${id}: ${(await res.text()).slice(0, 200)}`);
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toCloudflareAttachments(atts: QueueAttachment[]): EmailAttachment[] {
  const out: EmailAttachment[] = [];
  for (const a of atts) {
    // inlineAttachments has already turned r2_key references into base64;
    // anything it could not fetch arrives without bytes and is dropped
    // (it logged why), matching what PA does with the same payload.
    if (!a.base64) continue;
    const content = base64ToBytes(a.base64);
    if (a.is_inline && a.content_id) {
      out.push({ disposition: "inline", contentId: a.content_id, filename: a.filename, type: a.mime, content });
    } else {
      out.push({ disposition: "attachment", filename: a.filename, type: a.mime, content });
    }
  }
  return out;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    return (code ? `${code}: ` : "") + err.message;
  }
  return String(err);
}

export async function runCloudflareEmailDrain(env: Env): Promise<CloudflareDrainResult> {
  if (!env.EMAIL) return { claimed: 0, sent: 0, failed: 0, skipped_reason: "EMAIL binding unbound" };

  // Routes first: with none routed here there is nothing to claim, and this
  // avoids a claim RPC every minute for a pilot that is switched off.
  const routes = await loadRoutes(env);
  if (routes.size === 0) return { claimed: 0, sent: 0, failed: 0, skipped_reason: "no routes" };

  const claimId = crypto.randomUUID();
  const rows = await claim(env, claimId);
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    // A route can be deleted between the routes read and the claim. Without
    // its from_address we have nobody to send as, so fall back to the env
    // default rather than failing the row.
    const from = routes.get(row.source_kind)?.from_address || env.CF_EMAIL_FROM;
    try {
      if (!from) throw new Error("no from_address on the route and CF_EMAIL_FROM unset");
      const atts = toCloudflareAttachments(await inlineAttachments(env, row.id, row.attachments));
      const result = await env.EMAIL.send({
        from,
        to: row.recipient,
        ...(row.cc && row.cc.length ? { cc: row.cc } : {}),
        ...(row.reply_to ? { replyTo: row.reply_to } : {}),
        subject: row.subject,
        ...(row.body_html ? { html: row.body_html } : {}),
        ...(row.body_text ? { text: row.body_text } : {}),
        ...(atts.length ? { attachments: atts } : {})
      });
      await patchRow(env, row.id, claimId, {
        sent_at: new Date().toISOString(),
        last_error: null,
        sent_via: "cloudflare",
        provider_message_id: result?.messageId ?? null
      });
      sent += 1;
    } catch (err) {
      const msg = errorText(err).slice(0, 1000);
      console.error(`[forms.email-queue.cloudflare] send failed for ${row.id}: ${msg}`);
      await patchRow(env, row.id, claimId, {
        claimed_at: null,
        claim_id: null,
        send_attempts: (row.send_attempts ?? 0) + 1,
        last_error: `cloudflare: ${msg}`
      });
      failed += 1;
    }
  }

  return { claimed: rows.length, sent, failed };
}
