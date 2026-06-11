// Brief 167 — per-site "special ended" notification renderer.
//
// Symmetric twin of `render-site-notify.ts` (Brief 164, build-phase).
// Fires one branded HTML email per recipient per site when IT clicks
// the "Notify removed sites" FAB on the IT ticket page after marking
// each site torn down via the removal checklist.
//
// Wrapped in the shared Splash shell from `@splash/email-shell` so the
// notification matches the visual identity of forms workflow emails,
// promo announcements, and the build-notify email.
//
// Hard-coded body (no template registry — that's Brief 163's domain,
// scoped to marketing announcements). Optional operator-supplied note
// prepends as a styled callout block.

import { wrapInEmailShell, escapeHtml, escapeAttr } from "@splash/email-shell";

export interface RenderRemovalNotifyInput {
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

export interface RenderRemovalNotifyOutput {
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

export function renderRemovalNotify(
  input: RenderRemovalNotifyInput
): RenderRemovalNotifyOutput {
  const bodyHtml = buildBodyHtml(input);
  const preheader = buildPreheader(input);
  const html = wrapInEmailShell(bodyHtml, {
    title: `Special ended: ${input.promoTitle}`,
    preheader
  });
  const plainText = buildPlainText(input);
  return { html, plainText };
}

function buildBodyHtml(input: RenderRemovalNotifyInput): string {
  const parts: string[] = [];

  parts.push(
    `<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 700; color: ${NAVY}; line-height: 1.3;">Special ended</h2>`
  );

  parts.push(
    `<p style="margin: 0 0 20px 0; font-size: 14px; color: ${TEXT}; line-height: 1.6;">` +
      `The <strong>${escapeHtml(input.promoTitle)}</strong> special has been removed at <strong>${escapeHtml(input.locationPretty)}</strong>. ` +
      `The promotional pricing is no longer active at your site.` +
      `</p>`
  );

  // Optional operator note as a styled callout.
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
    `<p style="margin: 24px 0 0 0; font-size: 14px; color: ${TEXT}; line-height: 1.6;">Reach out to your manager if anything still looks active at your site.</p>`
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

function renderMetadataGrid(input: RenderRemovalNotifyInput): string {
  const rows: Array<{ label: string; valueHtml: string }> = [
    { label: "Promo type", valueHtml: escapeHtml(input.promoType) },
    {
      label: "Location code",
      valueHtml: `<span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;">${escapeHtml(input.locationCode)}</span>`
    },
    { label: "Removed by", valueHtml: escapeHtml(input.notifiedByEmail) }
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

function buildPreheader(input: RenderRemovalNotifyInput): string {
  const parts = [input.promoType, "removed at", input.locationPretty];
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 100);
}

function buildPlainText(input: RenderRemovalNotifyInput): string {
  const lines: string[] = [];
  lines.push("Special ended");
  lines.push("");
  lines.push(
    `The ${input.promoTitle} special has been removed at ${input.locationPretty}. The promotional pricing is no longer active at your site.`
  );
  lines.push("");
  if (input.note && input.note.trim().length > 0) {
    lines.push("Note from IT:");
    lines.push(input.note);
    lines.push("");
  }
  lines.push(`Promo type: ${input.promoType}`);
  lines.push(`Location code: ${input.locationCode}`);
  lines.push(`Removed by: ${input.notifiedByEmail}`);
  lines.push("");
  lines.push(`View promo details: ${input.liveViewUrl}`);
  lines.push("");
  lines.push(
    "Reach out to your manager if anything still looks active at your site."
  );
  return lines.join("\n");
}
