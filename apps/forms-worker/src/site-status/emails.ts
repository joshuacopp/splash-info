// Site status emails, through the shared outbound_emails queue.
//
//   closed    RD, RM, HRT, CRD agent, CRD supervisor -- AND the site's own
//             inbox, because this email carries the reopen link (operator
//             2026-11-15). A site with no CRD coverage goes to every supervisor.
//   reopened  same list minus the site.
//   estimate  same list minus the site.
//   overdue   RD + RM only, each with their own no-sign-in link to extend or
//             mark open.
//
// TEST MODE (site_status_settings.test_email_to): every email goes only to that
// address, subject prefixed [TEST], with the intended recipients listed at the
// top. Same idea as a form's test mode.
//
// All sends are fail-soft: a queue error is logged and never undoes the
// status change the person just made.

import { enqueueOutboundEmail } from "@splash/db-supabase";
import { escapeHtml, wrapInEmailShell } from "@splash/email-shell";
import type { Env } from "../index.js";
import { REASON_LABEL, listCrdSupervisors, type Closure, type SiteInfo } from "./data.js";
import { between, fmtDuration, fmtEt } from "./format.js";

export const APP_BASE = "https://splashcarwashes.info";
export const BOARD_URL = `${APP_BASE}/admin/site-status`;

export function reopenLinkUrl(token: string, siteNumber?: number): string {
  return `${APP_BASE}/forms/site-status/${token}${siteNumber ? `?site=${siteNumber}` : ""}`;
}

type Kind = "closed" | "reopened" | "estimate" | "overdue";

function uniq(list: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const e of list) {
    const v = (e ?? "").trim().toLowerCase();
    if (v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) seen.add(v);
  }
  return [...seen];
}

export async function broadcastRecipients(env: Env, site: SiteInfo, includeSite: boolean): Promise<string[]> {
  let crd: string[] = [site.crd_email, site.crd_supervisor_email].filter((e): e is string => !!e);
  if (!site.crd_covered) {
    try {
      crd = await listCrdSupervisors(env);
    } catch (err) {
      console.error("[site-status] supervisor list failed", err);
      crd = [];
    }
  }
  return uniq([site.rd_email, site.rm_email, site.hrt_email, ...crd, includeSite ? site.site_email : null]);
}

// ---- rendering ----------------------------------------------------------------

function row(label: string, value: string): string {
  return `<tr><td style="padding:6px 12px 6px 0;color:#5b6b82;font-size:13px;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td><td style="padding:6px 0;color:#0b2a4a;font-size:14px">${value}</td></tr>`;
}

function button(url: string, label: string, color = "#1b75bb"): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;margin:6px 8px 6px 0"><tr><td style="background:${color};border-radius:6px"><a href="${escapeHtml(url)}" style="display:inline-block;padding:11px 20px;color:#ffffff;font-weight:bold;font-size:14px;text-decoration:none">${escapeHtml(label)}</a></td></tr></table>`;
}

function reasonText(c: Closure): string {
  const base = REASON_LABEL[c.reason] ?? c.reason;
  return c.reason_detail ? `${base} - ${c.reason_detail}` : base;
}

