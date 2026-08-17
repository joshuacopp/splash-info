// Visit-report email — subject line, branded HTML body, and the standalone
// goal-vs-actual comparison document that rides along as an attachment.
//
// Rendering lives here rather than in db.ts so the send path in db.ts stays
// about recipients and the queue, and so this file can be read on its own when
// somebody wants to change what the email says.
//
// EVERY number this file prints comes from the computed visit that db.ts built
// by running the SPA's own calc.js against a fresh read of the database. This
// file does no arithmetic beyond percentages and bar widths, and it accepts
// nothing from the request body. That is the whole reason the email cannot
// drift from the Visit Detail page, and the reason a caller cannot dictate
// what a mail sent from a splash address claims about a site's costs.
//
// The body shows headline numbers, a per-product goal-vs-actual bar block, and
// the flags. The attachment carries the full per-product table for this visit
// AND the previous one — the thing an area manager actually forwards or prints.
//
// Visuals are table-cell bars, not images and not SVG. Workers cannot run
// headless Chrome, so there is no chart library available here; and Outlook
// renders HTML through Word, which drops SVG and inline background-image
// entirely. A `<td>` with a bgcolor and a percentage width is the one bar
// primitive that survives Outlook, Gmail, Apple Mail and mobile alike.
//
// Every URL in the output is built from a base the WORKER supplies (the request
// origin), never from anything in the request body.

import { wrapInEmailShell, escapeHtml, escapeAttr } from "@splash/email-shell";
import type { OutboundEmailAttachment } from "@splash/db-supabase";

const NAVY = "#0E2745";
const SPLASH_BLUE = "#1FB6E0";
const AMBER = "#B45309";
const AMBER_BAR = "#F59E0B";
const MUTED = "#6B7280";
const RULE = "#E5E7EB";
const TRACK = "#F1F5F9";
const PREV_BAR = "#CBD5E1";
const GOAL_BAR = "#94A3B8";

// ---------------------------------------------------------------------------
// Shapes
//
// calc.js is plain JS reached through `allowJs` (see tsconfig.json), so these
// are hand-written mirrors of what computeVisit + attachPrevDeltas return
// rather than inferred types. Declaring them explicitly means a change to
// calc.js's output shows up here as a compile error in the fields this file
// reads, instead of silently rendering "—" in a manager's inbox.
// ---------------------------------------------------------------------------

export interface ReportEntry {
  name: string;
  description?: string | null;
  targetMlPerCar: number | null;
  actualMlPerCar: number | null;
  overTarget: boolean;
  overTargetPct: number | null;
  usageGal: number;
  cost: number;
  onHandValue: number;
  endingQtyGal: number;
  negativeUsage: boolean;
  /** Attached by attachPrevDeltas; absent when the site has no earlier visit. */
  prevMlPerCar?: number | null;
  prevCost?: number | null;
  mlPerCarDelta?: number | null;
}

export interface ComputedVisitLike {
  visit: {
    id: string;
    location_id: string;
    visit_date: string;
    submitter?: string | null;
    notes?: string | null;
    water_hardness_gpg?: number | null;
    tds_ppm?: number | null;
  };
  location: { name?: string | null } | null;
  totalWashCount: number;
  chemicalCost: number;
  onHandValue: number;
  blendedCpc: number | null;
  blendedTargetCpc: number | null;
  entries: ReportEntry[];
  overTargetFlags: ReportEntry[];
  negativeUsageFlags: ReportEntry[];
  flagCount: number;
  prevVisit?: { id: string; visit_date: string } | null;
  prevComputed?: {
    totalWashCount: number;
    chemicalCost: number;
    onHandValue: number;
    blendedCpc: number | null;
    blendedTargetCpc: number | null;
    entries: ReportEntry[];
  } | null;
}

