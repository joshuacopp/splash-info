// IT Issue Tracker emails: the daily report to IT and the per-issue
// "Send to IT support now" escalation. Both go through the shared
// outbound_emails queue and both carry no-sign-in links (it-issues.ts
// mintIssueLink) so IT can add a ticket number or close an issue from the
// email without ever signing in. IT staff who do sign in hold the
// `it_issues_it` grant, so their in-app actions count as IT's too.
//
// RECIPIENTS ARE [vars], not code: IT_ISSUES_REPORT_TO / IT_ISSUES_ESCALATE_TO
// in wrangler.toml. During testing both point at the operator so IT is not
// bothered by a half-finished tool; going live is a one-line change each.

import { enqueueOutboundEmail } from "@splash/db-supabase";
import { escapeHtml, wrapInEmailShell } from "@splash/email-shell";
import {
  IMPACT_LABEL,
  appsWebBase,
  deviceLabel,
  mintIssueLink,
  pg,
  recipientsOf,
  type EventRow,
  type IssueRow,
  type ItIssuesEnv
} from "./it-issues.js";

const NAVY = "#0b2545";
const MUTED = "#5b6b7f";
const RULE = "#e3e8ef";
const RED = "#b42318";
const AMBER = "#b54708";

/** Sent to IT at least this long ago, with no IT action for at least this
 *  long, puts an issue in "Needs attention". */
export const IT_RESPONSE_DAYS = 2;

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  waiting_on_it: "Waiting on IT",
  in_progress: "In progress",
  resolved: "Resolved"
};
const KIND_LABEL: Record<string, string> = {
  created: "Reported",
  occurrence: "Happened again",
  note: "Note",
  status: "Status changed",
  ticket: "Ticket # added",
  escalated: "Sent to IT support",
  resolved: "Resolved",
  reopened: "Reopened",
  mx_request: "MaintainX request created",
  priority: "Priority changed",
  provider_contact: "Called the POS provider"
};

function fmt(iso: string | null): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}

function easternDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function refs(issue: IssueRow): string {
  const parts: string[] = [];
  if (issue.it_ticket_no) parts.push(`IT ticket ${issue.it_ticket_no}`);
  if (issue.pos_provider_ticket_no) parts.push(`${issue.pos_provider ?? "POS provider"} ticket ${issue.pos_provider_ticket_no}`);
  if (issue.mx_request_id) parts.push(`MaintainX request #${issue.mx_request_id}`);
  return parts.join(" / ");
}

/**
 * Whether the site has raised it with the POS provider's own tech support
 * (Micrologic, DRB, ICS) -- not Splash IT. "" for older issues never asked.
 */
export function providerSummary(
  issue: Pick<
    IssueRow,
    | "pos_provider_opened"
    | "pos_provider"
    | "pos_provider_ticket_no"
    | "pos_provider_first_contact_at"
    | "pos_provider_last_contact_at"
  >
): string {
  if (issue.pos_provider_opened === false) return "No ticket opened with the POS provider";
  if (!issue.pos_provider_opened) return "";
  const first = issue.pos_provider_first_contact_at;
  const last = issue.pos_provider_last_contact_at;
  return [
    issue.pos_provider ?? "POS provider",
    issue.pos_provider_ticket_no ? `ticket ${issue.pos_provider_ticket_no}` : "",
    first ? `called ${fmt(first)}` : "",
    last && last !== first ? `last contact ${fmt(last)}` : ""
  ]
    .filter(Boolean)
    .join(", ");
}

/** "#" or "#s": the field takes a comma-separated list of ticket numbers. */
export function ticketLabel(v: string | null | undefined): string {
  return v && /[,;]/.test(v) ? "Transaction ticket #s" : "Transaction ticket #";
}

/** "transaction ticket 123, account 456", or "" when neither was given. */
export function customerRefsText(ticket: unknown, account: unknown): string {
  const parts: string[] = [];
  if (typeof ticket === "string" && ticket) {
    parts.push(`${/[,;]/.test(ticket) ? "transaction tickets" : "transaction ticket"} ${ticket}`);
  }
  if (typeof account === "string" && account) parts.push(`account ${account}`);
  return parts.join(", ");
}

