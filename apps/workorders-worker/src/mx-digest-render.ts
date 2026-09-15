// Rendering for the per-site daily work-order digest.
//
// Split from mx-daily-digest.ts so the query layer and the presentation layer
// can be read and tested apart: this file is pure, takes no env, and makes no
// network calls, so a test can assert the output without standing up Postgres.
//
// Both an HTML and a plain-text body are produced. The queue's drain flow
// prefers body_html and falls back to body_text, so the text version is not
// decorative -- it is what a plain-text client actually receives.

import { escapeHtml, wrapInEmailShell } from "@splash/email-shell";

export interface DigestComment {
  /** Null when the author is not in the maintainx_users cache. Rendered as
   *  "Unknown" rather than hidden -- the comment text is the point. */
  author: string | null;
  content: string;
  createdAt: string | null;
}

export interface DigestExpense {
  description: string;
  type: string | null;
  quantity: number | null;
  /** CENTS. Formatted only at the point of render -- see the MaintainX money
   *  note in CLAUDE.md; this column was 100x out for months. */
  totalCents: number | null;
}

export interface DigestWorkOrder {
  id: number;
  sequentialId: number | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  comments: DigestComment[];
  commentsTruncated: boolean;
  expenses: DigestExpense[];
}

export interface DigestSite {
  name: string;
  /** e.g. "Monday, September 15" -- already formatted in Eastern time. */
  dayLabel: string;
  workOrders: DigestWorkOrder[];
}

const NAVY = "#0a2a57";
const MUTED = "#5b6b7f";
const RULE = "#e3e8ef";

function formatCents(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(t));
}

/** MaintainX's own UI, so a reader can act on the work order rather than just
 *  read about it. Work orders live at /workorders/{id} -- NOT the asymmetric
 *  /requests/{id} that work requests use (Brief 80). */
function maintainxUrl(workOrderId: number): string {
  return `https://app.getmaintainx.com/workorders/${workOrderId}`;
}

function renderWorkOrderHtml(wo: DigestWorkOrder): string {
  const ref = wo.sequentialId != null ? `#${wo.sequentialId}` : `#${wo.id}`;
  const parts: string[] = [];

  parts.push(
    `<tr><td style="padding:16px 0 0 0;border-top:1px solid ${RULE};">`,
    `<div style="font-size:15px;font-weight:600;color:${NAVY};">`,
    `<a href="${maintainxUrl(wo.id)}" style="color:${NAVY};text-decoration:none;">`,
    `${escapeHtml(wo.title)}</a></div>`,
    `<div style="font-size:12px;color:${MUTED};padding-top:2px;">`,
    `${escapeHtml(ref)} &middot; ${escapeHtml(wo.status)} &middot; ${escapeHtml(wo.priority)} priority`,
    `</div>`
  );

  if (wo.description && wo.description.trim() !== "") {
    parts.push(
      `<div style="font-size:13px;color:#33475b;padding-top:8px;white-space:pre-wrap;">`,
      escapeHtml(wo.description.trim()),
      `</div>`
    );
  }

  if (wo.comments.length > 0) {
    parts.push(
      `<div style="font-size:11px;font-weight:600;text-transform:uppercase;`,
      `letter-spacing:.04em;color:${MUTED};padding-top:12px;">Comments today</div>`
    );
    for (const c of wo.comments) {
      const when = formatTime(c.createdAt);
      parts.push(
        `<div style="padding-top:6px;">`,
        `<div style="font-size:12px;font-weight:600;color:${NAVY};">`,
        escapeHtml(c.author ?? "Unknown"),
        when ? `<span style="font-weight:400;color:${MUTED};"> &middot; ${escapeHtml(when)}</span>` : "",
        `</div>`,
        `<div style="font-size:13px;color:#33475b;white-space:pre-wrap;">`,
        escapeHtml(c.content),
        `</div></div>`
      );
    }
    if (wo.commentsTruncated) {
      parts.push(
        `<div style="font-size:12px;padding-top:6px;">`,
        `<a href="${maintainxUrl(wo.id)}" style="color:#1f6feb;">Older comments in MaintainX &rarr;</a>`,
        `</div>`
      );
    }
  }

  if (wo.expenses.length > 0) {
    parts.push(
      `<div style="font-size:11px;font-weight:600;text-transform:uppercase;`,
      `letter-spacing:.04em;color:${MUTED};padding-top:12px;">New expenses</div>`,
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding-top:4px;">`
    );
    for (const e of wo.expenses) {
      const qty = e.quantity != null ? ` &times;${e.quantity}` : "";
      const type = e.type ? ` <span style="color:${MUTED};">(${escapeHtml(e.type)})</span>` : "";
      parts.push(
        `<tr><td style="font-size:13px;color:#33475b;padding:2px 0;">`,
        `${escapeHtml(e.description)}${type}${qty}</td>`,
        `<td align="right" style="font-size:13px;color:${NAVY};padding:2px 0;white-space:nowrap;">`,
        `${escapeHtml(formatCents(e.totalCents))}</td></tr>`
      );
    }
    parts.push(`</table>`);
  }

  parts.push(`<div style="height:8px;"></div></td></tr>`);
  return parts.join("");
}

