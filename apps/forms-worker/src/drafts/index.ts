// "Save and continue later" (2026-11-15, supabase/forms-secret-links-and-drafts-01.sql).
//
// For forms with forms.email_drafts on. The filler types a Splash email
// address; the answers are stored server-side (form_drafts) and a random
// resume link /forms/resume/{token} is emailed. Built for the shared site
// tablets: people without their own login can still stop and come back, and
// nothing is left in the tablet's browser (local autosave is off for these
// forms -- see forms-public.js).
//
// SECURITY MODEL -- the emailed link IS the key, same as the approval links:
//   * only the SHA-256 of the token is stored;
//   * the link is sent only to a Splash address (DRAFT_EMAIL_DOMAINS), so a
//     personnel draft can't be mailed to a personal inbox;
//   * a draft expires DRAFT_TTL_DAYS after its last save and is deleted by the
//     daily cleanup, and deleted as soon as the form is submitted;
//   * a resume link survives "Change link" on the form (it is the person's
//     own draft), but not the form being unpublished or drafts turned off.
//
// Uploaded files and signatures live in R2 under the draft's
// pending_submission_id, which is kept for the life of the draft; the daily
// orphan sweep skips ids that still have a live draft (cron/cleanup.ts).

import { authenticate, IMPERSONATE_COOKIE } from "@splash/auth";
import { isOriginAllowed, jsonError } from "@splash/http";
import { enqueueOutboundEmail } from "@splash/db-supabase";
import { wrapInEmailShell, escapeHtml, escapeAttr } from "@splash/email-shell";
import type { FormMeta } from "@splash/forms-schema";
import type { Env } from "../index.js";
import { getFormBySlug } from "../db/forms.js";
import { hashToken } from "../approval-links/tokens.js";

export const DRAFT_TTL_DAYS = 14;
/** Resume links only go to these domains (operator, 2026-11-15). */
export const DRAFT_EMAIL_DOMAINS = ["splashcarwashes.com"];
const MAX_VALUES_BYTES = 256 * 1024;
const MAX_NEW_DRAFTS_PER_HOUR = 10;
const RESEND_COOLDOWN_MS = 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DRAFT_TOKEN_RE = /^[A-Za-z0-9_-]{32,100}$/;
const PRODUCTION_BASE = "https://splashcarwashes.info";
const KNOWN_BASES = new Set([PRODUCTION_BASE, "https://staging.splashcarwashes.info"]);

export interface DraftRow {
  id: string;
  form_id: string;
  email: string;
  pending_submission_id: string;
  values: Record<string, unknown>;
  updated_at: string;
  last_emailed_at: string | null;
  expires_at: string;
}

const SELECT = "id,form_id,email,pending_submission_id,values,updated_at,last_emailed_at,expires_at";

function headers(env: Env, extra: Record<string, string> = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}
function rest(env: Env): URL {
  return new URL("/rest/v1/form_drafts", env.SUPABASE_URL);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isAllowedDraftEmail(email: string): boolean {
  const m = /^[^@\s]+@([^@\s]+)$/.exec(email.trim().toLowerCase());
  if (!m || !m[1]) return false;
  return DRAFT_EMAIL_DOMAINS.includes(m[1]);
}

/** "j***@splashcarwashes.com" -- shown on the page, which a tablet passer-by can see. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Keep only what the form inputs can hold. Drops the plumbing (the pending id
 * is kept on the row; the token and Turnstile response must never be stored)
 * and anything that isn't a string or list of strings.
 */
export function cleanDraftValues(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "pending_submission_id" || k.startsWith("_draft") || k === "cf-turnstile-response") continue;
    if (k.length > 200) continue;
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    else continue;
    if (++n > 500) return null;
  }
  return out;
}

