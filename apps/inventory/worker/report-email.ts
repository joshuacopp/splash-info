// Visit-report email — subject line + branded HTML body.
//
// Rendering lives here rather than in db.ts so the send path in db.ts stays
// about recipients and the queue, and so this file can be read on its own when
// somebody wants to change what the email says.
//
// The body deliberately mirrors the top of the Visit Detail page (headline
// numbers, then flags, then notes) rather than reproducing the full product
// table. A recipient who wants the per-product breakdown clicks through; an
// area manager skimming on a phone gets the four numbers that matter and an
// immediate answer to "is anything wrong here".
//
// Every URL in the output is built from a base the WORKER supplies (the request
// origin), never from anything in the request body. An email that Power
// Automate sends from a splash address must not be able to carry a link chosen
// by whoever POSTed to /api/report.

import { wrapInEmailShell, escapeHtml, escapeAttr } from "@splash/email-shell";

const NAVY = "#0E2745";
const SPLASH_BLUE = "#1FB6E0";
const AMBER = "#B45309";
const MUTED = "#6B7280";
const RULE = "#E5E7EB";

export interface VisitReportPayload {
  /** site_visits.id — also the dedup key for the outbound_emails queue. */
  visitId?: string;
  /** location_code. Named locationId because the SPA speaks `location_id`. */
  locationId?: string;
  locationName?: string;
  visitDate?: string;
  submitter?: string | null;
  totalWashCount?: number | null;
  chemicalCost?: number | null;
  blendedCpc?: number | null;
  blendedTargetCpc?: number | null;
  onHandValue?: number | null;
  waterHardnessGpg?: number | null;
  tdsPpm?: number | null;
  /** Pre-rendered one-line strings, e.g. "HWS: 14.2 ml/car vs target 11". */
  flags?: string[];
  notes?: string | null;
}

export interface RenderedReport {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

export function renderVisitReport(
  payload: VisitReportPayload,
  visitUrl: string | null
): RenderedReport {
  const name = payload.locationName || payload.locationId || "Unknown location";
  const date = formatDate(payload.visitDate);
  const flags = (payload.flags || []).filter((f) => typeof f === "string" && f.trim());

  // The flag count goes in the subject line because that is the entire reason
  // a manager opens this on a Saturday. "Clean" is stated positively rather
  // than omitted — a subject that only ever mentions problems trains people to
  // read the absence of a suffix as "didn't send".
  const suffix = flags.length ? ` — ${flags.length} flag${flags.length === 1 ? "" : "s"}` : " — clean";
  const subject = `Chemical visit: ${name} · ${date}${suffix}`;

  const bodyHtml = wrapInEmailShell(renderBodyHtml(payload, flags, visitUrl, name, date), {
    title: subject,
    preheader: buildPreheader(payload, flags)
  });

  return { subject, bodyHtml, bodyText: renderBodyText(payload, flags, visitUrl, name, date) };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function renderBodyHtml(
  p: VisitReportPayload,
  flags: string[],
  visitUrl: string | null,
  name: string,
  date: string
): string {
  const out: string[] = [];

  out.push(
    `<p style="margin: 0 0 4px 0; font-size: 20px; font-weight: 700; color: ${NAVY};">${escapeHtml(name)}</p>`,
    `<p style="margin: 0 0 20px 0; font-size: 14px; color: ${MUTED};">${escapeHtml(date)}${
      p.submitter ? ` &nbsp;·&nbsp; ${escapeHtml(p.submitter)}` : ""
    }</p>`
  );

  // Headline numbers, two per row. A table rather than flex because Outlook's
  // Word engine ignores flex entirely and would stack these full-width.
  //
  // Target CPC is conditional, not "—". The form can't compute a blended
  // target that agrees with calc.js's composition model, so it sends nothing;
  // printing a dash beside three real numbers reads as a broken calculation
  // rather than as an absent optional field. Same rule for on-hand value.
  const stats: Array<[string, string]> = [
    ["Cars washed", fmtInt(p.totalWashCount)],
    ["Chemical cost", fmtMoney(p.chemicalCost)],
    ["Blended CPC", fmtCpc(p.blendedCpc)]
  ];
  if (p.blendedTargetCpc != null) stats.push(["Target CPC", fmtCpc(p.blendedTargetCpc)]);
  if (p.onHandValue != null) stats.push(["On-hand value", fmtMoney(p.onHandValue)]);
  out.push(renderStatGrid(stats));

  // Water is omitted entirely when neither reading was taken. Printing "—"
  // twice on every visit at a site that doesn't test would read as a broken
  // email rather than as an optional field. `!= null` rather than truthiness:
  // 0 gpg is a real reading at an RO or softened site.
  if (p.waterHardnessGpg != null || p.tdsPpm != null) {
    out.push(
      renderStatGrid([
        ["Hardness", p.waterHardnessGpg != null ? `${fmtNum(p.waterHardnessGpg)} gpg` : "—"],
        ["TDS", p.tdsPpm != null ? `${fmtNum(p.tdsPpm)} ppm` : "—"]
      ])
    );
  }

  if (flags.length) {
    out.push(
      `<p style="margin: 20px 0 8px 0; font-size: 14px; font-weight: 700; color: ${AMBER};">${flags.length} flag${
        flags.length === 1 ? "" : "s"
      } on this visit</p>`,
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 0 4px 0;"><tbody>`,
      flags
        .map(
          (f) =>
            `<tr><td style="padding: 8px 12px; font-size: 14px; color: #1f2937; background-color: #FFFBEB; border-left: 3px solid #F59E0B;">${escapeHtml(
              f
            )}</td></tr><tr><td style="height: 4px; line-height: 4px; font-size: 0;">&nbsp;</td></tr>`
        )
        .join(""),
      `</tbody></table>`
    );
  }

  if (p.notes && p.notes.trim()) {
    out.push(
      `<p style="margin: 20px 0 6px 0; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${MUTED};">Notes</p>`,
      `<p style="margin: 0; font-size: 14px; line-height: 1.6; color: #1f2937; white-space: pre-wrap;">${escapeHtml(
        p.notes.trim()
      ).replace(/\n/g, "<br>")}</p>`
    );
  }

  if (visitUrl) {
    out.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 26px 0 4px 0;"><tr><td>`,
      `<a href="${escapeAttr(
        visitUrl
      )}" style="display: inline-block; padding: 12px 24px; background-color: ${SPLASH_BLUE}; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 6px; border: 2px solid ${SPLASH_BLUE}; mso-padding-alt: 0;" target="_blank" rel="noopener">View Full Visit</a>`,
      `</td></tr></table>`
    );
  }

  return out.join("\n");
}

/** Label-over-value cells, two per row, hairline-separated. */
function renderStatGrid(stats: Array<[string, string]>): string {
  const cells = stats.map(
    ([label, value]) =>
      `<td width="50%" style="padding: 12px 12px 12px 0; vertical-align: top; border-bottom: 1px solid ${RULE};">` +
      `<span style="display: block; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: ${MUTED};">${escapeHtml(
        label
      )}</span>` +
      `<span style="display: block; margin-top: 2px; font-size: 18px; font-weight: 700; color: ${NAVY};">${escapeHtml(
        value
      )}</span>` +
      `</td>`
  );
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    // Pad the last row so a 3- or 5-stat grid doesn't leave a stretched cell.
    const pair = cells.slice(i, i + 2);
    if (pair.length === 1) pair.push(`<td width="50%" style="border-bottom: 1px solid ${RULE};">&nbsp;</td>`);
    rows.push(`<tr>${pair.join("")}</tr>`);
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 0 4px 0;"><tbody>${rows.join(
    ""
  )}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Plain text