function renderWorkOrderText(wo: DigestWorkOrder): string {
  const ref = wo.sequentialId != null ? `#${wo.sequentialId}` : `#${wo.id}`;
  const lines: string[] = [];
  lines.push(`${wo.title} (${ref}) - ${wo.status}, ${wo.priority} priority`);
  if (wo.description && wo.description.trim() !== "") {
    lines.push(`  ${wo.description.trim().replace(/\n/g, "\n  ")}`);
  }
  if (wo.comments.length > 0) {
    lines.push("  Comments today:");
    for (const c of wo.comments) {
      const when = formatTime(c.createdAt);
      lines.push(`    - ${c.author ?? "Unknown"}${when ? ` (${when})` : ""}: ${c.content}`);
    }
    if (wo.commentsTruncated) lines.push("    - (older comments in MaintainX)");
  }
  if (wo.expenses.length > 0) {
    lines.push("  New expenses:");
    for (const e of wo.expenses) {
      const qty = e.quantity != null ? ` x${e.quantity}` : "";
      const amount = formatCents(e.totalCents);
      lines.push(`    - ${e.description}${qty}${amount ? `  ${amount}` : ""}`);
    }
  }
  lines.push(`  ${maintainxUrl(wo.id)}`);
  return lines.join("\n");
}

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

/**
 * One site's digest.
 *
 * The caller only invokes this for sites WITH activity, so there is no
 * empty-state branch by design: a daily "nothing happened" email trains people
 * to ignore the series, which costs more than the reassurance is worth.
 */
export function renderDailyDigestEmail(site: DigestSite, appsWebBase: string): RenderedDigest {
  const n = site.workOrders.length;
  const subject = `${site.name}: ${n} work order${n === 1 ? "" : "s"} worked on ${site.dayLabel}`;

  const totalCents = site.workOrders
    .flatMap((w) => w.expenses)
    .reduce((sum, e) => sum + (e.totalCents ?? 0), 0);

  const body = [
    `<h2 style="margin:0 0 4px 0;font-size:20px;color:${NAVY};">${escapeHtml(site.name)}</h2>`,
    `<div style="font-size:13px;color:${MUTED};padding-bottom:4px;">`,
    `Reactive work orders worked on ${escapeHtml(site.dayLabel)}`,
    `</div>`,
    totalCents > 0
      ? `<div style="font-size:13px;color:${NAVY};padding-bottom:8px;">` +
        `New expenses today: <strong>${escapeHtml(formatCents(totalCents))}</strong></div>`
      : "",
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">`,
    site.workOrders.map(renderWorkOrderHtml).join(""),
    `</table>`,
    `<div style="font-size:12px;color:${MUTED};padding-top:16px;border-top:1px solid ${RULE};">`,
    `Preventative maintenance is not included. `,
    `<a href="${escapeHtml(appsWebBase)}/workorders" style="color:#1f6feb;">Open Work Orders</a>`,
    `</div>`
  ].join("");

  const html = wrapInEmailShell(body, {
    title: subject,
    preheader: `${n} reactive work order${n === 1 ? "" : "s"} at ${site.name}`
  });

  const text = [
    `${site.name} - reactive work orders worked on ${site.dayLabel}`,
    totalCents > 0 ? `New expenses today: ${formatCents(totalCents)}` : "",
    "",
    site.workOrders.map(renderWorkOrderText).join("\n\n"),
    "",
    "Preventative maintenance is not included.",
    `${appsWebBase}/workorders`
  ]
    .filter((line) => line !== "")
    .join("\n");

  return { subject, html, text };
}
