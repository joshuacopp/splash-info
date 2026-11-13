// Supply Orders emails -- all through the shared outbound_emails queue.
//
//   * VENDOR (supply-orders.ts approveAndSend): the order to Kleen-Rite, in the
//     layout GMs already used by hand (account, PO, one line per item, shipping
//     method, ship-to). Deliberately plain -- it is read by a sales desk and
//     keyed into their system, not admired. No prices: ours are Kleen-Rite's
//     public prices and would only invite a mismatch with our account pricing.
//   * APPROVAL REQUEST to the site's RM, with a sign-in link to the order.
//   * DECISION back to the orderer (approved and sent / denied with reason).

import { enqueueOutboundEmail } from "@splash/db-supabase";
import { escapeHtml, wrapInEmailShell } from "@splash/email-shell";
import type { LineRow, OrderRow, SiteRow, SupplyOrdersEnv, VendorRow } from "./supply-orders.js";

const NAVY = "#1c164e";
const MUTED = "#5b6b7f";
const RULE = "#e3e8ef";

function base(env: SupplyOrdersEnv): string {
  return (env.APPS_WEB_BASE_URL || "https://splashcarwashes.info").replace(/\/+$/, "");
}

export function orderUrl(env: SupplyOrdersEnv, id: string): string {
  return `${base(env)}/admin/supply-orders/${id}`;
}

export function money(cents: number | null): string {
  if (cents == null) return "";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "GUSS50 - Spraying System ... Spray Gun - Qty 5" */
export function vendorLine(l: Pick<LineRow, "sku" | "name" | "qty" | "uom">): string {
  const uom = l.uom && l.uom.toLowerCase() !== "each" ? ` (${l.uom})` : "";
  return `${l.sku} - ${l.name}${uom} - Qty ${l.qty}`;
}

export function buildVendorEmail(input: {
  order: Pick<OrderRow, "po_number" | "account_no" | "shipping_method" | "ship_to" | "site_name">;
  lines: Array<Pick<LineRow, "sku" | "name" | "qty" | "uom">>;
  vendor: Pick<VendorRow, "ship_to_company">;
  test: boolean;
}): { subject: string; text: string; html: string } {
  const { order, lines, test } = input;
  const subject = `${test ? "[TEST - do not fill] " : ""}Order - PO ${order.po_number} - Splash ${order.site_name}`;
  const shipLines = order.ship_to.split("\n").filter(Boolean);
  const text = [
    test ? "*** TEST ORDER - this was not sent to Kleen-Rite ***\n" : "",
    `Account - ${order.account_no}`,
    "",
    `PO - ${order.po_number}`,
    "",
    ...lines.map(vendorLine),
    "",
    order.shipping_method,
    ...shipLines
  ]
    .join("\n")
    .trimStart();
  const p = (s: string) => `<p style="margin:0 0 14px;">${s}</p>`;
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#111;">`,
    test
      ? p(`<strong style="color:#b42318;">TEST ORDER - this was not sent to Kleen-Rite.</strong>`)
      : "",
    p(`Account - ${escapeHtml(order.account_no)}`),
    p(`PO - ${escapeHtml(order.po_number)}`),
    p(lines.map((l) => escapeHtml(vendorLine(l))).join("<br>")),
    p([order.shipping_method, ...shipLines].map(escapeHtml).join("<br>")),
    `</div>`
  ].join("");
  return { subject, text, html };
}

function linesTableHtml(lines: LineRow[]): string {
  const rows = lines
    .map(
      (l) =>
        `<tr>` +
        `<td style="padding:6px 8px;border-bottom:1px solid ${RULE};font-family:monospace;white-space:nowrap;">${escapeHtml(l.sku)}</td>` +
        `<td style="padding:6px 8px;border-bottom:1px solid ${RULE};">${escapeHtml(l.name)}</td>` +
        `<td style="padding:6px 8px;border-bottom:1px solid ${RULE};text-align:right;">${l.qty}</td>` +
        `<td style="padding:6px 8px;border-bottom:1px solid ${RULE};text-align:right;white-space:nowrap;">${escapeHtml(
          l.unit_price_cents != null ? money(l.unit_price_cents * l.qty) : "-"
        )}</td>` +
        `</tr>`
    )
    .join("");
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px;color:${NAVY};margin:0 0 12px;">` +
    `<tr><th align="left" style="padding:6px 8px;border-bottom:2px solid ${RULE};">Item #</th>` +
    `<th align="left" style="padding:6px 8px;border-bottom:2px solid ${RULE};">Description</th>` +
    `<th align="right" style="padding:6px 8px;border-bottom:2px solid ${RULE};">Qty</th>` +
    `<th align="right" style="padding:6px 8px;border-bottom:2px solid ${RULE};">Est.</th></tr>` +
    rows +
    `</table>`
  );
}

function estimateOf(lines: LineRow[]): number | null {
  const priced = lines.filter((l) => l.unit_price_cents != null);
  return priced.length ? priced.reduce((n, l) => n + l.qty * (l.unit_price_cents ?? 0), 0) : null;
}