//
// Not a fallback nobody reads: `body_text` is what Power Automate ships when
// body_html is absent, and it is also what shows in the admin email-queue
// preview. Kept genuinely readable rather than stripped-down HTML.
// ---------------------------------------------------------------------------

function renderBodyText(
  p: VisitReportPayload,
  flags: string[],
  visitUrl: string | null,
  name: string,
  date: string
): string {
  const lines = [
    `${name} — ${date}`,
    p.submitter ? `Submitted by ${p.submitter}` : "",
    "",
    `Cars washed:   ${fmtInt(p.totalWashCount)}`,
    `Chemical cost: ${fmtMoney(p.chemicalCost)}`,
    `Blended CPC:   ${fmtCpc(p.blendedCpc)}`,
    p.blendedTargetCpc != null ? `Target CPC:    ${fmtCpc(p.blendedTargetCpc)}` : "",
    p.onHandValue != null ? `On-hand value: ${fmtMoney(p.onHandValue)}` : "",
    p.waterHardnessGpg != null ? `Hardness:      ${fmtNum(p.waterHardnessGpg)} gpg` : "",
    p.tdsPpm != null ? `TDS:           ${fmtNum(p.tdsPpm)} ppm` : ""
  ];

  if (flags.length) {
    lines.push("", `${flags.length} flag${flags.length === 1 ? "" : "s"}:`);
    for (const f of flags) lines.push(`  - ${f}`);
  }
  if (p.notes && p.notes.trim()) lines.push("", "Notes:", p.notes.trim());
  if (visitUrl) lines.push("", `View full visit: ${visitUrl}`);

  return lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n");
}

function buildPreheader(p: VisitReportPayload, flags: string[]): string {
  const cars = fmtInt(p.totalWashCount);
  const cpc = fmtCpc(p.blendedCpc);
  const flagPart = flags.length ? `${flags.length} flag${flags.length === 1 ? "" : "s"}` : "no flags";
  return `${cars} cars · ${cpc} blended CPC · ${flagPart}`;
}

// ---------------------------------------------------------------------------
// Formatting
//
// Locale is pinned to en-US rather than left to the runtime default. Workers
// isolates can and do differ, and a CPC that renders as "0,182" in one and
// "0.182" in another is the kind of thing nobody notices until a manager
// reads it as a hundred and eighty two.
// ---------------------------------------------------------------------------

function formatDate(iso: string | undefined): string {
  if (!iso) return "date unknown";
  // Parsed as UTC on purpose. visit_date is a DATE column with no time or zone;
  // letting the runtime read "2026-08-17" as local midnight would render the
  // previous day for anyone west of UTC.
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function fmtInt(v: unknown): string {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtNum(v: unknown): string {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtMoney(v: unknown): string {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Cost per car — three decimals, because these land around $0.180. */
function fmtCpc(v: unknown): string {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
}