export function eventLine(ev: EventRow): string {
  const d = ev.details ?? {};
  let what = KIND_LABEL[ev.kind] ?? ev.kind;
  if (ev.kind === "status") what = `Status: ${STATUS_LABEL[String(d.to)] ?? d.to}`;
  if (ev.kind === "priority") what = `Priority: ${cap(String(d.to))}`;
  if (ev.kind === "ticket") what = `Ticket #: ${d.to}`;
  if (ev.kind === "mx_request") what = `MaintainX request #${d.mx_request_id}`;
  if (ev.kind === "provider_contact") {
    what = `Called ${String(d.provider ?? "the POS provider")}${d.ticket_no ? ` (their ticket ${String(d.ticket_no)})` : ""}`;
  }
  if (ev.kind === "occurrence" && d.error_text) what += ` (error: ${d.error_text})`;
  const cust = ev.kind === "occurrence" ? customerRefsText(d.customer_ticket_no, d.customer_account_no) : "";
  if (cust) what += ` (${cust})`;
  if (Array.isArray(d.photos) && d.photos.length) {
    what += ` [${d.photos.length} photo${d.photos.length === 1 ? "" : "s"} - open the issue to see]`;
  }
  const who = [
    ev.actor_name,
    ev.by_it && ev.via !== "email_link" ? "IT" : "",
    ev.via === "email_link" ? "IT, via email link" : ""
  ]
    .filter(Boolean)
    .join(", ");
  // The time it HAPPENED leads; the time it was logged follows only when the
  // two differ enough to matter (a site logging an hour later).
  const happened = ev.occurred_at ?? ev.at;
  const late = Math.abs(Date.parse(ev.at) - Date.parse(happened)) >= 15 * 60_000;
  const logged = late ? ` (logged ${fmt(ev.at)})` : "";
  return `${fmt(happened)} - ${what}${logged}${who ? ` - ${who}` : ""}${ev.note ? `: ${ev.note}` : ""}`;
}