function button(url: string, label: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;"><tr>` +
    `<td style="background:#2b3491;border-radius:6px;"><a href="${escapeHtml(url)}" ` +
    `style="display:inline-block;padding:10px 18px;color:#ffffff;font-weight:bold;text-decoration:none;font-size:14px;">${escapeHtml(label)}</a></td>` +
    `</tr></table>`
  );
}

export async function sendApprovalRequestEmail(
  env: SupplyOrdersEnv,
  order: OrderRow,
  lines: LineRow[],
  _site: SiteRow
): Promise<void> {
  if (!order.approver_email) return;
  const url = orderUrl(env, order.id);
  const est = estimateOf(lines);
  const subject = `Approve Kleen-Rite order: ${order.site_name} - PO ${order.po_number}`;
  const html = wrapInEmailShell(
    [
      `<h2 style="margin:0 0 8px;color:${NAVY};font-size:18px;">Kleen-Rite order waiting on you</h2>`,
      `<p style="margin:0 0 12px;color:${NAVY};font-size:14px;">${escapeHtml(order.ordered_by_email)} placed an order for ` +
        `<strong>${escapeHtml(order.site_name)}</strong> (PO ${escapeHtml(order.po_number)}). ` +
        `Approving sends it to Kleen-Rite. You can change quantities or remove items first.</p>`,
      order.note
        ? `<p style="margin:0 0 12px;padding:10px 12px;background:#fff7e6;border-radius:8px;color:${NAVY};font-size:13px;"><strong>Note:</strong> ${escapeHtml(order.note)}</p>`
        : "",
      linesTableHtml(lines),
      est != null
        ? `<p style="margin:0 0 12px;color:${MUTED};font-size:12px;">Estimated ${escapeHtml(money(est))} at Kleen-Rite's public prices. Your account pricing may differ.</p>`
        : "",
      button(url, "Review and approve"),
      `<p style="margin:10px 0 0;color:${MUTED};font-size:12px;">Ships to: ${escapeHtml(order.ship_to.replace(/\n/g, ", "))}</p>`
    ].join(""),
    { title: subject, preheader: `${order.site_name}: ${lines.length} item(s) to approve`.slice(0, 100) }
  );
  const text = [
    `${order.ordered_by_email} placed a Kleen-Rite order for ${order.site_name} (PO ${order.po_number}).`,
    order.note ? `Note: ${order.note}` : "",
    "",
    ...lines.map((l) => `${l.sku} - ${l.name} - Qty ${l.qty}`),
    est != null ? `\nEstimated ${money(est)} at public prices.` : "",
    "",
    `Review and approve: ${url}`
  ].join("\n");
  await enqueueOutboundEmail(env, {
    source_worker: "workorders-worker",
    source_kind: "supply-order-approval",
    source_id: order.id,
    recipient: order.approver_email,
    reply_to: order.ordered_by_email,
    subject,
    body_html: html,
    body_text: text,
    attachments: []
  });
}

export async function sendDecisionEmail(
  env: SupplyOrdersEnv,
  order: OrderRow,
  lines: LineRow[],
  decision: "approved" | "denied"
): Promise<void> {
  const url = orderUrl(env, order.id);
  const approved = decision === "approved";
  const subject = approved
    ? `Kleen-Rite order sent: ${order.site_name} - PO ${order.po_number}`
    : `Kleen-Rite order denied: ${order.site_name} - PO ${order.po_number}`;
  const lead = approved
    ? `${escapeHtml(order.decided_by_email ?? "Your RM")} approved PO ${escapeHtml(order.po_number)} and it has been sent to Kleen-Rite.`
    : `${escapeHtml(order.decided_by_email ?? "Your RM")} denied PO ${escapeHtml(order.po_number)}.`;
  const html = wrapInEmailShell(
    [
      `<h2 style="margin:0 0 8px;color:${NAVY};font-size:18px;">${approved ? "Order sent to Kleen-Rite" : "Order denied"}</h2>`,
      `<p style="margin:0 0 12px;color:${NAVY};font-size:14px;">${lead}</p>`,
      order.decision_note
        ? `<p style="margin:0 0 12px;padding:10px 12px;background:#fff7e6;border-radius:8px;color:${NAVY};font-size:13px;"><strong>${
            approved ? "Note" : "Reason"
          }:</strong> ${escapeHtml(order.decision_note)}</p>`
        : "",
      linesTableHtml(lines),
      button(url, "Open the order")
    ].join(""),
    { title: subject, preheader: subject.slice(0, 100) }
  );
  const text = [
    approved
      ? `${order.decided_by_email ?? "Your RM"} approved PO ${order.po_number} and it has been sent to Kleen-Rite.`
      : `${order.decided_by_email ?? "Your RM"} denied PO ${order.po_number}.`,
    order.decision_note ? `${approved ? "Note" : "Reason"}: ${order.decision_note}` : "",
    "",
    ...lines.map((l) => `${l.sku} - ${l.name} - Qty ${l.qty}`),
    "",
    `Open the order: ${url}`
  ].join("\n");
  await enqueueOutboundEmail(env, {
    source_worker: "workorders-worker",
    source_kind: "supply-order-decision",
    source_id: `${order.id}:${decision}`,
    recipient: order.ordered_by_email,
    ...(order.decided_by_email ? { reply_to: order.decided_by_email } : {}),
    subject,
    body_html: html,
    body_text: text,
    attachments: []
  });
}
