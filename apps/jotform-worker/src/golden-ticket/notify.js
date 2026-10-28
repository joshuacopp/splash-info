// Golden Ticket — email the CRD agent covering the site when a win arrives.
//
// Fired from the JotForm webhook (handlers/webhook.js) after the submission
// is stored, via ctx.waitUntil so JotForm gets its 200 straight away. Sent
// through the shared outbound_emails queue (Brief 127) that the Power
// Automate drain already delivers -- no new flow.
//
// WHO
//   * The site's CRD agent: crd_site_coverage.crd_email for the win's site.
//   * That agent's region supervisor (crd_regions.supervisor_email), unless
//     it is the same address.
//   * No coverage row for the site (a new site, or the Test site): every
//     region supervisor instead, so a win is never silently un-routed.
// ONE email per win: the agent is To, the supervisor CC (on the fallback,
// the first supervisor To and the rest CC). Both drains pass CC through --
// the PA flow since 2026-10-28 (Graph ccRecipients, tested) -- so this halves
// the send count against Exchange's per-minute cap and a reply-all reaches
// everyone. Before that date each person got their own row.
//
// DEDUP: (jotform-worker, golden-ticket-crd-notify, submission_id, recipient)
// is the queue's unique key, and recipient is the To address only. JotForm
// re-delivering the webhook (or the same submission being edited) re-enqueues
// the same To and is a no-op.
//
// Backfill does NOT notify -- it is a bulk catch-up, and emailing CRD about
// every historical win at once would bury the live ones.
//
// FAIL-SOFT: any error is logged and swallowed; the submission is already
// stored and visible in the queue regardless.

import { enqueueOutboundEmail } from "@splash/db-supabase";
import { escapeAttr, escapeHtml, wrapInEmailShell } from "@splash/email-shell";
import { sb } from "./shared.js";

// apps/web production, where CRD work. Not derived from the webhook request:
// JotForm posts to staging.splashcarwashes.info, and a link built from that
// would send agents to staging.
const QUEUE_URL = "https://splashcarwashes.info/admin/golden-ticket";

const SOURCE_WORKER = "jotform-worker";
const SOURCE_KIND = "golden-ticket-crd-notify";

const PRIZE_LABEL = { GT30: "Free month", GT365: "Free year", GTLIFE: "Free for life" };

const NAVY = "#0E2745";
const TEXT = "#374151";
const MUTED = "#6B7280";
const SUDSY = "#1E5FA8";

/**
 * Webhook hook: notify only when this form is tagged golden_ticket. Checked
 * here with its own query rather than by widening loadFormById, which every
 * webhook depends on -- a problem in this check must never stop other forms
 * from being stored.
 */
export async function maybeNotifyGoldenTicket(env, formId, submissionId) {
  try {
    const rows = await sb(env, "jotform_forms", {
      query: { form_id: `eq.${formId}`, access_tag: "eq.golden_ticket", select: "form_id", limit: "1" }
    });
    if (!Array.isArray(rows) || rows.length === 0) return;
  } catch (err) {
    console.error("[golden-ticket.notify] form tag check failed", err);
    return;
  }
  await notifyCrdOfWin(env, submissionId);
}

export async function notifyCrdOfWin(env, submissionId) {
  try {
    const rows = await sb(env, "golden_ticket_wins", {
      query: {
        submission_id: `eq.${submissionId}`,
        select:
          "submission_id,site_number,site_name,submitted_at,customer_name,phone,plate,prize,prize_code,existing_unlimited,ticket_serial,employee_name,barcode,promo_name,dup_count",
        limit: "1"
      }
    });
    const win = Array.isArray(rows) ? rows[0] : null;
    if (!win) {
      console.warn(`[golden-ticket.notify] ${submissionId} not in golden_ticket_wins; skipping`);
      return;
    }

    const recipients = await resolveRecipients(env, win.site_number);
    if (recipients.length === 0) {
      console.error(`[golden-ticket.notify] no CRD agent or supervisor on file; ${submissionId} not emailed`);
      return;
    }

    const { subject, html, text } = render(win);
    const [to, ...cc] = recipients;
    try {
      await enqueueOutboundEmail(env, {
        source_worker: SOURCE_WORKER,
        source_kind: SOURCE_KIND,
        source_id: submissionId,
        recipient: to,
        ...(cc.length ? { cc } : {}),
        subject,
        body_html: html,
        body_text: text
      });
    } catch (err) {
      console.error(`[golden-ticket.notify] enqueue failed for ${submissionId}`, err);
      return;
    }
    console.log(`[golden-ticket.notify] ${submissionId} -> to ${to}${cc.length ? `, cc ${cc.join(", ")}` : ""}`);
  } catch (err) {
    console.error(`[golden-ticket.notify] failed for ${submissionId}`, err);
  }
}