async function findDraft(env: Env, token: string): Promise<DraftRow | null> {
  if (!DRAFT_TOKEN_RE.test(token)) return null;
  const u = rest(env);
  u.searchParams.set("token_hash", `eq.${await hashToken(token)}`);
  u.searchParams.set("expires_at", `gt.${new Date().toISOString()}`);
  u.searchParams.set("select", SELECT);
  const r = await fetch(u.toString(), { headers: headers(env) });
  if (!r.ok) throw new Error(`form_drafts get ${r.status}`);
  return ((await r.json()) as DraftRow[])[0] ?? null;
}

/** The live draft for a resume link, or null (unknown, expired, or deleted). */
export async function getDraftByToken(env: Env, token: string): Promise<DraftRow | null> {
  try {
    return await findDraft(env, token);
  } catch (err) {
    console.error("[forms.drafts] lookup failed", err);
    return null;
  }
}

async function recentDraftCount(env: Env, email: string): Promise<number> {
  const u = rest(env);
  u.searchParams.set("email", `eq.${email}`);
  u.searchParams.set("created_at", `gt.${new Date(Date.now() - 3600_000).toISOString()}`);
  u.searchParams.set("select", "id");
  const r = await fetch(u.toString(), { headers: headers(env, { Prefer: "count=exact", Range: "0-0" }) });
  const total = Number((r.headers.get("Content-Range") ?? "").split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

function expiryIso(): string {
  return new Date(Date.now() + DRAFT_TTL_DAYS * 24 * 3600_000).toISOString();
}

function formatEt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}

export function resumeUrl(base: string, token: string): string {
  return `${base}/forms/resume/${token}`;
}

export function renderDraftEmail(args: { title: string; url: string; expiresAt: string }): {
  subject: string;
  html: string;
  text: string;
} {
  // The subject names the FORM only -- never an employee or anything typed
  // into it; subjects show on lock screens and in shared inboxes.
  const subject = `Continue your form: ${args.title}`;
  const until = formatEt(args.expiresAt);
  const bodyHtml =
    `<h2 style="margin: 0 0 12px 0; font-size: 22px; color: #0E2745;">${escapeHtml(args.title)}</h2>` +
    `<p style="margin: 0 0 20px 0; font-size: 15px; line-height: 22px; color: #0E2745;">Your answers are saved. Use this link to pick up where you left off.</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 20px 0;"><tr>` +
    `<td align="center" bgcolor="#1E88E5" style="border-radius: 6px;">` +
    `<a href="${escapeAttr(args.url)}" style="display: inline-block; padding: 12px 24px; font-size: 16px; font-weight: bold; color: #ffffff; text-decoration: none;">Continue the form</a>` +
    `</td></tr></table>` +
    `<p style="margin: 0 0 12px 0; font-size: 14px; line-height: 21px; color: #0E2745;">The link works until <strong>${escapeHtml(until)}</strong> (Eastern). Each time you save again, it gets another ${DRAFT_TTL_DAYS} days. Once the form is submitted, the link stops working.</p>` +
    `<p style="margin: 0 0 12px 0; font-size: 14px; line-height: 21px; color: #8A1C1C;">Don't forward this email. Anyone who has the link can open your answers.</p>` +
    `<p style="margin: 0; font-size: 13px; line-height: 20px; color: #5A6B80;">Didn't ask for this? You can ignore it. Or copy this link: ` +
    `<a href="${escapeAttr(args.url)}" style="color: #1E88E5; word-break: break-all;">${escapeHtml(args.url)}</a></p>`;
  const html = wrapInEmailShell(bodyHtml, { title: subject, preheader: "Your answers are saved. Use the link to pick up where you left off." });
  const text = [
    args.title,
    "",
    "Your answers are saved. Use this link to pick up where you left off:",
    args.url,
    "",
    `The link works until ${until} (Eastern). Each time you save again, it gets another ${DRAFT_TTL_DAYS} days. Once the form is submitted, the link stops working.`,
    "",
    "Don't forward this email. Anyone who has the link can open your answers."
  ].join("\n");
  return { subject, html, text };
}

/**
 * POST /forms/api/drafts/{slugOrKey}
 * Body: { values, pending_submission_id, email?, token?, resend? }
 *
 * No token: a new draft -- email required, the link is emailed.
 * Token: update that draft (silent autosave). The link is emailed again when
 *   `email` changes it or `resend` is set (at most once a minute).
 */
export async function handleSaveDraft(
  env: Env,
  req: Request,
  ctx: ExecutionContext,
  slugOrKey: string
): Promise<Response> {
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const form = await getFormBySlug(env, slugOrKey);
  if (!form || form.status !== "published" || !form.emailDrafts) return jsonError(404, "form_not_found");
  if (form.audience === "public") return jsonError(403, "drafts_not_available");

  // Same posture as submit: an internal form needs a real session, and a
  // refused "View as" session must not slip through as anonymous.
  const cookies = req.headers.get("Cookie") ?? "";
  if (form.audience === "internal" || cookies.includes(`${IMPERSONATE_COOKIE}=`)) {
    const auth = await authenticate(req, env);
    if (auth.status === "unauthenticated") {
      if (auth.reason) return jsonError(403, auth.reason);
      if (form.audience === "internal") return jsonError(401, "session_expired");
    }
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_json");
  }
  const values = cleanDraftValues(body.values);
  if (!values) return jsonError(400, "bad_values");
  if (JSON.stringify(values).length > MAX_VALUES_BYTES) return jsonError(413, "draft_too_large");

  const emailIn = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (emailIn && !isAllowedDraftEmail(emailIn)) return jsonError(400, "email_not_allowed");
  const token = typeof body.token === "string" ? body.token : "";
  const reqOrigin = new URL(req.url).origin;
  const base = KNOWN_BASES.has(reqOrigin) ? reqOrigin : PRODUCTION_BASE;
  const now = new Date();

  try {
    if (token) {
      const draft = await findDraft(env, token);
      if (!draft || draft.form_id !== form.id) return jsonError(404, "draft_not_found");
      const emailChanged = !!emailIn && emailIn !== draft.email;
      const wantEmail =
        (emailChanged || body.resend === true) &&
        (!draft.last_emailed_at || now.getTime() - Date.parse(draft.last_emailed_at) > RESEND_COOLDOWN_MS);
      const email = emailChanged ? emailIn : draft.email;
      const expires = expiryIso();
      const patch: Record<string, unknown> = {
        values,
        email,
        updated_at: now.toISOString(),
        expires_at: expires,
        ...(wantEmail ? { last_emailed_at: now.toISOString() } : {})
      };
      const u = rest(env);
      u.searchParams.set("id", `eq.${draft.id}`);
      const r = await fetch(u.toString(), { method: "PATCH", headers: headers(env), body: JSON.stringify(patch) });
      if (!r.ok) throw new Error(`form_drafts patch ${r.status}`);
      if (wantEmail) ctx.waitUntil(sendDraftEmail(env, form, draft.id, email, resumeUrl(base, token), expires, now));
      return json(200, { ok: true, token, emailed: wantEmail, email_masked: maskEmail(email), expires_at: expires });
    }

    if (!emailIn) return jsonError(400, "email_required");
    const pending = typeof body.pending_submission_id === "string" ? body.pending_submission_id : "";
    if (!UUID_RE.test(pending)) return jsonError(400, "invalid_pending_id");
    if ((await recentDraftCount(env, emailIn)) >= MAX_NEW_DRAFTS_PER_HOUR) return jsonError(429, "too_many_drafts");

    const fresh = newToken();
    const expires = expiryIso();
    const u = rest(env);
    u.searchParams.set("select", "id");
    const r = await fetch(u.toString(), {
      method: "POST",
      headers: headers(env, { Prefer: "return=representation" }),
      body: JSON.stringify({
        form_id: form.id,
        token_hash: await hashToken(fresh),
        email: emailIn,
        pending_submission_id: pending,
        values,
        last_emailed_at: now.toISOString(),
        expires_at: expires
      })
    });
    if (!r.ok) throw new Error(`form_drafts insert ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const id = ((await r.json()) as Array<{ id: string }>)[0]?.id ?? crypto.randomUUID();
    console.log(`[forms.drafts] created form=${form.id} draft=${id}`);
    ctx.waitUntil(sendDraftEmail(env, form, id, emailIn, resumeUrl(base, fresh), expires, now));
    return json(201, { ok: true, token: fresh, emailed: true, email_masked: maskEmail(emailIn), expires_at: expires });
  } catch (err) {
    console.error("[forms.drafts] save failed", err);
    return jsonError(500, "draft_save_failed");
  }
}

async function sendDraftEmail(
  env: Env,
  form: FormMeta,
  draftId: string,
  email: string,
  url: string,
  expiresAt: string,
  now: Date
): Promise<void> {
  const msg = renderDraftEmail({ title: form.title, url, expiresAt });
  try {
    await enqueueOutboundEmail(env, {
      source_worker: "forms",
      source_kind: "form-draft-link",
      // A resend is a new email, so the dedup id carries the send time.
      source_id: `${draftId}:${now.getTime()}`,
      recipient: email,
      subject: msg.subject,
      body_html: msg.html,
      body_text: msg.text
    });
  } catch (err) {
    console.error("[forms.drafts] email enqueue failed", err);
  }
}

/** The form was submitted: its drafts (same pending id) are done. Best-effort. */
export async function deleteDraftsForSubmission(env: Env, formId: string, submissionId: string): Promise<void> {
  try {
    const u = rest(env);
    u.searchParams.set("form_id", `eq.${formId}`);
    u.searchParams.set("pending_submission_id", `eq.${submissionId}`);
    const r = await fetch(u.toString(), { method: "DELETE", headers: headers(env) });
    if (!r.ok) console.error("[forms.drafts] delete on submit returned", r.status);
  } catch (err) {
    console.error("[forms.drafts] delete on submit failed", err);
  }
}

/** Daily cleanup: delete expired drafts. Returns how many went. */
export async function deleteExpiredDrafts(env: Env): Promise<number> {
  const u = rest(env);
  u.searchParams.set("expires_at", `lt.${new Date().toISOString()}`);
  u.searchParams.set("select", "id");
  const r = await fetch(u.toString(), {
    method: "DELETE",
    headers: headers(env, { Prefer: "return=representation" })
  });
  if (r.status === 404) return 0; // table not created yet
  if (!r.ok) throw new Error(`form_drafts expire ${r.status}`);
  return ((await r.json()) as unknown[]).length;
}

/** pending_submission_ids that still have a live draft: their uploads must stay. */
export async function liveDraftPendingIds(env: Env): Promise<Set<string> | null> {
  try {
    const u = rest(env);
    u.searchParams.set("expires_at", `gt.${new Date().toISOString()}`);
    u.searchParams.set("select", "pending_submission_id");
    u.searchParams.set("limit", "10000");
    const r = await fetch(u.toString(), { headers: headers(env) });
    if (r.status === 404) return new Set(); // table not created yet: no drafts
    if (!r.ok) return null;
    return new Set(((await r.json()) as Array<{ pending_submission_id: string }>).map((x) => x.pending_submission_id));
  } catch {
    return null;
  }
}

export function draftExpiredPage(): Response {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Link expired - Splash</title></head><body style="font-family:sans-serif;margin:0;"><div style="padding:48px 16px;text-align:center;max-width:520px;margin:0 auto;"><h1>This link has expired</h1><p>Saved drafts last ${DRAFT_TTL_DAYS} days after the last save, and the link stops working once the form is submitted.</p><p>If you still need to fill it out, open the form again from its usual link.</p></div></body></html>`,
    {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }
    }
  );
}
