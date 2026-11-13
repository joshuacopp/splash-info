// POST /forms/admin/api/forms/{id}/share-email
//
// Email a published form's public link to a list of people. Recipients come
// from the share dialog on /admin/forms and the builder: addresses picked
// from the org directory (/forms/admin/api/users/search) and addresses typed
// free-hand for people with no account. The worker cannot tell the two apart
// and does not need to -- both are just validated email addresses.
//
// Body: { recipients: string[], message?: string }
//
// The dialog POSTs here straight from the browser (same origin -- forms is
// path-carved), so the request's own origin says whether the sender is on
// production or staging and the link matches what they are looking at. It
// is honoured only when it is one of KNOWN_BASES; anything else (a
// workers.dev host, the "https://internal" of a service-binding call) links
// to production, so the client can never steer where the emailed link goes.
//
// Delivery rides the Brief 127 outbound_emails queue. source_id carries a
// fresh UUID per send, so sending the same form to the same person again
// later is a new email rather than a dedup no-op; a double-click inside one
// send is still collapsed because the recipient list is deduped here.
//
// Auth: adminGate, the same gate as the forms list the dialog lives on.

import { isOriginAllowed, jsonError } from "@splash/http";
import { enqueueOutboundEmail } from "@splash/db-supabase";
import { wrapInEmailShell, escapeHtml, escapeAttr } from "@splash/email-shell";
import { isValidEmail } from "@splash/types/email-validate";
import { adminGate, adminGateResponse, requireServiceKey } from "./auth.js";
import type { Env } from "../index.js";

const PRODUCTION_BASE = "https://splashcarwashes.info";
const KNOWN_BASES = new Set([PRODUCTION_BASE, "https://staging.splashcarwashes.info"]);
const MAX_RECIPIENTS = 50;
const MAX_MESSAGE = 2000;

interface FormRow {
  id: string;
  slug: string;
  title: string | null;
  status: string;
  audience: string;
}

export async function handleShareFormEmail(
  env: Env,
  req: Request,
  formId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);
  const session = gate.session;

  let body: { recipients?: unknown; message?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "bad_request");
  }

  if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
    return jsonError(400, "no_recipients");
  }
  const seen = new Set<string>();
  const recipients: string[] = [];
  const invalid: string[] = [];
  for (const raw of body.recipients) {
    const email = typeof raw === "string" ? raw.trim() : "";
    if (!email || !isValidEmail(email)) {
      invalid.push(String(raw));
      continue;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(email);
  }
  if (invalid.length > 0) {
    return json(400, { error: "invalid_recipients", invalid });
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return json(400, { error: "too_many_recipients", max: MAX_RECIPIENTS });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length > MAX_MESSAGE) {
    return json(400, { error: "message_too_long", max: MAX_MESSAGE });
  }
  const reqOrigin = new URL(req.url).origin;
  const base = KNOWN_BASES.has(reqOrigin) ? reqOrigin : PRODUCTION_BASE;

  const form = await fetchForm(env, formId);
  if (!form) return jsonError(404, "form_not_found");
  if (form.status !== "published") return jsonError(409, "form_not_published");

  const formUrl = `${base}/forms/${encodeURIComponent(form.slug)}`;
  const title = form.title?.trim() || form.slug;
  const sender = session.email ?? "";
  const rendered = renderShareEmail({ title, formUrl, sender, message });
  const sendId = crypto.randomUUID();

  let sent = 0;
  const failed: string[] = [];
  for (const recipient of recipients) {
    try {
      await enqueueOutboundEmail(env, {
        source_worker: "forms",
        source_kind: "form-share",
        source_id: `${form.id}:${sendId}`,
        recipient,
        ...(sender ? { reply_to: sender } : {}),
        subject: rendered.subject,
        body_html: rendered.html,
        body_text: rendered.text,
        attachments: []
      });
      sent++;
    } catch (err) {
      console.error("[forms.share-email] enqueue failed", recipient, err);
      failed.push(recipient);
    }
  }

  console.log("[forms.share-email] queued", {
    formId: form.id,
    by: sender,
    sent,
    failed: failed.length
  });
  return json(failed.length === recipients.length ? 502 : 200, {
    ok: failed.length < recipients.length,
    sent,
    failed
  });
}

async function fetchForm(env: Env, formId: string): Promise<FormRow | null> {
  const url = new URL("/rest/v1/forms", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${formId}`);
  url.searchParams.set("select", "id,slug,title,status,audience");
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Accept: "application/json"
    }
  });
  if (!resp.ok) throw new Error(`share-email: form fetch ${resp.status}`);
  const rows = (await resp.json().catch(() => [])) as FormRow[];
  return rows[0] ?? null;
}

export function renderShareEmail(input: {
  title: string;
  formUrl: string;
  sender: string;
  message: string;
}): { subject: string; html: string; text: string } {
  const { title, formUrl, sender, message } = input;
  const subject = `Please fill out: ${title}`;
  const intro = sender
    ? `${sender} sent you a form to fill out.`
    : "You've been sent a form to fill out.";

  const messageHtml = message
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 0 0 20px 0;"><tr>` +
      `<td style="border-left: 4px solid #1E88E5; background-color: #F3F8FD; padding: 12px 16px; font-size: 15px; line-height: 22px; color: #0E2745;">` +
      escapeHtml(message).replace(/\r?\n/g, "<br />") +
      `</td></tr></table>`
    : "";

  const bodyHtml =
    `<h2 style="margin: 0 0 12px 0; font-size: 22px; color: #0E2745;">${escapeHtml(title)}</h2>` +
    `<p style="margin: 0 0 20px 0; font-size: 15px; line-height: 22px; color: #0E2745;">${escapeHtml(intro)}</p>` +
    messageHtml +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 20px 0;"><tr>` +
    `<td align="center" bgcolor="#1E88E5" style="border-radius: 6px;">` +
    `<a href="${escapeAttr(formUrl)}" style="display: inline-block; padding: 12px 24px; font-size: 16px; font-weight: bold; color: #ffffff; text-decoration: none;">Open the form</a>` +
    `</td></tr></table>` +
    `<p style="margin: 0; font-size: 13px; line-height: 20px; color: #5A6B80;">Or copy this link: ` +
    `<a href="${escapeAttr(formUrl)}" style="color: #1E88E5; word-break: break-all;">${escapeHtml(formUrl)}</a></p>`;

  const html = wrapInEmailShell(bodyHtml, {
    title: subject,
    preheader: message || intro
  });

  const text = [
    title,
    "",
    intro,
    ...(message ? ["", message] : []),
    "",
    `Open the form: ${formUrl}`
  ].join("\n");

  return { subject, html, text };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
