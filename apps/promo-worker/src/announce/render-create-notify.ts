// Brief 162 — promo create-notify HTML + plain-text renderer.
//
// Sibling to `render-html.ts` (the announcement renderer). Renders the
// branded HTML email that lands in every IT-tier user's inbox right
// after a marketing operator submits a promo via /admin/promotions/new.
//
// Wrapped in the shared Splash shell from `@splash/email-shell` so the
// notification matches the visual identity of forms workflow emails
// and promo announcements.

import { wrapInEmailShell, escapeHtml, escapeAttr } from "@splash/email-shell";

export interface RenderCreateNotifyInput {
  promoId: string;
  title: string;
  promoType: string;
  posBehavior: string | null;
  priority: string;
  /** ISO YYYY-MM-DD */
  proposedStartDate: string;
  proposedEndDate: string;
  requestedGoLiveDate: string;
  locationCodes: string[];
  submitterEmail: string;
  /** Already-resolved absolute URL — e.g.
   *  `https://splashcarwashes.info/admin/promotions/{id}/ticket`. */
  ticketUrl: string;
  /** Already-resolved absolute URL — e.g.
   *  `https://splashcarwashes.info/admin/promotions/{id}`. */
  liveViewUrl: string;
}

export interface RenderCreateNotifyOutput {
  /** Full `<!DOCTYPE html>` document, ready for `outbound_emails.body_html`. */
  html: string;
  /** Plain text matching the queue row's `body_text` for client fallback. */
  plainText: string;
}

const NAVY = "#0E2745";
const TEXT = "#374151";
const MUTED = "#6B7280";
const SUDSY = "#1E5FA8";
const DANGER = "#B91C1C";
const WARN = "#B45309";

const LOCATION_PREVIEW_LIMIT = 5;

export function renderCreateNotify(
  input: RenderCreateNotifyInput
): RenderCreateNotifyOutput {
  const bodyHtml = buildBodyHtml(input);
  const preheader = buildPreheader(input);
  const html = wrapInEmailShell(bodyHtml, {
    title: `New promotion submitted: ${input.title}`,
    preheader
  });
  const plainText = buildPlainText(input);
  return { html, plainText };
}

function buildBodyHtml(input: RenderCreateNotifyInput): string {
  const parts: string[] = [];

  parts.push(
    `<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 700; color: ${NAVY}; line-height: 1.3;">New promotion submitted</h2>`
  );

  parts.push(
    `<p style="margin: 0 0 20px 0; font-size: 14px; color: ${TEXT}; line-height: 1.6;">A marketing operator just submitted a new promotion. Below is a summary; open the IT ticket to begin scoping.</p>`
  );

  parts.push(renderMetadataGrid(input));

  parts.push(
    renderCtaButton(input.ticketUrl, "Open IT ticket")
  );

  parts.push(
    `<p style="margin: 16px 0 0 0; font-size: 13px; color: ${MUTED}; line-height: 1.55;">` +
      `Or <a href="${escapeAttr(input.liveViewUrl)}" style="color: ${SUDSY}; text-decoration: underline;">view promo overview</a>.` +
      `</p>`
  );

  parts.push(
    `<p style="margin: 24px 0 0 0; font-size: 14px; color: ${TEXT}; line-height: 1.6;">Pick this up in the IT queue when you're ready to scope.</p>`
  );

  return parts.join("\n");
}

function renderMetadataGrid(input: RenderCreateNotifyInput): string {
  const rows: Array<{ label: string; valueHtml: string }> = [
    { label: "Title", valueHtml: escapeHtml(input.title) },
    { label: "Type", valueHtml: escapeHtml(input.promoType) },
    { label: "Priority", valueHtml: renderPriorityBadge(input.priority) },
    {
      label: "Requested go-live",
      valueHtml: escapeHtml(formatDate(input.requestedGoLiveDate))
    },
    {
      label: "Proposed window",
      valueHtml: escapeHtml(
        `${formatDate(input.proposedStartDate)} → ${formatDate(input.proposedEndDate)}`
      )
    },
    {
      label: "Locations affected",
      valueHtml: renderLocationsCell(input.locationCodes)
    },
    {
      label: "POS behavior",
      valueHtml: input.posBehavior
        ? escapeHtml(input.posBehavior).replace(/\n/g, "<br />")
        : `<span style="color: ${MUTED}; font-style: italic;">(not specified)</span>`
    },
    { label: "Submitted by", valueHtml: escapeHtml(input.submitterEmail) }
  ];

  // Outlook-safe two-column layout via `<table>`. Inline styles only (no
  // <style> blocks) so Outlook's Word engine doesn't strip them.
  const tableRows = rows
    .map(
      (r) =>
        `<tr>` +
        `<td style="padding: 6px 12px 6px 0; vertical-align: top; font-size: 13px; color: ${MUTED}; line-height: 1.55; white-space: nowrap;">${escapeHtml(r.label)}</td>` +
        `<td style="padding: 6px 0; vertical-align: top; font-size: 14px; color: ${TEXT}; line-height: 1.55;">${r.valueHtml}</td>` +
        `</tr>`
    )
    .join("");

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse: collapse; margin: 0 0 24px 0; border-top: 1px solid #E5E7EB; border-bottom: 1px solid #E5E7EB;">` +
    `<tbody>${tableRows}</tbody>` +
    `</table>`
  );
}

