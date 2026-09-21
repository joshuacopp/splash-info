// Renders the daily "waiting on you" digest.
//
// Splash-branded HTML via the shared @splash/email-shell envelope -- the same
// one workflow email steps and promo announcements use -- plus a plain-text
// mirror, because the queue row carries both and the PA drain prefers
// body_html when present.

import { wrapInEmailShell, escapeHtml } from "@splash/email-shell";

const NAVY = "#0b2545";
const SUDSY = "#1d6fb8";
const MUTED = "#5a6b7d";
const BORDER = "#dfe5ea";

export interface DigestFormLine {
  form_id: string;
  form_title: string;
  count: number;
  oldest_submitted_at: string;
}

export interface RenderedDigest {
  subject: string;
  html: string;
  plainText: string;
}

/** "3 days" / "1 day" / "today" — the age of the oldest item, which is the
 *  number that actually tells someone whether to care. An exact timestamp in a
 *  digest is noise; "waiting 9 days" is not. */
function agePhrase(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

export function renderApprovalDigest(input: {
  byForm: DigestFormLine[];
  totalPending: number;
  dashboardUrl: string;
  now?: Date;
}): RenderedDigest {
  const { byForm, totalPending, dashboardUrl } = input;
  const now = input.now ?? new Date();
  const item = totalPending === 1 ? "item" : "items";

  const subject = `${totalPending} ${item} waiting for your review`;

  const rows = byForm
    .map((f) => {
      const age = agePhrase(f.oldest_submitted_at, now);
      return [
        `<tr>`,
        `<td style="padding: 8px 12px; border-bottom: 1px solid ${BORDER}; color: ${NAVY}; font-size: 14px;">`,
        escapeHtml(f.form_title),
        `</td>`,
        `<td style="padding: 8px 12px; border-bottom: 1px solid ${BORDER}; color: ${NAVY}; font-size: 14px; font-weight: bold; text-align: right; white-space: nowrap;">`,
        String(f.count),
        `</td>`,
        `<td style="padding: 8px 12px; border-bottom: 1px solid ${BORDER}; color: ${MUTED}; font-size: 13px; white-space: nowrap;">`,
        age ? `oldest ${escapeHtml(age)}` : "",
        `</td>`,
        `</tr>`
      ].join("");
    })
    .join("");

  const body = [
    `<h2 style="margin: 0 0 12px; color: ${NAVY}; font-size: 20px;">Waiting for your review</h2>`,
    `<p style="margin: 0 0 16px; color: ${NAVY}; font-size: 14px; line-height: 1.5;">`,
    `You have <strong>${totalPending}</strong> ${item} pending.`,
    `</p>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse: collapse; margin-bottom: 20px;">`,
    rows,
    `</table>`,
    // Table-wrapped button: Outlook ignores padding on a bare <a>.
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`,
    `<td style="background-color: ${SUDSY}; border-radius: 4px;">`,
    `<a href="${escapeHtml(dashboardUrl)}" style="display: inline-block; padding: 11px 22px; color: #ffffff; font-size: 14px; font-weight: bold; text-decoration: none;">Open Pending Approvals</a>`,
    `</td>`,
    `</tr></table>`,
    `<p style="margin: 18px 0 0; color: ${MUTED}; font-size: 12px; line-height: 1.5;">`,
    `This is a once-daily summary. It lists what is waiting on you right now — acting on something removes it from tomorrow's email.`,
    `</p>`
  ].join("");

  const plainText = [
    `Waiting for your review`,
    ``,
    `You have ${totalPending} ${item} pending.`,
    ``,
    ...byForm.map((f) => {
      const age = agePhrase(f.oldest_submitted_at, now);
      return `  - ${f.form_title}: ${f.count}${age ? ` (oldest ${age})` : ""}`;
    }),
    ``,
    `Open Pending Approvals: ${dashboardUrl}`,
    ``,
    `This is a once-daily summary. It lists what is waiting on you right now -`,
    `acting on something removes it from tomorrow's email.`
  ].join("\n");

  return {
    subject,
    html: wrapInEmailShell(body, {
      title: subject,
      preheader: `${totalPending} ${item} pending across ${byForm.length} form${byForm.length === 1 ? "" : "s"}`
    }),
    plainText
  };
}
