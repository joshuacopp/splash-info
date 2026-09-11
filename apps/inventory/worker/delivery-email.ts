// Delivery receipt email.
//
// Deliberately much plainer than renderVisitReport in ./report-email.ts. A
// visit report argues about consumption — bar charts, ml/car deltas against the
// previous visit, an attached comparison sheet. A delivery receipt answers one
// question: what was dropped at this site, and what was it worth. Anything
// beyond that is noise on a document somebody files in an inbox.
//
// Every figure here is recomputed from stored rows by the caller, exactly as
// the visit report is, so the email and the on-screen record cannot disagree.

/** The subset of computeVisit()'s output a receipt needs. Hand-written contract
 *  between this module and the untyped calc.js, asserted at the call site. */
export interface DeliveryEntryLike {
  productId: string;
  name: string;
  qtyDeliveredGal: number;
  endingQtyGal: number;
  pricePerMl: number;
  discount: number;
  deliveredValue: number;
  onHandValue: number;
}

export interface ComputedDeliveryLike {
  visit: {
    id: string;
    location_id: string;
    visit_date: string;
    submitter?: string | null;
    notes?: string | null;
  };
  location: { name?: string | null } | null;
  entries: DeliveryEntryLike[];
  onHandValue: number;
}

export interface RenderedReceipt {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

const NAVY = "#0e3565";
const SLATE = "#64748b";
const BORDER = "#e2e8f0";

export function renderDeliveryReceipt(
  c: ComputedDeliveryLike,
  deliveryUrl: string | null
): RenderedReceipt {
  const site = c.location?.name || c.visit.location_id;
  const date = formatDate(c.visit.visit_date);

  // Only chemicals actually delivered. save_delivery already drops zero-qty
  // rows, but a receipt listing a product with 0 gallons would be confusing if
  // one ever slipped through.
  const lines = c.entries.filter((e) => e.qtyDeliveredGal > 0);
  const deliveredValue = lines.reduce((s, e) => s + e.deliveredValue, 0);

  const subject = `Delivery receipt - ${site} - ${date}`;

  return {
    subject,
    bodyHtml: renderHtml(c, lines, deliveredValue, site, date, deliveryUrl),
    bodyText: renderText(c, lines, deliveredValue, site, date, deliveryUrl)
  };
}

function renderHtml(
  c: ComputedDeliveryLike,
  lines: DeliveryEntryLike[],
  deliveredValue: number,
  site: string,
  date: string,
  url: string | null
): string {
  const rows = lines
    .map(
      (e) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};font-size:14px;color:#0f172a;">${esc(
          e.name
        )}</td>
        <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};font-size:14px;color:#0f172a;text-align:right;font-variant-numeric:tabular-nums;">${fmtNum(
          e.qtyDeliveredGal
        )}</td>
        <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};font-size:14px;color:#0f172a;text-align:right;font-variant-numeric:tabular-nums;">${fmtMoney(
          e.deliveredValue
        )}</td>
        <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};font-size:14px;color:${SLATE};text-align:right;font-variant-numeric:tabular-nums;">${fmtNum(
          e.endingQtyGal
        )}</td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid ${BORDER};">
    <div style="background:${NAVY};padding:22px 24px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#93c5fd;">Splash Chemical Inventory</div>
      <div style="font-size:22px;font-weight:800;color:#ffffff;margin-top:4px;">Delivery receipt</div>
    </div>

    <div style="padding:20px 24px 8px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="font-size:13px;color:${SLATE};padding:2px 0;">Site</td>
          <td style="font-size:13px;color:#0f172a;font-weight:700;text-align:right;">${esc(site)}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:${SLATE};padding:2px 0;">Delivery date</td>
          <td style="font-size:13px;color:#0f172a;font-weight:700;text-align:right;">${esc(date)}</td>
        </tr>
        ${
          c.visit.submitter
            ? `<tr><td style="font-size:13px;color:${SLATE};padding:2px 0;">Recorded by</td>
               <td style="font-size:13px;color:#0f172a;font-weight:700;text-align:right;">${esc(
                 c.visit.submitter
               )}</td></tr>`
            : ""
        }
      </table>
    </div>

    <div style="padding:14px 24px 0;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 12px;background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:${SLATE};border-bottom:1px solid ${BORDER};">Chemical</th>
            <th style="text-align:right;padding:8px 12px;background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:${SLATE};border-bottom:1px solid ${BORDER};">Delivered (gal)</th>
            <th style="text-align:right;padding:8px 12px;background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:${SLATE};border-bottom:1px solid ${BORDER};">Value</th>
            <th style="text-align:right;padding:8px 12px;background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:${SLATE};border-bottom:1px solid ${BORDER};">On hand after</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div style="padding:16px 24px 4px;">
      <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;">
        <tr>
          <td style="padding:12px 14px;font-size:13px;font-weight:700;color:#0f172a;">Total delivered value</td>
          <td style="padding:12px 14px;font-size:18px;font-weight:800;color:${NAVY};text-align:right;">${fmtMoney(
            deliveredValue
          )}</td>
        </tr>
        <tr>
          <td style="padding:0 14px 12px;font-size:12px;color:${SLATE};">Site inventory value after delivery</td>
          <td style="padding:0 14px 12px;font-size:13px;font-weight:700;color:#0f172a;text-align:right;">${fmtMoney(
            c.onHandValue
          )}</td>
        </tr>
      </table>
    </div>

    ${
      c.visit.notes
        ? `<div style="padding:8px 24px 0;">
             <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${SLATE};">Notes</div>
             <div style="font-size:13px;color:#0f172a;margin-top:4px;white-space:pre-wrap;">${esc(
               c.visit.notes
             )}</div>
           </div>`
        : ""
    }

    <div style="padding:18px 24px 24px;">
      ${
        url
          ? `<a href="${esc(
              url
            )}" style="display:inline-block;background:${NAVY};color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 18px;border-radius:10px;">View the record</a>`
          : ""
      }
      <p style="font-size:11px;color:${SLATE};margin:16px 0 0;">
        This is a delivery record only. No car counts or chemical levels were measured;
        quantities shown as "on hand after" are the previous recorded level plus what was delivered.
      </p>
    </div>
  </div>
