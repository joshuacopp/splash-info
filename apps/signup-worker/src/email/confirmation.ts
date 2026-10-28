// MaxPass confirmation email — rendered here, delivered by the shared
// `outbound_emails` queue (one Power Automate flow drains it).
//
// Ported from the "Get MaxPass from Supabase" PA flow's Send an email (V2)
// step (2026-10-28). That flow polled every 30 minutes, so customers waited a
// median 15 minutes for this email; it now enqueues at submit time.
//
// Deliberate differences from the PA template, all small:
//   * every interpolated value is HTML-escaped (PA inserted them raw, so a
//     `<` or `&` in terms_text or a package name broke the markup);
//   * prices always show two decimals ("$5.00", not "$5");
//   * line breaks in terms_text are kept as <br> (PA collapsed them);
//   * the hidden pricing / BOGO row is simply not emitted, rather than
//     emitted with display:none — some clients ignore display:none on <tr>;
//   * a plain-text body is included for clients that refuse HTML.
//
// Dates: PA's convertTimeZone 'Eastern Standard Time' is the Windows zone id,
// which is DST-aware, so America/New_York matches it. BOGO dates are derived
// from recurring_start_date exactly as PA did (minus 2 months = today, minus
// 1 month = the free month), which keeps them consistent with the signed
// terms_text that recurring_start_date was taken from.

export interface ConfirmationInput {
  location_pretty: string;
  package_pretty: string;
  phone_formatted: string;
  submitted_at: string;
  today_price: number;
  monthly_price: number;
  terms_text: string;
  is_bogo: boolean;
  /** YYYY-MM-DD, required when is_bogo. */
  recurring_start_date: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const LOGO_URL =
  "https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/Splash_logo_full%20(1)%201.png";
const PHONE = "(888) 697-7527";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : String(n);
}

/** "10/28/2026 02:15 PM" in Eastern time — PA's 'MM/dd/yyyy hh:mm tt'. */
export function easternStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  return `${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute} ${String(parts.dayPeriod).toUpperCase()}`;
}

/** YYYY-MM-DD shifted by whole months, as MM/dd/yyyy. Pure calendar
 *  arithmetic (no time zone involved), clamping the day the way PA's
 *  addToTime does: Mar 31 minus one month is Feb 28/29. */
