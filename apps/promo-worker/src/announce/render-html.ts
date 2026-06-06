// Brief 160 — promo announcement HTML + plain-text renderer.
//
// Single source of truth for what an announcement looks like once the
// queue drains and PA delivers. Used by:
//   - `handleSendAnnouncement` (announce.ts) — renders once per send,
//     same HTML for every recipient.
//   - `handlePreviewAnnouncement` (announce.ts) — renders against the
//     same input to return the exact bytes that would have shipped.
//
// HTML body composition (operator-authored body first, then inline
// material images, then optional PTP, then a trailing "Attachments:"
// line). Wrapped in the shared Splash shell from `@splash/email-shell`.
//
// Inline materials reference attachments via CID
// (`<img src="cid:material-{materialId}" />`). The `attachments` array
// on the queue row carries `is_inline: true` + matching `content_id`;
// PA's Send Email V2 connector flips `IsInline` + `ContentId` so the
// recipient renders the image in the body, not as an attachment.
//
// No per-recipient body variation at v1 — same HTML to every recipient.

import { wrapInEmailShell, escapeHtml } from "@splash/email-shell";

export interface RenderAnnouncementInput {
  subject: string;
  /** Operator-authored plain text. Newlines preserved: `\n\n` → paragraph
   *  break (`<p>`), single `\n` → soft break (`<br />`). HTML in the
   *  body text is escaped, not interpreted. */
  bodyText: string;
  /** The owning promo's title — currently unused in the body but
   *  passed through so a future tweak (e.g., the preheader, or a
   *  "Promotion: {title}" label) can use it without a signature
   *  change. */
  promoTitle: string;
  includePtp: boolean;
  ptp: { purpose: string; tools: string; process: string } | null;
  /** Image materials rendered inline in the body via CID. */
  inlineMaterials: Array<{
    materialId: string;
    name: string;
    /** Must match the `content_id` on the corresponding outbound_emails
     *  attachment. Convention: `material-{materialId}`. */
    contentId: string;
  }>;
  /** Non-image materials (or images the operator demoted to attachment-
   *  only). Surfaces as a trailing "Attachments: name1, name2" line so
   *  recipients know there's more in the attachment tray. */
  attachmentMaterials: Array<{ materialId: string; name: string }>;
}

export interface RenderAnnouncementOutput {
  /** Full `<!DOCTYPE html>` document, ready for `outbound_emails.body_html`. */
  html: string;
  /** Plain text matching the queue row's `body_text` for send parity. */
  plainText: string;
}

const NAVY = "#0E2745";
const TEXT = "#374151";
const MUTED = "#6B7280";

export function renderAnnouncement(
  input: RenderAnnouncementInput
): RenderAnnouncementOutput {
  const bodyHtml = buildBodyHtml(input);
  const preheader = derivePreheader(input.bodyText);
  const html = wrapInEmailShell(bodyHtml, {
    title: input.subject,
    preheader
  });
  const plainText = buildPlainText(input);
  return { html, plainText };
}

function buildBodyHtml(input: RenderAnnouncementInput): string {
  const parts: string[] = [];

  parts.push(renderBodyParagraphs(input.bodyText));

  for (const m of input.inlineMaterials) {
    parts.push(
      `<img src="cid:${escapeHtml(m.contentId)}" alt="${escapeHtml(m.name)}" ` +
        `style="max-width: 100%; height: auto; margin: 16px 0; display: block; border: 0;" />`
    );
  }

  if (input.includePtp && input.ptp) {
    const { purpose, tools, process } = input.ptp;
    parts.push(
      `<hr style="border: 0; border-top: 1px solid #E5E7EB; margin: 24px 0;" />`
    );
    parts.push(renderPtpSection("Purpose", purpose));
    parts.push(renderPtpSection("Tools", tools));
    parts.push(renderPtpSection("Process", process));
  }

  if (input.attachmentMaterials.length > 0) {
    const names = input.attachmentMaterials.map((m) => escapeHtml(m.name)).join(", ");
    parts.push(
      `<p style="margin: 24px 0 0 0; font-size: 13px; color: ${MUTED}; line-height: 1.55;">` +
        `Attachments: ${names}` +
        `</p>`
    );
  }

  return parts.filter((s) => s.length > 0).join("\n");
}

function renderBodyParagraphs(bodyText: string): string {
  // Split on blank lines (CRLF-tolerant) into paragraphs; single newlines
  // inside a paragraph become `<br />`. Escape everything as HTML.
  const normalized = bodyText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const paragraphs = normalized.split(/\n\s*\n/);
  const rendered: string[] = [];
  for (const p of paragraphs) {
    const trimmed = p.replace(/\n+$/, "").replace(/^\n+/, "");
    if (trimmed.length === 0) continue;
    const escaped = escapeHtml(trimmed).replace(/\n/g, "<br />");
    rendered.push(
      `<p style="margin: 0 0 16px 0; font-size: 14px; color: ${TEXT}; line-height: 1.6;">${escaped}</p>`
    );
  }
  return rendered.join("\n");
}

function renderPtpSection(label: string, value: string): string {
  const escapedValue =
    escapeHtml((value ?? "").trim() || "(none)").replace(/\n/g, "<br />");
  return (
    `<h3 style="margin: 16px 0 8px 0; font-size: 16px; font-weight: 700; color: ${NAVY}; line-height: 1.3;">${escapeHtml(label)}</h3>` +
    `<p style="margin: 0 0 12px 0; font-size: 14px; color: ${TEXT}; line-height: 1.6;">${escapedValue}</p>`
  );
}

function derivePreheader(bodyText: string): string {
  return bodyText.replace(/\s+/g, " ").trim().slice(0, 100);
}

function buildPlainText(input: RenderAnnouncementInput): string {
  // Mirrors the existing announce.ts plain-text composition: operator's
  // body, then optional PTP divider, then a trailing "Attachments:" line
  // matching the HTML body's attachment summary so the two channels
  // stay in sync.
  let out = input.bodyText;
  if (input.includePtp && input.ptp) {
    const purpose = input.ptp.purpose?.trim() || "(none)";
    const tools = input.ptp.tools?.trim() || "(none)";
    const process = input.ptp.process?.trim() || "(none)";
    out =
      `${out}\n\n---\n\n` +
      `PTP (Purpose, Tools, Process)\n\n` +
      `Purpose: ${purpose}\n` +
      `Tools: ${tools}\n` +
      `Process: ${process}`;
  }
  if (input.attachmentMaterials.length > 0) {
    const names = input.attachmentMaterials.map((m) => m.name).join(", ");
    out = `${out}\n\nAttachments: ${names}`;
  }
  return out;
}