function renderPriorityBadge(priority: string): string {
  const lowered = priority.toLowerCase();
  let bg = "#E5E7EB";
  let color = NAVY;
  if (lowered === "high") {
    bg = "#FEE2E2";
    color = DANGER;
  } else if (lowered === "medium") {
    bg = "#FEF3C7";
    color = WARN;
  } else if (lowered === "low") {
    bg = "#E5E7EB";
    color = NAVY;
  }
  return (
    `<span style="display: inline-block; padding: 2px 8px; border-radius: 9999px; background-color: ${bg}; color: ${color}; font-size: 12px; font-weight: 600; line-height: 1.4;">` +
    escapeHtml(priority) +
    `</span>`
  );
}

function renderLocationsCell(locationCodes: string[]): string {
  const count = locationCodes.length;
  if (count === 0) {
    return `<span style="color: ${MUTED}; font-style: italic;">(none)</span>`;
  }
  const preview = locationCodes.slice(0, LOCATION_PREVIEW_LIMIT);
  const remainder = count - preview.length;
  const summary =
    `<strong>${count}</strong> ` +
    escapeHtml(count === 1 ? "location" : "locations");
  const listHtml = preview.map((c) => escapeHtml(c)).join(", ");
  const tail =
    remainder > 0 ? ` <span style="color: ${MUTED};">and ${remainder} more</span>` : "";
  return `${summary}<br /><span style="font-size: 13px;">${listHtml}${tail}</span>`;
}

function renderCtaButton(url: string, label: string): string {
  // Table-wrapped button is the boring-and-correct path for Outlook
  // compatibility — matches the workflow-email-shell convention.
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 8px 0 0 0;">` +
    `<tr>` +
    `<td align="center" bgcolor="${SUDSY}" style="background-color: ${SUDSY}; border-radius: 6px; padding: 0;">` +
    `<a href="${escapeAttr(url)}" style="display: inline-block; padding: 12px 24px; font-size: 14px; font-weight: 600; color: #ffffff; text-decoration: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">${escapeHtml(label)}</a>` +
    `</td>` +
    `</tr>` +
    `</table>`
  );
}

function buildPreheader(input: RenderCreateNotifyInput): string {
  // Inbox-preview text: "{title} — {type}, {priority} priority".
  const parts = [
    input.title,
    `${input.promoType}, ${input.priority} priority`
  ];
  return parts.join(" — ").replace(/\s+/g, " ").trim().slice(0, 100);
}

function buildPlainText(input: RenderCreateNotifyInput): string {
  const lines: string[] = [];
  lines.push("New promotion submitted");
  lines.push("");
  lines.push(`Title: ${input.title}`);
  lines.push(`Type: ${input.promoType}`);
  lines.push(`Priority: ${input.priority}`);
  lines.push(`Requested go-live: ${formatDate(input.requestedGoLiveDate)}`);
  lines.push(
    `Proposed window: ${formatDate(input.proposedStartDate)} -> ${formatDate(input.proposedEndDate)}`
  );

  const count = input.locationCodes.length;
  const noun = count === 1 ? "location" : "locations";
  if (count === 0) {
    lines.push("Locations affected: (none)");
  } else {
    const preview = input.locationCodes.slice(0, LOCATION_PREVIEW_LIMIT).join(", ");
    const remainder = count - Math.min(count, LOCATION_PREVIEW_LIMIT);
    lines.push(
      `Locations affected: ${count} ${noun}` +
        ` (${preview}${remainder > 0 ? ` and ${remainder} more` : ""})`
    );
  }

  lines.push(`POS behavior: ${input.posBehavior ?? "(not specified)"}`);
  lines.push(`Submitted by: ${input.submitterEmail}`);
  lines.push("");
  lines.push(`Open IT ticket: ${input.ticketUrl}`);
  lines.push(`View promo overview: ${input.liveViewUrl}`);
  lines.push("");
  lines.push("Pick this up in the IT queue when you're ready to scope.");
  return lines.join("\n");
}

function formatDate(iso: string): string {
  // Inputs are guaranteed ISO YYYY-MM-DD by the create-promo validator.
  // Parse defensively — if anything else slips through, fall back to the
  // raw string so the email still ships with usable content.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  const month = MONTHS[parsed.getUTCMonth()] ?? "";
  const day = parsed.getUTCDate();
  const year = parsed.getUTCFullYear();
  return `${month} ${day}, ${year}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];