function button(url: string, label: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="background:#1f6feb;border-radius:6px;">` +
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;color:#ffffff;font-weight:bold;text-decoration:none;font-size:14px;">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

function detailRows(issue: IssueRow): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Site", issue.site_name],
    ["Device", deviceLabel(issue)],
    ["Problem", issue.problem],
    ["Error message", issue.error_text ?? ""],
    ["Customer impact", IMPACT_LABEL[issue.customer_impact]],
    ["Priority", cap(issue.priority)],
    ["Status", STATUS_LABEL[issue.status] ?? issue.status],
    [ticketLabel(issue.customer_ticket_no), issue.customer_ticket_no ?? ""],
    ["Customer account #", issue.customer_account_no ?? ""],
    ["First happened", fmt(issue.first_reported_at)],
    ["Times it has happened", String(issue.occurrence_count)],
    ["Last happened", fmt(issue.last_occurred_at)],
    ["Already tried", issue.troubleshooting ?? ""],
    ["POS provider", providerSummary(issue)],
    ["Reported by", `${issue.reporter_name}, ${issue.reporter_phone}`],
    ["Ticket numbers", refs(issue)]
  ];
  return rows.filter(([, v]) => v !== "");
}

/* ============================================================
 * Escalation
 * ============================================================ */

/** The escalating user's address, if it looks like one. A bad Reply-To can
 *  make the whole send fail, and the mail flow pastes it into JSON unescaped,
 *  so quotes, backslashes and anything else doubtful are left off. */
export function escalationReplyTo(email: string | null | undefined): string | undefined {
  const e = email?.trim().toLowerCase();
  return e && /^[^@\s"\\<>,;]+@[^@\s"\\<>,;]+\.[a-z]{2,}$/.test(e) ? e : undefined;
}

export async function sendEscalationEmail(
  env: ItIssuesEnv,
  issue: IssueRow,
  events: EventRow[],
  escalation: EventRow,
  to: string[]
): Promise<{ sent: string[]; failed: string[] }> {
  const subject = `IT issue IT-${issue.ref_no} - ${issue.site_name}: ${deviceLabel(issue)} - ${issue.problem}`.slice(0, 200);
  const result = { sent: [] as string[], failed: [] as string[] };
  const replyTo = escalationReplyTo(escalation.actor_email);

  for (const recipient of to) {
    const link = await mintIssueLink(env, issue.id, recipient);
    const html = wrapInEmailShell(
      [
        `<h2 style="margin:0 0 6px;color:${NAVY};font-size:20px;">IT-${issue.ref_no}: ${escapeHtml(deviceLabel(issue))} at ${escapeHtml(issue.site_name)}</h2>`,
        `<p style="margin:0 0 14px;color:${MUTED};font-size:13px;">Sent to IT support by ${escapeHtml(escalation.actor_name ?? "the site")} on ${escapeHtml(fmt(escalation.at))}.</p>`,
        escalation.note
          ? `<div style="background:#fff7e6;border-left:4px solid ${AMBER};padding:10px 12px;margin:0 0 14px;color:${NAVY};font-size:14px;">${escapeHtml(escalation.note).replace(/\n/g, "<br />")}</div>`
          : "",
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:${NAVY};margin-bottom:14px;">`,
        detailRows(issue)
          .map(
            ([k, v]) =>
              `<tr><td style="padding:4px 10px 4px 0;color:${MUTED};vertical-align:top;white-space:nowrap;">${escapeHtml(k)}</td>` +
              `<td style="padding:4px 0;">${escapeHtml(v).replace(/\n/g, "<br />")}</td></tr>`
          )
          .join(""),
        `</table>`,
        `<div style="font-size:13px;font-weight:bold;color:${NAVY};margin:6px 0;">Timeline</div>`,
        `<ul style="margin:0 0 16px;padding-left:18px;font-size:13px;color:${NAVY};">`,
        events.map((e) => `<li style="margin-bottom:3px;">${escapeHtml(eventLine(e))}</li>`).join(""),
        `</ul>`,
        link ? button(link, "Open issue - add a ticket # or close it") : "",
        link
          ? `<p style="margin:10px 0 0;color:${MUTED};font-size:12px;">No sign-in needed. The link works until the issue is resolved.</p>`
          : ""
      ].join(""),
      { title: subject, preheader: `${issue.site_name}: ${issue.problem}`.slice(0, 100) }
    );
    const text = [
      `IT-${issue.ref_no}: ${deviceLabel(issue)} at ${issue.site_name}`,
      `Sent to IT support by ${escalation.actor_name ?? "the site"} on ${fmt(escalation.at)}.`,
      escalation.note ? `\n${escalation.note}\n` : "",
      ...detailRows(issue).map(([k, v]) => `${k}: ${v}`),
      "",
      "Timeline:",
      ...events.map((e) => `- ${eventLine(e)}`),
      "",
      link ? `Open issue (no sign-in): ${link}` : ""
    ].join("\n");

    try {
      await enqueueOutboundEmail(env, {
        source_worker: "workorders-worker",
        source_kind: "it-issue-escalation",
        // One email per press: the event id makes each escalation distinct.
        source_id: `${issue.id}:${escalation.id}`,
        recipient,
        // IT's reply goes to whoever pressed the button, not the no-reply sender.
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject,
        body_html: html,
        body_text: text,
        attachments: []
      });
      result.sent.push(recipient);
    } catch (err) {
      console.error(`[it-issues] escalation enqueue failed for ${recipient}:`, err);
      result.failed.push(recipient);
    }
  }
  return result;
}

/* ============================================================
 * Daily report
 * ============================================================ */

export interface ItReportResult {
  open: number;
  attention: number;
  resolvedRecently: number;
  emailsQueued: number;
  skipped: string | null;
}

export type DigestBucket = "attention" | "with_it" | "site";

/**
 * Where an open issue goes in the digest, and the flag shown beside it.
 *
 *   attention -- sent to IT IT_RESPONSE_DAYS+ ago and IT has done nothing for
 *                IT_RESPONSE_DAYS+. The ONLY thing that means "needs
 *                attention": a one-off glitch that never came back is not a
 *                problem, IT not answering is.
 *   with_it   -- sent to IT, not overdue.
 *   site      -- never sent to IT; the site is monitoring it. Critical ones
 *                carry a flag, because a critical issue nobody sent is the
 *                one case here IT would want to hear about.
 */
export function digestBucket(
  issue: Pick<IssueRow, "first_escalated_at" | "last_it_action_at" | "priority">,
  now: number
): { bucket: DigestBucket; flag: string | null } {
  if (!issue.first_escalated_at) {
    return { bucket: "site", flag: issue.priority === "critical" ? "Critical, not sent to IT" : null };
  }
  const days = (iso: string) => Math.floor((now - Date.parse(iso)) / 86_400_000);
  const sent = days(issue.first_escalated_at);
  const quiet = issue.last_it_action_at ? days(issue.last_it_action_at) : sent;
  if (sent >= IT_RESPONSE_DAYS && quiet >= IT_RESPONSE_DAYS) {
    return {
      bucket: "attention",
      flag: issue.last_it_action_at
        ? `No IT action for ${quiet} day${quiet === 1 ? "" : "s"}`
        : `Sent to IT ${sent} day${sent === 1 ? "" : "s"} ago, no IT action yet`
    };
  }
  return { bucket: "with_it", flag: null };
}