/** Agent + supervisor for the site, else every region supervisor. */
async function resolveRecipients(env, siteNumberRaw) {
  const out = [];
  const add = (e) => {
    const v = typeof e === "string" ? e.trim() : "";
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  };

  const n = Number.parseInt(String(siteNumberRaw ?? "").replace(/\D/g, ""), 10);
  if (Number.isFinite(n)) {
    const cov = await sb(env, "crd_site_coverage", {
      query: {
        site_number: `eq.${n}`,
        select: "crd_email,crd_regions(supervisor_email)",
        limit: "1"
      }
    });
    const row = Array.isArray(cov) ? cov[0] : null;
    if (row) {
      add(row.crd_email);
      const region = Array.isArray(row.crd_regions) ? row.crd_regions[0] : row.crd_regions;
      if (region) add(region.supervisor_email);
      if (out.length) return out;
    }
  }

  console.warn(`[golden-ticket.notify] no CRD coverage for site ${siteNumberRaw}; sending to all region supervisors`);
  const regions = await sb(env, "crd_regions", { query: { select: "supervisor_email" } });
  for (const r of Array.isArray(regions) ? regions : []) add(r.supervisor_email);
  return out;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(d);
}

function render(win) {
  const site = win.site_name ? `${win.site_name} (${win.site_number})` : `Site ${win.site_number ?? "?"}`;
  const prize = win.prize_code ? `${PRIZE_LABEL[win.prize_code] ?? win.prize} (${win.prize_code})` : win.prize || "Unknown prize";
  const existing = String(win.existing_unlimited ?? "").toLowerCase().startsWith("y");
  const dup = win.dup_count > 1;

  const subject = `Golden Ticket win: ${PRIZE_LABEL[win.prize_code] ?? win.prize ?? "prize"} at ${win.site_name ?? `site ${win.site_number}`}${dup ? " (DUPLICATE PLATE)" : ""}`;

  const fields = [
    ["Prize", prize],
    ["Site", site],
    ["Won", fmtWhen(win.submitted_at)],
    ["Customer", win.customer_name],
    ["Phone", win.phone],
    ["Plate", win.plate],
    ["Already has Unlimited?", win.existing_unlimited],
    ["Barcode", win.barcode],
    ["Ticket serial", win.ticket_serial],
    ["Employee", win.employee_name],
    ["Promo", win.promo_name ?? "Outside any promo"]
  ];

  const todo = existing
    ? `This is an <strong>existing member</strong>: update their Micrologic account and tag it <strong>${escapeHtml(win.prize_code ?? "")}</strong>.`
    : `Finish setting up the new member in Micrologic and tag the account <strong>${escapeHtml(win.prize_code ?? "")}</strong>.`;

  const parts = [
    `<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 700; color: ${NAVY}; line-height: 1.3;">New Golden Ticket win</h2>`,
    dup
      ? `<div style="margin: 0 0 16px 0; padding: 12px 14px; border-left: 4px solid #DC2626; background-color: #FEE2E2; border-radius: 4px; font-size: 14px; color: #991B1B; line-height: 1.55;"><strong>This plate already won in this promo.</strong> Compare the photos on the Golden Ticket page before setting anything up.</div>`
      : "",
    `<p style="margin: 0 0 20px 0; font-size: 14px; color: ${TEXT}; line-height: 1.6;">${todo}</p>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse: collapse; margin: 0 0 20px 0; border-top: 1px solid #E5E7EB; border-bottom: 1px solid #E5E7EB;"><tbody>` +
      fields
        .map(
          ([label, value]) =>
            `<tr><td style="padding: 6px 12px 6px 0; vertical-align: top; font-size: 13px; color: ${MUTED}; line-height: 1.55; white-space: nowrap;">${escapeHtml(label)}</td>` +
            `<td style="padding: 6px 0; vertical-align: top; font-size: 14px; color: ${TEXT}; line-height: 1.55;">${escapeHtml(value || "-")}</td></tr>`
        )
        .join("") +
      `</tbody></table>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color: ${SUDSY}; border-radius: 6px;">` +
      `<a href="${escapeAttr(QUEUE_URL)}" style="display: inline-block; padding: 12px 22px; font-size: 15px; font-weight: 700; color: #FFFFFF; text-decoration: none;">Open the Golden Ticket queue</a>` +
      `</td></tr></table>`,
    `<p style="margin: 16px 0 0 0; font-size: 13px; color: ${MUTED}; line-height: 1.55;">The ticket-and-plate photo is on the queue page. Mark the win Done there once the account is set up and tagged.</p>`
  ];

  const html = wrapInEmailShell(parts.filter(Boolean).join("\n"), {
    title: "Golden Ticket win",
    preheader: `${prize} at ${site}`.slice(0, 100)
  });

  const text = [
    "New Golden Ticket win",
    "",
    dup ? "THIS PLATE ALREADY WON IN THIS PROMO. Compare the photos on the Golden Ticket page before setting anything up.\n" : null,
    existing
      ? `Existing member: update their Micrologic account and tag it ${win.prize_code ?? ""}.`
      : `Finish setting up the new member in Micrologic and tag the account ${win.prize_code ?? ""}.`,
    "",
    ...fields.map(([l, v]) => `${l}: ${v || "-"}`),
    "",
    `Golden Ticket queue: ${QUEUE_URL}`
  ]
    .filter((l) => l !== null)
    .join("\n");

  return { subject, html, text };
}
