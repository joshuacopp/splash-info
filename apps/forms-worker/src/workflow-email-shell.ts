// Brief 134 — Outlook-safe HTML email shell.
//
// Wraps an operator-authored body fragment (already rendered via
// `renderTemplateHtml`) in a Splash-branded HTML document with a navy
// header band + white-script logo, a 600px white content area, and a
// light-gray footer that carries the canonical brand line + optional
// "View All Open Approvals" / "View My Requests" secondary CTAs.
//
// Why all the table soup: Outlook's Word-rendering engine doesn't honor
// modern flex/grid CSS and strips `<style>` blocks in some
// configurations. Inline styles + table layout is the documented
// boring-and-correct path. Skipping VML/mso-hide gymnastics at v1 —
// standard inline styles render acceptably in Outlook 365, Gmail, iOS
// Mail, and Apple Mail per the brief.
//
// The logo URL is the existing public R2 asset (`ASSETS.logoWhite`
// from `@splash/storage-r2`) — same source used by the damage check-
// request PDF, so it's already operator-confirmed public.

import { ASSETS } from "@splash/storage-r2";

export interface EmailShellOptions {
  /** Optional `<title>` for the document. Most clients ignore but a
   *  few accessibility tools surface it. Defaults to "Splash". */
  title?: string;
  /** Hidden preheader text (first 100 chars of the body) — surfaces
   *  in inbox previews on most clients. Skip newlines + token
   *  metadata; first sentence of the rendered body is ideal. */
  preheader?: string;
  /** When true, appends "View All Open Approvals" link to the
   *  footer. Used for approver-assignment emails. */
  showApproverFooter?: boolean;
  /** When true, appends "View My Requests" link to the footer.
   *  Used for outcome-notification emails sent to the original
   *  submitter. */
  showSubmitterFooter?: boolean;
}

const LOGO_URL = ASSETS.logoWhite;
const BRAND_LINE = "Splash Car Wash · splashcarwashes.info";
const APPROVALS_URL = "https://splashcarwashes.info/admin/approvals";
const MY_REQUESTS_URL = "https://splashcarwashes.info/admin/my-requests";

const NAVY = "#0E2745";
const FOOTER_BG = "#F4F6F8";
const FOOTER_TEXT = "#6B7280";
const PAGE_BG = "#F4F6F8";

export function wrapInEmailShell(
  bodyHtml: string,
  opts: EmailShellOptions = {}
): string {
  const title = escapeHtml(opts.title ?? "Splash");
  const preheader = escapeHtml((opts.preheader ?? "").replace(/\s+/g, " ").trim());
  const footerLinks = buildFooterLinks(opts);

  return [
    `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">`,
    `<html xmlns="http://www.w3.org/1999/xhtml" lang="en">`,
    `<head>`,
    `<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />`,
    `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`,
    `<title>${title}</title>`,
    `</head>`,
    `<body style="margin: 0; padding: 0; background-color: ${PAGE_BG}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">`,
    preheader
      ? `<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all; visibility: hidden; opacity: 0; color: transparent; height: 0; width: 0;">${preheader}</div>`
      : "",
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: ${PAGE_BG};">`,
    `<tr>`,
    `<td align="center" style="padding: 24px 12px;">`,

    // Outer 600px container
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(14, 39, 69, 0.08);">`,

    // Header band (navy)
    `<tr>`,
    `<td align="center" style="background-color: ${NAVY}; padding: 20px 24px;">`,
    `<img src="${escapeAttr(LOGO_URL)}" alt="Splash Car Wash" width="200" height="60" style="display: block; border: 0; outline: none; max-height: 60px; height: auto; width: auto;" />`,
    `</td>`,
    `</tr>`,

    // Content area
    `<tr>`,
    `<td style="padding: 28px 32px 16px 32px; background-color: #ffffff;">`,
    bodyHtml,
    `</td>`,
    `</tr>`,

    // Footer band
    `<tr>`,
    `<td style="background-color: ${FOOTER_BG}; padding: 20px 32px; border-top: 1px solid #E5E7EB;">`,
    `<p style="margin: 0; font-size: 12px; color: ${FOOTER_TEXT}; line-height: 1.55; text-align: center;">${escapeHtml(BRAND_LINE)}</p>`,
    footerLinks
      ? `<p style="margin: 8px 0 0 0; font-size: 12px; color: ${FOOTER_TEXT}; line-height: 1.55; text-align: center;">${footerLinks}</p>`
      : "",
    `</td>`,
    `</tr>`,

    `</table>`,

    `</td>`,
    `</tr>`,
    `</table>`,
    `</body>`,
    `</html>`
  ].filter((s) => s !== "").join("\n");
}

function buildFooterLinks(opts: EmailShellOptions): string {
  const links: string[] = [];
  if (opts.showApproverFooter) {
    links.push(
      `<a href="${escapeAttr(APPROVALS_URL)}" style="color: ${NAVY}; text-decoration: underline;">View All Open Approvals</a>`
    );
  }
  if (opts.showSubmitterFooter) {
    links.push(
      `<a href="${escapeAttr(MY_REQUESTS_URL)}" style="color: ${NAVY}; text-decoration: underline;">View My Requests</a>`
    );
  }
  return links.join(" &nbsp;·&nbsp; ");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