function compareIssues(a: IssueRow, b: IssueRow): number {
  return (
    (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
    Date.parse(a.first_reported_at) - Date.parse(b.first_reported_at)
  );
}

export async function runItIssuesDailyReport(env: ItIssuesEnv, now = new Date()): Promise<ItReportResult> {
  const result: ItReportResult = { open: 0, attention: 0, resolvedRecently: 0, emailsQueued: 0, skipped: null };
  const to = recipientsOf(env.IT_ISSUES_REPORT_TO);
  if (to.length === 0) {
    result.skipped = "IT_ISSUES_REPORT_TO unset";
    return result;
  }

  const since = encodeURIComponent(new Date(now.getTime() - 86_400_000).toISOString());
  const [openRes, doneRes] = await Promise.all([
    pg<IssueRow[]>(env, "GET", "it_issues?select=*&status=neq.resolved&limit=1000"),
    pg<IssueRow[]>(env, "GET", `it_issues?select=*&status=eq.resolved&resolved_at=gte.${since}&order=resolved_at.desc&limit=200`)
  ]);
  if (!openRes.ok || !doneRes.ok) {
    result.skipped = "read failed";
    return result;
  }
  const open = (openRes.data ?? []).sort(compareIssues);
  const done = doneRes.data ?? [];
  const nowMs = now.getTime();
  const placed = new Map(open.map((i) => [i.id, digestBucket(i, nowMs)]));
  const flagOf = (i: IssueRow) => placed.get(i.id)?.flag ?? null;
  const attention = open.filter((i) => placed.get(i.id)?.bucket === "attention");
  const withIt = open.filter((i) => placed.get(i.id)?.bucket === "with_it");
  const atSite = open.filter((i) => placed.get(i.id)?.bucket === "site");
  result.open = open.length;
  result.attention = attention.length;
  result.resolvedRecently = done.length;

  // The same device type open at more than one site -- the pattern per-site
  // spreadsheets hid (Binghamton and Fayetteville logged the same dead kiosk
  // scanner on the same day). Sites cannot see each other's issues, so this
  // is the only place it shows.
  const byDevice = new Map<string, IssueRow[]>();
  for (const i of open) byDevice.set(i.device, [...(byDevice.get(i.device) ?? []), i]);
  const shared = [...byDevice.entries()]
    .filter(([, list]) => new Set(list.map((i) => i.location_id)).size > 1)
    .sort((a, b) => b[1].length - a[1].length);

  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(now);
  const subject =
    open.length === 0
      ? `IT issues ${dateLabel}: nothing open`
      : `IT issues ${dateLabel}: ${open.length} open${attention.length ? `, ${attention.length} need attention` : ""}`;

  const base = appsWebBase(env);
  for (const recipient of to) {
    // Links are per recipient, so they are minted inside the loop.
    const links = new Map<string, string | null>();
    for (const i of [...open, ...done]) links.set(i.id, await mintIssueLink(env, i.id, recipient));

    const row = (i: IssueRow, flag: string | null) => {
      const link = links.get(i.id);
      const meta = [
        `${cap(i.priority)}`,
        STATUS_LABEL[i.status] ?? i.status,
        `reported ${fmt(i.first_reported_at)}`,
        i.occurrence_count > 1 ? `happened ${i.occurrence_count} times, last ${fmt(i.last_occurred_at)}` : "",
        i.first_escalated_at ? `sent to IT ${fmt(i.first_escalated_at)}` : "",
        i.last_it_action_at ? `last IT action ${fmt(i.last_it_action_at)}` : "",
        refs(i),
        i.pos_provider_opened === false ? "not raised with the POS provider" : ""
      ]
        .filter(Boolean)
        .join(" &middot; ");
      return (
        `<tr><td style="padding:8px 0;border-bottom:1px solid ${RULE};font-size:14px;color:${NAVY};">` +
        `<div><strong>IT-${i.ref_no}</strong> ${escapeHtml(i.site_name)} - ${escapeHtml(deviceLabel(i))}` +
        (flag ? ` <span style="color:${RED};font-weight:bold;">(${escapeHtml(flag)})</span>` : "") +
        `</div>` +
        `<div style="margin:2px 0;">${escapeHtml(i.problem)}</div>` +
        `<div style="font-size:12px;color:${MUTED};">${meta}` +
        (link ? ` &middot; <a href="${escapeHtml(link)}" style="color:#1f6feb;">Open</a>` : "") +
        `</div></td></tr>`
      );
    };
    const section = (title: string, rows: string) =>
      rows
        ? `<div style="font-size:15px;font-weight:bold;color:${NAVY};margin:18px 0 4px;">${escapeHtml(title)}</div>` +
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>`
        : "";

    const sharedHtml = shared.length
      ? `<div style="font-size:15px;font-weight:bold;color:${NAVY};margin:18px 0 4px;">Same device open at more than one site</div>` +
        `<ul style="margin:0;padding-left:18px;font-size:14px;color:${NAVY};">` +
        shared
          .map(
            ([device, list]) =>
              `<li>${escapeHtml(device)}: ${list.map((i) => `${escapeHtml(i.site_name)} (IT-${i.ref_no})`).join(", ")}</li>`
          )
          .join("") +
        `</ul>`
      : "";

    const html = wrapInEmailShell(
      [
        `<h2 style="margin:0 0 4px;color:${NAVY};font-size:20px;">IT issues - ${escapeHtml(dateLabel)}</h2>`,
        `<p style="margin:0;color:${MUTED};font-size:13px;">${open.length} open, ${attention.length} need attention, ${done.length} resolved in the last day. ` +
          `"Needs attention" = sent to IT ${IT_RESPONSE_DAYS}+ days ago with no IT action for ${IT_RESPONSE_DAYS}+ days. ` +
          `Each "Open" link works without signing in: add your ticket number, or close the issue with a note.</p>`,
        open.length === 0 && done.length === 0
          ? `<p style="margin:16px 0 0;color:${NAVY};font-size:14px;">No open IT issues.</p>`
          : "",
        section("Needs attention - passed to IT, no response", attention.map((i) => row(i, flagOf(i))).join("")),
        section("Open - passed to IT", withIt.map((i) => row(i, flagOf(i))).join("")),
        section("Open - monitoring at site", atSite.map((i) => row(i, flagOf(i))).join("")),
        sharedHtml,
        section("Resolved in the last day", done.map((i) => row(i, null)).join("")),
        `<p style="margin:18px 0 0;font-size:12px;color:${MUTED};">All issues: <a href="${escapeHtml(base)}/admin/it-issues" style="color:#1f6feb;">${escapeHtml(base)}/admin/it-issues</a> (sign-in required).</p>`
      ].join(""),
      { title: subject, preheader: subject }
    );

    const textRow = (i: IssueRow, flag: string | null) =>
      [
        `IT-${i.ref_no} ${i.site_name} - ${deviceLabel(i)}${flag ? ` (${flag})` : ""}`,
        `  ${i.problem}`,
        `  ${cap(i.priority)}, ${STATUS_LABEL[i.status]}, reported ${fmt(i.first_reported_at)}` +
          (i.occurrence_count > 1 ? `, happened ${i.occurrence_count} times` : "") +
          (i.first_escalated_at ? `, sent to IT ${fmt(i.first_escalated_at)}` : "") +
          (i.last_it_action_at ? `, last IT action ${fmt(i.last_it_action_at)}` : "") +
          (refs(i) ? `, ${refs(i)}` : "") +
          (i.pos_provider_opened === false ? ", not raised with the POS provider" : ""),
        links.get(i.id) ? `  ${links.get(i.id)}` : ""
      ]
        .filter(Boolean)
        .join("\n");
    const text = [
      `IT issues - ${dateLabel}`,
      `${open.length} open, ${attention.length} need attention, ${done.length} resolved in the last day.`,
      attention.length ? `\nNEEDS ATTENTION - PASSED TO IT, NO RESPONSE\n${attention.map((i) => textRow(i, flagOf(i))).join("\n\n")}` : "",
      withIt.length ? `\nOPEN - PASSED TO IT\n${withIt.map((i) => textRow(i, flagOf(i))).join("\n\n")}` : "",
      atSite.length ? `\nOPEN - MONITORING AT SITE\n${atSite.map((i) => textRow(i, flagOf(i))).join("\n\n")}` : "",
      shared.length
        ? `\nSAME DEVICE AT MORE THAN ONE SITE\n${shared.map(([d, l]) => `${d}: ${l.map((i) => `${i.site_name} (IT-${i.ref_no})`).join(", ")}`).join("\n")}`
        : "",
      done.length ? `\nRESOLVED IN THE LAST DAY\n${done.map((i) => textRow(i, null)).join("\n\n")}` : "",
      `\nAll issues: ${base}/admin/it-issues`
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await enqueueOutboundEmail(env, {
        source_worker: "workorders-worker",
        source_kind: "it-issues-daily-report",
        // One per Eastern day: a re-run the same day is a no-op.
        source_id: easternDate(now),
        recipient,
        subject,
        body_html: html,
        body_text: text,
        attachments: []
      });
      result.emailsQueued += 1;
    } catch (err) {
      console.error(`[it-issues] daily report enqueue failed for ${recipient}:`, err);
    }
  }
  return result;
}

/* ============================================================
 * Site update -- IT acted from an emailed link
 * ============================================================ */

/**
 * Tell the site what IT just did from an emailed link: a note, a ticket #, a
 * status change or a close. Without this the site only finds out by opening
 * the tracker. Goes to the location's site_email; a site with none on file is
 * logged and skipped (the change itself has already been saved).
 *
 * The site's own actions in the app never send this.
 */
export async function sendSiteUpdateEmail(env: ItIssuesEnv, issue: IssueRow, events: EventRow[]): Promise<void> {
  const loc = await pg<Array<{ site_email: string | null }>>(env, "GET", `locations?id=eq.${issue.location_id}&select=site_email`);
  const recipient = loc.data?.[0]?.site_email?.trim().toLowerCase();
  if (!recipient) {
    console.warn(`[it-issues] IT-${issue.ref_no}: no site_email for location ${issue.location_id}; site update not sent`);
    return;
  }

  const closed = events.some((e) => e.kind === "resolved");
  const who = events[0]?.actor_name ?? "IT";
  const subject = `${closed ? "IT closed" : "IT update on"} IT-${issue.ref_no}: ${deviceLabel(issue)} at ${issue.site_name}`.slice(0, 200);
  const url = `${appsWebBase(env)}/admin/it-issues/${issue.id}`;
  const after = closed
    ? "If the problem comes back, open the issue and use \"It happened again\" - that reopens it so IT can see the fix didn't hold."
    : "No action is needed unless IT asked you for something.";

  const html = wrapInEmailShell(
    [
      `<h2 style="margin:0 0 6px;color:${NAVY};font-size:20px;">${escapeHtml(closed ? "IT closed this issue" : "IT updated this issue")}</h2>`,
      `<p style="margin:0 0 14px;color:${NAVY};font-size:14px;"><strong>IT-${issue.ref_no}</strong> ${escapeHtml(deviceLabel(issue))} - ${escapeHtml(issue.problem)}</p>`,
      `<ul style="margin:0 0 14px;padding-left:18px;font-size:14px;color:${NAVY};">`,
      events.map((e) => `<li style="margin-bottom:4px;">${escapeHtml(eventLine(e)).replace(/\n/g, "<br />")}</li>`).join(""),
      `</ul>`,
      `<p style="margin:0 0 16px;color:${MUTED};font-size:13px;">${escapeHtml(after)}</p>`,
      button(url, "Open the issue")
    ].join(""),
    { title: subject, preheader: `${who}: ${closed ? "closed" : "updated"} IT-${issue.ref_no}` }
  );
  const text = [
    `${closed ? "IT closed" : "IT updated"} IT-${issue.ref_no}: ${deviceLabel(issue)} - ${issue.problem}`,
    "",
    ...events.map((e) => `- ${eventLine(e)}`),
    "",
    after,
    url
  ].join("\n");

  try {
    await enqueueOutboundEmail(env, {
      source_worker: "workorders-worker",
      source_kind: "it-issue-site-update",
      // First event of this action: one email per IT action.
      source_id: `${issue.id}:${events[0]!.id}`,
      recipient,
      subject,
      body_html: html,
      body_text: text,
      attachments: []
    });
  } catch (err) {
    console.error(`[it-issues] site update enqueue failed for IT-${issue.ref_no}:`, err);
  }
}