</body></html>`;
}

function renderText(
  c: ComputedDeliveryLike,
  lines: DeliveryEntryLike[],
  deliveredValue: number,
  site: string,
  date: string,
  url: string | null
): string {
  const out: string[] = [
    "SPLASH CHEMICAL INVENTORY - DELIVERY RECEIPT",
    "",
    `Site:          ${site}`,
    `Delivery date: ${date}`
  ];
  if (c.visit.submitter) out.push(`Recorded by:   ${c.visit.submitter}`);
  out.push("", "DELIVERED", "");

  for (const e of lines) {
    out.push(
      `  ${e.name}: ${fmtNum(e.qtyDeliveredGal)} gal  ${fmtMoney(
        e.deliveredValue
      )}  (on hand after: ${fmtNum(e.endingQtyGal)} gal)`
    );
  }

  out.push(
    "",
    `Total delivered value:               ${fmtMoney(deliveredValue)}`,
    `Site inventory value after delivery: ${fmtMoney(c.onHandValue)}`
  );

  if (c.visit.notes) out.push("", "NOTES", "", c.visit.notes);
  if (url) out.push("", `View the record: ${url}`);
  out.push(
    "",
    "This is a delivery record only. No car counts or chemical levels were",
    "measured; \"on hand after\" is the previous recorded level plus what was",
    "delivered."
  );
  return out.join("\n");
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "-";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return String(iso);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[m - 1]} ${d}, ${y}`;
}

function fmtNum(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fmtMoney(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "-";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