function details(c: Closure, now: Date): string {
  const rows = [
    row("Site", escapeHtml(`${c.site_name} (${c.site_number})`)),
    row("Reason", escapeHtml(reasonText(c))),
    row("Closed by", escapeHtml(c.closed_by)),
    row("Closed at", escapeHtml(fmtEt(c.closed_at))),
    row("Expected to reopen", escapeHtml(`${fmtEt(c.est_reopen_at)} (${fmtDuration(between(c.closed_at, c.est_reopen_at))} total)`))
  ];
  if (c.reopened_at) {
    rows.push(row("Reopened", escapeHtml(`${fmtEt(c.reopened_at)} by ${c.reopened_by ?? "-"}`)));
    rows.push(row("Closed for", `<strong>${escapeHtml(fmtDuration(between(c.closed_at, c.reopened_at)))}</strong>`));
    if (c.reopen_note) rows.push(row("Note", escapeHtml(c.reopen_note)));
  } else {
    rows.push(row("Closed so far", escapeHtml(fmtDuration(now.getTime() - new Date(c.closed_at).getTime()))));
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px">${rows.join("")}</table>`;
}

function detailsText(c: Closure, now: Date): string {
  const lines = [
    `Site: ${c.site_name} (${c.site_number})`,
    `Reason: ${reasonText(c)}`,
    `Closed by: ${c.closed_by}`,
    `Closed at: ${fmtEt(c.closed_at)}`,
    `Expected to reopen: ${fmtEt(c.est_reopen_at)}`
  ];
  if (c.reopened_at) {
    lines.push(`Reopened: ${fmtEt(c.reopened_at)} by ${c.reopened_by ?? "-"}`);
    lines.push(`Closed for: ${fmtDuration(between(c.closed_at, c.reopened_at))}`);
    if (c.reopen_note) lines.push(`Note: ${c.reopen_note}`);
  } else {
    lines.push(`Closed so far: ${fmtDuration(now.getTime() - new Date(c.closed_at).getTime())}`);
  }
  return lines.join("\n");
}

interface Rendered {
  subject: string;
  /** Body HTML before the email shell is wrapped around it. */
  body: string;
  text: string;
}

export function renderEmail(
  kind: Kind,
  c: Closure,
  opts: { reopenUrl?: string | null; manageUrl?: string | null; estimateNote?: string | null; now?: Date }
): Rendered {
  const now = opts.now ?? new Date();
  const where = `${c.site_name} (${c.site_number})`;
  let subject: string;
  let lead: string;
  let buttons = "";
  let textActions = "";

  switch (kind) {
    case "closed":
      subject = `CLOSED: ${where} - ${REASON_LABEL[c.reason]}`;
      lead = `<strong>${escapeHtml(where)}</strong> has been closed.`;
      if (opts.reopenUrl) {
        buttons += button(opts.reopenUrl, "Mark the site open", "#1f8a4c");
        textActions += `\nWhen the site reopens, mark it open here: ${opts.reopenUrl}`;
      }
      break;
    case "reopened":
      subject = `OPEN: ${where} is back open`;
      lead = `<strong>${escapeHtml(where)}</strong> is open again.`;
      break;
    case "estimate":
      subject = `UPDATE: ${where} now expected to reopen ${fmtEt(c.est_reopen_at)}`;
      lead = `The expected reopen time for <strong>${escapeHtml(where)}</strong> has changed.`;
      if (opts.estimateNote) lead += `<br/>Note: ${escapeHtml(opts.estimateNote)}`;
      break;
    case "overdue":
      subject = `STILL CLOSED: ${where} was expected open at ${fmtEt(c.est_reopen_at)}`;
      lead = `<strong>${escapeHtml(where)}</strong> is past its expected reopen time and is still marked closed. Extend the estimate, or mark it open if it already is.`;
      if (opts.manageUrl) {
        buttons += button(opts.manageUrl, "Extend or mark open");
        textActions += `\nExtend or mark open: ${opts.manageUrl}`;
      }
      break;
  }

  buttons += button(BOARD_URL, "Site status board", "#0b2a4a");
  textActions += `\nSite status board: ${BOARD_URL}`;

  const body = `<p style="font-size:15px;color:#0b2a4a;margin:0 0 8px">${lead}</p>${details(c, now)}<div>${buttons}</div>`;
  const leadText = lead.replace(/<br\/>/g, "\n").replace(/<[^>]+>/g, "");
  return {
    subject,
    body,
    text: `${leadText}\n\n${detailsText(c, now)}\n${textActions}\n`
  };
}

// ---- sending ------------------------------------------------------------------

async function enqueue(
  env: Env,
  args: { kind: Kind; sourceId: string; to: string; r: Rendered; testTo: string | null; intended: string[] }
): Promise<void> {
  const { r } = args;
  let subject = r.subject;
  let body = r.body;
  let text = r.text;
  let to = args.to;
  if (args.testTo) {
    to = args.testTo;
    subject = `[TEST] ${subject}`;
    const list = args.intended.join(", ") || "(nobody)";
    body = `<div style="background:#fff4d6;border:1px solid #e0b84c;padding:10px 12px;margin:0 0 14px;font-size:13px;color:#5a4300">TEST MODE - in live mode this would go to: ${escapeHtml(list)}</div>${body}`;
    text = `TEST MODE - in live mode this would go to: ${list}\n\n${text}`;
  }
  const html = wrapInEmailShell(body, { title: subject, preheader: r.subject });
  try {
    await enqueueOutboundEmail(env, {
      source_worker: "forms-worker",
      source_kind: `site-status-${args.kind}`,
      source_id: args.sourceId,
      recipient: to,
      subject,
      body_html: html,
      body_text: text
    });
  } catch (err) {
    console.error(`[site-status] enqueue ${args.kind} failed for ${to}`, err);
  }
}

/** One email per recipient (or one test email listing them all). */
export async function sendBroadcast(
  env: Env,
  kind: "closed" | "reopened" | "estimate",
  c: Closure,
  site: SiteInfo,
  opts: { testTo: string | null; reopenUrl?: string | null; estimateNote?: string | null; eventKey: string }
): Promise<void> {
  const recipients = await broadcastRecipients(env, site, kind === "closed");
  const r = renderEmail(kind, c, opts);
  const sourceId = `${c.id}:${opts.eventKey}`;
  if (opts.testTo) {
    await enqueue(env, { kind, sourceId, to: opts.testTo, r, testTo: opts.testTo, intended: recipients });
    return;
  }
  await Promise.all(recipients.map((to) => enqueue(env, { kind, sourceId, to, r, testTo: null, intended: recipients })));
}

/** Overdue: each RD / RM gets their own manage link. */
export async function sendOverdue(
  env: Env,
  c: Closure,
  site: SiteInfo | null,
  opts: { testTo: string | null; mintLink: (recipient: string) => Promise<string | null> }
): Promise<number> {
  const recipients = uniq([site?.rd_email ?? c.rd_email, site?.rm_email ?? c.rm_email]);
  let sent = 0;
  for (const person of recipients) {
    const manageUrl = await opts.mintLink(person);
    const r = renderEmail("overdue", c, { manageUrl });
    // Keyed on the estimate it is about, so extending re-arms a fresh email.
    const sourceId = `${c.id}:overdue:${c.est_reopen_at}:${person}`;
    await enqueue(env, {
      kind: "overdue",
      sourceId,
      to: opts.testTo ?? person,
      r,
      testTo: opts.testTo,
      intended: [person]
    });
    sent++;
  }
  return sent;
}