export interface RenderedReport {
  subject: string;
  bodyHtml: string;
  bodyText: string;
  attachment: OutboundEmailAttachment;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function renderVisitReport(c: ComputedVisitLike, visitUrl: string | null): RenderedReport {
  const name = c.location?.name || c.visit.location_id || "Unknown location";
  const date = formatDate(c.visit.visit_date);
  const flags = buildFlagLines(c);

  // The flag count goes in the subject line because that is the entire reason
  // a manager opens this on a Saturday. "Clean" is stated positively rather
  // than omitted — a subject that only ever mentions problems trains people to
  // read the absence of a suffix as "didn't send".
  const suffix = flags.length ? ` — ${flags.length} flag${flags.length === 1 ? "" : "s"}` : " — clean";
  const subject = `Chemical visit: ${name} · ${date}${suffix}`;

  const bodyHtml = wrapInEmailShell(renderBodyHtml(c, flags, visitUrl, name, date), {
    title: subject,
    preheader: buildPreheader(c, flags)
  });

  return {
    subject,
    bodyHtml,
    bodyText: renderBodyText(c, flags, visitUrl, name, date),
    attachment: buildAttachment(c, name, date, visitUrl)
  };
}

// ---------------------------------------------------------------------------
// Flags
//
// Composed here from the computed entries rather than accepted as pre-rendered
// strings from the client. The client used to send these; it could therefore
// send anything at all, and a client one deploy behind would describe the
// visit using last release's thresholds.
// ---------------------------------------------------------------------------

function buildFlagLines(c: ComputedVisitLike): string[] {
  const out: string[] = [];
  for (const e of c.overTargetFlags || []) {
    const pct = e.overTargetPct != null ? ` (${e.overTargetPct > 0 ? "+" : ""}${fmtNum(e.overTargetPct * 100, 0)}%)` : "";
    out.push(`${e.name}: ${fmtNum(e.actualMlPerCar, 1)} ml/car vs goal ${fmtNum(e.targetMlPerCar, 1)}${pct}`);
  }
  for (const e of c.negativeUsageFlags || []) {
    out.push(`${e.name}: negative usage (${fmtNum(e.usageGal, 2)} gal) — check for a missed delivery`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML body
// ---------------------------------------------------------------------------

function renderBodyHtml(
  c: ComputedVisitLike,
  flags: string[],
  visitUrl: string | null,
  name: string,
  date: string
): string {
  const out: string[] = [];
  const v = c.visit;

  out.push(
    `<p style="margin: 0 0 4px 0; font-size: 20px; font-weight: 700; color: ${NAVY};">${escapeHtml(name)}</p>`,
    `<p style="margin: 0 0 20px 0; font-size: 14px; color: ${MUTED};">${escapeHtml(date)}${
      v.submitter ? ` &nbsp;·&nbsp; ${escapeHtml(String(v.submitter))}` : ""
    }</p>`
  );

  // Headline numbers, two per row. A table rather than flex because Outlook's
  // Word engine ignores flex entirely and would stack these full-width.
  //
  // Every one of these is now computed server-side, so Target CPC is always
  // present when the location has package composition rows — the old
  // conditional existed only because the client couldn't compute it.
  const stats: Array<[string, string]> = [
    ["Cars washed", fmtInt(c.totalWashCount)],
    ["Chemical cost", fmtMoney(c.chemicalCost)],
    ["Blended CPC", fmtCpc(c.blendedCpc)]
  ];
  if (c.blendedTargetCpc != null) stats.push(["Goal CPC", fmtCpc(c.blendedTargetCpc)]);
  if (c.onHandValue != null) stats.push(["On-hand value", fmtMoney(c.onHandValue)]);
  out.push(renderStatGrid(stats));

  // Against the previous visit. Only rendered when there IS one — a site's
  // first visit should not show a row of dashes implying missing data.
  if (c.prevComputed && c.prevVisit) {
    const pc = c.prevComputed;
    out.push(
      `<p style="margin: 22px 0 6px 0; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${MUTED};">vs ${escapeHtml(
        formatDate(c.prevVisit.visit_date)
      )}</p>`,
      renderStatGrid([
        ["Cars", deltaText(c.totalWashCount, pc.totalWashCount, (n) => fmtInt(n))],
        ["Chemical cost", deltaText(c.chemicalCost, pc.chemicalCost, (n) => fmtMoney(n))],
        ["Blended CPC", deltaText(c.blendedCpc, pc.blendedCpc, (n) => fmtCpc(n))],
        ["On-hand value", deltaText(c.onHandValue, pc.onHandValue, (n) => fmtMoney(n))]
      ])
    );
  }

  // Water is omitted entirely when neither reading was taken. Printing "—"
  // twice on every visit at a site that doesn't test would read as a broken
  // email rather than as an optional field. `!= null` rather than truthiness:
  // 0 gpg is a real reading at an RO or softened site.
  if (v.water_hardness_gpg != null || v.tds_ppm != null) {
    out.push(
      renderStatGrid([
        ["Hardness", v.water_hardness_gpg != null ? `${fmtNum(v.water_hardness_gpg, 2)} gpg` : "—"],
        ["TDS", v.tds_ppm != null ? `${fmtNum(v.tds_ppm, 2)} ppm` : "—"]
      ])
    );
  }

  out.push(renderBarBlock(c));

  if (flags.length) {
    out.push(
      `<p style="margin: 24px 0 8px 0; font-size: 14px; font-weight: 700; color: ${AMBER};">${flags.length} flag${
        flags.length === 1 ? "" : "s"
      } on this visit</p>`,
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 0 4px 0;"><tbody>`,
      flags
        .map(
          (f) =>
            `<tr><td style="padding: 8px 12px; font-size: 14px; color: #1f2937; background-color: #FFFBEB; border-left: 3px solid ${AMBER_BAR};">${escapeHtml(
              f
            )}</td></tr><tr><td style="height: 4px; line-height: 4px; font-size: 0;">&nbsp;</td></tr>`
        )
        .join(""),
      `</tbody></table>`
    );
  }

  if (v.notes && String(v.notes).trim()) {
    out.push(
      `<p style="margin: 20px 0 6px 0; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${MUTED};">Notes</p>`,
      `<p style="margin: 0; font-size: 14px; line-height: 1.6; color: #1f2937;">${escapeHtml(
        String(v.notes).trim()
      ).replace(/\n/g, "<br>")}</p>`
    );
  }

  out.push(
    `<p style="margin: 22px 0 0 0; font-size: 13px; line-height: 1.6; color: ${MUTED};">The attached comparison report has the full per-product breakdown for this visit and the previous one.</p>`
  );

  if (visitUrl) {
    out.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 18px 0 4px 0;"><tr><td>`,
      `<a href="${escapeAttr(
        visitUrl
      )}" style="display: inline-block; padding: 12px 24px; background-color: ${SPLASH_BLUE}; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 6px; border: 2px solid ${SPLASH_BLUE}; mso-padding-alt: 0;" target="_blank" rel="noopener">View Full Visit</a>`,
      `</td></tr></table>`
    );
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Goal-vs-actual bars
//
// Two bars per product — goal on top, actual below — plus a third, lighter bar
// for the previous visit's actual when there is one. All three share a single
// scale (the largest value anywhere in the block) so bar lengths are comparable
// down the column, which is the entire point; per-row autoscaling would make
// every product look identical.
//
// Colour carries the verdict: amber actual = over goal by more than the 30%
// tolerance calc.js applies, blue = within it. Colour is never the ONLY signal
// — the numeric ml/car sits at the right of every bar for the colour-blind and
// for the Outlook configurations that strip bgcolor.
// ---------------------------------------------------------------------------

function renderBarBlock(c: ComputedVisitLike): string {
  // Products with no goal on file can't be shown as goal-vs-actual; they'd
  // render as a bare bar with nothing to compare against. They're still in the
  // attachment's table, which is the complete record.
  const rows = (c.entries || []).filter((e) => e.targetMlPerCar != null && e.actualMlPerCar != null);
  if (!rows.length) return "";

  let max = 0;
  for (const e of rows) {
    max = Math.max(max, e.targetMlPerCar || 0, e.actualMlPerCar || 0, e.prevMlPerCar || 0);
  }
  if (!(max > 0)) return "";

  const hasPrev = rows.some((e) => e.prevMlPerCar != null);

  const blocks = rows
    .slice()
    .sort((a, b) => (b.overTargetPct ?? -Infinity) - (a.overTargetPct ?? -Infinity))
    .map((e) => {
      const bars = [
        bar("Goal", e.targetMlPerCar, max, GOAL_BAR),
        bar("Actual", e.actualMlPerCar, max, e.overTarget ? AMBER_BAR : SPLASH_BLUE)
      ];
      if (e.prevMlPerCar != null) bars.push(bar("Previous", e.prevMlPerCar, max, PREV_BAR));

      const deltaNote =
        e.mlPerCarDelta != null
          ? `<span style="font-size: 12px; color: ${MUTED};"> &nbsp;·&nbsp; ${
              e.mlPerCarDelta >= 0 ? "+" : "−"
            }${fmtNum(Math.abs(e.mlPerCarDelta), 2)} ml/car vs last visit</span>`
          : "";

      return (
        `<tr><td style="padding: 14px 0 4px 0;">` +
        `<span style="font-size: 14px; font-weight: 700; color: ${
          e.overTarget ? AMBER : NAVY
        };">${escapeHtml(e.name)}</span>${deltaNote}` +
        `</td></tr>` +
        `<tr><td style="padding: 0 0 6px 0;">` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;"><tbody>${bars.join(
          ""
        )}</tbody></table>` +
        `</td></tr>`
      );
    });

  return (
    `<p style="margin: 26px 0 0 0; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${MUTED};">Goal vs actual — ml per car</p>` +
    (hasPrev
      ? `<p style="margin: 4px 0 0 0; font-size: 12px; color: ${MUTED};">Grey = goal, blue/amber = this visit, pale = previous visit.</p>`
      : `<p style="margin: 4px 0 0 0; font-size: 12px; color: ${MUTED};">Grey = goal, blue/amber = this visit.</p>`) +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;"><tbody>${blocks.join(
      ""
    )}</tbody></table>`
  );
}

/**
 * One labelled bar row: label | track containing a filled cell | value.
 *
 * The fill is a nested table with a percentage width rather than a styled div,
 * because Word gives percentage widths on table cells to tables reliably and
 * gives them to block elements only sometimes. A 1px floor keeps a very small
 * non-zero value visible rather than collapsing it to nothing.
 */
function bar(label: string, value: number | null | undefined, max: number, color: string): string {
  const v = Number(value);
  const pct = Number.isFinite(v) && max > 0 ? Math.max(1, Math.min(100, Math.round((v / max) * 100))) : 0;
  return (
    `<tr>` +
    `<td width="72" style="padding: 2px 8px 2px 0; font-size: 11px; color: ${MUTED}; white-space: nowrap;">${escapeHtml(
      label
    )}</td>` +
    `<td style="padding: 2px 0;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse: collapse; background-color: ${TRACK};"><tr>` +
    `<td width="${pct}%" bgcolor="${color}" style="height: 12px; line-height: 12px; font-size: 0; background-color: ${color};">&nbsp;</td>` +
    `<td style="height: 12px; line-height: 12px; font-size: 0;">&nbsp;</td>` +
    `</tr></table>` +
    `</td>` +
    `<td width="64" align="right" style="padding: 2px 0 2px 10px; font-size: 12px; font-weight: 600; color: ${NAVY}; white-space: nowrap;">${escapeHtml(
      fmtNum(value, 1)
    )}</td>` +
    `</tr>`
  );
}

/** Label-over-value cells, two per row, hairline-separated. */
function renderStatGrid(stats: Array<[string, string]>): string {
  const cells = stats.map(
    ([label, value]) =>
      `<td width="50%" style="padding: 12px 12px 12px 0; vertical-align: top; border-bottom: 1px solid ${RULE};">` +
      `<span style="display: block; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: ${MUTED};">${escapeHtml(
        label
      )}</span>` +
      `<span style="display: block; margin-top: 2px; font-size: 18px; font-weight: 700; color: ${NAVY};">${value}</span>` +
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

/**
 * "$412.18" plus a smaller "+$18.40" in delta colour. Returns pre-escaped HTML
 * — renderStatGrid does not escape its value for exactly this reason.
 */
function deltaText(
  now: number | null,
  prev: number | null,
  fmt: (n: number | null) => string
): string {
  const head = escapeHtml(fmt(now));
  if (now == null || prev == null || !Number.isFinite(Number(now)) || !Number.isFinite(Number(prev))) {
    return head;
  }
  const d = Number(now) - Number(prev);
  if (Math.abs(d) < 1e-9) return `${head} <span style="font-size: 12px; font-weight: 500; color: ${MUTED};">flat</span>`;
  // Deliberately colour-neutral. Up is bad for cost and good for cars, and a
  // single stat grid carries both — green/red here would be wrong half the time.
  const sign = d > 0 ? "+" : "−";
  return `${head} <span style="font-size: 12px; font-weight: 500; color: ${MUTED};">${sign}${escapeHtml(
    fmt(Math.abs(d))
  )}</span>`;
}

// ---------------------------------------------------------------------------
// Plain text
//
// Not a fallback nobody reads: `body_text` is what Power Automate ships when
// body_html is absent, and it is also what shows in the admin email-queue
// preview. Kept genuinely readable rather than stripped-down HTML.
// ---------------------------------------------------------------------------

function renderBodyText(
  c: ComputedVisitLike,
  flags: string[],
  visitUrl: string | null,
  name: string,
  date: string
): string {
  const v = c.visit;
  const lines = [
    `${name} — ${date}`,
    v.submitter ? `Submitted by ${v.submitter}` : "",
    "",
    `Cars washed:   ${fmtInt(c.totalWashCount)}`,
    `Chemical cost: ${fmtMoney(c.chemicalCost)}`,
    `Blended CPC:   ${fmtCpc(c.blendedCpc)}`,
    c.blendedTargetCpc != null ? `Goal CPC:      ${fmtCpc(c.blendedTargetCpc)}` : "",
    c.onHandValue != null ? `On-hand value: ${fmtMoney(c.onHandValue)}` : "",
    v.water_hardness_gpg != null ? `Hardness:      ${fmtNum(v.water_hardness_gpg, 2)} gpg` : "",
    v.tds_ppm != null ? `TDS:           ${fmtNum(v.tds_ppm, 2)} ppm` : ""
  ];

  const withGoals = (c.entries || []).filter((e) => e.targetMlPerCar != null && e.actualMlPerCar != null);
  if (withGoals.length) {
    lines.push("", "Goal vs actual (ml/car):");
    for (const e of withGoals) {
      const prev = e.prevMlPerCar != null ? `, prev ${fmtNum(e.prevMlPerCar, 1)}` : "";
      const mark = e.overTarget ? "  <-- over goal" : "";
      lines.push(
        `  ${e.name}: goal ${fmtNum(e.targetMlPerCar, 1)}, actual ${fmtNum(e.actualMlPerCar, 1)}${prev}${mark}`
      );
    }
  }

  if (flags.length) {
    lines.push("", `${flags.length} flag${flags.length === 1 ? "" : "s"}:`);
    for (const f of flags) lines.push(`  - ${f}`);
  }
  if (v.notes && String(v.notes).trim()) lines.push("", "Notes:", String(v.notes).trim());
  lines.push("", "Full per-product comparison is attached.");
  if (visitUrl) lines.push("", `View full visit: ${visitUrl}`);

  return lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n");
}

function buildPreheader(c: ComputedVisitLike, flags: string[]): string {
  const cars = fmtInt(c.totalWashCount);
  const cpc = fmtCpc(c.blendedCpc);
  const flagPart = flags.length ? `${flags.length} flag${flags.length === 1 ? "" : "s"}` : "no flags";
  return `${cars} cars · ${cpc} blended CPC · ${flagPart}`;
}

// ---------------------------------------------------------------------------
// Attachment — standalone comparison document
//
// A complete HTML file, not a fragment: it opens straight from the attachment
// in any browser and prints to PDF cleanly (hence the @page rule and the
// print-colour-adjust hints, which keep the amber over-goal shading from
// vanishing on paper).
//
// HTML rather than XLSX or PDF because neither can be produced in a Worker
// without pulling a heavyweight dependency into an isolate that has a hard CPU
// budget — and because every recipient of this mail can open HTML, whereas
// "open the .xlsx" on a phone is a coin flip.
//
// Inlined as base64 rather than parked in R2 under an `r2_key`. R2 delivery
// would need the attachment bucket union widened in @splash/db-supabase, a new
// bucket bound on forms-worker's wrangler.toml, and the dispatch in
// forms-worker's attachments.ts extended — three coordinated changes across two
// workers to save a few tens of KB on a queue row that is capped at 5 MB.
// ---------------------------------------------------------------------------

function buildAttachment(
  c: ComputedVisitLike,
  name: string,
  date: string,
  visitUrl: string | null
): OutboundEmailAttachment {
  const html = renderComparisonDoc(c, name, date, visitUrl);
  const encoded = toBase64(html);
  return {
    filename: `chemical-comparison-${slug(name)}-${String(c.visit.visit_date).slice(0, 10)}.html`,
    base64: encoded.base64,
    mime: "text/html",
    size_bytes: encoded.bytes
  };
}

function renderComparisonDoc(
  c: ComputedVisitLike,
  name: string,
  date: string,
  visitUrl: string | null
): string {
  const pc = c.prevComputed || null;
  const prevDate = c.prevVisit ? formatDate(c.prevVisit.visit_date) : null;

  // Per-product previous-visit figures come off the entries themselves —
  // attachPrevDeltas already matched them by product id. Re-matching here on
  // product NAME would break the moment a product is renamed, and would pair
  // two different chemicals that happen to share a label.
  //
  // The consequence is that a product carried last visit but dropped this one
  // has no row. That is the right answer for a goal-vs-actual table: there is
  // no goal and no actual to compare. The visit-level summary above still
  // counts its cost on the previous-visit side.
  //
  // Sorted worst-first. Somebody who reads only the top of this table should be
  // reading about the product that is costing the site money.
  const entries = (c.entries || [])
    .slice()
    .sort((a, b) => (b.overTargetPct ?? -Infinity) - (a.overTargetPct ?? -Infinity));

  const summaryRows: Array<[string, string, string]> = [
    ["Cars washed", fmtInt(c.totalWashCount), pc ? fmtInt(pc.totalWashCount) : "—"],
    ["Chemical cost", fmtMoney(c.chemicalCost), pc ? fmtMoney(pc.chemicalCost) : "—"],
    ["Blended CPC", fmtCpc(c.blendedCpc), pc ? fmtCpc(pc.blendedCpc) : "—"],
    ["Goal CPC", fmtCpc(c.blendedTargetCpc), pc ? fmtCpc(pc.blendedTargetCpc) : "—"],
    ["On-hand value", fmtMoney(c.onHandValue), pc ? fmtMoney(pc.onHandValue) : "—"]
  ];

  const productRows = entries.map((e) => {
    const variance =
      e.overTargetPct != null
        ? `${e.overTargetPct >= 0 ? "+" : "−"}${fmtNum(Math.abs(e.overTargetPct) * 100, 1)}%`
        : "—";
    const delta =
      e.mlPerCarDelta != null
        ? `${e.mlPerCarDelta >= 0 ? "+" : "−"}${fmtNum(Math.abs(e.mlPerCarDelta), 2)}`
        : "—";
    const cls = e.overTarget ? ' class="over"' : "";
    return (
      `<tr${cls}>` +
      `<th scope="row">${escapeHtml(e.name)}${
        e.description ? `<span class="sub">${escapeHtml(String(e.description))}</span>` : ""
      }</th>` +
      `<td>${escapeHtml(fmtNum(e.targetMlPerCar, 2))}</td>` +
      `<td class="strong">${escapeHtml(fmtNum(e.actualMlPerCar, 2))}</td>` +
      `<td>${escapeHtml(variance)}</td>` +
      `<td>${escapeHtml(e.prevMlPerCar != null ? fmtNum(e.prevMlPerCar, 2) : "—")}</td>` +
      `<td>${escapeHtml(delta)}</td>` +
      `<td>${escapeHtml(fmtNum(e.usageGal, 2))}</td>` +
      `<td>${escapeHtml(fmtMoney(e.cost))}</td>` +
      `<td>${escapeHtml(e.prevCost != null ? fmtMoney(e.prevCost) : "—")}</td>` +
      `<td>${escapeHtml(fmtMoney(e.onHandValue))}</td>` +
      `</tr>`
    );
  });

  const flags = buildFlagLines(c);
  const title = `Chemical comparison — ${name} — ${date}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: landscape; margin: 12mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; padding: 28px 22px 48px; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2937; background: #ffffff; }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { margin: 0 0 2px; font-size: 22px; color: ${NAVY}; }
  .meta { margin: 0 0 24px; font-size: 13px; color: ${MUTED}; }
  h2 { margin: 30px 0 8px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: ${MUTED}; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid ${RULE}; text-align: right; vertical-align: top; }
  thead th { text-align: right; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: ${MUTED}; border-bottom: 2px solid ${NAVY}; white-space: nowrap; }
  th[scope="row"], thead th:first-child { text-align: left; }
  th[scope="row"] { font-weight: 600; color: ${NAVY}; }
  .sub { display: block; font-weight: 400; font-size: 11px; color: ${MUTED}; }
  .strong { font-weight: 700; color: ${NAVY}; }
  tr.over th[scope="row"], tr.over .strong { color: ${AMBER}; }
  tr.over { background: #FFFBEB; }
  .flags { margin: 8px 0 0; padding: 0; list-style: none; font-size: 13px; }
  .flags li { padding: 7px 11px; margin-bottom: 5px; background: #FFFBEB; border-left: 3px solid ${AMBER_BAR}; }
  .clean { font-size: 13px; color: ${MUTED}; margin: 8px 0 0; }
  .notes { font-size: 13px; line-height: 1.6; white-space: pre-wrap; margin: 8px 0 0; }
  .foot { margin: 34px 0 0; font-size: 11px; color: ${MUTED}; line-height: 1.6; }
  .foot a { color: ${SPLASH_BLUE}; }
  @media print { .foot a { color: ${MUTED}; text-decoration: none; } }
</style></head>
<body><div class="wrap">
<h1>${escapeHtml(name)}</h1>
<p class="meta">${escapeHtml(date)}${c.visit.submitter ? ` · ${escapeHtml(String(c.visit.submitter))}` : ""}${
    prevDate ? ` · compared against ${escapeHtml(prevDate)}` : " · no previous visit on record"
  }</p>

<h2>Visit summary</h2>
<table><thead><tr><th>Metric</th><th>This visit</th><th>${escapeHtml(prevDate || "Previous")}</th></tr></thead>
<tbody>${summaryRows
    .map(
      ([label, now, prev]) =>
        `<tr><th scope="row">${escapeHtml(label)}</th><td class="strong">${escapeHtml(
          now
        )}</td><td>${escapeHtml(prev)}</td></tr>`
    )
    .join("")}</tbody></table>

<h2>Per-product — goal vs actual</h2>
<table><thead><tr>
<th>Product</th><th>Goal ml/car</th><th>Actual ml/car</th><th>Variance</th>
<th>Prev ml/car</th><th>&Delta; ml/car</th><th>Usage gal</th><th>Cost</th><th>Prev cost</th><th>On hand</th>
</tr></thead><tbody>${productRows.join("")}</tbody></table>

<h2>Flags</h2>
${
  flags.length
    ? `<ul class="flags">${flags.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`
    : `<p class="clean">No flags on this visit.</p>`
}

${
  c.visit.notes && String(c.visit.notes).trim()
    ? `<h2>Notes</h2><p class="notes">${escapeHtml(String(c.visit.notes).trim())}</p>`
    : ""
}

<p class="foot">Generated automatically from the chemical inventory record. Variance is actual ml/car against the goal on file for this site; products are listed worst-variance first. Goal CPC is the composition-weighted target across the packages sold on this visit.${
    visitUrl ? `<br><a href="${escapeAttr(visitUrl)}">${escapeHtml(visitUrl)}</a>` : ""
  }</p>
</div></body></html>`;
}

/**
 * UTF-8 safe base64. `btoa` takes a binary string, so the text is encoded to
 * bytes first — a product name with a degree sign or an em-dash in the notes
 * would throw otherwise. Chunked because spreading a large byte array into
 * String.fromCharCode blows the argument limit.
 */
function toBase64(text: string): { base64: string; bytes: number } {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return { base64: btoa(binary), bytes: bytes.length };
}

function slug(s: string): string {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "visit"
  );
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

function fmtNum(v: unknown, digits = 2): string {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
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