export function shiftMonths(ymd: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  let y = Number(m[1]);
  let mo = Number(m[2]) - 1 + months;
  y += Math.floor(mo / 12);
  mo = ((mo % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const day = Math.min(Number(m[3]), lastDay);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(mo + 1)}/${pad(day)}/${y}`;
}

const F = "font-family:Arial, Helvetica, sans-serif;";
const LABEL = `${F} font-size:12px; font-weight:bold; color:#64748b; text-transform:uppercase; letter-spacing:0.5px;`;
const VALUE = `${F} font-size:15px; color:#334155; text-align:right;`;

function priceBox(label: string, amount: string): string {
  return `<td class="price-cell" style="padding: 8px 24px 20px 24px; text-align:center;">
  <table cellspacing="0" cellpadding="0" border="0" style="background-color:#ffffff; border-radius:8px; border:2px solid #e2e8f0;"><tbody>
    <tr><td style="padding: 14px 12px 4px 12px; ${F} font-size:11px; font-weight:bold; color:#64748b; text-transform:uppercase; letter-spacing:0.5px; text-align:center;">${label}</td></tr>
    <tr><td style="padding: 2px 12px 4px 12px; ${F} font-size:26px; font-weight:bold; color:#1e3a8a; text-align:center;">$${amount}</td></tr>
    <tr><td style="padding: 0 12px 14px 12px; ${F} font-size:11px; color:#64748b; text-align:center;">plus tax</td></tr>
  </tbody></table>
</td>`;
}

function bogoStep(html: string, last = false): string {
  return `<tr><td style="padding:4px 22px${last ? " 16px 22px" : ""}; ${F} font-size:14px; color:#1c164e; line-height:1.55;">${html}</td></tr>`;
}

export function renderMaxpassConfirmation(r: ConfirmationInput): RenderedEmail {
  const loc = esc(r.location_pretty);
  const pkg = esc(r.package_pretty);
  const stamp = easternStamp(r.submitted_at);
  const today = money(r.today_price);
  const monthly = money(r.monthly_price);
  const bogo = r.is_bogo && !!r.recurring_start_date;
  const rsd = r.recurring_start_date ?? "";
  const terms = esc(r.terms_text ?? "").replace(/\r?\n/g, "<br>");

  const pricingRow = bogo
    ? `<tr><td colspan="2" style="padding: 8px 24px 20px 24px;">
  <table cellspacing="0" cellpadding="0" border="0" style="background:linear-gradient(135deg,#fef3c7 0%,#fde68a 100%); background-color:#fde68a; border-radius:12px; border:2px solid #f1c61e;"><tbody>
    <tr><td style="padding:16px 22px 8px 22px; ${F} font-size:15px; font-weight:bold; color:#1c164e; text-align:center; text-transform:uppercase; letter-spacing:0.05em;">BOGO &mdash; Buy One, Get One Free</td></tr>
    ${bogoStep(`<strong>Today (${shiftMonths(rsd, -2)}):</strong> $${today} plus tax charged today`)}
    ${bogoStep(`<strong>${shiftMonths(rsd, -1)}:</strong> Second month <strong>FREE</strong>`)}
    ${bogoStep(`<strong>${shiftMonths(rsd, 0)}:</strong> Recurring billing begins at $${monthly} plus tax`, true)}
  </tbody></table>
</td></tr>`
    : `<tr>${priceBox("Today's Price", today)}${priceBox("Monthly Price", monthly)}</tr>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MaxPass Confirmation</title>
<style>
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
  body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; background-color: #e0f2fe; }
  @media only screen and (max-width: 600px) {
    .email-container { width: 100% !important; }
    .price-cell { display: block !important; width: 100% !important; padding-bottom: 8px !important; }
  }
</style></head>
<body>
<table cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#e0f2fe;"><tbody><tr><td align="center" style="padding: 30px 10px;">
<table cellspacing="0" cellpadding="0" border="0" class="email-container" width="600" style="max-width:600px; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 20px rgba(0,0,0,0.08);"><tbody>
  <tr><td style="background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); background-color:#1e3a8a; padding: 30px 40px; text-align: center;">
    <table cellspacing="0" cellpadding="0" border="0" align="center"><tbody>
      <tr><td align="center" style="padding-bottom: 12px;"><img src="${LOGO_URL}" alt="Splash Car Wash" width="200" style="display:block; max-width:200px; height:auto;"></td></tr>
      <tr><td align="center" style="${F} font-size:20px; font-weight:bold; color:#ffffff; letter-spacing:0.5px;">MaxPass Confirmation</td></tr>
    </tbody></table>
  </td></tr>
  <tr><td style="padding: 30px 40px 10px 40px; ${F} font-size:16px; color:#334155; line-height:24px;">
    Thank you for joining the Splash Car Wash MaxPass at <strong style="color:#1e3a8a;">${loc}</strong>! Details are below.
  </td></tr>
  <tr><td style="padding: 20px 40px;">
    <table cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f8fafc; border-radius:12px; border:1px solid #e2e8f0;"><tbody>
      <tr><td colspan="2" style="padding: 20px 24px 12px 24px; ${F} font-size:20px; font-weight:bold; color:#1e3a8a; text-align:center; border-bottom:1px solid #e2e8f0;">${pkg}</td></tr>
      <tr><td style="padding: 14px 24px 6px 24px; ${LABEL}">Location</td><td style="padding: 14px 24px 6px 24px; ${VALUE}">${loc}</td></tr>
      <tr><td style="padding: 6px 24px; ${LABEL}">Phone</td><td style="padding: 6px 24px; ${VALUE}">${esc(r.phone_formatted)}</td></tr>
      <tr><td style="padding: 6px 24px; ${LABEL}">Signup Date</td><td style="padding: 6px 24px; ${VALUE}">${stamp}</td></tr>
      <tr><td colspan="2" style="padding: 10px 24px;"><div style="border-top: 1px solid #e2e8f0; height:1px; line-height:1px;">&nbsp;</div></td></tr>
      ${pricingRow}
    </tbody></table>
  </td></tr>
  <tr><td style="padding: 10px 40px;">
    <div style="${F} font-size:14px; font-weight:bold; color:#1e3a8a; padding-bottom:10px;">Terms &amp; Conditions</div>
    <div style="background-color:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px 20px; ${F} font-size:12px; color:#475569; line-height:20px;">${terms}</div>
  </td></tr>
  <tr><td style="padding: 16px 40px;">
    <div style="background-color:#dcfce7; border-radius:8px; border:1px solid #bbf7d0; padding: 12px 20px; ${F} font-size:13px; color:#166534; text-align:center;">&#10003; You agreed to the Terms &amp; Conditions on ${stamp}</div>
  </td></tr>
  <tr><td style="padding: 10px 40px 30px 40px; ${F} font-size:13px; color:#64748b; line-height:20px; text-align:center;">
    Questions about your membership? Call us at <strong style="color:#334155;">${PHONE}</strong> or visit <a href="https://splashcarwashes.com" style="color:#3b82f6; text-decoration:underline;">splashcarwashes.com</a>
  </td></tr>
  <tr><td style="background-color:#f1f5f9; padding: 20px 40px; border-top:1px solid #e2e8f0; ${F} font-size:11px; color:#94a3b8; text-align:center; line-height:18px;">
    Splash Car Wash &mdash; MaxPass Unlimited Program<br>
    This is a confirmation of your membership signup. Please keep this email for your records.<br>
    Cancellations may be made in person, online at splashcarwashes.com, or by phone ${PHONE}.
  </td></tr>
</tbody></table>
</td></tr></tbody></table>
</body></html>`;

  const pricingText = bogo
    ? [
        "BOGO - Buy One, Get One Free",
        `  Today (${shiftMonths(rsd, -2)}): $${today} plus tax charged today`,
        `  ${shiftMonths(rsd, -1)}: Second month FREE`,
        `  ${shiftMonths(rsd, 0)}: Recurring billing begins at $${monthly} plus tax`
      ]
    : [`Today's price: $${today} plus tax`, `Monthly price: $${monthly} plus tax`];

  const text = [
    `Thank you for joining the Splash Car Wash MaxPass at ${r.location_pretty}! Details are below.`,
    "",
    r.package_pretty,
    `Location: ${r.location_pretty}`,
    `Phone: ${r.phone_formatted}`,
    `Signup date: ${stamp}`,
    "",
    ...pricingText,
    "",
    "TERMS & CONDITIONS",
    r.terms_text ?? "",
    "",
    `You agreed to the Terms & Conditions on ${stamp}.`,
    "",
    `Questions about your membership? Call us at ${PHONE} or visit splashcarwashes.com.`,
    "",
    "Splash Car Wash - MaxPass Unlimited Program",
    "This is a confirmation of your membership signup. Please keep this email for your records.",
    `Cancellations may be made in person, online at splashcarwashes.com, or by phone ${PHONE}.`
  ].join("\n");

  return { subject: `MaxPass Confirmation - ${r.location_pretty}`, html, text };
}
