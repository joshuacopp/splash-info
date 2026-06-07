// Brief 164 — per-site "IT changes are live" notification renderer.
//
// Sibling to `render-create-notify.ts` (Brief 162) and `render-html.ts`
// (Brief 160). Fires one branded HTML email per recipient per site when
// IT clicks the "Notify completed sites" FAB on the IT ticket page.
//
// Wrapped in the shared Splash shell from `@splash/email-shell` so the
// notification matches the visual identity of forms workflow emails,
// promo announcements, and the create-notify email.
//
// Hard-coded body (no template registry — that's Brief 163's domain,
// scoped to marketing announcements). Optional operator-supplied note
// prepends as a styled callout block.

import { wrapInEmailShell, escapeHtml, escapeAttr } from "@splash/email-shell";

export interface RenderSiteNotifyInput {
  promoTitle: string;
  promoType: string;
  locationCode: string;
  /** Human-readable from pricing_simple; falls back to the code itself
   *  when the caller couldn't resolve it. */
  locationPretty: string;
  /** For the closing signature line. */
  notifiedByEmail: string;
  /** Operator-supplied optional note (trimmed). Renders a styled callout
   *  block when non-null + non-empty. */
  note: string | null;
  /** Already-resolved absolute URL — e.g.
   *  `https://splashcarwashes.info/admin/promotions/{id}`. */
  liveViewUrl: string;
}

export interface RenderSiteNotifyOutput {
  /** Full `<!DOCTYPE html>` document, ready for `outbound_emails.body_html`. */
  html: string;
  /** Plain text matching the queue row's `body_text` for client fallback. */
  plainText: string;
}

const NAVY = "#0E2745";
const TEXT = "#374151";
const MUTED = "#6B7280";
const SUDSY = "#1E5FA8";
const CALLOUT_BG = "#FEF3C7";
const CALLOUT_BORDER = "#F59E0B";

export function renderSiteNotify(
  input: RenderSiteNotifyInput
): RenderSiteNotifyOutput {
  const bodyHtml = buildBodyHtml(input);
  const preheader = buildPreheader(input);
  const html = wrapInEmailShell(bodyHtml, {
    title: `IT changes are live: ${input.promoTitle}`,
    preheader
  });
  const plainText = buildPlainText(input);
  return { html, plainText };
}

function buildBodyHtml(input: RenderSiteNotifyInput): string {
  const parts: string[] = [];

  parts.push(
    `<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 700; color: ${NAVY}; line-height: 1.3;">IT changes are live</h2>`
  );

  parts.push(
    `<p style="margin: 0 0 20px 0; font-size: 14px; color: ${TEXT}; line-height: 1.6;">` +
      `The IT setup for <strong>${escapeHtml(input.promoTitle)}</strong> is now live at <strong>${escapeHtml(input.locationPretty)}</strong>. ` +
      `The special is now active at your site.` +
      `</p>`
  );

  // Optional operator note as a styled callout. Note text already trimmed
  // + null-collapsed at the caller; we just render verbatim.
  if (input.note && input.note.trim().length > 0) {
    parts.push(renderNoteCallout(input.note));
  }

  parts.push(renderMetadataGrid(input));

  parts.push(
    `<p style="margin: 16px 0 0 0; font-size: 13px; color: ${MUTED}; line-height: 1.55;">` +
      `<a href="${escapeAttr(input.liveViewUrl)}" style="color: ${SUDSY}; text-decoration: underline;">View promo details</a>` +
      `</p>`
  );

  parts.push(
    `<p style="margin: 24px 0 0 0; font-size: 14px; color: ${TEXT}; line-height: 1.6;">Reach out to your manager if anything looks off at your site.</p>`
  );

  return parts.join("\n");
}

function renderNoteCallout(note: string): string {
  // Preserve operator-typed line breaks via `<br />` after escaping. Note
  // is operator-controlled but capped to 500 chars at the handler.
  const escaped = escapeHtml(note).replace(/\n/g, "<br />");
  return (
    `<div style="margin: 0 0 20px 0; padding: 12px 14px; border-left: 4px solid ${CALLOUT_BORDER}; background-color: ${CALLOUT_BG}; border-radius: 4px;">` +
      `<p style="margin: 0 0 4px 0; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: ${NAVY};">Note from IT</p>` +
      `<p style="margin: 0; font-size: 14px; color: ${TEXT}; line-height: 1.55;">${escaped}</p>` +
    `</div>`
  );
}

function renderMetadataGrid(input: RenderSiteNotifyInput): string {
  const rows: Array<{ label: string; valueHtml: string }> = [
    { label: "Promo type", valueHtml: escapeHtml(input.promoType) },
    {
      label: "Location code",
      valueHtml: `<span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;">${escapeHtml(input.locationCode)}</span>`
    },
    { label: "Notified by", valueHtml: escapeHtml(input.notifiedByEmail) }
  ];

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
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse: collapse; margin: 0 0 8px 0; border-top: 1px solid #E5E7EB; border-bottom: 1px solid #E5E7EB;">` +
    `<tbody>${tableRows}</tbody>` +
    `</table>`
  );
}

function buildPreheader(input: RenderSiteNotifyInput): string {
  const parts = [input.promoType, input.locationPretty];
  return parts.join(" at ").replace(/\s+/g, " ").trim().slice(0, 100);
}

function buildPlainText(input: RenderSiteNotifyInput): string {
  const lines: string[] = [];
  lines.push("IT changes are live");
  lines.push("");
  lines.push(
    `The IT setup for ${input.promoTitle} is now live at ${input.locationPretty}. The special is now active at your site.`
  );
  lines.push("");
  if (input.note && input.note.trim().length > 0) {
    lines.push("Note from IT:");
    lines.push(input.note);
    lines.push("");
  }
  lines.push(`Promo type: ${input.promoType}`);
  lines.push(`Location code: ${input.locationCode}`);
  lines.push(`Notified by: ${input.notifiedByEmail}`);
  lines.push("");
  lines.push(`View promo details: ${input.liveViewUrl}`);
  lines.push("");
  lines.push("Reach out to your manager if anything looks off at your site.");
  return lines.join("\n");
}
